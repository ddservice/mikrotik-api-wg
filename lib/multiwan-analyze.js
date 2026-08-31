/**
 * lib/multiwan-analyze.js — อ่านสภาพจริงของเราท์เตอร์ แล้วบอกว่าทำอะไรได้บ้าง
 *
 * ทำไมต้องมี: ฟอร์ม Multi-WAN เดิมให้คนพิมพ์ชื่อ interface กับ gateway เอง แล้วเชื่อ
 * ตามนั้น ซึ่งผิดได้ตั้งแต่ตัวอักษรแรก และ RouterOS ก็รับกฎที่อ้างของที่ไม่มีอยู่จริง
 * ไปเฉย ๆ ไม่ฟ้อง ผลคือได้เส้นทางที่ตายเงียบ ๆ พร้อมข้อความว่าสำเร็จ
 *
 * โมดูลนี้ตัดการเดาออกทั้งหมด: ทุกอย่างมาจากสิ่งที่เราท์เตอร์ตอบกลับมาจริง
 *
 * ทั้งหมดเป็นฟังก์ชันบริสุทธิ์ รับ state ที่อ่านมาแล้ว ไม่ต่อเน็ตเอง — เพื่อให้
 * เทสต์ได้โดยไม่ต้องมีเราท์เตอร์ และเพื่อให้ตรรกะการตัดสินใจถูกตรวจสอบได้
 */

'use strict';

/** ตัวเลือกที่แนะนำได้ */
const MODE = {
    FAILOVER: 'failover',
    PCC: 'pcc',
    NONE: 'none'
};

/**
 * PCC จะแบ่งการเชื่อมต่อลงทุกสายตามน้ำหนัก ถ้าสายสำรองช้ากว่าสายหลักมาก
 * ครึ่งหนึ่งของงานจะวิ่งลงสายช้าตลอดเวลา ผู้ใช้จะรู้สึกว่า "เน็ตช้าลงหลังทำ
 * โหลดบาลานซ์" ซึ่งเป็นเรื่องจริง ไม่ใช่ความรู้สึก
 *
 * 4 เท่าเป็นเส้นแบ่งที่ตั้งไว้แบบระมัดระวัง: 100/50 (2 เท่า) ยังพอแบ่งได้
 * แต่ 500/50 (10 เท่า) ไม่ควรแบ่ง
 */
const PCC_MAX_SPEED_RATIO = 4;

function toArr(v) { return Array.isArray(v) ? v : []; }
function truthy(v) { return v === true || v === 'true' || v === 'yes'; }
function isDisabled(row) { return truthy(row && row.disabled); }

/**
 * หา WAN ที่มีอยู่จริงจากสิ่งที่เราท์เตอร์ตอบ
 *
 * ไม่ถามคนว่ามีสายอะไรบ้าง แต่ดูจาก PPPoE client และ DHCP client ที่ตั้งไว้จริง
 * ซึ่งเป็นสองวิธีที่สาขาทั้งหมดใช้ต่อออกเน็ต
 */
function detectWans(state) {
    const wans = [];

    toArr(state.pppoeClients).forEach((c) => {
        const iface = c.name || c['interface'] || '';
        wans.push({
            kind: 'pppoe',
            interface: iface,
            // PPPoE เป็นลิงก์จุดต่อจุด ปลายทางเป็น IP ที่เปลี่ยนได้ทุกครั้งที่ต่อใหม่
            // จึงต้องชี้ gateway ด้วยชื่อ interface ไม่ใช่ IP
            gateway: iface,
            gatewayIsInterface: true,
            parent: c['interface'] || null,
            running: truthy(c.running),
            disabled: isDisabled(c),
            defaultRouteDistance: c['default-route-distance'] != null
                ? Number(c['default-route-distance']) : null,
            addsDefaultRoute: c['add-default-route'] == null
                ? true : truthy(c['add-default-route']),
            id: c['.id'] || null
        });
    });

    toArr(state.dhcpClients).forEach((c) => {
        const iface = c['interface'] || '';
        wans.push({
            kind: 'dhcp',
            interface: iface,
            // DHCP ได้ gateway มาแบบไดนามิก และเปลี่ยนได้เมื่อได้ lease ใหม่
            // ต้องอ่านค่าปัจจุบันมาใช้ และต้องเตือนว่ามันไม่คงที่
            gateway: c.gateway || null,
            gatewayIsInterface: false,
            parent: iface,
            running: String(c.status || '').toLowerCase() === 'bound',
            disabled: isDisabled(c),
            defaultRouteDistance: c['default-route-distance'] != null
                ? Number(c['default-route-distance']) : null,
            addsDefaultRoute: c['add-default-route'] == null
                ? true : String(c['add-default-route']) !== 'no',
            status: c.status || null,
            id: c['.id'] || null
        });
    });

    return wans;
}

