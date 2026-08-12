import { NextRequest, NextResponse } from 'next/server';
import { executeOnRouter } from '@/lib/routeros';

export async function GET(req: NextRequest) {
  try {
    const siteId = req.nextUrl.searchParams.get('siteId');

    const interfaces = await executeOnRouter(async (client) => {
      const list = await client.exec('/interface/print');
      return list.map((item) => ({
        id: item['.id'],
        name: item.name,
        type: item.type,
        running: item.running === 'true' || item.running === true,
        disabled: item.disabled === 'true' || item.disabled === true,
        rxByte: Number(item['rx-byte']) || 0,
        txByte: Number(item['tx-byte']) || 0,
        comment: item.comment || '',
      }));
    }, siteId);

    return NextResponse.json(interfaces);
  } catch (err: any) {
    return NextResponse.json([]);
  }
}
