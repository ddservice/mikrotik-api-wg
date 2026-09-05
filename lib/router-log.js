/**
 * lib/router-log.js — อ่าน log ของ RouterOS แล้วแปลว่ามันแปลว่าอะไร ต้องทำอะไรต่อ
 *
 * ทำไมต้องมี: log ของ MikroTik เป็นภาษาอังกฤษสั้น ๆ ที่บอกว่า "เกิดอะไรขึ้น" แต่ไม่บอก
 * ว่า "แปลว่าอะไร" และ "ควรทำอะไร" คนที่ไม่ได้ทำงานกับ RouterOS ทุกวันเห็นบรรทัดสีแดง
 * แล้วบอกไม่ได้ว่าเรื่องใหญ่หรือเรื่องปกติ ส่วนใหญ่จึงจบลงที่ไม่มีใครอ่านมันเลย
 *
 * ตั้งใจให้เป็นตารางกฎที่เขียนไว้ตรง ๆ ไม่ใช่ให้โมเดลภาษาเดา ด้วยเหตุผลเดียวกับ
 * lib/multiwan-analyze.js: ต้องได้คำตอบเดิมทุกครั้ง ต้องทำงานได้ตอนเน็ตล่ม
 * และต้องตรวจสอบได้ว่าคำแนะนำถูกจริง
 *
 * ทั้งหมดเป็นฟังก์ชันบริสุทธิ์ รับแถว log ที่อ่านมาแล้ว ไม่ต่อเน็ตเอง
 */

'use strict';

const SEVERITY = { CRITICAL: 'critical', WARNING: 'warning', INFO: 'info' };

/**
 * กฎการแปลความ — เรียงจากเจาะจงไปกว้าง ตัวแรกที่ตรงชนะ
 *
 * แต่ละข้อต้องตอบสามคำถามให้ครบ: เกิดอะไรขึ้น / แปลว่าอะไร / ทำอะไรต่อ
 * ถ้าตอบข้อสามไม่ได้ ก็ยังไม่ควรใส่เข้ามา เพราะจะกลายเป็นการเตือนที่ทำอะไรไม่ได้
 */
