const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DB_DIR = path.join(__dirname, 'db');
const CONFIG_FILE = path.join(DB_DIR, 'config.json');
const USERS_FILE = path.join(DB_DIR, 'users.json');

// Ensure db directory exists
if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

// Password hashing helper (Supports legacy SHA256 and secure per-user PBKDF2 with salt)
const LEGACY_SALT = "mikrotik_gatekeeper_salt_secure_2026";

function generateSalt() {
    return crypto.randomBytes(16).toString('hex');
}

function hashPasswordPBKDF2(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

function hashPasswordLegacy(password) {
    return crypto.createHash('sha256').update(password + LEGACY_SALT).digest('hex');
}


// Initial default configuration (Multi-Site supported)
const defaultSitesData = {
    activeSiteId: 'site_1',
    sites: [
        {
            id: 'site_1',
            name: 'สาขาหลัก (Main Site)',
            host: '',
            port: 8728,
            username: '',
            password: ''
        }
    ]
};

// Initial default users
const defaultAdminSalt = generateSalt();
const defaultUsers = [
    {
        id: '1',
        username: 'admin',
        salt: defaultAdminSalt,
        passwordHash: hashPasswordPBKDF2('admin1234', defaultAdminSalt),
        role: 'admin', // admin, co-admin, user
        name: 'System Administrator'
    }
];

function initDB() {
    if (!fs.existsSync(CONFIG_FILE)) {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultSitesData, null, 4), 'utf8');
    }
    if (!fs.existsSync(USERS_FILE)) {
        fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 4), 'utf8');
    }
}

// Initialize database files immediately
initDB();

function getSitesData() {
    try {
        const data = fs.readFileSync(CONFIG_FILE, 'utf8');
        const parsed = JSON.parse(data);
        // Migration check: if old single config format exists without sites array
        if (parsed.host !== undefined && !parsed.sites) {
            const migrated = {
                activeSiteId: 'site_1',
                sites: [
                    {
                        id: 'site_1',
                        name: 'สาขาหลัก (Main Site)',
                        host: parsed.host || '',
                        port: parsed.port || 8728,
                        username: parsed.username || '',
                        password: parsed.password || ''
                    }
                ]
            };
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(migrated, null, 4), 'utf8');
            return migrated;
        }
        return parsed;
    } catch (e) {
        return defaultSitesData;
    }
}

function saveSitesData(sitesData) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(sitesData, null, 4), 'utf8');
    return sitesData;
}

// Get config for active site or specified siteId (backward compatible)
function getConfig(siteId) {
    const data = getSitesData();
    const targetId = siteId || data.activeSiteId;
    const site = data.sites.find(s => s.id === targetId) || data.sites[0] || {};
    return {
        id: site.id,
        name: site.name,
        host: site.host || '',
        port: site.port || 8728,
        username: site.username || '',
        password: site.password || ''
    };
}

// Save config for active site or specified siteId
function saveConfig(config, siteId) {
    const data = getSitesData();
    const targetId = siteId || data.activeSiteId;
    const index = data.sites.findIndex(s => s.id === targetId);
    if (index !== -1) {
        data.sites[index] = {
            ...data.sites[index],
            host: config.host,
            port: parseInt(config.port) || 8728,
            username: config.username,
            password: config.password !== undefined ? config.password : data.sites[index].password
        };
        saveSitesData(data);
    }
    return config;
}

function getNextWireGuardIP() {
    const data = getSitesData();
    const usedLastOctets = new Set([1]); // 10.10.88.1 is VPS
    
    data.sites.forEach(s => {
        const ip = s.wireguardIp || s.host || '10.10.88.2';
        if (ip.startsWith('10.10.88.')) {
            const parts = ip.split('.');
            if (parts.length === 4) {
                const octet = parseInt(parts[3]);
                if (!isNaN(octet)) usedLastOctets.add(octet);
            }
        }
    });
    
    let nextOctet = 2;
    while (usedLastOctets.has(nextOctet) && nextOctet < 254) {
        nextOctet++;
    }
    return `10.10.88.${nextOctet}`;
}

function getSites() {
    const data = getSitesData();
    return {
        activeSiteId: data.activeSiteId,
        sites: data.sites.map(s => ({
            id: s.id,
            name: s.name,
            host: s.host,
            port: s.port,
            username: s.username,
            hasPassword: !!s.password,
            connectionType: s.connectionType || 'wireguard',
            wireguardIp: s.wireguardIp || s.host || '10.10.88.2',
            wireguardPublicKey: s.wireguardPublicKey || '',
            dnsLoggingEnabled: s.dnsLoggingEnabled !== false
        }))
    };
}