/** default route ที่ใช้งานอยู่ตอนนี้ */
function activeDefaultRoutes(state) {
    return toArr(state.routes).filter((r) =>
        String(r['dst-address'] || '') === '0.0.0.0/0' && !isDisabled(r)
    );
}

/** กฎ mangle ที่เกี่ยวกับ PCC หรือ mark-routing ซึ่งอาจตีกับของใหม่ */
function conflictingMangle(state) {
    return toArr(state.mangle).filter((m) => {
        if (isDisabled(m)) return false;
        if (m['per-connection-classifier']) return true;
        return m.action === 'mark-routing';
    });
}

/** WAN ตัวไหนมี masquerade แล้วบ้าง — ถ้าไม่มี สายนั้นใช้ออกเน็ตไม่ได้จริง */
function hasMasquerade(state, wan) {
    return toArr(state.nat).some((n) =>
        !isDisabled(n) &&
        n.chain === 'srcnat' &&
        n.action === 'masquerade' &&
        (n['out-interface'] === wan.interface ||
         n['out-interface-list'] === 'WAN' ||
         !n['out-interface'])
    );
}

/**
 * วิเคราะห์ว่าสภาพตอนนี้ทำอะไรได้
 *
 * @param {object} state ผลดิบจากเราท์เตอร์ (interfaces, pppoeClients, dhcpClients,
 *                       routes, mangle, nat, routingTables)
 * @param {object} [opts] {speeds: {<interface>: Mbps}}
 */
function analyzeState(state, opts = {}) {
    const speeds = opts.speeds || {};
    const ifaceNames = new Set(toArr(state.interfaces).map((i) => String(i.name || '')));

    const wans = detectWans(state).map((w) => ({
        ...w,
        existsOnRouter: ifaceNames.has(w.interface) || w.kind === 'pppoe',
        hasNat: hasMasquerade(state, w),
        speedMbps: Number(speeds[w.interface]) || null
    }));

    const usable = wans.filter((w) => w.existsOnRouter && !w.disabled);
    const up = usable.filter((w) => w.running);
    const defaults = activeDefaultRoutes(state);
    const mangleConflicts = conflictingMangle(state);

    const blockers = [];
    const warnings = [];

    if (usable.length < 2) {
        blockers.push({
            code: 'need-two-wans',
            message: `พบสายที่ใช้ได้ ${usable.length} สาย — ต้องมีอย่างน้อย 2 สายถึงจะทำสำรองได้`
        });
    }
    if (usable.length >= 2 && up.length < 2) {
        // ทำได้ แต่ยืนยันไม่ได้ว่าสายที่ยังไม่ขึ้นใช้ได้จริง
        warnings.push({
            code: 'wan-down',
            message: `มี ${usable.length} สาย แต่ตอนนี้ขึ้นจริง ${up.length} สาย — ` +
                     'สายที่ยังไม่ขึ้นจะยังสำรองไม่ได้จนกว่าจะต่อติด'
        });
    }
    usable.forEach((w) => {
        if (!w.hasNat) {
            warnings.push({
                code: 'no-nat',
                message: `สาย ${w.interface} ยังไม่มี NAT masquerade — เมื่อสลับมาใช้สายนี้ ` +
                         'เครื่องลูกข่ายจะออกเน็ตไม่ได้'
            });
        }
        if (w.kind === 'dhcp' && w.running && !w.gateway) {
            warnings.push({
                code: 'dhcp-no-gateway',
                message: `สาย ${w.interface} เป็น DHCP แต่ยังอ่าน gateway ไม่ได้`
            });
        }
    });
    if (mangleConflicts.length > 0) {
        warnings.push({
            code: 'existing-mangle',
            message: `มีกฎ mangle ที่จัดเส้นทางอยู่แล้ว ${mangleConflicts.length} ข้อ — ` +
                     'ต้องดูก่อนว่าจะตีกับของใหม่หรือไม่'
        });
    }
    if (defaults.length > 1) {
        warnings.push({
            code: 'multiple-defaults',
            message: `มี default route ใช้งานอยู่ ${defaults.length} เส้น — ` +
                     'ต้องตั้งลำดับ (distance) ให้ชัดว่าสายไหนหลักสายไหนสำรอง'
        });
    }

    return {
        wans,
        usable,
        up,
        defaultRoutes: defaults,
        mangleConflicts,
        blockers,
        warnings,
        canFailover: blockers.length === 0,
        recommendation: recommend(usable, up, mangleConflicts, speeds)
    };
}

