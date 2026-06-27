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
    const usedLastOctets = data.sites
        .map(s => s.wireguardIp)
        .filter(Boolean)
        .map(ip => parseInt(ip.split('.')[3]))
        .filter(n => !isNaN(n));
    
    let nextOctet = 2; // start from 10.10.88.2 (10.10.88.1 is VPS)
    while (usedLastOctets.includes(nextOctet) && nextOctet < 254) {
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
            wireguardIp: s.wireguardIp || '10.10.88.2',
            wireguardPublicKey: s.wireguardPublicKey || ''
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
    const newSite = {
        id,
        name: siteData.name || 'ไซต์งานใหม่',
        host: siteData.host || wireguardIp,
        port: parseInt(siteData.port) || 8728,
        username: siteData.username || 'admin',
        password: siteData.password || '',
        connectionType: siteData.connectionType || 'wireguard',
        wireguardIp: wireguardIp,
        wireguardPublicKey: siteData.wireguardPublicKey || ''
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

function getLogs() {
    try {
        if (!fs.existsSync(LOGS_FILE)) {
            fs.writeFileSync(LOGS_FILE, '[]', 'utf8');
        }
        const data = fs.readFileSync(LOGS_FILE, 'utf8');
        return JSON.parse(data);
    } catch (e) {
        return [];
    }
}

function addLog(username, action, details) {
    const logs = getLogs();
    const newLog = {
        timestamp: new Date().toISOString(),
        username,
        action,
        details
    };
    logs.unshift(newLog); // New logs first
    if (logs.length > 1000) logs.pop(); // Keep max 1000 logs
    fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 4), 'utf8');
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
    addLog,
    getAutoCleanupConfig,
    saveAutoCleanupConfig
};