const RULES = [
    {
        code: 'login-failure',
        match: /login failure/i,
        severity: SEVERITY.WARNING,
        title: 'มีคนพยายามล็อกอินเข้าเราท์เตอร์ไม่สำเร็จ',
        meaning: 'อาจเป็นพนักงานพิมพ์รหัสผิด หรือมีคนไล่เดารหัสจากภายนอก',
        action: 'ถ้าเกิดถี่ ๆ จาก IP เดิมซ้ำ ๆ ให้ติดตั้งชุดกฎความปลอดภัยในหน้า Firewall ' +
                'ซึ่งจะแบน IP ที่เดารหัสผิดซ้ำอัตโนมัติ 24 ชั่วโมง',
        // เดารหัสรัว ๆ ต่างจากพิมพ์ผิดครั้งสองครั้ง — ยกระดับเมื่อถี่
        escalateAt: 10
    },
    {
        code: 'rogue-dhcp',
        match: /dhcp.*(alert|unknown dhcp server|discovered)/i,
        severity: SEVERITY.CRITICAL,
        title: 'เจอ DHCP server แปลกปลอมในวง LAN',
        meaning: 'มีอุปกรณ์อื่นแจก IP แข่งกับเราท์เตอร์ ลูกค้าบางเครื่องจะได้ IP ผิดและใช้เน็ตไม่ได้ ' +
                 'ส่วนใหญ่เกิดจากมีคนเอาเราท์เตอร์บ้านมาต่อผิดพอร์ต (เสียบขา LAN เข้าขา WAN)',
        action: 'ไล่หาอุปกรณ์จาก MAC ที่ระบุใน log แล้วถอดออก หรือปิดพอร์ตนั้นชั่วคราว'
    },
    {
        code: 'out-of-memory',
        match: /out of memory|no memory|memory low/i,
        severity: SEVERITY.CRITICAL,
        title: 'หน่วยความจำเราท์เตอร์ใกล้หมด',
        meaning: 'เราท์เตอร์อาจทำงานผิดปกติหรือรีบูตเอง',
        action: 'ดูหน้า Overview ว่า RAM เหลือเท่าไร ถ้าเหลือน้อยเรื้อรังให้ลดขนาด log buffer ' +
                'หรือปิดฟีเจอร์ที่ไม่ได้ใช้ และพิจารณาเปลี่ยนรุ่นที่แรงกว่า'
    },
    {
        code: 'link-down',
        match: /link down/i,
        severity: SEVERITY.WARNING,
        title: 'สายที่พอร์ตหลุด',
        meaning: 'พอร์ตนั้นไม่มีสัญญาณแล้ว ถ้าเป็นขา WAN แปลว่าเน็ตสายนั้นขาด ' +
                 'ถ้าเป็นขา LAN แปลว่าอุปกรณ์ปลายทางดับหรือสายหลุด',
        action: 'ตรวจสายและอุปกรณ์ปลายทาง ถ้าเป็นขา WAN และมีหลายสาย ให้ดูหน้า Multi-WAN'
    },
    {
        code: 'pppoe-auth-failed',
        match: /pppoe.*(authentication failed|auth failed)|ppp.*authentication failed/i,
        severity: SEVERITY.CRITICAL,
        title: 'PPPoE ล็อกอินไม่ผ่าน',
        meaning: 'ชื่อผู้ใช้หรือรหัสผ่านของสายเน็ตไม่ถูกต้อง หรือผู้ให้บริการระงับสายชั่วคราว',
        action: 'ตรวจ user/password ของ PPPoE client ถ้าถูกต้องแล้วให้ติดต่อผู้ให้บริการอินเทอร์เน็ต'
    },
    {
        code: 'pppoe-down',
        match: /pppoe.*(disconnected|terminated|link down)/i,
        severity: SEVERITY.WARNING,
        title: 'สาย PPPoE หลุด',
        meaning: 'สายเน็ตหลุดชั่วคราว ปกติจะต่อกลับเองภายในไม่กี่วินาที',
        action: 'ถ้าหลุดบ่อยผิดปกติให้แจ้งผู้ให้บริการ และดูค่า keepalive ในหน้า PPPoE',
        escalateAt: 20
    },
    {
        code: 'reboot',
        match: /router (was )?rebooted|system.*(started|rebooted)/i,
        severity: SEVERITY.WARNING,
        title: 'เราท์เตอร์เริ่มระบบใหม่',
        meaning: 'อาจเกิดจากไฟดับ สั่งรีบูตเอง หรือเราท์เตอร์ค้างแล้วรีเซ็ตตัวเอง',
        action: 'ถ้าไม่มีใครสั่งรีบูตและเกิดซ้ำ ให้ตรวจไฟเลี้ยงและอุณหภูมิในหน้า Overview'
    },
    {
        code: 'bridge-loop',
        match: /received packet with own address|loop detected|bridge.*loop/i,
        severity: SEVERITY.CRITICAL,
        title: 'เกิดลูปในเครือข่าย (สายวนกลับ)',
        meaning: 'มีสายเชื่อมวนกลับมาที่สวิตช์ตัวเดิม ทำให้เครือข่ายช้าลงมากหรือใช้ไม่ได้ทั้งวง',
        action: 'ไล่ถอดสายที่เพิ่งเสียบเพิ่มล่าสุดออกก่อน แล้วดูว่าอาการหาย'
    },
    {
        code: 'dns-failure',
        match: /dns.*(failed|timeout|no response)/i,
        severity: SEVERITY.WARNING,
        title: 'DNS ไม่ตอบ',
        meaning: 'ลูกค้าจะเปิดเว็บไม่ได้ทั้งที่เน็ตยังต่ออยู่ — อาการคลาสสิกของ "เน็ตมีแต่เข้าเว็บไม่ได้"',
        action: 'ตรวจ DNS server ที่ตั้งไว้ ถ้าใช้ DNS ของผู้ให้บริการอยู่ ให้ลองเปลี่ยนเป็น 1.1.1.1 / 8.8.8.8'
    },
    {
        code: 'disk-full',
        match: /disk.*(full|space)|no space left/i,
        severity: SEVERITY.CRITICAL,
        title: 'พื้นที่เก็บข้อมูลบนเราท์เตอร์เต็ม',
        meaning: 'เราท์เตอร์จะเขียน log และไฟล์สำรองไม่ได้ และอาจทำงานผิดปกติ',
        action: 'ลบไฟล์เก่าในเมนู Files บนเราท์เตอร์ โดยเฉพาะไฟล์สำรองและ log ที่ไม่ใช้แล้ว'
    }
];