function setActiveSite(siteId) {
    const data = getSitesData();
    const site = data.sites.find(s => s.id === siteId);
    if (!site) throw new Error('Site not found');
    data.activeSiteId = siteId;
    saveSitesData(data);
    return site;
}

function addSite(siteData) {
    const data = getSitesData();
    const id = 'site_' + Date.now();
    const wireguardIp = siteData.wireguardIp || getNextWireGuardIP();
    
    if (siteData.connectionType === 'wireguard' || !siteData.connectionType) {
        const duplicate = data.sites.find(s => (s.wireguardIp === wireguardIp || s.host === wireguardIp));
        if (duplicate) {
            throw new Error(`ไอพี WireGuard (${wireguardIp}) ถูกใช้งานแล้วโดยไซต์งาน "${duplicate.name}" กรุณาใช้ไอพีที่ไม่ซ้ำกัน`);
        }
    }

    const newSite = {
        id,
        name: siteData.name || 'ไซต์งานใหม่',
        host: siteData.host || wireguardIp,
        port: parseInt(siteData.port) || 8728,
        username: siteData.username || 'admin',
        password: siteData.password || '',
        connectionType: siteData.connectionType || 'wireguard',
        wireguardIp: wireguardIp,
        wireguardPublicKey: siteData.wireguardPublicKey || '',
        dnsLoggingEnabled: siteData.dnsLoggingEnabled !== false
    };
    data.sites.push(newSite);
    saveSitesData(data);
    return newSite;
}

function updateSite(id, updateData) {
    const data = getSitesData();
    const index = data.sites.findIndex(s => s.id === id);
    if (index === -1) throw new Error('Site not found');

    const s = data.sites[index];

    if (updateData.wireguardIp && updateData.wireguardIp !== s.wireguardIp) {
        const duplicate = data.sites.find(item => item.id !== id && (item.wireguardIp === updateData.wireguardIp || item.host === updateData.wireguardIp));
        if (duplicate) {
            throw new Error(`ไอพี WireGuard (${updateData.wireguardIp}) ถูกใช้งานแล้วโดยไซต์งาน "${duplicate.name}"`);
        }
    }

    if (updateData.name) s.name = updateData.name;
    if (updateData.host) s.host = updateData.host;
    if (updateData.port) s.port = parseInt(updateData.port) || 8728;
    if (updateData.username) s.username = updateData.username;
    if (updateData.password !== undefined && updateData.password !== '') {
        s.password = updateData.password;
    }
    if (updateData.connectionType) s.connectionType = updateData.connectionType;
    if (updateData.wireguardIp) s.wireguardIp = updateData.wireguardIp;
    if (updateData.wireguardPublicKey) s.wireguardPublicKey = updateData.wireguardPublicKey;
    if (updateData.dnsLoggingEnabled !== undefined) s.dnsLoggingEnabled = !!updateData.dnsLoggingEnabled;

    data.sites[index] = s;
    saveSitesData(data);
    return s;
}


function deleteSite(id) {
    const data = getSitesData();
    if (data.sites.length <= 1) {
        throw new Error('ไม่สามารถลบไซต์งานสุดท้ายในระบบได้');
    }
    const index = data.sites.findIndex(s => s.id === id);
    if (index === -1) throw new Error('Site not found');

    data.sites.splice(index, 1);
    if (data.activeSiteId === id) {
        data.activeSiteId = data.sites[0].id;
    }
    saveSitesData(data);
    return true;
}

function getUsers() {
    try {
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return defaultUsers;
    }
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 4), 'utf8');
}

function addUser(username, password, role, name, assignedSiteId = 'all') {
    const users = getUsers();
    if (users.find(u => u.username.toLowerCase() === username.toLowerCase())) {
        throw new Error('Username already exists');
    }
    const id = Date.now().toString();
    const salt = generateSalt();
    const newUser = {
        id,
        username: username.toLowerCase(),
        salt,
        passwordHash: hashPasswordPBKDF2(password, salt),
        role,
        name,
        assignedSiteId: assignedSiteId || 'all'
    };
    users.push(newUser);
    saveUsers(users);
    return { id, username, role, name, assignedSiteId: newUser.assignedSiteId };
}

