import { NextResponse } from 'next/server';
import { getVpsWireGuardStatus } from '@/lib/wireguard';

export async function GET() {
  try {
    const status = getVpsWireGuardStatus();
    return NextResponse.json(status);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error fetching WireGuard status' }, { status: 500 });
  }
}
