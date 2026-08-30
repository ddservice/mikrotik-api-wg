#!/usr/bin/env node
/**
 * check-sites.js — ตรวจการเชื่อมต่อทุกสาขาแบบไล่ทีละชั้น
 *
 * ทำไมต้องไล่ทีละชั้น: เวลาสาขาหนึ่งใช้ไม่ได้ คำถามแรกคือ "ติดตรงไหน" —
 * เน็ตหน้างานล่ม, อุโมงค์ VPN ไม่ขึ้น, พอร์ตถูกบล็อก หรือรหัส API ผิด
 * แต่ละอย่างแก้คนละแบบและคนละคนรับผิดชอบ การบอกแค่ "ต่อไม่ได้" ไม่ช่วยอะไร
 *
 * ชั้นที่ตรวจ:
 *   1. ทะเบียนสาขา — มี host/username/password ครบไหม
 *   2. WireGuard   — มี peer ใน wg0 ไหม handshake ล่าสุดเมื่อไร
 *   3. Ping        — แพ็กเก็ตหายไหม หน่วงเท่าไร
 *   4. TCP         — พอร์ต API เปิดรับจริงไหม
 *   5. RouterOS API— ล็อกอินผ่านไหม และอ่านข้อมูลจริงได้ไหม
 *
 * อ่านอย่างเดียว ไม่แก้อะไรทั้งสิ้น รันบ่อยแค่ไหนก็ได้
 *
 * ใช้:  npm run check-sites
 */

const path = require('path');
const net = require('net');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function loadEnv() {
    if (process.env.SUPABASE_URL && !String(process.env.SUPABASE_URL).includes('YOUR_')) return;
    try {
        const eco = require(path.join(ROOT, 'ecosystem.config.js'));
        const env = (eco.apps && eco.apps[0] && eco.apps[0].env) || {};
        Object.keys(env).forEach((k) => {
            if (/^SUPABASE_|^R2_/.test(k) && !String(env[k]).includes('YOUR_')) process.env[k] = env[k];
        });
    } catch (_) {}
}
loadEnv();

const db = require(path.join(ROOT, process.env.SUPABASE_URL ? 'db-supabase.js' : 'db.js'));
const RouterOS = require(path.join(ROOT, 'routeros.js'));