function updateUser(id, updateData) {
    const users = getUsers();
    const index = users.findIndex(u => u.id === id);
    if (index === -1) throw new Error('User not found');

    const user = users[index];
    if (updateData.username && updateData.username.toLowerCase() !== user.username) {
        if (users.find(u => u.username.toLowerCase() === updateData.username.toLowerCase() && u.id !== id)) {
            throw new Error('Username already exists');
        }
        user.username = updateData.username.toLowerCase();
    }
    
    if (updateData.password) {
        const salt = generateSalt();
        user.salt = salt;
        user.passwordHash = hashPasswordPBKDF2(updateData.password, salt);
    }
    if (updateData.role) {
        user.role = updateData.role;
    }
    if (updateData.name) {
        user.name = updateData.name;
    }
    if (updateData.assignedSiteId !== undefined) {
        user.assignedSiteId = updateData.assignedSiteId;
    }
    
    users[index] = user;
    saveUsers(users);
    
    return { id: user.id, username: user.username, role: user.role, name: user.name, assignedSiteId: user.assignedSiteId || 'all' };
}

function deleteUser(id) {
    const users = getUsers();
    
    // Prevent deleting the last admin
    const userToDelete = users.find(u => u.id === id);
    if (userToDelete && userToDelete.username === 'admin') {
        throw new Error('Cannot delete default system admin account');
    }
    
    const admins = users.filter(u => u.role === 'admin');
    if (admins.length === 1 && admins[0].id === id) {
        throw new Error('Cannot delete the last administrator account');
    }
    
    const filtered = users.filter(u => u.id !== id);
    if (filtered.length === users.length) throw new Error('User not found');
    
    saveUsers(filtered);
    return true;
}

function authenticateUser(username, password) {
    const users = getUsers();
    const index = users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
    if (index === -1) return null;
    
    const user = users[index];
    let isValid = false;

    if (user.salt) {
        // Modern PBKDF2 check
        isValid = hashPasswordPBKDF2(password, user.salt) === user.passwordHash;
    } else {
        // Legacy SHA256 fallback & Seamless Auto-Migration to PBKDF2
        isValid = hashPasswordLegacy(password) === user.passwordHash;
        if (isValid) {
            const newSalt = generateSalt();
            user.salt = newSalt;
            user.passwordHash = hashPasswordPBKDF2(password, newSalt);
            users[index] = user;
            saveUsers(users);
        }
    }

    if (!isValid) return null;
    
    return {
        id: user.id,
        username: user.username,
        role: user.role,
        name: user.name,
        assignedSiteId: user.assignedSiteId || 'all'
    };
}



const LOGS_FILE = path.join(DB_DIR, 'logs.json');
const HOTSPOT_LOGS_FILE = path.join(DB_DIR, 'hotspot_logs.json');

// Retention constants
const MAX_ADMIN_LOGS = 5000;
const HOTSPOT_LOG_RETENTION_DAYS = 90; // พรบ คอมพิวเตอร์ มาตรา 26

// ==========================================
// Admin Activity Logs
// ==========================================
function getLogs(options = {}) {
    try {
        if (!fs.existsSync(LOGS_FILE)) {
            fs.writeFileSync(LOGS_FILE, '[]', 'utf8');
        }
        let logs = JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));

        // Filter by search keyword
        if (options.search) {
            const q = options.search.toLowerCase();
            logs = logs.filter(l =>
                (l.username || '').toLowerCase().includes(q) ||
                (l.action || '').toLowerCase().includes(q) ||
                (l.details || '').toLowerCase().includes(q)
            );
        }
        // Filter by date range
        if (options.from) {
            const from = new Date(options.from).getTime();
            logs = logs.filter(l => new Date(l.timestamp).getTime() >= from);
        }
        if (options.to) {
            const to = new Date(options.to).getTime();
            logs = logs.filter(l => new Date(l.timestamp).getTime() <= to);
        }

        const total = logs.length;
        // Pagination
        const page = parseInt(options.page) || 1;
        const limit = parseInt(options.limit) || 100;
        const offset = (page - 1) * limit;
        const paginated = logs.slice(offset, offset + limit);

        return { logs: paginated, total, page, limit, pages: Math.ceil(total / limit) };
    } catch (e) {
        return { logs: [], total: 0, page: 1, limit: 100, pages: 0 };
    }
}

function getAllLogsRaw() {
    try {
        if (!fs.existsSync(LOGS_FILE)) return [];
        return JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

function addLog(username, action, details) {
    const logs = getAllLogsRaw();
    const newLog = {
        timestamp: new Date().toISOString(),
        username,
        action,
        details
    };
    logs.unshift(newLog);
    if (logs.length > MAX_ADMIN_LOGS) logs.splice(MAX_ADMIN_LOGS);
    fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 4), 'utf8');
}

