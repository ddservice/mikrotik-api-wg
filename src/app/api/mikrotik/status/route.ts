import { NextRequest, NextResponse } from 'next/server';
import { executeOnRouter } from '@/lib/routeros';

export async function GET(req: NextRequest) {
  try {
    const siteId = req.nextUrl.searchParams.get('siteId');

    const status = await executeOnRouter(async (client) => {
      const resource = await client.exec('/system/resource/print');
      const res = resource[0] || {};

      let identityName = 'MikroTik Router';
      try {
        const idRes = await client.exec('/system/identity/print');
        if (idRes[0] && idRes[0].name) identityName = idRes[0].name;
      } catch (e) {}

      let activeHotspotCount = 0;
      try {
        const hotspotActive = await client.exec('/ip/hotspot/active/print');
        activeHotspotCount = hotspotActive.length;
      } catch (e) {}

      let activePppoeCount = 0;
      try {
        const pppActive = await client.exec('/ppp/active/print');
        activePppoeCount = pppActive.length;
      } catch (e) {}

      const totalMem = Number(res['total-memory']) || 1;
      const freeMem = Number(res['free-memory']) || 0;
      const memoryUsage = Math.round(((totalMem - freeMem) / totalMem) * 100);

      const totalHdd = Number(res['total-hdd-space']) || 1;
      const freeHdd = Number(res['free-hdd-space']) || 0;
      const hddUsage = Math.round(((totalHdd - freeHdd) / totalHdd) * 100);

      return {
        identity: identityName,
        model: res.board_name || res.model || 'MikroTik',
        version: res.version || 'RouterOS',
        cpuLoad: Number(res['cpu-load']) || 0,
        uptime: res.uptime || '0s',
        totalMemory: totalMem,
        freeMemory: freeMem,
        memoryUsage,
        totalHdd,
        freeHdd,
        hddUsage,
        activeHotspot: activeHotspotCount,
        activePppoe: activePppoeCount,
        connected: true,
      };
    }, siteId);

    return NextResponse.json(status);
  } catch (err: any) {
    return NextResponse.json(
      {
        identity: 'MikroTik Router (Offline)',
        model: 'MikroTik',
        version: '-',
        cpuLoad: 0,
        uptime: 'Offline',
        memoryUsage: 0,
        hddUsage: 0,
        activeHotspot: 0,
        activePppoe: 0,
        connected: false,
        error: err.message || 'Cannot connect to MikroTik Router',
      },
      { status: 200 }
    );
  }
}
