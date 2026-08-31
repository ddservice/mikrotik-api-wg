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
            // PPPoE ได้ IP มาเป็น local-address บน interface ที่สร้างขึ้น
            address: c['local-address'] || null,
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
            // DHCP บอก address มาในรูป 192.168.1.50/24 — ตัด prefix ออกให้อ่านง่าย
            address: c.address ? String(c.address).split('/')[0] : null,
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


/** คอมเมนต์กำกับที่ระบบนี้ติดไว้ (ต้องตรงกับ multiwan-plan.js) */
const TAG = 'DDS-FAILOVER';

/**
 * ตอนนี้ traffic ออก internet ทาง line ไหน
 *
 * ทำไมต้องรู้: failover ที่ทำงานถูกต้องจะสลับไป backup เงียบ ๆ โดยไม่มีใครรู้
 * สาขาจึงวิ่งบน line ที่ช้ากว่าได้เป็นสัปดาห์จนกว่าลูกค้าจะบ่นหรือบิลจะมา
 * ตัวนี้คือสิ่งที่ทำให้แจ้งเตือนได้ว่า "ตอนนี้ใช้ backup อยู่"
 *
 * ดูจาก default route ที่ระบบนี้สร้าง เลือกอันที่ active และ distance ต่ำสุด
 * เพราะนั่นคืออันที่ RouterOS ใช้จริง
 */
function activeFailoverWan(routes) {
    const mine = toArr(routes)
        .filter((r) => String(r.comment || '').startsWith(TAG + ' default'))
        .filter((r) => !isDisabled(r))
        // route ที่ check-gateway ตัดออกจะมี active=false — ต้องไม่นับ
        .filter((r) => r.active == null || truthy(r.active));
    if (mine.length === 0) return null;

    mine.sort((a, b) => Number(a.distance || 0) - Number(b.distance || 0));
    const parts = String(mine[0].comment).trim().split(/\s+/);
    const iface = parts[2] || null;
    const distance = Number(mine[0].distance || 0);
    return {
        interface: iface,
        distance,
        isPrimary: distance === 1,
        installed: true
    };
}


/**
 * ตรวจ "กับดัก DNS" — failover สำเร็จแล้วลูกค้ายังบอกว่าเน็ตไม่ได้
 *
 * ถ้าเครื่องลูกข่ายได้ DNS ของ ISP สายหลักมาทาง DHCP พอสายหลักตาย เส้นทางสลับ
 * ไป backup สำเร็จ แต่ DNS ยังชี้ไป resolver ที่เข้าถึงได้เฉพาะสายหลัก ผลคือ
 * เปิดเว็บไม่ได้ทั้งที่ ping IP ตรง ๆ ได้ — อาการนี้ดูเหมือน failover ไม่ทำงาน
 * ทั้งที่ routing ถูกทุกอย่าง
 *
 * ทางแก้คือให้เราท์เตอร์เป็น resolver ให้ลูกข่าย เพราะตัวเราท์เตอร์เองออกเน็ต
 * ทาง line ไหนก็ได้ตามเส้นทางที่ failover จัดให้
 */
