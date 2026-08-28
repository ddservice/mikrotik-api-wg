#!/usr/bin/env node
/**
 * enable-dns-logging.js — เปิดการเก็บประวัติเข้าเว็บ (DNS) ตาม พรบ. ม.26
 *
 * ที่มา (พบ 2026-08-29): DNS log หยุดทำงานมาตั้งแต่ 2026-07-09 — ทั้ง 109,514
 * รายการในฐานข้อมูลมาจากช่วง 8-9 ก.ค. เพียง 2 วัน หลังจากนั้นไม่มีเลยสักแถว
 *
 * สาเหตุมี 2 ชั้น ต้องแก้ทั้งคู่ ไม่งั้นยังไม่เก็บ:
 *
 *   ชั้นที่ 1 — ฝั่งเราท์เตอร์: ต้องมี logging rule topics=dns ที่เปิดใช้งานอยู่
 *     A4-Residence : มี rule `topics=dns,!packet action=dnsmem` แต่ *ถูกปิดไว้*
 *     อีก 3 สาขา   : ไม่มี rule เลย เราท์เตอร์จึงไม่เคยผลิต log บรรทัด dns ออกมา
 *
 *   ชั้นที่ 2 — ฝั่งแอป: ฟิลด์ dns_logging_enabled ของสาขาต้องเป็น true
 *     ถ้าเป็น false poller จะข้ามการอ่าน /log/print ไปเลย
 *     A4-Residence และ TingTing เป็น false อยู่
 *
 * สคริปต์นี้แก้ทั้งสองชั้น:
 *   1. สร้าง logging action แยกชื่อ `dnsmem` (memory, 3000 บรรทัด) ถ้ายังไม่มี
 *      แยก buffer ออกจาก `memory` ปกติ เพื่อไม่ให้ log dns ดัน log hotspot/system หายไป
 *   2. สร้างหรือเปิด logging rule `topics=dns,!packet action=dnsmem`
 *      (`!packet` ตัดรายละเอียดระดับแพ็กเก็ตออก เหลือแค่ query — ตรงกับที่ ม.26 ต้องการ
 *       คือเก็บระดับชื่อโดเมน ไม่เก็บเนื้อหา)
 *   3. ตั้ง dns_logging_enabled = true ในฐานข้อมูล
 *
 * ใช้:
 *   node scripts/enable-dns-logging.js            # ดูว่าจะทำอะไร (ไม่แก้อะไร)
 *   node scripts/enable-dns-logging.js --apply    # แก้จริง
 *   node scripts/enable-dns-logging.js --apply --site A4-Residence
 */

const path = require('path');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const siteIdx = args.indexOf('--site');
const ONLY_SITE = siteIdx >= 0 ? args[siteIdx + 1] : null;

const ACTION_NAME = 'dnsmem';
const ACTION_LINES = '3000';
const RULE_TOPICS = 'dns,!packet';

// อ่านคีย์จาก ecosystem.config.js ถ้ายังไม่มีใน env (เหมือนสคริปต์ตัวอื่นในโฟลเดอร์นี้)
function loadEnv() {
    if (process.env.SUPABASE_URL && !String(process.env.SUPABASE_URL).includes('YOUR_')) return;
    try {
        const eco = require(path.join(__dirname, '..', 'ecosystem.config.js'));
        const env = (eco.apps && eco.apps[0] && eco.apps[0].env) || {};
        Object.keys(env).forEach((k) => {
            if (/^SUPABASE_|^R2_/.test(k) && !String(env[k]).includes('YOUR_')) process.env[k] = env[k];
        });
    } catch (_) {}
}
loadEnv();

const db = require(path.join(__dirname, '..', process.env.SUPABASE_URL ? 'db-supabase.js' : 'db.js'));
const RouterOSClient = require(path.join(__dirname, '..', 'routeros.js'));