// ==========================================
// Hotspot Traffic Logs (พรบ คอมพิวเตอร์ มาตรา 26)
// บันทึก: username, IP, MAC, เวลาเข้า-ออก, traffic
// ==========================================
function getHotspotLogs(options = {}) {
    try {
        if (!fs.existsSync(HOTSPOT_LOGS_FILE)) {
            fs.writeFileSync(HOTSPOT_LOGS_FILE, '[]', 'utf8');
        }
        let logs = JSON.parse(fs.readFileSync(HOTSPOT_LOGS_FILE, 'utf8'));

        // Filter
        if (options.search) {
            const q = options.search.toLowerCase();
            logs = logs.filter(l =>
                (l.username || '').toLowerCase().includes(q) ||
                (l.ipAddress || '').includes(q) ||
                (l.macAddress || '').toLowerCase().includes(q)
            );
        }
        if (options.from) {
            const from = new Date(options.from).getTime();
            logs = logs.filter(l => new Date(l.loginTime).getTime() >= from);
        }
        if (options.to) {
            const to = new Date(options.to).getTime();
            logs = logs.filter(l => new Date(l.loginTime).getTime() <= to);
        }
        if (options.username) {
            logs = logs.filter(l => l.username === options.username);
        }
        if (options.siteName) {
            logs = logs.filter(l => l.siteName === options.siteName);
        }

        const total = logs.length;
        const page = parseInt(options.page) || 1;
        const limit = parseInt(options.limit) || 100;
        const offset = (page - 1) * limit;
        const paginated = logs.slice(offset, offset + limit);

        return { logs: paginated, total, page, limit, pages: Math.ceil(total / limit) };
    } catch (e) {
        return { logs: [], total: 0, page: 1, limit: 100, pages: 0 };
    }
}

