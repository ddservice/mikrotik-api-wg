// db-supabase.js - Supabase database layer (Node.js 20 compatible)
// Drop-in replacement for db.js — all functions async via PostgreSQL
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
if (typeof WebSocket === 'undefined') { global.WebSocket = require('ws'); }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('[db-supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
    realtime: { transport: require('ws') }
});

// Password Hashing
const LEGACY_SALT = 'mikrotik_gatekeeper_salt_secure_2026';
function generateSalt() { return crypto.randomBytes(16).toString('hex'); }
function hashPBKDF2(pw, salt) { return crypto.pbkdf2Sync(pw, salt, 100000, 64, 'sha512').toString('hex'); }
function hashLegacy(pw) { return crypto.createHash('sha256').update(pw + LEGACY_SALT).digest('hex'); }

// ==========================================
// USERS
// ==========================================
async function getUsers() {
    const { data, error } = await supabase
        .from('dashboard_users')
        .select('id,username,salt,password_hash,role,name,assigned_site_id,created_at')
        .order('created_at', { ascending: true });
    if (error) throw new Error(error.message);
    return data.map(function(u) {
        return { id: u.id, username: u.username, salt: u.salt, passwordHash: u.password_hash,
                 role: u.role, name: u.name, assignedSiteId: u.assigned_site_id || 'all' };
    });
}

async function addUser(username, password, role, name, assignedSiteId) {
    if (!assignedSiteId) assignedSiteId = 'all';
    var ex = await supabase.from('dashboard_users').select('id').ilike('username', username).maybeSingle();
    if (ex.data) throw new Error('Username already exists');
    var id = Date.now().toString();
    var salt = generateSalt();
    var res = await supabase.from('dashboard_users').insert({
        id: id, username: username.toLowerCase(), salt: salt,
        password_hash: hashPBKDF2(password, salt),
        role: role, name: name, assigned_site_id: assignedSiteId
    }).select('id,username,role,name,assigned_site_id').single();
    if (res.error) throw new Error(res.error.message);
    return { id: res.data.id, username: res.data.username, role: res.data.role,
             name: res.data.name, assignedSiteId: res.data.assigned_site_id };
}

async function updateUser(id, updateData) {
    var fu = await supabase.from('dashboard_users').select('*').eq('id', id).single();
    if (fu.error || !fu.data) throw new Error('User not found');
    var updates = {};
    if (updateData.username) {
        var dup = await supabase.from('dashboard_users').select('id').ilike('username', updateData.username).neq('id', id).maybeSingle();
        if (dup.data) throw new Error('Username already exists');
        updates.username = updateData.username.toLowerCase();
    }
    if (updateData.password) {
        var s2 = generateSalt();
        updates.salt = s2;
        updates.password_hash = hashPBKDF2(updateData.password, s2);
    }
    if (updateData.role) updates.role = updateData.role;
    if (updateData.name) updates.name = updateData.name;
    if (updateData.assignedSiteId !== undefined) updates.assigned_site_id = updateData.assignedSiteId;
    var res = await supabase.from('dashboard_users').update(updates).eq('id', id).select('id,username,role,name,assigned_site_id').single();
    if (res.error) throw new Error(res.error.message);
    return { id: res.data.id, username: res.data.username, role: res.data.role,
             name: res.data.name, assignedSiteId: res.data.assigned_site_id || 'all' };
}

async function deleteUser(id) {
    var u = await supabase.from('dashboard_users').select('username,role').eq('id', id).single();
    if (!u.data) throw new Error('User not found');
    if (u.data.username === 'admin') throw new Error('Cannot delete default system admin account');
    var admins = await supabase.from('dashboard_users').select('id').eq('role', 'admin');
    if (admins.data && admins.data.length === 1 && admins.data[0].id === id)
        throw new Error('Cannot delete the last administrator account');
    var res = await supabase.from('dashboard_users').delete().eq('id', id);
    if (res.error) throw new Error(res.error.message);
    return true;
}

