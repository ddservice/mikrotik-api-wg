import { NextRequest, NextResponse } from 'next/server';
import { getSitesData, isSupabase, supabase } from '@/lib/db';
import fs from 'fs';
import path from 'path';

const CONFIG_FILE = path.join(process.cwd(), 'db', 'config.json');

export async function POST(req: NextRequest) {
  try {
    const { siteId } = await req.json();
    if (!siteId) {
      return NextResponse.json({ error: 'Site ID is required' }, { status: 400 });
    }

    if (isSupabase && supabase) {
      await supabase.from('sites').update({ is_active: false }).neq('id', 'none');
      const res = await supabase.from('sites').update({ is_active: true }).eq('id', siteId);
      if (res.error) throw new Error(res.error.message);
    } else {
      const data = await getSitesData();
      data.activeSiteId = siteId;
      data.sites.forEach(s => {
        s.is_active = s.id === siteId;
      });
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 4), 'utf8');
    }

    return NextResponse.json({ success: true, activeSiteId: siteId });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error setting active site' }, { status: 500 });
  }
}
