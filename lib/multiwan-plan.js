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

/**
 * ชื่อของ scheduler ตัวถอนอัตโนมัติ
 *
 * ต้องแยกให้ชัดจาก scheduler ตัวอื่นที่ระบบนี้สร้าง (เช่นตัว sync DHCP gateway)
 * เพราะตอน commit เราลบเฉพาะ "ตัวถอน" ไม่ใช่ทุกอย่างที่ติดแท็กเดียวกัน
 */
const ROLLBACK_NAME = TAG + '-rollback';

/** ปลายทางสำหรับเช็คว่าสายนั้นยังออกเน็ตได้จริง — ต้องคนละตัวต่อสาย */
const DEFAULT_CHECK_HOSTS = ['8.8.8.8', '1.1.1.1', '9.9.9.9', '208.67.222.222'];

/**
 * distance ที่ดันของเดิมขึ้นไป
 *
 * ต้องสูงกว่าเส้นทางใหม่ทั้งหมด เพื่อให้ของใหม่ถูกใช้ก่อน แต่ยังอยู่เป็นตาข่ายรับ
 * ถ้าเส้นทางใหม่ถูก check-gateway ตัดออกทั้งหมด
 */
const FALLBACK_DISTANCE_BASE = 10;

/** ขึ้นบรรทัดใหม่ในสคริปต์ RouterOS */
const NL = String.fromCharCode(10);

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
        throw new Error('ยังทำ failover ไม่ได้: ' + (why || 'สภาพเราท์เตอร์ไม่พร้อม'));
    }

    const usable = analysis.usable.slice();
    // เรียงตามที่คนเลือก ถ้าไม่ได้เลือกก็ใช้ลำดับที่เจอ (PPPoE มาก่อน DHCP)
    const order = Array.isArray(opts.order) && opts.order.length ? opts.order : null;
    const wans = order
        ? order.map((n) => usable.find((w) => w.interface === n)).filter(Boolean)
        : usable;

    if (wans.length < 2) {
        throw new Error('ต้องเลือก WAN อย่างน้อย 2 lines และชื่อ interface ต้องตรงกับบนเราท์เตอร์');
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
            title: `${w.interface}: default-route-distance → ${next}`,
            why: 'ลด priority ของ dynamic default route เดิม แต่ไม่ลบทิ้ง — ถ้า recursive route ' +
                 'ใหม่ใช้ไม่ได้ RouterOS จะ fall back มา route นี้เอง internet ไม่ดับ',
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
            title: `Host-check route: ${host}/32 → ${w.interface}`,
            why: `บังคับให้ probe ไป ${host} ออกทาง ${w.interface} เท่านั้น (scope 10 / target-scope 10) ` +
                 'ถ้าไม่ pin แบบนี้ probe จะวิ่งออก line ไหนก็ได้ แล้ว line ที่ down จริงจะดูเหมือนยัง up',
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
                ? `Default route via ${w.interface} — PRIMARY (distance ${distance})`
                : `Default route via ${w.interface} — BACKUP (distance ${distance})`,
            why: i === 0
                ? `recursive route ผ่าน ${host} + check-gateway=ping — RouterOS จะ deactivate ` +
                  'route นี้เองเมื่อ probe ไม่ตอบ (detect ~20-30 วินาที)'
                : 'RouterOS จะใช้ route นี้อัตโนมัติเมื่อ route ที่ distance ต่ำกว่าถูก deactivate',
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
            title: `srcnat masquerade out-interface=${w.interface}`,
            why: 'line นี้ยังไม่มี masquerade ถ้า failover มาแล้วไม่มี NAT client จะออก internet ไม่ได้ ' +
                 'ซึ่งจะดูเหมือน failover ไม่ทำงาน ทั้งที่ routing ถูกแล้ว',
            risk: 'low',
            apply: { cmd: '/ip/firewall/nat/add', args },
            undo: { type: 'remove-added', cmd: '/ip/firewall/nat/remove' }
        });
    });

    // ---- ขั้นที่ 5: กัน DHCP gateway เปลี่ยนแล้ว host-check route ตายเงียบ ----
    //
    // host-check route ของ line แบบ DHCP ถูก pin ไว้กับ gateway IP ที่อ่านได้ตอนติดตั้ง
    // ถ้า lease ต่ออายุแล้วได้ gateway ใหม่ route นั้นจะ inactive และ backup line
    // จะใช้ไม่ได้ทันที โดยไม่มีอะไรฟ้อง — ซึ่งจะไปรู้ตอน primary down พอดี
    // คือตอนที่แย่ที่สุด
    //
    // ให้ scheduler อ่าน gateway ปัจจุบันจาก dhcp-client มา sync ทุก 1 นาที
    wans.filter((w) => w.kind === 'dhcp').forEach((w) => {
        const host = checkHosts[w.interface];
        const script = [
            `:local gw [/ip dhcp-client get [find interface="${w.interface}"] gateway]`,
            ':if ([:len $gw] > 0) do={',
            `  :local r [/ip route find comment="${TAG} check ${w.interface}"]`,
            '  :if ([:len $r] > 0) do={',
            '    :if ([/ip route get $r gateway] != $gw) do={',
            '      /ip route set $r gateway=$gw',
            `      :log info "${TAG}: ${w.interface} gateway changed -> $gw"`,
            '    }',
            '  }',
            '}'
        ].join(NL);
        steps.push({
            id: `dhcp-sync-${w.interface}`,
            title: `Auto-sync host-check gateway เมื่อ DHCP lease เปลี่ยน (${w.interface})`,
            why: `host-check route ของ ${host} ถูก pin ไว้กับ gateway ปัจจุบัน ถ้า lease ` +
                 'ต่ออายุแล้วได้ gateway ใหม่ route จะ inactive และ backup line จะตายเงียบ ' +
                 '— scheduler นี้ตรวจทุก 1 นาทีและแก้ให้เอง',
            risk: 'low',
            apply: {
                cmd: '/system/scheduler/add',
                args: {
                    name: `${TAG}-dhcpsync-${w.interface}`,
                    interval: '1m',
                    'on-event': script,
                    comment: `${TAG} sync ${w.interface}`
                }
            },
            undo: { type: 'remove-added', cmd: '/system/scheduler/remove' }
        });
    });

    // ---- ขั้นที่ 6: ล้าง connection tracking ตอนสลับ line ----
    //
    // ตอน failover source IP ที่ออก internet เปลี่ยน connection เดิมทั้งหมดจึงใช้ไม่ได้
    // แต่ยังค้างอยู่ใน conntrack จนหมดอายุ (TCP established ตั้งไว้เป็นชั่วโมง)
    // ผู้ใช้จะเจอ "เน็ตค้าง" นานหลายนาทีทั้งที่ routing สลับสำเร็จไปแล้ว
    //
    // netwatch ยิงเร็วกว่า check-gateway มาก จึงใช้เป็นตัวจับจังหวะสลับได้
    const primary = wans[0];
    const primaryHost = checkHosts[primary.interface];
    steps.push({
        id: 'netwatch-flush',
        title: `Netwatch ${primaryHost} — flush connection tracking เมื่อ primary down`,
        why: 'ตอน failover source IP เปลี่ยน connection เดิมใช้ไม่ได้แล้วแต่ยังค้างใน conntrack ' +
             'จน timeout (TCP established = 1 ชม.) ผู้ใช้จะเจอเน็ตค้างหลายนาทีทั้งที่ routing ' +
             'สลับสำเร็จแล้ว — ล้างทิ้งให้ client เปิด connection ใหม่ได้ทันที',
        risk: 'medium',
        apply: {
            cmd: '/tool/netwatch/add',
            args: {
                host: primaryHost,
                interval: '10s',
                timeout: '3s',
                // ยืนยันกับ routing table ก่อนล้าง — netwatch มองว่า down ตั้งแต่ probe ตก
                // ครั้งเดียว ถ้าล้างทันทีตามนั้น แพ็กเก็ตหายครั้งเดียวจะทำให้ลูกค้าทั้งสาขา
                // หลุดการเชื่อมต่อพร้อมกัน โดยที่ไม่มีอะไรเสียจริง
                //
                // เงื่อนไขที่ถูกคือ RouterOS ตัด route ของ primary ออกแล้ว
                // ซึ่งแปลว่า check-gateway ยืนยันแล้วว่าสายตายจริง
                'down-script': [
                    `:local r [/ip route find comment~"${TAG} default ${primary.interface}"]`,
                    ':if ([:len $r] > 0) do={',
                    '  :if ([/ip route get $r active] = false) do={',
                    '    /ip firewall connection remove [find]',
                    `    :log warning "${TAG}: ${primary.interface} down - conntrack flushed"`,
                    '  }',
                    '}'
                ].join(NL),
                'up-script': `:log info "${TAG}: primary ${primary.interface} UP"`,
                comment: `${TAG} netwatch ${primary.interface}`
            }
        },
        undo: { type: 'remove-added', cmd: '/tool/netwatch/remove' }
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
    // ห่อทุกคำสั่งด้วย do/on-error เพราะสคริปต์ RouterOS หยุดทันทีที่คำสั่งใดพัง
    //
    // ถ้าไม่ห่อ แล้วคำสั่งกลางทางพัง (เช่นสิทธิ์ไม่พอ) สคริปต์จะไปไม่ถึงบรรทัดสุดท้าย
    // ที่ลบ scheduler ตัวเอง ผลคือ scheduler ค้างบนเราท์เตอร์และยิงซ้ำทุก N วินาที
    // ตลอดไป — ถอนคืนไม่ครบ แถมทิ้งขยะไว้ให้คนมาเจอทีหลัง
    const guard = (cmd) => `:do { ${cmd} } on-error={}`;

    const lines = [
        guard(`/ip route remove [find comment~"${TAG}"]`),
        guard(`/ip firewall nat remove [find comment~"${TAG}"]`),
        guard(`/tool netwatch remove [find comment~"${TAG}"]`)
    ];
    plan.wans.forEach((w) => {
        if (!w.id) return;
        const d = w.defaultRouteDistance == null ? 1 : w.defaultRouteDistance;
        const p = w.kind === 'pppoe' ? '/interface pppoe-client' : '/ip dhcp-client';
        lines.push(guard(`${p} set [find where .id="${w.id}"] default-route-distance=${d}`));
    });
    lines.push(guard(`:log warning "${TAG}: auto-rollback executed"`));
    // ลบตัวเองเป็นคำสั่งสุดท้าย — ตอนนี้มั่นใจได้ว่ามาถึงบรรทัดนี้เสมอ
    lines.push(guard(`/system scheduler remove [find comment~"${TAG}"]`));
    return lines.join('\n');
}

/** คำสั่งฝากตัวถอนไว้ล่วงหน้า */
function buildArmCommand(plan, seconds) {
    return {
        cmd: '/system/scheduler/add',
        args: {
            name: ROLLBACK_NAME,
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

/**
 * ข้อความสรุปหลังลงสำเร็จ ส่งเข้า Telegram ทีมแอดมิน
 *
 * ต้องมี IP ของทุก line เพราะ IP ฝั่ง WAN คือสิ่งแรกที่ต้องใช้เวลาโทรแจ้ง ISP
 * หรือเวลาต้องเปิด port forward และเป็นสิ่งที่หาจากระยะไกลยากที่สุดถ้าไม่จดไว้
 */
function buildSuccessAlert(o) {
    const { siteName, plan, mode, checks } = o;
    const L = [];
    L.push('✅ Multi-WAN ติดตั้งสำเร็จ');
    L.push(`สาขา: ${siteName || '-'}`);
    L.push(`รูปแบบ: ${mode || 'Failover'}`);
    L.push('');
    plan.wans.forEach((w, i) => {
        const role = i === 0 ? 'PRIMARY' : `BACKUP ${i}`;
        const chk = (checks || []).find((c) => c.interface === w.interface);
        L.push(`${i + 1}. ${w.interface}  [${role}]`);
        L.push(`   type      : ${w.kind.toUpperCase()}`);
        L.push(`   WAN IP    : ${w.address || 'ยังอ่านไม่ได้'}`);
        L.push(`   gateway   : ${w.gateway || '-'}`);
        L.push(`   distance  : ${i + 1}`);
        L.push(`   check host: ${plan.checkHosts[w.interface]}` +
               (chk ? `  (ping ${chk.replies}/${chk.sent})` : ''));
        L.push('');
    });
    L.push(`เมื่อ ${plan.wans[0].interface} down ระบบจะสลับไป ` +
           `${plan.wans[1] ? plan.wans[1].interface : '-'} อัตโนมัติภายใน ~20-30 วินาที`);
    L.push('และจะล้าง connection tracking ให้ client ต่อใหม่ได้ทันที');
    return L.join(NL);
}

module.exports = {
    TAG,
    ROLLBACK_NAME,
    buildSuccessAlert,
    parseOriginalDistances,
    DEFAULT_CHECK_HOSTS,
    FALLBACK_DISTANCE_BASE,
    buildFailoverPlan,
    buildRollbackScript,
    buildArmCommand
};
