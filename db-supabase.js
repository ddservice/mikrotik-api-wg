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
// SITES (With In-Memory Cache)
// ==========================================
let _sitesCache = null;
let _sitesCacheTime = 0;
const SITES_CACHE_TTL_MS = 20000; // 20s TTL

function invalidateSitesCache() {
    _sitesCache = null;
    _sitesCacheTime = 0;
}

async function _getSitesRaw() {
    const now = Date.now();
    if (_sitesCache && (now - _sitesCacheTime < SITES_CACHE_TTL_MS)) {
        return _sitesCache;
    }
    var res = await supabase.from('sites').select('*').order('created_at', { ascending: true });
    if (res.error) throw new Error(res.error.message);
    _sitesCache = res.data || [];
    _sitesCacheTime = now;
    return _sitesCache;
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
                     wireguardPublicKey: s.wireguard_public_key || '',
                     // Missing/null column (older rows, or column not yet
                     // migrated) defaults to enabled — only an explicit
                     // false turns it off.
                     dnsLoggingEnabled: s.dns_logging_enabled !== false };
        })
    };
}

async function getConfig(siteId) {
    var d = await getSitesData();
    var targetId = siteId || d.activeSiteId;
    var targetIdStr = String(targetId || '').trim();
    var site = d.sites.find(function(s) {
        return s.id === targetIdStr || s.name === targetIdStr ||
               (s.id && s.id.toLowerCase() === targetIdStr.toLowerCase()) ||
               (s.name && s.name.toLowerCase() === targetIdStr.toLowerCase());
    }) || d.sites.find(function(s) { return s.is_active; }) || d.sites[0] || {};
    var host = site.host || site.wireguard_ip || site.wireguardIp || '';
    return {
        id: site.id,
        name: site.name,
        host: host,
        port: parseInt(site.port) || 8728,
        username: site.username || 'admin',
        password: site.password || '',
        connectionType: site.connection_type || site.connectionType || 'wireguard',
        wireguardIp: site.wireguard_ip || site.wireguardIp || ''
    };
}

async function saveConfig(config, siteId) {
    var d = await getSitesData();
    var targetId = siteId || d.activeSiteId;
    var updates = { host: config.host, port: parseInt(config.port) || 8728, username: config.username };
    if (config.password !== undefined) updates.password = config.password;
    var res = await supabase.from('sites').update(updates).eq('id', targetId);
    if (res.error) throw new Error(res.error.message);
    invalidateSitesCache();
    return config;
}

async function setActiveSite(siteId) {
    var res = await supabase.from('sites').select('id').eq('id', siteId).single();
    if (res.error || !res.data) throw new Error('Site not found');
    await supabase.from('sites').update({ is_active: false }).neq('id', '__none__');
    await supabase.from('sites').update({ is_active: true }).eq('id', siteId);
    invalidateSitesCache();
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
                dns_logging_enabled: siteData.dnsLoggingEnabled !== false,
                is_active: sites.length === 0 };
    var res = await supabase.from('sites').insert(row).select().single();
    if (res.error) throw new Error(res.error.message);
    invalidateSitesCache();
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
    if (updateData.dnsLoggingEnabled !== undefined) u.dns_logging_enabled = !!updateData.dnsLoggingEnabled;
    var res = await supabase.from('sites').update(u).eq('id', id).select().single();
    if (res.error) throw new Error(res.error.message);
    invalidateSitesCache();
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
    invalidateSitesCache();
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
        if (options.siteName) query = query.eq('site_name', options.siteName);
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
        if (options.siteName) query = query.eq('site_name', options.siteName);
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
async function getPppoeUsageSummary(month, siteName) {
    var m = /^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7);
    var start = new Date(m + '-01T00:00:00.000Z');
    var end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
    var query = supabase.from('pppoe_usage_logs')
        .select('username, bytes_in, bytes_out')
        .gte('login_time', start.toISOString())
        .lt('login_time', end.toISOString());
    if (siteName) query = query.eq('site_name', siteName);
    var res = await query;
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
        if (options.siteName) query = query.eq('site_name', options.siteName);
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
    'co-admin': ['hotspot', 'pppoe', 'multiwan', 'firewall', 'logs'],
    'user': ['hotspot', 'firewall']
};

