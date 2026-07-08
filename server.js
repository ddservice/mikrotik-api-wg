const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// Auto-select database: Supabase (if env set) หรือ JSON file (legacy)
const db = process.env.SUPABASE_URL
    ? require('./db-supabase')
    : require('./db');

console.log(`[DB] Using: ${process.env.SUPABASE_URL ? 'Supabase (PostgreSQL)' : 'Local JSON files'}`);

const RouterOSClient = require('./routeros');

// ==========================================
// P2 SECURITY: Rate Limiting
// ==========================================
let rateLimit;
try {
    rateLimit = require('express-rate-limit');
} catch (e) {
    // Fallback: ถ้ายังไม่ได้ติดตั้ง package ให้รัน: npm install express-rate-limit
    console.warn('[Security] express-rate-limit not installed — rate limiting disabled');
    rateLimit = () => (req, res, next) => next(); // no-op middleware
}

// Rate limit สำหรับ Login: 5 ครั้ง ใน 15 นาที (ป้องกัน brute-force)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 นาที
    max: 5,                     // สูงสุด 5 ครั้ง
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'พยายามเข้าระบบมากเกินไป โปรดรอ 15 นาทีแล้วลองใหม่ (Too many login attempts)',
        retryAfter: 900
    },
    handler: (req, res, next, options) => {
        const ip = req.ip || req.connection.remoteAddress;
        db.addLog('System Security', 'Rate Limit ล็อก Login', `IP ${ip} พยายาม login เกินสิทธิ์`);
        res.status(429).json(options.message);
    },
    skip: (req) => {
        // ไม่นับ localhost ใน development
        const ip = req.ip || '';
        return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    }
});

// Rate limit ทั่วไปสำหรับ API: 200 ครั้ง ใน 1 นาที
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,       // 1 นาที
    max: 200,                  // สูงสุด 200 request
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'ส่ง request มากเกินไป โปรดรอสักครู่ (Rate limit exceeded)' },
    skip: (req) => {
        const ip = req.ip || '';
        return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    }
});


const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// P2 SECURITY: CORS — ล็อก origin ที่อนุญาต
// ตั้งค่าผ่าน env: ALLOWED_ORIGINS=https://yourdomain.com,https://other.com
// ==========================================
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

// เพิ่ม localhost เสมอเพื่อ development
const devOrigins = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost',
    'http://127.0.0.1'
];

const corsOptions = {
    origin: (origin, callback) => {
        // อนุญาต same-origin requests (ไม่มี origin header = curl, mobile app)
        if (!origin) return callback(null, true);

        const allowedList = ALLOWED_ORIGINS.length > 0
            ? [...devOrigins, ...ALLOWED_ORIGINS]
            : devOrigins;  // ถ้าไม่ตั้ง env ให้ dev origins อย่างเดียว

        if (allowedList.includes(origin)) {
            callback(null, true);
        } else {
            console.warn(`[CORS] Blocked origin: ${origin}`);
            callback(new Error(`CORS: Origin '${origin}' not allowed`));
        }
    },
    credentials: true,
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Apply ทั่วไป API rate limiter
app.use('/api/', apiLimiter);

// Exclude /api/wireguard/callback-register from the global JSON parser: if
// RouterOS's /tool/fetch sends a malformed body under Content-Type: application/json,
// this middleware would throw a SyntaxError and Express's default error handler
// returns a generic 400 *before the route handler ever runs* — which is almost
// certainly why an earlier route-specific-parser fix had no effect. That route
// reads and parses its body manually instead (see below).
app.use(express.json({
    type: (req) => req.path !== '/api/wireguard/callback-register' && (req.headers['content-type'] || '').includes('json')
}));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory sessions store (token -> { user, expires })
const activeSessions = new Map();
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Single-use tokens for the RouterOS auto-callback registration flow
// (token -> { wireguardIp, siteId, expiresAt }) — see /api/wireguard/generate-script
// and /api/wireguard/callback-register
const wgRegistrationTokens = new Map();
const WG_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 min, single-use

// Middleware: Authentication
function requireAuth(allowedRoles = []) {
    return (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized: Missing token' });
        }
        
        const token = authHeader.substring(7);
        const session = activeSessions.get(token);
        
        if (!session) {
            return res.status(401).json({ error: 'Unauthorized: Invalid token' });
        }
        
        if (session.expires < Date.now()) {
            activeSessions.delete(token);
            return res.status(401).json({ error: 'Unauthorized: Token expired' });
        }
        
        // Refresh session expiry
        session.expires = Date.now() + SESSION_EXPIRY_MS;
        req.user = session.user;
        
        // Role check
        if (allowedRoles.length > 0 && !allowedRoles.includes(session.user.role)) {
            return res.status(403).json({ error: 'Forbidden: Insufficient privileges' });
        }
        
        next();
    };
}

// Router connection runner helper
async function executeOnRouter(fn, siteId) {
    const config = await db.getConfig(siteId);
    if (!config.host || !config.username) {
        throw new Error(`Router connection (${config.name || 'Site'}) is not configured. Please setup Router Settings.`);
    }
    const client = new RouterOSClient(config.host, config.port, config.username, config.password);
    await client.connect();
    try {
        return await fn(client);
    } finally {
        client.close();
    }
}

// ==========================================
// Authentication APIs
// ==========================================

app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = await db.authenticateUser(username, password);
    if (!user) {
        // บันทึก login ล้มเพื่อตรวจสอบภายหลัง
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        db.addLog('System Security', 'Login ล้มเหลว', `username: "${username}" | IP: ${ip}`);
        return res.status(400).json({ error: 'Invalid username or password' });
    }
    
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions.set(token, {
        user,
        expires: Date.now() + SESSION_EXPIRY_MS
    });
    
    db.addLog(user.username, 'เข้าสู่ระบบ', 'ล็อกอินเข้าสู่หน้าจัดการสำเร็จ');
    res.json({ token, user });
});

app.post('/api/auth/logout', requireAuth(), (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        activeSessions.delete(token);
    }
    res.json({ success: true });
});

app.get('/api/auth/me', requireAuth(), (req, res) => {
    res.json({ user: req.user });
});

