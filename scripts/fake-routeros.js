/**
 * scripts/fake-routeros.js — เราท์เตอร์ MikroTik จำลอง พูดโปรโตคอล API จริง
 *
 * มีไว้ทดสอบเส้นทางที่ "สั่งลงเราท์เตอร์" โดยไม่ต้องเอาสาขาจริงมาเสี่ยง
 * ตัวมันเก็บสถานะไว้ในหน่วยความจำ เพิ่ม/ลบ/แก้ได้จริง จึงตรวจได้ว่าหลังสั่ง
 * ไปแล้วของบนเราท์เตอร์เปลี่ยนไปตามที่ตั้งใจหรือเปล่า ไม่ใช่แค่ว่าคำสั่งไม่ error
 *
 * ใช้: node scripts/fake-routeros.js [port] [--scenario a4|a4-broken]
 *   a4         สภาพแบบ A4: PPPoE บน ether1 + DHCP บน ether2 (ping ตอบปกติ)
 *   a4-broken  เหมือนกันแต่ ping ไม่ตอบ — ใช้ดูว่าระบบถอนคืนจริงไหม
 */

'use strict';

const net = require('net');

const PORT = Number(process.argv[2]) || 8728;
const scenarioArg = process.argv.find((a) => a.startsWith('--scenario='));
const SCENARIO = scenarioArg ? scenarioArg.split('=')[1] : 'a4';
const PING_WORKS = SCENARIO !== 'a4-broken';
const THREE_WAN = SCENARIO === '3wan' || SCENARIO === '3wan-notest';
// จำลองผู้ใช้ API ที่ไม่มีสิทธิ์ test — สภาพจริงของ 3 ใน 4 สาขาตอนนี้
const NO_TEST_POLICY = SCENARIO.endsWith('notest');

// ให้กำหนดเวอร์ชันที่รายงานได้จากบรรทัดคำสั่ง (--version=7.23.1)
// ใช้จำลองสถานะ "อัปเกรดเสร็จแล้ว" เพื่อดูว่าหน้าจออ่านค่าใหม่จริงหรือยังค้างของเก่า
const verArg = process.argv.find((a) => a.startsWith('--version='));
const VERSION = verArg ? verArg.split('=')[1] : '7.24.1';

let idSeq = 100;
const nextId = () => `*${(++idSeq).toString(16).toUpperCase()}`;

// ---- สถานะจำลอง ----
const db = {
    interfaces: [
        { '.id': '*1', name: 'ether1', type: 'ether', running: 'true' },
        { '.id': '*2', name: 'ether2', type: 'ether', running: 'true' },
        { '.id': '*3', name: 'ether3', type: 'ether', running: 'false' },
        { '.id': '*4', name: 'bridge-lan', type: 'bridge', running: 'true' },
        { '.id': '*5', name: 'pppoe-out1', type: 'pppoe-out', running: 'true' }
    ],
    pppoeClients: [
        { '.id': '*A', name: 'pppoe-out1', interface: 'ether1', running: 'true',
          disabled: 'false', 'add-default-route': 'yes', 'default-route-distance': '1',
          user: 'a4user', 'local-address': '101.51.20.33' }
    ],
    dhcpClients: [
        { '.id': '*B', interface: 'ether2', status: 'bound', address: '192.168.1.50/24',
          gateway: '192.168.1.1', disabled: 'false', 'add-default-route': 'yes',
          'default-route-distance': '1' }
    ].concat(THREE_WAN ? [
        { '.id': '*B2', interface: 'ether3', status: 'bound', address: '192.168.8.100/24',
          gateway: '192.168.8.1', disabled: 'false', 'add-default-route': 'yes',
          'default-route-distance': '1' }
    ] : []),
    routes: [
        { '.id': '*C', 'dst-address': '0.0.0.0/0', gateway: 'pppoe-out1',
          distance: '1', dynamic: 'true', active: 'true' },
        { '.id': '*D', 'dst-address': '0.0.0.0/0', gateway: '192.168.1.1',
          distance: '1', dynamic: 'true', active: 'true' }
    ],
    mangle: [],
    nat: [
        { '.id': '*E', chain: 'srcnat', action: 'masquerade',
          'out-interface': 'pppoe-out1', comment: 'NAT หลัก' }
    ],
    scheduler: [],
    resource: [{ version: VERSION, 'board-name': 'CCR2004-16G-2S+', uptime: '8w1d2h13m12s',
                 'cpu-load': '3', 'free-memory': '1500000000' }],
    identity: [{ name: 'A4-Residence-FAKE' }],
    routerboard: [{ 'board-name': 'CCR2004-16G-2S+', model: 'CCR2004-16G-2S+',
                    'current-firmware': VERSION, 'upgrade-firmware': VERSION,
                    'firmware-type': 'tile' }],
    health: [{ temperature: '42', voltage: '24.1' }],
    netwatch: [],
    addresses: [{ '.id': '*IP1', address: '192.168.88.1/24', interface: 'bridge-lan' }]
};

// ---- โปรโตคอล API ของ RouterOS ----
function encodeLen(n) {
    if (n < 0x80) return Buffer.from([n]);
    if (n < 0x4000) { const b = Buffer.alloc(2); b.writeUInt16BE(n | 0x8000); return b; }
    if (n < 0x200000) { const b = Buffer.alloc(4); b.writeUInt32BE(n | 0xC00000); return b.slice(1); }
    const b = Buffer.alloc(4); b.writeUInt32BE(n | 0xE0000000); return b;
}
function word(s) {
    const b = Buffer.from(s, 'utf8');
    return Buffer.concat([encodeLen(b.length), b]);
}
function sentence(words) {
    return Buffer.concat([...words.map(word), Buffer.from([0])]);
}

