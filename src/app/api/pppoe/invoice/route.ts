import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { roomName, packageName, price, invoiceDate, dueDate } = await req.json();

    const invoice = {
      invoiceNo: `INV-${Date.now().toString().slice(-6)}`,
      roomName: roomName || 'ห้อง 101',
      packageName: packageName || 'PPPoE 100/100 Mbps',
      price: Number(price) || 500,
      vat: Math.round((Number(price) || 500) * 0.07),
      totalAmount: Math.round((Number(price) || 500) * 1.07),
      invoiceDate: invoiceDate || new Date().toISOString().slice(0, 10),
      dueDate: dueDate || new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      issuerName: 'DDService Network Systems',
    };

    return NextResponse.json({ success: true, invoice });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error generating PPPoE invoice' }, { status: 500 });
  }
}