// Menu visibility per role (co-admin/user) — admin always sees everything,
// this is a UI-only convenience toggle, not an API-level access boundary
// (the underlying API routes keep their own fixed requireAuth role checks).
app.get('/api/settings/menu-permissions', requireAuth(), async (req, res) => {
    try {
        const perms = await db.getMenuPermissions();
        res.json(perms);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/settings/menu-permissions', requireAuth(['admin']), async (req, res) => {
    try {
        const updated = await db.saveMenuPermissions(req.body || {});
        db.addLog(req.user.username, 'ตั้งค่าสิทธิ์เมนู', 'อัปเดตสิทธิ์การมองเห็นเมนูของ co-admin/user');
        res.json(updated);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ==========================================
// Log APIs (Admin only)
// ==========================================

// GET admin activity logs with search/filter/pagination
app.get('/api/logs', requireAuth(['admin']), async (req, res) => {
    const { search, from, to, page, limit } = req.query;
    const result = await db.getLogs({ search, from, to, page, limit });
    res.json(result);
});

// GET hotspot traffic logs (พรบ) with filter/pagination
app.get('/api/hotspot-logs', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { search, from, to, username, page, limit, site } = req.query;
    const result = await db.getHotspotLogs({ search, from, to, username, page, limit, siteName: site });
    res.json(result);
});

// Export admin activity logs as CSV
app.get('/api/logs/export-csv', requireAuth(['admin']), async (req, res) => {
    const { search, from, to } = req.query;
    const result = await db.getLogs({ search, from, to, page: 1, limit: 99999 });
    const rows = result.logs;

    const headers = ['วันเวลา', 'ผู้ใช้งาน', 'การกระทำ', 'รายละเอียด'];
    const csvLines = [
        '\uFEFF' + headers.join(','),
        ...rows.map(r => [
            `"${r.timestamp || ''}"`,
            `"${r.username || ''}"`,
            `"${(r.action || '').replace(/"/g, '""')}"`,
            `"${(r.details || '').replace(/"/g, '""')}"`
        ].join(','))
    ];

    const filename = `activity_log_${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    db.addLog(req.user.username, 'Export Log CSV', `Export activity log จำนวน ${rows.length} รายการ`);
    res.send(csvLines.join('\r\n'));
});

// Export hotspot traffic logs as CSV (พรบ)
app.get('/api/hotspot-logs/export-csv', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { search, from, to, username, site } = req.query;
    const result = await db.getHotspotLogs({ search, from, to, username, siteName: site, page: 1, limit: 99999 });
    const rows = result.logs;

    const headers = [
        'รหัส Log', 'เวลาเข้าใช้งาน', 'เวลาออก', 'ชื่อผู้ใช้',
        'IP Address', 'MAC Address', 'วิธีล็อกอิน',
        'ระยะเวลาใช้งาน', 'ดาวน์โหลด (bytes)', 'อัปโหลด (bytes)',
        'ไซต์งาน', 'สถานะ'
    ];
    const csvLines = [
        '\uFEFF' + headers.join(','),
        ...rows.map(r => [
            `"${r.id || ''}"`,
            `"${r.loginTime || ''}"`,
            `"${r.logoutTime || ''}"`,
            `"${r.username || ''}"`,
            `"${r.ipAddress || ''}"`,
            `"${r.macAddress || ''}"`,
            `"${r.loginBy || ''}"`,
            `"${r.uptime || ''}"`,
            `"${r.bytesIn || 0}"`,
            `"${r.bytesOut || 0}"`,
            `"${(r.siteName || '').replace(/"/g, '""')}"`,
            `"${r.status || ''}"`
        ].join(','))
    ];

    const filename = `hotspot_traffic_log_${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    db.addLog(req.user.username, 'Export Hotspot Log CSV', `Export traffic log จำนวน ${rows.length} รายการ`);
    res.send(csvLines.join('\r\n'));
});

// GET DNS query (domain visit history) logs with search/filter/pagination
app.get('/api/dns-logs', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { search, from, to, username, page, limit, site } = req.query;
    const result = await db.getDnsQueryLogs({ search, from, to, username, page, limit, siteName: site });
    res.json(result);
});

// Export DNS query (domain visit history) logs as CSV
app.get('/api/dns-logs/export-csv', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { search, from, to, username, site } = req.query;
    const result = await db.getDnsQueryLogs({ search, from, to, username, siteName: site, page: 1, limit: 99999 });
    const rows = result.logs;

    const headers = ['เวลา', 'ชื่อผู้ใช้', 'IP Address', 'MAC Address', 'โดเมนที่เข้าชม', 'ไซต์งาน'];
    const csvLines = [
        '﻿' + headers.join(','),
        ...rows.map(r => [
            `"${r.queryTime || ''}"`,
            `"${r.username || ''}"`,
            `"${r.ipAddress || ''}"`,
            `"${r.macAddress || ''}"`,
            `"${r.domain || ''}"`,
            `"${(r.siteName || '').replace(/"/g, '""')}"`
        ].join(','))
    ];

    const filename = `dns_visit_log_${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    db.addLog(req.user.username, 'Export DNS Log CSV', `Export DNS visit log จำนวน ${rows.length} รายการ`);
    res.send(csvLines.join('\r\n'));
});

// PPPoE room usage — monthly billing summary
app.get('/api/pppoe-usage', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const summary = await db.getPppoeUsageSummary(req.query.month, req.query.site);
        res.json(summary);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PPPoE room usage — raw session log (audit trail), paginated
app.get('/api/pppoe-usage/logs', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { search, from, to, username, page, limit, site } = req.query;
    const result = await db.getPppoeUsageLogs({ search, from, to, username, page, limit, siteName: site });
    res.json(result);
});

// PPPoE room usage — export raw session log as CSV
app.get('/api/pppoe-usage/export-csv', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { search, from, to, username, site } = req.query;
    const result = await db.getPppoeUsageLogs({ search, from, to, username, siteName: site, page: 1, limit: 99999 });
    const rows = result.logs;

    const headers = ['เวลาเข้าใช้', 'เวลาออก', 'ห้อง', 'IP Address', 'ไซต์งาน', 'สถานะ', 'ดาวน์โหลด (bytes)', 'อัปโหลด (bytes)'];
    const csvLines = [
        '﻿' + headers.join(','),
        ...rows.map(r => [
            `"${r.loginTime || ''}"`,
            `"${r.logoutTime || ''}"`,
            `"${r.username || ''}"`,
            `"${r.ipAddress || ''}"`,
            `"${(r.siteName || '').replace(/"/g, '""')}"`,
            `"${r.status || ''}"`,
            `"${r.bytesIn || 0}"`,
            `"${r.bytesOut || 0}"`
        ].join(','))
    ];

    const filename = `pppoe_usage_log_${new Date().toISOString().slice(0,10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    db.addLog(req.user.username, 'Export PPPoE Usage CSV', `Export PPPoE usage log จำนวน ${rows.length} รายการ`);
    res.send(csvLines.join('\r\n'));
});


// ==========================================
// Dashboard Users CRUD APIs (Admin only)
// ==========================================

app.get('/api/users', requireAuth(['admin']), async (req, res) => {
    try {
        const allUsers = await db.getUsers();
        const users = allUsers.map(u => ({
            id: u.id,
            username: u.username,
            role: u.role,
            name: u.name,
            assignedSiteId: u.assignedSiteId || 'all'
        }));
        res.json(users);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/users', requireAuth(['admin']), async (req, res) => {
    const { username, password, role, name, assignedSiteId } = req.body;
    if (!username || !password || !role || !name) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    if (!['admin', 'co-admin', 'user'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
    }
    try {
        const newUser = await db.addUser(username, password, role, name, assignedSiteId || 'all');
        db.addLog(req.user.username, 'เพิ่มบัญชีระบบ', 'เพิ่มบัญชี ' + username + ' (สิทธิ์: ' + role + ', ไซต์: ' + (assignedSiteId || 'all') + ')');
        res.status(201).json(newUser);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.put('/api/users/:id', requireAuth(['admin']), async (req, res) => {
    const { username, password, role, name, assignedSiteId } = req.body;
    try {
        const updated = await db.updateUser(req.params.id, { username, password, role, name, assignedSiteId });
        
        // If password changed or username changed, terminate that user's sessions
        for (const [token, session] of activeSessions.entries()) {
            if (session.user.id === req.params.id) {
                if (password || username || role || assignedSiteId !== undefined) {
                    activeSessions.delete(token); // Force log them out to re-authenticate
                } else if (name) {
                    session.user.name = name;
                }
            }
        }
        
        db.addLog(req.user.username, 'แก้ไขบัญชีระบบ', 'แก้ไขบัญชี ID ' + req.params.id + ' (ชื่อ: ' + (name || '') + ')');
        res.json(updated);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/users/:id', requireAuth(['admin']), async (req, res) => {
    try {
        await db.deleteUser(req.params.id);
        // Clean sessions
        for (const [token, session] of activeSessions.entries()) {
            if (session.user.id === req.params.id) {
                activeSessions.delete(token);
            }
        }
        db.addLog(req.user.username, 'ลบบัญชีระบบ', 'ลบบัญชี ID ' + req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ==========================================
// Router Settings Configurations & Multi-Site APIs
// ==========================================

// Get all sites and active site ID (Filtered by user permission)
app.get('/api/sites', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const sitesData = await db.getSites();
        if (req.user.role !== 'admin' && req.user.assignedSiteId && req.user.assignedSiteId !== 'all') {
            const allowedSite = sitesData.sites.find(s => s.id === req.user.assignedSiteId);
            return res.json({
                activeSiteId: req.user.assignedSiteId,
                sites: allowedSite ? [allowedSite] : []
            });
        }
        res.json(sitesData);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Switch active site (Validated against assigned permission)
app.post('/api/sites/switch/:id', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    if (req.user.role !== 'admin' && req.user.assignedSiteId && req.user.assignedSiteId !== 'all') {
        if (req.params.id !== req.user.assignedSiteId) {
            return res.status(403).json({ error: 'คุณไม่มีสิทธิ์สลับไปใช้งานไซต์งานนี้' });
        }
    }
    try {
        const activeSite = await db.setActiveSite(req.params.id);
        db.addLog(req.user.username, 'สลับไซต์งาน', 'สลับไปใช้งานไซต์งาน: ' + activeSite.name);
        res.json({ success: true, activeSite });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});


// Helper for VPS WireGuard Peer Management
//
// NOTE: these shell out to `sudo wg`/`sudo wg-quick`, which requires the OS
// user running this Node process to have passwordless sudo rights for those
// two binaries (see /etc/sudoers.d/ setup) — without it, sudo silently fails
// (no TTY to prompt for a password). Errors here are intentionally left to
// propagate (not swallowed with `|| true`) so callers/route handlers can
// report the real failure instead of a false "success".
function cleanupVpsPeerByIp(wireguardIp) {
    if (!wireguardIp) return;
    const { execSync } = require('child_process');
    const dump = execSync('sudo wg show wg0 dump', { encoding: 'utf8' });
    const lines = dump.split('\n');
    const targetIpStr = wireguardIp.trim() + '/32';
    for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 4) {
            const pubKey = parts[0];
            const allowedIps = parts[3];
            if (allowedIps && allowedIps.includes(targetIpStr)) {
                execSync(`sudo wg set wg0 peer "${pubKey}" remove`, { encoding: 'utf8' });
            }
        }
    }
}

function registerVpsPeer(wireguardIp, clientPublicKey) {
    if (!wireguardIp || !clientPublicKey) return;
    cleanupVpsPeerByIp(wireguardIp);
    const { execSync } = require('child_process');
    execSync(`sudo wg set wg0 peer "${clientPublicKey.trim()}" allowed-ips ${wireguardIp.trim()}/32`, { encoding: 'utf8' });
    execSync('sudo wg-quick save wg0', { encoding: 'utf8' });
}

// Add new site (Admin only)
app.post('/api/sites', requireAuth(['admin']), async (req, res) => {
    const { name, host, port, username, password, connectionType, wireguardIp, wireguardPublicKey } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Name is required' });
    }
    try {
        const newSite = await db.addSite({ name, host, port, username, password, connectionType, wireguardIp, wireguardPublicKey });
        if (connectionType === 'wireguard' && wireguardPublicKey && wireguardIp) {
            try {
                registerVpsPeer(wireguardIp, wireguardPublicKey);
            } catch (wgErr) {
                console.error('[WireGuard] Failed to register VPS peer for new site', name, ':', wgErr.message);
                db.addLog('System Auto', 'WireGuard Peer ลงทะเบียนล้มเหลว', `ไซต์ ${name}: ${wgErr.message}`);
            }
        }
        db.addLog(req.user.username, 'เพิ่มไซต์งานใหม่', 'เพิ่มไซต์งาน ' + name + ' (IP: ' + newSite.host + ')');
        res.status(201).json(newSite);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Update site (Admin only)
app.put('/api/sites/:id', requireAuth(['admin']), async (req, res) => {
    const { name, host, port, username, password, connectionType, wireguardIp, wireguardPublicKey } = req.body;
    try {
        const updated = await db.updateSite(req.params.id, { name, host, port, username, password, connectionType, wireguardIp, wireguardPublicKey });
        if (connectionType === 'wireguard' && wireguardPublicKey && wireguardIp) {
            try {
                registerVpsPeer(wireguardIp, wireguardPublicKey);
            } catch (wgErr) {
                console.error('[WireGuard] Failed to register VPS peer for site', updated.name, ':', wgErr.message);
                db.addLog('System Auto', 'WireGuard Peer ลงทะเบียนล้มเหลว', `ไซต์ ${updated.name}: ${wgErr.message}`);
            }
        }
        db.addLog(req.user.username, 'แก้ไขไซต์งาน', 'แก้ไขข้อมูลไซต์งาน: ' + updated.name);
        res.json(updated);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Generate WireGuard Setup Script for MikroTik
app.post('/api/wireguard/generate-script', requireAuth(['admin']), async (req, res) => {
    const { wireguardIp, vpsPublicKey, clientPublicKey, port, siteId } = req.body;
    const targetIp = wireguardIp || '10.10.88.2';
    const targetPort = parseInt(port) || 8728;
    let autoRegistered = false;

    // Guard against generating a script for an IP another site already owns —
    // the site-save validation (addSite/updateSite) catches this too, but only
    // if the admin actually saves before generating; this route is reachable
    // (and the script copyable to a real router) independently of saving, so
    // it needs its own check. Root-caused a real IP collision this session
    // (two different routers both configured for 10.10.88.2).
    try {
        const sitesData = await db.getSites();
        const dup = (sitesData.sites || []).find(s => s.id !== siteId && (s.wireguardIp === targetIp || s.host === targetIp));
        if (dup) {
            return res.status(400).json({ error: `WireGuard IP ${targetIp} ถูกใช้อยู่แล้วโดยไซต์ "${dup.name}" กรุณาเลือก IP อื่น` });
        }
    } catch (e) {
        // Fail-open on the check itself (e.g. DB hiccup) — don't block script
        // generation over a transient error unrelated to the actual collision.
    }

    if (clientPublicKey && clientPublicKey.trim()) {
        try {
            registerVpsPeer(targetIp, clientPublicKey);
            autoRegistered = true;
            db.addLog(req.user.username, 'ลงทะเบียน WireGuard Peer อัตโนมัติ', `ลงทะเบียนคีย์สำหรับ IP ${targetIp}`);
        } catch (e) {}
    }
    
    let pubKey = vpsPublicKey;
    if (!pubKey) {
        try {
            const { execSync } = require('child_process');
            pubKey = execSync('wg show wg0 public-key 2>/dev/null || sudo wg show wg0 public-key 2>/dev/null', { encoding: 'utf8' }).trim();
        } catch (e) {}
    }
    if (!pubKey) {
        try {
            const candidatePaths = [
                '/etc/wireguard/publickey',
                path.join(__dirname, 'vps_publickey.txt'),
                path.join(__dirname, 'publickey')
            ];
            for (const p of candidatePaths) {
                if (fs.existsSync(p)) {
                    pubKey = fs.readFileSync(p, 'utf8').trim();
                    if (pubKey) break;
                }
            }
        } catch (e) {
            console.error('Failed to read VPS public key:', e.message);
        }
    }
    if (!pubKey) {
        return res.status(500).json({ error: 'ไม่สามารถอ่าน VPS WireGuard Public Key ได้ — ตรวจสอบว่า wg0 ทำงานอยู่และ sudoers ตั้งค่าถูกต้อง (ลองรัน: sudo -n wg show wg0 public-key)' });
    }

    // Auto-registration callback: if PUBLIC_APP_URL is configured, embed a
    // /tool/fetch call in the script that POSTs the router's freshly-generated
    // public key straight back to us — no manual copy-paste needed. Falls back
    // to the existing fully-manual Step 2 flow if not configured.
    let callbackScriptBlock = '';
    if (process.env.PUBLIC_APP_URL) {
        const token = crypto.randomBytes(24).toString('hex');
        wgRegistrationTokens.set(token, { wireguardIp: targetIp, siteId: siteId || null, expiresAt: Date.now() + WG_TOKEN_TTL_MS });
        callbackScriptBlock = `
