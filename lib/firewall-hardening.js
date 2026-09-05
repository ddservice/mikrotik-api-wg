/**
 * lib/firewall-hardening.js — ชุดกฎความปลอดภัยพื้นฐานของ RouterOS v7
 *
 * แยกออกมาเพราะเดิมมีสองปัญหาที่ทำให้ "ติดตั้งสำเร็จ" แต่ไม่ได้ป้องกันอะไรเลย
 * ซึ่งสำหรับฟีเจอร์ความปลอดภัยแย่กว่าไม่มี เพราะคนจะเลิกมองหาปัญหาตรงนั้น
 *
 * ปัญหาที่ 1 — ลำดับกฎ
 *   ของเดิมใช้ /ip/firewall/filter/add เฉย ๆ ซึ่ง **ต่อท้ายสุดของ chain**
 *   RouterOS ไล่กฎจากบนลงล่างและหยุดที่กฎแรกที่ accept/drop
 *   เราท์เตอร์ที่ตั้งค่าแล้วเกือบทุกตัวปิดท้าย chain input ด้วยกฎ drop
 *   กฎที่ต่อท้ายหลังจากนั้นจึงไม่มีวันถูกประมวลผล — ติดตั้งไปก็เท่านั้น
 *
 * ปัญหาที่ 2 — อ้าง interface-list ที่ไม่มีอยู่
 *   กฎกัน DNS amplification ใช้ in-interface-list=WAN แต่ไม่เคยสร้าง list นั้น
 *   RouterOS รับกฎที่อ้าง list ที่ไม่มีไปเฉย ๆ แล้วกฎนั้นก็ไม่ match อะไรเลย
 *   ผลคือเราท์เตอร์ยังเป็น open DNS resolver ให้คนเอาไปยิง DDoS ใส่คนอื่นได้
 *   ขณะที่หน้าจอบอกว่าป้องกันแล้ว (บทเรียนเดียวกับที่ Multi-WAN เจอเมื่อ 2026-08-31)
 */

'use strict';

const BRUTE_PORTS = '22,8291,80,443,8728';

/**
 * กฎเรียงจากบนลงล่างตามลำดับที่ต้องอยู่บนเราท์เตอร์จริง
 *
 * ลำดับนี้สำคัญมาก: IP ใหม่จะไปโดนกฎสุดท้าย (ใส่ stage1) พอพยายามอีกครั้งจะโดน
 * กฎก่อนหน้า (stage1 -> stage2) ไล่ขึ้นไปเรื่อย ๆ จนถูกแบน ถ้าสลับลำดับกัน
 * ทุก IP จะค้างอยู่ที่ stage1 ตลอดกาลและไม่มีใครถูกแบนเลย
 */
const RULES = [
    {
        key: 'drop-invalid',
        args: { chain: 'input', action: 'drop', 'connection-state': 'invalid',
                comment: 'Drop Invalid Packets (Input)' }
    },
    {
        key: 'drop-blacklisted',
        args: { chain: 'input', action: 'drop', 'src-address-list': 'brute_force_blacklist',
                comment: 'Drop Brute-Force Blacklisted IPs' }
    },
    {
        key: 'stage3-to-blacklist',
        args: { chain: 'input', action: 'add-src-to-address-list',
                'address-list': 'brute_force_blacklist', 'address-list-timeout': '1d',
                protocol: 'tcp', 'dst-port': BRUTE_PORTS, 'src-address-list': 'bf_stage3',
                comment: 'Brute-Force Stage 3 -> Blacklist 24h' }
    },
    {
        key: 'stage2-to-stage3',
        args: { chain: 'input', action: 'add-src-to-address-list',
                'address-list': 'bf_stage3', 'address-list-timeout': '1m',
                protocol: 'tcp', 'dst-port': BRUTE_PORTS, 'src-address-list': 'bf_stage2',
                comment: 'Brute-Force Stage 2 -> Stage 3' }
    },
    {
        key: 'stage1-to-stage2',
        args: { chain: 'input', action: 'add-src-to-address-list',
                'address-list': 'bf_stage2', 'address-list-timeout': '1m',
                protocol: 'tcp', 'dst-port': BRUTE_PORTS, 'src-address-list': 'bf_stage1',
                comment: 'Brute-Force Stage 1 -> Stage 2' }
    },
    {
        key: 'stage1',
        args: { chain: 'input', action: 'add-src-to-address-list',
                'address-list': 'bf_stage1', 'address-list-timeout': '1m',
                protocol: 'tcp', 'dst-port': BRUTE_PORTS,
                comment: 'Brute-Force Stage 1' }
    }
];

/** กฎกัน open DNS resolver — ต้องมี interface-list WAN ก่อนถึงจะมีผลจริง */
function dnsRules() {
    return ['udp', 'tcp'].map((proto) => ({
        key: 'block-dns-' + proto,
        args: { chain: 'input', action: 'drop', protocol: proto, 'dst-port': '53',
                'in-interface-list': 'WAN',
                comment: 'Block Open DNS Resolver Attacks from WAN (' + proto + ')' }
    }));
}

const MARKER = 'Drop Brute-Force Blacklisted IPs';

/** ติดตั้งไปแล้วหรือยัง — ดูจากคอมเมนต์ที่กฎของเราติดไว้ */
function alreadyInstalled(existingFilters) {
    return (existingFilters || []).some((r) =>
        String(r.comment || '').includes('Drop Brute-Force'));
}

