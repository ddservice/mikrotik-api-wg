import { NextRequest, NextResponse } from 'next/server';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';

export async function POST(req: NextRequest) {
  try {
    const { username } = await req.json();
    if (!username) {
      return NextResponse.json({ error: 'Username is required' }, { status: 400 });
    }

    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(username, 'MT Management', secret);
    const qrCodeUrl = await QRCode.toDataURL(otpauth);

    return NextResponse.json({
      secret,
      qrCodeUrl,
      otpauth,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error generating 2FA secret' }, { status: 500 });
  }
}