function readLen(buf, off) {
    const c = buf[off];
    if (c === undefined) return null;
    if ((c & 0x80) === 0) return { len: c, off: off + 1 };
    if ((c & 0xC0) === 0x80) return { len: ((c & 0x3f) << 8) | buf[off + 1], off: off + 2 };
    if ((c & 0xE0) === 0xC0) return { len: ((c & 0x1f) << 16) | (buf[off+1] << 8) | buf[off+2], off: off + 3 };
    return { len: buf.readUInt32BE(off + 1), off: off + 5 };
}

/** จัดการหนึ่งคำสั่ง คืนอาร์เรย์ของ sentence ที่จะตอบกลับ */
function handle(cmd, attrs) {
    const reply = (rows) => {
        const out = rows.map((r) => sentence(['!re', ...Object.entries(r).map(([k, v]) => `=${k}=${v}`)]));
        out.push(sentence(['!done']));
        return out;
    };
    const done = (extra) => [sentence(['!done', ...(extra || [])])];
    const err = (m) => [sentence(['!trap', `=message=${m}`]), sentence(['!done'])];

    const c = cmd.replace(/\/$/, '');

    if (c === '/login') return done();
    if (c === '/system/resource/print') return reply(db.resource);
    if (c === '/system/identity/print') return reply(db.identity);
    if (c === '/interface/print') return reply(db.interfaces);
    if (c === '/interface/pppoe-client/print') return reply(db.pppoeClients);
    if (c === '/ip/dhcp-client/print') return reply(db.dhcpClients);
    if (c === '/ip/route/print') return reply(db.routes);
    if (c === '/ip/firewall/mangle/print') return reply(db.mangle);
    if (c === '/ip/firewall/nat/print') return reply(db.nat);
    if (c === '/system/scheduler/print') return reply(db.scheduler);
    if (c === '/system/routerboard/print') return reply(db.routerboard);
    if (c === '/system/health/print') return reply(db.health);
    if (c === '/tool/netwatch/print') return reply(db.netwatch);
    if (c === '/ip/address/print') return reply(db.addresses);

    if (c === '/system/backup/save') {
        return done([`=ret=${attrs.name || 'backup'}`]);
    }

    if (c === '/ping') {
        if (NO_TEST_POLICY) return err('not enough permissions (9)');
        const n = Number(attrs.count) || 4;
        const rows = [];
        for (let i = 0; i < n; i++) {
            rows.push(PING_WORKS
                ? { seq: String(i), host: attrs.address, 'time': '12ms', received: '1', sent: '1' }
                : { seq: String(i), host: attrs.address, received: '0', sent: '1', status: 'timeout' });
        }
        return reply(rows);
    }

    // add / set / remove
    const m = c.match(/^(.*)\/(add|set|remove)$/);
    if (m) {
        const [, base, op] = m;
        const table = {
            '/ip/route': db.routes,
            '/ip/firewall/nat': db.nat,
            '/ip/firewall/mangle': db.mangle,
            '/system/scheduler': db.scheduler,
            '/interface/pppoe-client': db.pppoeClients,
            '/ip/dhcp-client': db.dhcpClients,
            '/tool/netwatch': db.netwatch,
            '/ip/address': db.addresses
        }[base];
        if (!table) return err(`no such command prefix (${base})`);

        if (op === 'add') {
            const row = Object.assign({ '.id': nextId(), active: 'true' }, attrs);
            table.push(row);
            return done([`=ret=${row['.id']}`]);
        }
        if (op === 'set') {
            const row = table.find((r) => r['.id'] === attrs['.id']);
            if (!row) return err('no such item');
            Object.assign(row, attrs);
            return done();
        }
        if (op === 'remove') {
            const i = table.findIndex((r) => r['.id'] === attrs['.id']);
            if (i < 0) return err('no such item');
            table.splice(i, 1);
            return done();
        }
    }

    return err(`no such command (${c})`);
}

const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        // แกะทีละ sentence
        for (;;) {
            let off = 0;
            const words = [];
            let complete = false;
            for (;;) {
                const r = readLen(buf, off);
                if (!r || buf.length < r.off + r.len) break;
                if (r.len === 0) { complete = true; off = r.off; break; }
                words.push(buf.slice(r.off, r.off + r.len).toString('utf8'));
                off = r.off + r.len;
            }
            if (!complete) break;
            buf = buf.slice(off);

            const cmd = words[0] || '';
            const attrs = {};
            words.slice(1).forEach((w) => {
                if (w.startsWith('=')) {
                    const i = w.indexOf('=', 1);
                    if (i > 0) attrs[w.slice(1, i)] = w.slice(i + 1);
                }
            });
            console.log(`  <- ${cmd} ${JSON.stringify(attrs).slice(0, 120)}`);
            handle(cmd, attrs).forEach((s) => sock.write(s));
        }
    });
    sock.on('error', () => {});
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`เราท์เตอร์จำลองพร้อมที่ 127.0.0.1:${PORT} (scenario=${SCENARIO}, ping ${PING_WORKS ? 'ตอบ' : 'ไม่ตอบ'})`);
});

// เปิดช่องให้ตรวจสถานะภายในผ่าน stdin (พิมพ์ dump แล้ว Enter)
process.stdin.on('data', (d) => {
    if (String(d).trim() === 'dump') {
        console.log(JSON.stringify({
            routes: db.routes, nat: db.nat, scheduler: db.scheduler,
            pppoe: db.pppoeClients, dhcp: db.dhcpClients
        }, null, 2));
    }
});