/** จัดระดับความรุนแรงจากฟิลด์ topics ที่ RouterOS ส่งมา */
function severityFromTopics(topics) {
    const t = String(topics || '').toLowerCase();
    if (/critical|emergency|alert/.test(t)) return SEVERITY.CRITICAL;
    if (/error/.test(t)) return SEVERITY.CRITICAL;
    if (/warning/.test(t)) return SEVERITY.WARNING;
    return SEVERITY.INFO;
}

/**
 * แปลงหนึ่งแถว log เป็นผลวิเคราะห์
 * คืน severity ที่สูงกว่าระหว่าง "ที่กฎบอก" กับ "ที่ topics บอก" เสมอ
 */
function classify(row) {
    const message = String((row && row.message) || '');
    const topics = String((row && row.topics) || '');
    const bySeverity = severityFromTopics(topics);

    const rule = RULES.find((r) => r.match.test(message) || r.match.test(topics));
    const rank = { info: 0, warning: 1, critical: 2 };
    const severity = rule && rank[rule.severity] > rank[bySeverity] ? rule.severity : bySeverity;

    return {
        time: (row && row.time) || '',
        topics,
        message,
        severity,
        code: rule ? rule.code : null,
        title: rule ? rule.title : null,
        meaning: rule ? rule.meaning : null,
        action: rule ? rule.action : null
    };
}

/**
 * สรุปทั้งชุด: จัดกลุ่มเรื่องเดียวกันเข้าด้วยกัน แล้วเรียงตามความรุนแรง
 *
 * จัดกลุ่มเพราะ log จริงมักเป็นเรื่องเดิมซ้ำหลายร้อยบรรทัด (เช่นเดารหัสรัว ๆ)
 * การไล่อ่านทีละบรรทัดทำให้มองไม่เห็นว่าจริง ๆ มีปัญหาอยู่กี่เรื่อง
 */
function summarize(rows) {
    const items = (Array.isArray(rows) ? rows : []).map(classify);
    const groups = new Map();

    items.forEach((it) => {
        const key = it.code || ('raw:' + it.severity + ':' + it.message.slice(0, 60));
        if (!groups.has(key)) {
            groups.set(key, {
                code: it.code, severity: it.severity, title: it.title,
                meaning: it.meaning, action: it.action,
                count: 0, firstTime: it.time, lastTime: it.time,
                sample: it.message, topics: it.topics
            });
        }
        const g = groups.get(key);
        g.count++;
        g.lastTime = it.time || g.lastTime;
    });

    // เรื่องที่เกิดถี่เกินเกณฑ์ ยกระดับขึ้น — พิมพ์รหัสผิดสองครั้งกับโดนไล่เดารหัส
    // เป็นคนละเรื่องกัน แม้ข้อความใน log จะเหมือนกันทุกตัวอักษร
    groups.forEach((g) => {
        const rule = RULES.find((r) => r.code === g.code);
        if (rule && rule.escalateAt && g.count >= rule.escalateAt && g.severity === SEVERITY.WARNING) {
            g.severity = SEVERITY.CRITICAL;
            g.escalated = true;
            g.meaning = g.meaning + ` (เกิด ${g.count} ครั้ง ซึ่งถี่ผิดปกติ)`;
        }
    });

    const rank = { critical: 0, warning: 1, info: 2 };
    const list = [...groups.values()].sort((a, b) =>
        (rank[a.severity] - rank[b.severity]) || (b.count - a.count));

    return {
        groups: list,
        total: items.length,
        counts: {
            critical: list.filter((g) => g.severity === SEVERITY.CRITICAL).length,
            warning: list.filter((g) => g.severity === SEVERITY.WARNING).length,
            info: list.filter((g) => g.severity === SEVERITY.INFO).length
        },
        // มีเรื่องที่ต้องทำอะไรต่อไหม — ใช้ตัดสินว่าจะแจ้งเตือนหรือไม่
        needsAttention: list.some((g) => g.severity === SEVERITY.CRITICAL)
    };
}

module.exports = { SEVERITY, RULES, classify, summarize, severityFromTopics };
