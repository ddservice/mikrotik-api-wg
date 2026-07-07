// ============================================================
// db-supabase.js — Supabase database layer
// แทน db.js เดิม ใช้ PostgreSQL ผ่าน @supabase/supabase-js
// API เหมือนเดิมทุก function — drop-in replacement
// ============================================================

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ==========================================
// Supabase Client Init
// ==========================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('[db-supabase] SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
});

// ==========================================
// Password Hashing
// ==========================================
const LEGACY_SALT = 'mikrotik_gatekeeper_salt_secure_2026';

function generateSalt() { return crypto.randomBytes(16).toString('hex'); }
function hashPasswordPBKDF2(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}
function hashPasswordLegacy(password) {
    return crypto.createHash('sha256').update(password + LEGACY_SALT).digest('hex');
}

// ==========================================
// USERS
// ==========================================
async function getUsers() {
    const { data, error } = await supabase
        .from('dashboard_users')
        .select('id,username,salt,password_hash,role,name,assigned_site_id,created_at')
        .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return data.map(u => ({
        id: u.id, username: u.username, salt: u.salt,
        passwordHash: u.password_hash, role: u.role,
        name: u.name, assignedSiteId: u.assigned_site_id || 'all'
    }));
}

async function addUser(username, password, role, name, assignedSiteId = 'all') {
    const { data: ex } = await supabase.from('dashboard_users').select('id').ilike('username', username).maybeSingle();
    if (ex) throw new Error('Username already exists');
    const id = Date.now().toString();
    const salt = generateSalt();
    const { data, error } = await supabase.from('dashboard_users').insert({
        id, username: username.toLowerCase(), salt,
        password_hash: hashPasswordPBKDF2(password, salt),
        role, name, assigned_site_id: assignedSiteId || 'all'
    }).select('id,username,role,name,assigned_site_id').single();
    if (error) throw new Error(error.message);
    return { id: data.id, username: data.username, role: data.role, name: data.name, assignedSiteId: data.assigned_site_id };
}

async function updateUser(id, updateData) {
    const { data: user, error: fe } = await supabase.from('dashboard_users').select('*').eq('id', id).single();
    if (fe || !user) throw new Error('User not found');
    const updates = {};
    if (updateData.username) {
        const { data: dup } = await supabase.from('dashboard_users').select('id').ilike('username', updateData.username).neq('id', id).maybeSingle();
        if (dup) throw new Error('Username already exists');
        updates.username = updateData.username.toLowerCase();
    }
    if (updateData.password) { const s = generateSalt(); updates.salt = s; updates.password_hash = hashPasswordPBKDF2(updateData.password, s); }
    if (updateData.role) updates.role = updateData.role;
    if (updateData.name) updates.name = updateData.name;
    if (updateData.assignedSiteId !== undefined) updates.assigned_site_id = updateData.assignedSiteId;
    const { data, error } = await supabase.from('dashboard_users').update(updates).eq('id', id).select('id,username,role,name,assigned_site_id').single();
    if (error) throw new Error(error.message);
    return { id: data.id, username: data.username, role: data.role, name: data.name, assignedSiteId: data.assigned_site_id || 'all' };
}

async function deleteUser(id) {
    const { data: u } = await supabase.from('dashboard_users').select('username,role').eq('id', id).single();
    if (!u) throw new Error('User not found');
    if (u.username === 'admin') throw new Error('Cannot delete default system admin account');
    const { data: admins } = await supabase.from('dashboard_users').select('id').eq('role', 'admin');
    if (admins && admins.length === 1 && admins[0].id === id) throw new Error('Cannot delete the last administrator account');
    const { error } = await supabase.from('dashboard_users').delete().eq('id', id);
    if (error) throw new Error(error.message);
    return true;
}

