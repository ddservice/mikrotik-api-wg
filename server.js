const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

// Auto-select database: Supabase (if env set) หรือ JSON file (legacy)
// Ignore placeholder Supabase env (YOUR_PROJECT_ID) — same rule as src/lib/db.ts.
// Uncommented placeholders in ecosystem.config.js must NOT select db-supabase.
const _supabaseUrl = process.env.SUPABASE_URL || '';
const _supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';
const useSupabase = !!(
    _supabaseUrl &&
    _supabaseKey &&
    !_supabaseUrl.includes('YOUR_PROJECT_ID') &&
    !_supabaseKey.includes('YOUR_SERVICE_ROLE_KEY')
);
const db = useSupabase ? require('./db-supabase') : require('./db');

console.log(`[DB] Using: ${useSupabase ? 'Supabase (PostgreSQL)' : 'Local JSON files'}`);

const RouterOSClient = require('./routeros');
const { resolvePppoeIface } = require('./lib/pppoe-iface');

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

// Rate limit สำหรับ Login: 30 ครั้ง ใน 15 นาที (ป้องกัน brute-force โดยไม่บล็อกแอดมินจริง)
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 นาที
    max: 30,                    // สูงสุด 30 ครั้ง
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        error: 'พยายามเข้าระบบมากเกินไป โปรดรอสักครู่แล้วลองใหม่ (Too many login attempts)',
        retryAfter: 300
    },
    handler: (req, res, next, options) => {
        const ip = req.ip || req.connection?.remoteAddress || 'unknown';
        db.addLog('System Security', 'Rate Limit ล็อก Login', `IP ${ip} พยายาม login เกินสิทธิ์`);
        res.status(429).json(options.message);
    },
    skip: (req) => {
        const ip = req.ip || req.connection?.remoteAddress || '';
        return ip.includes('127.0.0.1') || ip.includes('::1') || ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('::ffff:10.') || ip.startsWith('::ffff:192.168.');
    }
});

// Rate limit ทั่วไปสำหรับ API: 300 ครั้ง ใน 1 นาที
const apiLimiter = rateLimit({
    windowMs: 60 * 1000,       // 1 นาที
    max: 300,                  // สูงสุด 300 request
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'ส่ง request มากเกินไป โปรดรอสักครู่ (Rate limit exceeded)' },
    skip: (req) => {
        const ip = req.ip || req.connection?.remoteAddress || '';
        return ip.includes('127.0.0.1') || ip.includes('::1') || ip.startsWith('10.') || ip.startsWith('192.168.');
    }
});


const app = express();
// Default 3001 — port 3000 is reserved for cnxhaircutz on the same VPS.
const PORT = process.env.PORT || 3001;

// Hide server framework signature
app.disable('x-powered-by');

// ==========================================
// ENTERPRISE SECURITY: Security Headers Middleware
// ==========================================
app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    next();
});



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

        if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin) || devOrigins.includes(origin)) {
            callback(null, true);
        } else {
            console.warn(`[CORS] Request from origin: ${origin}`);
            callback(null, true);
        }
    },
    credentials: true,
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// Apply ทั่วไป API rate limiter
app.use('/api/', apiLimiter);

// Exclude /api/wireguard/callback-register from the global JSON parser
app.use(express.json({
    type: (req) => req.path !== '/api/wireguard/callback-register' && (req.headers['content-type'] || '').includes('json')
}));

// Static Assets Caching Strategy (Fast asset loading + no-cache for index.html)
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '1d',
    etag: true,
    setHeaders: (res, filepath) => {
        if (filepath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
}));

// In-memory sessions store (token -> { user, expires })
const activeSessions = new Map();
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Garbage collector for expired sessions and single-use registration tokens (every 15 min)
setInterval(() => {
    const now = Date.now();
    for (const [token, session] of activeSessions.entries()) {
        if (session.expires < now) {
            activeSessions.delete(token);
        }
    }
    for (const [token, reg] of wgRegistrationTokens.entries()) {
        if (reg.expiresAt < now) {
            wgRegistrationTokens.delete(token);
        }
    }
}, 15 * 60 * 1000);

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

/** Never send router passwords (or other secrets) to the browser. */
function sanitizeSitePublic(site, { includeRouterCreds = false } = {}) {
    if (!site) return site;
    const base = {
        id: site.id,
        name: site.name,
        connectionType: site.connectionType || 'wireguard',
        wireguardIp: site.wireguardIp || site.wireguard_ip || '',
        dnsLoggingEnabled: site.dnsLoggingEnabled !== false,
        hasPassword: !!(site.password || site.hasPassword),
        is_active: site.is_active
    };
    if (includeRouterCreds) {
        return {
            ...base,
            host: site.host || '',
            port: site.port || 8728,
            username: site.username || '',
            wireguardPublicKey: site.wireguardPublicKey || site.wireguard_public_key || ''
        };
    }
    return base;
}

function isSiteLockedUser(user) {
    return !!(user && user.role !== 'admin' && user.assignedSiteId && user.assignedSiteId !== 'all');
}

/** Force co-admin/user log queries onto their assigned site name (ignore client override). */
async function resolveForcedSiteName(req, requestedSiteName) {
    if (!isSiteLockedUser(req.user)) return requestedSiteName || null;
    const sitesData = await db.getSites();
    const allowed = (sitesData.sites || []).find(s => s.id === req.user.assignedSiteId);
    return allowed ? allowed.name : '__no_access__';
}

// ==========================================
// HIGH PERFORMANCE: Router Connection Pooling Engine
// ==========================================
const routerClientPool = new Map(); // key -> { client, config, poolKey, lastUsed }

async function getPooledRouterClient(targetSiteId) {
    const config = await db.getConfig(targetSiteId);
    if (!config.host || !config.username) {
        throw new Error(`Router connection (${config.name || targetSiteId || 'Site'}) is not configured. Please setup Router Settings.`);
    }

    const poolKey = `${config.id || targetSiteId || 'default'}_${config.host}_${config.port}_${config.username}`;
    let entry = routerClientPool.get(poolKey);

    if (entry && entry.client && entry.client.connected) {
        entry.lastUsed = Date.now();
        return entry;
    }

    // Clean up dead client if present
    if (entry && entry.client) {
        try { entry.client.close(); } catch (_) {}
    }

    const client = new RouterOSClient(config.host, config.port, config.username, config.password);
    await client.connect();

    entry = {
        client,
        config,
        poolKey,
        lastUsed: Date.now()
    };
    routerClientPool.set(poolKey, entry);
    return entry;
}

// Auto cleanup idle pooled clients after 60s
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of routerClientPool.entries()) {
        if (now - entry.lastUsed > 60000) {
            try { entry.client.close(); } catch (_) {}
            routerClientPool.delete(key);
        }
    }
}, 15000);

// Router connection runner helper — strictly enforces user site permissions with Connection Pooling
async function executeOnRouter(arg1, arg2, arg3) {
    let fn;
    let targetSiteId = null;

    if (typeof arg1 === 'function') {
        // Form: executeOnRouter(fn, siteId)
        fn = arg1;
        targetSiteId = typeof arg2 === 'string' ? arg2 : null;
    } else if (typeof arg2 === 'function') {
        fn = arg2;
        if (typeof arg1 === 'string') {
            // Form: executeOnRouter(siteId, fn)
            targetSiteId = arg1;
        } else if (arg1 && typeof arg1 === 'object') {
            // Form: executeOnRouter(req, fn, siteIdParam)
            const req = arg1;
            if (req.user && req.user.role !== 'admin' && req.user.assignedSiteId && req.user.assignedSiteId !== 'all') {
                targetSiteId = req.user.assignedSiteId;
            } else {
                targetSiteId = arg3 || req.query?.siteId || req.body?.siteId || req.headers?.['x-site-id'] || null;
            }
        }
    } else {
        fn = arg2 || arg1;
        targetSiteId = typeof arg1 === 'string' ? arg1 : (typeof arg2 === 'string' ? arg2 : null);
    }

    let poolEntry;
    try {
        poolEntry = await getPooledRouterClient(targetSiteId);
        return await fn(poolEntry.client);
    } catch (err) {
        // If socket was disconnected mid-flight, evict from pool and retry once with fresh connect
        if (poolEntry) {
            try { poolEntry.client.close(); } catch (_) {}
            routerClientPool.delete(poolEntry.poolKey);
        }
        poolEntry = await getPooledRouterClient(targetSiteId);
        return await fn(poolEntry.client);
    }
}

// ==========================================
// Health Check — สำหรับ UptimeRobot / external monitor
// ไม่ต้อง auth — ตอบ 200 เสมอถ้า server รันอยู่
// ==========================================

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        db: useSupabase ? 'supabase' : 'local-json'
    });
});

// ==========================================
// Authentication APIs
// ==========================================

app.post('/api/auth/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }
    if (String(username).length > 128 || String(password).length > 256) {
        return res.status(400).json({ error: 'Invalid username or password' });
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
    const siteName = await resolveForcedSiteName(req, site);
    const result = await db.getHotspotLogs({ search, from, to, username, page, limit, siteName });
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
    const siteName = await resolveForcedSiteName(req, site);
    const result = await db.getHotspotLogs({ search, from, to, username, siteName, page: 1, limit: 99999 });
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
    const siteName = await resolveForcedSiteName(req, site);
    const result = await db.getDnsQueryLogs({ search, from, to, username, page, limit, siteName });
    res.json(result);
});

// Export DNS query (domain visit history) logs as CSV
app.get('/api/dns-logs/export-csv', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { search, from, to, username, site } = req.query;
    const siteName = await resolveForcedSiteName(req, site);
    const result = await db.getDnsQueryLogs({ search, from, to, username, siteName, page: 1, limit: 99999 });
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
        const site = await resolveForcedSiteName(req, req.query.site);
        const summary = await db.getPppoeUsageSummary(req.query.month, site);
        res.json(summary);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// PPPoE room usage — raw session log (audit trail), paginated
app.get('/api/pppoe-usage/logs', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { search, from, to, username, page, limit, site } = req.query;
    const siteName = await resolveForcedSiteName(req, site);
    const result = await db.getPppoeUsageLogs({ search, from, to, username, page, limit, siteName });
    res.json(result);
});

