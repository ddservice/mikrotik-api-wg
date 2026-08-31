/**
 * lib/multiwan-apply.js — ลงแผนจริงแบบที่ถอยกลับได้เสมอ
 *
 * ลำดับนี้จงใจ ไม่ใช่แค่ความเรียบร้อย:
 *
 *   1. สำรองค่าทั้งเครื่องไว้ก่อน            (ตาข่ายชั้นสุดท้าย ถ้าทุกอย่างพัง)
 *   2. ฝากตัวถอนไว้บนเราท์เตอร์ก่อนแตะอะไร   (ชั้นเดียวที่ยังทำงานตอนเราหลุด)
 *   3. ลงทีละขั้น จำ id ของทุกอย่างที่เพิ่ม   (ถอนได้ตรงตัว ไม่ต้องเดา)
 *   4. ตรวจว่ายังออกเน็ตได้จริง             (ไม่ใช่แค่ "คำสั่งไม่ error")
 *   5. ผ่านค่อยปลดตัวถอน / ไม่ผ่านถอนทันที
 *
 * ข้อ 2 ต้องมาก่อนข้อ 3 เสมอ ถ้าสลับกันแล้วเราหลุดระหว่างข้อ 3 จะไม่มีอะไรมากู้เลย
 *
 * ข้อ 4 สำคัญพอ ๆ กัน: RouterOS รับคำสั่งที่ทำให้เน็ตดับได้โดยไม่ error สักตัว
 * "สั่งผ่าน" กับ "ใช้งานได้" เป็นคนละเรื่อง
 */

'use strict';

const mwPlan = require('./multiwan-plan');
const rosErrors = require('./routeros-errors');

/** เวลารอก่อนถอนอัตโนมัติ ถ้าไม่มีการยืนยัน */
const DEFAULT_ROLLBACK_SECONDS = 180;

/** ต้องได้ตอบกลับอย่างน้อยเท่านี้ถึงจะถือว่าสายใช้ได้ */
const PING_COUNT = 4;
const PING_MIN_REPLIES = 2;

