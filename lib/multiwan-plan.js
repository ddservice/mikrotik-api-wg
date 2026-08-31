/**
 * lib/multiwan-plan.js — แปลงผลวิเคราะห์เป็นแผนลงมือ ที่ทุกขั้นย้อนกลับได้
 *
 * หลักที่ยึด: เราคุยกับเราท์เตอร์ผ่านสายที่กำลังจะไปแก้ ถ้าแก้พลาดคือขาดการติดต่อ
 * ทันทีและกู้จากระยะไกลไม่ได้ ทุกอย่างในไฟล์นี้จึงออกแบบรอบสมมติฐานว่า
 * "เราอาจหลุดกลางคัน"
 *
 * สามชั้นที่กันไว้:
 *   1. ตั้ง distance ของ default route เดิมให้สูงขึ้น แทนที่จะลบทิ้ง — ถ้าเส้นทางใหม่
 *      ใช้ไม่ได้ RouterOS จะตกกลับไปใช้ของเดิมเอง เน็ตไม่ดับ
 *   2. ทุกอย่างที่เพิ่มติดคอมเมนต์เฉพาะไว้ ทำให้ถอนออกได้ครบโดยไม่แตะของเดิม
 *   3. ตั้งเวลาถอนไว้บนเราท์เตอร์ล่วงหน้า ถ้าเราหลุดจนสั่งอะไรไม่ได้ มันถอนตัวเอง
 *
 * ชั้นที่ 3 สำคัญที่สุด เพราะเป็นชั้นเดียวที่ยังทำงานตอนที่เราสั่งอะไรไม่ได้แล้ว
 */

'use strict';

/** คอมเมนต์กำกับของที่ระบบนี้สร้าง ใช้เป็นที่จับตอนถอน */
const TAG = 'DDS-FAILOVER';

/** ปลายทางสำหรับเช็คว่าสายนั้นยังออกเน็ตได้จริง — ต้องคนละตัวต่อสาย */
const DEFAULT_CHECK_HOSTS = ['8.8.8.8', '1.1.1.1', '9.9.9.9', '208.67.222.222'];

/**
 * distance ที่ดันของเดิมขึ้นไป
 *
 * ต้องสูงกว่าเส้นทางใหม่ทั้งหมด เพื่อให้ของใหม่ถูกใช้ก่อน แต่ยังอยู่เป็นตาข่ายรับ
 * ถ้าเส้นทางใหม่ถูก check-gateway ตัดออกทั้งหมด
 */
const FALLBACK_DISTANCE_BASE = 10;

function pathFor(kind) {
    return kind === 'pppoe' ? '/interface/pppoe-client/set' : '/ip/dhcp-client/set';
}

/**
 * สร้างแผนทำสำรองอัตโนมัติ
 *
 * @param {object} analysis ผลจาก analyzeState()
 * @param {object} [opts] {order: [interfaceName,...] เรียงจากสายหลักไปสายสำรอง,
 *                         checkHosts: [ip,...]}
 * @returns {{steps: Array, wans: Array, tag: string, checkHosts: object}}
 */