function checkDnsResilience(state) {
    const dns = toArr(state.dns)[0] || {};
    const routerIsResolver = truthy(dns['allow-remote-requests']);
    const networks = toArr(state.dhcpNetworks);

    // network ที่แจก DNS ที่ไม่ใช่ตัวเราท์เตอร์เอง (gateway ของ network นั้น)
    const risky = networks.filter((n) => {
        const handed = String(n['dns-server'] || '').split(',').map((x) => x.trim()).filter(Boolean);
        if (handed.length === 0) return true;              // ไม่ได้ตั้ง = ลูกข่ายได้ DNS จาก ISP
        return !handed.includes(String(n.gateway || ''));  // ไม่ได้ชี้มาที่เราท์เตอร์
    });

    return {
        routerIsResolver,
        upstreamServers: String(dns.servers || '').split(',').filter(Boolean),
        networks: networks.map((n) => ({
            id: n['.id'] || null,
            address: n.address || null,
            gateway: n.gateway || null,
            dnsServer: n['dns-server'] || null
        })),
        riskyNetworks: risky.map((n) => n.address || n['.id']),
        atRisk: !routerIsResolver || risky.length > 0
    };
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

    // IP ที่แต่ละ interface ถืออยู่จริง ใช้เติมให้ line ที่ client ไม่ได้รายงานมาเอง
    const addrByIface = {};
    toArr(state.addresses).forEach((a) => {
        const ifn = a['interface'] || a['actual-interface'];
        if (ifn && a.address && !addrByIface[ifn]) {
            addrByIface[ifn] = String(a.address).split('/')[0];
        }
    });

    const wans = detectWans(state).map((w) => ({
        ...w,
        existsOnRouter: ifaceNames.has(w.interface) || w.kind === 'pppoe',
        hasNat: hasMasquerade(state, w),
        address: w.address || addrByIface[w.interface] || null,
        speedMbps: Number(speeds[w.interface]) || null
    }));

    const usable = wans.filter((w) => w.existsOnRouter && !w.disabled);
    const up = usable.filter((w) => w.running);
    const defaults = activeDefaultRoutes(state);
    const mangleConflicts = conflictingMangle(state);
    const dns = checkDnsResilience(state);

    // กฎ firewall ที่อ้าง in-interface-list=WAN จะไม่ทำงานเลยถ้า list ไม่มีอยู่
    // และ RouterOS ก็ไม่ได้ฟ้องว่าอ้างของที่ไม่มี — เป็นความเงียบแบบเดียวกับ
    // เรื่อง interface name ที่พิมพ์ผิด
    const listNames = new Set(toArr(state.ifaceLists).map((l) => String(l.name || '')));
    const wanMembers = new Set(
        toArr(state.ifaceListMembers)
            .filter((m) => String(m.list || '') === 'WAN')
            .map((m) => String(m.interface || ''))
    );
    const wanList = {
        exists: listNames.has('WAN'),
        members: [...wanMembers],
        missingMembers: usable.map((w) => w.interface).filter((n) => !wanMembers.has(n))
    };

    const blockers = [];
    const warnings = [];

    if (usable.length < 2) {
        blockers.push({
            code: 'need-two-wans',
            message: `พบ WAN ที่ใช้ได้ ${usable.length} line — ต้องมีอย่างน้อย 2 lines ถึงจะทำ failover ได้`
        });
    }
    if (usable.length >= 2 && up.length < 2) {
        // ทำได้ แต่ยืนยันไม่ได้ว่าสายที่ยังไม่ขึ้นใช้ได้จริง
        warnings.push({
            code: 'wan-down',
            message: `มี ${usable.length} WAN แต่ตอนนี้ status running จริง ${up.length} — ` +
                     'line ที่ยัง down จะยังทำ failover ไม่ได้จนกว่าจะ up'
        });
    }
    usable.forEach((w) => {
        if (!w.hasNat) {
            warnings.push({
                code: 'no-nat',
                message: `${w.interface} ยังไม่มี srcnat masquerade — เมื่อ failover มาที่ line นี้ ` +
                         'client ใน LAN จะออก internet ไม่ได้'
            });
        }
        if (w.kind === 'dhcp' && w.running && !w.gateway) {
            warnings.push({
                code: 'dhcp-no-gateway',
                message: `${w.interface} เป็น DHCP client แต่ยังอ่าน gateway ไม่ได้`
            });
        }
    });
    if (mangleConflicts.length > 0) {
        warnings.push({
            code: 'existing-mangle',
            message: `มี mangle rule ที่ทำ mark-routing / PCC อยู่แล้ว ${mangleConflicts.length} rules — ` +
                     'ต้องตรวจก่อนว่าจะ conflict กับของใหม่หรือไม่'
        });
    }
    if (dns.atRisk && usable.length >= 2) {
        warnings.push({
            code: 'dns-not-resilient',
            message: 'เครื่องลูกข่ายยังใช้ DNS ที่ผูกกับ line ใด line หนึ่ง — เมื่อ failover ' +
                     'เส้นทางจะสลับสำเร็จแต่ลูกค้าจะยังเปิดเว็บไม่ได้ เพราะ DNS เดิม' +
                     'เข้าถึงได้เฉพาะ line ที่ตายไปแล้ว (เลือกเปิด DNS resilience ในขั้น plan ได้)'
        });
    }
    if (defaults.length > 1) {
        warnings.push({
            code: 'multiple-defaults',
            message: `มี active default route อยู่ ${defaults.length} routes — ` +
                     'ต้องตั้ง distance ให้ชัดว่า line ไหนเป็น primary line ไหนเป็น backup'
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
        activeWan: activeFailoverWan(state.routes),
        dns,
        wanList,
        filterRuleCount: toArr(state.filter).length,
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
            why: ['ต้องมี WAN uplink อย่างน้อย 2 lines'],
            confidence: 'high'
        };
    }

    // เรียงจากเร็วไปช้า — line ที่เร็วที่สุดควรเป็น primary เสมอ
    const ranked = usable.slice().sort((a, b) => (b.speedMbps || 0) - (a.speedMbps || 0));
    const known = usable.filter((w) => w.speedMbps > 0);
    const allKnown = known.length === usable.length;

    // จัดกลุ่ม line ที่ bandwidth ใกล้กันพอจะแบ่งโหลดร่วมกันได้
    // (ทำเฉพาะเมื่อรู้ความเร็วครบ ไม่งั้นเป็นการเดา)
    let pccGroup = [];
    if (allKnown) {
        const fastest = ranked[0].speedMbps;
        pccGroup = ranked.filter((w) => fastest / w.speedMbps <= PCC_MAX_SPEED_RATIO);
    }

    const pccBlockers = [];
    if (!allKnown) {
        pccBlockers.push('ยังไม่รู้ bandwidth จริงของทุก line จึงคำนวณ PCC weight ไม่ได้');
    } else if (pccGroup.length < 2) {
        const r = (ranked[0].speedMbps / ranked[1].speedMbps).toFixed(1);
        pccBlockers.push(
            `bandwidth ต่างกัน ${r} เท่า — PCC จะกระจาย connection ครึ่งหนึ่ง` +
            'ลง line ที่ช้ากว่าตลอดเวลา ผู้ใช้จะรู้สึกว่าเน็ตแย่ลงหลังเปิด load balance'
        );
    }
    if (up.length < usable.length) {
        pccBlockers.push('ยังมี line ที่ down — กระจาย connection ลง line ที่ใช้ไม่ได้จะทำให้เน็ตเสียเป็นช่วง ๆ');
    }
    if (mangleConflicts.length > 0) {
        pccBlockers.push(`มี mangle rule เดิมอยู่ ${mangleConflicts.length} rules ซึ่ง PCC ต้องเขียนทับ`);
    }

    const order = ranked.map((w) => w.interface);

    // ---- ทางเลือกที่ 1: failover ล้วน ----
    if (pccBlockers.length > 0) {
        const why = [
            `Failover ${usable.length} lines — primary: ${order[0]}, ` +
            `backup ตามลำดับ: ${order.slice(1).join(' → ')}`,
            'ไม่ใช้ mangle เลย FastTrack จึงเปิดทิ้งไว้ได้ ไม่เสีย throughput — ' +
            'สำคัญมากบน hEX / hAP ที่พึ่ง FastTrack',
            'เสถียรระยะยาวเพราะไม่แตะ path ของ traffic ที่วิ่งอยู่ ' +
            'มีแค่ routing table ที่เปลี่ยน'
        ];
        pccBlockers.forEach((b) => why.push('ไม่เลือก PCC: ' + b));
        return {
            mode: MODE.FAILOVER,
            title: `Failover ${usable.length} lines (automatic WAN backup)`,
            order,
            why,
            rejected: { mode: MODE.PCC, because: pccBlockers },
            confidence: 'high'
        };
    }

    // ---- ทางเลือกที่ 2: PCC เฉพาะกลุ่มที่ใกล้กัน + ที่เหลือเป็น backup ----
    const pccNames = pccGroup.map((w) => w.interface);
    const rest = ranked.filter((w) => !pccNames.includes(w.interface)).map((w) => w.interface);
    const why = [
        `PCC ข้าม ${pccNames.length} lines ที่ bandwidth ใกล้กัน: ${pccNames.join(' + ')}`,
        'ทุก line status running และไม่มี mangle rule เดิมที่ต้องเขียนทับ'
    ];
    if (rest.length > 0) {
        why.push(
            `${rest.join(', ')} ช้ากว่ากลุ่มหลักเกิน ${PCC_MAX_SPEED_RATIO} เท่า ` +
            'จึงควรเป็น backup อย่างเดียว ไม่ควรเอาเข้ากลุ่มแบ่งโหลด'
        );
    }
    why.push('ลง Failover ก่อนเสมอ — PCC อย่างเดียวไม่ช่วยตอน line ใด line หนึ่ง down');
    why.push(
        'ข้อแลกเปลี่ยน: PCC ต้องใช้ mangle จึงต้องปิดหรือยกเว้น FastTrack ' +
        'ซึ่งลด throughput ชัดเจนบน hEX / hAP — บน CCR ยังพอมี headroom'
    );
    why.push('และ PCC ไม่ได้ทำให้การโหลดไฟล์เดียวเร็วขึ้น ช่วยตอนมีผู้ใช้หลายคนพร้อมกัน');

    return {
        mode: MODE.PCC,
        title: `PCC ${pccNames.length} lines + failover (แนะนำลง Failover ก่อน)`,
        order,
        pccGroup: pccNames,
        backupOnly: rest,
        why,
        confidence: 'medium'
    };
}


module.exports = {
    MODE,
    TAG,
    activeFailoverWan,
    checkDnsResilience,
    PCC_MAX_SPEED_RATIO,
    detectWans,
    activeDefaultRoutes,
    conflictingMangle,
    hasMasquerade,
    analyzeState,
    recommend
};
