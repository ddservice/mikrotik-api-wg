/**
 * lib/wireguard-script.js — สร้างสคริปต์ตั้งค่า WireGuard สำหรับเราท์เตอร์สาขา
 *
 * แยกออกมาจาก server.js เพราะสคริปต์นี้คือสิ่งที่ถูกเอาไปรันบนเราท์เตอร์จริงของลูกค้า
 * ผิดหนึ่งบรรทัดคือสาขาต่อไม่ได้ และเดิมไม่มีเทสต์คุมเลยสักตัว
 *
 * บทเรียนจาก EstiaHotel (2026-09-05): เราท์เตอร์ตัวนั้นมี WireGuard interface เดิม
 * อยู่แล้วซึ่งใช้ listen-port 13231 พอสคริปต์สร้างตัวใหม่ด้วยพอร์ตเดียวกัน RouterOS
 * รับคำสั่งไปเฉย ๆ แล้ว "ปิด" interface ใหม่ทิ้ง — ไม่มี error ไม่มีคำเตือน
 * สคริปต์รันจบสวยงาม แต่ tunnel ไม่มีทางขึ้น และไล่หาสาเหตุอยู่นาน
 *
 * จึงแก้สองชั้น:
 *   1. หาพอร์ตว่างเองตอนรัน แทนที่จะ hardcode ค่าเดียว
 *   2. ตรวจซ้ำหลังสร้างว่า interface ไม่ได้ถูกปิด แล้วบอกออกมาดัง ๆ ถ้าโดนปิด
 *      — ความล้มเหลวที่เงียบคือสิ่งที่แพงที่สุดในระบบนี้
 */

'use strict';

const IFACE = 'wg-gatekeeper';
const IP_COMMENT = 'WireGuard VPN IP';
const DEFAULT_LISTEN_PORT = 13231;

/**
 * @param {object} o
 *   wireguardIp    IP ของสาขาในวง 10.10.88.0/24
 *   apiPort        พอร์ต API ที่จะล็อกให้เข้าได้เฉพาะในอุโมงค์
 *   vpsPublicKey   public key ของ VPS
 *   endpointHost   IP/โฮสต์ของ VPS
 *   endpointPort   พอร์ต WireGuard ของ VPS
 *   callbackBlock  บล็อกลงทะเบียนอัตโนมัติ (ว่างได้)
 */
function buildSetupScript(o) {
    const ip = String(o.wireguardIp || '').trim();
    const apiPort = Number(o.apiPort) || 8728;
    const host = String(o.endpointHost || '').trim();
    const endpointPort = Number(o.endpointPort) || 51820;
    const pubKey = String(o.vpsPublicKey || '').trim();
    const callbackBlock = o.callbackBlock || '';

    if (!ip) throw new Error('ต้องระบุ wireguardIp');
    if (!host) throw new Error('ต้องระบุ endpointHost ของ VPS');
    if (!pubKey) throw new Error('ต้องระบุ vpsPublicKey');

    return `# ======================================================
# MikroTik RouterOS WireGuard Setup Script (MT Management)
# Targeted IP: ${ip}
# API Port: ${apiPort}
# VPS Endpoint: ${host}:${endpointPort}
# ======================================================

# 1. Clear existing interface, peers, and IP if any — removing the interface
# does NOT cascade-delete its peers/addresses on this RouterOS version, so
# they'd otherwise accumulate as orphaned "unknown"-interface entries on every
# re-run of this script. This router only ever has the one VPS Hub Server
# peer, so it's safe to clear all WireGuard peers/addresses unconditionally.
/interface/wireguard/peers/remove [find]
/ip/address/remove [find comment="${IP_COMMENT}"]
/interface/wireguard/remove [find name=${IFACE}]

# 2. Pick a listen-port that is not already taken.
#
# RouterOS will silently DISABLE a new WireGuard interface whose listen-port
# collides with an existing one — no error, no warning, the script finishes
# normally and the tunnel simply never comes up. This happened on a live site.
# Any other WireGuard interface on this router keeps working untouched.
:local wgport ${DEFAULT_LISTEN_PORT}
:local guard 0
:while ([:len [/interface/wireguard find listen-port=$wgport]] > 0 && $guard < 50) do={
    :set wgport ($wgport + 1)
    :set guard ($guard + 1)
}
:if ($wgport != ${DEFAULT_LISTEN_PORT}) do={
    :put ("NOTE: port ${DEFAULT_LISTEN_PORT} was in use by another WireGuard interface - using " . $wgport . " instead")
}

# 3. Add WireGuard interface
/interface/wireguard/add name=${IFACE} listen-port=$wgport comment="MT Management WireGuard"

# 4. Add IP Address
/ip/address/add address=${ip}/24 interface=${IFACE} comment="${IP_COMMENT}"

# 5. Add VPS Server Peer
/interface/wireguard/peers/add interface=${IFACE} endpoint-address="${host}" endpoint-port=${endpointPort} allowed-address=10.10.88.0/24 persistent-keepalive=25s comment="VPS Hub Server" public-key="${pubKey}"

# 6. Security Hardening (Lock API Service to VPN Subnet Only & Set Custom Port)
/ip/service/set api address=10.10.88.0/24 port=${apiPort} disabled=no
/ip/service/disable api-ssl

# 7. Verify the interface actually came up enabled.
#
# Creating it is not the same as it running. If RouterOS disabled it for any
# reason, say so loudly here rather than letting the operator find out later
# from a tunnel that never connects.
:if ([/interface/wireguard get [find name=${IFACE}] disabled] = true) do={
    :put "!!!! FAILED: interface ${IFACE} was created but is DISABLED."
    :put "!!!! Check for another WireGuard interface using the same listen-port,"
    :put "!!!! then run: /interface/wireguard enable [find name=${IFACE}]"
} else={
    :put "--------------------------------------------------------"
    :put ("WireGuard Interface OK - listening on port " . $wgport)
    :put "Your Router WireGuard Public Key is:"
    :put [/interface/wireguard/get [find name=${IFACE}] public-key]
    :put "--------------------------------------------------------"
}
${callbackBlock}
`;
}

/** สคริปต์ถอนการติดตั้งฝั่งเราท์เตอร์ */
function buildUninstallScript() {
    return `# ======================================================
# MikroTik RouterOS WireGuard Clean-up / Uninstall Script
# ======================================================

# 1. Remove WireGuard Interface and associated IPs/Peers
/interface/wireguard/remove [find name=${IFACE}]
/ip/address/remove [find comment="${IP_COMMENT}"]

:put "--------------------------------------------------------"
:put "WireGuard Interface & Configuration Removed Successfully!"
:put "--------------------------------------------------------"
`;
}

module.exports = { buildSetupScript, buildUninstallScript, IFACE, IP_COMMENT, DEFAULT_LISTEN_PORT };
