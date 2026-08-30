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
    const targetIdStr = String(targetId || '').trim();
    const site = data.sites.find(s =>
        s.id === targetIdStr || s.name === targetIdStr ||
        (s.id && s.id.toLowerCase() === targetIdStr.toLowerCase()) ||
        (s.name && s.name.toLowerCase() === targetIdStr.toLowerCase())
    ) || data.sites.find(s => s.id === data.activeSiteId) || data.sites[0] || {};
    const host = site.host || site.wireguardIp || '';
    return {
        id: site.id,
        name: site.name,
        host: host,
        port: parseInt(site.port) || 8728,
        username: site.username || 'admin',
        password: site.password || '',
        connectionType: site.connectionType || 'wireguard',
        wireguardIp: site.wireguardIp || ''
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




// ==========================================================================
// ช่วงวันที่ของตัวกรอง log — ตีความเป็น "วันตามปฏิทินไทย" ไม่ใช่ UTC
//
// บั๊กเดิม: `new Date('2026-08-27').toISOString()` ได้ '2026-08-27T00:00:00Z'
// พอเอาไปใช้กับ lte จึงตัดทั้งวันที่ 27 ทิ้ง เหลือเฉพาะแถวที่ตรงเที่ยงคืนพอดี
// ผลคือกรอง "ตั้งแต่ 27 ถึง 27" ได้ 0 แถวเสมอ และช่วงวันใด ๆ จะขาดวันสุดท้ายไป
//
// อีกชั้นหนึ่ง: log เก็บเป็น UTC แต่ผู้ใช้คิดเป็นเวลาไทย (UTC+7 ไม่มี DST)
// วันที่ 27 ตามเวลาไทย = 2026-08-26T17:00:00Z ถึง 2026-08-27T16:59:59.999Z
// สำคัญกับ พรบ. ม.26 เพราะไฟล์ปิดผนึกรายวันต้องตรงกับวันตามปฏิทินจริง
// ==========================================================================
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

function dayStartUtc(dateStr) {
    // ต้นวันตามเวลาไทย -> UTC
    return new Date(new Date(dateStr + 'T00:00:00.000Z').getTime() - BANGKOK_OFFSET_MS);
}

function dayEndUtc(dateStr) {
    // ปลายวันตามเวลาไทย -> UTC
    return new Date(new Date(dateStr + 'T23:59:59.999Z').getTime() - BANGKOK_OFFSET_MS);
}

// รับได้ทั้ง 'YYYY-MM-DD' และ timestamp เต็ม — ถ้าเป็น timestamp เต็มให้ใช้ตามที่ส่งมา
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function rangeStart(v) {
    return DATE_ONLY.test(String(v)) ? dayStartUtc(v) : new Date(v);
}

function rangeEnd(v) {
    return DATE_ONLY.test(String(v)) ? dayEndUtc(v) : new Date(v);
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
            const from = rangeStart(options.from).getTime();
            logs = logs.filter(l => new Date(l.timestamp).getTime() >= from);
        }
        if (options.to) {
            const to = rangeEnd(options.to).getTime();
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
            const from = rangeStart(options.from).getTime();
            logs = logs.filter(l => new Date(l.loginTime).getTime() >= from);
        }
        if (options.to) {
            const to = rangeEnd(options.to).getTime();
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
            const from = rangeStart(options.from).getTime();
            logs = logs.filter(l => new Date(l.loginTime).getTime() >= from);
        }
        if (options.to) {
            const to = rangeEnd(options.to).getTime();
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
            const from = rangeStart(options.from).getTime();
            logs = logs.filter(l => new Date(l.queryTime).getTime() >= from);
        }
        if (options.to) {
            const to = rangeEnd(options.to).getTime();
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
    'co-admin': ['hotspot', 'pppoe', 'multiwan', 'firewall', 'logs'],
    'user': ['hotspot', 'firewall']
};

function getMenuPermissions() {
    try {
        if (!fs.existsSync(MENU_PERMISSIONS_FILE)) return { ...DEFAULT_MENU_PERMISSIONS };
        const data = JSON.parse(fs.readFileSync(MENU_PERMISSIONS_FILE, 'utf8'));
        if (data['co-admin'] && !data['co-admin'].includes('multiwan')) {
            data['co-admin'].push('multiwan');
        }
        return data;
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

const MULTIWAN_FILE = path.join(__dirname, 'db', 'multiwan.json');

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
        alertOnline: true,
        alertStorage: true
    };
}

function getTelegramAlertConfig() {
    try {
        if (!fs.existsSync(SETTINGS_FILE)) return _defaultTelegramAlertConfig();
        const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        const cfg = data.telegram_alert_config;
        if (cfg) {
            return {
                enabled: !!cfg.enabled,
                botToken: cfg.botToken || '',
                chatId: cfg.chatId || '',
                alertOffline: cfg.alertOffline !== false,
                alertOnline: cfg.alertOnline !== false,
                alertStorage: cfg.alertStorage !== false
            };
        }
        // ยังไม่เคยตั้งค่า — ยืมค่าจากหน้า Multi-WAN มาเป็นค่าเริ่มต้น แต่ยังไม่เปิดใช้งาน
        const mw = getMultiWanConfig();
        const d = _defaultTelegramAlertConfig();
        d.botToken = (mw && mw.telegramToken) || '';
        d.chatId = (mw && mw.telegramChatId) || '';
        return d;
    } catch (e) {
        return _defaultTelegramAlertConfig();
    }
}

function saveTelegramAlertConfig(config) {
    try {
        const current = getTelegramAlertConfig();
        let data = {};
        if (fs.existsSync(SETTINGS_FILE)) data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        const updated = {
            enabled: config.enabled !== undefined ? !!config.enabled : current.enabled,
            botToken: config.botToken !== undefined ? String(config.botToken).trim() : current.botToken,
            chatId: config.chatId !== undefined ? String(config.chatId).trim() : current.chatId,
            alertOffline: config.alertOffline !== undefined ? !!config.alertOffline : current.alertOffline,
            alertOnline: config.alertOnline !== undefined ? !!config.alertOnline : current.alertOnline,
            alertStorage: config.alertStorage !== undefined ? !!config.alertStorage : current.alertStorage
        };
        data.telegram_alert_config = updated;
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
        return updated;
    } catch (e) {
        throw e;
    }
}

function getMultiWanConfig(siteId) {
    try {
        if (!fs.existsSync(MULTIWAN_FILE)) fs.writeFileSync(MULTIWAN_FILE, '{}', 'utf8');
        const fileData = JSON.parse(fs.readFileSync(MULTIWAN_FILE, 'utf8'));
        const key = siteId || 'default';
        const data = fileData[key];
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

function saveMultiWanConfig(siteId, config) {
    if (!fs.existsSync(MULTIWAN_FILE)) fs.writeFileSync(MULTIWAN_FILE, '{}', 'utf8');
    const data = JSON.parse(fs.readFileSync(MULTIWAN_FILE, 'utf8'));
    const key = siteId || 'default';
    const current = getMultiWanConfig(siteId);
    data[key] = Object.assign({}, current, config);
    fs.writeFileSync(MULTIWAN_FILE, JSON.stringify(data, null, 4), 'utf8');
    return data[key];
}

// ==========================================
// Archived / Deleted Hotspot Users
// ==========================================
const ARCHIVED_HOTSPOT_USERS_FILE = path.join(DB_DIR, 'archived_hotspot_users.json');

function getArchivedHotspotUsers(options = {}) {
    try {
        if (!fs.existsSync(ARCHIVED_HOTSPOT_USERS_FILE)) {
            fs.writeFileSync(ARCHIVED_HOTSPOT_USERS_FILE, '[]', 'utf8');
        }
        let list = JSON.parse(fs.readFileSync(ARCHIVED_HOTSPOT_USERS_FILE, 'utf8'));

        if (options.siteName) {
            list = list.filter(u => u.siteName === options.siteName);
        }
        if (options.search) {
            const q = options.search.toLowerCase();
            list = list.filter(u =>
                (u.username || '').toLowerCase().includes(q) ||
                (u.comment || '').toLowerCase().includes(q) ||
                (u.profile || '').toLowerCase().includes(q)
            );
        }
        list.sort((a, b) => new Date(b.deletedAt || b.expiredAt) - new Date(a.deletedAt || a.expiredAt));

        const total = list.length;
        const page = parseInt(options.page) || 1;
        const limit = parseInt(options.limit) || 100;
        const offset = (page - 1) * limit;
        const paginated = list.slice(offset, offset + limit);

        return {
            users: paginated,
            total,
            page,
            limit,
            pages: Math.ceil(total / limit) || 1
        };
    } catch (e) {
        return { users: [], total: 0, page: 1, limit: 100, pages: 1 };
    }
}

function archiveDeletedHotspotUser(entry) {
    try {
        if (!fs.existsSync(ARCHIVED_HOTSPOT_USERS_FILE)) {
            fs.writeFileSync(ARCHIVED_HOTSPOT_USERS_FILE, '[]', 'utf8');
        }
        const list = JSON.parse(fs.readFileSync(ARCHIVED_HOTSPOT_USERS_FILE, 'utf8'));
        const item = {
            id: Date.now().toString() + Math.random().toString(36).substring(2, 7),
            username: entry.username || entry.name || '',
            password: entry.password || '',
            profile: entry.profile || 'default',
            limitUptime: entry.limitUptime || '',
            limitBytesTotal: parseInt(entry.limitBytesTotal) || 0,
            comment: entry.comment || '',
            siteName: entry.siteName || '',
            expiredAt: entry.expiredAt || new Date().toISOString(),
            deletedAt: new Date().toISOString(),
            deletedBy: entry.deletedBy || 'System',
            reason: entry.reason || 'manual_delete'
        };
        list.unshift(item);
        if (list.length > 2000) list.length = 2000;
        fs.writeFileSync(ARCHIVED_HOTSPOT_USERS_FILE, JSON.stringify(list, null, 4), 'utf8');
        return item;
    } catch (e) {
        console.error('Failed to archive deleted hotspot user:', e);
        return null;
    }
}

function archiveDeletedHotspotUsersBulk(entries) {
    try {
        if (!entries || !entries.length) return 0;
        if (!fs.existsSync(ARCHIVED_HOTSPOT_USERS_FILE)) {
            fs.writeFileSync(ARCHIVED_HOTSPOT_USERS_FILE, '[]', 'utf8');
        }
        let list = JSON.parse(fs.readFileSync(ARCHIVED_HOTSPOT_USERS_FILE, 'utf8'));
        const newItems = entries.map(entry => ({
            id: Date.now().toString() + Math.random().toString(36).substring(2, 7),
            username: entry.username || entry.name || '',
            password: entry.password || '',
            profile: entry.profile || 'default',
            limitUptime: entry.limitUptime || '',
            limitBytesTotal: parseInt(entry.limitBytesTotal) || 0,
            comment: entry.comment || '',
            siteName: entry.siteName || '',
            expiredAt: entry.expiredAt || new Date().toISOString(),
            deletedAt: new Date().toISOString(),
            deletedBy: entry.deletedBy || 'System Auto',
            reason: entry.reason || 'auto_cleanup'
        }));
        list = [...newItems, ...list];
        if (list.length > 2000) list.length = 2000;
        fs.writeFileSync(ARCHIVED_HOTSPOT_USERS_FILE, JSON.stringify(list, null, 4), 'utf8');
        return newItems.length;
    } catch (e) {
        console.error('Failed to bulk archive deleted hotspot users:', e);
        return 0;
    }
}

function deleteArchivedHotspotUser(id) {
    try {
        if (!fs.existsSync(ARCHIVED_HOTSPOT_USERS_FILE)) return false;
        let list = JSON.parse(fs.readFileSync(ARCHIVED_HOTSPOT_USERS_FILE, 'utf8'));
        const lenBefore = list.length;
        list = list.filter(item => item.id !== id);
        if (list.length < lenBefore) {
            fs.writeFileSync(ARCHIVED_HOTSPOT_USERS_FILE, JSON.stringify(list, null, 4), 'utf8');
            return true;
        }
        return false;
    } catch (e) { return false; }
}

function clearArchivedHotspotUsers(siteName) {
    try {
        if (!fs.existsSync(ARCHIVED_HOTSPOT_USERS_FILE)) return 0;
        let list = JSON.parse(fs.readFileSync(ARCHIVED_HOTSPOT_USERS_FILE, 'utf8'));
        const initial = list.length;
        if (siteName) {
            list = list.filter(item => item.siteName !== siteName && item.site_name !== siteName);
        } else {
            list = [];
        }
        fs.writeFileSync(ARCHIVED_HOTSPOT_USERS_FILE, JSON.stringify(list, null, 4), 'utf8');
        return initial - list.length;
    } catch (e) { return 0; }
}


// ==========================================
// LOG ARCHIVES (พรบ. ม.26 — ไฟล์ปิดผนึกรายวัน + SHA-256)
// ต้องมี signature และ return shape ตรงกับ db-supabase.js เป๊ะ ๆ
// ==========================================
const LOG_ARCHIVES_FILE = path.join(DB_DIR, 'log_archives.json');

function _readArchives() {
    try {
        if (!fs.existsSync(LOG_ARCHIVES_FILE)) return [];
        const d = JSON.parse(fs.readFileSync(LOG_ARCHIVES_FILE, 'utf8'));
        return Array.isArray(d) ? d : [];
    } catch (e) {
        return [];
    }
}

function getLogArchives(options) {
    options = options || {};
    try {
        let list = _readArchives();
        if (options.logType) list = list.filter(a => a.logType === options.logType);
        if (options.from) list = list.filter(a => a.archiveDate >= options.from);
        if (options.to) list = list.filter(a => a.archiveDate <= options.to);
        list.sort((a, b) => (a.archiveDate === b.archiveDate
            ? String(a.logType).localeCompare(String(b.logType))
            : String(b.archiveDate).localeCompare(String(a.archiveDate))));

        const page = parseInt(options.page) || 1;
        const limit = parseInt(options.limit) || 100;
        const total = list.length;
        return {
            archives: list.slice((page - 1) * limit, page * limit),
            total,
            page,
            limit,
            pages: Math.ceil(total / limit) || 1
        };
    } catch (e) {
        return { archives: [], total: 0, page: 1, limit: 100, pages: 0, error: e.message };
    }
}

function getLogArchive(id) {
    return _readArchives().find(a => a.id === id) || null;
}

function saveLogArchive(rec) {
    const list = _readArchives();
    const row = {
        id: rec.id,
        archiveDate: rec.archiveDate,
        logType: rec.logType,
        siteName: rec.siteName || 'ALL',
        recordCount: rec.recordCount || 0,
        fileName: rec.fileName,
        fileSize: rec.fileSize || 0,
        sha256: rec.sha256,
        storageR2Key: rec.storageR2Key || null,
        storageLocal: rec.storageLocal || null,
        createdAt: new Date().toISOString(),
        createdBy: rec.createdBy || 'System Auto'
    };
    const i = list.findIndex(a => a.id === row.id);
    if (i >= 0) list[i] = row; else list.push(row);
    fs.writeFileSync(LOG_ARCHIVES_FILE, JSON.stringify(list, null, 2), 'utf8');
    return row;
}


// ==========================================================================
// สถิติปริมาณข้อมูล — คู่ขนานกับ getStorageStats ใน db-supabase.js
//
// โหมด JSON ได้เปรียบตรงที่วัดขนาดไฟล์จริงบนดิสก์ได้เลย ไม่ต้องประมาณ
// เหมือนฝั่ง Supabase ที่ต้องสุ่มวัดขนาดแถว — ค่า estimatedBytes ที่นี่จึงแม่นจริง
//
// ชื่อฟิลด์ฝั่ง JSON เป็น camelCase (queryTime/loginTime) ต่างจาก Postgres
// ที่เป็น snake_case จึงรับได้หลายชื่อ เพื่อให้ผลลัพธ์ออกมาหน้าตาเดียวกัน
// ==========================================================================
const STORAGE_TABLES = [
    { table: 'dns_query_logs', label: 'ประวัติเข้าเว็บ (DNS)', file: DNS_LOGS_FILE, timeFields: ['queryTime', 'query_time'], retentionDays: DNS_LOG_RETENTION_DAYS, law: 'ม.26' },
    { table: 'hotspot_logs', label: 'ประวัติใช้งาน Hotspot', file: HOTSPOT_LOGS_FILE, timeFields: ['loginTime', 'login_time'], retentionDays: HOTSPOT_LOG_RETENTION_DAYS, law: 'ม.26' },
    { table: 'pppoe_usage_logs', label: 'ประวัติใช้งาน PPPoE (บิล)', file: PPPOE_LOGS_FILE, timeFields: ['loginTime', 'login_time'], retentionDays: null, law: null },
    { table: 'archived_hotspot_users', label: 'ผู้ใช้ Hotspot ที่ถูกลบ', file: ARCHIVED_HOTSPOT_USERS_FILE, timeFields: ['deletedAt', 'deleted_at'], retentionDays: null, law: null },
    { table: 'activity_logs', label: 'ประวัติการใช้งานระบบ', file: LOGS_FILE, timeFields: ['createdAt', 'created_at', 'timestamp'], retentionDays: null, law: null },
    { table: 'log_archives', label: 'ทะเบียนไฟล์ปิดผนึก', file: LOG_ARCHIVES_FILE, timeFields: ['createdAt', 'created_at'], retentionDays: null, law: null }
];

function pickTime(row, fields) {
    for (const f of fields) {
        if (row && row[f]) return row[f];
    }
    return null;
}

function pickSite(row) {
    return (row && (row.siteName || row.site_name)) || '';
}

async function getStorageStats() {
    const sitesData = await getSites();
    const siteNames = ((sitesData && sitesData.sites) || []).map(s => s.name);

    const tables = STORAGE_TABLES.map((def) => {
        try {
            let rows = [];
            let fileBytes = 0;
            if (fs.existsSync(def.file)) {
                fileBytes = fs.statSync(def.file).size;
                const parsed = JSON.parse(fs.readFileSync(def.file, 'utf8'));
                rows = Array.isArray(parsed) ? parsed : [];
            }

            const times = rows.map(r => pickTime(r, def.timeFields)).filter(Boolean)
                .map(t => new Date(t).getTime()).filter(n => !isNaN(n));
            const oldest = times.length ? new Date(Math.min(...times)).toISOString() : null;
            const newest = times.length ? new Date(Math.max(...times)).toISOString() : null;

            // อัตราโตต่อวัน — ตัวเลขที่ใช้ตัดสินใจได้จริง ต่างจากยอดรวมที่บอกแค่ปัจจุบัน
            const dayAgoMs = Date.now() - 86400000;
            const rowsLast24h = times.filter((t) => t >= dayAgoMs).length;

            const oldestAgeDays = oldest
                ? Math.floor((Date.now() - new Date(oldest).getTime()) / 86400000)
                : null;
            let retentionOk = true;
            if (def.retentionDays && oldestAgeDays !== null) {
                // เผื่อ 2 วัน เพราะ purge ทำงานรอบกลางคืน ไม่ได้ลบทันทีเมื่อครบกำหนดพอดี
                retentionOk = oldestAgeDays <= def.retentionDays + 2;
            }

            let bySite = null;
            const hasSite = rows.some(r => pickSite(r));
            if (hasSite) {
                const counts = new Map();
                rows.forEach((r) => {
                    const n = pickSite(r) || '(ไม่ระบุสาขา)';
                    counts.set(n, (counts.get(n) || 0) + 1);
                });
                bySite = [...counts.entries()]
                    .map(([siteName, n]) => ({
                        siteName,
                        rows: n,
                        // ชื่อที่ไม่อยู่ในทะเบียนสาขาแล้ว = ข้อมูลเก่าจากตอนที่ยังใช้ชื่อเดิม
                        unmatched: !siteNames.includes(siteName)
                    }))
                    .sort((a, b) => b.rows - a.rows);
            }

            return {
                table: def.table, label: def.label, law: def.law,
                rows: rows.length, oldest, newest, oldestAgeDays,
                retentionDays: def.retentionDays, retentionOk,
                avgRowBytes: rows.length ? Math.round(fileBytes / rows.length) : 0,
                estimatedBytes: fileBytes,
                exactSize: true,
                rowsLast24h,
                projectedBytes: def.retentionDays && rows.length
                    ? rowsLast24h * def.retentionDays * Math.round(fileBytes / rows.length)
                    : null,
                bySite
            };
        } catch (e) {
            return { table: def.table, label: def.label, error: e.message, rows: 0, estimatedBytes: 0 };
        }
    });

    return {
        backend: 'json',
        generatedAt: new Date().toISOString(),
        tables,
        totalRows: tables.reduce((a, t) => a + (t.rows || 0), 0),
        estimatedBytes: tables.reduce((a, t) => a + (t.estimatedBytes || 0), 0)
    };
}

// หมายเหตุ (2026-08-29): ตรงนี้เคยมี module.exports ซ้ำอีกชุดหนึ่ง ซึ่งถูกชุดท้ายไฟล์
// ทับทั้งก้อนอยู่แล้ว จึงเป็นโค้ดตายมานาน — เพิ่งรู้ตอนเพิ่ม getStorageStats แล้วเรียกไม่เจอ
// เพราะไปเพิ่มในชุดที่ตายแล้ว ตัวตรวจ parity ก็อ่านชุดแรกจึงบอกว่าผ่านทั้งที่ใช้งานไม่ได้
// ลบทิ้งเพื่อให้เหลือ module.exports จุดเดียวที่ท้ายไฟล์ (ดู scripts/check-db-parity.js
// ที่ตอนนี้ดักกรณีมี module.exports ซ้ำแล้ว)

function getLineDigestConfig(siteId) {
    try {
        const sitesData = getSitesData();
        const activeId = sitesData.activeSiteId || (sitesData.sites && sitesData.sites[0] && sitesData.sites[0].id) || 'default';
        const targetSiteId = siteId || activeId;
        const siteCount = (sitesData.sites && sitesData.sites.length) || 0;

        const EMPTY = {
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

        if (!fs.existsSync(SETTINGS_FILE)) return EMPTY;
        const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
        const siteConfig = data[`line_digest_${targetSiteId}`];

        // สาขาที่มี config ของตัวเอง ใช้ค่าของตัวเองล้วน ๆ ห้ามยืมจาก config กลาง
        // (ต้องตรงกับ db-supabase.js — ดูคำอธิบายบั๊ก 2026-08-28 ที่นั่น)
        if (siteConfig) {
            return {
                siteId: targetSiteId,
                enabled: !!siteConfig.enabled,
                channelAccessToken: siteConfig.channelAccessToken || siteConfig.lineNotifyToken || '',
                channelSecret: siteConfig.channelSecret || '',
                targetId: siteConfig.targetId || '',
                digestTime: siteConfig.digestTime || '09:00',
                includeHotspot: siteConfig.includeHotspot !== false,
                includePppoe: siteConfig.includePppoe !== false,
                lastSentDate: siteConfig.lastSentDate || ''
            };
        }

        // ไม่มี config ของตัวเอง — อ่านค่ากลางได้เฉพาะตอนที่ยังเป็นระบบสาขาเดียว
        const isSingleSiteLegacy = targetSiteId === 'default' || siteCount <= 1;
        if (isSingleSiteLegacy) {
            const primary = data['line_digest_default'] || {};
            return {
                siteId: targetSiteId,
                enabled: data.lineDigestEnabled !== undefined ? !!data.lineDigestEnabled : !!primary.enabled,
                channelAccessToken: data.lineChannelAccessToken || data.lineNotifyToken || primary.channelAccessToken || '',
                channelSecret: data.lineChannelSecret || primary.channelSecret || '',
                targetId: data.lineTargetId || primary.targetId || '',
                digestTime: data.lineDigestTime || primary.digestTime || '09:00',
                includeHotspot: primary.includeHotspot !== false,
                includePppoe: primary.includePppoe !== false,
                lastSentDate: primary.lastSentDate || ''
            };
        }

        // ระบบหลายสาขา + สาขานี้ยังไม่ได้ตั้งค่า = ปิดสนิท
        return EMPTY;
    } catch (e) {
        return {
            siteId: siteId || 'default',
            enabled: false,
            channelAccessToken: '',
            channelSecret: '',
            targetId: '',
            digestTime: '09:00',
            includeHotspot: true,
            includePppoe: true,
            lastSentDate: ''
        };
    }
}

function saveLineDigestConfig(config, siteId) {
    const sitesData = getSitesData();
    const activeId = sitesData.activeSiteId || (sitesData.sites && sitesData.sites[0] && sitesData.sites[0].id) || 'default';
    const targetSiteId = siteId || config.siteId || activeId;
    
    let allData = {};
    if (fs.existsSync(SETTINGS_FILE)) {
        try { allData = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) {}
    }
    
    const siteConfigKey = `line_digest_${targetSiteId}`;
    const currentSiteConfig = getLineDigestConfig(targetSiteId);
    const finalConfig = Object.assign({}, config);

    const updatedSiteConfig = {
        enabled: finalConfig.enabled !== undefined ? !!finalConfig.enabled : currentSiteConfig.enabled,
        channelAccessToken: finalConfig.channelAccessToken !== undefined ? finalConfig.channelAccessToken : currentSiteConfig.channelAccessToken,
        channelSecret: finalConfig.channelSecret !== undefined ? finalConfig.channelSecret : currentSiteConfig.channelSecret,
        targetId: finalConfig.targetId !== undefined ? finalConfig.targetId : currentSiteConfig.targetId,
        digestTime: finalConfig.digestTime || currentSiteConfig.digestTime,
        includeHotspot: finalConfig.includeHotspot !== undefined ? finalConfig.includeHotspot !== false : currentSiteConfig.includeHotspot,
        includePppoe: finalConfig.includePppoe !== undefined ? finalConfig.includePppoe !== false : currentSiteConfig.includePppoe,
        lastSentDate: finalConfig.lastSentDate !== undefined ? finalConfig.lastSentDate : currentSiteConfig.lastSentDate
    };

    allData[siteConfigKey] = updatedSiteConfig;

    const firstSiteId = (sitesData.sites && sitesData.sites[0] && sitesData.sites[0].id) || 'default';
    if (targetSiteId === 'default' || targetSiteId === firstSiteId) {
        allData.lineDigestEnabled = updatedSiteConfig.enabled;
        allData.lineChannelAccessToken = updatedSiteConfig.channelAccessToken;
        allData.lineChannelSecret = updatedSiteConfig.channelSecret;
        allData.lineTargetId = updatedSiteConfig.targetId;
        allData.lineDigestTime = updatedSiteConfig.digestTime;
        allData.lineDigestLastSentDate = updatedSiteConfig.lastSentDate;
    }

    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(allData, null, 4), 'utf8');
    return getLineDigestConfig(targetSiteId);
}

// ==========================================
// LINE User Account Bindings
// ==========================================
const LINE_USER_BINDINGS_FILE = path.join(DB_DIR, 'line_user_bindings.json');

function getLineUserBinding(lineUserId) {
    try {
        if (!fs.existsSync(LINE_USER_BINDINGS_FILE)) return null;
        const list = JSON.parse(fs.readFileSync(LINE_USER_BINDINGS_FILE, 'utf8'));
        return list.find(item => item.lineUserId === lineUserId) || null;
    } catch (e) {
        return null;
    }
}

function bindLineUser(lineUserId, username, siteId = null, siteName = 'Default') {
    try {
        if (!fs.existsSync(LINE_USER_BINDINGS_FILE)) {
            fs.writeFileSync(LINE_USER_BINDINGS_FILE, '[]', 'utf8');
        }
        let list = JSON.parse(fs.readFileSync(LINE_USER_BINDINGS_FILE, 'utf8'));
        list = list.filter(item => item.lineUserId !== lineUserId);
        const item = {
            lineUserId,
            username,
            siteId: siteId || 'default',
            siteName: siteName || 'Default',
            linkedAt: new Date().toISOString()
        };
        list.push(item);
        fs.writeFileSync(LINE_USER_BINDINGS_FILE, JSON.stringify(list, null, 4), 'utf8');
        return item;
    } catch (e) {
        return null;
    }
}


function unbindLineUser(lineUserId) {
    try {
        if (!fs.existsSync(LINE_USER_BINDINGS_FILE)) return false;
        let list = JSON.parse(fs.readFileSync(LINE_USER_BINDINGS_FILE, 'utf8'));
        const initLen = list.length;
        list = list.filter(item => item.lineUserId !== lineUserId);
        if (list.length < initLen) {
            fs.writeFileSync(LINE_USER_BINDINGS_FILE, JSON.stringify(list, null, 4), 'utf8');
            return true;
        }
        return false;
    } catch (e) { return false; }
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
    saveMenuPermissions,
    getMultiWanConfig,
    saveMultiWanConfig,
    getArchivedHotspotUsers,
    archiveDeletedHotspotUser,
    archiveDeletedHotspotUsersBulk,
    deleteArchivedHotspotUser,
    clearArchivedHotspotUsers,
    getLineDigestConfig,
    saveLineDigestConfig,
    getLineUserBinding,
    bindLineUser,
    unbindLineUser,
    getTelegramAlertConfig,
    saveTelegramAlertConfig,
    getLogArchives,
    getLogArchive,
    saveLogArchive,
    getStorageStats
};