async function authenticateUser(username, password) {
    const { data: user } = await supabase.from('dashboard_users').select('*').ilike('username', username).single();
    if (!user) return null;
    let isValid = false;
    if (user.salt) {
        isValid = hashPasswordPBKDF2(password, user.salt) === user.password_hash;
    } else {
        isValid = hashPasswordLegacy(password) === user.password_hash;
        if (isValid) { const ns = generateSalt(); await supabase.from('dashboard_users').update({ salt: ns, password_hash: hashPasswordPBKDF2(password, ns) }).eq('id', user.id); }
    }
    if (!isValid) return null;
    return { id: user.id, username: user.username, role: user.role, name: user.name, assignedSiteId: user.assigned_site_id || 'all' };
}

// ==========================================
// SITES
// ==========================================
async function _getSitesRaw() {
    const { data, error } = await supabase.from('sites').select('*').order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return data || [];
}

async function getSitesData() {
    const sites = await _getSitesRaw();
    const active = sites.find(s => s.is_active) || sites[0];
    return { activeSiteId: active?.id || '', sites };
}

async function getSites() {
    const { activeSiteId, sites } = await getSitesData();
    return {
        activeSiteId,
        sites: sites.map(s => ({
            id: s.id, name: s.name, host: s.host, port: s.port, username: s.username,
            hasPassword: !!s.password, connectionType: s.connection_type || 'wireguard',
            wireguardIp: s.wireguard_ip || s.host || '10.10.88.2',
            wireguardPublicKey: s.wireguard_public_key || ''
        }))
    };
}

async function getConfig(siteId) {
    const { activeSiteId, sites } = await getSitesData();
    const targetId = siteId || activeSiteId;
    const site = sites.find(s => s.id === targetId) || sites[0] || {};
    return { id: site.id, name: site.name, host: site.host || '', port: site.port || 8728, username: site.username || '', password: site.password || '' };
}

async function saveConfig(config, siteId) {
    const { activeSiteId } = await getSitesData();
    const targetId = siteId || activeSiteId;
    const updates = { host: config.host, port: parseInt(config.port) || 8728, username: config.username };
    if (config.password !== undefined) updates.password = config.password;
    const { error } = await supabase.from('sites').update(updates).eq('id', targetId);
    if (error) throw new Error(error.message);
    return config;
}

async function setActiveSite(siteId) {
    const { data: site } = await supabase.from('sites').select('id').eq('id', siteId).single();
    if (!site) throw new Error('Site not found');
    await supabase.from('sites').update({ is_active: false }).neq('id', '__none__');
    await supabase.from('sites').update({ is_active: true }).eq('id', siteId);
    return site;
}

function _getNextWireGuardIP(sites) {
    const used = new Set([1]);
    sites.forEach(s => { const ip = s.wireguard_ip || s.host || ''; if (ip.startsWith('10.10.88.')) { const o = parseInt(ip.split('.')[3]); if (!isNaN(o)) used.add(o); } });
    let n = 2; while (used.has(n) && n < 254) n++;
    return 10.10.88.;
}

async function addSite(siteData) {
    const sites = await _getSitesRaw();
    const id = 'site_' + Date.now();
    const wireguardIp = siteData.wireguardIp || _getNextWireGuardIP(sites);
    if (!siteData.connectionType || siteData.connectionType === 'wireguard') {
        const dup = sites.find(s => s.wireguard_ip === wireguardIp || s.host === wireguardIp);
        if (dup) throw new Error(ไอพี WireGuard () ถูกใช้งานแล้วโดยไซต์งาน "");
    }
    const row = { id, name: siteData.name || 'ไซต์งานใหม่', host: siteData.host || wireguardIp, port: parseInt(siteData.port) || 8728, username: siteData.username || 'admin', password: siteData.password || '', connection_type: siteData.connectionType || 'wireguard', wireguard_ip: wireguardIp, wireguard_public_key: siteData.wireguardPublicKey || '', is_active: sites.length === 0 };
    const { data, error } = await supabase.from('sites').insert(row).select().single();
    if (error) throw new Error(error.message);
    return data;
}