async function authenticateUser(username, password) {
    var res = await supabase.from('dashboard_users').select('*').ilike('username', username).single();
    if (res.error || !res.data) return null;
    var user = res.data;
    var isValid = false;
    if (user.salt) {
        isValid = hashPBKDF2(password, user.salt) === user.password_hash;
    } else {
        isValid = hashLegacy(password) === user.password_hash;
        if (isValid) {
            var ns = generateSalt();
            await supabase.from('dashboard_users').update({ salt: ns, password_hash: hashPBKDF2(password, ns) }).eq('id', user.id);
        }
    }
    if (!isValid) return null;
    return { id: user.id, username: user.username, role: user.role,
             name: user.name, assignedSiteId: user.assigned_site_id || 'all' };
}

// ==========================================
// SITES
// ==========================================
async function _getSitesRaw() {
    var res = await supabase.from('sites').select('*').order('created_at', { ascending: true });
    if (res.error) throw new Error(res.error.message);
    return res.data || [];
}

async function getSitesData() {
    var sites = await _getSitesRaw();
    var active = sites.find(function(s) { return s.is_active; }) || sites[0];
    return { activeSiteId: (active ? active.id : ''), sites: sites };
}

async function getSites() {
    var d = await getSitesData();
    return {
        activeSiteId: d.activeSiteId,
        sites: d.sites.map(function(s) {
            return { id: s.id, name: s.name, host: s.host, port: s.port,
                     username: s.username, hasPassword: !!s.password,
                     connectionType: s.connection_type || 'wireguard',
                     wireguardIp: s.wireguard_ip || s.host || '10.10.88.2',
                     wireguardPublicKey: s.wireguard_public_key || '' };
        })
    };
}

async function getConfig(siteId) {
    var d = await getSitesData();
    var targetId = siteId || d.activeSiteId;
    var site = d.sites.find(function(s) { return s.id === targetId; }) || d.sites[0] || {};
    return { id: site.id, name: site.name, host: site.host || '',
             port: site.port || 8728, username: site.username || '', password: site.password || '' };
}

async function saveConfig(config, siteId) {
    var d = await getSitesData();
    var targetId = siteId || d.activeSiteId;
    var updates = { host: config.host, port: parseInt(config.port) || 8728, username: config.username };
    if (config.password !== undefined) updates.password = config.password;
    var res = await supabase.from('sites').update(updates).eq('id', targetId);
    if (res.error) throw new Error(res.error.message);
    return config;
}

async function setActiveSite(siteId) {
    var res = await supabase.from('sites').select('id').eq('id', siteId).single();
    if (res.error || !res.data) throw new Error('Site not found');
    await supabase.from('sites').update({ is_active: false }).neq('id', '__none__');
    await supabase.from('sites').update({ is_active: true }).eq('id', siteId);
    return res.data;
}

function _getNextWireGuardIP(sites) {
    var used = new Set([1]);
    sites.forEach(function(s) {
        var ip = s.wireguard_ip || s.host || '';
        if (ip.startsWith('10.10.88.')) {
            var o = parseInt(ip.split('.')[3]);
            if (!isNaN(o)) used.add(o);
        }
    });
    var n = 2;
    while (used.has(n) && n < 254) n++;
    return '10.10.88.' + n;
}

async function addSite(siteData) {
    var sites = await _getSitesRaw();
    var id = 'site_' + Date.now();
    var wireguardIp = siteData.wireguardIp || _getNextWireGuardIP(sites);
    if (!siteData.connectionType || siteData.connectionType === 'wireguard') {
        var dup = sites.find(function(s) { return s.wireguard_ip === wireguardIp || s.host === wireguardIp; });
        if (dup) throw new Error('WireGuard IP ' + wireguardIp + ' already used by site: ' + dup.name);
    }
    var row = { id: id, name: siteData.name || 'New Site',
                host: siteData.host || wireguardIp,
                port: parseInt(siteData.port) || 8728,
                username: siteData.username || 'admin',
                password: siteData.password || '',
                connection_type: siteData.connectionType || 'wireguard',
                wireguard_ip: wireguardIp,
                wireguard_public_key: siteData.wireguardPublicKey || '',
                is_active: sites.length === 0 };
    var res = await supabase.from('sites').insert(row).select().single();
    if (res.error) throw new Error(res.error.message);
    return res.data;
}

