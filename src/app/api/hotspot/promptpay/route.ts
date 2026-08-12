import { NextRequest, NextResponse } from 'next/server';
import generatePayload from 'promptpay-qr';
import QRCode from 'qrcode';

export async function POST(req: NextRequest) {
  try {
    const { mobileOrTaxId, amount } = await req.json();
    const target = mobileOrTaxId || '0812345678';
    const parsedAmount = Number(amount) || 0;

    const payload = generatePayload(target, { amount: parsedAmount });
    const qrCodeUrl = await QRCode.toDataURL(payload);

    return NextResponse.json({
      success: true,
      target,
      amount: parsedAmount,
      payload,
      qrCodeUrl,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error generating PromptPay QR Code' }, { status: 500 });
  }
}