function nowTag() {
    return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * ยิง ping จากตัวเราท์เตอร์เอง เพื่อดูว่ายังออกเน็ตได้จริงไหม
 *
 * ping จากเราไม่นับ เพราะเราอาจเข้าถึงเราท์เตอร์ผ่านอุโมงค์ซึ่งไม่ได้พิสูจน์ว่า
 * ทางออกอินเทอร์เน็ตของสาขายังดีอยู่
 */
async function pingFromRouter(client, address, count = PING_COUNT) {
    const res = await client.exec('/ping', { address, count: String(count) },
        { timeoutMs: (count + 15) * 1000 });
    const rows = Array.isArray(res) ? res : [];
    const replies = rows.filter((r) => {
        const recv = Number(r.received != null ? r.received : 0);
        const status = String(r.status || '').toLowerCase();
        return recv > 0 || (!status && r.time != null);
    }).length;
    return { replies, sent: rows.length || count };
}

/**
 * ลงแผนสำรองอัตโนมัติ
 *
 * @param {object} o
 * @param {object} o.client           RouterOS client ที่ต่ออยู่แล้ว
 * @param {object} o.plan             ผลจาก buildFailoverPlan()
 * @param {number} [o.rollbackSeconds]
 * @param {boolean} [o.skipBackup]
 * @param {function} [o.onProgress]   เรียกทุกครั้งที่ขยับ ใช้ส่งสถานะให้หน้าจอ
 * @returns {Promise<object>}
 */
async function applyFailover(o) {
    const { client, plan } = o;
    const rollbackSeconds = o.rollbackSeconds || DEFAULT_ROLLBACK_SECONDS;
    const progress = typeof o.onProgress === 'function' ? o.onProgress : () => {};

    const done = [];          // ขั้นที่ลงไปแล้ว พร้อม id ที่ได้กลับมา
    const logs = [];
    let armed = false;
    let backupName = null;

    const say = (phase, message, extra) => {
        const item = Object.assign({ phase, message, at: Date.now() }, extra || {});
        logs.push(item);
        progress(item);
    };

    try {
        // ---- 0. ตรวจสิทธิ์ก่อนแตะอะไร ----
        //
        // ขั้น verify ใช้ /ping ซึ่งต้องมีสิทธิ์ test บน RouterOS ถ้าผู้ใช้ API ไม่มี
        // สิทธิ์นั้น เราจะลงครบทุกขั้นแล้วไปพังตอน verify แล้วถอนคืนทั้งหมด —
        // ปลอดภัยแต่เสียเวลาเปล่า และทำให้เน็ตสาขาสะดุดโดยไม่จำเป็น
        //
        // สาขา 3 ใน 4 ของระบบนี้ยังไม่มีสิทธิ์ test (พบเมื่อ 2026-08-31)
        // จึงต้องตรวจก่อน ไม่ใช่ค้นพบตอนกลางคัน
        try {
            await client.exec('/ping', { address: '127.0.0.1', count: '1' },
                { timeoutMs: 20000 });
        } catch (permErr) {
            if (rosErrors.isPermissionError(permErr)) {
                const e = new Error(rosErrors.explain(permErr, { task: 'nettest' }) +
                    String.fromCharCode(10) +
                    'ยังไม่ได้แตะเราท์เตอร์เลย — เพิ่มสิทธิ์แล้วค่อยกดใหม่');
                e.preflight = true;
                throw e;
            }
            // ping ไม่ผ่านด้วยเหตุอื่น (เช่นสายล่ม) ไม่ใช่เรื่องสิทธิ์ ปล่อยให้ไปต่อ
            // แล้วให้ขั้น verify เป็นตัวตัดสิน
        }

        // ---- 1. สำรองค่าทั้งเครื่อง ----
        if (!o.skipBackup) {
            backupName = `pre-failover-${nowTag()}`;
            await client.exec('/system/backup/save', { name: backupName },
                { timeoutMs: 120000 });
            say('backup', `สำรองค่าไว้เป็นไฟล์ ${backupName}.backup บนเราท์เตอร์แล้ว`,
                { backupName });
        }

        // ---- 2. ฝากตัวถอนไว้ก่อนแตะอะไรทั้งนั้น ----
        // ต้องมาก่อนการแก้ ไม่ใช่หลัง เพราะกรณีที่ต้องใช้คือกรณีที่เราหลุดกลางคัน
        const arm = mwPlan.buildArmCommand(plan, rollbackSeconds);
        await client.exec(arm.cmd, arm.args);

        // อ่านกลับมาดูว่ามันอยู่จริง ไม่เชื่อว่าคำสั่งผ่านแล้วแปลว่าได้ผล
        //
        // สองอย่างที่การอ่านกลับจับได้ และเราตรวจด้วยวิธีอื่นไม่ได้เลย:
        //  - RouterOS รับ on-event หลายบรรทัดผ่าน API ไม่ได้ แล้วเก็บสคริปต์ว่างไว้
        //  - scheduler ยิงทันทีที่สร้าง (ขึ้นกับค่า start-time ของแต่ละรุ่น)
        //    แล้วลบตัวเองไปตั้งแต่ก่อนเราจะได้แก้อะไร
        //
        // ทั้งสองกรณีทำให้เราลงค่าต่อไปโดยไม่มีตาข่ายรับ ทั้งที่หน้าจอบอกว่ามี
        // ซึ่งแย่กว่าการไม่มีตาข่ายแล้วรู้ตัว
        const armedRows = await client.exec('/system/scheduler/print');
        const mine = (Array.isArray(armedRows) ? armedRows : [])
            .find((r) => String(r.name || '') === mwPlan.ROLLBACK_NAME);
        if (!mine) {
            const e = new Error(
                'สร้างตัวถอนอัตโนมัติบนเราท์เตอร์ไม่สำเร็จ — ยังไม่ได้แก้อะไรเลย' +
                String.fromCharCode(10) +
                'ไม่ลงต่อโดยไม่มีตัวถอน เพราะถ้าหลุดกลางคันจะกู้จากระยะไกลไม่ได้'
            );
            e.preflight = true;
            throw e;
        }
        if (!String(mine['on-event'] || '').includes('/ip route remove')) {
            const e = new Error(
                'ตัวถอนอัตโนมัติถูกสร้างแต่สคริปต์ข้างในไม่ครบ — ยังไม่ได้แก้อะไรเลย' +
                String.fromCharCode(10) +
                'เป็นไปได้ว่าเราท์เตอร์รุ่นนี้ไม่รับสคริปต์หลายบรรทัดผ่าน API'
            );
            e.preflight = true;
            // ลบตัวที่ไม่สมบูรณ์ทิ้ง ไม่ทิ้งขยะไว้บนเราท์เตอร์
            try { await client.exec('/system/scheduler/remove', { '.id': mine['.id'] }); } catch (_) {}
            throw e;
        }
        armed = true;
        say('arm', `ฝากคำสั่งถอนไว้บนเราท์เตอร์แล้ว — ถ้าไม่ได้ยืนยันภายใน ` +
                   `${rollbackSeconds} วินาที มันจะคืนค่าเดิมเอง`, { rollbackSeconds });

        // ---- 3. ลงทีละขั้น ----
        for (const step of plan.steps) {
            const res = await client.exec(step.apply.cmd, step.apply.args);
            // RouterOS คืน .id ของสิ่งที่เพิ่ง add มาให้ ใช้เป็นที่จับตอนถอน
            const addedId = Array.isArray(res) && res[0] && (res[0]['.id'] || res[0].ret)
                ? (res[0]['.id'] || res[0].ret) : null;
            done.push({ step, addedId });
            say('step', step.title, { stepId: step.id, addedId });
        }

        // ---- 4. ตรวจว่ายังใช้งานได้จริง ----
        const checks = [];
        for (const w of plan.wans) {
            const host = plan.checkHosts[w.interface];
            const r = await pingFromRouter(client, host);
            const ok = r.replies >= PING_MIN_REPLIES;
            checks.push({ interface: w.interface, host, replies: r.replies, sent: r.sent, ok });
            say('verify', `ตรวจสาย ${w.interface} ผ่าน ${host}: ตอบกลับ ${r.replies}/${r.sent}`,
                { ok });
        }

        const primary = checks[0];
        if (!primary || !primary.ok) {
            throw new Error(
                `สายหลัก ${primary ? primary.interface : '?'} ตรวจไม่ผ่านหลังลงค่า ` +
                `(ตอบกลับ ${primary ? primary.replies : 0}/${primary ? primary.sent : 0}) — ถอนคืนทั้งหมด`
            );
        }

        // ---- 5. ผ่านแล้วค่อยปลดตัวถอน ----
        await disarm(client);
        armed = false;
        say('commit', 'ยืนยันแล้ว — ปลดตัวถอนอัตโนมัติออก การตั้งค่าอยู่ถาวร');

        return {
            success: true, applied: done.length, checks, logs, backupName,
            rolledBack: false
        };

    } catch (err) {
        // ตกตั้งแต่ขั้นตรวจสิทธิ์ = ยังไม่ได้เขียนอะไรลงเราท์เตอร์ ไม่มีอะไรต้องถอน
        if (err && err.preflight) {
            say('preflight', err.message);
            return { success: false, error: err.message, applied: 0, logs,
                     rolledBack: false, preflight: true };
        }
        // พังกลางทาง = ถอนทุกอย่างที่ลงไปแล้ว ตามลำดับย้อนกลับ
        say('error', 'ล้มเหลว: ' + err.message);
        let rolledBack = false;
        try {
            await undoAll(client, done);
            rolledBack = true;
            say('rollback', `ถอนคืนแล้ว ${done.length} ขั้น — กลับสู่สภาพเดิม`);
        } catch (e2) {
            say('rollback-failed',
                'ถอนคืนอัตโนมัติไม่สำเร็จ: ' + e2.message +
                ' — ตัวถอนที่ฝากไว้บนเราท์เตอร์จะทำงานเองเมื่อครบเวลา');
        }
        if (armed && rolledBack) {
            // ถอนสำเร็จแล้วก็ไม่ต้องให้ตัวบนเราท์เตอร์ทำซ้ำ
            try { await disarm(client); } catch (_) { /* ปล่อยให้มันทำงานเองดีกว่าไม่มีเลย */ }
        }
        return {
            success: false, error: err.message, applied: done.length,
            logs, backupName, rolledBack
        };
    }
}

/** ถอนตามลำดับย้อนกลับ ของที่ลงทีหลังต้องถูกถอนก่อน */
async function undoAll(client, done) {
    for (let i = done.length - 1; i >= 0; i--) {
        const { step, addedId } = done[i];
        const undo = step.undo;
        if (!undo) continue;
        if (undo.type === 'remove-added') {
            if (!addedId) continue;     // ไม่รู้ id ก็ถอนตรงตัวไม่ได้ ปล่อยให้ตัวบนเราท์เตอร์จัดการ
            await client.exec(undo.cmd, { '.id': addedId });
        } else {
            await client.exec(undo.cmd, undo.args);
        }
    }
}

/**
 * ปลดเฉพาะ scheduler ตัวถอนอัตโนมัติ
 *
 * ต้องเจาะจงชื่อ ไม่ใช่ลบทุกตัวที่ติดแท็กเดียวกัน — ระบบนี้ยังสร้าง scheduler
 * ตัวอื่นที่ต้องอยู่ถาวร (ตัว sync DHCP gateway) ถ้าเหมาลบตอน commit
 * การป้องกัน DHCP gateway เปลี่ยนจะหายไปทันทีที่ติดตั้งเสร็จ
 */
async function disarm(client) {
    const rows = await client.exec('/system/scheduler/print');
    const mine = (Array.isArray(rows) ? rows : []).filter((r) =>
        String(r.name || '') === mwPlan.ROLLBACK_NAME
    );
    for (const r of mine) {
        if (r['.id']) await client.exec('/system/scheduler/remove', { '.id': r['.id'] });
    }
    return mine.length;
}

/** ลบ scheduler ทุกตัวที่ระบบนี้สร้าง — ใช้ตอนถอนออกทั้งหมด */
async function removeAllSchedulers(client) {
    const rows = await client.exec('/system/scheduler/print');
    const mine = (Array.isArray(rows) ? rows : []).filter((r) =>
        String(r.name || '').includes(mwPlan.TAG) || String(r.comment || '').includes(mwPlan.TAG)
    );
    for (const r of mine) {
        if (r['.id']) await client.exec('/system/scheduler/remove', { '.id': r['.id'] });
    }
    return mine.length;
}

/** ถอนของที่ลงไว้แล้ว โดยจับจากคอมเมนต์กำกับ — ใช้ตอนคนกดถอนเองทีหลัง */
async function removeAll(client, wans) {
    const removed = { routes: 0, nat: 0, filter: 0, netwatch: 0, scheduler: 0,
                      scripts: 0, listMembers: 0, lists: 0, dnsRestored: false };

    const routes = await client.exec('/ip/route/print');
    // อ่านค่า distance เดิมจากคอมเมนต์ก่อนลบเส้นทางทิ้ง ไม่งั้นข้อมูลหายไปพร้อมกัน
    const originals = mwPlan.parseOriginalDistances(routes);
    for (const r of (Array.isArray(routes) ? routes : [])) {
        if (String(r.comment || '').includes(mwPlan.TAG) && r['.id']) {
            await client.exec('/ip/route/remove', { '.id': r['.id'] });
            removed.routes++;
        }
    }
    const nat = await client.exec('/ip/firewall/nat/print');
    for (const n of (Array.isArray(nat) ? nat : [])) {
        if (String(n.comment || '').includes(mwPlan.TAG) && n['.id']) {
            await client.exec('/ip/firewall/nat/remove', { '.id': n['.id'] });
            removed.nat++;
        }
    }
    // คืน distance เดิมของแต่ละสาย
    //
    // ต้องใช้ค่าที่ฝังไว้ในคอมเมนต์ ไม่ใช่ค่าที่อ่านได้ตอนนี้ — เพราะตอนนี้มันคือค่า
    // ที่เราดันไปเองแล้ว ถ้าเอามาคืนก็เท่ากับเขียนทับด้วยตัวมันเอง ไม่ได้คืนอะไรเลย
    for (const w of (wans || [])) {
        if (!w.id) continue;
        const orig = originals[w.interface];
        const restore = orig != null
            ? orig
            // ไม่มีค่าที่ฝังไว้ (เช่นคนลบคอมเมนต์ทิ้ง) ให้กลับไปค่าตั้งต้นของ RouterOS
            : 1;
        const path = w.kind === 'pppoe' ? '/interface/pppoe-client/set' : '/ip/dhcp-client/set';
        await client.exec(path, { '.id': w.id, 'default-route-distance': String(restore) });
    }
    // คืนค่า DNS ก่อนอย่างอื่น โดยรันสคริปต์ที่เก็บค่าเดิมไว้ตอนติดตั้ง
    //
    // ต้องมาก่อนการลบสคริปต์ ไม่งั้นค่าเดิมหายไปพร้อมกับตัวที่จะเอาไปคืน
    const scripts = await client.exec('/system/script/print').catch(() => []);
    for (const sc of (Array.isArray(scripts) ? scripts : [])) {
        if (String(sc.comment || '').includes(mwPlan.TAG + ' dns restore') && sc['.id']) {
            try {
                await client.exec('/system/script/run', { '.id': sc['.id'] });
                removed.dnsRestored = true;
            } catch (e) {
                // คืนค่า DNS ไม่สำเร็จต้องไม่ทำให้การถอนที่เหลือหยุดกลางคัน
                removed.dnsRestoreError = e.message;
            }
        }
    }
    for (const sc of (Array.isArray(scripts) ? scripts : [])) {
        if (String(sc.comment || '').includes(mwPlan.TAG) && sc['.id']) {
            await client.exec('/system/script/remove', { '.id': sc['.id'] }).catch(() => {});
            removed.scripts++;
        }
    }

    const fw = await client.exec('/ip/firewall/filter/print').catch(() => []);
    for (const f of (Array.isArray(fw) ? fw : [])) {
        if (String(f.comment || '').includes(mwPlan.TAG) && f['.id']) {
            await client.exec('/ip/firewall/filter/remove', { '.id': f['.id'] });
            removed.filter++;
        }
    }

    const nw = await client.exec('/tool/netwatch/print').catch(() => []);
    for (const n of (Array.isArray(nw) ? nw : [])) {
        if (String(n.comment || '').includes(mwPlan.TAG) && n['.id']) {
            await client.exec('/tool/netwatch/remove', { '.id': n['.id'] });
            removed.netwatch++;
        }
    }
    // สมาชิกต้องถูกลบก่อน list ไม่งั้น RouterOS ปฏิเสธเพราะยังมีของอ้างอยู่
    const mem = await client.exec('/interface/list/member/print').catch(() => []);
    for (const m of (Array.isArray(mem) ? mem : [])) {
        if (String(m.comment || '').includes(mwPlan.TAG) && m['.id']) {
            await client.exec('/interface/list/member/remove', { '.id': m['.id'] }).catch(() => {});
            removed.listMembers++;
        }
    }
    const lists = await client.exec('/interface/list/print').catch(() => []);
    for (const l of (Array.isArray(lists) ? lists : [])) {
        if (String(l.comment || '').includes(mwPlan.TAG) && l['.id']) {
            await client.exec('/interface/list/remove', { '.id': l['.id'] }).catch(() => {});
            removed.lists++;
        }
    }

    removed.scheduler = await removeAllSchedulers(client);
    return removed;
}

module.exports = {
    DEFAULT_ROLLBACK_SECONDS,
    PING_COUNT,
    PING_MIN_REPLIES,
    applyFailover,
    undoAll,
    disarm,
    removeAllSchedulers,
    removeAll,
    pingFromRouter
};