# 7. Auto-register this router's key with the dashboard (no manual copy-paste needed)
# Sent as a plain HTTP header, not a JSON body (avoids any string-escaping
# issues). Confirmed live on RouterOS 7.2.2: assigning the key to a
# ":local pubkey [...]" variable first silently loses the value — call
# [/interface/wireguard/get ... public-key] directly inline instead, which
# works correctly.
/tool/fetch url="${process.env.PUBLIC_APP_URL}/api/wireguard/callback-register?token=${token}" http-method=post http-header-field=("X-Public-Key: " . [/interface/wireguard/get [find name=wg-gatekeeper] public-key]) output=none
:put "Public Key auto-registered to dashboard!"`;
    } else {
        console.warn('[WireGuard] PUBLIC_APP_URL not set — script will not self-register, Step 2 manual paste is required.');
    }

    const script = `# ======================================================
# MikroTik RouterOS WireGuard Setup Script (MT Management)
# Targeted IP: ${targetIp}
# API Port: ${targetPort}
# VPS Endpoint: 157.85.108.84:51820
# ======================================================

# 1. Clear existing interface, peers, and IP if any — removing the interface
# does NOT cascade-delete its peers/addresses on this RouterOS version, so
# they'd otherwise accumulate as orphaned "unknown"-interface entries on every
# re-run of this script. This router only ever has the one VPS Hub Server
# peer, so it's safe to clear all WireGuard peers/addresses unconditionally.
/interface/wireguard/peers/remove [find]
/ip/address/remove [find comment="WireGuard VPN IP"]
/interface/wireguard/remove [find name=wg-gatekeeper]

# 2. Add WireGuard interface
/interface/wireguard/add name=wg-gatekeeper listen-port=13231 comment="MT Management WireGuard"

# 3. Add IP Address
/ip/address/add address=${targetIp}/24 interface=wg-gatekeeper comment="WireGuard VPN IP"

# 4. Add VPS Server Peer
/interface/wireguard/peers/add interface=wg-gatekeeper endpoint-address="157.85.108.84" endpoint-port=51820 allowed-address=10.10.88.0/24 persistent-keepalive=25s comment="VPS Hub Server" public-key="${pubKey}"

# 5. Security Hardening (Lock API Service to VPN Subnet Only & Set Custom Port)
/ip/service/set api address=10.10.88.0/24 port=${targetPort} disabled=no
/ip/service/disable api-ssl