async function getMenuPermissions() {
    try {
        var res = await supabase.from('app_settings').select('value').eq('key', 'menu_permissions').maybeSingle();
        var val = (res.data && res.data.value) || Object.assign({}, DEFAULT_MENU_PERMISSIONS);
        if (val['co-admin'] && !val['co-admin'].includes('multiwan')) {
            val['co-admin'].push('multiwan');
        }
        return val;
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

function _getDefaultMultiWanConfig() {
    return {
        wans: [
            { id: 'wan_1', name: 'WAN 1', interface: 'pppoe-out1', type: 'pppoe', gateway: '', speed: 1000, weight: 2, dnsCheck: '8.8.8.8' },
            { id: 'wan_2', name: 'WAN 2', interface: 'ether2-WAN2', type: 'dhcp', gateway: '192.168.2.1', speed: 500, weight: 1, dnsCheck: '1.1.1.1' }
        ],
        pbrRules: [
            { id: 'pbr_1', srcInterface: 'vlan10-hotspot', targetWanNum: 1, note: 'VLAN 10 Hotspot ออก WAN 1' },
            { id: 'pbr_2', srcInterface: 'vlan20-pppoe', targetWanNum: 2, note: 'VLAN 20 PPPoE ออก WAN 2' }
        ],
        telegramToken: '',
        telegramChatId: '',
        mssClamping: true,
        fasttrackBypass: true,
        dnsHijack: true,
        hairpinNat: true
    };
}


// ==========================================
// TELEGRAM OPS ALERTS
// แยกจาก LINE โดยเจตนา: LINE คือช่องทางหาลูกค้า/ผู้เช่าห้อง (สรุปวันหมดอายุ)
// ส่วน Telegram คือช่องทางของทีมแอดมิน (เราท์เตอร์ล่ม, auth fail, ปัญหาระบบ)
// เอามารวมช่องเดียวกันแล้วมีปัญหามาแล้วจริง ๆ เมื่อ 2026-08-28
// (แจ้งเตือน Suksawad-CMU ล่ม ไปโผล่ในกลุ่มลูกค้าของ A4)
//
// เป็น config เดียวทั้งระบบ ไม่แยกรายสาขา เพราะทีมแอดมินดูทุกสาขาอยู่แล้ว
// ในข้อความจะระบุชื่อสาขากำกับเสมอ
// ==========================================

function _defaultTelegramAlertConfig() {
    return {
        enabled: false,
        botToken: '',
        chatId: '',
        alertOffline: true,
        alertOnline: true
    };
}

async function getTelegramAlertConfig() {
    try {
        var res = await supabase.from('app_settings').select('value').eq('key', 'telegram_alert_config').maybeSingle();
        var data = (res.data && res.data.value) || null;
        if (data) {
            return {
                enabled: !!data.enabled,
                botToken: data.botToken || '',
                chatId: data.chatId || '',
                alertOffline: data.alertOffline !== false,
                alertOnline: data.alertOnline !== false
            };
        }
        // ยังไม่เคยตั้งค่า — ยืมค่าที่กรอกไว้ในหน้า Multi-WAN มาเป็นค่าเริ่มต้น
        // (ที่นั่นใช้ token/chat เดียวกันสำหรับ netwatch บนเราท์เตอร์อยู่แล้ว)
        // แต่ยังไม่เปิดใช้งานให้เอง ต้องมากดเปิดเองเพื่อไม่ให้มีข้อความโผล่โดยไม่ตั้งใจ
        var mw = await getMultiWanConfig();
        var d = _defaultTelegramAlertConfig();
        d.botToken = (mw && mw.telegramToken) || '';
        d.chatId = (mw && mw.telegramChatId) || '';
        return d;
    } catch (e) {
        return _defaultTelegramAlertConfig();
    }
}

async function saveTelegramAlertConfig(config) {
    try {
        var current = await getTelegramAlertConfig();
        var updated = {
            enabled: config.enabled !== undefined ? !!config.enabled : current.enabled,
            botToken: config.botToken !== undefined ? String(config.botToken).trim() : current.botToken,
            chatId: config.chatId !== undefined ? String(config.chatId).trim() : current.chatId,
            alertOffline: config.alertOffline !== undefined ? !!config.alertOffline : current.alertOffline,
            alertOnline: config.alertOnline !== undefined ? !!config.alertOnline : current.alertOnline
        };
        await supabase.from('app_settings').upsert({ key: 'telegram_alert_config', value: updated, updated_at: new Date().toISOString() });
        return updated;
    } catch (e) {
        throw e;
    }
}

async function getMultiWanConfig(siteId) {
    try {
        var key = 'multiwan_' + (siteId || 'default');
        var res = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
        var data = res.data && res.data.value;
        if (!data) return _getDefaultMultiWanConfig();
        if (!data.wans || !Array.isArray(data.wans)) {
            data.wans = [
                { id: 'wan_1', name: 'WAN 1', interface: data.wan1Interface || 'pppoe-out1', type: data.wan1Type || 'pppoe', gateway: '', speed: data.wan1Speed || 1000, weight: data.wan1Weight || 2, dnsCheck: data.dnsCheckWan1 || '8.8.8.8' },
                { id: 'wan_2', name: 'WAN 2', interface: data.wan2Interface || 'ether2-WAN2', type: data.wan2Type || 'dhcp', gateway: data.wan2Gateway || '192.168.2.1', speed: data.wan2Speed || 500, weight: data.wan2Weight || 1, dnsCheck: data.dnsCheckWan2 || '1.1.1.1' }
            ];
        }
        if (!data.pbrRules || !Array.isArray(data.pbrRules)) {
            data.pbrRules = [
                { id: 'pbr_1', srcInterface: 'vlan10-hotspot', targetWanNum: 1, note: 'VLAN 10 Hotspot ออก WAN 1' },
                { id: 'pbr_2', srcInterface: 'vlan20-pppoe', targetWanNum: 2, note: 'VLAN 20 PPPoE ออก WAN 2' }
            ];
        }
        return Object.assign({}, _getDefaultMultiWanConfig(), data);
    } catch(e) {
        return _getDefaultMultiWanConfig();
    }
}

async function saveMultiWanConfig(siteId, config) {
    var key = 'multiwan_' + (siteId || 'default');
    var current = await getMultiWanConfig(siteId);
    var updated = Object.assign({}, current, config);
    await supabase.from('app_settings').upsert({ key: key, value: updated, updated_at: new Date().toISOString() });
    return updated;
}

// ==========================================
// ARCHIVED HOTSPOT USERS
// ==========================================
function _mapArchivedHotspotRow(l) {
    return {
        id: l.id,
        username: l.username || '',
        password: l.password || '',
        profile: l.profile || 'default',
        limitUptime: l.limit_uptime || '',
        limitBytesTotal: l.limit_bytes_total || 0,
        comment: l.comment || '',
        siteName: l.site_name || '',
        expiredAt: l.expired_at || l.deleted_at,
        deletedAt: l.deleted_at,
        deletedBy: l.deleted_by || 'System',
        reason: l.reason || 'expired'
    };
}

async function getArchivedHotspotUsers(options) {
    options = options || {};
    try {
        var query = supabase.from('archived_hotspot_users')
            .select('*', { count: 'exact' })
            .order('deleted_at', { ascending: false });

        if (options.siteName) query = query.eq('site_name', options.siteName);
        if (options.search) {
            var q = '%' + options.search + '%';
            query = query.or('username.ilike.' + q + ',comment.ilike.' + q + ',profile.ilike.' + q);
        }

        var page = parseInt(options.page) || 1;
        var limit = parseInt(options.limit) || 100;
        var res = await query.range((page - 1) * limit, page * limit - 1);
        if (res.error) throw res.error;
        return {
            users: (res.data || []).map(_mapArchivedHotspotRow),
            total: res.count || 0,
            page: page,
            limit: limit,
            pages: Math.ceil((res.count || 0) / limit) || 1
        };
    } catch(e) {
        return { users: [], total: 0, page: 1, limit: 100, pages: 1 };
    }
}

async function archiveDeletedHotspotUser(entry) {
    try {
        var id = Date.now().toString() + Math.random().toString(36).substr(2, 5);
        var row = {
            id: id,
            username: entry.username || entry.name || '',
            password: entry.password || '',
            profile: entry.profile || 'default',
            limit_uptime: entry.limitUptime || '',
            limit_bytes_total: parseInt(entry.limitBytesTotal) || 0,
            comment: entry.comment || '',
            site_name: entry.siteName || '',
            expired_at: entry.expiredAt || new Date().toISOString(),
            deleted_at: new Date().toISOString(),
            deleted_by: entry.deletedBy || 'System',
            reason: entry.reason || 'manual_delete'
        };
        var res = await supabase.from('archived_hotspot_users').insert(row).select().single();
        if (res.error) throw res.error;
        return _mapArchivedHotspotRow(res.data);
    } catch(e) {
        console.error('Supabase archiveDeletedHotspotUser failed:', e.message || e);
        return null;
    }
}

async function archiveDeletedHotspotUsersBulk(entries) {
    if (!entries || !entries.length) return 0;
    try {
        var rows = entries.map(function(entry) {
            return {
                id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
                username: entry.username || entry.name || '',
                password: entry.password || '',
                profile: entry.profile || 'default',
                limit_uptime: entry.limitUptime || '',
                limit_bytes_total: parseInt(entry.limitBytesTotal) || 0,
                comment: entry.comment || '',
                site_name: entry.siteName || '',
                expired_at: entry.expiredAt || new Date().toISOString(),
                deleted_at: new Date().toISOString(),
                deleted_by: entry.deletedBy || 'System Auto',
                reason: entry.reason || 'auto_cleanup'
            };
        });
        var res = await supabase.from('archived_hotspot_users').insert(rows);
        if (res.error) throw res.error;
        return rows.length;
    } catch(e) {
        console.error('Supabase archiveDeletedHotspotUsersBulk failed:', e.message || e);
        return 0;
    }
}

async function deleteArchivedHotspotUser(id) {
    try {
        var res = await supabase.from('archived_hotspot_users').delete().eq('id', id);
        return !res.error;
    } catch(e) { return false; }
}

async function clearArchivedHotspotUsers(siteName) {
    try {
        var query = supabase.from('archived_hotspot_users').delete();
        if (siteName) query = query.eq('site_name', siteName);
        var res = await query;
        return !res.error;
    } catch(e) { return 0; }
}

async function getLineDigestConfig(siteId) {
    try {
        var sitesData = await getSites();
        var activeId = (sitesData && sitesData.activeSiteId) || (sitesData && sitesData.sites && sitesData.sites[0] && sitesData.sites[0].id) || 'default';
        var targetSiteId = siteId || activeId;
        var siteCount = (sitesData && sitesData.sites && sitesData.sites.length) || 0;

        var key = 'line_digest_config_' + targetSiteId;
        var res = await supabase.from('app_settings').select('value').eq('key', key).maybeSingle();
        var data = res.data && res.data.value;

        // สาขาที่มี record ของตัวเอง ใช้ค่าของตัวเองล้วน ๆ ห้ามยืมจาก record กลาง
        // เดิมเขียนเป็น (data.targetId || globalTarget) ทำให้สาขาที่ยังไม่ได้ตั้งค่า
        // ไปหยิบ token/group ของอีกสาขามาใช้ ผลคือแจ้งเตือนของ Suksawad-CMU
        // เด้งเข้ากลุ่ม LINE ของ A4-Residence (พบจริง 2026-08-28)
        if (data) {
            return {
                siteId: targetSiteId,
                enabled: !!data.enabled,
                channelAccessToken: data.channelAccessToken || data.lineNotifyToken || '',
                channelSecret: data.channelSecret || '',
                targetId: data.targetId || '',
                digestTime: data.digestTime || '09:00',
                includeHotspot: data.includeHotspot !== false,
                includePppoe: data.includePppoe !== false,
                lastSentDate: data.lastSentDate || ''
            };
        }

        // ไม่มี record ของตัวเอง — อ่าน record กลางได้เฉพาะตอนที่ระบบยังเป็นสาขาเดียว
        // (ติดตั้งเก่าที่ยังไม่มีตาราง sites หรือมีสาขาเดียว) เพื่อไม่ให้ของเดิมพัง
        var isSingleSiteLegacy = targetSiteId === 'default' || siteCount <= 1;
        if (isSingleSiteLegacy) {
            var resOld = await supabase.from('app_settings').select('value').eq('key', 'line_digest_config').maybeSingle();
            var dataOld = (resOld.data && resOld.data.value) || {};
            return {
                siteId: targetSiteId,
                enabled: !!dataOld.enabled,
                channelAccessToken: dataOld.channelAccessToken || dataOld.lineNotifyToken || '',
                channelSecret: dataOld.channelSecret || '',
                targetId: dataOld.targetId || '',
                digestTime: dataOld.digestTime || '09:00',
                includeHotspot: dataOld.includeHotspot !== false,
                includePppoe: dataOld.includePppoe !== false,
                lastSentDate: dataOld.lastSentDate || ''
            };
        }

        // ระบบหลายสาขา + สาขานี้ยังไม่ได้ตั้งค่า = ปิดสนิท ไม่มี token ไม่มีปลายทาง
        return {
            siteId: targetSiteId,
            enabled: false,
            channelAccessToken: '',
            channelSecret: '',
            targetId: '',
            digestTime: '09:00',
            includeHotspot: true,
            includePppoe: true,
            lastSentDate: ''
        };
    } catch (e) {
        return { siteId: siteId || 'default', enabled: false, channelAccessToken: '', channelSecret: '', targetId: '', digestTime: '09:00', includeHotspot: true, includePppoe: true, lastSentDate: '' };
    }
}

async function saveLineDigestConfig(config, siteId) {
    try {
        var sitesData = await getSites();
        var activeId = (sitesData && sitesData.activeSiteId) || (sitesData && sitesData.sites && sitesData.sites[0] && sitesData.sites[0].id) || 'default';
        var targetSiteId = siteId || config.siteId || activeId;

        var key = 'line_digest_config_' + targetSiteId;
        var current = await getLineDigestConfig(targetSiteId);
        var finalConfig = Object.assign({}, config);

        var updated = Object.assign({}, current, finalConfig, {
            siteId: targetSiteId,
            enabled: finalConfig.enabled !== undefined ? !!finalConfig.enabled : current.enabled,
            channelAccessToken: finalConfig.channelAccessToken !== undefined ? finalConfig.channelAccessToken : current.channelAccessToken,
            channelSecret: finalConfig.channelSecret !== undefined ? finalConfig.channelSecret : current.channelSecret,
            targetId: finalConfig.targetId !== undefined ? finalConfig.targetId : current.targetId,
            digestTime: finalConfig.digestTime || current.digestTime,
            includeHotspot: finalConfig.includeHotspot !== undefined ? finalConfig.includeHotspot !== false : current.includeHotspot,
            includePppoe: finalConfig.includePppoe !== undefined ? finalConfig.includePppoe !== false : current.includePppoe,
            lastSentDate: finalConfig.lastSentDate !== undefined ? finalConfig.lastSentDate : current.lastSentDate
        });

        await supabase.from('app_settings').upsert({ key: key, value: updated, updated_at: new Date().toISOString() });

        var firstSiteId = (sitesData && sitesData.sites && sitesData.sites[0] && sitesData.sites[0].id) || 'default';
        if (targetSiteId === 'default' || targetSiteId === firstSiteId) {
            await supabase.from('app_settings').upsert({ key: 'line_digest_config', value: updated, updated_at: new Date().toISOString() });
        }

        return getLineDigestConfig(targetSiteId);
    } catch (e) {
        throw e;
    }
}

// ==========================================
// LINE USER BINDINGS
// ==========================================
async function getLineUserBinding(lineUserId) {
    try {
        var res = await supabase.from('line_user_bindings').select('*').eq('line_user_id', lineUserId).maybeSingle();
        if (res.error || !res.data) return null;
        return {
            lineUserId: res.data.line_user_id,
            username: res.data.username,
            siteId: res.data.site_id || 'default',
            siteName: res.data.site_name || 'Default',
            linkedAt: res.data.linked_at
        };
    } catch(e) { return null; }
}

async function bindLineUser(lineUserId, username, siteId, siteName) {
    try {
        var row = {
            line_user_id: lineUserId,
            username: username,
            site_id: siteId || 'default',
            site_name: siteName || 'Default',
            linked_at: new Date().toISOString()
        };
        var res = await supabase.from('line_user_bindings').upsert(row, { onConflict: 'line_user_id' }).select().single();
        if (res.error) throw res.error;
        return {
            lineUserId: res.data.line_user_id,
            username: res.data.username,
            siteId: res.data.site_id,
            siteName: res.data.site_name,
            linkedAt: res.data.linked_at
        };
    } catch(e) {
        return { lineUserId: lineUserId, username: username, siteId: siteId || 'default', siteName: siteName || 'Default', linkedAt: new Date().toISOString() };
    }
}


async function unbindLineUser(lineUserId) {
    try {
        var res = await supabase.from('line_user_bindings').delete().eq('line_user_id', lineUserId);
        return !res.error;
    } catch(e) { return false; }
}


// ==========================================
// LOG ARCHIVES (พรบ. ม.26 — ไฟล์ปิดผนึกรายวัน + SHA-256)
// ==========================================
function _mapArchiveRow(r) {
    return {
        id: r.id,
        archiveDate: r.archive_date,
        logType: r.log_type,
        siteName: r.site_name,
        recordCount: r.record_count || 0,
        fileName: r.file_name,
        fileSize: r.file_size || 0,
        sha256: r.sha256,
        storageR2Key: r.storage_r2_key || null,
        storageLocal: r.storage_local || null,
        createdAt: r.created_at,
        createdBy: r.created_by
    };
}

async function getLogArchives(options) {
    options = options || {};
    try {
        var query = supabase.from('log_archives')
            .select('*', { count: 'exact' })
            .order('archive_date', { ascending: false })
            .order('log_type', { ascending: true });

        if (options.logType) query = query.eq('log_type', options.logType);
        if (options.from) query = query.gte('archive_date', options.from);
        if (options.to) query = query.lte('archive_date', options.to);

        var page = parseInt(options.page) || 1;
        var limit = parseInt(options.limit) || 100;
        var res = await query.range((page - 1) * limit, page * limit - 1);
        if (res.error) throw res.error;
        return {
            archives: (res.data || []).map(_mapArchiveRow),
            total: res.count || 0,
            page: page,
            limit: limit,
            pages: Math.ceil((res.count || 0) / limit) || 1
        };
    } catch (e) {
        return { archives: [], total: 0, page: 1, limit: 100, pages: 0, error: e.message };
    }
}

async function getLogArchive(id) {
    try {
        var res = await supabase.from('log_archives').select('*').eq('id', id).maybeSingle();
        if (res.error) throw res.error;
        return res.data ? _mapArchiveRow(res.data) : null;
    } catch (e) {
        return null;
    }
}

async function saveLogArchive(rec) {
    var row = {
        id: rec.id,
        archive_date: rec.archiveDate,
        log_type: rec.logType,
        site_name: rec.siteName || 'ALL',
        record_count: rec.recordCount || 0,
        file_name: rec.fileName,
        file_size: rec.fileSize || 0,
        sha256: rec.sha256,
        storage_r2_key: rec.storageR2Key || null,
        storage_local: rec.storageLocal || null,
        created_by: rec.createdBy || 'System Auto'
    };
    var res = await supabase.from('log_archives').upsert(row, { onConflict: 'id' }).select().single();
    if (res.error) throw res.error;
    return _mapArchiveRow(res.data);
}

module.exports = {
    getMultiWanConfig: getMultiWanConfig, saveMultiWanConfig: saveMultiWanConfig,
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
    getMenuPermissions: getMenuPermissions, saveMenuPermissions: saveMenuPermissions,
    getArchivedHotspotUsers: getArchivedHotspotUsers, archiveDeletedHotspotUser: archiveDeletedHotspotUser,
    archiveDeletedHotspotUsersBulk: archiveDeletedHotspotUsersBulk,
    deleteArchivedHotspotUser: deleteArchivedHotspotUser, clearArchivedHotspotUsers: clearArchivedHotspotUsers,
    getLineDigestConfig: getLineDigestConfig, saveLineDigestConfig: saveLineDigestConfig,
    getLineUserBinding: getLineUserBinding, bindLineUser: bindLineUser, unbindLineUser: unbindLineUser,
    getTelegramAlertConfig: getTelegramAlertConfig, saveTelegramAlertConfig: saveTelegramAlertConfig,
    getLogArchives: getLogArchives, getLogArchive: getLogArchive, saveLogArchive: saveLogArchive
};