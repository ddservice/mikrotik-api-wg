import { NextRequest, NextResponse } from 'next/server';
import { getVpsPublicKey, registerVpsPeer } from '@/lib/wireguard';
import { getSitesData } from '@/lib/db';
import crypto from 'crypto';

// Token store for auto-callback registration
export const wgTokens = new Map<string, { wireguardIp: string; siteId?: string; expiresAt: number }>();

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { wireguardIp, vpsPublicKey, clientPublicKey, port, siteId } = body;
    const targetIp = wireguardIp || '10.10.88.2';
    const targetPort = Number(port) || 8728;
    let autoRegistered = false;

    // Check IP collisions across site entries
    try {
      const sitesData = await getSitesData();
      const dup = (sitesData.sites || []).find(
        (s) => s.id !== siteId && (s.wireguardIp === targetIp || s.host === targetIp)
      );
      if (dup) {
        return NextResponse.json(
          { error: `WireGuard IP ${targetIp} ถูกใช้อยู่แล้วโดยไซต์ "${dup.name}" กรุณาเลือก IP อื่น` },
          { status: 400 }
        );
      }
    } catch (e) {}

    if (clientPublicKey && clientPublicKey.trim()) {
      try {
        registerVpsPeer(targetIp, clientPublicKey);
        autoRegistered = true;
      } catch (e) {}
    }

    const pubKey = vpsPublicKey || getVpsPublicKey();
    if (!pubKey) {
      return NextResponse.json(
        { error: 'ไม่สามารถอ่าน VPS WireGuard Public Key ได้ — ตรวจสอบว่า wg0 ทำงานอยู่และ sudoers ตั้งค่าถูกต้อง' },
        { status: 500 }
      );
    }

    const vpsAppUrl = process.env.PUBLIC_APP_URL || '';
    let callbackBlock = '';

    if (vpsAppUrl) {
      const token = crypto.randomBytes(24).toString('hex');
      wgTokens.set(token, { wireguardIp: targetIp, siteId: siteId || undefined, expiresAt: Date.now() + 30 * 60 * 1000 });
      callbackBlock = `
# 7. Auto-register this router's key with the dashboard (no manual copy-paste needed)
/tool/fetch url="${vpsAppUrl}/api/wireguard/callback-register?token=${token}" http-method=post http-header-field=("X-Public-Key: " . [/interface/wireguard/get [find name=wg-gatekeeper] public-key]) output=none
:put "Public Key auto-registered to dashboard!"`;
    }

    const script = `# ======================================================
# MikroTik RouterOS WireGuard Setup Script (MT Management)
# Targeted IP: ${targetIp}
# API Port: ${targetPort}
# VPS Endpoint: 157.85.108.84:51820
# ======================================================

# 1. Clear existing interface, peers, and IP if any
/interface/wireguard/peers/remove [find]
/ip/address/remove [find comment="WireGuard VPN IP"]
/interface/wireguard/remove [find name=wg-gatekeeper]

# 2. Add WireGuard interface
/interface/wireguard/add name=wg-gatekeeper listen-port=13231 comment="MT Management WireGuard"

# 3. Add IP Address
/ip/address/add address=${targetIp}/24 interface=wg-gatekeeper comment="WireGuard VPN IP"

# 4. Add VPS Peer
/interface/wireguard/peers/add interface=wg-gatekeeper public-key="${pubKey}" endpoint-address=157.85.108.84 endpoint-port=51820 allowed-address=10.10.88.0/24 persistent-keepalive=25s comment="VPS Hub Server"

# 5. Enable API service for WireGuard IP
/ip/service/set api disabled=no port=${targetPort} address=10.10.88.0/24

# 6. Verify WireGuard status
:put "--------------------------------------------------------"
:put "WireGuard Interface Setup Complete!"
:put "Targeted IP: ${targetIp}"
:put "--------------------------------------------------------"
${callbackBlock}
`;

    return NextResponse.json({
      success: true,
      script,
      wireguardIp: targetIp,
      autoRegistered,
      vpsPublicKey: pubKey,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error generating WireGuard script' }, { status: 500 });
  }
}