# 6. Display Result
:put "--------------------------------------------------------"
:put "WireGuard Interface & Security Hardening Completed!"
:put "Your Router WireGuard Public Key is:"
:put [/interface/wireguard/get [find name=wg-gatekeeper] public-key]
:put "--------------------------------------------------------"
${callbackScriptBlock}
`;

    res.json({ script, wireguardIp: targetIp, autoRegistered });
});

// Callback endpoint the generated RouterOS script hits via /tool/fetch to
// self-register its public key — no requireAuth (the router can't do our
// session auth), security instead comes from the token being random,
// single-use, and only created moments earlier by an authenticated admin
// action (see generate-script above). Still covered by the global apiLimiter.
//
// The public key arrives as a plain X-Public-Key header, not a JSON body —
// two earlier attempts at building a JSON body string inside the RouterOS
// script (inline interpolation, then string concatenation) both silently
// produced empty/malformed output, confirmed live via diagnostic logging.
// A raw header value sidesteps RouterOS's string-escaping quirks entirely.
// TEMPORARY diagnostic route — echoes back everything received (method,
// headers, raw body) so we can see exactly what RouterOS's /tool/fetch
// actually transmits, instead of continuing to guess blind. Point a
// standalone /tool/fetch test at this URL directly (not through the full
// generated script) to isolate the transport layer from script logic.
// Safe to remove once the real callback-register issue is resolved.
app.all('/api/wireguard/debug-echo', express.text({ type: () => true }), (req, res) => {
    const info = {
        method: req.method,
        query: req.query,
        headers: req.headers,
        rawBody: req.body
    };
    console.log('[wg-debug-echo]', JSON.stringify(info, null, 2));
    res.json({ received: info });
});

app.post('/api/wireguard/callback-register', async (req, res) => {
    const token = req.query.token;
    const publicKey = req.headers['x-public-key'];
    console.log('[wg-callback] X-Public-Key header:', publicKey ? '(present, len=' + publicKey.length + ')' : '(missing)');
    if (!token || !publicKey) {
        return res.status(400).json({ error: 'token and publicKey are required' });
    }
    const entry = wgRegistrationTokens.get(token);
    if (!entry || entry.expiresAt < Date.now()) {
        return res.status(401).json({ error: 'Token invalid or expired' });
    }
    wgRegistrationTokens.delete(token); // single-use
    try {
        registerVpsPeer(entry.wireguardIp, publicKey);
        if (entry.siteId) {
            // Best-effort — db.updateSite is sync in JSON mode, async in Supabase
            // mode, and either can throw/reject (e.g. unknown siteId); don't let
            // that fail the whole registration.
            try {
                const maybePromise = db.updateSite(entry.siteId, { wireguardPublicKey: publicKey });
                if (maybePromise && typeof maybePromise.catch === 'function') maybePromise.catch(() => {});
            } catch (e) {}
        }
        db.addLog('MikroTik Auto-Callback', 'ลงทะเบียน WireGuard Peer อัตโนมัติ', `IP ${entry.wireguardIp}`);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Check live connection status of a site's WireGuard peer (handshake/traffic)
app.get('/api/wireguard/peer-status', requireAuth(['admin']), (req, res) => {
    const wireguardIp = req.query.wireguardIp;
    if (!wireguardIp) {
        return res.status(400).json({ error: 'wireguardIp is required' });
    }
    try {
        const { execSync } = require('child_process');
        const dump = execSync('sudo wg show wg0 dump', { encoding: 'utf8' });
        const targetIpStr = wireguardIp.trim() + '/32';
        const lines = dump.trim().split('\n').slice(1); // skip interface line (only 4 fields)
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 8 && parts[3] && parts[3].includes(targetIpStr)) {
                const handshake = parseInt(parts[4]) || 0; // unix epoch seconds, 0 = never
                return res.json({
                    connected: handshake > 0,
                    lastHandshakeSecondsAgo: handshake > 0 ? Math.floor(Date.now() / 1000) - handshake : null,
                    transferRx: parseInt(parts[5]) || 0,
                    transferTx: parseInt(parts[6]) || 0
                });
            }
        }
        res.json({ connected: false, lastHandshakeSecondsAgo: null, transferRx: 0, transferTx: 0 });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Register MikroTik Peer into VPS WireGuard automatically
app.post('/api/wireguard/register-peer', requireAuth(['admin']), (req, res) => {
    const { clientPublicKey, wireguardIp } = req.body;
    if (!clientPublicKey || !wireguardIp) {
        return res.status(400).json({ error: 'Client Public Key and WireGuard IP are required' });
    }
    try {
        registerVpsPeer(wireguardIp, clientPublicKey);
        db.addLog(req.user.username, 'ลงทะเบียน WireGuard Peer', `ลงทะเบียนคีย์สำหรับ IP ${wireguardIp}`);
        res.json({ success: true, message: 'ลงทะเบียน Peer บน VPS สำเร็จ (พร้อมล้างค่าคีย์เก่า)' });
    } catch (err) {
        res.status(500).json({ error: `ไม่สามารถลงทะเบียน Peer บน VPS ได้: ${err.message}` });
    }
});

// Remove Peer from VPS WireGuard manually
app.post('/api/wireguard/remove-peer', requireAuth(['admin']), (req, res) => {
    const { wireguardIp } = req.body;
    if (!wireguardIp) {
        return res.status(400).json({ error: 'WireGuard IP is required' });
    }
    try {
        cleanupVpsPeerByIp(wireguardIp);
        const { execSync } = require('child_process');
        execSync('sudo wg-quick save wg0', { encoding: 'utf8' });
        db.addLog(req.user.username, 'ลบ WireGuard Peer', `ลบ Peer สำหรับ IP ${wireguardIp} บน VPS`);
        res.json({ success: true, message: `ล้างค่า WireGuard Peer สำหรับ IP ${wireguardIp} บน VPS เรียบร้อยแล้ว` });
    } catch (err) {
        res.status(500).json({ error: `ไม่สามารถล้างค่า Peer บน VPS ได้: ${err.message}` });
    }
});

// Generate Uninstall Script for MikroTik
app.post('/api/wireguard/generate-uninstall-script', requireAuth(['admin']), (req, res) => {
    const script = `# ======================================================
# MikroTik RouterOS WireGuard Clean-up / Uninstall Script
# ======================================================

# 1. Remove WireGuard Interface and associated IPs/Peers
/interface/wireguard/remove [find name=wg-gatekeeper]
/ip/address/remove [find comment="WireGuard VPN IP"]

