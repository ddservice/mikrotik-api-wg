/**
 * lib/site-diagnostics.js — ตรวจการเชื่อมต่อสาขาแบบไล่ทีละชั้น
 *
 * ทำไมต้องไล่ทีละชั้น: เวลาสาขาหนึ่งใช้ไม่ได้ คำถามแรกคือ "ติดตรงไหน" —
 * เน็ตหน้างานล่ม, อุโมงค์ VPN ไม่ขึ้น, พอร์ตถูกบล็อก หรือรหัส API ผิด
 * แต่ละอย่างแก้คนละแบบและคนละคนรับผิดชอบ การบอกแค่ "ต่อไม่ได้" ไม่ช่วยอะไร
 *
 * ทำไมต้องแยกมาเป็นโมดูล: ตรรกะชุดนี้เคยมีอยู่สามที่ — ใน endpoint
 * /api/mikrotik/diagnose-site, ใน scripts/check-sites.js และบางส่วนใน
 * scripts/diagnose-vps-status.js ซึ่งแต่ละที่เขียนเองคนละแบบและเพี้ยนกันไปเรื่อย
 * (เช่น เกณฑ์ว่า handshake เก่าแค่ไหนถึงถือว่าขาด) รวมมาไว้ที่เดียวเพื่อให้
 * หน้าเว็บกับ CLI ตอบเหมือนกันเสมอ
 *
 * ฟังก์ชันหลักรับสิ่งที่ต้องพึ่งภายนอกเป็นพารามิเตอร์ (การต่อเราท์เตอร์, การอ่าน wg)
 * จึงทดสอบได้โดยไม่ต้องมีเราท์เตอร์จริงหรือสิทธิ์ root
 */

'use strict';

const net = require('net');
const dnsp = require('dns').promises;

// keepalive ปกติ 25 วินาที เกิน 180 = อุโมงค์น่าจะขาดแล้ว ไม่ใช่แค่เงียบชั่วคราว
const WG_STALE_SECONDS = 180;
const TCP_TIMEOUT_MS = 5000;

/**
 * แปลงผลลัพธ์ `wg show wg0 dump` เป็น Map ของ tunnel IP -> ข้อมูล peer
 *
 * รูปแบบ dump: บรรทัดแรกเป็นของ interface เอง บรรทัดถัดไปเป็น peer
 * คั่นด้วย tab: pubkey, psk, endpoint, allowed-ips, handshake, rx, tx, keepalive
 */
function parseWgDump(dumpText) {
    const peers = new Map();
    if (!dumpText || dumpText.indexOf('\t') < 0) return peers;

    dumpText.split('\n').slice(1).forEach((line) => {
        if (!line.trim()) return;
        const f = line.split('\t');
        if (f.length < 5) return;
        const ip = String(f[3] || '').split('/')[0];
        if (!ip) return;
        peers.set(ip, {
            publicKey: f[0],
            endpoint: f[2] && f[2] !== '(none)' ? f[2] : null,
            handshake: parseInt(f[4]) || 0,
            rx: parseInt(f[5]) || 0,
            tx: parseInt(f[6]) || 0
        });
    });
    return peers;
}

/** สรุปสถานะ peer หนึ่งตัวเป็นข้อความที่คนอ่านแล้วรู้ว่าต้องทำอะไรต่อ */
function describeWgPeer(peer, tunnelIp, now = Date.now()) {
    if (!peer) {
        return {
            status: 'fail',
            detail: `ไม่พบ Peer ของ IP ${tunnelIp} บน wg0 ของ VPS — ` +
                    `เราท์เตอร์ยังไม่เคยลงทะเบียนคีย์เข้ามา (ใช้ปุ่มสร้างสคริปต์ WireGuard แล้ววางบนเราท์เตอร์)`
        };
    }

    if (!peer.handshake) {
        return {
            status: 'warn',
            detail: `มี Peer ${tunnelIp} บน VPS แล้ว แต่ยังไม่เคย Handshake สักครั้ง ` +
                    `(endpoint: ${peer.endpoint || 'ยังไม่มีเชื่อมเข้ามา'}) — ` +
                    `ตรวจว่าเราท์เตอร์เปิด interface WireGuard และใส่ endpoint ของ VPS ถูกต้อง`
        };
    }

    const ago = Math.floor(now / 1000) - peer.handshake;
    if (ago > WG_STALE_SECONDS) {
        return {
            status: 'warn',
            detail: `Handshake ล่าสุดเมื่อ ${ago} วินาทีที่แล้ว — ถือว่าขาดการติดต่อ ` +
                    `ตรวจ persistent-keepalive=25 บนเราท์เตอร์ และอินเทอร์เน็ตหน้างาน`
        };
    }

    return {
        status: 'ok',
        detail: `อุโมงค์ปกติ (handshake เมื่อ ${ago} วินาทีที่แล้ว, endpoint ${peer.endpoint || '-'}, ` +
                `รับ ${(peer.rx / 1048576).toFixed(1)} MB / ส่ง ${(peer.tx / 1048576).toFixed(1)} MB)`
    };
}

/** ต่อ TCP ดูว่าพอร์ตเปิดรับจริงไหม */
function tcpProbe(host, port, timeoutMs = TCP_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const started = Date.now();
        const sock = new net.Socket();
        let done = false;
        const finish = (ok, error) => {
            if (done) return;
            done = true;
            try { sock.destroy(); } catch (_) {}
            resolve({ ok, ms: Date.now() - started, error });
        };
        sock.setTimeout(timeoutMs);
        sock.once('connect', () => finish(true, null));
        sock.once('timeout', () => finish(false, `ไม่ตอบกลับภายใน ${timeoutMs / 1000} วินาที`));
        sock.once('error', (e) => finish(false, e.code || e.message));
        sock.connect(port, host);
    });
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** แปลงชื่อโฮสต์เป็น IP (ถ้าเป็น IP อยู่แล้วก็คืนค่าเดิม) */
async function resolveHost(host) {
    if (IPV4.test(host)) return { ip: host, viaDns: false };
    const r = await dnsp.lookup(host);
    return { ip: r.address, viaDns: true };
}