async function fixSite(site) {
    const label = `[${site.name}]`;
    const cfg = await db.getConfig(site.id);
    if (!cfg.host || !cfg.username) {
        console.log(`${label} ข้าม — ยังไม่ได้ตั้งค่าการเชื่อมต่อ`);
        return;
    }

    const client = new RouterOSClient(cfg.host, cfg.port, cfg.username, cfg.password, { connectTimeoutMs: 10000 });
    try {
        await client.connect();
    } catch (e) {
        console.log(`${label} เชื่อมต่อไม่ได้: ${e.message}`);
        return;
    }

    try {
        // ---- 1. logging action ----
        const actions = await client.exec('/system/logging/action/print');
        const action = (actions || []).find((a) => a.name === ACTION_NAME);
        if (!action) {
            console.log(`${label} ${APPLY ? 'สร้าง' : 'จะสร้าง'} logging action "${ACTION_NAME}" (memory, ${ACTION_LINES} บรรทัด)`);
            if (APPLY) {
                await client.exec('/system/logging/action/add', {
                    name: ACTION_NAME, target: 'memory', 'memory-lines': ACTION_LINES
                });
            }
        } else {
            console.log(`${label} มี logging action "${ACTION_NAME}" อยู่แล้ว (${action['memory-lines']} บรรทัด)`);
        }

        // ---- 2. logging rule ----
        const rules = await client.exec('/system/logging/print');
        const rule = (rules || []).find((r) => String(r.topics || '').includes('dns'));

        if (!rule) {
            console.log(`${label} ${APPLY ? 'สร้าง' : 'จะสร้าง'} logging rule topics=${RULE_TOPICS} action=${ACTION_NAME}`);
            if (APPLY) {
                await client.exec('/system/logging/add', { topics: RULE_TOPICS, action: ACTION_NAME });
            }
        } else if (rule.disabled === 'true') {
            console.log(`${label} ${APPLY ? 'เปิด' : 'จะเปิด'} logging rule ที่มีอยู่ (ถูกปิดไว้) — topics=${rule.topics}`);
            if (APPLY) {
                await client.exec('/system/logging/enable', { numbers: rule['.id'] });
            }
        } else {
            console.log(`${label} logging rule topics=${rule.topics} เปิดใช้งานอยู่แล้ว`);
        }

        // ---- 3. ฟิลด์ในฐานข้อมูล ----
        if (site.dnsLoggingEnabled === false) {
            console.log(`${label} ${APPLY ? 'ตั้ง' : 'จะตั้ง'} dns_logging_enabled = true ในฐานข้อมูล`);
            if (APPLY) await db.updateSite(site.id, { dnsLoggingEnabled: true });
        } else {
            console.log(`${label} dns_logging_enabled = true อยู่แล้ว`);
        }

        // ---- ตรวจผล ----
        if (APPLY) {
            const after = await client.exec('/system/logging/print');
            const r = (after || []).find((x) => String(x.topics || '').includes('dns'));
            console.log(`${label} ผลลัพธ์: rule ${r ? (r.disabled === 'true' ? 'ยังปิดอยู่ ***' : 'เปิดแล้ว ✓') : 'ไม่พบ ***'}`);
        }
    } catch (e) {
        console.log(`${label} ล้มเหลว: ${e.message}`);
    } finally {
        try { client.close(); } catch (_) {}
    }
}

(async () => {
    console.log('');
    console.log(APPLY ? '*** โหมดแก้ไขจริง (--apply) ***' : '*** DRY RUN — ยังไม่แก้อะไร ใส่ --apply เพื่อแก้จริง ***');
    console.log('');

    const sitesData = await db.getSites();
    let sites = (sitesData && sitesData.sites) || [];
    if (ONLY_SITE) sites = sites.filter((s) => s.name === ONLY_SITE || s.id === ONLY_SITE);
    if (!sites.length) {
        console.log('ไม่พบสาขาที่ตรงกับที่ระบุ');
        process.exit(1);
    }

    for (const s of sites) {
        await fixSite(s);
        console.log('');
    }

    console.log(APPLY
        ? 'เสร็จแล้ว — poller จะเริ่มเก็บ DNS log ในรอบถัดไป (ทุก 5 นาที)'
        : 'นี่คือ dry-run — ใส่ --apply เพื่อแก้จริง');
    process.exit(0);
})().catch((e) => {
    console.error('ล้มเหลว:', e.message);
    process.exit(1);
});
