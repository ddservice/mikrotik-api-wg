import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/db';
import { RouterOSClient } from '@/lib/routeros';

export async function POST(req: NextRequest) {
  try {
    const siteConfig = await getConfig();
    if (!siteConfig || !siteConfig.host || !siteConfig.username) {
      return NextResponse.json({ error: 'ไม่พบการตั้งค่าเชื่อมต่อเราท์เตอร์' }, { status: 400 });
    }

    const client = new RouterOSClient(siteConfig.host, siteConfig.port, siteConfig.username, siteConfig.password);
    await client.connect();

    const timestamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const backupName = `backup_${siteConfig.id}_${timestamp}`;

    // Execute backup save on router
    await client.exec('/system/backup/save', { name: backupName });
    client.close();

    return NextResponse.json({
      success: true,
      message: `สร้างไฟล์สำรองข้อมูล RouterOS (${backupName}.backup) สำเร็จเรียบร้อยแล้ว`,
      backupName: `${backupName}.backup`,
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'เกิดข้อผิดพลาดในการสำรองข้อมูล' }, { status: 500 });
  }
}
