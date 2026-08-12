import { NextRequest, NextResponse } from 'next/server';
import { authenticator } from 'otplib';

export async function POST(req: NextRequest) {
  try {
    const { token, secret } = await req.json();
    if (!token || !secret) {
      return NextResponse.json({ error: 'Token and Secret are required' }, { status: 400 });
    }

    const isValid = authenticator.verify({ token, secret });
    if (!isValid) {
      return NextResponse.json({ error: 'รหัส 2FA (OTP) ไม่ถูกต้อง' }, { status: 400 });
    }

    return NextResponse.json({ success: true, message: 'ยืนยันรหัส 2FA สำเร็จ' });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error verifying 2FA token' }, { status: 500 });
  }
}