:put "--------------------------------------------------------"
:put "WireGuard Interface & Configuration Removed Successfully!"
:put "--------------------------------------------------------"
`;
    res.json({ script });
});



// Delete site (Admin only)
app.delete('/api/sites/:id', requireAuth(['admin']), async (req, res) => {
    try {
        await db.deleteSite(req.params.id);
        db.addLog(req.user.username, 'ลบไซต์งาน', 'ลบไซต์งาน ID: ' + req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Legacy single config endpoints (backward compatible)
app.get('/api/config', requireAuth(['admin']), async (req, res) => {
    try {
        const config = await db.getConfig();
        res.json({
            host: config.host,
            port: config.port,
            username: config.username,
            hasPassword: !!config.password
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/config', requireAuth(['admin']), async (req, res) => {
    const { host, port, username, password } = req.body;
    if (!host || !username) {
        return res.status(400).json({ error: 'Host and Username are required' });
    }
    try {
        const existingConfig = await db.getConfig();
        const newConfig = {
            host,
            port: parseInt(port) || 8728,
            username,
            password: password !== undefined ? password : existingConfig.password
        };
        await db.saveConfig(newConfig);
        db.addLog(req.user.username, 'ตั้งค่าเราท์เตอร์', 'อัปเดตข้อมูลเชื่อมโยงเราท์เตอร์ IP: ' + host);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ==========================================
// MikroTik Router API Proxy Routes
// ==========================================

// Check router connection test (supports ?siteId=)
app.get('/api/mikrotik/test-connection', requireAuth(['admin']), async (req, res) => {
    const siteId = req.query.siteId;
    try {
        await executeOnRouter(async (client) => {
            await client.exec('/system/resource/print');
        }, siteId);
        res.json({ success: true, message: 'Connected successfully' });
    } catch (err) {
        res.status(500).json({ error: `Connection failed: ${err.message}` });
    }
});

// 1. Overview System Resource status
app.get('/api/mikrotik/status', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const stats = await executeOnRouter(async (client) => {
            const resources = await client.exec('/system/resource/print');
            const routerboard = await client.exec('/system/routerboard/print');
            
            const r = resources[0] || {};
            const rb = routerboard[0] || {};
            
            return {
                uptime: r.uptime || 'N/A',
                version: r.version || 'N/A',
                cpuLoad: r['cpu-load'] ? `${r['cpu-load']}%` : 'N/A',
                freeMemory: r['free-memory'] ? parseInt(r['free-memory']) : 0,
                totalMemory: r['total-memory'] ? parseInt(r['total-memory']) : 0,
                cpu: r.cpu || 'N/A',
                boardName: r['board-name'] || 'N/A',
                model: rb.model || r['board-name'] || 'MikroTik Router',
                serialNumber: rb['serial-number'] || 'N/A'
            };
        });
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Read interface list and stats (for real-time traffic graph)
app.get('/api/mikrotik/interfaces', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const interfaces = await executeOnRouter(async (client) => {
            const list = await client.exec('/interface/print');
            return list.map(item => ({
                id: item['.id'],
                name: item.name,
                type: item.type,
                running: item.running === 'true',
                disabled: item.disabled === 'true',
                // Accumulative stats (in bytes)
                rxByte: parseInt(item['rx-byte']) || 0,
                txByte: parseInt(item['tx-byte']) || 0,
                comment: item.comment || ''
            }));
        });
        res.json(interfaces);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// Hotspot Management APIs (Admin and Co-Admin)
// ==========================================

// Read Hotspot users
app.get('/api/mikrotik/hotspot/users', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const users = await executeOnRouter(async (client) => {
            const list = await client.exec('/ip/hotspot/user/print');
            return list.map(item => {
                let userPassword = item.password || item['plain-password'] || item.pass || item.secret || '';
                if (!userPassword) {
                    for (const k of Object.keys(item)) {
                        if (k.toLowerCase().includes('pass') || k.toLowerCase().includes('secret') || k.toLowerCase().includes('pwd')) {
                            if (item[k]) {
                                userPassword = item[k];
                                break;
                            }
                        }
                    }
                }
                return {
                    id: item['.id'],
                    name: item.name,
                    password: userPassword,
                    profile: item.profile,
                    uptime: item.uptime || '0s',
                    bytesIn: parseInt(item['bytes-in']) || 0,
                    bytesOut: parseInt(item['bytes-out']) || 0,
                    limitUptime: item['limit-uptime'] || 'Unlimited',
                    limitBytesTotal: parseInt(item['limit-bytes-total']) || 0,
                    disabled: item.disabled === 'true',
                    comment: item.comment || ''
                };
            });
        });
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// Create Hotspot user
app.post('/api/mikrotik/hotspot/users', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const { name, password, profile, limitUptime, limitBytesTotal, comment } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Username is required' });
    }
    
    try {
        const result = await executeOnRouter(async (client) => {
            const params = {
                name,
                password: password || '',
                profile: profile || 'default',
                comment: comment || 'Added by Web Dashboard'
            };
            if (limitUptime) params['limit-uptime'] = limitUptime;
            if (limitBytesTotal) params['limit-bytes-total'] = limitBytesTotal;
            
            return await client.exec('/ip/hotspot/user/add', params);
        });
        db.addLog(req.user.username, 'เพิ่มบัญชี Hotspot', 'เพิ่มผู้ใช้ ' + name + ' (โปรไฟล์: ' + profile + ')');
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Edit Hotspot user
app.put('/api/mikrotik/hotspot/users/:id', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const { name, password, profile, limitUptime, limitBytesTotal, comment } = req.body;
    try {
        const result = await executeOnRouter(async (client) => {
            const params = {
                '.id': req.params.id,
                name,
                profile: profile || 'default',
                comment: comment || ''
            };
            if (password !== undefined) params.password = password;
            
            // Set limit properties (empty value removes limits in RouterOS depending on version,
            // but setting limit-uptime="0" or "00:00:00" might clear it, or leaving it out is standard)
            params['limit-uptime'] = limitUptime || '00:00:00';
            params['limit-bytes-total'] = limitBytesTotal || 0;

            return await client.exec('/ip/hotspot/user/set', params);
        });
        db.addLog(req.user.username, 'แก้ไขบัญชี Hotspot', 'แก้ไขผู้ใช้ ID: ' + req.params.id + ' เป็นชื่อ ' + name + ' (โปรไฟล์: ' + profile + ')');
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Hotspot user
app.delete('/api/mikrotik/hotspot/users/:id', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        await executeOnRouter(async (client) => {
            await client.exec('/ip/hotspot/user/remove', { '.id': req.params.id });
        });
        db.addLog(req.user.username, 'ลบบัญชี Hotspot', 'ลบผู้ใช้ ID: ' + req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Read Hotspot active sessions
app.get('/api/mikrotik/hotspot/active', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const active = await executeOnRouter(async (client) => {
            const list = await client.exec('/ip/hotspot/active/print');
            return list.map(item => ({
                id: item['.id'],
                user: item.user,
                address: item.address,
                macAddress: item['mac-address'],
                uptime: item.uptime || '0s',
                bytesIn: parseInt(item['bytes-in']) || 0,
                bytesOut: parseInt(item['bytes-out']) || 0,
                loginBy: item['login-by'] || ''
            }));
        });
        res.json(active);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Kick Active User
app.delete('/api/mikrotik/hotspot/active/:id', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        await executeOnRouter(async (client) => {
            await client.exec('/ip/hotspot/active/remove', { '.id': req.params.id });
        });
        db.addLog(req.user.username, 'เตะผู้ใช้ Hotspot', 'ตัดการเชื่อมต่อเซสชัน ID: ' + req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Read User Profiles
app.get('/api/mikrotik/hotspot/profiles', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const profiles = await executeOnRouter(async (client) => {
            const list = await client.exec('/ip/hotspot/user/profile/print');
            return list.map(item => ({
                id: item['.id'],
                name: item.name,
                sharedUsers: item['shared-users'] || '1',
                rateLimit: item['rate-limit'] || 'Unlimited',
                sessionTimeout: item['session-timeout'] || '00:00:00',
                idleTimeout: item['idle-timeout'] || 'none'
            }));
        });
        res.json(profiles);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create User Profile
app.post('/api/mikrotik/hotspot/profiles', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const { name, rateLimit, sharedUsers, sessionTimeout } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Profile name is required' });
    }
    try {
        await executeOnRouter(async (client) => {
            const params = {
                name,
                'shared-users': String(sharedUsers || '1')
            };
            if (rateLimit) params['rate-limit'] = rateLimit;
            if (sessionTimeout) params['session-timeout'] = sessionTimeout;
            await client.exec('/ip/hotspot/user/profile/add', params);
        });
        db.addLog(req.user.username, 'เพิ่มโปรไฟล์ Hotspot', 'เพิ่มโปรไฟล์ ' + name);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Edit User Profile
app.put('/api/mikrotik/hotspot/profiles/:id', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const { name, rateLimit, sharedUsers, sessionTimeout } = req.body;
    try {
        await executeOnRouter(async (client) => {
            const params = {
                '.id': req.params.id,
                name,
                'shared-users': String(sharedUsers || '1'),
                'rate-limit': rateLimit || '',
                'session-timeout': sessionTimeout || '00:00:00'
            };
            await client.exec('/ip/hotspot/user/profile/set', params);
        });
        db.addLog(req.user.username, 'แก้ไขโปรไฟล์ Hotspot', 'แก้ไขโปรไฟล์ ' + name);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete User Profile
app.delete('/api/mikrotik/hotspot/profiles/:id', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        await executeOnRouter(async (client) => {
            await client.exec('/ip/hotspot/user/profile/remove', { '.id': req.params.id });
        });
        db.addLog(req.user.username, 'ลบโปรไฟล์ Hotspot', 'ลบโปรไฟล์ ID: ' + req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// PPPoE Room Account Management APIs (Admin, Co-Admin — billing tool, not general-user-facing)
// ==========================================

// Read PPPoE room accounts
app.get('/api/mikrotik/pppoe/users', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const users = await executeOnRouter(async (client) => {
            const list = await client.exec('/ppp/secret/print');
            return list
                .filter(item => item.service === 'pppoe')
                .map(item => ({
                    id: item['.id'],
                    name: item.name,
                    password: item.password || '',
                    profile: item.profile,
                    disabled: item.disabled === 'true',
                    comment: item.comment || ''
                }));
        });
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create PPPoE room account
app.post('/api/mikrotik/pppoe/users', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { name, password, profile, comment } = req.body;
    if (!name || !password) {
        return res.status(400).json({ error: 'ต้องระบุชื่อห้องและรหัสผ่าน' });
    }
    try {
        await executeOnRouter(async (client) => {
            await client.exec('/ppp/secret/add', {
                name, password,
                profile: profile || 'default',
                service: 'pppoe',
                comment: comment || ''
            });
        });
        db.addLog(req.user.username, 'เพิ่มบัญชี PPPoE', 'เพิ่มห้อง ' + name + ' (แพ็กเกจ: ' + (profile || 'default') + ')');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Edit PPPoE room account (also used to enable/disable a room)
app.put('/api/mikrotik/pppoe/users/:id', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { name, password, profile, comment, disabled } = req.body;
    try {
        await executeOnRouter(async (client) => {
            const params = {
                '.id': req.params.id,
                name,
                profile: profile || 'default',
                comment: comment || ''
            };
            if (password !== undefined && password !== '') params.password = password;
            if (disabled !== undefined) params.disabled = disabled ? 'yes' : 'no';
            await client.exec('/ppp/secret/set', params);
        });
        db.addLog(req.user.username, 'แก้ไขบัญชี PPPoE', 'แก้ไขห้อง ID: ' + req.params.id + ' เป็นชื่อ ' + name);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete PPPoE room account
app.delete('/api/mikrotik/pppoe/users/:id', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        await executeOnRouter(async (client) => {
            await client.exec('/ppp/secret/remove', { '.id': req.params.id });
        });
        db.addLog(req.user.username, 'ลบบัญชี PPPoE', 'ลบห้อง ID: ' + req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Read PPPoE live sessions
// NOTE: byte counters on /ppp/active vary by RouterOS version — may need a
// quick live check/adjustment after deploy, same class of issue as the DNS
// log message-format calibration earlier this session.
app.get('/api/mikrotik/pppoe/active', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const active = await executeOnRouter(async (client) => {
            const list = await client.exec('/ppp/active/print');
            return list
                .filter(item => item.service === 'pppoe')
                .map(item => ({
                    id: item['.id'],
                    name: item.name,
                    address: item.address || '',
                    uptime: item.uptime || '0s',
                    callerId: item['caller-id'] || '',
                    bytesIn: parseInt(item['bytes-in']) || 0,
                    bytesOut: parseInt(item['bytes-out']) || 0
                }));
        });
        res.json(active);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Disconnect a PPPoE session
app.delete('/api/mikrotik/pppoe/active/:id', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        await executeOnRouter(async (client) => {
            await client.exec('/ppp/active/remove', { '.id': req.params.id });
        });
        db.addLog(req.user.username, 'ตัดการเชื่อมต่อ PPPoE', 'ตัดเซสชัน ID: ' + req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Read PPPoE packages (profiles)
app.get('/api/mikrotik/pppoe/profiles', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const profiles = await executeOnRouter(async (client) => {
            const list = await client.exec('/ppp/profile/print');
            return list.map(item => ({
                id: item['.id'],
                name: item.name,
                rateLimit: item['rate-limit'] || 'Unlimited',
                localAddress: item['local-address'] || '',
                remoteAddress: item['remote-address'] || ''
            }));
        });
        res.json(profiles);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create PPPoE package
app.post('/api/mikrotik/pppoe/profiles', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { name, rateLimit, localAddress, remoteAddress } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'ต้องระบุชื่อแพ็กเกจ' });
    }
    try {
        await executeOnRouter(async (client) => {
            const params = { name, 'only-one': 'yes' };
            if (rateLimit) params['rate-limit'] = rateLimit;
            if (localAddress) params['local-address'] = localAddress;
            if (remoteAddress) params['remote-address'] = remoteAddress;
            await client.exec('/ppp/profile/add', params);
        });
        db.addLog(req.user.username, 'เพิ่มแพ็กเกจ PPPoE', 'เพิ่มแพ็กเกจ ' + name);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Edit PPPoE package
app.put('/api/mikrotik/pppoe/profiles/:id', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { name, rateLimit, localAddress, remoteAddress } = req.body;
    try {
        await executeOnRouter(async (client) => {
            const params = { '.id': req.params.id, name };
            if (rateLimit) params['rate-limit'] = rateLimit;
            if (localAddress) params['local-address'] = localAddress;
            if (remoteAddress) params['remote-address'] = remoteAddress;
            await client.exec('/ppp/profile/set', params);
        });
        db.addLog(req.user.username, 'แก้ไขแพ็กเกจ PPPoE', 'แก้ไขแพ็กเกจ ' + name);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete PPPoE package
app.delete('/api/mikrotik/pppoe/profiles/:id', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        await executeOnRouter(async (client) => {
            await client.exec('/ppp/profile/remove', { '.id': req.params.id });
        });
        db.addLog(req.user.username, 'ลบแพ็กเกจ PPPoE', 'ลบแพ็กเกจ ID: ' + req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Generate PPPoE Server Setup Script for MikroTik (one-time per-site setup, run once in WinBox)
app.post('/api/mikrotik/pppoe/generate-script', requireAuth(['admin']), (req, res) => {
    const { interfaceName, vlanId, poolStart, poolEnd, serverAddress } = req.body;
    if (!interfaceName || !poolStart || !poolEnd || !serverAddress) {
        return res.status(400).json({ error: 'ต้องระบุ Interface, IP Pool (ต้น-ปลาย) และ Server Address ให้ครบ' });
    }

    const targetInterface = vlanId ? `vlan-pppoe-${vlanId}` : interfaceName;
    const vlanStepBlock = vlanId ? `
