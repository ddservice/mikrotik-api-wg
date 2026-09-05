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
                 'cpu-load': '3', 'free-memory': '1500000000', 'total-memory': '4000000000',
                 'free-hdd-space': '100000000', 'total-hdd-space': '128000000' }],
    // log ตัวอย่างที่มีทั้งเรื่องปกติและเรื่องที่ต้องสนใจ
    routerLogs: [
        { time: '09:15:01', topics: 'system,info', message: 'router rebooted' },
        { time: '10:02:11', topics: 'dhcp,warning', message: 'dhcp alert on bridge-lan: discovered unknown dhcp server, mac 00:11:22:33:44:55' },
        { time: '10:30:00', topics: 'interface,info', message: 'ether3: link down' },
        { time: '11:00:00', topics: 'system,info', message: 'user admin logged in from 10.10.88.1 via api' }
    ],
    identity: [{ name: 'A4-Residence-FAKE' }],
    routerboard: [{ 'board-name': 'CCR2004-16G-2S+', model: 'CCR2004-16G-2S+',
                    'current-firmware': VERSION, 'upgrade-firmware': VERSION,
                    'firmware-type': 'tile' }],
    health: [{ temperature: '42', voltage: '24.1' }],
    netwatch: [],
    filter: [
        { '.id': '*F1', chain: 'input', action: 'accept', 'connection-state': 'established,related' },
        { '.id': '*F2', chain: 'input', action: 'drop', comment: 'drop everything else' }
    ],
    scripts: [],
    ifaceLists: [],
    ifaceListMembers: [],
    dns: [{ servers: '203.113.1.1', 'allow-remote-requests': 'false', 'dynamic-servers': '' }],
    dhcpNetworks: [{ '.id': '*N1', address: '192.168.88.0/24', gateway: '192.168.88.1',
                     'dns-server': '203.113.1.1' }],
    addresses: [{ '.id': '*IP1', address: '192.168.88.1/24', interface: 'bridge-lan' }],
    // Hotspot — มีไว้ทดสอบเส้นทางสร้างคูปองแบบกลุ่ม ซึ่งเขียนผู้ใช้ลงเราท์เตอร์จริงทีละไม่เกิน 100 ราย
    hotspotProfiles: [
        { '.id': '*HP1', name: 'default', 'rate-limit': '', 'shared-users': '1' },
        { '.id': '*HP2', name: '1day', 'rate-limit': '10M/10M', 'shared-users': '1',
          'session-timeout': '1d' }
    ],
    hotspotUsers: [
        { '.id': '*HU1', name: 'a028', password: 'test1234', profile: 'default',
          uptime: '1h20m', 'limit-uptime': '02:00:00', 'bytes-in': '104857600',
          'bytes-out': '20971520', comment: 'ลูกค้าประจำ' },
        { '.id': '*HU2', name: 'a029', password: 'abcd2345', profile: '1day',
          uptime: '0s', 'limit-uptime': '1d', 'bytes-in': '0', 'bytes-out': '0', comment: '' }
    ],
    // PPPoE — ห้องเช่า (/ppp/secret) และเซสชันที่ออนไลน์อยู่ (/ppp/active)
    pppSecrets: [
        { '.id': '*PS1', name: 'rm319', password: 'room319', profile: 'default',
          service: 'pppoe', disabled: 'false', comment: 'คุณสมชาย',
          'last-logged-out': 'sep/03/2026 21:10:04' },
        { '.id': '*PS2', name: 'rm320', password: 'room320', profile: 'default',
          service: 'pppoe', disabled: 'true', comment: 'ค้างค่าเช่า',
          'last-logged-out': 'aug/28/2026 08:00:00' }
    ],
    pppActive: [
        { '.id': '*PA1', name: 'rm319', address: '10.20.0.5', 'caller-id': 'DE:AD:BE:EF:00:01',
          uptime: '3h12m', service: 'pppoe' }
    ],
    pppProfiles: [
        { '.id': '*PP1', name: 'default', 'rate-limit': '', 'local-address': '10.20.0.1',
          'remote-address': 'pppoe-pool' }
    ],
    pppoeServers: [
        { '.id': '*PSV1', 'service-name': 'mt-pppoe', interface: 'ether5',
          'keepalive-timeout': '10', disabled: 'false' }
    ],
    // DHCP lease — เคสจริงมีทั้งที่เราท์เตอร์แจกเอง (dynamic) และที่คนจองไว้ (static)
    dhcpLeases: [
        { '.id': '*L1', address: '192.168.88.101', 'mac-address': 'AA:BB:CC:DD:EE:01',
          'host-name': 'iPhone-somchai', server: 'dhcp1', dynamic: 'true', status: 'bound',
          'last-seen': '2m30s', 'expires-after': '2h15m', disabled: 'false' },
        { '.id': '*L2', address: '192.168.88.50', 'mac-address': 'AA:BB:CC:DD:EE:02',
          'host-name': 'printer-office', server: 'dhcp1', dynamic: 'false', status: 'bound',
          comment: 'เครื่องพิมพ์ชั้น 2', 'last-seen': '10s', 'expires-after': '', disabled: 'false' },
        { '.id': '*L3', address: '192.168.88.150', 'mac-address': 'AA:BB:CC:DD:EE:03',
          'host-name': '', server: 'dhcp1', dynamic: 'true', status: 'waiting',
          'last-seen': '3d1h', 'expires-after': '', disabled: 'false' }
    ],
    dhcpServers: [
        { '.id': '*S1', name: 'dhcp1', interface: 'bridge-lan',
          'address-pool': 'dhcp_pool0', 'lease-time': '3d', disabled: 'false' }
    ],
    hotspotActive: [
        { '.id': '*HA1', user: 'a028', address: '192.168.88.101', 'mac-address': 'AA:BB:CC:DD:EE:01',
          'login-by': 'http-chap', uptime: '1h20m', 'bytes-in': '104857600', 'bytes-out': '20971520' }
    ]
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
    if (c === '/ip/dns/print') return reply(db.dns);
    if (c === '/ip/dhcp-server/network/print') return reply(db.dhcpNetworks);
    if (c === '/ip/firewall/filter/print') return reply(db.filter);
    if (c === '/ip/dns/set') { Object.assign(db.dns[0], attrs); return done(); }
    if (c === '/system/script/print') return reply(db.scripts);
    if (c === '/interface/list/print') return reply(db.ifaceLists);
    if (c === '/interface/list/member/print') return reply(db.ifaceListMembers);
    if (c === '/system/script/run') {
        // รันสคริปต์ที่เก็บไว้จริง ๆ เท่าที่จำเป็นต่อการทดสอบการคืนค่า
        const sc = db.scripts.find((x) => x['.id'] === attrs['.id']);
        if (sc) {
            String(sc.source || '').split(String.fromCharCode(10)).forEach((line) => {
                let m = line.match(/^\/ip dns set servers="([^"]*)" allow-remote-requests=(\w+)/);
                if (m) { db.dns[0].servers = m[1]; db.dns[0]['allow-remote-requests'] = m[2]; return; }
                m = line.match(/^\/ip dhcp-server network set \[find where \.id="([^"]+)"\] dns-server="([^"]*)"/);
                if (m) {
                    const n = db.dhcpNetworks.find((x) => x['.id'] === m[1]);
                    if (n) n['dns-server'] = m[2];
                }
            });
        }
        return done();
    }

    if (c === '/ppp/secret/print') return reply(db.pppSecrets);
    if (c === '/ppp/active/print') return reply(db.pppActive);
    if (c === '/ppp/profile/print') return reply(db.pppProfiles);
    if (c === '/interface/pppoe-server/server/print') return reply(db.pppoeServers);
    // /export คืนคอนฟิกเป็นข้อความ — RouterOS จริงส่งมาหลาย sentence
    if (c === '/export') {
        const cfg = [
            '# sep/05/2026 02:30:00 by RouterOS ' + VERSION,
            '/interface bridge',
            'add name=bridge-lan comment="LAN"',
            '/interface wireguard',
            'add name=wg-gatekeeper listen-port=13231 comment="MT Management WireGuard"',
            '/ip pool',
            'add name=dhcp_pool0 ranges=192.168.88.10-192.168.88.254',
            '/ip address',
            'add address=192.168.88.1/24 interface=bridge-lan',
            'add address=10.10.88.5/24 interface=wg-gatekeeper comment="WireGuard VPN IP"',
            '/ip dhcp-server',
            'add address-pool=dhcp_pool0 interface=bridge-lan name=dhcp1',
            '/ip firewall filter',
            'add action=accept chain=input connection-state=established,related',
            'add action=drop chain=input connection-state=invalid',
            '/system identity',
            'set name=A4-Residence-FAKE'
        ];
        return reply(cfg.map((line) => ({ ret: line })));
    }
    if (c === '/log/print') return reply(db.routerLogs);
    if (c === '/ip/dhcp-server/lease/print') return reply(db.dhcpLeases);
    if (c === '/ip/dhcp-server/print') return reply(db.dhcpServers);
    if (c === '/ip/dhcp-server/lease/make-static') {
        const l = db.dhcpLeases.find((x) => x['.id'] === (attrs.numbers || attrs['.id']));
        if (!l) return err('no such item');
        l.dynamic = 'false';
        return done();
    }
    if (c === '/ip/hotspot/user/print') return reply(db.hotspotUsers);
    if (c === '/ip/hotspot/user/profile/print') return reply(db.hotspotProfiles);
    if (c === '/ip/hotspot/active/print') {
        // server กรองด้วย ?user= ตอนจะเตะเซสชันก่อนต่ออายุ
        const filt = attrs['?user'] !== undefined ? attrs['?user'] : null;
        return reply(filt ? db.hotspotActive.filter((s) => s.user === filt) : db.hotspotActive);
    }
    if (c === '/ip/hotspot/user/reset-counters') {
        const u = db.hotspotUsers.find((x) => x['.id'] === (attrs.numbers || attrs['.id']));
        if (!u) return err('no such item');
        u.uptime = '0s';
        u['bytes-in'] = '0';
        u['bytes-out'] = '0';
        return done();
    }

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
            '/ip/address': db.addresses,
            '/ip/firewall/filter': db.filter,
            '/ip/dhcp-server/network': db.dhcpNetworks,
            '/system/script': db.scripts,
            '/interface/list': db.ifaceLists,
            '/interface/list/member': db.ifaceListMembers,
            '/ppp/secret': db.pppSecrets,
            '/ppp/active': db.pppActive,
            '/ppp/profile': db.pppProfiles,
            '/interface/pppoe-server/server': db.pppoeServers,
            '/ip/dhcp-server/lease': db.dhcpLeases,
            '/ip/hotspot/user': db.hotspotUsers,
            '/ip/hotspot/user/profile': db.hotspotProfiles,
            '/ip/hotspot/active': db.hotspotActive
        }[base];
        if (!table) return err(`no such command prefix (${base})`);

        if (op === 'add') {
            // เลียนแบบ RouterOS: place-before ที่ชี้ไปยังของที่ไม่มีจะ error
            if (attrs['place-before'] != null && table.length === 0) {
                return err('no such item (place-before)');
            }
            const row = Object.assign({ '.id': nextId(), active: 'true' }, attrs);
            // RouterOS: place-before แทรกก่อนตำแหน่งที่ระบุ ไม่ใช่ต่อท้าย
            if (attrs['place-before'] != null) {
                const at = Number(attrs['place-before']);
                table.splice(Number.isFinite(at) ? at : table.length, 0, row);
            } else {
                table.push(row);
            }
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
            pppoe: db.pppoeClients, dhcp: db.dhcpClients,
            filter: db.filter, hotspotUsers: db.hotspotUsers, pppSecrets: db.pppSecrets
        }, null, 2));
    }
});