async function updateSite(id, updateData) {
    const { data: s } = await supabase.from('sites').select('*').eq('id', id).single();
    if (!s) throw new Error('Site not found');
    if (updateData.wireguardIp && updateData.wireguardIp !== s.wireguard_ip) {
        const { data: dup } = await supabase.from('sites').select('id,name').or(wireguard_ip.eq.,host.eq.).neq('id', id).maybeSingle();
        if (dup) throw new Error(ไอพี WireGuard () ถูกใช้งานแล้ว "");
    }
    const u = {};
    if (updateData.name) u.name = updateData.name;
    if (updateData.host) u.host = updateData.host;
    if (updateData.port) u.port = parseInt(updateData.port) || 8728;
    if (updateData.username) u.username = updateData.username;
    if (updateData.password !== undefined && updateData.password !== '') u.password = updateData.password;
    if (updateData.connectionType) u.connection_type = updateData.connectionType;
    if (updateData.wireguardIp) u.wireguard_ip = updateData.wireguardIp;
    if (updateData.wireguardPublicKey) u.wireguard_public_key = updateData.wireguardPublicKey;
    const { data, error } = await supabase.from('sites').update(u).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    return data;
}

async function deleteSite(id) {
    const sites = await _getSitesRaw();
    if (sites.length <= 1) throw new Error('ไม่สามารถลบไซต์งานสุดท้ายในระบบได้');
    const target = sites.find(s => s.id === id);
    if (!target) throw new Error('Site not found');
    await supabase.from('sites').delete().eq('id', id);
    if (target.is_active) { const rem = sites.filter(s => s.id !== id); if (rem.length > 0) await supabase.from('sites').update({ is_active: true }).eq('id', rem[0].id); }
    return true;
}

// ==========================================
// ACTIVITY LOGS
// ==========================================
const MAX_ADMIN_LOGS = 5000;

async function getLogs(options = {}) {
    try {
        let query = supabase.from('activity_logs').select('id,username,action,details,created_at', { count: 'exact' }).order('created_at', { ascending: false });
        if (options.search) { const q = %%; query = query.or(username.ilike.,action.ilike.,details.ilike.); }
        if (options.from) query = query.gte('created_at', new Date(options.from).toISOString());
        if (options.to) query = query.lte('created_at', new Date(options.to).toISOString());
        const page = parseInt(options.page) || 1;
        const limit = parseInt(options.limit) || 100;
        const { data, count, error } = await query.range((page - 1) * limit, page * limit - 1);
        if (error) throw error;
        const logs = (data || []).map(l => ({ timestamp: l.created_at, username: l.username, action: l.action, details: l.details }));
        return { logs, total: count || 0, page, limit, pages: Math.ceil((count || 0) / limit) };
    } catch (e) { return { logs: [], total: 0, page: 1, limit: 100, pages: 0 }; }
}

async function getAllLogsRaw() {
    const { data } = await supabase.from('activity_logs').select('username,action,details,created_at').order('created_at', { ascending: false }).limit(MAX_ADMIN_LOGS);
    return (data || []).map(l => ({ timestamp: l.created_at, username: l.username, action: l.action, details: l.details }));
}

async function addLog(username, action, details) {
    // Non-blocking — ไม่ await เพื่อไม่ block request
    supabase.from('activity_logs').insert({ username, action, details }).then(() => {
        // Auto-trim เก็บไว้แค่ MAX_ADMIN_LOGS รายการล่าสุด (ทำ async)
        supabase.from('activity_logs').select('id', { count: 'exact', head: true }).then(({ count }) => {
            if (count && count > MAX_ADMIN_LOGS) {
                supabase.from('activity_logs').select('id').order('created_at', { ascending: true }).limit(count - MAX_ADMIN_LOGS).then(({ data }) => {
                    if (data && data.length) supabase.from('activity_logs').delete().in('id', data.map(r => r.id));
                });
            }
        });
    });
}

// ==========================================
// HOTSPOT LOGS (พรบ 90 วัน)
// ==========================================
const HOTSPOT_LOG_RETENTION_DAYS = 90;

function _mapHotspotRow(l) {
    return { id: l.id, loginTime: l.login_time, logoutTime: l.logout_time, username: l.username, ipAddress: l.ip_address, macAddress: l.mac_address, loginBy: l.login_by, uptime: l.uptime, bytesIn: l.bytes_in || 0, bytesOut: l.bytes_out || 0, siteName: l.site_name, status: l.status };
}