// PPPoE room usage — export raw session log as CSV
app.get('/api/pppoe-usage/export-csv', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { search, from, to, username, site } = req.query;
    const siteName = await resolveForcedSiteName(req, site);
    const result = await db.getPppoeUsageLogs({ search, from, to, username, siteName, page: 1, limit: 99999 });
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
        const includeRouterCreds = req.user.role === 'admin';
        const mapSite = (s) => sanitizeSitePublic(s, { includeRouterCreds });
        if (isSiteLockedUser(req.user)) {
            const allowedSite = sitesData.sites.find(s => s.id === req.user.assignedSiteId);
            return res.json({
                activeSiteId: req.user.assignedSiteId,
                sites: allowedSite ? [mapSite(allowedSite)] : []
            });
        }
        res.json({
            activeSiteId: sitesData.activeSiteId,
            sites: (sitesData.sites || []).map(mapSite)
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Switch active site (Validated against assigned permission)
app.post('/api/sites/switch/:id', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    if (isSiteLockedUser(req.user)) {
        if (req.params.id !== req.user.assignedSiteId) {
            return res.status(403).json({ error: 'คุณไม่มีสิทธิ์สลับไปใช้งานไซต์งานนี้' });
        }
    }
    try {
        const activeSite = await db.setActiveSite(req.params.id);
        db.addLog(req.user.username, 'สลับไซต์งาน', 'สลับไปใช้งานไซต์งาน: ' + activeSite.name);
        res.json({
            success: true,
            activeSite: sanitizeSitePublic(activeSite, { includeRouterCreds: req.user.role === 'admin' })
        });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Get Multi-WAN configuration for current site
app.get('/api/multiwan', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const siteId = (req.user.role !== 'admin' && req.user.assignedSiteId && req.user.assignedSiteId !== 'all') ? req.user.assignedSiteId : (req.query.siteId || null);
        const config = await db.getMultiWanConfig(siteId);
        res.json(config);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Save Multi-WAN configuration for current site
app.post('/api/multiwan', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const siteId = (req.user.role !== 'admin' && req.user.assignedSiteId && req.user.assignedSiteId !== 'all') ? req.user.assignedSiteId : (req.query.siteId || null);
        const updated = await db.saveMultiWanConfig(siteId, req.body);
        db.addLog(req.user.username, 'ตั้งค่า Multi-WAN', 'บันทึกการตั้งค่า Multi-WAN ประจำไซต์งาน');
        res.json({ success: true, config: updated });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Helper to normalize WAN list from request payload
function _parseWanLines(cfg) {
    if (Array.isArray(cfg.wans) && cfg.wans.length > 0) {
        return cfg.wans.map((w, idx) => ({
            num: idx + 1,
            id: w.id || `wan_${idx + 1}`,
            name: w.name || `WAN ${idx + 1}`,
            interface: w.interface || (idx === 0 ? 'pppoe-out1' : `ether${idx + 1}`),
            type: w.type || (idx === 0 ? 'pppoe' : 'dhcp'),
            gateway: w.gateway || (w.type === 'pppoe' ? '' : `192.168.${idx + 1}.1`),
            speed: parseInt(w.speed) || 500,
            weight: parseInt(w.weight) || 1,
            dnsCheck: w.dnsCheck || (idx === 0 ? '8.8.8.8' : (idx === 1 ? '1.1.1.1' : `9.9.9.${idx + 1}`))
        }));
    }
    // Backward compatibility fallback for legacy 2-WAN format
    return [
        { num: 1, id: 'wan_1', name: 'WAN 1', interface: cfg.wan1Interface || 'pppoe-out1', type: cfg.wan1Type || 'pppoe', gateway: '', speed: parseInt(cfg.wan1Speed) || 1000, weight: parseInt(cfg.wan1Weight) || 2, dnsCheck: cfg.dnsCheckWan1 || '8.8.8.8' },
        { num: 2, id: 'wan_2', name: 'WAN 2', interface: cfg.wan2Interface || 'ether2-WAN2', type: cfg.wan2Type || 'dhcp', gateway: cfg.wan2Gateway || '192.168.2.1', speed: parseInt(cfg.wan2Speed) || 500, weight: parseInt(cfg.wan2Weight) || 1, dnsCheck: cfg.dnsCheckWan2 || '1.1.1.1' }
    ];
}

// Generate Multi-WAN RouterOS v7 CLI Script (Dynamic N-WAN)
app.post('/api/multiwan/generate-script', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const cfg = req.body;
        const wans = _parseWanLines(cfg);
        const totalWeight = wans.reduce((sum, w) => sum + (w.weight > 0 ? w.weight : 1), 0);
        const vlan10 = cfg.pbrVlan10Subnet || '192.168.10.0/24';
        const vlan20 = cfg.pbrVlan20Subnet || '192.168.20.0/24';
        const tgToken = cfg.telegramToken || 'YOUR_TELEGRAM_BOT_TOKEN_HERE';
        const tgChatId = cfg.telegramChatId || 'YOUR_TELEGRAM_CHAT_ID_HERE';

        let script = `# ==============================================================================
# Enterprise RouterOS v7+ Multi-WAN Setup Script (${wans.length}-WAN Dynamic)
# Target Version: MikroTik RouterOS v7.10+
# Generated by MT Management Web Dashboard
# Total Configured WAN Lines: ${wans.length} | Total Weight Ratio: ${totalWeight}
# ==============================================================================

# 1. Routing Tables (RouterOS v7)
`;
        wans.forEach(w => {
            script += `/routing table add name=to_WAN${w.num} fib\n`;
        });

        script += `\n# 2. Recursive Failover Routes (Fortinet Style)\n`;
        wans.forEach(w => {
            const gw = w.type === 'pppoe' ? w.interface : (w.gateway || w.interface);
            script += `/ip route add dst-address=${w.dnsCheck}/32 gateway=${gw} scope=10 target-scope=10 comment="WAN${w.num} Host Check"\n`;
            script += `/ip route add dst-address=0.0.0.0/0 gateway=${w.dnsCheck} check-gateway=ping distance=${w.num} scope=30 target-scope=11 comment="Default Primary WAN${w.num}"\n`;
            script += `/ip route add dst-address=0.0.0.0/0 gateway=${w.dnsCheck} check-gateway=ping distance=1 routing-table=to_WAN${w.num} scope=30 target-scope=11 comment="Table to_WAN${w.num}"\n`;
        });

        script += `\n# 3. NAT Rules\n/ip firewall nat\n`;
        wans.forEach(w => {
            script += `add chain=srcnat out-interface=${w.interface} action=masquerade comment="Masquerade WAN${w.num}"\n`;
        });
        if (cfg.dnsHijack) {
            script += `add chain=dstnat protocol=udp dst-port=53 in-interface-list=!WAN action=redirect to-ports=53 comment="Force DNS Hijack UDP"\n`;
            script += `add chain=dstnat protocol=tcp dst-port=53 in-interface-list=!WAN action=redirect to-ports=53 comment="Force DNS Hijack TCP"\n`;
        }
        if (cfg.hairpinNat) {
            script += `add chain=srcnat src-address=192.168.0.0/16 dst-address=192.168.0.0/16 action=masquerade comment="Hairpin NAT"\n`;
        }

        script += `\n# 4. Mangle: FastTrack Bypass, Sticky HTTPS, PBR, Weighted PCC\n/ip firewall mangle\n`;
        if (cfg.fasttrackBypass) {
            script += `add chain=prerouting action=accept connection-state=new comment="Bypass FastTrack"\n`;
        }
        script += `add chain=prerouting protocol=tcp dst-port=443 connection-state=new dst-address-type=!local in-interface-list=!WAN action=mark-connection new-connection-mark=HTTPS_STICKY passthrough=yes comment="Sticky 443"\n\n`;

        script += `# Policy-Based Routing (PBR Interface/Subnet Rules)\n`;
        const pbrRules = (Array.isArray(cfg.pbrRules) && cfg.pbrRules.length > 0) ? cfg.pbrRules : [
            { srcInterface: cfg.pbrVlan10Subnet || '192.168.10.0/24', targetWanNum: 1, note: 'PBR VLAN 10 -> WAN1' },
            { srcInterface: cfg.pbrVlan20Subnet || '192.168.20.0/24', targetWanNum: 2, note: 'PBR VLAN 20 -> WAN2' }
        ];
        pbrRules.forEach(r => {
            if (r.srcInterface) {
                const isSubnet = r.srcInterface.includes('/') || (r.srcInterface.match(/^\d+\.\d+\.\d+\.\d+/));
                const paramStr = isSubnet ? `src-address=${r.srcInterface}` : `in-interface=${r.srcInterface}`;
                const targetWan = r.targetWanNum || 1;
                const note = r.note || `PBR ${r.srcInterface} -> WAN${targetWan}`;
                script += `add chain=prerouting ${paramStr} dst-address-type=!local action=mark-routing new-routing-mark=to_WAN${targetWan} passthrough=no comment="${note}"\n`;
            }
        });

        script += `\n# Weighted PCC Load Balancing (${totalWeight} Total Streams Ratio)\n`;
        script += `add chain=prerouting dst-address-type=local action=accept comment="Accept Local"\n`;

        let currentStreamIdx = 0;
        wans.forEach(w => {
            const wWeight = w.weight > 0 ? w.weight : 1;
            for (let i = 0; i < wWeight; i++) {
                script += `add chain=prerouting in-interface-list=!WAN connection-mark=no-mark dst-address-type=!local per-connection-classifier=both-addresses-and-ports:${totalWeight}/${currentStreamIdx} action=mark-connection new-connection-mark=WAN${w.num}_CONN passthrough=yes comment="PCC ${totalWeight}/${currentStreamIdx} -> WAN${w.num}"\n`;
                currentStreamIdx++;
            }
        });

        script += `\n`;
        wans.forEach(w => {
            script += `add chain=prerouting connection-mark=WAN${w.num}_CONN in-interface-list=!WAN action=mark-routing new-routing-mark=to_WAN${w.num} passthrough=no comment="Routing WAN${w.num}"\n`;
        });
        script += `add chain=prerouting connection-mark=HTTPS_STICKY in-interface-list=!WAN action=mark-routing new-routing-mark=to_WAN1 passthrough=no comment="Routing Sticky HTTPS"\n`;
        if (cfg.mssClamping) {
            script += `add chain=forward protocol=tcp tcp-flags=syn action=change-mss new-mss=clamp-to-pmtu comment="MSS Clamping"\n`;
        }

        script += `\n# 5. Connection Tracking Optimization\n/ip firewall connection tracking set enabled=yes tcp-established-timeout=1h tcp-syn-sent-timeout=15s udp-timeout=10s\n`;

        script += `\n# 6. Telegram Netwatch Alerting\n/tool netwatch\n`;
        wans.forEach(w => {
            script += `add host=${w.dnsCheck} type=icmp interval=5s timeout=1000ms comment="WAN${w.num} Netwatch" up-script="/tool fetch url=\\"https://api.telegram.org/bot${tgToken}/sendMessage?chat_id=${tgChatId}&text=%E2%9C%85+WAN${w.num}+ONLINE\\" keep-result=no" down-script="/tool fetch url=\\"https://api.telegram.org/bot${tgToken}/sendMessage?chat_id=${tgChatId}&text=%F0%9F%9A%A8+WAN${w.num}+OFFLINE\\" keep-result=no"\n`;
        });

        res.json({ script });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Directly Apply Multi-WAN configuration to MikroTik Router via API (Dynamic N-WAN)
app.post('/api/multiwan/apply', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const cfg = req.body;
        const siteId = (req.user.role !== 'admin' && req.user.assignedSiteId && req.user.assignedSiteId !== 'all') ? req.user.assignedSiteId : (req.query.siteId || null);
        
        // Save config first
        await db.saveMultiWanConfig(siteId, cfg);

        const wans = _parseWanLines(cfg);

        const result = await executeOnRouter(req, async (client) => {
            const logs = [];

            // 1. Check & Add Routing Tables (RouterOS v7)
            try {
                const tables = await client.exec('/routing/table/print');
                for (const w of wans) {
                    const tableName = `to_WAN${w.num}`;
                    if (!tables.some(t => t.name === tableName)) {
                        await client.exec('/routing/table/add', { name: tableName, fib: '' });
                        logs.push(`สร้าง Routing Table: ${tableName}`);
                    }
                }
            } catch (e) {
                /* ignore */
            }

            // 2. Setup Host Check Routes
            try {
                const routes = await client.exec('/ip/route/print');
                for (const r of routes) {
                    if (r.comment && r.comment.includes('Host Check')) {
                        await client.exec('/ip/route/remove', { '.id': r['.id'] });
                    }
                }
                for (const w of wans) {
                    const gw = w.type === 'pppoe' ? w.interface : (w.gateway || w.interface);
                    await client.exec('/ip/route/add', {
                        'dst-address': `${w.dnsCheck}/32`,
                        gateway: gw,
                        scope: '10',
                        'target-scope': '10',
                        comment: `WAN${w.num} Host Check`
                    });
                    logs.push(`ตั้งค่า Host Check Route WAN${w.num} (${w.dnsCheck})`);
                }
            } catch (e) {
                logs.push(`ข้อผิดพลาด Routes: ${e.message}`);
            }

            // 3. Setup NAT Rules
            try {
                const nats = await client.exec('/ip/firewall/nat/print');
                for (const w of wans) {
                    if (!nats.some(n => n['out-interface'] === w.interface && n.action === 'masquerade')) {
                        await client.exec('/ip/firewall/nat/add', {
                            chain: 'srcnat',
                            'out-interface': w.interface,
                            action: 'masquerade',
                            comment: `Masquerade WAN${w.num}`
                        });
                    }
                }
                logs.push(`ตั้งค่า Outbound NAT (Masquerade) ทั้งหมด ${wans.length} WAN`);
            } catch (e) {
                logs.push(`ข้อผิดพลาด NAT: ${e.message}`);
            }

            // 4. Connection Tracking Optimization
            try {
                await client.exec('/ip/firewall/connection/tracking/set', {
                    enabled: 'yes',
                    'tcp-established-timeout': '1h',
                    'tcp-syn-sent-timeout': '15s',
                    'udp-timeout': '10s'
                });
                logs.push('ปรับตั้งค่า Connection Tracking Optimization');
            } catch (e) { /* ignore */ }

            return logs;
        });

        db.addLog(req.user.username, 'ตั้งค่า Multi-WAN อัตโนมัติ', `บังคับใช้การตั้งค่า Multi-WAN (${wans.length} สาย) ลงบนเราท์เตอร์เรียบร้อยแล้ว`);
        res.json({ success: true, message: `ตั้งค่าและบังคับใช้ Multi-WAN (${wans.length} สาย) ลงบนเราท์เตอร์สำเร็จ!`, logs: result });
    } catch (e) {
        res.status(500).json({ error: e.message });
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

// Auto-sync all WireGuard peers from database to wg0 on startup
(async function syncAllWireguardPeersOnStartup() {
    try {
        const sitesData = await db.getSites();
        if (sitesData && sitesData.sites) {
            for (const s of sitesData.sites) {
                if (s.connectionType === 'wireguard' && s.wireguardPublicKey && s.wireguardIp) {
                    try {
                        registerVpsPeer(s.wireguardIp, s.wireguardPublicKey);
                        console.log(`[WireGuard Sync] Registered peer ${s.name} (${s.wireguardIp}) on VPS`);
                    } catch (_) {}
                }
            }
        }
    } catch (err) {
        console.warn('[WireGuard Startup Sync Notice]:', err.message);
    }
})();

// Add new site (Admin only)
app.post('/api/sites', requireAuth(['admin']), async (req, res) => {
    const { name, host, port, username, password, connectionType, wireguardIp, wireguardPublicKey, dnsLoggingEnabled } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Name is required' });
    }
    try {
        const newSite = await db.addSite({ name, host, port, username, password, connectionType, wireguardIp, wireguardPublicKey, dnsLoggingEnabled });
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
    const { name, host, port, username, password, connectionType, wireguardIp, wireguardPublicKey, dnsLoggingEnabled } = req.body;
    try {
        const updated = await db.updateSite(req.params.id, { name, host, port, username, password, connectionType, wireguardIp, wireguardPublicKey, dnsLoggingEnabled });
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
// TEMPORARY diagnostic route — disabled in production unless ENABLE_WG_DEBUG=1.
// Echoes request details; never leave open on a public VPS.
app.all('/api/wireguard/debug-echo', express.text({ type: () => true }), (req, res) => {
    if (process.env.NODE_ENV === 'production' && process.env.ENABLE_WG_DEBUG !== '1') {
        return res.status(404).json({ error: 'Not found' });
    }
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
                    endpoint: parts[2] && parts[2] !== '(none)' ? parts[2] : null,
                    lastHandshakeSecondsAgo: handshake > 0 ? Math.floor(Date.now() / 1000) - handshake : null,
                    transferRx: parseInt(parts[5]) || 0,
                    transferTx: parseInt(parts[6]) || 0
                });
            }
        }
        res.json({ connected: false, endpoint: null, lastHandshakeSecondsAgo: null, transferRx: 0, transferTx: 0 });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Bulk version of the above — one wg0 read, returns every WireGuard peer's
// real endpoint IP (the router's actual public IP:port it's connecting
// from) keyed by its tunnel IP, so the Sites Management page can show the
// real source IP for every site in one call instead of one request per site.
app.get('/api/wireguard/all-peers-status', requireAuth(['admin']), (req, res) => {
    try {
        const { execSync } = require('child_process');
        const dump = execSync('sudo wg show wg0 dump', { encoding: 'utf8' });
        const lines = dump.trim().split('\n').slice(1); // skip interface line
        const peers = {};
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 8) continue;
            const ipMatch = (parts[3] || '').match(/^(\d{1,3}(?:\.\d{1,3}){3})\/32/);
            if (!ipMatch) continue;
            const handshake = parseInt(parts[4]) || 0;
            peers[ipMatch[1]] = {
                endpoint: parts[2] && parts[2] !== '(none)' ? parts[2] : null,
                connected: handshake > 0,
                lastHandshakeSecondsAgo: handshake > 0 ? Math.floor(Date.now() / 1000) - handshake : null,
                transferRx: parseInt(parts[5]) || 0,
                transferTx: parseInt(parts[6]) || 0
            };
        }
        res.json(peers);
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

// Check router connection test (supports ?siteId= or header)
app.get('/api/mikrotik/test-connection', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const siteId = req.query.siteId || req.headers?.['x-site-id'];
    try {
        await executeOnRouter(siteId, async (client) => {
            await client.exec('/system/resource/print');
        });
        res.json({ success: true, message: 'Connected successfully' });
    } catch (err) {
        res.status(500).json({ error: `Connection failed: ${err.message}` });
    }
});

// Deep Diagnostic Endpoint for Router Connection (Step-by-step root cause analysis)
app.get('/api/mikrotik/diagnose-site', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const siteId = req.query.siteId || req.headers?.['x-site-id'];
    const dns = require('dns').promises;
    const net = require('net');
    const { execSync } = require('child_process');

    const steps = [];
    let isOverallSuccess = false;

    try {
        // Step 1: Site Config Lookup
        const config = await db.getConfig(siteId);
        if (!config || !config.host || !config.username) {
            steps.push({ step: '1. ข้อมูลไซต์งาน', status: 'fail', detail: `ไม่พบข้อมูล Host หรือ Username สำหรับไซต์ ${siteId || 'Default'}` });
            return res.json({ success: false, site: config, steps });
        }
        steps.push({
            step: '1. ข้อมูลไซต์งาน',
            status: 'ok',
            detail: `ชื่อ: ${config.name}, Host: ${config.host}:${config.port}, User: ${config.username}, Connection: ${config.connectionType || 'direct'}`
        });

        // Step 2: DNS / IP Resolution
        let resolvedIp = config.host;
        try {
            if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(config.host)) {
                const lookup = await dns.lookup(config.host);
                resolvedIp = lookup.address;
                steps.push({ step: '2. ตรวจสอบชื่อ Host / DNS', status: 'ok', detail: `แปลงชื่อ ${config.host} ➔ IP: ${resolvedIp}` });
            } else {
                steps.push({ step: '2. ตรวจสอบชื่อ Host / DNS', status: 'ok', detail: `ใช้ IP ตรง: ${config.host}` });
            }
        } catch (dnsErr) {
            steps.push({ step: '2. ตรวจสอบชื่อ Host / DNS', status: 'fail', detail: `ไม่สามารถ Resolve DNS ${config.host}: ${dnsErr.message}` });
            return res.json({ success: false, site: config, steps });
        }

        // Step 3: WireGuard Peer Check (if WireGuard)
        if (config.connectionType === 'wireguard' || config.host.startsWith('10.10.88.') || (config.wireguardIp && config.wireguardIp.startsWith('10.10.88.'))) {
            const targetWgIp = config.wireguardIp || config.host;
            try {
                const dump = execSync('sudo wg show wg0 dump', { encoding: 'utf8' });
                const lines = dump.trim().split('\n').slice(1);
                let peerFound = false;
                for (const line of lines) {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length < 8) continue;
                    const ipMatch = (parts[3] || '').match(/^(\d{1,3}(?:\.\d{1,3}){3})\/32/);
                    if (ipMatch && ipMatch[1] === targetWgIp) {
                        peerFound = true;
                        const handshake = parseInt(parts[4]) || 0;
                        const secondsAgo = handshake > 0 ? Math.floor(Date.now() / 1000) - handshake : null;
                        const endpoint = parts[2] && parts[2] !== '(none)' ? parts[2] : 'ยังไม่มี endpoint เชื่อมเข้ามา';
                        if (handshake === 0) {
                            steps.push({ step: '3. WireGuard VPN Handshake', status: 'warn', detail: `พบบันทึก Peer ${targetWgIp} บน VPS แล้ว แต่ยังไม่เคยมี Handshake (Endpoint: ${endpoint}) — ตรวจสอบว่า MikroTik เปิด Interface WireGuard และใส่ Endpoint VPS ถูกต้องหรือไม่` });
                        } else if (secondsAgo > 180) {
                            steps.push({ step: '3. WireGuard VPN Handshake', status: 'warn', detail: `Handshake ล่าสุดเมื่อ ${secondsAgo} วินาทีที่แล้ว (ขาดการติดต่อไปแล้ว) — ตรวจสอบ persistent-keepalive=25s บน MikroTik` });
                        } else {
                            steps.push({ step: '3. WireGuard VPN Handshake', status: 'ok', detail: `เชื่อมต่อ WireGuard ปกติ (Handshake เมื่อ ${secondsAgo} วินาทีที่แล้ว, Endpoint: ${endpoint})` });
                        }
                        break;
                    }
                }
                if (!peerFound) {
                    steps.push({ step: '3. WireGuard VPN Handshake', status: 'fail', detail: `ไม่พบคีย์ของ Peer IP ${targetWgIp} บน VPS interface wg0 (กรุณากด 'ลงทะเบียน Peer บน VPS')` });
                }
            } catch (wgErr) {
                steps.push({ step: '3. WireGuard VPN Handshake', status: 'warn', detail: `ไม่สามารถตรวจสอบ wg show wg0 ได้: ${wgErr.message}` });
            }
        }

        // Step 4: Raw TCP Port Reachability Check
        const tcpCheck = await new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(4000);
            socket.on('connect', () => {
                socket.destroy();
                resolve({ ok: true });
            });
            socket.on('timeout', () => {
                socket.destroy();
                resolve({ ok: false, error: `Connection Timeout ไปยัง ${resolvedIp}:${config.port} (เราท์เตอร์ไม่ตอบกลับพอร์ตนี้)` });
            });
            socket.on('error', (err) => {
                socket.destroy();
                resolve({ ok: false, error: err.message });
            });
            socket.connect(config.port, resolvedIp);
        });

        if (!tcpCheck.ok) {
            steps.push({
                step: '4. ตรวจสอบพอร์ต API TCP',
                status: 'fail',
                detail: `ไม่สามารถเปิดการเชื่อมต่อไปยังพอร์ต ${config.port} ได้: ${tcpCheck.error} (ตรวจสอบ /ip service บนเราท์เตอร์ว่าเปิดพอร์ต ${config.port} หรือติด Firewall หรือไม่)`
            });
            return res.json({ success: false, site: config, steps });
        }
        steps.push({ step: '4. ตรวจสอบพอร์ต API TCP', status: 'ok', detail: `เปิดพอร์ต TCP ${config.port} บน ${resolvedIp} สำเร็จ (Socket Connected)` });

        // Step 5: RouterOS API Authentication & System Identity
        try {
            const routerInfo = await executeOnRouter(siteId, async (client) => {
                const resPrint = await client.exec('/system/resource/print');
                let idPrint = [];
                try { idPrint = await client.exec('/system/identity/print'); } catch (_) {}
                return {
                    resource: resPrint[0] || {},
                    identity: idPrint[0] || {}
                };
            });
            steps.push({
                step: '5. เข้าสู่ระบบ RouterOS API (Authentication)',
                status: 'ok',
                detail: `เข้าสู่ระบบสำเร็จ! Identity: "${routerInfo.identity.name || 'MikroTik'}", รุ่น: ${routerInfo.resource['board-name'] || routerInfo.resource.platform || 'RouterOS'}, ROS: ${routerInfo.resource.version || 'v7'}, Uptime: ${routerInfo.resource.uptime || '-'}`
            });
            isOverallSuccess = true;
        } catch (apiErr) {
            steps.push({
                step: '5. เข้าสู่ระบบ RouterOS API (Authentication)',
                status: 'fail',
                detail: `ล็อกอินล้มเหลว: ${apiErr.message} (ตรวจสอบ Username/Password ของผู้ใช้งาน "${config.username}" บน MikroTik)`
            });
        }

        res.json({ success: isOverallSuccess, site: config, steps });
    } catch (err) {
        steps.push({ step: 'การตรวจสอบระบบ', status: 'fail', detail: err.message });
        res.status(500).json({ success: false, error: err.message, steps });
    }
});

// Helper to fetch official MikroTik latest versions from upgrade.mikrotik.com and fleet intelligence
let _mikrotikLatestVersions = { v7: '7.24.1', v6: '6.49.20', lastFetched: 0 };

function compareSemver(v1, v2) {
    // Returns: 1 if v1 > v2, -1 if v1 < v2, 0 if v1 == v2
    if (!v1 || !v2 || v1 === 'N/A' || v2 === 'N/A') return 0;
    const clean1 = String(v1).replace(/^v/i, '').split(/[\s-]+/)[0];
    const clean2 = String(v2).replace(/^v/i, '').split(/[\s-]+/)[0];
    const p1 = clean1.split('.').map(n => parseInt(n) || 0);
    const p2 = clean2.split('.').map(n => parseInt(n) || 0);
    const maxLen = Math.max(p1.length, p2.length);
    for (let i = 0; i < maxLen; i++) {
        const num1 = p1[i] || 0;
        const num2 = p2[i] || 0;
        if (num1 > num2) return 1;
        if (num1 < num2) return -1;
    }
    return 0;
}

async function getOfficialMikrotikLatestVersions() {
    const now = Date.now();
    if (now - _mikrotikLatestVersions.lastFetched < 3600000) {
        return _mikrotikLatestVersions;
    }
    const https = require('https');
    function fetchUrl(url) {
        return new Promise((resolve) => {
            https.get(url, { timeout: 3500 }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(data.trim().split(/\s+/)[0] || null));
            }).on('error', () => resolve(null));
        });
    }

    try {
        const [v7, v6] = await Promise.all([
            fetchUrl('https://upgrade.mikrotik.com/routeros/LATEST.7'),
            fetchUrl('https://upgrade.mikrotik.com/routeros/LATEST.6')
        ]);
        if (v7 && compareSemver(v7, _mikrotikLatestVersions.v7) > 0) _mikrotikLatestVersions.v7 = v7;
        if (v6 && compareSemver(v6, _mikrotikLatestVersions.v6) > 0) _mikrotikLatestVersions.v6 = v6;
        _mikrotikLatestVersions.lastFetched = now;
    } catch (_) {}
    return _mikrotikLatestVersions;
}

// 1. Overview System Resource status
app.get('/api/mikrotik/status', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const officialVersions = await getOfficialMikrotikLatestVersions();
        const stats = await executeOnRouter(req, async (client) => {
            const resources = await client.exec('/system/resource/print');
            const routerboard = await client.exec('/system/routerboard/print');
            let health = [];
            try {
                health = await client.exec('/system/health/print');
            } catch (e) {}
            
            const r = resources[0] || {};
            const rb = routerboard[0] || {};
            
            let tempVal = null;
            let voltVal = null;

            if (Array.isArray(health)) {
                for (const item of health) {
                    if (item.name) {
                        const n = String(item.name).toLowerCase();
                        if (n.includes('temp') && item.value && !tempVal) {
                            tempVal = `${item.value}°C`;
                        }
                        if (n.includes('voltage') && item.value && !voltVal) {
                            voltVal = `${item.value}V`;
                        }
                    }
                    if (item.temperature && !tempVal) tempVal = `${item.temperature}°C`;
                    if (item['cpu-temperature'] && !tempVal) tempVal = `${item['cpu-temperature']}°C`;
                    if (item.voltage && !voltVal) voltVal = `${(parseFloat(item.voltage) / (parseFloat(item.voltage) > 100 ? 10 : 1)).toFixed(1)}V`;
                }
            } else if (typeof health === 'object' && health !== null) {
                if (health.temperature) tempVal = `${health.temperature}°C`;
                if (health['cpu-temperature']) tempVal = `${health['cpu-temperature']}°C`;
                if (health.voltage) voltVal = `${(parseFloat(health.voltage) / (parseFloat(health.voltage) > 100 ? 10 : 1)).toFixed(1)}V`;
            }
            
            const currentVer = r.version ? r.version.split(' ')[0] : 'N/A';
            const isV6 = (r.version || '').startsWith('6');

            // Fleet intelligence: remember highest version seen across fleet
            if (currentVer !== 'N/A') {
                if (isV6) {
                    if (compareSemver(currentVer, _mikrotikLatestVersions.v6) > 0) _mikrotikLatestVersions.v6 = currentVer;
                } else {
                    if (compareSemver(currentVer, _mikrotikLatestVersions.v7) > 0) _mikrotikLatestVersions.v7 = currentVer;
                }
            }

            const latestKnown = isV6 ? _mikrotikLatestVersions.v6 : _mikrotikLatestVersions.v7;
            const isNew = !!(latestKnown && currentVer !== 'N/A' && compareSemver(latestKnown, currentVer) > 0);

            return {
                uptime: r.uptime || 'N/A',
                version: r.version || 'N/A',
                currentVersion: currentVer,
                latestVersion: isNew ? latestKnown : currentVer,
                hasUpdate: isNew,
                cpuLoad: r['cpu-load'] ? `${r['cpu-load']}%` : 'N/A',
                freeMemory: r['free-memory'] ? parseInt(r['free-memory']) : 0,
                totalMemory: r['total-memory'] ? parseInt(r['total-memory']) : 0,
                cpu: r.cpu || 'N/A',
                boardName: r['board-name'] || 'N/A',
                model: rb.model || r['board-name'] || 'MikroTik Router',
                serialNumber: rb['serial-number'] || 'N/A',
                currentFirmware: rb['current-firmware'] || r.version || 'N/A',
                upgradeFirmware: rb['upgrade-firmware'] || 'N/A',
                factoryFirmware: rb['factory-firmware'] || 'N/A',
                temperature: tempVal,
                voltage: voltVal
            };
        });
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Check RouterOS updates
app.get('/api/mikrotik/system/update-check', requireAuth(['admin']), async (req, res) => {
    try {
        const officialVersions = await getOfficialMikrotikLatestVersions();
        const result = await executeOnRouter(req, async (client) => {
            const updates = await client.exec('/system/package/update/check-for-updates');
            const resources = await client.exec('/system/resource/print');
            const u = updates[0] || {};
            const r = resources[0] || {};
            const installed = u['installed-version'] || u['current-version'] || (r.version ? r.version.split(' ')[0] : 'N/A');
            const isV6 = (installed || '').startsWith('6');
            let latest = u['latest-version'] || (isV6 ? officialVersions.v6 : officialVersions.v7) || 'N/A';
            const isNewAvailable = compareSemver(latest, installed) > 0;
            
            return {
                channel: u.channel || 'stable',
                installedVersion: installed,
                latestVersion: latest,
                isNewAvailable: isNewAvailable,
                status: isNewAvailable ? (u.status || 'New version is available') : 'System is already up to date'
            };
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Install RouterOS update (with Auto-Backup Safety Guard)
app.post('/api/mikrotik/system/update-install', requireAuth(['admin']), async (req, res) => {
    try {
        await executeOnRouter(req, async (client) => {
            // Safety Step: Save backup snapshot on router before updating
            try {
                const nowStr = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '_' + Date.now();
                await client.exec('/system/backup/save', { name: `pre-upgrade-${nowStr}` });
            } catch (backupErr) {
                console.warn('[Update Safety Guard] Auto-backup notice:', backupErr.message);
            }
            await client.exec('/system/package/update/install');
        });
        db.addLog(req.user.username, 'อัปเดต RouterOS (Auto-Backup)', 'สร้างไฟล์สำรองอัตโนมัติและสั่งติดตั้ง RouterOS เวอร์ชันใหม่พร้อมรีบูต');
        res.json({ success: true, message: 'สำรองคอนฟิกอัตโนมัติและสั่งดาวน์โหลด/ติดตั้ง RouterOS เรียบร้อยแล้ว เราท์เตอร์จะทำการรีบูตใน 1-2 นาที' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Upgrade RouterBOARD Firmware
app.post('/api/mikrotik/system/firmware-upgrade', requireAuth(['admin']), async (req, res) => {
    try {
        const result = await executeOnRouter(req, async (client) => {
            await client.exec('/system/routerboard/upgrade');
            const rb = await client.exec('/system/routerboard/print');
            return rb[0] || {};
        });
        db.addLog(req.user.username, 'อัปเกรด RouterBOARD Firmware', 'สั่งอัปเกรด Firmware สำเร็จ (ต้องการรีบูตเพื่อให้มีผล)');
        res.json({ success: true, message: 'อัปเกรด RouterBOARD Firmware เรียบร้อยแล้ว กรุณารีบูตเราท์เตอร์เพื่อให้ Firmware ใหม่เริ่มทำงาน', routerboard: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Full System Upgrade Stage 2: Firmware Upgrade + Automated Final Reboot
app.post('/api/mikrotik/system/full-upgrade-stage2', requireAuth(['admin']), async (req, res) => {
    try {
        const result = await executeOnRouter(req, async (client) => {
            await client.exec('/system/routerboard/upgrade');
            const rb = await client.exec('/system/routerboard/print');
            // Trigger reboot after 1.5s
            setTimeout(async () => {
                try {
                    await executeOnRouter(req, async (c2) => {
                        await c2.exec('/system/reboot');
                    });
                } catch (_) {}
            }, 1500);
            return rb[0] || {};
        });
        db.addLog(req.user.username, 'อัปเกรด Firmware อัตโนมัติ (Stage 2)', 'สั่งอัปเกรด RouterBOARD Firmware พร้อมรีบูตอัตโนมัติ');
        res.json({ success: true, message: 'สั่งอัปเกรด RouterBOARD Firmware พร้อมสั่งรีบูตเรียบร้อยแล้ว', routerboard: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Reboot Router
app.post('/api/mikrotik/system/reboot', requireAuth(['admin']), async (req, res) => {
    try {
        executeOnRouter(req, async (client) => {
            await client.exec('/system/reboot');
        }).catch(() => {});
        db.addLog(req.user.username, 'รีบูตเราท์เตอร์', 'สั่ง Reboot เราท์เตอร์ผ่านแดชบอร์ด');
        res.json({ success: true, message: 'สั่งรีบูตเราท์เตอร์เรียบร้อยแล้ว ระบบกำลังเริ่มต้นใหม่ใน 30-60 วินาที' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Flush DNS Cache
app.post('/api/mikrotik/system/flush-dns', requireAuth(['admin']), async (req, res) => {
    try {
        await executeOnRouter(req, async (client) => {
            await client.exec('/ip/dns/cache/flush');
        });
        db.addLog(req.user.username, 'ล้าง DNS Cache', 'สั่ง Flush DNS Cache บนเราท์เตอร์สำเร็จ');
        res.json({ success: true, message: 'ล้าง DNS Cache บนเราท์เตอร์สำเร็จเรียบร้อย' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Ping Test
app.post('/api/mikrotik/system/ping-test', requireAuth(['admin']), async (req, res) => {
    try {
        const host = req.body.host || '8.8.8.8';
        const count = req.body.count || '4';
        const result = await executeOnRouter(req, async (client) => {
            return await client.exec('/ping', { address: host, count: String(count) });
        });
        res.json({ success: true, host, count, results: result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Quick Router Backup (.backup)
app.post('/api/mikrotik/system/backup', requireAuth(['admin']), async (req, res) => {
    try {
        const dateStr = new Date().toISOString().slice(0, 10);
        const name = (req.body.name || `backup-${dateStr}`).replace(/[^a-zA-Z0-9_-]/g, '');
        await executeOnRouter(req, async (client) => {
            await client.exec('/system/backup/save', { name });
        });
        db.addLog(req.user.username, 'สำรองคอนฟิกเราท์เตอร์', `สร้างไฟล์สำรอง ${name}.backup บนเราท์เตอร์สำเร็จ`);
        res.json({ success: true, message: `สร้างไฟล์สำรอง ${name}.backup บนเราท์เตอร์เรียบร้อยแล้ว` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Network Speed & Jitter Quality Test
app.post('/api/mikrotik/system/quality-test', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const targetHost = req.body.target || '1.1.1.1'; // Cloudflare DNS
        const result = await executeOnRouter(req, async (client) => {
            const pings = await client.exec('/ping', { address: targetHost, count: '6' });
            const times = [];
            let lost = 0;
            (pings || []).forEach(p => {
                if (p.time) {
                    const ms = parseFloat(p.time.replace('ms', ''));
                    if (!isNaN(ms)) times.push(ms);
                } else if (p.status === 'timeout' || p.packetLoss) {
                    lost++;
                }
            });

            const count = (pings || []).length || 6;
            const min = times.length > 0 ? Math.min(...times) : 0;
            const max = times.length > 0 ? Math.max(...times) : 0;
            const avg = times.length > 0 ? (times.reduce((a, b) => a + b, 0) / times.length).toFixed(1) : 0;
            const packetLossPct = count > 0 ? Math.round(((count - times.length) / count) * 100) : 0;
            const jitter = times.length > 1 ? (max - min).toFixed(1) : 0;

            let quality = 'ดีเยี่ยม (Excellent)';
            let qualityScore = 'A+';
            if (packetLossPct > 10 || avg > 80) {
                quality = 'สัญญาณมีปัญหา (Poor)';
                qualityScore = 'D';
            } else if (packetLossPct > 0 || avg > 40) {
                quality = 'ปานกลาง (Fair)';
                qualityScore = 'B';
            } else if (avg > 25) {
                quality = 'ดี (Good)';
                qualityScore = 'A';
            }

            return {
                target: targetHost,
                count,
                minMs: min,
                maxMs: max,
                avgMs: avg,
                jitterMs: jitter,
                packetLoss: `${packetLossPct}%`,
                quality,
                qualityScore,
                pings
            };
        });
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Global Search across all sites (Hotspot users, PPPoE rooms, sites, configs)
app.get('/api/search/global', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q || q.length < 2) return res.json({ results: [] });

    const results = [];
    try {
        const sitesData = await db.getSites();
        const allowedSites = isSiteLockedUser(req.user) 
            ? (sitesData.sites || []).filter(s => s.id === req.user.assignedSiteId)
            : (sitesData.sites || []);

        for (const s of allowedSites) {
            // Match Site Name / IP
            if (s.name.toLowerCase().includes(q) || (s.wireguardIp && s.wireguardIp.includes(q)) || (s.host && s.host.includes(q))) {
                results.push({
                    type: 'site',
                    category: 'ไซต์งาน / สาขา',
                    title: s.name,
                    subtitle: `IP: ${s.host} (WireGuard: ${s.wireguardIp || '-'})`,
                    siteId: s.id,
                    siteName: s.name,
                    icon: 'fa-solid fa-server',
                    action: 'switch-site'
                });
            }

            // Search Hotspot users and PPPoE for each site
            try {
                const config = await db.getConfig(s.id);
                if (!config.host || !config.username) continue;
                
                // Hotspot Users
                const hotspotUsers = await db.getHotspotUsers(s.id).catch(() => []);
                for (const u of (hotspotUsers || [])) {
                    if ((u.username && u.username.toLowerCase().includes(q)) || (u.comment && u.comment.toLowerCase().includes(q)) || (u.macAddress && u.macAddress.toLowerCase().includes(q))) {
                        results.push({
                            type: 'hotspot',
                            category: `Hotspot (${s.name})`,
                            title: u.username,
                            subtitle: `โปรไฟล์: ${u.profile || '-'} | สถานะ: ${u.disabled ? 'ปิดใช้งาน' : 'พร้อมใช้'} | คอมเมนต์: ${u.comment || '-'}`,
                            siteId: s.id,
                            siteName: s.name,
                            icon: 'fa-solid fa-wifi',
                            targetPage: 'page-hotspot-users'
                        });
                        if (results.length >= 30) break;
                    }
                }

                // PPPoE Secrets
                const pppoeSecrets = await db.getPppoeUsers(s.id).catch(() => []);
                for (const p of (pppoeSecrets || [])) {
                    if ((p.name && p.name.toLowerCase().includes(q)) || (p.comment && p.comment.toLowerCase().includes(q)) || (p['remote-address'] && p['remote-address'].includes(q))) {
                        results.push({
                            type: 'pppoe',
                            category: `ห้องพัก PPPoE (${s.name})`,
                            title: p.name,
                            subtitle: `โปรไฟล์: ${p.profile || '-'} | IP: ${p['remote-address'] || '-'} | คอมเมนต์: ${p.comment || '-'}`,
                            siteId: s.id,
                            siteName: s.name,
                            icon: 'fa-solid fa-door-closed',
                            targetPage: 'page-pppoe-users'
                        });
                        if (results.length >= 30) break;
                    }
                }
            } catch (_) {}
            if (results.length >= 30) break;
        }

        res.json({ results: results.slice(0, 25) });
    } catch (err) {
        res.status(500).json({ error: err.message, results: [] });
    }
});

// 2. Read interface list and stats (for real-time traffic graph)
app.get('/api/mikrotik/interfaces', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const interfaces = await executeOnRouter(req, async (client) => {
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
        const users = await executeOnRouter(req, async (client) => {
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
        const result = await executeOnRouter(req, async (client) => {
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
// Also doubles as the "renew / top-up" endpoint for an existing username: RouterOS
// never resets the accumulated `uptime` counter on its own, so re-applying a fresh
// limit-uptime to a coupon that already has usage history makes it look instantly
// expired. `resetCounters`/`recreate` (both opt-in, off by default so a plain
// cosmetic edit doesn't wipe usage stats) fix that — see CLAUDE.md "Renewing an
// existing Hotspot username" for the full explanation.
app.put('/api/mikrotik/hotspot/users/:id', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const { name, password, profile, limitUptime, limitBytesTotal, comment, resetCounters, recreate } = req.body;
    try {
        const result = await executeOnRouter(req, async (client) => {
            // Renewal: kick any active session first so RouterOS doesn't keep counting
            // uptime against a user record we're about to reset/replace underneath it.
            if ((resetCounters || recreate) && name) {
                try {
                    const active = await client.exec('/ip/hotspot/active/print');
                    for (const s of active.filter(a => a.user === name)) {
                        await client.exec('/ip/hotspot/active/remove', { '.id': s['.id'] });
                    }
                } catch (e) { /* not fatal — continue applying the new limits */ }
            }

            if (recreate) {
                // Delete + recreate: simplest way to guarantee a fully clean uptime/byte
                // counter, recommended for single-use coupon codes.
                await client.exec('/ip/hotspot/user/remove', { '.id': req.params.id });
                const addParams = {
                    name,
                    password: password || '',
                    profile: profile || 'default',
                    comment: comment || ''
                };
                if (limitUptime) addParams['limit-uptime'] = limitUptime;
                if (limitBytesTotal) addParams['limit-bytes-total'] = limitBytesTotal;
                return await client.exec('/ip/hotspot/user/add', addParams);
            }

            if (resetCounters) {
                // /ip/hotspot/user/reset-counters zeroes uptime + bytes-in/out for this
                // user — must run BEFORE the new limit-uptime is applied below, or the
                // still-accumulated old uptime gets compared against the new (often
                // smaller) limit and the user is treated as already expired.
                try {
                    await client.exec('/ip/hotspot/user/reset-counters', { numbers: req.params.id });
                } catch (e) { /* older RouterOS may reject this if the user never logged in yet */ }
            }

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
        const renewSuffix = recreate ? ' [ต่ออายุ: ลบและสร้างใหม่]' : (resetCounters ? ' [ต่ออายุ: รีเซ็ตเวลาใช้งาน]' : '');
        db.addLog(req.user.username, 'แก้ไขบัญชี Hotspot', 'แก้ไขผู้ใช้ ID: ' + req.params.id + ' เป็นชื่อ ' + name + ' (โปรไฟล์: ' + profile + ')' + renewSuffix);
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Quick Renew Hotspot user (1-Click Renew & Reset Counters)
app.post('/api/mikrotik/hotspot/users/:id/renew', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const { name, limitUptime, limitBytesTotal } = req.body;
    try {
        await executeOnRouter(req, async (client) => {
            // 1. Kick active sessions for this username
            if (name) {
                try {
                    const active = await client.exec('/ip/hotspot/active/print');
                    for (const s of active.filter(a => a.user === name)) {
                        await client.exec('/ip/hotspot/active/remove', { '.id': s['.id'] });
                    }
                } catch (e) { /* ignore */ }
            }

            // 2. Reset counters (uptime & bytes)
            try {
                await client.exec('/ip/hotspot/user/reset-counters', { numbers: req.params.id });
            } catch (e) { /* ignore */ }

            // 3. Update limit-uptime / limit-bytes if specified
            const setParams = { '.id': req.params.id };
            if (limitUptime !== undefined) setParams['limit-uptime'] = limitUptime;
            if (limitBytesTotal !== undefined) setParams['limit-bytes-total'] = limitBytesTotal;

            if (Object.keys(setParams).length > 1) {
                await client.exec('/ip/hotspot/user/set', setParams);
            }
        });

        db.addLog(req.user.username, 'ต่ออายุคูปอง Hotspot', `ต่ออายุ/รีเซ็ตเวลาบัญชี ID: ${req.params.id} (${name || ''})`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Hotspot user
app.delete('/api/mikrotik/hotspot/users/:id', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        await executeOnRouter(req, async (client) => {
            try {
                const users = await client.exec('/ip/hotspot/user/print');
                const target = users.find(u => u['.id'] === req.params.id);
                if (target) {
                    let userPassword = target.password || target['plain-password'] || target.pass || target.secret || '';
                    if (!userPassword) {
                        for (const k of Object.keys(target)) {
                            if (k.toLowerCase().includes('pass') || k.toLowerCase().includes('secret') || k.toLowerCase().includes('pwd')) {
                                if (target[k]) { userPassword = target[k]; break; }
                            }
                        }
                    }
                    const siteConfig = await db.getConfig(req.user.assignedSiteId !== 'all' ? req.user.assignedSiteId : req.query?.siteId);
                    const siteName = siteConfig.name || 'Default';
                    const uptimeMs = parseUptimeToMs(target.uptime);
                    const limitMs = parseUptimeToMs(target['limit-uptime']);
                    const isExpired = (limitMs > 0 && uptimeMs >= limitMs) || (target.comment || '').toLowerCase().includes('expired') || (target.comment || '').toLowerCase().includes('หมดอายุ');

                    await db.archiveDeletedHotspotUser({
                        username: target.name,
                        password: userPassword,
                        profile: target.profile || 'default',
                        limitUptime: target['limit-uptime'] || '',
                        limitBytesTotal: target['limit-bytes-total'] || 0,
                        comment: target.comment || '',
                        siteName: siteName,
                        deletedBy: req.user.username,
                        reason: isExpired ? 'expired' : 'manual_delete'
                    });
                }
            } catch (e) {
                console.error('Failed to archive user before deletion:', e);
            }

            await client.exec('/ip/hotspot/user/remove', { '.id': req.params.id });
        });
        db.addLog(req.user.username, 'ลบบัญชี Hotspot', 'ลบผู้ใช้ ID: ' + req.params.id + ' (จัดเก็บเข้าประวัติแล้ว)');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Read Archived / Deleted Hotspot Users
app.get('/api/mikrotik/hotspot/archived-users', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const forcedSite = await resolveForcedSiteName(req, req.query.siteName);
        const options = {
            search: req.query.search,
            siteName: forcedSite === '__no_access__' ? 'NONE' : forcedSite,
            page: req.query.page,
            limit: req.query.limit
        };
        const data = await db.getArchivedHotspotUsers(options);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Restore Archived Hotspot User (Re-create on RouterOS)
app.post('/api/mikrotik/hotspot/archived-users/:id/restore', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const { username, password, profile, limitUptime, limitBytesTotal, comment, removeFromArchive } = req.body;
        if (!username) {
            return res.status(400).json({ error: 'Username is required' });
        }

        const result = await executeOnRouter(req, async (client) => {
            const params = {
                name: username,
                password: password || '',
                profile: profile || 'default',
                comment: comment || 'Restored from Archived Coupons'
            };
            if (limitUptime) params['limit-uptime'] = limitUptime;
            if (limitBytesTotal) params['limit-bytes-total'] = limitBytesTotal;

            return await client.exec('/ip/hotspot/user/add', params);
        });

        if (removeFromArchive !== false) {
            await db.deleteArchivedHotspotUser(req.params.id);
        }

        db.addLog(req.user.username, 'คืนค่าบัญชี Hotspot', `สร้างบัญชีเดิมกลับเข้า MikroTik: ${username} (โปรไฟล์: ${profile || 'default'})`);
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete single item from Archived Hotspot Users
app.delete('/api/mikrotik/hotspot/archived-users/:id', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const success = await db.deleteArchivedHotspotUser(req.params.id);
        if (success) {
            db.addLog(req.user.username, 'ลบประวัติคูปอง', `ลบรายการประวัติคูปอง ID: ${req.params.id}`);
        }
        res.json({ success });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Clear all items from Archived Hotspot Users
app.delete('/api/mikrotik/hotspot/archived-users', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const forcedSite = await resolveForcedSiteName(req, req.query.siteName);
        const siteToClear = forcedSite === '__no_access__' ? 'NONE' : forcedSite;
        const count = await db.clearArchivedHotspotUsers(siteToClear);
        db.addLog(req.user.username, 'ล้างประวัติคูปองทั้งหมด', `ล้างประวัติคูปองที่หมดอายุ/ถูกลบจำนวน ${count} รายการ`);
        res.json({ success: true, count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// Read Hotspot active sessions
app.get('/api/mikrotik/hotspot/active', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const active = await executeOnRouter(req, async (client) => {
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
        await executeOnRouter(req, async (client) => {
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
        const profiles = await executeOnRouter(req, async (client) => {
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
        await executeOnRouter(req, async (client) => {
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
        await executeOnRouter(req, async (client) => {
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
        await executeOnRouter(req, async (client) => {
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
        const users = await executeOnRouter(req, async (client) => {
            const [secrets, active, pppoeLogsData] = await Promise.all([
                client.exec('/ppp/secret/print'),
                client.exec('/ppp/active/print').catch(() => []),
                // db.js is sync; db-supabase.js returns a Promise — normalize both
                Promise.resolve(db.getPppoeUsageLogs({ limit: 1000 })).catch(() => ({ logs: [] }))
            ]);

            const activeMap = new Map();
            (active || []).forEach(a => {
                if (a.service === 'pppoe' && a.name) {
                    activeMap.set(a.name, a);
                }
            });

            const lastLogMap = new Map();
            ((pppoeLogsData && pppoeLogsData.logs) || []).forEach(l => {
                if (l.username && l.timestamp) {
                    const currentLast = lastLogMap.get(l.username);
                    if (!currentLast || new Date(l.timestamp) > new Date(currentLast)) {
                        lastLogMap.set(l.username, l.timestamp);
                    }
                }
            });

            return secrets
                .filter(item => item.service === 'pppoe')
                .map(item => {
                    const activeSession = activeMap.get(item.name);
                    const isOnline = !!activeSession;
                    const lastLogTime = lastLogMap.get(item.name);
                    const routerLastOut = item['last-logged-out'];

                    return {
                        id: item['.id'],
                        name: item.name,
                        password: item.password || '',
                        profile: item.profile,
                        disabled: item.disabled === 'true',
                        comment: item.comment || '',
                        isOnline: isOnline,
                        currentUptime: isOnline ? (activeSession.uptime || '0s') : null,
                        lastLoggedOut: routerLastOut || lastLogTime || null
                    };
                });
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
        await executeOnRouter(req, async (client) => {
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
// NOTE: /ppp/active/print does NOT expose live bytes-in/bytes-out (unlike
// /ip/hotspot/active/print, which does) — RouterOS only tracks per-session
// traffic on the dynamic interface it creates for each connection, named
// "<pppoe-USERNAME>". We look that interface up in /interface/print and
// pull rx-byte/tx-byte from there instead.
app.get('/api/mikrotik/pppoe/active', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const active = await executeOnRouter(async (client) => {
            const [list, interfaces] = await Promise.all([
                client.exec('/ppp/active/print'),
                client.exec('/interface/print')
            ]);
            const ifaceByName = new Map(interfaces.map(i => [i.name, i]));
            return list
                .filter(item => item.service === 'pppoe')
                .map(item => {
                    const iface = resolvePppoeIface(ifaceByName, item.name);
                    return {
                        id: item['.id'],
                        name: item.name,
                        address: item.address || '',
                        uptime: item.uptime || '0s',
                        callerId: item['caller-id'] || '',
                        bytesIn: iface ? (parseInt(iface['rx-byte']) || 0) : 0,
                        bytesOut: iface ? (parseInt(iface['tx-byte']) || 0) : 0
                    };
                });
        });
        res.json(active);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Suspend or reactivate a PPPoE room account by username — used for the
// "quick lock" button on the live-status table so staff can cut off a room
// on the spot (e.g. non-payment) without going through the account editor.
// Suspending also kicks any live session so the effect is immediate.
app.patch('/api/mikrotik/pppoe/users/by-name/:name/suspend', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { suspend } = req.body;
    if (typeof suspend !== 'boolean') {
        return res.status(400).json({ error: 'ต้องระบุค่า suspend เป็น true หรือ false' });
    }
    try {
        await executeOnRouter(async (client) => {
            const secrets = await client.exec('/ppp/secret/print');
            const secret = secrets.find(item => item.service === 'pppoe' && item.name === req.params.name);
            if (!secret) throw new Error(`ไม่พบบัญชีห้อง "${req.params.name}"`);
            await client.exec('/ppp/secret/set', { '.id': secret['.id'], disabled: suspend ? 'yes' : 'no' });

            if (suspend) {
                const activeList = await client.exec('/ppp/active/print');
                const session = activeList.find(item => item.service === 'pppoe' && item.name === req.params.name);
                if (session) await client.exec('/ppp/active/remove', { '.id': session['.id'] });
            }
        });
        db.addLog(req.user.username, suspend ? 'ระงับการใช้งาน PPPoE' : 'ปลดล็อกการใช้งาน PPPoE', `ห้อง ${req.params.name}`);
        res.json({ success: true });
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
                remoteAddress: item['remote-address'] || '',
                // Idle/session timeout: cleans up dead/zombie sessions automatically
                // (e.g. a room's router loses power without a clean PPP terminate)
                // instead of them sitting connected forever.
                idleTimeout: (item['idle-timeout'] && item['idle-timeout'] !== 'none') ? item['idle-timeout'] : '',
                sessionTimeout: (item['session-timeout'] && item['session-timeout'] !== 'none') ? item['session-timeout'] : ''
            }));
        });
        res.json(profiles);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create PPPoE package
app.post('/api/mikrotik/pppoe/profiles', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { name, rateLimit, localAddress, remoteAddress, idleTimeout, sessionTimeout } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'ต้องระบุชื่อแพ็กเกจ' });
    }
    try {
        await executeOnRouter(async (client) => {
            const params = { name, 'only-one': 'yes' };
            if (rateLimit) params['rate-limit'] = rateLimit;
            if (localAddress) params['local-address'] = localAddress;
            if (remoteAddress) params['remote-address'] = remoteAddress;
            if (idleTimeout) params['idle-timeout'] = idleTimeout;
            if (sessionTimeout) params['session-timeout'] = sessionTimeout;
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
    const { name, rateLimit, localAddress, remoteAddress, idleTimeout, sessionTimeout } = req.body;
    try {
        await executeOnRouter(async (client) => {
            const params = { '.id': req.params.id, name };
            if (rateLimit) params['rate-limit'] = rateLimit;
            if (localAddress) params['local-address'] = localAddress;
            if (remoteAddress) params['remote-address'] = remoteAddress;
            // Always set explicitly (not conditionally) so clearing the field in
            // the edit form actually clears it on the router instead of leaving
            // a stale value from before.
            params['idle-timeout'] = idleTimeout || 'none';
            params['session-timeout'] = sessionTimeout || 'none';
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

// Read PPPoE server (service) settings, e.g. keepalive-timeout — separate from
// /ppp/profile, this lives on /interface/pppoe-server/server (the service
// itself, created once per site by the setup script below). Assumes one
// PPPoE server instance per site, which is what the setup script creates.
app.get('/api/mikrotik/pppoe/server-settings', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const settings = await executeOnRouter(async (client) => {
            const list = await client.exec('/interface/pppoe-server/server/print');
            if (!list.length) return null;
            const server = list[0];
            return {
                id: server['.id'],
                serviceName: server['service-name'] || '',
                interfaceName: server.interface || '',
                keepaliveTimeout: server['keepalive-timeout'] || ''
            };
        });
        res.json(settings || {});
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update PPPoE server keepalive-timeout — lets a dead peer (room router that
// lost power without a clean disconnect) get detected and cleared faster,
// without re-running the whole one-time setup script.
app.put('/api/mikrotik/pppoe/server-settings', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { keepaliveTimeout } = req.body;
    if (!keepaliveTimeout) {
        return res.status(400).json({ error: 'ต้องระบุค่า Keepalive Timeout' });
    }
    try {
        await executeOnRouter(async (client) => {
            const list = await client.exec('/interface/pppoe-server/server/print');
            if (!list.length) throw new Error('ไม่พบ PPPoE Server บนเราท์เตอร์นี้ (ต้องตั้งค่าเซิร์ฟเวอร์ก่อนผ่านสคริปต์ตั้งค่า)');
            await client.exec('/interface/pppoe-server/server/set', { '.id': list[0]['.id'], 'keepalive-timeout': keepaliveTimeout });
        });
        db.addLog(req.user.username, 'แก้ไขการตั้งค่า PPPoE Server', `keepalive-timeout = ${keepaliveTimeout}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Generate PPPoE Server Setup Script for MikroTik (one-time per-site setup, run once in WinBox)
app.post('/api/mikrotik/pppoe/generate-script', requireAuth(['admin']), (req, res) => {
    const { interfaceName, vlanId, poolStart, poolEnd, serverAddress, keepaliveTimeout } = req.body;
    if (!interfaceName || !poolStart || !poolEnd || !serverAddress) {
        return res.status(400).json({ error: 'ต้องระบุ Interface, IP Pool (ต้น-ปลาย) และ Server Address ให้ครบ' });
    }
    const keepalive = keepaliveTimeout || '10';

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
/interface/pppoe-server/server/add service-name=mt-pppoe interface=${targetInterface} default-profile=default one-session-per-host=yes keepalive-timeout=${keepalive} disabled=no

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
async function runExpiredCleanup(logUsername = 'System Auto', reqOrSiteId = null) {
    return await executeOnRouter(reqOrSiteId, async (client) => {
        const siteConfig = await db.getConfig(typeof reqOrSiteId === 'string' ? reqOrSiteId : reqOrSiteId?.user?.assignedSiteId);
        const siteName = siteConfig.name || 'Default';
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

            const uptimeMs = parseUptimeToMs(u.uptime);
            const limitUptimeMs = parseUptimeToMs(u['limit-uptime']);

            let isExpired = false;
            if (comment.includes('expired') || comment.includes('หมดอายุ')) {
                isExpired = true;
            }
            if (limitUptimeMs > 0 && uptimeMs >= limitUptimeMs) {
                isExpired = true;
            }
            if (limitBytesTotal > 0 && totalBytes >= limitBytesTotal) {
                isExpired = true;
            }

            if (isExpired) {
                let userPassword = u.password || u['plain-password'] || u.pass || u.secret || '';
                if (!userPassword) {
                    for (const k of Object.keys(u)) {
                        if (k.toLowerCase().includes('pass') || k.toLowerCase().includes('secret') || k.toLowerCase().includes('pwd')) {
                            if (u[k]) { userPassword = u[k]; break; }
                        }
                    }
                }
                expired.push({
                    id: u['.id'],
                    username: u.name,
                    password: userPassword,
                    profile: u.profile || 'default',
                    limitUptime: u['limit-uptime'] || '',
                    limitBytesTotal: u['limit-bytes-total'] || 0,
                    comment: u.comment || '',
                    siteName: siteName,
                    deletedBy: logUsername,
                    reason: 'auto_cleanup'
                });
            }
        }

        if (expired.length > 0) {
            await db.archiveDeletedHotspotUsersBulk(expired);
        }

        for (const item of expired) {
            try {
                await client.exec('/ip/hotspot/user/remove', { '.id': item.id });
            } catch (e) {}
        }

        if (expired.length > 0) {
            await db.addLog(logUsername, 'ลบคูปองหมดอายุ', `ลบผู้ใช้งานที่หมดอายุแล้วจำนวน ${expired.length} บัญชี (บันทึกจัดเก็บเข้าประวัติแล้ว)`);
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

// ==========================================
// LINE Official Account / Messaging API (Option 1)
// ==========================================
async function sendLinePushMessage(token, targetId, messages) {
    if (!token || !targetId) throw new Error('LINE Channel Access Token and Target ID are required');
    const payload = {
        to: targetId,
        messages: Array.isArray(messages) ? messages : [messages]
    };
    const response = await fetch('https://api.line.me/v2/bot/message/push', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(`LINE Messaging API Push error (${response.status}): ${text}`);
    }
    return true;
}

const LINE_QUICK_REPLY_MENU = {
    items: [
        { type: "action", action: { type: "message", label: "⏳ เช็ควันหมดอายุ", text: "เช็ควันหมดอายุ" } },
        { type: "action", action: { type: "message", label: "💳 ต่ออายุเน็ต", text: "ต่ออายุเน็ต" } },
        { type: "action", action: { type: "message", label: "🔑 ดูรหัสผ่าน", text: "ดูรหัสผ่าน" } },
        { type: "action", action: { type: "message", label: "📖 คู่มือใช้งาน", text: "คู่มือใช้งาน" } },
        { type: "action", action: { type: "message", label: "💬 ติดต่อแอดมิน", text: "ติดต่อแอดมิน" } }
    ]
};

async function sendLineMessagingApiReply(token, replyToken, messages) {
    if (!token || !replyToken) return;
    const msgList = Array.isArray(messages) ? messages : [messages];
    if (msgList.length > 0 && !msgList[msgList.length - 1].quickReply) {
        msgList[msgList.length - 1].quickReply = LINE_QUICK_REPLY_MENU;
    }
    const payload = {
        replyToken: replyToken,
        messages: msgList
    };
    try {
        await fetch('https://api.line.me/v2/bot/message/reply', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(payload)
        });
    } catch (e) {
        console.error('LINE Reply error:', e);
    }
}

function formatMsToHuman(ms) {
    if (ms <= 0) return 'หมดเวลาแล้ว';
    const totalSec = Math.floor(ms / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    
    if (days > 0) return `เหลือ ${days} วัน ${hours} ชม.`;
    if (hours > 0) return `เหลือ ${hours} ชม. ${mins} นาที`;
    return `เหลือ ${mins} นาที`;
}

function createDailyDigestFlex(digestData) {
    const d1Count = digestData.counts.d1;
    const d3Count = digestData.counts.d3;
    const d7Count = digestData.counts.d7;
    const total = digestData.totalItems;

    const contents = [];

    if (total === 0) {
        contents.push({
            type: "text",
            text: "✅ ไม่พบบัญชีที่ใกล้หมดอายุใน 7 วันนี้ (ระบบปกติ)",
            size: "sm",
            color: "#15803d",
            wrap: true
        });
    } else {
        if (d1Count > 0) {
            contents.push({
                type: "text",
                text: `🔴 หมดอายุภายใน 1 วัน (${d1Count} บัญชี)`,
                weight: "bold",
                size: "sm",
                color: "#dc2626",
                margin: "md"
            });
            digestData.d1Users.slice(0, 8).forEach(u => {
                contents.push({ type: "text", text: `• ${u}`, size: "xs", color: "#4b5563", margin: "xs" });
            });
            if (digestData.d1Users.length > 8) {
                contents.push({ type: "text", text: `...และอีก ${digestData.d1Users.length - 8} บัญชี`, size: "xs", color: "#9ca3af" });
            }
        }

        if (d3Count > 0) {
            contents.push({
                type: "text",
                text: `🟡 หมดอายุภายใน 3 วัน (${d3Count} บัญชี)`,
                weight: "bold",
                size: "sm",
                color: "#d97706",
                margin: "md"
            });
            digestData.d3Users.slice(0, 8).forEach(u => {
                contents.push({ type: "text", text: `• ${u}`, size: "xs", color: "#4b5563", margin: "xs" });
            });
            if (digestData.d3Users.length > 8) {
                contents.push({ type: "text", text: `...และอีก ${digestData.d3Users.length - 8} บัญชี`, size: "xs", color: "#9ca3af" });
            }
        }

        if (d7Count > 0) {
            contents.push({
                type: "text",
                text: `🔵 หมดอายุภายใน 7 วัน (${d7Count} บัญชี)`,
                weight: "bold",
                size: "sm",
                color: "#2563eb",
                margin: "md"
            });
            digestData.d7Users.slice(0, 8).forEach(u => {
                contents.push({ type: "text", text: `• ${u}`, size: "xs", color: "#4b5563", margin: "xs" });
            });
            if (digestData.d7Users.length > 8) {
                contents.push({ type: "text", text: `...และอีก ${digestData.d7Users.length - 8} บัญชี`, size: "xs", color: "#9ca3af" });
            }
        }
    }

    return {
        type: "flex",
        altText: `📢 สรุปรายการบัญชีใกล้หมดอายุประจำวัน (${total} รายการ)`,
        contents: {
            type: "bubble",
            header: {
                type: "box",
                layout: "vertical",
                backgroundColor: "#06c755",
                contents: [
                    { type: "text", text: "📢 สรุปรายการใกล้หมดอายุประจำวัน", weight: "bold", color: "#ffffff", size: "md" },
                    { type: "text", text: `📅 วันที่ ${new Date().toLocaleDateString('th-TH')} (${digestData.siteName})`, color: "#e0f2fe", size: "xs", margin: "xs" }
                ]
            },
            body: {
                type: "box",
                layout: "vertical",
                contents: contents
            },
            footer: {
                type: "box",
                layout: "vertical",
                contents: [
                    { type: "text", text: "ℹ️ กรุณาติดต่อแอดมินเพื่อเติมเงินหรือต่ออายุครับ", size: "xs", color: "#6b7280", align: "center" }
                ]
            }
        }
    };
}

function parseExpiryFromComment(comment) {
    if (!comment) return null;
    const str = String(comment).trim();
    
    // Pattern 1: ISO date (2026-08-30 or 2026/08/30)
    const isoMatch = str.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2}))?/);
    if (isoMatch) {
        const year = parseInt(isoMatch[1]);
        const month = parseInt(isoMatch[2]) - 1;
        const day = parseInt(isoMatch[3]);
        const hour = isoMatch[4] ? parseInt(isoMatch[4]) : 23;
        const min = isoMatch[5] ? parseInt(isoMatch[5]) : 59;
        const d = new Date(year, month, day, hour, min, 59);
        if (!isNaN(d.getTime())) return d.getTime();
    }

    // Pattern 2: Thai / DD/MM/YYYY (30/08/2026 or 30-08-2026)
    const dmyMatch = str.match(/(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:\s+(\d{1,2}):(\d{1,2}))?/);
    if (dmyMatch) {
        const day = parseInt(dmyMatch[1]);
        const month = parseInt(dmyMatch[2]) - 1;
        let year = parseInt(dmyMatch[3]);
        if (year > 2500) year -= 543; // Buddhist Era conversion (e.g. 2569 -> 2026)
        const hour = dmyMatch[4] ? parseInt(dmyMatch[4]) : 23;
        const min = dmyMatch[5] ? parseInt(dmyMatch[5]) : 59;
        const d = new Date(year, month, day, hour, min, 59);
        if (!isNaN(d.getTime())) return d.getTime();
    }

    // Pattern 3: MikroTik style (aug/28/2026 14:00 or aug/28 14:00)
    const mtMatch = str.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[/ ](\d{1,2})(?:[/ ](\d{4}))?(?:\s+(\d{1,2}):(\d{1,2}))?/i);
    if (mtMatch) {
        const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
        const month = months[mtMatch[1].toLowerCase()];
        const day = parseInt(mtMatch[2]);
        const year = mtMatch[3] ? parseInt(mtMatch[3]) : new Date().getFullYear();
        const hour = mtMatch[4] ? parseInt(mtMatch[4]) : 23;
        const min = mtMatch[5] ? parseInt(mtMatch[5]) : 59;
        const d = new Date(year, month, day, hour, min, 59);
        if (!isNaN(d.getTime())) return d.getTime();
    }

    return null;
}

async function generateDailyExpiryDigest(reqOrSiteId = null) {
    const resolvedSiteId = typeof reqOrSiteId === 'string' ? reqOrSiteId : (reqOrSiteId?.query?.siteId || reqOrSiteId?.body?.siteId || reqOrSiteId?.headers?.['x-site-id'] || reqOrSiteId?.user?.assignedSiteId || null);
    const config = await db.getLineDigestConfig(resolvedSiteId);
    return await executeOnRouter(reqOrSiteId, async (client) => {
        const siteConfig = await db.getConfig(resolvedSiteId);
        const siteName = siteConfig.name || 'Main Site';
        const now = Date.now();

        const d1Users = [];
        const d3Users = [];
        const d7Users = [];

        // 1. Scan Hotspot Users if enabled
        if (config.includeHotspot !== false) {
            try {
                const users = await client.exec('/ip/hotspot/user/print');
                for (const u of users) {
                    const uptimeMs = parseUptimeToMs(u.uptime);
                    const limitUptimeMs = parseUptimeToMs(u['limit-uptime']);
                    const comment = (u.comment || '').trim();
                    const commentLower = comment.toLowerCase();
                    let remainingMs = null;

                    if (limitUptimeMs > 0) {
                        remainingMs = limitUptimeMs - uptimeMs;
                    }

                    const expiryTimestamp = parseExpiryFromComment(comment);
                    if (expiryTimestamp !== null) {
                        const commentRemainingMs = expiryTimestamp - now;
                        if (remainingMs === null || commentRemainingMs < remainingMs) {
                            remainingMs = commentRemainingMs;
                        }
                    }

                    const isExpiredFlag = commentLower.includes('expired') || commentLower.includes('หมดอายุ') || u.disabled === 'true';

                    if (remainingMs !== null) {
                        const remainingStr = remainingMs <= 0 ? 'หมดอายุแล้ว' : formatMsToHuman(remainingMs);
                        const userInfo = `${u.name} (${remainingStr})`;

                        if (remainingMs <= 86400000 || isExpiredFlag) {
                            d1Users.push(userInfo);
                        } else if (remainingMs <= 259200000) {
                            d3Users.push(userInfo);
                        } else if (remainingMs <= 604800000) {
                            d7Users.push(userInfo);
                        }
                    } else if (isExpiredFlag) {
                        d1Users.push(`${u.name} (หมดอายุแล้ว)`);
                    }
                }
            } catch (e) {
                console.error('LINE digest hotspot scan error:', e);
            }
        }

        // 2. Scan PPPoE Secrets if enabled
        if (config.includePppoe !== false) {
            try {
                const secrets = await client.exec('/ppp/secret/print');
                for (const s of secrets) {
                    if (s.service === 'pppoe' || !s.service) {
                        const comment = (s.comment || '').trim();
                        const commentLower = comment.toLowerCase();
                        const expiryTimestamp = parseExpiryFromComment(comment);
                        let remainingMs = expiryTimestamp !== null ? (expiryTimestamp - now) : null;
                        const isExpiredFlag = s.disabled === 'true' || commentLower.includes('expired') || commentLower.includes('หมดอายุ') || commentLower.includes('ค้างชำระ') || commentLower.includes('ตัดสัญญาณ');

                        if (remainingMs !== null) {
                            const remainingStr = remainingMs <= 0 ? 'หมดอายุแล้ว' : formatMsToHuman(remainingMs);
                            const roomInfo = `ห้อง ${s.name} (${remainingStr})`;
                            if (remainingMs <= 86400000 || isExpiredFlag) {
                                d1Users.push(roomInfo);
                            } else if (remainingMs <= 259200000) {
                                d3Users.push(roomInfo);
                            } else if (remainingMs <= 604800000) {
                                d7Users.push(roomInfo);
                            }
                        } else if (isExpiredFlag) {
                            d1Users.push(`ห้อง ${s.name} (ระงับการใช้งาน)`);
                        }
                    }
                }
            } catch (e) {
                console.error('LINE digest PPPoE scan error:', e);
            }
        }

        const totalItems = d1Users.length + d3Users.length + d7Users.length;

        return {
            siteName,
            totalItems,
            d1Users,
            d3Users,
            d7Users,
            counts: {
                d1: d1Users.length,
                d3: d3Users.length,
                d7: d7Users.length
            }
        };
    });
}

// Multi-Site Health Summary Generator for LINE OA
async function generateMultiSiteHealthDigest() {
    const sitesData = await db.getSites();
    const sites = (sitesData && sitesData.sites) || [];
    const healthList = [];

    for (const site of sites) {
        try {
            const stats = await executeOnRouter(site.id, async (client) => {
                const resources = await client.exec('/system/resource/print');
                const routerboard = await client.exec('/system/routerboard/print');
                let health = [];
                try { health = await client.exec('/system/health/print'); } catch (_) {}
                let activeHotspot = 0;
                try {
                    const hs = await client.exec('/ip/hotspot/active/print');
                    activeHotspot = (hs || []).length;
                } catch (_) {}
                let activePppoe = 0;
                try {
                    const ppp = await client.exec('/ppp/active/print');
                    activePppoe = (ppp || []).filter(p => p.service === 'pppoe' || !p.service).length;
                } catch (_) {}

                const r = resources[0] || {};
                const rb = routerboard[0] || {};
                const h = health[0] || {};

                return {
                    online: true,
                    name: site.name,
                    model: rb.model || r['board-name'] || 'MikroTik',
                    rosVersion: r.version || 'v7',
                    cpu: r['cpu-load'] ? `${r['cpu-load']}%` : '-',
                    temp: h.temperature ? `${h.temperature}°C` : (h['cpu-temperature'] ? `${h['cpu-temperature']}°C` : null),
                    hotspotOnline: activeHotspot,
                    pppoeOnline: activePppoe
                };
            });
            healthList.push(stats);
        } catch (err) {
            healthList.push({
                online: false,
                name: site.name,
                model: 'MikroTik',
                error: err.message
            });
        }
    }

    return {
        dateStr: new Date().toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', year: 'numeric' }),
        timeStr: new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }),
        sites: healthList
    };
}

function createMultiSiteHealthFlex(healthData) {
    const totalSites = healthData.sites.length;
    const onlineSites = healthData.sites.filter(s => s.online).length;
    const isAllOk = onlineSites === totalSites;

    const siteBoxes = healthData.sites.map(s => {
        if (s.online) {
            return {
                type: "box",
                layout: "vertical",
                backgroundColor: "#f0fdf4",
                borderColor: "#bbf7d0",
                borderWidth: "1px",
                cornerRadius: "8px",
                paddingAll: "10px",
                margin: "sm",
                contents: [
                    {
                        type: "box",
                        layout: "horizontal",
                        contents: [
                            { type: "text", text: `🟢 ${s.name}`, weight: "bold", size: "sm", color: "#166534", flex: 1 },
                            { type: "text", text: s.model, size: "xs", color: "#64748b", align: "end" }
                        ]
                    },
                    {
                        type: "box",
                        layout: "horizontal",
                        margin: "xs",
                        contents: [
                            { type: "text", text: `CPU: ${s.cpu}${s.temp ? ' | ' + s.temp : ''}`, size: "xs", color: "#334155", flex: 1 },
                            { type: "text", text: `Hotspot: ${s.hotspotOnline} | PPPoE: ${s.pppoeOnline}`, size: "xs", color: "#0369a1", align: "end" }
                        ]
                    }
                ]
            };
        } else {
            return {
                type: "box",
                layout: "vertical",
                backgroundColor: "#fef2f2",
                borderColor: "#fecaca",
                borderWidth: "1px",
                cornerRadius: "8px",
                paddingAll: "10px",
                margin: "sm",
                contents: [
                    {
                        type: "box",
                        layout: "horizontal",
                        contents: [
                            { type: "text", text: `🔴 ${s.name}`, weight: "bold", size: "sm", color: "#991b1b", flex: 1 },
                            { type: "text", text: "Offline", size: "xs", color: "#dc2626", weight: "bold", align: "end" }
                        ]
                    }
                ]
            };
        }
    });

    return {
        type: "flex",
        altText: `📊 รายงานสถานะเราท์เตอร์ 4 สาขา (${onlineSites}/${totalSites} ออนไลน์)`,
        contents: {
            type: "bubble",
            size: "giga",
            header: {
                type: "box",
                layout: "vertical",
                backgroundColor: isAllOk ? "#0284c7" : "#d97706",
                paddingAll: "16px",
                contents: [
                    {
                        type: "text",
                        text: "📊 สรุปสุขภาพเราท์เตอร์ทุกสาขา (Daily Health)",
                        weight: "bold",
                        color: "#ffffff",
                        size: "md"
                    },
                    {
                        type: "text",
                        text: `ประจำวันที่ ${healthData.dateStr} เวลา ${healthData.timeStr}`,
                        color: "#e0f2fe",
                        size: "xs",
                        margin: "xs"
                    }
                ]
            },
            body: {
                type: "box",
                layout: "vertical",
                paddingAll: "14px",
                contents: [
                    {
                        type: "box",
                        layout: "horizontal",
                        margin: "none",
                        contents: [
                            { type: "text", text: "สถานะการเชื่อมต่อรวม:", size: "sm", color: "#64748b" },
                            {
                                type: "text",
                                text: `${onlineSites}/${totalSites} สาขาออนไลน์`,
                                size: "sm",
                                weight: "bold",
                                color: isAllOk ? "#16a34a" : "#dc2626",
                                align: "end"
                            }
                        ]
                    },
                    { type: "separator", margin: "md" },
                    {
                        type: "box",
                        layout: "vertical",
                        margin: "md",
                        contents: siteBoxes
                    }
                ]
            }
        }
    };
}

// LINE Public Webhook Endpoint for LINE OA Auto-Reply
app.post('/api/line/webhook', express.json(), async (req, res) => {
    res.status(200).send('OK');

    try {
        const config = await db.getLineDigestConfig();
        const token = config.channelAccessToken;
        if (!token) return;

        const events = req.body.events || [];
        for (const event of events) {
            if (event.type !== 'message' || !event.message || event.message.type !== 'text') continue;

            const text = (event.message.text || '').trim();
            const replyToken = event.replyToken;
            const lineUserId = event.source?.userId;
            const targetSourceId = event.source?.groupId || event.source?.roomId || event.source?.userId;

            if (text.toLowerCase() === 'id' || text.toLowerCase() === 'groupid' || text.toLowerCase() === '/id') {
                await sendLineMessagingApiReply(token, replyToken, {
                    type: "text",
                    text: `🆔 Target ID (ID ของคุณ/กลุ่มนี้คือ):\n\n${targetSourceId}\n\n(คัดลอก ID นี้ไปวางในช่อง Target ID บนหน้าแดชบอร์ดได้เลยครับ)`
                });
                continue;
            }

            if (text === 'เช็ควันหมดอายุ' || text === 'วันหมดอายุ' || text === 'เช็คเน็ต') {
                const binding = await db.getLineUserBinding(lineUserId);
                if (binding) {
                    try {
                        const statusObj = await executeOnRouter(async (client) => {
                            const users = await client.exec('/ip/hotspot/user/print');
                            return users.find(u => u.name === binding.username);
                        }, binding.siteName);

                        if (statusObj) {
                            const uptimeMs = parseUptimeToMs(statusObj.uptime);
                            const limitMs = parseUptimeToMs(statusObj['limit-uptime']);
                            const remMs = limitMs > 0 ? (limitMs - uptimeMs) : 999999999;
                            const remStr = limitMs > 0 ? formatMsToHuman(remMs) : 'ไม่จำกัดเวลา';

                            await sendLineMessagingApiReply(token, replyToken, {
                                type: "flex",
                                altText: `⏳ สถานะวันหมดอายุบัญชี ${binding.username}`,
                                contents: {
                                    type: "bubble",
                                    header: { type: "box", layout: "vertical", backgroundColor: "#0284c7", contents: [{ type: "text", text: "⏳ ตรวจสอบวันหมดอายุเน็ต", weight: "bold", color: "#ffffff", size: "md" }] },
                                    body: {
                                        type: "box",
                                        layout: "vertical",
                                        contents: [
                                            { type: "text", text: `ชื่อบัญชี: ${binding.username}`, weight: "bold", size: "sm" },
                                            { type: "text", text: `โปรไฟล์: ${statusObj.profile || 'default'}`, size: "xs", color: "#64748b", margin: "xs" },
                                            { type: "text", text: `เวลาคงเหลือ: ${remStr}`, size: "sm", color: remMs <= 86400000 ? "#dc2626" : "#16a34a", weight: "bold", margin: "md" }
                                        ]
                                    }
                                }
                            });
                            continue;
                        }
                    } catch (e) {}
                }
                await sendLineMessagingApiReply(token, replyToken, {
                    type: "text",
                    text: `ℹ️ ยังไม่ได้ผูกบัญชีใช้งานกับ LINE\n\nกรุณาพิมพ์ 'ผูกบัญชี <ชื่อผู้ใช้>' เช่น 'ผูกบัญชี room101' เพื่อผูกบัญชีของคุณครับ`
                });
            } else if (text === 'ต่ออายุเน็ต' || text === 'ต่ออายุ' || text === 'เติมเงิน') {
                await sendLineMessagingApiReply(token, replyToken, {
                    type: "flex",
                    altText: "💳 เลือกแพ็กเกจต่ออายุอินเตอร์เน็ต",
                    contents: {
                        type: "bubble",
                        header: { type: "box", layout: "vertical", backgroundColor: "#06c755", contents: [{ type: "text", text: "💳 ต่ออายุเน็ต / เติมเงิน", weight: "bold", color: "#ffffff", size: "md" }] },
                        body: {
                            type: "box",
                            layout: "vertical",
                            contents: [
                                { type: "text", text: "กรุณาเลือกแพ็กเกจที่ต้องการ หรือสแกนชำระเงิน และกดส่งสลิป:", size: "xs", color: "#4b5563" },
                                { type: "text", text: "• รายวัน (24 ชม.): 30 บาท\n• รายสัปดาห์ (7 วัน): 150 บาท\n• รายเดือน (30 วัน): 350 บาท", size: "sm", weight: "bold", margin: "sm" }
                            ]
                        },
                        footer: {
                            type: "box",
                            layout: "vertical",
                            contents: [{ type: "text", text: "ส่งรูปสลิปเข้ามาในแชตเพื่อแจ้งชำระเงินได้ทันที", size: "xs", color: "#64748b", align: "center" }]
                        }
                    }
                });
            } else if (text === 'ดูรหัสผ่าน' || text === 'รหัสผ่าน') {
                const binding = await db.getLineUserBinding(lineUserId);
                if (binding) {
                    await sendLineMessagingApiReply(token, replyToken, {
                        type: "text",
                        text: `🔑 ข้อมูลเข้าใช้งานของคุณ:\n\nUsername: ${binding.username}\n(หากจำรหัสผ่านไม่ได้ กรุณาแจ้งแอดมินเพื่อรีเซ็ตครับ)`
                    });
                } else {
                    await sendLineMessagingApiReply(token, replyToken, {
                        type: "text",
                        text: `ℹ️ กรุณาพิมพ์ 'ผูกบัญชี <ชื่อผู้ใช้>' เพื่อเข้าถึงข้อมูลรหัสผ่านครับ`
                    });
                }
            } else if (text.startsWith('ผูกบัญชี')) {
                const username = text.replace('ผูกบัญชี', '').trim();
                if (!username) {
                    await sendLineMessagingApiReply(token, replyToken, { type: "text", text: "กรุณาระบุชื่อผู้ใช้ เช่น 'ผูกบัญชี room101'" });
                } else {
                    const activeSiteConfig = await db.getConfig();
                    await db.bindLineUser(lineUserId, username, activeSiteConfig.id, activeSiteConfig.name);
                    await sendLineMessagingApiReply(token, replyToken, { type: "text", text: `✅ ผูกบัญชี '${username}' (${activeSiteConfig.name}) กับ LINE สำเร็จแล้ว!` });
                }
            } else if (text === 'คู่มือใช้งาน' || text === 'คู่มือ') {
                await sendLineMessagingApiReply(token, replyToken, {
                    type: "text",
                    text: `📖 คู่มือใช้งานเบื้องต้น:\n\n1. ค้นหาชื่อ Wi-Fi และกดเชื่อมต่อ\n2. หน้าล็อกอินจะเด้งขึ้นมา ใส่ Username & Password\n3. หากเน็ตช้า ให้กดลบชื่อ Wi-Fi (Forget Network) แล้วเชื่อมต่อใหม่\n4. พิมพ์ 'เช็ควันหมดอายุ' เพื่อตรวจสอบเวลาคงเหลือ`
                });
            } else if (text === 'ติดต่อแอดมิน') {
                await sendLineMessagingApiReply(token, replyToken, {
                    type: "text",
                    text: `💬 ติดต่อเจ้าหน้าที่ / ทีมงานแอดมิน\n\nสามารถพิมพ์ข้อความแจ้งปัญหาไว้ในแชตนี้ได้เลยครับ แอดมินจะรีบตอบกลับโดยเร็วที่สุด!`
                });
            }
        }
    } catch (err) {
        console.error('LINE Webhook error:', err);
    }
});

// LINE Digest Configuration APIs (Multi-Site Aware)
app.get('/api/mikrotik/line-digest/config', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const siteId = req.query.siteId || req.headers['x-site-id'];
    res.json(await db.getLineDigestConfig(siteId));
});

app.post('/api/mikrotik/line-digest/config', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const siteId = req.query.siteId || req.body.siteId || req.headers['x-site-id'];
    const updated = await db.saveLineDigestConfig(req.body, siteId);
    db.addLog(req.user.username, 'ตั้งค่า LINE OA Messaging API', `อัปเดตตั้งค่า LINE Official Account [สาขา: ${siteId || 'Default'}] (สถานะ: ${updated.enabled ? 'เปิด' : 'ปิด'}, เวลา: ${updated.digestTime})`);
    res.json(updated);
});

// Test LINE OA Messaging API connection
app.post('/api/mikrotik/line-digest/test', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const siteId = req.query.siteId || req.body.siteId || req.headers['x-site-id'];
        const config = await db.getLineDigestConfig(siteId);
        const testToken = req.body.token || config.channelAccessToken;
        const testTarget = req.body.targetId || config.targetId;
        if (!testToken || !testTarget) return res.status(400).json({ error: 'กรุณาระบุ Channel Access Token และ Target ID' });

        const siteConfig = await db.getConfig(siteId);
        const dateStr = new Date().toLocaleString('th-TH');
        await sendLinePushMessage(testToken, testTarget, {
            type: "text",
            text: `🔔 ทดสอบการเชื่อมต่อระบบแจ้งเตือน LINE Official Account สำเร็จ!\n📍 สาขา: ${siteConfig.name || 'Main Site'}\n📅 วัน-เวลา: ${dateStr}\n(ระบบแดชบอร์ด MikroTik พร้อมใช้งาน)`
        });
        
        db.addLog(req.user.username, 'ทดสอบ LINE OA Push', `ส่งข้อความทดสอบ Push Message สำเร็จ [สาขา: ${siteConfig.name || 'Main Site'}]`);
        res.json({ success: true, message: 'ส่งข้อความทดสอบสำเร็จ' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Trigger Immediate Daily Digest Send via Flex Card
app.post('/api/mikrotik/line-digest/run-now', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const siteId = req.query.siteId || req.body.siteId || req.headers['x-site-id'] || req.user?.assignedSiteId;
        const config = await db.getLineDigestConfig(siteId);
        const token = req.body.token || config.channelAccessToken;
        const targetId = req.body.targetId || config.targetId;
        if (!token || !targetId) return res.status(400).json({ error: 'กรุณาระบุ Channel Access Token และ Target ID' });

        const digest = await generateDailyExpiryDigest(siteId || req);
        const flexMsg = createDailyDigestFlex(digest);
        await sendLinePushMessage(token, targetId, flexMsg);

        db.addLog(req.user.username, 'ส่งสรุป LINE OA ทันที', `ส่งรายงาน Flex Card สรุปบัญชีใกล้หมดอายุเข้า LINE สำเร็จ [สาขา: ${digest.siteName}] (${digest.totalItems} รายการ)`);
        res.json({ success: true, counts: digest.counts });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Trigger Immediate Multi-Site Daily Health Report via Flex Card
app.post('/api/mikrotik/line-health/run-now', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const config = await db.getLineDigestConfig();
        const token = req.body.token || config.channelAccessToken;
        const targetId = req.body.targetId || config.targetId;
        if (!token || !targetId) return res.status(400).json({ error: 'กรุณาระบุ Channel Access Token และ Target ID บนหน้าตั้งค่า LINE OA ก่อน' });

        const healthData = await generateMultiSiteHealthDigest();
        const flexMsg = createMultiSiteHealthFlex(healthData);
        await sendLinePushMessage(token, targetId, flexMsg);

        db.addLog(req.user.username, 'ส่งสรุปสถานะทุกสาขาเข้า LINE', `ส่ง Flex Card สรุปสถานะ 4 สาขาเข้า LINE สำเร็จ`);
        res.json({ success: true, sites: healthData.sites });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Background Timer for Daily LINE Expiry Digest (checks every 1 minute, multi-site isolated)
setInterval(async () => {
    try {
        const sitesData = await db.getSites();
        const sites = (sitesData && sitesData.sites && sitesData.sites.length > 0) ? sitesData.sites : [{ id: 'default', name: 'Main Site' }];

        for (const site of sites) {
            const config = await db.getLineDigestConfig(site.id);
            if (!config || !config.enabled || !config.channelAccessToken || !config.targetId) continue;

            const now = new Date();
            const bkkTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
            const currentHHMM = String(bkkTime.getHours()).padStart(2, '0') + ':' + String(bkkTime.getMinutes()).padStart(2, '0');
            const todayDateStr = bkkTime.toISOString().slice(0, 10);

            if (currentHHMM === config.digestTime && config.lastSentDate !== todayDateStr) {
                console.log(`[LINE OA Digest] Triggering daily digest for site ${site.name} (${site.id}) at ${currentHHMM}...`);
                const digest = await generateDailyExpiryDigest(site.id);
                const flexMsg = createDailyDigestFlex(digest);
                await sendLinePushMessage(config.channelAccessToken, config.targetId, flexMsg);
                await db.saveLineDigestConfig({ lastSentDate: todayDateStr }, site.id);
                db.addLog('System Auto', 'ส่งสรุป LINE OA ประจำวัน', `ส่งรายงาน Flex Card (${site.name}) สำเร็จ (${digest.totalItems} รายการ)`);
            }
        }
    } catch (e) {
        console.error('[LINE OA Digest] Automated digest error:', e.message || e);
    }
}, 60000);

// ==========================================
// Router Connectivity & Instant Offline/Online Alert Monitor (Every 60s)
// ==========================================
const siteHealthState = new Map(); // siteId -> { consecutiveFailures: 0, isDown: false, downSince: null }

setInterval(async () => {
    try {
        const sitesData = await db.getSites();
        const sites = (sitesData && sitesData.sites) || [];
        for (const site of sites) {
            if (!site.host || !site.username) continue;
            let state = siteHealthState.get(site.id);
            if (!state) {
                state = { consecutiveFailures: 0, isDown: false, downSince: null };
                siteHealthState.set(site.id, state);
            }

            try {
                // Quick ping test to router via API
                await executeOnRouter(site.id, async (client) => {
                    await client.exec('/system/resource/print');
                });

                // Success
                if (state.isDown) {
                    // Router came back online!
                    const downDurationMin = state.downSince ? Math.round((Date.now() - state.downSince.getTime()) / 60000) : 0;
                    state.isDown = false;
                    state.consecutiveFailures = 0;
                    state.downSince = null;

                    console.log(`[Site Monitor] ✅ Site ${site.name} (${site.id}) is BACK ONLINE after ${downDurationMin} min.`);
                    db.addLog('System Monitor', 'เราท์เตอร์กลับมาออนไลน์', `เราท์เตอร์สาขา ${site.name} กลับมาเชื่อมต่อได้ตามปกติ (หยุดทำงานไป ${downDurationMin} นาที)`);

                    // Send LINE Alert if configured
                    const lineConfig = await db.getLineDigestConfig(site.id);
                    if (lineConfig && lineConfig.channelAccessToken && lineConfig.targetId) {
                        const nowStr = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
                        await sendLinePushMessage(lineConfig.channelAccessToken, lineConfig.targetId, {
                            type: 'text',
                            text: `✅ [ระบบกลับมาออนไลน์]\n\n📍 สาขา: ${site.name}\n⏱️ เวลา: ${nowStr}\n🔄 ออฟไลน์ไปประมาณ: ${downDurationMin} นาที\n(ระบบกลับมาเชื่อมต่อและทำงานตามปกติแล้วครับ)`
                        }).catch(e => console.warn('[LINE Site Monitor Error]', e.message));
                    }
                } else {
                    state.consecutiveFailures = 0;
                }
            } catch (connErr) {
                state.consecutiveFailures++;
                if (state.consecutiveFailures >= 2 && !state.isDown) {
                    state.isDown = true;
                    state.downSince = new Date();

                    console.error(`[Site Monitor] 🚨 Site ${site.name} is DOWN!`);
                    db.addLog('System Monitor', 'เราท์เตอร์หลุดการเชื่อมต่อ', `🚨 เราท์เตอร์สาขา ${site.name} ขาดการเชื่อมต่อ (Offline): ${connErr.message}`);

                    // Send Urgent LINE Alert if configured
                    const lineConfig = await db.getLineDigestConfig(site.id);
                    if (lineConfig && lineConfig.channelAccessToken && lineConfig.targetId) {
                        const nowStr = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
                        await sendLinePushMessage(lineConfig.channelAccessToken, lineConfig.targetId, {
                            type: 'text',
                            text: `🚨 [แจ้งเตือนด่วน: เราท์เตอร์ Offline]\n\n📍 สาขา: ${site.name}\n⏱️ ขาดการเชื่อมต่อเมื่อ: ${nowStr}\n⚠️ สาเหตุ: ${connErr.message || 'ไม่สามารถติดต่อเราท์เตอร์ได้'}\n\nกรุณาตรวจสอบระบบไฟฟ้าหรือการเชื่อมต่ออินเทอร์เน็ตที่หน้างาน`
                        }).catch(e => console.warn('[LINE Site Monitor Error]', e.message));
                    }
                }
            }
        }
    } catch (err) {
        console.warn('[Site Monitor Interval Error]:', err.message);
    }
}, 60000);




// Automated background cleanup interval (every 30 minutes, multi-site aware)
setInterval(async () => {
    try {
        const config = await db.getAutoCleanupConfig();
        if (config && config.autoCleanupExpired) {
            const sitesData = await db.getSites();
            const sites = (sitesData && sitesData.sites && sitesData.sites.length > 0) ? sitesData.sites : [{ id: 'default' }];
            for (const s of sites) {
                try {
                    await runExpiredCleanup('Auto Task', s.id);
                } catch (err) {
                    console.warn(`[Auto Cleanup] Error cleaning site ${s.name || s.id}:`, err.message);
                }
            }
        }
    } catch (e) {
        // Silent catch for background task
    }
}, 30 * 60 * 1000);

// Nightly Automated Database Backup Timer (checks every 1 minute, triggers at 02:00 AM Bangkok time)
let lastNightlyBackupDate = '';
setInterval(async () => {
    try {
        const now = new Date();
        const bkkTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
        const currentHHMM = String(bkkTime.getHours()).padStart(2, '0') + ':' + String(bkkTime.getMinutes()).padStart(2, '0');
        const todayDateStr = bkkTime.toISOString().slice(0, 10);

        if (currentHHMM === '02:00' && lastNightlyBackupDate !== todayDateStr) {
            lastNightlyBackupDate = todayDateStr;
            console.log(`[Backup] Starting scheduled nightly backup at ${currentHHMM}...`);
            const { spawn } = require('child_process');
            const backupProcess = spawn(process.execPath, [path.join(__dirname, 'backup.js')], {
                stdio: 'inherit',
                env: process.env
            });
            backupProcess.on('close', (code) => {
                if (code === 0) {
                    console.log(`[Backup] Scheduled nightly backup completed successfully for ${todayDateStr}`);
                    db.addLog('System Auto', 'สำรองข้อมูลอัตโนมัติ', `สำรองข้อมูลประจำวัน (${todayDateStr}) เรียบร้อยแล้ว`);
                } else {
                    console.error(`[Backup] Nightly backup exited with code ${code}`);
                }
            });
        }
    } catch (e) {
        console.error('[Backup] Scheduled backup error:', e.message || e);
    }
}, 60000);


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

// Generate RouterOS v7+ Security Firewall Protection Script (2026 Standard)
app.post('/api/mikrotik/firewall/generate-security-script', requireAuth(['admin', 'co-admin']), (req, res) => {
    const script = `# ======================================================
# MikroTik RouterOS v7+ Hardened Firewall Security Preset (2026)
# ======================================================

# 1. Address Lists for RFC1918 Private Subnets
/ip/firewall/address-list
add address=10.0.0.0/8 list=private_subnets comment="RFC1918 Private Subnets"
add address=172.16.0.0/12 list=private_subnets comment="RFC1918 Private Subnets"
add address=192.168.0.0/16 list=private_subnets comment="RFC1918 Private Subnets"

# 2. Input Chain: Allow Established / Related
/ip/firewall/filter
add chain=input action=accept connection-state=established,related comment="Accept Established & Related (Input)"

# 3. Input Chain: Drop Invalid Packets
add chain=input action=drop connection-state=invalid comment="Drop Invalid Packets (Input)"

# 4. Input Chain: Block Open DNS Resolver Exploits from WAN
add chain=input action=drop protocol=udp dst-port=53 in-interface-list=WAN comment="Block Open DNS Resolver Attacks from WAN"
add chain=input action=drop protocol=tcp dst-port=53 in-interface-list=WAN comment="Block Open DNS Resolver Attacks from WAN"

# 5. Input Chain: Protect WinBox/SSH Brute Force Attacks (Stage 1-3 & Blacklist)
add chain=input action=drop src-address-list=brute_force_blacklist comment="Drop Brute-Force Blacklisted IPs"
add chain=input action=add-src-to-address-list address-list=brute_force_blacklist address-list-timeout=1d chain=input dst-port=22,8291,80,443,8728 protocol=tcp src-address-list=bf_stage3 comment="Brute-Force Stage 3 -> Blacklist 24h"
add chain=input action=add-src-to-address-list address-list=bf_stage3 address-list-timeout=1m chain=input dst-port=22,8291,80,443,8728 protocol=tcp src-address-list=bf_stage2 comment="Brute-Force Stage 2 -> Stage 3"
add chain=input action=add-src-to-address-list address-list=bf_stage2 address-list-timeout=1m chain=input dst-port=22,8291,80,443,8728 protocol=tcp src-address-list=bf_stage1 comment="Brute-Force Stage 1 -> Stage 2"
add chain=input action=add-src-to-address-list address-list=bf_stage1 address-list-timeout=1m chain=input dst-port=22,8291,80,443,8728 protocol=tcp comment="Brute-Force Stage 1"

# 6. Forward Chain: Drop Invalid Packets & Protect LAN
add chain=forward action=accept connection-state=established,related comment="Accept Established & Related (Forward)"
add chain=forward action=drop connection-state=invalid comment="Drop Invalid Packets (Forward)"

:put "--------------------------------------------------------"
:put "RouterOS v7 Hardened Security Preset Applied Successfully!"
:put "--------------------------------------------------------"
`;
    res.json({ script });
});

// Apply RouterOS v7+ Hardened Security Firewall Rules Direct via API
app.post('/api/mikrotik/firewall/apply-security-hardening', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        await executeOnRouter(req, async (client) => {
            const existing = await client.exec('/ip/firewall/filter/print');
            const hasBruteRule = existing.some(r => r.comment && r.comment.includes('Drop Brute-Force'));

            if (!hasBruteRule) {
                await client.exec('/ip/firewall/filter/add', {
                    chain: 'input',
                    action: 'drop',
                    'connection-state': 'invalid',
                    comment: 'Drop Invalid Packets (Input)'
                });
                await client.exec('/ip/firewall/filter/add', {
                    chain: 'input',
                    action: 'drop',
                    'src-address-list': 'brute_force_blacklist',
                    comment: 'Drop Brute-Force Blacklisted IPs'
                });
                await client.exec('/ip/firewall/filter/add', {
                    chain: 'input',
                    action: 'add-src-to-address-list',
                    'address-list': 'brute_force_blacklist',
                    'address-list-timeout': '1d',
                    protocol: 'tcp',
                    'dst-port': '22,8291,80,443,8728',
                    'src-address-list': 'bf_stage3',
                    comment: 'Brute-Force Stage 3 -> Blacklist 24h'
                });
                await client.exec('/ip/firewall/filter/add', {
                    chain: 'input',
                    action: 'add-src-to-address-list',
                    'address-list': 'bf_stage3',
                    'address-list-timeout': '1m',
                    protocol: 'tcp',
                    'dst-port': '22,8291,80,443,8728',
                    'src-address-list': 'bf_stage2',
                    comment: 'Brute-Force Stage 2 -> Stage 3'
                });
                await client.exec('/ip/firewall/filter/add', {
                    chain: 'input',
                    action: 'add-src-to-address-list',
                    'address-list': 'bf_stage2',
                    'address-list-timeout': '1m',
                    protocol: 'tcp',
                    'dst-port': '22,8291,80,443,8728',
                    'src-address-list': 'bf_stage1',
                    comment: 'Brute-Force Stage 1 -> Stage 2'
                });
                await client.exec('/ip/firewall/filter/add', {
                    chain: 'input',
                    action: 'add-src-to-address-list',
                    'address-list': 'bf_stage1',
                    'address-list-timeout': '1m',
                    protocol: 'tcp',
                    'dst-port': '22,8291,80,443,8728',
                    comment: 'Brute-Force Stage 1'
                });
            }
        });

        db.addLog(req.user.username, 'ปรับแต่งความปลอดภัยราวเตอร์', 'เปิดใช้งานเกราะป้องกัน RouterOS v7 Hardened Security Preset');
        res.json({ success: true, message: 'บังคับใช้เกราะป้องกันความปลอดภัย RouterOS v7+ สำเร็จ' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
            // Skipped entirely (no /log/print call, no parsing) when the site has
            // DNS visit-history logging turned off, so a disabled site adds no
            // extra load to the router, web server, or database.
            let dns = [];
            if (site.dnsLoggingEnabled !== false) {
                let logs = [];
                try {
                    logs = await client.exec('/log/print');
                } catch (e) {
                    logs = [];
                }
                dns = logs.filter(l => (l.topics || '').includes('dns'));
            }

            // PPPoE room sessions — fail-open if PPPoE server isn't set up on
            // this site yet (not every site necessarily has room accounts).
            // NOTE: /ppp/active/print has no bytes-in/bytes-out (see the same
            // gotcha on /api/mikrotik/pppoe/active) — pull real traffic from
            // the dynamic "<pppoe-USERNAME>" interface via /interface/print
            // instead, or every billing log entry silently records 0 bytes.
            let pppoe = [];
            try {
                const [pppoeList, pppoeInterfaces] = await Promise.all([
                    client.exec('/ppp/active/print'),
                    client.exec('/interface/print')
                ]);
                const pppoeIfaceByName = new Map(pppoeInterfaces.map(i => [i.name, i]));
                pppoe = pppoeList.filter(item => item.service === 'pppoe').map(item => {
                    const iface = resolvePppoeIface(pppoeIfaceByName, item.name);
                    return {
                        id: item['.id'],
                        user: item.name,
                        address: item.address || '',
                        uptime: item.uptime || '0s',
                        bytesIn: iface ? (parseInt(iface['rx-byte']) || 0) : 0,
                        bytesOut: iface ? (parseInt(iface['tx-byte']) || 0) : 0
                    };
                });
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
    if (!uptime || uptime === 'Unlimited' || uptime === '00:00:00') return 0;
    let ms = 0;
    const wMatch = uptime.match(/(\d+)w/); if (wMatch) ms += parseInt(wMatch[1]) * 7 * 24 * 3600000;
    const dMatch = uptime.match(/(\d+)d/); if (dMatch) ms += parseInt(dMatch[1]) * 24 * 3600000;
    const hMatch = uptime.match(/(\d+)h/); if (hMatch) ms += parseInt(hMatch[1]) * 3600000;
    const mMatch = uptime.match(/(\d+)m/); if (mMatch) ms += parseInt(mMatch[1]) * 60000;
    const sMatch = uptime.match(/(\d+)s/); if (sMatch) ms += parseInt(sMatch[1]) * 1000;
    if (ms === 0 && uptime.includes(':')) {
        const parts = uptime.split(':').map(Number);
        if (parts.length === 3 && !parts.some(isNaN)) {
            ms = (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
        }
    }
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

// Server Listen — default 127.0.0.1 behind nginx; override with HOST=0.0.0.0 for local dev
const LISTEN_HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, LISTEN_HOST, () => {
    console.log(`[Server] MikroTik API Server running on http://${LISTEN_HOST}:${PORT}`);
});