function sh(cmd) {
    try { return execSync(cmd, { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (_) { return ''; }
}

function tcpProbe(host, port, timeoutMs = 8000) {
    return new Promise((resolve) => {
        const started = Date.now();
        const sock = new net.Socket();
        let done = false;
        const finish = (ok, msg) => {
            if (done) return;
            done = true;
            try { sock.destroy(); } catch (_) {}
            resolve({ ok, ms: Date.now() - started, msg });
        };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => finish(true, ''));
        sock.once('timeout', () => finish(false, 'timeout'));
        sock.once('error', (e) => finish(false, e.code || e.message));
        sock.connect(port, host);
    });
}

(async () => {
    // wg show ต้องใช้สิทธิ์ root — ถ้าอ่านไม่ได้ต้องบอกว่า "ข้ามชั้นนี้"
    // ไม่ใช่รายงานว่า "ไม่มี peer" ซึ่งเป็นคนละเรื่องและทำให้ตกใจฟรี
    const wg = sh('sudo -n wg show wg0 dump') || sh('wg show wg0 dump');
    const wgReadable = wg.indexOf('\t') >= 0;
    const wgPeers = new Map();
    wg.split('\n').slice(1).filter(Boolean).forEach((line) => {
        const f = line.split('\t');   // pubkey, psk, endpoint, allowed-ips, handshake, rx, tx, keepalive
        const ip = (f[3] || '').split('/')[0];
        if (ip) wgPeers.set(ip, { handshake: parseInt(f[4]) || 0, rx: parseInt(f[5]) || 0, tx: parseInt(f[6]) || 0 });
    });

    const { sites } = await db.getSites();
    console.log('');
    console.log(`ตรวจ ${sites.length} สาขา — ไล่ตั้งแต่ทะเบียนจนถึงอ่านข้อมูลจริงจากเราท์เตอร์`);
    if (!wgReadable) console.log('(อ่านสถานะ WireGuard ไม่ได้ ต้องใช้สิทธิ์ root — จะข้ามชั้นนั้นไป)');
    console.log('');

    let allOk = true;

    for (const site of sites) {
        const cfg = await db.getConfig(site.id);
        console.log('─'.repeat(68));
        console.log(`${site.name}   (${site.connectionType || 'direct'})`);

        const problems = [];

        if (!cfg.host || !cfg.username) {
            console.log('   ตั้งค่า      : ไม่ครบ (host หรือ username ว่าง)');
            console.log('   สรุป        : มีปัญหา -> ตั้งค่าไม่ครบ');
            allOk = false;
            continue;
        }
        console.log(`   ปลายทาง     : ${cfg.host}:${cfg.port || 8728}   user=${cfg.username}` +
                    (cfg.password ? '' : '   *** ไม่มีรหัสผ่าน ***'));
        if (!cfg.password) problems.push('ไม่มีรหัสผ่าน');

        const viaVpn = site.wireguardIp && String(cfg.host).startsWith('10.10.88.');
        if (viaVpn) {
            const p = wgPeers.get(site.wireguardIp);
            if (!wgReadable) {
                console.log('   WireGuard   : ข้าม (อ่านไม่ได้ด้วยสิทธิ์ปัจจุบัน)');
            } else if (!p) {
                console.log('   WireGuard   : *** ไม่มี peer ใน wg0 ***');
                problems.push('ไม่มี WireGuard peer');
            } else {
                const age = p.handshake ? Math.round(Date.now() / 1000 - p.handshake) : null;
                // keepalive ปกติ 25 วินาที เกิน 180 = อุโมงค์น่าจะหลุด
                const stale = age === null || age > 180;
                console.log(`   WireGuard   : handshake ${age === null ? 'ไม่เคย' : age + ' วินาทีที่แล้ว'}` +
                            `   rx=${(p.rx / 1048576).toFixed(1)}MB tx=${(p.tx / 1048576).toFixed(1)}MB` +
                            (stale ? '   *** เก่าเกินไป ***' : ''));
                if (stale) problems.push('WireGuard handshake เก่า');
            }

            // ยิง 20 ครั้งเพื่อให้ตัวเลขมีความหมาย และเตือนเมื่อหายเกิน 30% เท่านั้น
            //
            // เดิมยิง 5 ครั้งแล้วเตือนทันทีที่หาย > 0% ซึ่งแพ็กเก็ตหายใบเดียวก็ขึ้น 20%
            // แล้วรายงานว่า "มีปัญหา" ทั้งที่ API ยังต่อได้ปกติใน 410 ms
            // ลิงก์อินเทอร์เน็ตบ้านทั่วไปหายบ้างเป็นเรื่องปกติ เครื่องมือที่เตือนทุกครั้ง
            // ที่หายใบเดียวจะถูกเมิน แล้วตอนมีปัญหาจริงก็ไม่มีใครอ่าน
            const ping = sh(`ping -c 20 -i 0.2 -W 2 ${cfg.host} 2>&1`);
            const loss = (/(\d+)% packet loss/.exec(ping) || [])[1];
            const rtt = (/rtt [^=]*= [\d.]+\/([\d.]+)\//.exec(ping) || [])[1];
            if (loss === undefined) {
                console.log('   Ping        : ใช้คำสั่ง ping ไม่ได้ — ข้าม');
            } else {
                const pct = parseInt(loss);
                console.log(`   Ping        : loss ${loss}% (จาก 20 ครั้ง)` + (rtt ? `   avg ${rtt} ms` : '') +
                            (pct > 0 && pct <= 30 ? '   — หายประปรายถือว่าปกติ' : ''));
                if (pct > 30) problems.push(`ping สูญหาย ${loss}%`);
            }
        }

        const tcp = await tcpProbe(cfg.host, cfg.port || 8728);
        console.log(`   TCP         : ${tcp.ok ? 'ต่อได้ใน ' + tcp.ms + ' ms' : '*** ต่อไม่ได้: ' + tcp.msg + ' ***'}`);
        if (!tcp.ok) problems.push('TCP ต่อไม่ได้');

        if (tcp.ok) {
            const client = new RouterOS(cfg.host, cfg.port, cfg.username, cfg.password, { connectTimeoutMs: 10000 });
            const t0 = Date.now();
            try {
                await client.connect();
                const [res, id, hs, pp] = await Promise.all([
                    client.exec('/system/resource/print'),
                    client.exec('/system/identity/print'),
                    client.exec('/ip/hotspot/active/print').catch(() => []),
                    client.exec('/ppp/active/print').catch(() => [])
                ]);
                const r = res[0] || {};
                const freeMb = Math.round((parseInt(r['free-memory']) || 0) / 1048576);
                console.log(`   RouterOS API: ต่อได้ใน ${Date.now() - t0} ms   identity=${(id[0] || {}).name || '-'}`);
                console.log(`   เราท์เตอร์   : ROS ${r.version}   uptime ${r.uptime}   cpu ${r['cpu-load']}%   free-mem ${freeMb}MB`);
                console.log(`   ใช้งานอยู่   : Hotspot ${hs.length} คน   PPPoE ${pp.length} ห้อง`);
                if (freeMb < 20) problems.push(`หน่วยความจำเหลือน้อย (${freeMb}MB)`);
            } catch (e) {
                console.log(`   RouterOS API: *** ล้มเหลว: ${e.message} ***`);
                problems.push('API: ' + e.message);
            } finally {
                try { client.close(); } catch (_) {}
            }
        }

        if (problems.length) {
            allOk = false;
            console.log('   สรุป        : มีปัญหา -> ' + problems.join(' | '));
        } else {
            console.log('   สรุป        : ปกติทุกชั้น');
        }
    }

    console.log('─'.repeat(68));
    console.log('');
    console.log(allOk ? 'ทุกสาขาเชื่อมต่อได้ปกติทุกชั้น' : '*** มีสาขาที่ต้องตรวจสอบ (ดูรายละเอียดด้านบน) ***');
    process.exit(allOk ? 0 : 1);
})().catch((e) => {
    console.error('ล้มเหลว:', e.message);
    process.exit(2);
});
