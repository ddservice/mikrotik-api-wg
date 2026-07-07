// ============================================================
// migrate.js — One-time migration: JSON files → Supabase
// รันครั้งเดียวบน VPS:
//   SUPABASE_URL=xxx SUPABASE_SERVICE_KEY=yyy node migrate.js
// ============================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('ERROR: ตั้งค่า SUPABASE_URL และ SUPABASE_SERVICE_KEY ก่อน');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const DB_DIR = path.join(__dirname, 'db');

function readJSON(file, fallback) {
    try {
        const p = path.join(DB_DIR, file);
        if (!fs.existsSync(p)) return fallback;
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) { return fallback; }
}

async function migrate() {
    console.log('🚀 เริ่ม Migration JSON → Supabase\n');

    // ── 1. Users ─────────────────────────────────────────────
    console.log('📦 [1/5] Migrating dashboard_users...');
    const users = readJSON('users.json', []);
    if (users.length > 0) {
        const rows = users.map(u => ({
            id: u.id, username: u.username, salt: u.salt || null,
            password_hash: u.passwordHash, role: u.role,
            name: u.name || u.username, assigned_site_id: u.assignedSiteId || 'all'
        }));
        const { error } = await supabase.from('dashboard_users').upsert(rows, { onConflict: 'id' });
        if (error) console.error('  ❌ Error:', error.message);
        else console.log(  ✅  users migrated);
    } else {
        console.log('  ⚠️  ไม่พบไฟล์ users.json (จะใช้ admin default)');
    }

    // ── 2. Sites ──────────────────────────────────────────────
    console.log('\n📦 [2/5] Migrating sites...');
    const configData = readJSON('config.json', null);
    if (configData && configData.sites) {
        const rows = configData.sites.map((s, i) => ({
            id: s.id, name: s.name, host: s.host || '',
            port: s.port || 8728, username: s.username || '',
            password: s.password || '',
            connection_type: s.connectionType || 'wireguard',
            wireguard_ip: s.wireguardIp || s.host || '',
            wireguard_public_key: s.wireguardPublicKey || '',
            is_active: s.id === configData.activeSiteId
        }));
        const { error } = await supabase.from('sites').upsert(rows, { onConflict: 'id' });
        if (error) console.error('  ❌ Error:', error.message);
        else console.log(  ✅  sites migrated (active: ));
    } else {
        console.log('  ⚠️  ไม่พบ config.json หรือไม่มี sites array');
    }

    // ── 3. Settings ───────────────────────────────────────────
    console.log('\n📦 [3/5] Migrating app_settings...');
    const settings = readJSON('settings.json', { autoCleanupExpired: false, cleanupIntervalMinutes: 60 });
    const { error: se } = await supabase.from('app_settings').upsert({ key: 'auto_cleanup', value: settings, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (se) console.error('  ❌ Error:', se.message);
    else console.log('  ✅ settings migrated');

    // ── 4. Activity Logs ──────────────────────────────────────
    console.log('\n📦 [4/5] Migrating activity_logs...');
    const logs = readJSON('logs.json', []);
    if (logs.length > 0) {
        const BATCH = 500;
        let total = 0;
        for (let i = 0; i < logs.length; i += BATCH) {
            const batch = logs.slice(i, i + BATCH).map(l => ({
                username: l.username || '', action: l.action || '',
                details: l.details || '', created_at: l.timestamp
            }));
            const { error } = await supabase.from('activity_logs').insert(batch);
            if (error) { console.error(  ❌ Batch -:, error.message); }
            else total += batch.length;
        }
        console.log(  ✅  activity logs migrated);
    } else {
        console.log('  ⚠️  ไม่พบ logs.json (เริ่มใหม่ได้เลย)');
    }

    // ── 5. Hotspot Logs ───────────────────────────────────────
    console.log('\n📦 [5/5] Migrating hotspot_logs...');
    const hotspotLogs = readJSON('hotspot_logs.json', []);
    if (hotspotLogs.length > 0) {
        const cutoff = Date.now() - 90 * 86400000;
        const valid = hotspotLogs.filter(l => new Date(l.loginTime).getTime() >= cutoff);
        const BATCH = 200;
        let total = 0;
        for (let i = 0; i < valid.length; i += BATCH) {
            const batch = valid.slice(i, i + BATCH).map(l => ({
                id: l.id, username: l.username || '',
                ip_address: l.ipAddress || '', mac_address: l.macAddress || '',
                login_by: l.loginBy || '', uptime: l.uptime || '',
                bytes_in: l.bytesIn || 0, bytes_out: l.bytesOut || 0,
                site_name: l.siteName || '', status: l.status || 'connected',
                login_time: l.loginTime, logout_time: l.logoutTime || null
            }));
            const { error } = await supabase.from('hotspot_logs').upsert(batch, { onConflict: 'id' });
            if (error) { console.error(  ❌ Batch -:, error.message); }
            else total += batch.length;
        }
        console.log(  ✅ / hotspot logs migrated (เฉพาะ 90 วันล่าสุด));
    } else {
        console.log('  ⚠️  ไม่พบ hotspot_logs.json (เริ่มใหม่ได้เลย)');
    }

    console.log('\n✅ Migration เสร็จสมบูรณ์!');
    console.log('📌 ขั้นตอนต่อไป:');
    console.log('   1. ตั้งค่า SUPABASE_URL, SUPABASE_SERVICE_KEY ใน ecosystem.config.js');
    console.log('   2. แก้ server.js: require(\'./db-supabase\') แทน require(\'./db\')');
    console.log('   3. npm install @supabase/supabase-js');
    console.log('   4. pm2 reload all');
}

migrate().catch(e => { console.error('❌ Migration failed:', e.message); process.exit(1); });