# 1. Create VLAN interface for the room-facing switch port
/interface/vlan/add name=${targetInterface} vlan-id=${vlanId} interface=${interfaceName} comment="PPPoE Rooms VLAN"
` : '';
    const poolStepNum = vlanId ? 2 : 1;
    const serverStepNum = poolStepNum + 1;
    const resultStepNum = serverStepNum + 1;

    const script = `# ======================================================
# MikroTik PPPoE Server Setup Script (MT Management)
# Interface: ${targetInterface}
# IP Pool: ${poolStart} - ${poolEnd}
# Server Address: ${serverAddress}
# ======================================================
${vlanStepBlock}
# ${poolStepNum}. Create IP Pool for PPPoE room clients
/ip/pool/add name=pppoe-pool ranges=${poolStart}-${poolEnd} comment="PPPoE Room Clients"

# ${serverStepNum}. Enable PPPoE Server
/interface/pppoe-server/server/add service-name=mt-pppoe interface=${targetInterface} default-profile=default one-session-per-host=yes disabled=no

# ${resultStepNum}. Display Result
:put "--------------------------------------------------------"
:put "PPPoE Server Enabled Successfully!"
:put "Interface: ${targetInterface}"
:put "NOTE: Create at least one Package (PPP Profile) from the dashboard's PPPoE page before adding room accounts."
:put "--------------------------------------------------------"
`;

    res.json({ script });
});


// Helper for cleaning expired users
async function runExpiredCleanup(logUsername = 'System Auto') {
    return await executeOnRouter(async (client) => {
        const users = await client.exec('/ip/hotspot/user/print');
        const expired = [];
        
        for (const u of users) {
            const uptime = u.uptime || '0s';
            const limitUptime = u['limit-uptime'] || '';
            const bytesOut = parseInt(u['bytes-out']) || 0;
            const bytesIn = parseInt(u['bytes-in']) || 0;
            const totalBytes = bytesOut + bytesIn;
            const limitBytesTotal = parseInt(u['limit-bytes-total']) || 0;
            const comment = (u.comment || '').toLowerCase();

            let isExpired = false;
            if (comment.includes('expired') || comment.includes('หมดอายุ')) {
                isExpired = true;
            }
            if (limitUptime && limitUptime !== '00:00:00' && limitUptime !== '0s' && uptime === limitUptime) {
                isExpired = true;
            }
            if (limitBytesTotal > 0 && totalBytes >= limitBytesTotal) {
                isExpired = true;
            }

            if (isExpired) {
                expired.push({ id: u['.id'], name: u.name });
            }
        }

        for (const item of expired) {
            try {
                await client.exec('/ip/hotspot/user/remove', { '.id': item.id });
            } catch (e) {}
        }

        if (expired.length > 0) {
            db.addLog(logUsername, 'ลบคูปองหมดอายุ', `ลบผู้ใช้งานที่หมดอายุแล้วจำนวน ${expired.length} บัญชี`);
        }
        return expired.length;
    });
}

// Expired Cleanup Configuration APIs
app.get('/api/mikrotik/hotspot/cleanup-config', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    res.json(await db.getAutoCleanupConfig());
});

app.post('/api/mikrotik/hotspot/cleanup-config', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const { autoCleanupExpired } = req.body;
    const updated = await db.saveAutoCleanupConfig({ autoCleanupExpired: !!autoCleanupExpired });
    db.addLog(req.user.username, 'ตั้งค่าลบคูปองหมดอายุ', `อัปเดตสถานะลบอัตโนมัติ: ${updated.autoCleanupExpired ? 'เปิด' : 'ปิด'}`);
    res.json(updated);
});

// Trigger Immediate Expired Cleanup
app.post('/api/mikrotik/hotspot/cleanup-expired', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const count = await runExpiredCleanup(req.user.username);
        res.json({ success: true, deletedCount: count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Automated background cleanup interval (every 30 minutes)
setInterval(async () => {
    try {
        const config = await db.getAutoCleanupConfig();
        if (config && config.autoCleanupExpired) {
            await runExpiredCleanup('Auto Task');
        }
    } catch (e) {
        // Silent catch for background task
    }
}, 30 * 60 * 1000);


// Bulk Generate Hotspot Users (Vouchers)
app.post('/api/mikrotik/hotspot/generate', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const { prefix, qty, profile, limitUptime, limitBytesTotal, siteTitle, packageName, price, contact } = req.body;
    const quantity = parseInt(qty) || 10;
    if (quantity <= 0 || quantity > 100) {
        return res.status(400).json({ error: 'Quantity must be between 1 and 100' });
    }

    const generatedUsers = [];
    const charPool = 'abcdefghijklmnopqrstuvwxyz23456789'; // alphanumeric without confusing chars (1, l, 0, o)
    const genRandomString = (len) => {
        let str = '';
        for (let i = 0; i < len; i++) {
            str += charPool.charAt(Math.floor(Math.random() * charPool.length));
        }
        return str;
    };

    const runPrefix = prefix || '';

    try {
        await executeOnRouter(async (client) => {
            for (let i = 0; i < quantity; i++) {
                // Generate a random username and password (6 chars each)
                const username = runPrefix + genRandomString(5);
                const password = genRandomString(6);
                
                const params = {
                    name: username,
                    password: password,
                    profile: profile || 'default',
                    comment: `Generated by Web Dashboard (${new Date().toLocaleDateString()})`
                };
                
                if (limitUptime) params['limit-uptime'] = limitUptime;
                if (limitBytesTotal) params['limit-bytes-total'] = limitBytesTotal;
                
                await client.exec('/ip/hotspot/user/add', params);
                generatedUsers.push({
                    username,
                    password,
                    profile: profile || 'default',
                    limitUptime: limitUptime || '',
                    limitBytesTotal: limitBytesTotal || '',
                    siteTitle: siteTitle || '',
                    packageName: packageName || '',
                    price: price || '',
                    contact: contact || ''
                });
            }
        });
        db.addLog(req.user.username, 'สร้างคูปองกลุ่ม', 'สร้างคูปองจำนวน ' + quantity + ' ใบ (โปรไฟล์: ' + profile + ')');
        res.json({ success: true, users: generatedUsers });
    } catch (err) {
        res.status(500).json({ error: `Failed during bulk generate: ${err.message}. ${generatedUsers.length} users were created.` });
    }
});

// ==========================================
// Firewall Block/Unblock & Schedule APIs
// ==========================================

const FIREWALL_SERVICES = {
    youtube: {
        comment: 'Block YouTube (Dashboard)',
        listName: 'blocked_youtube',
        domains: ['youtube.com', 'youtu.be', 'googlevideo.com', 'ytimg.com']
    },
    line: {
        comment: 'Block LINE (Dashboard)',
        listName: 'blocked_line',
        domains: ['line.me', 'line-apps.com', 'line-cdn.net']
    },
    games: {
        comment: 'Block Mobile Games (Dashboard)',
        listName: 'blocked_games',
        domains: ['roblox.com', 'rbxcdn.com', 'garena.com', 'freefiremobile.com', 'pubgmobile.com', 'proxima-beta.com', 'hoyoverse.com', 'genshinimpact.com', 'supercell.com', 'clashofclans.com']
    },
    ads: {
        comment: 'Block Ads & Trackers (Dashboard)',
        listName: 'blocked_ads',
        domains: ['doubleclick.net', 'adservice.google.com', 'googlesyndication.com', 'adnxs.com', 'admob.com', 'criteo.com', 'taboola.com', 'outbrain.com', 'appsflyer.com']
    },
    tiktok: {
        comment: 'Block TikTok (Dashboard)',
        listName: 'blocked_tiktok',
        domains: ['tiktok.com', 'tiktokcdn.com', 'byteoversea.com', 'musical.ly']
    },
    facebook: {
        comment: 'Block Facebook & IG (Dashboard)',
        listName: 'blocked_facebook',
        domains: ['facebook.com', 'fbcdn.net', 'instagram.com', 'cdninstagram.com']
    },
    adult: {
        comment: 'Block Adult Content (Dashboard)',
        listName: 'blocked_adult',
        domains: ['pornhub.com', 'xvideos.com', 'xnxx.com', 'stripchat.com', 'xhamster.com']
    },
    netflix: {
        comment: 'Block Netflix & Streaming (Dashboard)',
        listName: 'blocked_netflix',
        domains: ['netflix.com', 'nflxext.com', 'nflxvideo.net', 'disneyplus.com', 'bamgrid.com', 'viu.com', 'wetv.vip']
    },
    torrent: {
        comment: 'Block BitTorrent & P2P (Dashboard)',
        listName: 'blocked_torrent',
        domains: ['torrent.com', 'bittorrent.com', 'thepiratebay.org', '1337x.to', 'rarbg.to', 'yts.mx']
    },
    steam: {
        comment: 'Block Steam & PC Gaming (Dashboard)',
        listName: 'blocked_steam',
        domains: ['steampowered.com', 'steamcommunity.com', 'steamgames.com', 'epicgames.com', 'unrealengine.com']
    },
    crypto: {
        comment: 'Block Crypto Miners & Malware (Dashboard)',
        listName: 'blocked_crypto',
        domains: ['coinhive.com', 'coin-hive.com', 'crypto-loot.com', 'jsecoin.com', 'minr.pw', 'coin-have.com']
    }
};

// Get block status & schedule for all services
app.get('/api/mikrotik/firewall/status', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const status = await executeOnRouter(async (client) => {
            const filterRules = await client.exec('/ip/firewall/filter/print');
            const result = {};
            
            for (const [key, svc] of Object.entries(FIREWALL_SERVICES)) {
                const rule = filterRules.find(r => r.comment === svc.comment);
                let timeStart = '';
                let timeEnd = '';
                if (rule && rule.time) {
                    const parts = rule.time.split('-');
                    if (parts.length === 2) {
                        timeStart = parts[0].substring(0, 5); // HH:MM
                        timeEnd = parts[1].substring(0, 5);   // HH:MM
                    }
                }
                const days = rule && rule.days ? rule.days.split(',') : [];
                
                result[key] = {
                    blocked: rule ? rule.disabled === 'false' : false,
                    scheduleEnabled: !!(rule && (rule.time || rule.days)),
                    timeStart,
                    timeEnd,
                    days
                };
            }
            
            return result;
        });
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get custom address list rules
app.get('/api/mikrotik/firewall/custom-rules', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const rules = await executeOnRouter(async (client) => {
            const addrLists = await client.exec('/ip/firewall/address-list/print');
            return addrLists.filter(item => item.list === 'blocked_custom').map(item => ({
                id: item['.id'],
                address: item.address,
                comment: item.comment || '',
                disabled: item.disabled === 'true'
            }));
        });
        res.json(rules);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add custom domain block rule
app.post('/api/mikrotik/firewall/custom-rules', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const { domain, note } = req.body;
    if (!domain || !domain.trim()) {
        return res.status(400).json({ error: 'Domain/IP is required' });
    }
    const cleanDomain = domain.trim().toLowerCase();
    try {
        await executeOnRouter(async (client) => {
            const listName = 'blocked_custom';
            const addrLists = await client.exec('/ip/firewall/address-list/print');
            const exists = addrLists.some(item => item.list === listName && item.address === cleanDomain);
            if (!exists) {
                await client.exec('/ip/firewall/address-list/add', {
                    list: listName,
                    address: cleanDomain,
                    comment: note ? `Custom: ${note}` : 'Custom Block (Dashboard)'
                });
            }
            
            // Ensure drop filter rule for custom list exists
            const filterRules = await client.exec('/ip/firewall/filter/print');
            const ruleComment = 'Block Custom Domains (Dashboard)';
            const ruleExists = filterRules.some(r => r.comment === ruleComment);
            if (!ruleExists) {
                await client.exec('/ip/firewall/filter/add', {
                    chain: 'forward',
                    action: 'drop',
                    'dst-address-list': listName,
                    comment: ruleComment,
                    disabled: 'no'
                });
            }
        });
        db.addLog(req.user.username, 'เพิ่มกฎบล็อกกำหนดเอง', `บล็อกโดเมน: ${cleanDomain}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete custom domain block rule