function getAllHotspotLogsRaw() {
    try {
        if (!fs.existsSync(HOTSPOT_LOGS_FILE)) return [];
        return JSON.parse(fs.readFileSync(HOTSPOT_LOGS_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

// เพิ่ม session log ใหม่ (เมื่อ user เชื่อมต่อ)
function addHotspotSessionLog(entry) {
    const logs = getAllHotspotLogsRaw();
    const newEntry = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
        loginTime: entry.loginTime || new Date().toISOString(),
        logoutTime: entry.logoutTime || null,
        username: entry.username || '',
        ipAddress: entry.ipAddress || '',
        macAddress: entry.macAddress || '',
        loginBy: entry.loginBy || '',
        uptime: entry.uptime || '',
        bytesIn: entry.bytesIn || 0,
        bytesOut: entry.bytesOut || 0,
        siteName: entry.siteName || '',
        status: entry.status || 'connected' // connected | disconnected
    };
    logs.unshift(newEntry);
    // Purge logs older than 90 days
    const cutoff = Date.now() - (HOTSPOT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const retained = logs.filter(l => new Date(l.loginTime).getTime() >= cutoff);
    fs.writeFileSync(HOTSPOT_LOGS_FILE, JSON.stringify(retained, null, 4), 'utf8');
    return newEntry;
}

// อัปเดต session เมื่อ user disconnect
function updateHotspotSessionLog(sessionId, updateData) {
    const logs = getAllHotspotLogsRaw();
    const index = logs.findIndex(l => l.id === sessionId);
    if (index !== -1) {
        logs[index] = { ...logs[index], ...updateData };
        fs.writeFileSync(HOTSPOT_LOGS_FILE, JSON.stringify(logs, null, 4), 'utf8');
        return logs[index];
    }
    return null;
}

// ล้าง log เก่าเกิน 90 วัน (เรียกได้ตลอด)
function purgeOldHotspotLogs() {
    const logs = getAllHotspotLogsRaw();
    const cutoff = Date.now() - (HOTSPOT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const retained = logs.filter(l => new Date(l.loginTime).getTime() >= cutoff);
    if (retained.length < logs.length) {
        fs.writeFileSync(HOTSPOT_LOGS_FILE, JSON.stringify(retained, null, 4), 'utf8');
    }
    return logs.length - retained.length; // จำนวนที่ถูกลบ
}

// ==========================================
// PPPoE Usage Logs (ห้องเช่า — billing/accounting, no auto-purge)
// ==========================================
const PPPOE_LOGS_FILE = path.join(DB_DIR, 'pppoe_usage_logs.json');

function getAllPppoeUsageLogsRaw() {
    try {
        if (!fs.existsSync(PPPOE_LOGS_FILE)) return [];
        return JSON.parse(fs.readFileSync(PPPOE_LOGS_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

function getPppoeUsageLogs(options = {}) {
    try {
        let logs = getAllPppoeUsageLogsRaw();
        if (options.search) {
            const q = options.search.toLowerCase();
            logs = logs.filter(l =>
                (l.username || '').toLowerCase().includes(q) ||
                (l.ipAddress || '').includes(q)
            );
        }
        if (options.from) {
            const from = new Date(options.from).getTime();
            logs = logs.filter(l => new Date(l.loginTime).getTime() >= from);
        }
        if (options.to) {
            const to = new Date(options.to).getTime();
            logs = logs.filter(l => new Date(l.loginTime).getTime() <= to);
        }
        if (options.username) {
            logs = logs.filter(l => l.username === options.username);
        }
        if (options.siteName) {
            logs = logs.filter(l => l.siteName === options.siteName);
        }
        const total = logs.length;
        const page = parseInt(options.page) || 1;
        const limit = parseInt(options.limit) || 100;
        const offset = (page - 1) * limit;
        const paginated = logs.slice(offset, offset + limit);
        return { logs: paginated, total, page, limit, pages: Math.ceil(total / limit) };
    } catch (e) {
        return { logs: [], total: 0, page: 1, limit: 100, pages: 0 };
    }
}

function addPppoeUsageLog(entry) {
    const logs = getAllPppoeUsageLogsRaw();
    const newEntry = {
        id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
        loginTime: entry.loginTime || new Date().toISOString(),
        logoutTime: entry.logoutTime || null,
        username: entry.username || '',
        ipAddress: entry.ipAddress || '',
        bytesIn: entry.bytesIn || 0,
        bytesOut: entry.bytesOut || 0,
        siteName: entry.siteName || '',
        status: entry.status || 'connected'
    };
    logs.unshift(newEntry);
    // No auto-purge here — billing data, kept indefinitely (unlike hotspot/DNS logs).
    fs.writeFileSync(PPPOE_LOGS_FILE, JSON.stringify(logs, null, 4), 'utf8');
    return newEntry;
}

function getPppoeUsageSummary(month, siteName) {
    const m = /^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7);
    const start = new Date(m + '-01T00:00:00.000Z').getTime();
    const end = new Date(start); end.setUTCMonth(end.getUTCMonth() + 1);
    const endTime = end.getTime();
    const logs = getAllPppoeUsageLogsRaw().filter(l => {
        const t = new Date(l.loginTime).getTime();
        return t >= start && t < endTime && (!siteName || l.siteName === siteName);
    });
    const byRoom = {};
    for (const l of logs) {
        if (!byRoom[l.username]) byRoom[l.username] = { username: l.username, bytesIn: 0, bytesOut: 0 };
        byRoom[l.username].bytesIn += l.bytesIn || 0;
        byRoom[l.username].bytesOut += l.bytesOut || 0;
    }
    return { month: m, rooms: Object.values(byRoom) };
}

// ==========================================
// DNS Query Logs (พรบ คอมพิวเตอร์ มาตรา 26 — domain-level visit history)
// ==========================================
const DNS_LOGS_FILE = path.join(DB_DIR, 'dns_query_logs.json');
const DNS_LOG_RETENTION_DAYS = 90;

function getAllDnsQueryLogsRaw() {
    try {
        if (!fs.existsSync(DNS_LOGS_FILE)) return [];
        return JSON.parse(fs.readFileSync(DNS_LOGS_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

function getDnsQueryLogs(options = {}) {
    try {
        let logs = getAllDnsQueryLogsRaw();

        if (options.search) {
            const q = options.search.toLowerCase();
            logs = logs.filter(l =>
                (l.username || '').toLowerCase().includes(q) ||
                (l.ipAddress || '').includes(q) ||
                (l.macAddress || '').toLowerCase().includes(q) ||
                (l.domain || '').toLowerCase().includes(q)
            );
        }
        if (options.from) {
            const from = new Date(options.from).getTime();
            logs = logs.filter(l => new Date(l.queryTime).getTime() >= from);
        }
        if (options.to) {
            const to = new Date(options.to).getTime();
            logs = logs.filter(l => new Date(l.queryTime).getTime() <= to);
        }
        if (options.username) {
            logs = logs.filter(l => l.username === options.username);
        }
        if (options.siteName) {
            logs = logs.filter(l => l.siteName === options.siteName);
        }

        const total = logs.length;
        const page = parseInt(options.page) || 1;
        const limit = parseInt(options.limit) || 100;
        const offset = (page - 1) * limit;
        const paginated = logs.slice(offset, offset + limit);

        return { logs: paginated, total, page, limit, pages: Math.ceil(total / limit) };
    } catch (e) {
        return { logs: [], total: 0, page: 1, limit: 100, pages: 0 };
    }
}

function addDnsQueryLogsBulk(entries) {
    if (!entries || entries.length === 0) return 0;
    const logs = getAllDnsQueryLogsRaw();
    const newRows = entries.map(entry => ({
        id: Date.now().toString() + Math.random().toString(36).substr(2, 6),
        queryTime: entry.queryTime || new Date().toISOString(),
        username: entry.username || '',
        ipAddress: entry.ipAddress || '',
        macAddress: entry.macAddress || '',
        domain: entry.domain || '',
        siteName: entry.siteName || ''
    }));
    const combined = newRows.concat(logs);
    const cutoff = Date.now() - (DNS_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const retained = combined.filter(l => new Date(l.queryTime).getTime() >= cutoff);
    fs.writeFileSync(DNS_LOGS_FILE, JSON.stringify(retained, null, 4), 'utf8');
    return newRows.length;
}

function purgeOldDnsQueryLogs() {
    const logs = getAllDnsQueryLogsRaw();
    const cutoff = Date.now() - (DNS_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const retained = logs.filter(l => new Date(l.queryTime).getTime() >= cutoff);
    if (retained.length < logs.length) {
        fs.writeFileSync(DNS_LOGS_FILE, JSON.stringify(retained, null, 4), 'utf8');
    }
    return logs.length - retained.length;
}

const SETTINGS_FILE = path.join(DB_DIR, 'settings.json');

function getAutoCleanupConfig() {
    try {
        if (!fs.existsSync(SETTINGS_FILE)) {
            const defaultConfig = { autoCleanupExpired: false, cleanupIntervalMinutes: 60 };
            fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultConfig, null, 4), 'utf8');
            return defaultConfig;
        }
        const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return { autoCleanupExpired: false, cleanupIntervalMinutes: 60 };
    }
}

function saveAutoCleanupConfig(config) {
    const current = getAutoCleanupConfig();
    const updated = { ...current, ...config };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 4), 'utf8');
    return updated;
}

// ==========================================
// Menu Permissions (which nav items co-admin/user can see)
// admin always sees everything — not configurable, not stored here.
// ==========================================
const MENU_PERMISSIONS_FILE = path.join(DB_DIR, 'menu_permissions.json');
const DEFAULT_MENU_PERMISSIONS = {
    'co-admin': ['hotspot', 'pppoe', 'firewall', 'logs'],
    'user': ['hotspot', 'firewall']
};

function getMenuPermissions() {
    try {
        if (!fs.existsSync(MENU_PERMISSIONS_FILE)) return { ...DEFAULT_MENU_PERMISSIONS };
        return JSON.parse(fs.readFileSync(MENU_PERMISSIONS_FILE, 'utf8'));
    } catch (e) {
        return { ...DEFAULT_MENU_PERMISSIONS };
    }
}

function saveMenuPermissions(config) {
    const updated = {
        'co-admin': Array.isArray(config['co-admin']) ? config['co-admin'] : [],
        'user': Array.isArray(config['user']) ? config['user'] : []
    };
    fs.writeFileSync(MENU_PERMISSIONS_FILE, JSON.stringify(updated, null, 4), 'utf8');
    return updated;
}

module.exports = {
    getConfig,
    saveConfig,
    getSites,
    setActiveSite,
    addSite,
    updateSite,
    deleteSite,
    getUsers,
    addUser,
    updateUser,
    deleteUser,
    authenticateUser,
    getLogs,
    getAllLogsRaw,
    addLog,
    getHotspotLogs,
    getAllHotspotLogsRaw,
    addHotspotSessionLog,
    updateHotspotSessionLog,
    purgeOldHotspotLogs,
    getDnsQueryLogs,
    getAllDnsQueryLogsRaw,
    addDnsQueryLogsBulk,
    purgeOldDnsQueryLogs,
    getPppoeUsageLogs,
    getAllPppoeUsageLogsRaw,
    addPppoeUsageLog,
    getPppoeUsageSummary,
    getAutoCleanupConfig,
    saveAutoCleanupConfig,
    getMenuPermissions,
    saveMenuPermissions
};

