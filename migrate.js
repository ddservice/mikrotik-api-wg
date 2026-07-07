// ============================================================
// migrate.js - One-time migration: JSON files to Supabase
// Run once on VPS:
//   SUPABASE_URL=xxx SUPABASE_SERVICE_KEY=yyy node migrate.js
// ============================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
if (typeof WebSocket === 'undefined') { global.WebSocket = require('ws'); }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('ERROR: Set SUPABASE_URL and SUPABASE_SERVICE_KEY first');
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
    console.log('[START] Migration JSON -> Supabase\n');

    // 1. Users
    console.log('[1/5] Migrating dashboard_users...');
    const users = readJSON('users.json', []);
    if (users.length > 0) {
        const rows = users.map(u => ({
            id: u.id, username: u.username, salt: u.salt || null,
            password_hash: u.passwordHash, role: u.role,
            name: u.name || u.username, assigned_site_id: u.assignedSiteId || 'all'
        }));
        const { error } = await supabase.from('dashboard_users').upsert(rows, { onConflict: 'id' });
        if (error) console.error('  ERROR:', error.message);
        else console.log('  OK: ' + users.length + ' users migrated');
    } else {
        console.log('  SKIP: users.json not found');
    }

    // 2. Sites
    console.log('\n[2/5] Migrating sites...');
    const configData = readJSON('config.json', null);
    if (configData && configData.sites) {
        const rows = configData.sites.map(function(s) {
            return {
                id: s.id, name: s.name, host: s.host || '',
                port: s.port || 8728, username: s.username || '',
                password: s.password || '',
                connection_type: s.connectionType || 'wireguard',
                wireguard_ip: s.wireguardIp || s.host || '',
                wireguard_public_key: s.wireguardPublicKey || '',
                is_active: s.id === configData.activeSiteId
            };
        });
        const { error } = await supabase.from('sites').upsert(rows, { onConflict: 'id' });
        if (error) console.error('  ERROR:', error.message);
        else console.log('  OK: ' + rows.length + ' sites migrated (active: ' + configData.activeSiteId + ')');
    } else {
        console.log('  SKIP: config.json not found or no sites');
    }

    // 3. Settings
    console.log('\n[3/5] Migrating app_settings...');
    const settings = readJSON('settings.json', { autoCleanupExpired: false, cleanupIntervalMinutes: 60 });
    const { error: se } = await supabase.from('app_settings').upsert({ key: 'auto_cleanup', value: settings, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (se) console.error('  ERROR:', se.message);
    else console.log('  OK: settings migrated');

    // 4. Activity Logs
    console.log('\n[4/5] Migrating activity_logs...');
    const logs = readJSON('logs.json', []);
    if (logs.length > 0) {
        const BATCH = 500;
        var total = 0;
        for (var i = 0; i < logs.length; i += BATCH) {
            var batch = logs.slice(i, i + BATCH).map(function(l) {
                return { username: l.username || '', action: l.action || '', details: l.details || '', created_at: l.timestamp };
            });
            var res = await supabase.from('activity_logs').insert(batch);
            if (res.error) console.error('  ERROR batch ' + i + ':', res.error.message);
            else total += batch.length;
        }
        console.log('  OK: ' + total + ' activity logs migrated');
    } else {
        console.log('  SKIP: logs.json not found');
    }

    // 5. Hotspot Logs
    console.log('\n[5/5] Migrating hotspot_logs...');
    const hotspotLogs = readJSON('hotspot_logs.json', []);
    if (hotspotLogs.length > 0) {
        var cutoff = Date.now() - 90 * 86400000;
        var valid = hotspotLogs.filter(function(l) { return new Date(l.loginTime).getTime() >= cutoff; });
        var BATCH2 = 200;
        var total2 = 0;
        for (var j = 0; j < valid.length; j += BATCH2) {
            var batch2 = valid.slice(j, j + BATCH2).map(function(l) {
                return {
                    id: l.id, username: l.username || '',
                    ip_address: l.ipAddress || '', mac_address: l.macAddress || '',
                    login_by: l.loginBy || '', uptime: l.uptime || '',
                    bytes_in: l.bytesIn || 0, bytes_out: l.bytesOut || 0,
                    site_name: l.siteName || '', status: l.status || 'connected',
                    login_time: l.loginTime, logout_time: l.logoutTime || null
                };
            });
            var res2 = await supabase.from('hotspot_logs').upsert(batch2, { onConflict: 'id' });
            if (res2.error) console.error('  ERROR batch ' + j + ':', res2.error.message);
            else total2 += batch2.length;
        }
        console.log('  OK: ' + total2 + '/' + hotspotLogs.length + ' hotspot logs migrated (last 90 days only)');
    } else {
        console.log('  SKIP: hotspot_logs.json not found');
    }

    console.log('\n[DONE] Migration complete!');
    console.log('Next steps:');
    console.log('  1. Add SUPABASE_URL and SUPABASE_SERVICE_KEY to ecosystem.config.js');
    console.log('  2. pm2 reload all');
    console.log('  3. pm2 logs --lines 20  (should show: [DB] Using: Supabase)');
}

migrate().catch(function(e) { console.error('FAILED:', e.message); process.exit(1); });