/** สาขานี้ต่อผ่านอุโมงค์ WireGuard หรือไม่ */
function usesWireguard(config) {
    return config.connectionType === 'wireguard' ||
           String(config.host || '').startsWith('10.10.88.') ||
           String(config.wireguardIp || '').startsWith('10.10.88.');
}

/**
 * ตรวจครบ 5 ชั้น
 *
 * @param {object} opts
 * @param {object} opts.config      ค่าการเชื่อมต่อของสาขา
 * @param {function} opts.runOnRouter  ฟังก์ชันที่รับ callback แล้วไปคุยกับเราท์เตอร์
 * @param {function} [opts.readWgDump] คืนข้อความจาก `wg show wg0 dump` (ไม่มีก็ข้ามชั้นนี้)
 * @param {number} [opts.now]
 * @returns {{ success: boolean, steps: Array }}
 */
async function diagnose({ config, runOnRouter, readWgDump, now = Date.now() }) {
    const steps = [];
    const push = (step, status, detail) => steps.push({ step, status, detail });

    // ---- 1. ทะเบียนสาขา ----
    if (!config || !config.host || !config.username) {
        push('1. ข้อมูลไซต์งาน', 'fail', 'ยังไม่ได้กรอก Host หรือ Username ของสาขานี้');
        return { success: false, steps };
    }
    push('1. ข้อมูลไซต์งาน', 'ok',
        `ชื่อ: ${config.name || '-'}, Host: ${config.host}:${config.port}, ` +
        `User: ${config.username}, การเชื่อมต่อ: ${config.connectionType || 'direct'}` +
        (config.password ? '' : '  *** ยังไม่ได้ตั้งรหัสผ่าน ***'));

    // ---- 2. ชื่อโฮสต์ ----
    let ip = config.host;
    try {
        const r = await resolveHost(config.host);
        ip = r.ip;
        push('2. ตรวจสอบชื่อ Host / DNS', 'ok',
            r.viaDns ? `แปลงชื่อ ${config.host} ➔ ${ip}` : `ใช้ IP ตรง: ${ip}`);
    } catch (e) {
        push('2. ตรวจสอบชื่อ Host / DNS', 'fail',
            `แปลงชื่อ ${config.host} เป็น IP ไม่ได้: ${e.message} — ตรวจว่าชื่อ DDNS ยังใช้งานอยู่`);
        return { success: false, steps };
    }

    // ---- 3. อุโมงค์ WireGuard (เฉพาะสาขาที่ใช้) ----
    if (usesWireguard(config)) {
        const tunnelIp = config.wireguardIp || config.host;
        let dump = null;
        try {
            dump = readWgDump ? await readWgDump() : null;
        } catch (_) {
            dump = null;
        }

        if (!dump || dump.indexOf('\t') < 0) {
            // อ่านไม่ได้ ≠ ไม่มี peer — ต้องบอกให้ถูก ไม่งั้นตกใจฟรี
            push('3. WireGuard VPN Handshake', 'warn',
                'อ่านสถานะ wg0 ไม่ได้ (ต้องใช้สิทธิ์ root) — ข้ามการตรวจชั้นนี้');
        } else {
            const r = describeWgPeer(parseWgDump(dump).get(tunnelIp), tunnelIp, now);
            push('3. WireGuard VPN Handshake', r.status, r.detail);
        }
    }

    // ---- 4. พอร์ต API ----
    const tcp = await tcpProbe(ip, config.port);
    if (!tcp.ok) {
        push('4. ตรวจสอบพอร์ต API TCP', 'fail',
            `ต่อพอร์ต ${config.port} บน ${ip} ไม่ได้: ${tcp.error} — ` +
            `ตรวจ /ip service บนเราท์เตอร์ว่าเปิดพอร์ตนี้ และไม่ถูก firewall กั้น`);
        return { success: false, steps };
    }
    push('4. ตรวจสอบพอร์ต API TCP', 'ok', `เปิดพอร์ต ${config.port} บน ${ip} ได้ใน ${tcp.ms} ms`);

    // ---- 5. ล็อกอิน API และอ่านข้อมูลจริง ----
    try {
        const info = await runOnRouter(async (client) => {
            const res = await client.exec('/system/resource/print');
            let id = [];
            try { id = await client.exec('/system/identity/print'); } catch (_) {}
            return { resource: res[0] || {}, identity: id[0] || {} };
        });
        const r = info.resource;
        push('5. เข้าสู่ระบบ RouterOS API (Authentication)', 'ok',
            `ล็อกอินสำเร็จ — Identity: "${info.identity.name || 'MikroTik'}", ` +
            `รุ่น: ${r['board-name'] || r.platform || 'RouterOS'}, ROS ${r.version || '-'}, ` +
            `uptime ${r.uptime || '-'}, CPU ${r['cpu-load'] || 0}%`);
        return { success: true, steps };
    } catch (e) {
        push('5. เข้าสู่ระบบ RouterOS API (Authentication)', 'fail',
            `ล็อกอินไม่ผ่าน: ${e.message} — ตรวจรหัสผ่านของผู้ใช้ "${config.username}" บนเราท์เตอร์`);
        return { success: false, steps };
    }
}

module.exports = {
    WG_STALE_SECONDS,
    parseWgDump,
    describeWgPeer,
    tcpProbe,
    resolveHost,
    usesWireguard,
    diagnose
};