function buildFailoverPlan(analysis, opts = {}) {
    if (!analysis || !analysis.canFailover) {
        const why = (analysis && analysis.blockers || []).map((b) => b.message).join('; ');
        throw new Error('ยังทำสำรองไม่ได้: ' + (why || 'สภาพเราท์เตอร์ไม่พร้อม'));
    }

    const usable = analysis.usable.slice();
    // เรียงตามที่คนเลือก ถ้าไม่ได้เลือกก็ใช้ลำดับที่เจอ (PPPoE มาก่อน DHCP)
    const order = Array.isArray(opts.order) && opts.order.length ? opts.order : null;
    const wans = order
        ? order.map((n) => usable.find((w) => w.interface === n)).filter(Boolean)
        : usable;

    if (wans.length < 2) {
        throw new Error('ต้องเลือกสายอย่างน้อย 2 สาย และชื่อต้องตรงกับที่มีบนเราท์เตอร์');
    }

    const hosts = opts.checkHosts && opts.checkHosts.length ? opts.checkHosts : DEFAULT_CHECK_HOSTS;
    const checkHosts = {};
    wans.forEach((w, i) => { checkHosts[w.interface] = hosts[i % hosts.length]; });

    const steps = [];

    // ---- ขั้นที่ 1: ดัน default route เดิมให้อยู่ลำดับหลัง (ยังอยู่ ไม่ได้ลบ) ----
    wans.forEach((w, i) => {
        if (!w.id) return;   // ไม่มี id ก็สั่งแก้ไม่ได้
        const next = FALLBACK_DISTANCE_BASE + i;
        if (w.defaultRouteDistance === next) return;   // ตรงอยู่แล้ว ไม่ต้องแตะ
        steps.push({
            id: `distance-${w.interface}`,
            title: `ดันเส้นทางเดิมของ ${w.interface} ไปลำดับ ${next}`,
            why: 'ยังเก็บไว้เป็นตาข่ายรับ ถ้าเส้นทางใหม่ใช้ไม่ได้ เน็ตจะตกกลับมาเส้นนี้เอง ' +
                 'ไม่ดับ — ปลอดภัยกว่าลบทิ้งแล้วหวังว่าของใหม่จะทำงาน',
            risk: 'low',
            apply: { cmd: pathFor(w.kind), args: { '.id': w.id, 'default-route-distance': String(next) } },
            undo: {
                cmd: pathFor(w.kind),
                args: {
                    '.id': w.id,
                    'default-route-distance': String(w.defaultRouteDistance == null ? 1 : w.defaultRouteDistance)
                }
            }
        });
    });

    // ---- ขั้นที่ 2: เส้นทางตรวจสาย ผูกแต่ละสายไว้กับ gateway ของตัวเอง ----
    wans.forEach((w) => {
        const host = checkHosts[w.interface];
        const args = {
            'dst-address': `${host}/32`,
            gateway: w.gatewayIsInterface ? w.interface : w.gateway,
            scope: '10',
            'target-scope': '10',
            comment: `${TAG} check ${w.interface}`
        };
        steps.push({
            id: `check-${w.interface}`,
            title: `ผูกการตรวจสาย ${w.interface} ไว้กับ ${host}`,
            why: `บังคับให้ ping ไป ${host} วิ่งออกทาง ${w.interface} เท่านั้น ` +
                 'ถ้าไม่ผูกแบบนี้ การตรวจจะวิ่งออกสายไหนก็ได้ แล้วสายที่ตายจริงจะดูเหมือนยังดีอยู่',
            risk: 'low',
            apply: { cmd: '/ip/route/add', args },
            undo: { type: 'remove-added', cmd: '/ip/route/remove' }
        });
    });

    // ---- ขั้นที่ 3: เส้นทางออกเน็ตแบบมีลำดับ + ตรวจว่ายังใช้ได้ ----
    wans.forEach((w, i) => {
        const host = checkHosts[w.interface];
        const distance = i + 1;
        const origDistance = w.defaultRouteDistance == null ? 1 : w.defaultRouteDistance;
        const args = {
            'dst-address': '0.0.0.0/0',
            gateway: host,
            'check-gateway': 'ping',
            distance: String(distance),
            scope: '30',
            'target-scope': '11',
            // ฝัง distance เดิมไว้ในคอมเมนต์ เพื่อให้ถอนทีหลังคืนค่าได้ถูกต้อง
            //
            // ถ้าไม่ฝังไว้ ตอนถอนจะอ่านค่า "ปัจจุบัน" (ซึ่งถูกดันไปแล้ว) มาเป็นค่าเดิม
            // แล้วคืนค่าทับด้วยตัวมันเอง — เท่ากับไม่ได้คืนอะไรเลย
            // เก็บไว้บนเราท์เตอร์ ไม่ใช่ในฐานข้อมูลของเรา เพราะตัวถอนต้องทำงานได้
            // แม้ระบบเราจะไม่อยู่แล้ว
            comment: `${TAG} default ${w.interface} d=${distance} orig=${origDistance}`
        };
        steps.push({
            id: `default-${w.interface}`,
            title: i === 0
                ? `ตั้ง ${w.interface} เป็นสายหลัก (ลำดับ ${distance})`
                : `ตั้ง ${w.interface} เป็นสายสำรองลำดับ ${distance}`,
            why: i === 0
                ? 'ใช้สายนี้ก่อนเสมอ และให้เราท์เตอร์ ping ตรวจตลอด ถ้าสายตายจะตัดเส้นนี้ออกเอง'
                : 'จะถูกใช้อัตโนมัติเมื่อสายลำดับก่อนหน้าตรวจแล้วไม่ผ่าน',
            risk: i === 0 ? 'high' : 'medium',
            apply: { cmd: '/ip/route/add', args },
            undo: { type: 'remove-added', cmd: '/ip/route/remove' }
        });
    });

    // ---- ขั้นที่ 4: NAT ให้สายที่ยังไม่มี ----
    wans.forEach((w) => {
        if (w.hasNat) return;
        const args = {
            chain: 'srcnat',
            action: 'masquerade',
            'out-interface': w.interface,
            comment: `${TAG} nat ${w.interface}`
        };
        steps.push({
            id: `nat-${w.interface}`,
            title: `เปิด NAT ให้ ${w.interface}`,
            why: 'สายนี้ยังไม่มี masquerade ถ้าสลับมาใช้แล้วไม่มี NAT เครื่องลูกข่ายจะออกเน็ตไม่ได้ ' +
                 'ซึ่งจะดูเหมือนสำรองไม่ทำงาน ทั้งที่เส้นทางถูกแล้ว',
            risk: 'low',
            apply: { cmd: '/ip/firewall/nat/add', args },
            undo: { type: 'remove-added', cmd: '/ip/firewall/nat/remove' }
        });
    });

    return { steps, wans, tag: TAG, checkHosts };
}