async function getHotspotLogs(options = {}) {
    try {
        let query = supabase.from('hotspot_logs').select('*', { count: 'exact' }).order('login_time', { ascending: false });
        if (options.search) { const q = %%; query = query.or(username.ilike.,ip_address.ilike.,mac_address.ilike.); }
        if (options.from) query = query.gte('login_time', new Date(options.from).toISOString());
        if (options.to) query = query.lte('login_time', new Date(options.to).toISOString());
        if (options.username) query = query.eq('username', options.username);
        const page = parseInt(options.page) || 1;
        const limit = parseInt(options.limit) || 100;
        const { data, count, error } = await query.range((page - 1) * limit, page * limit - 1);
        if (error) throw error;
        return { logs: (data || []).map(_mapHotspotRow), total: count || 0, page, limit, pages: Math.ceil((count || 0) / limit) };
    } catch (e) { return { logs: [], total: 0, page: 1, limit: 100, pages: 0 }; }
}

async function getAllHotspotLogsRaw() {
    const cutoff = new Date(Date.now() - HOTSPOT_LOG_RETENTION_DAYS * 86400000).toISOString();
    const { data } = await supabase.from('hotspot_logs').select('*').gte('login_time', cutoff).order('login_time', { ascending: false });
    return (data || []).map(_mapHotspotRow);
}

async function addHotspotSessionLog(entry) {
    const id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    const row = { id, username: entry.username || '', ip_address: entry.ipAddress || '', mac_address: entry.macAddress || '', login_by: entry.loginBy || '', uptime: entry.uptime || '', bytes_in: entry.bytesIn || 0, bytes_out: entry.bytesOut || 0, site_name: entry.siteName || '', status: entry.status || 'connected', login_time: entry.loginTime || new Date().toISOString(), logout_time: entry.logoutTime || null };
    const { data, error } = await supabase.from('hotspot_logs').insert(row).select().single();
    if (error) throw new Error(error.message);
    return _mapHotspotRow(data);
}

async function updateHotspotSessionLog(sessionId, updateData) {
    const u = {};
    if (updateData.logoutTime !== undefined) u.logout_time = updateData.logoutTime;
    if (updateData.status !== undefined) u.status = updateData.status;
    if (updateData.bytesIn !== undefined) u.bytes_in = updateData.bytesIn;
    if (updateData.bytesOut !== undefined) u.bytes_out = updateData.bytesOut;
    if (updateData.uptime !== undefined) u.uptime = updateData.uptime;
    const { data } = await supabase.from('hotspot_logs').update(u).eq('id', sessionId).select().single();
    return data ? _mapHotspotRow(data) : null;
}

async function purgeOldHotspotLogs() {
    const cutoff = new Date(Date.now() - HOTSPOT_LOG_RETENTION_DAYS * 86400000).toISOString();
    const { count } = await supabase.from('hotspot_logs').delete({ count: 'exact' }).lt('login_time', cutoff);
    return count || 0;
}

// ==========================================
// SETTINGS
// ==========================================
async function getAutoCleanupConfig() {
    try {
        const { data } = await supabase.from('app_settings').select('value').eq('key', 'auto_cleanup').maybeSingle();
        return data?.value || { autoCleanupExpired: false, cleanupIntervalMinutes: 60 };
    } catch (e) { return { autoCleanupExpired: false, cleanupIntervalMinutes: 60 }; }
}

async function saveAutoCleanupConfig(config) {
    const current = await getAutoCleanupConfig();
    const updated = { ...current, ...config };
    await supabase.from('app_settings').upsert({ key: 'auto_cleanup', value: updated, updated_at: new Date().toISOString() });
    return updated;
}

module.exports = { getConfig, saveConfig, getSites, setActiveSite, addSite, updateSite, deleteSite, getUsers, addUser, updateUser, deleteUser, authenticateUser, getLogs, getAllLogsRaw, addLog, getHotspotLogs, getAllHotspotLogsRaw, addHotspotSessionLog, updateHotspotSessionLog, purgeOldHotspotLogs, getAutoCleanupConfig, saveAutoCleanupConfig };