/**
 * เลือกวิธีที่เหมาะกับสภาพจริง
 *
 * ตั้งใจให้เป็นกฎที่เขียนไว้ตรง ๆ ไม่ใช่ให้โมเดลภาษาตัดสิน เพราะ:
 *  - ต้องได้คำตอบเดิมทุกครั้งกับ input เดิม เวลาสาขาล่มแล้วต้องย้อนดูว่าทำไมถึงเลือกแบบนี้
 *  - ต้องทำงานได้ตอนเน็ตขาออกล่ม ซึ่งเป็นตอนที่ต้องใช้มันพอดี
 *  - ต้องเทสต์ได้ และเหตุผลต้องตรวจสอบได้ว่าถูกจริง
 * เกณฑ์พวกนี้มาจากข้อเท็จจริงที่วัดได้ ไม่ใช่เรื่องที่ต้องตีความ
 */
function recommend(usable, up, mangleConflicts, speeds) {
    if (usable.length < 2) {
        return {
            mode: MODE.NONE,
            title: 'ยังทำไม่ได้',
            why: ['ต้องมีสายออกเน็ตอย่างน้อย 2 สาย'],
            confidence: 'high'
        };
    }

    const reasons = [];
    const known = usable.map((w) => w.speedMbps).filter((s) => s > 0);
    let ratio = null;
    if (known.length === usable.length && known.length >= 2) {
        ratio = Math.max(...known) / Math.min(...known);
    }

    // เหตุผลที่ทำให้ PCC ไม่เหมาะ
    const pccBlockers = [];
    if (ratio != null && ratio > PCC_MAX_SPEED_RATIO) {
        pccBlockers.push(
            `ความเร็วสองสายต่างกัน ${ratio.toFixed(1)} เท่า — PCC จะโยนงานครึ่งหนึ่ง` +
            'ลงสายช้าตลอดเวลา ผู้ใช้จะรู้สึกว่าเน็ตแย่ลงหลังทำ'
        );
    }
    if (ratio == null) {
        pccBlockers.push('ยังไม่รู้ความเร็วจริงของแต่ละสาย จึงคำนวณสัดส่วนแบ่งโหลดไม่ได้');
    }
    if (up.length < usable.length) {
        pccBlockers.push('ยังมีสายที่ไม่ขึ้น — แบ่งโหลดลงสายที่ยังใช้ไม่ได้จะทำให้เน็ตเสียเป็นช่วง ๆ');
    }
    if (mangleConflicts.length > 0) {
        pccBlockers.push(`มีกฎ mangle เดิมอยู่ ${mangleConflicts.length} ข้อ ซึ่ง PCC ต้องเขียนทับ`);
    }

    if (pccBlockers.length > 0) {
        reasons.push('เลือก "สำรองอัตโนมัติ" เพราะเพิ่มความทนทานได้โดยไม่แตะเส้นทางของงานที่วิ่งอยู่');
        pccBlockers.forEach((b) => reasons.push('ไม่เลือก PCC: ' + b));
        return {
            mode: MODE.FAILOVER,
            title: 'ทำสำรองอัตโนมัติ (Failover)',
            why: reasons,
            rejected: { mode: MODE.PCC, because: pccBlockers },
            confidence: 'high'
        };
    }

    return {
        mode: MODE.PCC,
        title: 'แบ่งโหลด PCC ได้ (แนะนำให้ทำสำรองก่อน)',
        why: [
            `ความเร็วสองสายใกล้เคียงกัน (ต่างกัน ${ratio.toFixed(1)} เท่า) จึงแบ่งโหลดได้คุ้ม`,
            'ทุกสายขึ้นครบ และไม่มีกฎ mangle เดิมที่ต้องเขียนทับ',
            'ยังควรลงสำรองอัตโนมัติก่อน เพราะ PCC อย่างเดียวไม่ได้ช่วยตอนสายใดสายหนึ่งตาย'
        ],
        confidence: 'medium'
    };
}

module.exports = {
    MODE,
    PCC_MAX_SPEED_RATIO,
    detectWans,
    activeDefaultRoutes,
    conflictingMangle,
    hasMasquerade,
    analyzeState,
    recommend
};