async function updateSite(id, updateData) {
    var sr = await supabase.from('sites').select('*').eq('id', id).single();
    if (sr.error || !sr.data) throw new Error('Site not found');
    var s = sr.data;
    if (updateData.wireguardIp && updateData.wireguardIp !== s.wireguard_ip) {
        var wip = updateData.wireguardIp;
        var dup = await supabase.from('sites').select('id,name')
            .or('wireguard_ip.eq.' + wip + ',host.eq.' + wip).neq('id', id).maybeSingle();
        if (dup.data) throw new Error('WireGuard IP ' + wip + ' already used: ' + dup.data.name);
    }
    var u = {};
    if (updateData.name) u.name = updateData.name;
    if (updateData.host) u.host = updateData.host;
    if (updateData.port) u.port = parseInt(updateData.port) || 8728;
    if (updateData.username) u.username = updateData.username;
    if (updateData.password !== undefined && updateData.password !== '') u.password = updateData.password;
    if (updateData.connectionType) u.connection_type = updateData.connectionType;
    if (updateData.wireguardIp) u.wireguard_ip = updateData.wireguardIp;
    if (updateData.wireguardPublicKey) u.wireguard_public_key = updateData.wireguardPublicKey;
    var res = await supabase.from('sites').update(u).eq('id', id).select().single();
    if (res.error) throw new Error(res.error.message);
    return res.data;
}

async function deleteSite(id) {
    var sites = await _getSitesRaw();
    if (sites.length <= 1) throw new Error('Cannot delete the last site');
    var target = sites.find(function(s) { return s.id === id; });
    if (!target) throw new Error('Site not found');
    await supabase.from('sites').delete().eq('id', id);
    if (target.is_active) {
        var rem = sites.filter(function(s) { return s.id !== id; });
        if (rem.length > 0) await supabase.from('sites').update({ is_active: true }).eq('id', rem[0].id);
    }
    return true;
}

// ==========================================
// ACTIVITY LOGS
// ==========================================
var MAX_ADMIN_LOGS = 5000;

async function getLogs(options) {
    options = options || {};
    try {
        var query = supabase.from('activity_logs')
            .select('id,username,action,details,created_at', { count: 'exact' })
            .order('created_at', { ascending: false });
        if (options.search) {
            var q = '%' + options.search + '%';
            query = query.or('username.ilike.' + q + ',action.ilike.' + q + ',details.ilike.' + q);
        }
        if (options.from) query = query.gte('created_at', new Date(options.from).toISOString());
        if (options.to) query = query.lte('created_at', new Date(options.to).toISOString());
        var page = parseInt(options.page) || 1;
        var limit = parseInt(options.limit) || 100;
        var res = await query.range((page - 1) * limit, page * limit - 1);
        if (res.error) throw res.error;
        var logs = (res.data || []).map(function(l) {
            return { timestamp: l.created_at, username: l.username, action: l.action, details: l.details };
        });
        return { logs: logs, total: res.count || 0, page: page, limit: limit,
                 pages: Math.ceil((res.count || 0) / limit) };
    } catch(e) { return { logs: [], total: 0, page: 1, limit: 100, pages: 0 }; }
}

async function getAllLogsRaw() {
    var res = await supabase.from('activity_logs')
        .select('username,action,details,created_at')
        .order('created_at', { ascending: false }).limit(MAX_ADMIN_LOGS);
    return (res.data || []).map(function(l) {
        return { timestamp: l.created_at, username: l.username, action: l.action, details: l.details };
    });
}

async function addLog(username, action, details) {
    supabase.from('activity_logs').insert({ username: username, action: action, details: details }).then(function() {
        supabase.from('activity_logs').select('id', { count: 'exact', head: true }).then(function(r) {
            if (r.count && r.count > MAX_ADMIN_LOGS) {
                supabase.from('activity_logs').select('id').order('created_at', { ascending: true })
                    .limit(r.count - MAX_ADMIN_LOGS).then(function(d) {
                        if (d.data && d.data.length) {
                            supabase.from('activity_logs').delete().in('id', d.data.map(function(x) { return x.id; }));
                        }
                    });
            }
        });
    });
}

// ==========================================
// HOTSPOT LOGS
// ==========================================
var HOTSPOT_LOG_RETENTION_DAYS = 90;

