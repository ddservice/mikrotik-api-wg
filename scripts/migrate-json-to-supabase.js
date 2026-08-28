#!/usr/bin/env node
/**
 * migrate-json-to-supabase.js
 *
 * ย้ายข้อมูลที่สะสมอยู่ใน db/*.json (ช่วงที่แอปตกไปใช้ Local JSON เพราะ
 * ecosystem.config.js มี SUPABASE_URL เป็น placeholder) กลับเข้า Supabase
 *
 * ปลอดภัยโดยออกแบบ:
 *   - ค่าเริ่มต้นเป็น dry-run ต้องใส่ --apply ถึงจะเขียนจริง
 *   - ใช้ upsert onConflict: 'id' -> รันซ้ำได้ ไม่เกิดข้อมูลซ้ำ
 *   - ไม่ลบอะไรทั้งสิ้น ไม่แตะ dashboard_users ไม่แตะ app_settings
 *   - สาขาที่มีอยู่แล้วใน Supabase จะไม่ถูกแก้ เพิ่มเฉพาะที่ยังไม่มีจริง ๆ
 *
 * ใช้:
 *   node scripts/migrate-json-to-supabase.js                 # ดูว่าจะทำอะไรบ้าง
 *   node scripts/migrate-json-to-supabase.js --apply         # เขียนจริง
 *   node scripts/migrate-json-to-supabase.js --apply --no-sites   # ข้ามการเพิ่มสาขา
 *
 * อ่านคีย์ Supabase จาก env ก่อน ถ้าไม่มีจะลองอ่านจากไฟล์ที่ระบุด้วย --eco
 * (ค่าเริ่มต้น /home/ddservice/backups/ecosystem.config.js.REAL.bak)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_DIR = path.join(ROOT, 'db');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SKIP_SITES = args.includes('--no-sites');
const ecoArgIdx = args.indexOf('--eco');
const ECO_PATH = ecoArgIdx >= 0 ? args[ecoArgIdx + 1] : '/home/ddservice/backups/ecosystem.config.js.REAL.bak';

const CHUNK = 500;

function readJson(file) {
    try {
        const raw = fs.readFileSync(path.join(DB_DIR, file), 'utf8');
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
}

function isPlaceholder(url) {
    return !url || String(url).includes('YOUR_PROJECT_ID') || String(url).includes('YOUR_');
}

function resolveCredentials() {
    let url = process.env.SUPABASE_URL;
    let key = process.env.SUPABASE_SERVICE_KEY;
    if (!isPlaceholder(url) && key) return { url, key, from: 'env' };

    try {
        const eco = require(ECO_PATH);
        const env = (eco.apps && eco.apps[0] && eco.apps[0].env) || {};
        if (!isPlaceholder(env.SUPABASE_URL) && env.SUPABASE_SERVICE_KEY) {
            return { url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_KEY, from: ECO_PATH };
        }
    } catch (_) {}

    throw new Error(
        'หาคีย์ Supabase ที่ใช้ได้ไม่เจอ — ตั้ง SUPABASE_URL / SUPABASE_SERVICE_KEY ' +
        'หรือชี้ --eco ไปที่ไฟล์ ecosystem ที่มีคีย์จริง'
    );
}

function chunked(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

async function upsertAll(sb, table, rows, label) {
    if (!rows.length) {
        console.log(`   ${label}: ไม่มีข้อมูลต้องย้าย`);
        return { inserted: 0, failed: 0 };
    }
    if (!APPLY) {
        console.log(`   ${label}: จะ upsert ${rows.length} รายการ (dry-run)`);
        return { inserted: 0, failed: 0 };
    }
    let ok = 0;
    let failed = 0;
    const batches = chunked(rows, CHUNK);
    for (let i = 0; i < batches.length; i++) {
        const res = await sb.from(table).upsert(batches[i], { onConflict: 'id' });
        if (res.error) {
            failed += batches[i].length;
            console.log(`   ${label}: batch ${i + 1}/${batches.length} ล้มเหลว — ${res.error.message}`);
        } else {
            ok += batches[i].length;
            process.stdout.write(`\r   ${label}: ${ok}/${rows.length}`);
        }
    }
    process.stdout.write('\n');
    return { inserted: ok, failed };
}

(async () => {
    const creds = resolveCredentials();
    const { createClient } = require('@supabase/supabase-js');
    const sb = createClient(creds.url, creds.key, { auth: { persistSession: false } });

    console.log('');
    console.log(APPLY ? '*** โหมดเขียนจริง (--apply) ***' : '*** DRY RUN — ยังไม่เขียนอะไร ใส่ --apply เพื่อเขียนจริง ***');
    console.log('อ่านคีย์จาก:', creds.from);
    console.log('Supabase   :', String(creds.url).slice(0, 34) + '...');
    console.log('');

    // ---------- 1. จับคู่สาขา ----------
    const cfg = readJson('config.json');
    const jsonSites = (cfg && cfg.sites) || [];
    const sbRes = await sb.from('sites').select('id,name,host,port,username,wireguard_ip');
    if (sbRes.error) throw new Error('อ่านตาราง sites ไม่ได้: ' + sbRes.error.message);
    const sbSites = sbRes.data || [];

    // จับคู่ด้วย id ก่อน แล้วค่อย wireguard_ip แล้วค่อย host
    // (ชื่อสาขาเชื่อไม่ได้ — JSON เรียก "SuksawatWiFi" ส่วน Supabase เรียก "Suksawad-CMU")
    const matchSite = (js) => {
        const byId = sbSites.find(s => s.id === js.id);
        if (byId) return { site: byId, how: 'id' };
        if (js.wireguardIp) {
            const byWg = sbSites.find(s => s.wireguard_ip && s.wireguard_ip === js.wireguardIp);
            if (byWg) return { site: byWg, how: 'wireguard_ip' };
        }
        if (js.host) {
            const byHost = sbSites.find(s => s.host && s.host === js.host);
            if (byHost) return { site: byHost, how: 'host' };
        }
        return null;
    };

    console.log('=== การจับคู่สาขา ===');
    const nameMap = new Map(); // ชื่อใน JSON -> ชื่อมาตรฐานใน Supabase
    const sitesToAdd = [];
    for (const js of jsonSites) {
        const m = matchSite(js);
        if (m) {
            console.log(`   "${js.name}" -> "${m.site.name}" (จับคู่ด้วย ${m.how})`);
            if (js.name && m.site.name && js.name !== m.site.name) nameMap.set(js.name, m.site.name);
        } else {
            console.log(`   "${js.name}" -> ยังไม่มีใน Supabase (จะเพิ่มใหม่)`);
            sitesToAdd.push(js);
        }
    }

    if (sitesToAdd.length && !SKIP_SITES) {
        const rows = sitesToAdd.map(js => ({
            id: js.id || ('site_' + Date.now() + Math.random().toString(36).slice(2, 6)),
            name: js.name || 'Imported Site',
            host: js.host || js.wireguardIp || '',
            port: parseInt(js.port) || 8728,
            username: js.username || 'admin',
            password: js.password || '',
            connection_type: js.connectionType || 'wireguard',
            wireguard_ip: js.wireguardIp || null,
            wireguard_public_key: js.wireguardPublicKey || '',
            dns_logging_enabled: js.dnsLoggingEnabled !== false,
            is_active: false // ไม่แย่งสถานะ active ของสาขาเดิม
        }));
        console.log('');
        console.log('=== เพิ่มสาขาที่ขาด ===');
        rows.forEach(r => console.log(`   + ${r.name} (host=${r.host}, wg=${r.wireguard_ip || '-'}, password=${r.password ? 'มี' : 'ไม่มี'})`));
        await upsertAll(sb, 'sites', rows, 'sites');
    } else if (sitesToAdd.length && SKIP_SITES) {
        console.log('   (ข้ามการเพิ่มสาขาเพราะใส่ --no-sites)');
    }

    const canonical = (n) => nameMap.get(n) || n;

    // ---------- 2. hotspot_logs ----------
    console.log('');
    console.log('=== ย้าย log ===');
    const hs = (readJson('hotspot_logs.json') || []).filter(x => x && x.id);
    const hsRows = hs.map(e => ({
        id: String(e.id),
        username: e.username || '',
        ip_address: e.ipAddress || '',
        mac_address: e.macAddress || '',
        login_by: e.loginBy || '',
        uptime: e.uptime || '',
        bytes_in: e.bytesIn || 0,
        bytes_out: e.bytesOut || 0,
        site_name: canonical(e.siteName || ''),
        status: e.status || 'connected',
        login_time: e.loginTime || new Date().toISOString(),
        logout_time: e.logoutTime || null
    }));
    const rHs = await upsertAll(sb, 'hotspot_logs', hsRows, 'hotspot_logs');

    // ---------- 3. pppoe_usage_logs ----------
    const pp = (readJson('pppoe_usage_logs.json') || []).filter(x => x && x.id);
    const ppRows = pp.map(e => ({
        id: String(e.id),
        username: e.username || '',
        ip_address: e.ipAddress || '',
        bytes_in: e.bytesIn || 0,
        bytes_out: e.bytesOut || 0,
        site_name: canonical(e.siteName || ''),
        status: e.status || 'connected',
        login_time: e.loginTime || new Date().toISOString(),
        logout_time: e.logoutTime || null
    }));
    const rPp = await upsertAll(sb, 'pppoe_usage_logs', ppRows, 'pppoe_usage_logs');

    // ---------- 4. archived_hotspot_users ----------
    const ar = (readJson('archived_hotspot_users.json') || []).filter(x => x && x.id);
    const arRows = ar.map(e => ({
        id: String(e.id),
        username: e.username || e.name || '',
        password: e.password || '',
        profile: e.profile || 'default',
        limit_uptime: e.limitUptime || '',
        limit_bytes_total: parseInt(e.limitBytesTotal) || 0,
        comment: e.comment || '',
        site_name: canonical(e.siteName || ''),
        expired_at: e.expiredAt || new Date().toISOString(),
        deleted_at: e.deletedAt || new Date().toISOString(),
        deleted_by: e.deletedBy || 'System',
        reason: e.reason || 'manual_delete'
    }));
    const rAr = await upsertAll(sb, 'archived_hotspot_users', arRows, 'archived_hotspot_users');

    // ---------- 5. dns_query_logs ----------
    const dns = (readJson('dns_query_logs.json') || []).filter(x => x && x.id);
    if (dns.length) {
        const dnsRows = dns.map(e => ({
            id: String(e.id),
            username: e.username || '',
            ip_address: e.ipAddress || '',
            mac_address: e.macAddress || '',
            domain: e.domain || '',
            site_name: canonical(e.siteName || ''),
            queried_at: e.queriedAt || e.timestamp || new Date().toISOString()
        }));
        await upsertAll(sb, 'dns_query_logs', dnsRows, 'dns_query_logs');
    } else {
        console.log('   dns_query_logs: ไม่มีข้อมูลใน JSON (โหมด JSON ไม่ได้บันทึก DNS log ไว้)');
    }

    // ---------- 6. activity_logs ----------
    // ไม่มี id ใน JSON จึงกันซ้ำด้วยการเทียบ (username, action, details, created_at)
    // กับที่มีอยู่แล้วในช่วงเวลาเดียวกัน
    const acts = (readJson('logs.json') || []).filter(x => x && x.timestamp);
    if (acts.length) {
        const times = acts.map(a => a.timestamp).sort();
        const existing = await sb.from('activity_logs')
            .select('username,action,details,created_at')
            .gte('created_at', times[0])
            .lte('created_at', times[times.length - 1]);
        const seen = new Set(((existing && existing.data) || []).map(r =>
            [r.username, r.action, r.details, new Date(r.created_at).toISOString()].join('|')
        ));
        const actRows = acts
            .filter(a => !seen.has([a.username, a.action, a.details, new Date(a.timestamp).toISOString()].join('|')))
            .map(a => ({
                username: a.username || '',
                action: a.action || '',
                details: a.details || '',
                created_at: a.timestamp
            }));
        console.log(`   activity_logs: ใน JSON ${acts.length} รายการ, ซ้ำกับที่มีอยู่ ${acts.length - actRows.length}, ต้องย้าย ${actRows.length}`);
        if (actRows.length && APPLY) {
            for (const batch of chunked(actRows, CHUNK)) {
                const res = await sb.from('activity_logs').insert(batch);
                if (res.error) console.log('   activity_logs ล้มเหลว:', res.error.message);
            }
            console.log(`   activity_logs: ย้ายแล้ว ${actRows.length} รายการ`);
        }
    } else {
        console.log('   activity_logs: ไม่มีข้อมูลใน JSON');
    }

    // ---------- สรุป ----------
    console.log('');
    console.log('=== ยอดหลังย้าย ===');
    for (const t of ['sites', 'hotspot_logs', 'dns_query_logs', 'pppoe_usage_logs', 'activity_logs', 'archived_hotspot_users']) {
        const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true });
        console.log('   ' + t.padEnd(24), error ? 'ERR ' + error.message.slice(0, 40) : count);
    }

    console.log('');
    if (!APPLY) {
        console.log('นี่คือ dry-run — ยังไม่มีอะไรถูกเขียน ใส่ --apply เพื่อทำจริง');
    } else {
        console.log('ย้ายข้อมูลเสร็จแล้ว:',
            `hotspot ${rHs.inserted}, pppoe ${rPp.inserted}, archive ${rAr.inserted}`,
            (rHs.failed + rPp.failed + rAr.failed) ? `(ล้มเหลว ${rHs.failed + rPp.failed + rAr.failed})` : '');
        console.log('ขั้นถัดไป: ใส่คีย์ Supabase จริงลง ecosystem.config.js แล้ว pm2 reload');
    }
    process.exit(0);
})().catch(e => {
    console.error('ล้มเหลว:', e.message);
    process.exit(1);
});
