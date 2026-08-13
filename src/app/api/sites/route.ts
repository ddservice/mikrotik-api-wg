import { NextRequest, NextResponse } from 'next/server';
import { getSitesData, isSupabase, saveSitesData, supabase } from '@/lib/db';

export async function GET() {
  try {
    const data = await getSitesData();
    return NextResponse.json(data);
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error fetching sites' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { name, host, port, username, password, wireguardIp } = body;

    const data = await getSitesData();
    const id = 'site_' + Date.now();
    const newSite = {
      id,
      name: name || 'ไซต์งานใหม่',
      host: host || wireguardIp || '',
      port: Number(port) || 8728,
      username: username || 'admin',
      password: password || '',
      wireguardIp: wireguardIp || '',
      is_active: false,
    };

    if (isSupabase && supabase) {
      const res = await supabase.from('sites').insert([newSite]);
      if (res.error) throw new Error(res.error.message);
    } else {
      data.sites = data.sites || [];
      data.sites.push(newSite);
      saveSitesData(data);
    }

    return NextResponse.json({ success: true, site: newSite });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error adding site' }, { status: 500 });
  }
}