function _mapHotspotRow(l) {
    return { id: l.id, loginTime: l.login_time, logoutTime: l.logout_time,
             username: l.username, ipAddress: l.ip_address, macAddress: l.mac_address,
             loginBy: l.login_by, uptime: l.uptime, bytesIn: l.bytes_in || 0,
             bytesOut: l.bytes_out || 0, siteName: l.site_name, status: l.status };
}

async function getHotspotLogs(options) {
    options = options || {};
    try {
        var query = supabase.from('hotspot_logs')
            .select('*', { count: 'exact' })
            .order('login_time', { ascending: false });
        if (options.search) {
            var q = '%' + options.search + '%';
            query = query.or('username.ilike.' + q + ',ip_address.ilike.' + q + ',mac_address.ilike.' + q);
        }
        if (options.from) query = query.gte('login_time', new Date(options.from).toISOString());
        if (options.to) query = query.lte('login_time', new Date(options.to).toISOString());
        if (options.username) query = query.eq('username', options.username);
        var page = parseInt(options.page) || 1;
        var limit = parseInt(options.limit) || 100;
        var res = await query.range((page - 1) * limit, page * limit - 1);
        if (res.error) throw res.error;
        return { logs: (res.data || []).map(_mapHotspotRow), total: res.count || 0,
                 page: page, limit: limit, pages: Math.ceil((res.count || 0) / limit) };
    } catch(e) { return { logs: [], total: 0, page: 1, limit: 100, pages: 0 }; }
}

async function getAllHotspotLogsRaw() {
    var cutoff = new Date(Date.now() - HOTSPOT_LOG_RETENTION_DAYS * 86400000).toISOString();
    var res = await supabase.from('hotspot_logs').select('*').gte('login_time', cutoff).order('login_time', { ascending: false });
    return (res.data || []).map(_mapHotspotRow);
}

async function addHotspotSessionLog(entry) {
    var id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    var row = { id: id, username: entry.username || '', ip_address: entry.ipAddress || '',
                mac_address: entry.macAddress || '', login_by: entry.loginBy || '',
                uptime: entry.uptime || '', bytes_in: entry.bytesIn || 0,
                bytes_out: entry.bytesOut || 0, site_name: entry.siteName || '',
                status: entry.status || 'connected',
                login_time: entry.loginTime || new Date().toISOString(),
                logout_time: entry.logoutTime || null };
    var res = await supabase.from('hotspot_logs').insert(row).select().single();
    if (res.error) throw new Error(res.error.message);
    return _mapHotspotRow(res.data);
}

async function updateHotspotSessionLog(sessionId, updateData) {
    var u = {};
    if (updateData.logoutTime !== undefined) u.logout_time = updateData.logoutTime;
    if (updateData.status !== undefined) u.status = updateData.status;
    if (updateData.bytesIn !== undefined) u.bytes_in = updateData.bytesIn;
    if (updateData.bytesOut !== undefined) u.bytes_out = updateData.bytesOut;
    if (updateData.uptime !== undefined) u.uptime = updateData.uptime;
    var res = await supabase.from('hotspot_logs').update(u).eq('id', sessionId).select().single();
    return res.data ? _mapHotspotRow(res.data) : null;
}

async function purgeOldHotspotLogs() {
    var cutoff = new Date(Date.now() - HOTSPOT_LOG_RETENTION_DAYS * 86400000).toISOString();
    var res = await supabase.from('hotspot_logs').delete({ count: 'exact' }).lt('login_time', cutoff);
    return res.count || 0;
}

// ==========================================
// PPPoE USAGE LOGS (ห้องเช่า — billing/accounting, no auto-purge)
// ==========================================
function _mapPppoeRow(l) {
    return { id: l.id, loginTime: l.login_time, logoutTime: l.logout_time,
             username: l.username || '', ipAddress: l.ip_address || '',
             bytesIn: l.bytes_in || 0, bytesOut: l.bytes_out || 0,
             siteName: l.site_name || '', status: l.status || 'connected' };
}

async function getAllPppoeUsageLogsRaw() {
    var res = await supabase.from('pppoe_usage_logs').select('*').order('login_time', { ascending: false });
    return (res.data || []).map(_mapPppoeRow);
}