app.delete('/api/mikrotik/firewall/custom-rules/:id', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        await executeOnRouter(async (client) => {
            await client.exec('/ip/firewall/address-list/remove', { '.id': req.params.id });
        });
        db.addLog(req.user.username, 'ลบกฎบล็อกกำหนดเอง', `ลบกฎ ID: ${req.params.id}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Toggle blocks and update schedule
app.post('/api/mikrotik/firewall/toggle', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const { service, block, scheduleEnabled, timeStart, timeEnd, days } = req.body;
    
    if (!FIREWALL_SERVICES[service]) {
        return res.status(400).json({ error: `Invalid service: ${service}` });
    }
    
    const svcConfig = FIREWALL_SERVICES[service];
    const targetBlockState = !!block;
    const ruleComment = svcConfig.comment;
    const listName = svcConfig.listName;
    const domains = svcConfig.domains;

    try {
        await executeOnRouter(async (client) => {
            const filterRules = await client.exec('/ip/firewall/filter/print');
            const existingRule = filterRules.find(r => r.comment === ruleComment);
            
            // Format schedule parameters
            const setParams = {
                disabled: targetBlockState ? 'no' : 'yes'
            };

            if (scheduleEnabled && timeStart && timeEnd) {
                setParams.time = `${timeStart}:00-${timeEnd}:00`;
            } else {
                setParams.time = '';
            }

            if (scheduleEnabled && Array.isArray(days) && days.length > 0) {
                setParams.days = days.join(',');
            } else {
                setParams.days = '';
            }

            if (existingRule) {
                setParams['.id'] = existingRule['.id'];
                await client.exec('/ip/firewall/filter/set', setParams);
            } else {
                if (targetBlockState) {
                    // Add address list items if needed
                    const addrLists = await client.exec('/ip/firewall/address-list/print');
                    for (const domain of domains) {
                        const exists = addrLists.some(item => item.list === listName && item.address === domain);
                        if (!exists) {
                            await client.exec('/ip/firewall/address-list/add', {
                                list: listName,
                                address: domain,
                                comment: 'Added by Web Dashboard'
                            });
                        }
                    }
                    
                    // Create filter rule
                    const addParams = {
                        chain: 'forward',
                        action: 'drop',
                        'dst-address-list': listName,
                        comment: ruleComment,
                        disabled: 'no'
                    };
                    if (scheduleEnabled && timeStart && timeEnd) {
                        addParams.time = `${timeStart}:00-${timeEnd}:00`;
                    }
                    if (scheduleEnabled && Array.isArray(days) && days.length > 0) {
                        addParams.days = days.join(',');
                    }

                    await client.exec('/ip/firewall/filter/add', addParams);
                }
            }
        });
        
        db.addLog(req.user.username, targetBlockState ? 'ตั้งค่าการบล็อก' : 'ปิดการบล็อก', `บริการ: ${service} (สเกดดูล: ${scheduleEnabled ? 'เปิด' : 'ปิด'})`);
        res.json({ success: true, blocked: targetBlockState });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

// ==========================================
// Background: Snapshot Hotspot Sessions (พรบ Log)
// ตรวจสอบทุก 5 นาที — บันทึก user ใหม่ / user ที่ออกจากระบบ
// ครอบคลุมทุกไซต์งาน ไม่ใช่แค่ไซต์ที่ active อยู่
// ==========================================
let lastSnapshotSessionsBySite = new Map(); // siteId -> Map(sessionId -> session)
let lastPppoeSessionsBySite = new Map(); // siteId -> Map(sessionId -> session), for room billing usage

// Dedupe state for DNS visit-history polling (see parseDnsLogMessage below).
// RouterOS log '.id's reset on router reboot, so they're not a safe permanent
// watermark — instead we fingerprint by ip+domain+minute and keep a bounded
// recent-history set per site (also collapses the repeat queries browsers/OSes
// send for the same domain every few seconds).
let recentDnsFingerprintsBySite = new Map(); // siteId -> Set(fingerprint)
const MAX_DNS_FINGERPRINTS = 2000;

function rememberDnsFingerprint(siteId, fp) {
    let set = recentDnsFingerprintsBySite.get(siteId);
    if (!set) {
        set = new Set();
        recentDnsFingerprintsBySite.set(siteId, set);
    }
    set.add(fp);
    if (set.size > MAX_DNS_FINGERPRINTS) {
        const toDrop = Math.floor(MAX_DNS_FINGERPRINTS * 0.1);
        let i = 0;
        for (const v of set) {
            set.delete(v);
            if (++i >= toDrop) break;
        }
    }
}

async function snapshotHotspotSessions() {
    const sitesData = db.getSites ? await db.getSites() : { sites: [], activeSiteId: '' };
    const sites = sitesData.sites || [];
    if (sites.length === 0) return;
    // Promise.allSettled (not Promise.all) — one offline/slow router must not
    // stop the others from being polled on schedule.
    await Promise.allSettled(sites.map(site => snapshotSiteSessions(site)));
}

async function snapshotSiteSessions(site) {
    try {
        if (!site.host || !site.username) return; // ไซต์นี้ยังไม่ได้ตั้งค่าเราท์เตอร์
        const siteName = site.name || 'Main';

        const { currentSessions, dnsLogLines, pppoeSessions } = await executeOnRouter(async (client) => {
            const list = await client.exec('/ip/hotspot/active/print');
            const sessions = list.map(item => ({
                id: item['.id'],
                user: item.user,
                address: item.address,
                macAddress: item['mac-address'] || '',
                uptime: item.uptime || '0s',
                bytesIn: parseInt(item['bytes-in']) || 0,
                bytesOut: parseInt(item['bytes-out']) || 0,
                loginBy: item['login-by'] || ''
            }));

            // Fetch full log buffer and filter client-side for dns topic entries
            // (same "fetch all, filter in JS" convention used for firewall rules
            // below) — fail-open if DNS logging isn't configured on the router yet.
            let logs = [];
            try {
                logs = await client.exec('/log/print');
            } catch (e) {
                logs = [];
            }
            const dns = logs.filter(l => (l.topics || '').includes('dns'));

            // PPPoE room sessions — fail-open if PPPoE server isn't set up on
            // this site yet (not every site necessarily has room accounts).
            let pppoe = [];
            try {
                const pppoeList = await client.exec('/ppp/active/print');
                pppoe = pppoeList.filter(item => item.service === 'pppoe').map(item => ({
                    id: item['.id'],
                    user: item.name,
                    address: item.address || '',
                    uptime: item.uptime || '0s',
                    bytesIn: parseInt(item['bytes-in']) || 0,
                    bytesOut: parseInt(item['bytes-out']) || 0
                }));
            } catch (e) {
                pppoe = [];
            }

            return { currentSessions: sessions, dnsLogLines: dns, pppoeSessions: pppoe };
        }, site.id);

        const lastSessions = lastSnapshotSessionsBySite.get(site.id) || new Map();
        const currentMap = new Map(currentSessions.map(s => [s.id, s]));

        // ตรวจหา session ใหม่ที่ยังไม่ได้บันทึก
        for (const session of currentSessions) {
            if (!lastSessions.has(session.id)) {
                // User เชื่อมต่อใหม่
                await db.addHotspotSessionLog({
                    loginTime: new Date().toISOString(),
                    username: session.user,
                    ipAddress: session.address,
                    macAddress: session.macAddress,
                    loginBy: session.loginBy,
                    uptime: session.uptime,
                    bytesIn: session.bytesIn,
                    bytesOut: session.bytesOut,
                    siteName,
                    status: 'connected',
                    routerSessionId: session.id
                });
            }
        }

        // ตรวจหา session ที่หายไป (user disconnect)
        for (const [id, prevSession] of lastSessions.entries()) {
            if (!currentMap.has(id)) {
                // User ออกจากระบบแล้ว — บันทึก disconnect log
                await db.addHotspotSessionLog({
                    loginTime: new Date(Date.now() - parseUptimeToMs(prevSession.uptime)).toISOString(),
                    logoutTime: new Date().toISOString(),
                    username: prevSession.user,
                    ipAddress: prevSession.address,
                    macAddress: prevSession.macAddress,
                    loginBy: prevSession.loginBy,
                    uptime: prevSession.uptime,
                    bytesIn: prevSession.bytesIn,
                    bytesOut: prevSession.bytesOut,
                    siteName,
                    status: 'disconnected',
                    routerSessionId: id
                });
            }
        }

        lastSnapshotSessionsBySite.set(site.id, currentMap);

        // ----- DNS visit history correlation (พรบ มาตรา 26 — domain-level) -----
        if (dnsLogLines.length > 0) {
            const ipToClient = new Map();
            for (const s of currentSessions) {
                if (s.address) ipToClient.set(s.address, { username: s.user, macAddress: s.macAddress });
            }

            const siteDnsFingerprints = recentDnsFingerprintsBySite.get(site.id) || new Set();
            const newRows = [];
            for (const line of dnsLogLines) {
                const parsed = parseDnsLogMessage(line.message || '');
                if (!parsed) {
                    if (process.env.DEBUG_DNS_LOG) console.log('[DEBUG_DNS_LOG]', site.name, 'unmatched:', line.message);
                    continue;
                }

                const fp = parsed.sourceIp + '|' + parsed.domain + '|' + Math.floor(Date.now() / 60000);
                if (siteDnsFingerprints.has(fp)) continue;
                rememberDnsFingerprint(site.id, fp);

                const client = ipToClient.get(parsed.sourceIp);
                newRows.push({
                    queryTime: new Date().toISOString(),
                    username: client ? client.username : '',
                    ipAddress: parsed.sourceIp,
                    macAddress: client ? client.macAddress : '',
                    domain: parsed.domain,
                    siteName
                });
            }

            if (newRows.length > 0) {
                try {
                    await db.addDnsQueryLogsBulk(newRows);
                } catch (e) {
                    // Silent — same failure posture as the rest of this function
                }
            }
        }

        // ----- PPPoE room usage logging (billing) -----
        const lastPppoe = lastPppoeSessionsBySite.get(site.id) || new Map();
        const currentPppoeMap = new Map(pppoeSessions.map(s => [s.id, s]));

        for (const session of pppoeSessions) {
            if (!lastPppoe.has(session.id)) {
                await db.addPppoeUsageLog({
                    loginTime: new Date().toISOString(),
                    username: session.user,
                    ipAddress: session.address,
                    bytesIn: session.bytesIn,
                    bytesOut: session.bytesOut,
                    siteName,
                    status: 'connected'
                });
            }
        }
        for (const [id, prevSession] of lastPppoe.entries()) {
            if (!currentPppoeMap.has(id)) {
                await db.addPppoeUsageLog({
                    loginTime: new Date(Date.now() - parseUptimeToMs(prevSession.uptime)).toISOString(),
                    logoutTime: new Date().toISOString(),
                    username: prevSession.user,
                    ipAddress: prevSession.address,
                    bytesIn: prevSession.bytesIn,
                    bytesOut: prevSession.bytesOut,
                    siteName,
                    status: 'disconnected'
                });
            }
        }

        lastPppoeSessionsBySite.set(site.id, currentPppoeMap);

    } catch (e) {
        // Silent — this router may be offline temporarily; other sites unaffected
    }
}

// Parses a RouterOS `/log/print` message (topics containing "dns") into
// { sourceIp, domain }, or null if the line doesn't match a recognized
// DNS-query pattern. RouterOS's exact wording for DNS query log entries
// varies by RouterOS version — this is a best-effort permissive parser.
// Calibrate against real output: enable DEBUG_DNS_LOG=1 and check `pm2 logs`
// for "[DEBUG_DNS_LOG] unmatched:" lines, then adjust the patterns below.
function parseDnsLogMessage(msg) {
    if (!msg) return null;

    // Pattern A: "query from 172.16.1.247: #3 example.com. A"
    // Note: the "dns" prefix visible on-screen (WinBox/terminal) is actually
    // the separate `topics` field concatenated for display — the API's raw
    // `message` field does NOT include it, confirmed against live router output.
    let m = msg.match(/query from (\d{1,3}(?:\.\d{1,3}){3}).*?\s([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\.?\s/i);
    if (m) return { sourceIp: m[1], domain: m[2].toLowerCase() };

    // Pattern B: "resolving example.com from 172.16.1.247"
    m = msg.match(/resolving\s+([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\.?\s+from\s+(\d{1,3}(?:\.\d{1,3}){3})/i);
    if (m) return { sourceIp: m[2], domain: m[1].toLowerCase() };

    return null;
}

// แปลง RouterOS uptime string เป็น milliseconds
function parseUptimeToMs(uptime) {
    if (!uptime) return 0;
    let ms = 0;
    const wMatch = uptime.match(/(\d+)w/); if (wMatch) ms += parseInt(wMatch[1]) * 7 * 24 * 3600000;
    const dMatch = uptime.match(/(\d+)d/); if (dMatch) ms += parseInt(dMatch[1]) * 24 * 3600000;
    const hMatch = uptime.match(/(\d+)h/); if (hMatch) ms += parseInt(hMatch[1]) * 3600000;
    const mMatch = uptime.match(/(\d+)m/); if (mMatch) ms += parseInt(mMatch[1]) * 60000;
    const sMatch = uptime.match(/(\d+)s/); if (sMatch) ms += parseInt(sMatch[1]) * 1000;
    return ms;
}

// Snapshot ทุก 5 นาที
setInterval(snapshotHotspotSessions, 5 * 60 * 1000);
// รัน snapshot แรกหลัง server เริ่ม 30 วินาที
setTimeout(snapshotHotspotSessions, 30 * 1000);

// Daily purge log เก่าเกิน 90 วัน (ทุก 24 ชั่วโมง)
setInterval(async () => {
    const purged = await db.purgeOldHotspotLogs();
    if (purged > 0) {
        db.addLog('System Auto', 'Purge Log เก่า', `ลบ hotspot log เก่าเกิน 90 วัน จำนวน ${purged} รายการ`);
    }
    const purgedDns = await db.purgeOldDnsQueryLogs();
    if (purgedDns > 0) {
        db.addLog('System Auto', 'Purge DNS Log เก่า', `ลบ DNS query log เก่าเกิน 90 วัน จำนวน ${purgedDns} รายการ`);
    }
}, 24 * 60 * 60 * 1000);