/**
 * วางแผนคำสั่งที่จะส่งไปเราท์เตอร์
 *
 * @param {object} o
 *   existingFilters  กฎ filter ที่มีอยู่ (ใช้ตัดสินว่าใส่ place-before ได้ไหม)
 *   wanInterfaces    ชื่อ interface ขา WAN ที่ตรวจเจอ — ถ้าไม่มีจะข้ามกฎ DNS
 *   existingLists    interface list ที่มีอยู่แล้ว
 *   existingMembers  สมาชิกของ list ที่มีอยู่แล้ว
 */
function planApply(o = {}) {
    const existing = o.existingFilters || [];
    const wans = (o.wanInterfaces || []).filter(Boolean);
    const lists = (o.existingLists || []).map((l) => String(l.name || ''));
    const members = (o.existingMembers || [])
        .filter((m) => String(m.list || '') === 'WAN')
        .map((m) => String(m.interface || ''));

    const steps = [];
    const notes = [];

    // ---- interface-list WAN ต้องมีก่อน ไม่งั้นกฎ DNS ไม่ match อะไรเลย ----
    if (wans.length) {
        if (!lists.includes('WAN')) {
            steps.push({ cmd: '/interface/list/add', args: { name: 'WAN', comment: 'MT Management' } });
        }
        wans.forEach((iface) => {
            if (!members.includes(iface)) {
                steps.push({ cmd: '/interface/list/member/add', args: { list: 'WAN', interface: iface } });
            }
        });
    } else {
        notes.push('ไม่พบขา WAN บนเราท์เตอร์ จึงข้ามกฎกัน open DNS resolver — ' +
                   'กฎที่อ้าง interface-list ที่ไม่มีอยู่จะไม่ทำงานและไม่มีอะไรเตือน');
    }

    // ---- กฎ filter ----
    //
    // ใส่ไว้ "บนสุด" ของ chain เพราะกฎที่ต่อท้ายหลังกฎ drop เดิมจะไม่มีวันถูกเรียก
    // แทรกทีละตัวที่ตำแหน่ง 0 จะได้ลำดับกลับหัว จึงต้องไล่จากตัวล่างสุดขึ้นไป
    //
    // place-before=0 ใช้ไม่ได้ถ้า chain ยังว่าง (RouterOS ตอบ "no such item")
    // เราท์เตอร์ที่ยังไม่มีกฎอะไรเลยจึงต่อท้ายตามปกติได้ ผลลัพธ์เหมือนกัน
    const rules = RULES.concat(wans.length ? dnsRules() : []);
    const canPlaceFirst = existing.length > 0;
    const ordered = canPlaceFirst ? rules.slice().reverse() : rules;

    ordered.forEach((r) => {
        const args = Object.assign({}, r.args);
        if (canPlaceFirst) args['place-before'] = '0';
        steps.push({ cmd: '/ip/firewall/filter/add', args, key: r.key });
    });

    return { steps, notes, ruleCount: rules.length, placedFirst: canPlaceFirst };
}

/**
 * สคริปต์สำหรับวางใน WinBox เอง
 * สร้าง interface-list WAN ให้ด้วย ไม่งั้นกฎ DNS เป็นกฎที่ไม่ทำอะไร
 */
function buildScript(wanInterfaces) {
    const wans = (wanInterfaces || []).filter(Boolean);
    const wanBlock = wans.length
        ? `# 1. Make sure the WAN interface list exists and lists the real WAN ports.
# A rule naming a list that does not exist is accepted by RouterOS and then
# matches nothing at all — the DNS rules below would be silently dead.
/interface/list/add name=WAN comment="MT Management"
${wans.map((i) => `/interface/list/member/add list=WAN interface=${i}`).join('\n')}`
        : `# 1. WAN interface list — EDIT THIS before running.
# The DNS rules below only work for interfaces that are in this list.
# Replace ether1 with your actual internet-facing interface(s).
/interface/list/add name=WAN comment="MT Management"
/interface/list/member/add list=WAN interface=ether1`;

    const filterLines = RULES.concat(dnsRules()).map((r) => {
        const parts = Object.entries(r.args)
            .map(([k, v]) => `${k}=${/[ "]/.test(String(v)) ? JSON.stringify(v) : v}`);
        return 'add ' + parts.join(' ');
    }).join('\n');

    return `# ======================================================
# MikroTik RouterOS v7+ Hardened Firewall Security Preset
# ======================================================

${wanBlock}

# 2. Address lists for RFC1918 private subnets
/ip/firewall/address-list
add address=10.0.0.0/8 list=private_subnets comment="RFC1918 Private Subnets"
add address=172.16.0.0/12 list=private_subnets comment="RFC1918 Private Subnets"
add address=192.168.0.0/16 list=private_subnets comment="RFC1918 Private Subnets"

# 3. Filter rules — order matters and these must sit ABOVE any existing
# "drop everything else" rule, otherwise they are never reached.
# Paste this block, then in WinBox drag them to the top of the input chain
# if your router already had firewall rules.
/ip/firewall/filter
${filterLines}

# 4. Forward chain basics
add chain=forward action=accept connection-state=established,related comment="Accept Established & Related (Forward)"
add chain=forward action=drop connection-state=invalid comment="Drop Invalid Packets (Forward)"

:put "--------------------------------------------------------"
:put "RouterOS v7 Hardened Security Preset applied."
:put "Check that the brute-force rules sit ABOVE any drop rule in chain=input."
:put "--------------------------------------------------------"
`;
}

module.exports = { RULES, dnsRules, planApply, buildScript, alreadyInstalled, MARKER, BRUTE_PORTS };