async function getPppoeUsageLogs(options) {
    options = options || {};
    try {
        var query = supabase.from('pppoe_usage_logs')
            .select('*', { count: 'exact' })
            .order('login_time', { ascending: false });
        if (options.search) {
            var q = '%' + options.search + '%';
            query = query.or('username.ilike.' + q + ',ip_address.ilike.' + q);
        }
        if (options.from) query = query.gte('login_time', new Date(options.from).toISOString());
        if (options.to) query = query.lte('login_time', new Date(options.to).toISOString());
        if (options.username) query = query.eq('username', options.username);
        var page = parseInt(options.page) || 1;
        var limit = parseInt(options.limit) || 100;
        var res = await query.range((page - 1) * limit, page * limit - 1);
        if (res.error) throw res.error;
        return { logs: (res.data || []).map(_mapPppoeRow), total: res.count || 0,
                 page: page, limit: limit, pages: Math.ceil((res.count || 0) / limit) };
    } catch(e) { return { logs: [], total: 0, page: 1, limit: 100, pages: 0 }; }
}

async function addPppoeUsageLog(entry) {
    var id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
    var row = { id: id, username: entry.username || '', ip_address: entry.ipAddress || '',
                bytes_in: entry.bytesIn || 0, bytes_out: entry.bytesOut || 0,
                site_name: entry.siteName || '', status: entry.status || 'connected',
                login_time: entry.loginTime || new Date().toISOString(),
                logout_time: entry.logoutTime || null };
    var res = await supabase.from('pppoe_usage_logs').insert(row).select().single();
    if (res.error) throw new Error(res.error.message);
    return _mapPppoeRow(res.data);
}

// Monthly per-room usage summary for billing. `month` is 'YYYY-MM'.
async function getPppoeUsageSummary(month) {
    var m = /^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7);
    var start = new Date(m + '-01T00:00:00.000Z');
    var end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
    var res = await supabase.from('pppoe_usage_logs')
        .select('username, bytes_in, bytes_out')
        .gte('login_time', start.toISOString())
        .lt('login_time', end.toISOString());
    if (res.error) throw new Error(res.error.message);
    var byRoom = {};
    for (var row of (res.data || [])) {
        if (!byRoom[row.username]) byRoom[row.username] = { username: row.username, bytesIn: 0, bytesOut: 0 };
        byRoom[row.username].bytesIn += row.bytes_in || 0;
        byRoom[row.username].bytesOut += row.bytes_out || 0;
    }
    return { month: m, rooms: Object.values(byRoom) };
}

// ==========================================
// DNS QUERY LOGS (พรบ มาตรา 26 — domain-level visit history)
// ==========================================
var DNS_LOG_RETENTION_DAYS = 90;

function _mapDnsRow(l) {
    return { id: l.id, queryTime: l.query_time, username: l.username || '',
             ipAddress: l.ip_address, macAddress: l.mac_address || '',
             domain: l.domain, siteName: l.site_name || '' };
}

async function getDnsQueryLogs(options) {
    options = options || {};
    try {
        var query = supabase.from('dns_query_logs')
            .select('*', { count: 'exact' })
            .order('query_time', { ascending: false });
        if (options.search) {
            var q = '%' + options.search + '%';
            query = query.or('username.ilike.' + q + ',ip_address.ilike.' + q + ',mac_address.ilike.' + q + ',domain.ilike.' + q);
        }
        if (options.from) query = query.gte('query_time', new Date(options.from).toISOString());
        if (options.to) query = query.lte('query_time', new Date(options.to).toISOString());
        if (options.username) query = query.eq('username', options.username);
        var page = parseInt(options.page) || 1;
        var limit = parseInt(options.limit) || 100;
        var res = await query.range((page - 1) * limit, page * limit - 1);
        if (res.error) throw res.error;
        return { logs: (res.data || []).map(_mapDnsRow), total: res.count || 0,
                 page: page, limit: limit, pages: Math.ceil((res.count || 0) / limit) };
    } catch(e) { return { logs: [], total: 0, page: 1, limit: 100, pages: 0 }; }
}

async function getAllDnsQueryLogsRaw() {
    var cutoff = new Date(Date.now() - DNS_LOG_RETENTION_DAYS * 86400000).toISOString();
    var res = await supabase.from('dns_query_logs').select('*').gte('query_time', cutoff).order('query_time', { ascending: false });
    return (res.data || []).map(_mapDnsRow);
}

