import { NextRequest, NextResponse } from 'next/server';
import { executeOnRouter } from '@/lib/routeros';

export async function GET(req: NextRequest) {
  try {
    const siteId = req.nextUrl.searchParams.get('siteId');
    const rules = await executeOnRouter(async (client) => {
      const list = await client.exec('/ip/firewall/address-list/print');
      return list
        .filter((item) => item.comment && item.comment.includes('Custom Domain Block'))
        .map((item) => ({
          id: item['.id'],
          address: item.address,
          comment: item.comment,
          disabled: item.disabled === 'true',
        }));
    }, siteId);

    return NextResponse.json(rules);
  } catch (err: any) {
    return NextResponse.json([]);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { domain, siteId } = await req.json();
    if (!domain) {
      return NextResponse.json({ error: 'Domain is required' }, { status: 400 });
    }

    const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, '');

    await executeOnRouter(async (client) => {
      // Add domain to custom address list
      await client.exec('/ip/firewall/address-list/add', {
        list: 'custom_blocked_domains',
        address: cleanDomain,
        comment: 'Custom Domain Block (Dashboard)',
      });

      // Ensure drop rule exists in filter
      const filterRules = await client.exec('/ip/firewall/filter/print');
      const rule = filterRules.find((r) => r.comment === 'Custom Domain Block Rule (Dashboard)');
      if (!rule) {
        await client.exec('/ip/firewall/filter/add', {
          chain: 'forward',
          action: 'drop',
          'dst-address-list': 'custom_blocked_domains',
          comment: 'Custom Domain Block Rule (Dashboard)',
        });
      }
    }, siteId);

    return NextResponse.json({ success: true, domain: cleanDomain });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error adding custom domain block' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id, siteId } = await req.json();
    await executeOnRouter(async (client) => {
      await client.exec('/ip/firewall/address-list/remove', { '.id': id });
    }, siteId);

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Error deleting custom domain block' }, { status: 500 });
  }
}
