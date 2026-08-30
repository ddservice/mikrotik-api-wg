#!/usr/bin/env node
/**
 * normalize-site-names.js — เปลี่ยนชื่อสาขาเดิมใน log ให้เป็นชื่อปัจจุบัน
 *
 * ที่มา: สาขาถูกเปลี่ยนชื่อไปแล้ว แต่ log ที่บันทึกไว้ก่อนหน้ายังเก็บชื่อเก่า
 * พอกรองด้วยชื่อปัจจุบัน แถวเหล่านั้นจะไม่โผล่มา ผลคือถ้าต้องส่งบันทึกของสาขาหนึ่ง
 * ให้เจ้าหน้าที่ ไฟล์ที่ได้จะขาดรายการไปโดยไม่มีอะไรบอกว่าขาด — ซึ่งสำหรับหลักฐาน
 * ตาม ม.26 อันตรายกว่าไม่มีไฟล์เลย
 *
 * การจับคู่ชื่อเก่ากับชื่อใหม่ยืนยันจากข้อมูลเอง ไม่ใช่การเดา — username และ IP
 * ทับกันระหว่างชื่อเก่ากับชื่อใหม่ (เช่น a028/a014 อยู่ทั้ง "สาขาหลัก (Main Site)"
 * และ "Auioun@WiFi", tt201/tt205 อยู่ทั้ง "TingTing@WiFi" และ "TingTing")
 *
 * ข้อสำคัญ: สคริปต์นี้ "เปลี่ยนชื่อ" เท่านั้น ไม่ลบแถวใด ๆ ทั้งสิ้น
 * จำนวนแถวรวมของทุกตารางต้องเท่าเดิมเป๊ะทั้งก่อนและหลัง และมีการตรวจให้ด้วย
 *
 * ไฟล์ปิดผนึก (SHA-256) ที่สร้างไปแล้วยังเก็บชื่อ ณ ตอนนั้นไว้ตามเดิม
 * ตรวจแล้วกับไฟล์ของ 2026-08-25 ซึ่งมี CCR2004=12 อยู่ข้างใน
 * หลักฐานต้นฉบับจึงไม่ถูกแตะต้อง การแก้นี้กระทบเฉพาะตารางที่ใช้ค้นหา/ส่งออก
 *
 * ใช้:
 *   node scripts/normalize-site-names.js            # ดูว่าจะเปลี่ยนอะไร (ไม่แก้)
 *   node scripts/normalize-site-names.js --apply    # แก้จริง
 */

const path = require('path');

const APPLY = process.argv.includes('--apply');

function loadEnv() {
    if (process.env.SUPABASE_URL && !String(process.env.SUPABASE_URL).includes('YOUR_')) return;
    try {
        const eco = require(path.join(__dirname, '..', 'ecosystem.config.js'));
        const env = (eco.apps && eco.apps[0] && eco.apps[0].env) || {};
        Object.keys(env).forEach((k) => {
            if (/^SUPABASE_/.test(k) && !String(env[k]).includes('YOUR_')) process.env[k] = env[k];
        });
    } catch (_) {}
}
loadEnv();

if (!process.env.SUPABASE_URL) {
    console.error('สคริปต์นี้ใช้กับ Supabase เท่านั้น (ไม่พบ SUPABASE_URL)');
    process.exit(1);
}

const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false }
});

// ชื่อเก่า -> ชื่อปัจจุบัน
const RENAMES = {
    'CCR2004': 'A4-Residence',
    'สาขาหลัก (Main Site)': 'Auioun@WiFi',
    'TingTing@WiFi': 'TingTing'
};

const TABLES = ['dns_query_logs', 'hotspot_logs', 'pppoe_usage_logs', 'archived_hotspot_users'];

async function countAll(table) {
    const res = await supabase.from(table).select('id', { count: 'exact', head: true });
    if (res.error) throw new Error(`${table}: ${res.error.message}`);
    return res.count || 0;
}

async function countName(table, name) {
    const res = await supabase.from(table).select('id', { count: 'exact', head: true }).eq('site_name', name);
    if (res.error) throw new Error(`${table}: ${res.error.message}`);
    return res.count || 0;
}

(async () => {
    console.log('');
    console.log(APPLY ? '*** โหมดแก้ไขจริง (--apply) ***' : '*** DRY RUN — ยังไม่แก้อะไร ใส่ --apply เพื่อแก้จริง ***');
    console.log('');
    console.log('การจับคู่:');
    Object.entries(RENAMES).forEach(([from, to]) => console.log(`   "${from}"  ->  "${to}"`));
    console.log('');

    // นับจำนวนแถวรวมไว้ก่อน เพื่อพิสูจน์ทีหลังว่าไม่มีแถวไหนหายไป
    const before = {};
    for (const t of TABLES) before[t] = await countAll(t);

    let totalChanged = 0;

    for (const table of TABLES) {
        const lines = [];
        for (const [from, to] of Object.entries(RENAMES)) {
            const n = await countName(table, from);
            if (!n) continue;

            lines.push(`   "${from}" -> "${to}": ${n.toLocaleString()} แถว`);
            totalChanged += n;

            if (APPLY) {
                const res = await supabase.from(table).update({ site_name: to }).eq('site_name', from);
                if (res.error) throw new Error(`${table} (${from}): ${res.error.message}`);
                const left = await countName(table, from);
                if (left > 0) throw new Error(`${table}: ยังเหลือ "${from}" อีก ${left} แถวหลังอัปเดต`);
            }
        }
        if (lines.length) {
            console.log(table + ':');
            lines.forEach((l) => console.log(l));
        } else {
            console.log(table + ': ไม่มีชื่อเก่า');
        }
    }

    console.log('');
    console.log(`รวม ${totalChanged.toLocaleString()} แถวที่${APPLY ? 'ถูก' : 'จะ'}เปลี่ยนชื่อ`);

    // ตรวจว่าไม่มีแถวหายไป — นี่คือสิ่งที่ต้องพิสูจน์ ไม่ใช่แค่เชื่อว่า update ไม่ลบ
    console.log('');
    console.log('ตรวจจำนวนแถว (ต้องเท่าเดิมทุกตาราง — สคริปต์นี้เปลี่ยนชื่อ ไม่ลบ):');
    let mismatch = false;
    for (const t of TABLES) {
        const after = await countAll(t);
        const ok = after === before[t];
        if (!ok) mismatch = true;
        console.log(`   ${t.padEnd(24)} ${before[t].toLocaleString()} -> ${after.toLocaleString()}  ${ok ? 'เท่าเดิม' : '*** ไม่เท่า! ***'}`);
    }
    if (mismatch) {
        console.error('');
        console.error('จำนวนแถวเปลี่ยนไป — ต้องตรวจสอบทันที');
        process.exit(1);
    }

    if (APPLY) {
        console.log('');
        console.log('เสร็จแล้ว — การกรองด้วยชื่อสาขาปัจจุบันจะเห็นข้อมูลเก่าเหล่านี้ด้วยแล้ว');
        console.log('หมายเหตุ: ไฟล์ปิดผนึกที่สร้างไปแล้วยังเก็บชื่อเดิมไว้ตามเดิม ไม่ถูกแตะต้อง');
    } else {
        console.log('');
        console.log('นี่คือ dry-run — ใส่ --apply เพื่อแก้จริง');
    }
    process.exit(0);
})().catch((e) => {
    console.error('ล้มเหลว:', e.message);
    process.exit(1);
});