/**
 * สคริปต์ถอนที่ฝากไว้บนเราท์เตอร์
 *
 * ต้องเป็นสคริปต์ที่รันบนเราท์เตอร์เอง ไม่ใช่คำสั่งจากเรา เพราะกรณีที่ต้องใช้มัน
 * คือกรณีที่เราสั่งอะไรไม่ได้แล้ว
 *
 * ถอนของที่เพิ่มด้วยคอมเมนต์กำกับ แล้วคืนค่า distance เดิม สุดท้ายลบตัวเองทิ้ง
 */
function buildRollbackScript(plan) {
    const lines = [
        `/ip route remove [find comment~"${TAG}"]`,
        `/ip firewall nat remove [find comment~"${TAG}"]`
    ];
    plan.wans.forEach((w) => {
        if (!w.id) return;
        const d = w.defaultRouteDistance == null ? 1 : w.defaultRouteDistance;
        const p = w.kind === 'pppoe' ? '/interface pppoe-client' : '/ip dhcp-client';
        lines.push(`${p} set [find where .id="${w.id}"] default-route-distance=${d}`);
    });
    // ลบตัวเองเป็นคำสั่งสุดท้าย ไม่งั้นมันจะถอนซ้ำทุกรอบ
    lines.push(`/system scheduler remove [find comment~"${TAG}"]`);
    return lines.join('\n');
}

/** คำสั่งฝากตัวถอนไว้ล่วงหน้า */
function buildArmCommand(plan, seconds) {
    return {
        cmd: '/system/scheduler/add',
        args: {
            name: `${TAG}-rollback`,
            interval: `${seconds}s`,
            'on-event': buildRollbackScript(plan),
            comment: `${TAG} ถอนอัตโนมัติถ้าไม่มีการยืนยันภายใน ${seconds} วินาที`
        }
    };
}

/**
 * อ่าน distance เดิมกลับจากคอมเมนต์ที่ฝังไว้
 * @returns {object} map ของ interface -> distance เดิม
 */
function parseOriginalDistances(routes) {
    const out = {};
    (Array.isArray(routes) ? routes : []).forEach((r) => {
        // รูปแบบ: "<TAG> default <interface> d=<n> orig=<n>"
        // แยกด้วยช่องว่างแทนการใช้ regex — อ่านออกว่ากำลังจับอะไร และไม่มีปัญหา
        // เรื่อง escape ที่ทำให้ pattern เพี้ยนเงียบ ๆ
        const parts = String(r.comment || '').trim().split(/\s+/);
        if (parts[0] !== TAG || parts[1] !== 'default') return;
        const iface = parts[2];
        const orig = parts.find((x) => x.startsWith('orig='));
        if (!iface || !orig) return;
        const n = Number(orig.slice(5));
        if (Number.isFinite(n)) out[iface] = n;
    });
    return out;
}

module.exports = {
    TAG,
    parseOriginalDistances,
    DEFAULT_CHECK_HOSTS,
    FALLBACK_DISTANCE_BASE,
    buildFailoverPlan,
    buildRollbackScript,
    buildArmCommand
};
