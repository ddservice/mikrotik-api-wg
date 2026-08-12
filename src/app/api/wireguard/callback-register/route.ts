import { NextRequest, NextResponse } from 'next/server';
import { registerVpsPeer, wgTokens } from '@/lib/wireguard';

export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get('token');

    if (!token || !wgTokens.has(token)) {
      return NextResponse.json({ error: 'Invalid or expired registration token' }, { status: 400 });
    }

    const reg = wgTokens.get(token)!;
    if (reg.expiresAt < Date.now()) {
      wgTokens.delete(token);
      return NextResponse.json({ error: 'Registration token expired' }, { status: 400 });
    }

    const clientPublicKey = req.headers.get('x-public-key') || req.headers.get('X-Public-Key');
    if (!clientPublicKey) {
      return NextResponse.json({ error: 'Missing X-Public-Key header' }, { status: 400 });
    }

    registerVpsPeer(reg.wireguardIp, clientPublicKey.trim());
    wgTokens.delete(token);

    return NextResponse.json({
      success: true,
      message: `WireGuard peer registered successfully for IP ${reg.wireguardIp}`,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error registering WireGuard callback' }, { status: 500 });
  }
}
