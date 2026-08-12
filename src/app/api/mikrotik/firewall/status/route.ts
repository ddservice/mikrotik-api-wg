import { NextRequest, NextResponse } from 'next/server';
import { executeOnRouter } from '@/lib/routeros';
import { FIREWALL_SERVICES } from '@/lib/firewall-services';

export async function GET(req: NextRequest) {
  try {
    const siteId = req.nextUrl.searchParams.get('siteId');
    const result: Record<string, any> = {};

    await executeOnRouter(async (client) => {
      let filterRules: any[] = [];
      try {
        filterRules = await client.exec('/ip/firewall/filter/print');
      } catch (e) {}

      for (const [key, svc] of Object.entries(FIREWALL_SERVICES)) {
        const rule = filterRules.find((r) => r.comment === svc.comment);
        let timeStart = '';
        let timeEnd = '';
        if (rule && rule.time) {
          const parts = rule.time.split('-');
          if (parts.length === 2) {
            timeStart = parts[0].substring(0, 5);
            timeEnd = parts[1].substring(0, 5);
          }
        }
        const days = rule && rule.days ? rule.days.split(',') : [];

        result[key] = {
          blocked: rule ? rule.disabled === 'false' || rule.disabled === false : false,
          scheduleEnabled: !!(rule && (rule.time || rule.days)),
          timeStart,
          timeEnd,
          days,
        };
      }
    }, siteId);

    return NextResponse.json(result);
  } catch (err: any) {
    // Return graceful default if router is offline or unreachable
    const fallback: Record<string, any> = {};
    for (const [key] of Object.entries(FIREWALL_SERVICES)) {
      fallback[key] = { blocked: false, scheduleEnabled: false, timeStart: '', timeEnd: '', days: [] };
    }
    return NextResponse.json(fallback);
  }
}