async function addDnsQueryLogsBulk(entries) {
    if (!entries || entries.length === 0) return 0;
    var rows = entries.map(function(entry) {
        return { id: Date.now().toString() + Math.random().toString(36).substr(2, 6),
                 username: entry.username || '', ip_address: entry.ipAddress || '',
                 mac_address: entry.macAddress || '', domain: entry.domain || '',
                 site_name: entry.siteName || '',
                 query_time: entry.queryTime || new Date().toISOString() };
    });
    var res = await supabase.from('dns_query_logs').insert(rows);
    if (res.error) throw new Error(res.error.message);
    return rows.length;
}

async function purgeOldDnsQueryLogs() {
    var cutoff = new Date(Date.now() - DNS_LOG_RETENTION_DAYS * 86400000).toISOString();
    var res = await supabase.from('dns_query_logs').delete({ count: 'exact' }).lt('query_time', cutoff);
    return res.count || 0;
}

// ==========================================
// SETTINGS
// ==========================================
async function getAutoCleanupConfig() {
    try {
        var res = await supabase.from('app_settings').select('value').eq('key', 'auto_cleanup').maybeSingle();
        return (res.data && res.data.value) || { autoCleanupExpired: false, cleanupIntervalMinutes: 60 };
    } catch(e) { return { autoCleanupExpired: false, cleanupIntervalMinutes: 60 }; }
}

async function saveAutoCleanupConfig(config) {
    var current = await getAutoCleanupConfig();
    var updated = Object.assign({}, current, config);
    await supabase.from('app_settings').upsert({ key: 'auto_cleanup', value: updated, updated_at: new Date().toISOString() });
    return updated;
}

// ==========================================
// Menu Permissions (which nav items co-admin/user can see)
// admin always sees everything — not configurable, not stored here.
// ==========================================
var DEFAULT_MENU_PERMISSIONS = {
    'co-admin': ['hotspot', 'pppoe', 'firewall', 'logs'],
    'user': ['hotspot', 'firewall']
};

async function getMenuPermissions() {
    try {
        var res = await supabase.from('app_settings').select('value').eq('key', 'menu_permissions').maybeSingle();
        return (res.data && res.data.value) || Object.assign({}, DEFAULT_MENU_PERMISSIONS);
    } catch(e) { return Object.assign({}, DEFAULT_MENU_PERMISSIONS); }
}

async function saveMenuPermissions(config) {
    var updated = {
        'co-admin': Array.isArray(config['co-admin']) ? config['co-admin'] : [],
        'user': Array.isArray(config['user']) ? config['user'] : []
    };
    await supabase.from('app_settings').upsert({ key: 'menu_permissions', value: updated, updated_at: new Date().toISOString() });
    return updated;
}

module.exports = {
    getConfig: getConfig, saveConfig: saveConfig,
    getSites: getSites, setActiveSite: setActiveSite,
    addSite: addSite, updateSite: updateSite, deleteSite: deleteSite,
    getUsers: getUsers, addUser: addUser, updateUser: updateUser,
    deleteUser: deleteUser, authenticateUser: authenticateUser,
    getLogs: getLogs, getAllLogsRaw: getAllLogsRaw, addLog: addLog,
    getHotspotLogs: getHotspotLogs, getAllHotspotLogsRaw: getAllHotspotLogsRaw,
    addHotspotSessionLog: addHotspotSessionLog, updateHotspotSessionLog: updateHotspotSessionLog,
    purgeOldHotspotLogs: purgeOldHotspotLogs,
    getDnsQueryLogs: getDnsQueryLogs, getAllDnsQueryLogsRaw: getAllDnsQueryLogsRaw,
    addDnsQueryLogsBulk: addDnsQueryLogsBulk,
    purgeOldDnsQueryLogs: purgeOldDnsQueryLogs,
    getPppoeUsageLogs: getPppoeUsageLogs, getAllPppoeUsageLogsRaw: getAllPppoeUsageLogsRaw,
    addPppoeUsageLog: addPppoeUsageLog, getPppoeUsageSummary: getPppoeUsageSummary,
    getAutoCleanupConfig: getAutoCleanupConfig, saveAutoCleanupConfig: saveAutoCleanupConfig,
    getMenuPermissions: getMenuPermissions, saveMenuPermissions: saveMenuPermissions
};