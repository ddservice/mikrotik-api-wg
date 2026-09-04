const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const logArchive = require('./lib/log-archive');
const storageMonitor = require('./lib/storage-monitor');
// ตรรกะเวลาทั้งหมดอยู่ที่ lib/time.js ที่เดียว — บั๊กเกือบทุกตัวช่วง 28-30 ส.ค.
// เป็นเรื่องเวลา และเกิดจากการเขียนตรรกะเดียวกันซ้ำหลายที่คนละแบบ
const {
    bangkokNow, bangkokToday, parseHHMMToMinutes,
    parseUptimeToMs, parseRouterOsLogTime
} = require('./lib/time');
const { parseDnsLogMessage } = require('./lib/dns-log');
const sessionStore = require('./lib/session-store');
const siteDiagnostics = require('./lib/site-diagnostics');
const rosErrors = require('./lib/routeros-errors');
const mwAnalyze = require('./lib/multiwan-analyze');
const mwPlan = require('./lib/multiwan-plan');
const mwApply = require('./lib/multiwan-apply');
const pccWeights = require('./lib/pcc-weights');
const dnsStore = require('./lib/dns-log-store');
const { streamCsv, forEachPage, forEachPageReverse, csvRow } = require('./lib/csv-export');

// ส่งออกได้ทีละคำขอเท่านั้นทั้งระบบ
//
// การส่งออกหนึ่งครั้งต้องเรียงข้อมูลทีละวันในหน่วยความจำ วัดจริงกับวันที่มี 580,000 แถว
// ใช้ RSS สูงสุดหลายร้อย MB ขณะที่ PM2 ตั้ง max_memory_restart ไว้ 500M
// สองคำขอพร้อมกันจึงทำให้ PM2 ฆ่า process กลางคัน ซึ่งไม่ได้พังแค่ไฟล์ที่กำลังส่ง
// แต่ตัดทุก request ที่ค้างอยู่ตอนนั้นด้วย
//
// การส่งออกเป็นงานที่ทำนาน ๆ ครั้ง (ตอนมีหมายเรียก) การต่อคิวจึงไม่กระทบการใช้งานปกติ
let exportInFlight = null;

function beginExport(label) {
    if (exportInFlight) return null;
    exportInFlight = label;
    return () => { exportInFlight = null; };
}

// Auto-select database: Supabase (if env set) หรือ JSON file (legacy)
// Ignore placeholder Supabase env (YOUR_PROJECT_ID) — loading them would silently
// fall back to Local JSON while looking configured (incident 2026-08-13).
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

// ---------- หน้าเว็บเก่า (v1) กับหน้าใหม่ (v2) ----------
//
// ตั้งแต่ 2026-09-04 v2 ทำได้ครบทุกอย่างที่ v1 ทำได้แล้ว แต่ยังไม่ตัด v1 ทิ้ง
// เพราะกฎในไฟล์นี้เขียนไว้ว่าห้ามลบจนกว่าจะมีคนคลิกใช้จริงจนครบด้วยมือ
//
// UI_DEFAULT คุมว่า "/" จะเสิร์ฟตัวไหน โดยไม่ต้องแก้โค้ดหรือ deploy ใหม่:
//   UI_DEFAULT=v1 (ค่าเริ่มต้น)  "/" = หน้าเดิม
//   UI_DEFAULT=v2                "/" = หน้าใหม่
// ย้อนกลับได้ใน 10 วินาทีด้วยการแก้ค่าใน ecosystem.config.js แล้ว pm2 reload
// ซึ่งสำคัญกว่าการเลือกค่าเริ่มต้นถูกตั้งแต่แรก
//
// ไม่ว่าตั้งค่าไหน /v1/ กับ /v2/ ก็ยังเข้าได้เสมอ คนที่คุ้นกับหน้าไหนจึงเปิดตรงนั้นได้เลย
const UI_DEFAULT = String(process.env.UI_DEFAULT || 'v1').toLowerCase() === 'v2' ? 'v2' : 'v1';

const STATIC_OPTS = {
    maxAge: '1d',
    etag: true,
    setHeaders: (res, filepath) => {
        if (filepath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
        }
    }
};

// "/" ต้องตัดสินใจก่อน express.static จะเสิร์ฟ public/index.html ให้อัตโนมัติ
app.get('/', (req, res, next) => {
    if (UI_DEFAULT !== 'v2') return next();   // ปล่อยให้ static เสิร์ฟหน้าเดิมตามปกติ
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(path.join(__dirname, 'public', 'v2', 'index.html'));
});

// URL ถาวรของหน้าเดิม — ต้องมีก่อนสลับ ไม่งั้นพอ "/" กลายเป็น v2 แล้วจะไม่มีทางเข้า v1 เลย
// mount ทั้งโฟลเดอร์เพราะ index.html ของ v1 อ้างไฟล์แบบ relative (app.js?v=, style.css?v=)
// ถ้าเสิร์ฟแค่ไฟล์ HTML เดี่ยว ๆ เบราว์เซอร์จะหา /v1/app.js ไม่เจอ
// (ต่างจาก v2 ที่ vite ตั้ง base เป็น /v2/ จึงอ้างแบบ absolute อยู่แล้ว)
app.use('/v1', express.static(path.join(__dirname, 'public'), STATIC_OPTS));

// Static Assets Caching Strategy (Fast asset loading + no-cache for index.html)
app.use(express.static(path.join(__dirname, 'public'), STATIC_OPTS));

// Session store — คีย์เป็น "แฮชของ token" ไม่ใช่ token ตรง ๆ (ดู lib/session-store.js)
//
// เดิมอยู่ในหน่วยความจำล้วน ทุกครั้งที่ deploy ผู้ใช้หลุดออกจากระบบหมด
// ตอนนี้เขียนลงไฟล์และโหลดกลับตอนบูต พฤติกรรมอื่นเหมือนเดิมทุกอย่าง
// (ต่ออายุเมื่อใช้งาน, logout แล้วใช้ต่อไม่ได้, แก้/ลบบัญชีแล้วเตะออก)
const activeSessions = new Map();
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const SESSION_FILE = path.join(__dirname, 'db', 'sessions.json');

try {
    if (fs.existsSync(SESSION_FILE)) {
        const restored = sessionStore.deserialize(fs.readFileSync(SESSION_FILE, 'utf8'));
        for (const [k, v] of restored.entries()) activeSessions.set(k, v);
        if (restored.size) console.log(`[Session] กู้คืน ${restored.size} session ที่ยังไม่หมดอายุ`);
    }
} catch (e) {
    // อ่านไม่ได้ = ทุกคนต้องล็อกอินใหม่ ซึ่งยอมรับได้
    // แต่ห้ามทำให้ server สตาร์ตไม่ขึ้นเด็ดขาด
    console.warn('[Session] อ่านไฟล์ session เดิมไม่ได้:', e.message);
}

// เขียนลงไฟล์แบบหน่วงเวลา — expires ถูกต่ออายุทุก request การเขียนทุกครั้ง
// จะกลายเป็น disk write ต่อ request ซึ่งไม่คุ้ม หน่วงไว้แล้วเขียนรวดเดียวพอ
let sessionSaveTimer = null;
function persistSessionsSoon() {
    if (sessionSaveTimer) return;
    sessionSaveTimer = setTimeout(() => {
        sessionSaveTimer = null;
        persistSessionsNow();
    }, 30000);
    if (sessionSaveTimer.unref) sessionSaveTimer.unref();
}

function persistSessionsNow() {
    try {
        const dir = path.dirname(SESSION_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        // เขียนไฟล์ชั่วคราวแล้วค่อย rename — กันไฟล์พังครึ่ง ๆ ถ้าดับกลางคัน
        const tmp = SESSION_FILE + '.tmp';
        fs.writeFileSync(tmp, sessionStore.serialize(activeSessions), { mode: 0o600 });
        fs.renameSync(tmp, SESSION_FILE);
    } catch (e) {
        console.warn('[Session] บันทึก session ไม่สำเร็จ:', e.message);
    }
}

// PM2 reload ส่ง SIGINT มาก่อน — บันทึกให้ทันก่อนปิด ไม่งั้นการ deploy
// ยังทำให้คนหลุดอยู่ดี ซึ่งคือปัญหาที่ตั้งใจแก้ตั้งแต่แรก
['SIGINT', 'SIGTERM'].forEach((sig) => {
    process.on(sig, () => {
        persistSessionsNow();
        persistWgTokens();
        process.exit(0);
    });
});

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
    persistSessionsNow();
    persistWgTokens();
}, 15 * 60 * 1000);

// Single-use tokens for the RouterOS auto-callback registration flow
// (token -> { wireguardIp, siteId, expiresAt }) — see /api/wireguard/generate-script
// and /api/wireguard/callback-register
//
// เก็บลงไฟล์ด้วยเหตุผลเดียวกับ session: ถ้า server รีสตาร์ตระหว่างที่แอดมิน
// กำลังเอาสคริปต์ไปวางใน WinBox token จะหายไป เราท์เตอร์โทรกลับมาแล้วได้ 401
// การลงทะเบียนอัตโนมัติล้มเหลว ต้องกดสร้างสคริปต์ใหม่แล้ววางซ้ำ
//
// ช่องนี้แคบ (30 นาที) และแก้ได้ด้วยการกดปุ่มซ้ำ แต่เกิดตอน "ติดตั้งสาขาใหม่"
// ซึ่งเป็นจังหวะที่คนกำลังยืนอยู่หน้างานและเสียเวลาแพงที่สุด การกันไว้จึงคุ้ม
// โดยเฉพาะเมื่อโครงสร้างการเก็บมีอยู่แล้วจากงาน session
const wgRegistrationTokens = new Map();
const WG_TOKEN_TTL_MS = 30 * 60 * 1000; // 30 min, single-use
const WG_TOKEN_FILE = path.join(__dirname, 'db', 'wg-registration-tokens.json');

try {
    if (fs.existsSync(WG_TOKEN_FILE)) {
        const raw = JSON.parse(fs.readFileSync(WG_TOKEN_FILE, 'utf8'));
        const list = (raw && Array.isArray(raw.tokens)) ? raw.tokens : [];
        const now = Date.now();
        let restored = 0;
        for (const t of list) {
            if (!t || typeof t.token !== 'string') continue;
            if (typeof t.expiresAt !== 'number' || t.expiresAt <= now) continue;
            wgRegistrationTokens.set(t.token, {
                wireguardIp: t.wireguardIp, siteId: t.siteId || null, expiresAt: t.expiresAt
            });
            restored++;
        }
        if (restored) console.log(`[WG] กู้คืน ${restored} token ลงทะเบียนที่ยังไม่หมดอายุ`);
    }
} catch (e) {
    // เหมือน session: อ่านไม่ได้ก็แค่ต้องกดสร้างสคริปต์ใหม่ ห้ามทำให้ server ไม่ขึ้น
    console.warn('[WG] อ่านไฟล์ token ลงทะเบียนเดิมไม่ได้:', e.message);
}

function persistWgTokens() {
    try {
        const dir = path.dirname(WG_TOKEN_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const now = Date.now();
        const tokens = [];
        for (const [token, r] of wgRegistrationTokens.entries()) {
            if (!r || typeof r.expiresAt !== 'number' || r.expiresAt <= now) continue;
            tokens.push({ token, wireguardIp: r.wireguardIp, siteId: r.siteId || null, expiresAt: r.expiresAt });
        }
        const tmp = WG_TOKEN_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, tokens }), { mode: 0o600 });
        fs.renameSync(tmp, WG_TOKEN_FILE);
    } catch (e) {
        console.warn('[WG] บันทึก token ลงทะเบียนไม่สำเร็จ:', e.message);
    }
}

// Middleware: Authentication
function requireAuth(allowedRoles = []) {
    return (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized: Missing token' });
        }
        
        const tokenKey = sessionStore.hashToken(authHeader.substring(7));
        const session = activeSessions.get(tokenKey);

        if (!session) {
            return res.status(401).json({ error: 'Unauthorized: Invalid token' });
        }

        if (session.expires < Date.now()) {
            activeSessions.delete(tokenKey);
            return res.status(401).json({ error: 'Unauthorized: Token expired' });
        }

        // Refresh session expiry
        session.expires = Date.now() + SESSION_EXPIRY_MS;
        persistSessionsSoon();
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

// การเชื่อมต่อที่ "กำลังต่ออยู่" ณ ตอนนี้ — poolKey -> Promise<entry>
// จำเป็นเพราะหน้า Overview ยิง /status, /hotspot/active, /pppoe/active พร้อมกัน
// ถ้าไม่มีตัวนี้ ทั้งสาม request จะเห็นว่า pool ว่าง แล้วต่างคนต่างเปิด TCP + login
// ของตัวเอง = 3 การเชื่อมต่อไปเราท์เตอร์ตัวเดียวกัน ช้ากว่าเดิม 3 เท่า และ 2 อัน
// กลายเป็น socket ลอยเพราะ pool เก็บได้แค่อันสุดท้าย
const routerClientConnecting = new Map();

async function getPooledRouterClient(targetSiteId) {
    // สำคัญ: ต้องเช็ค in-flight ก่อน await ตัวแรกของฟังก์ชัน
    // ถ้าไปเช็คหลัง `await db.getConfig()` request ที่เข้ามาพร้อมกันจะผ่านจุดเช็ค
    // ไปพร้อมกันหมดแล้วต่างคนต่างเปิดการเชื่อมต่อ (วัดได้จริง: ยิง 3 request พร้อมกัน
    // ได้ 2-3 TCP connection) จึง key ด้วย siteId ที่มีอยู่แล้วแบบ synchronous
    const siteKey = String(targetSiteId || 'default');

    const pending = routerClientConnecting.get(siteKey);
    if (pending) return pending;

    const attempt = (async () => {
        const config = await db.getConfig(targetSiteId);
        if (!config.host || !config.username) {
            throw new Error(`Router connection (${config.name || targetSiteId || 'Site'}) is not configured. Please setup Router Settings.`);
        }

        const poolKey = `${config.id || targetSiteId || 'default'}_${config.host}_${config.port}_${config.username}`;
        const existing = routerClientPool.get(poolKey);

        if (existing && existing.client && existing.client.connected) {
            existing.lastUsed = Date.now();
            return existing;
        }

        // Clean up dead client if present
        if (existing && existing.client) {
            try { existing.client.close(); } catch (_) {}
            routerClientPool.delete(poolKey);
        }

        const client = new RouterOSClient(config.host, config.port, config.username, config.password);
        await client.connect();

        const entry = {
            client,
            config,
            poolKey,
            lastUsed: Date.now(),
            fresh: true // เพิ่งต่อสด ๆ — executeOnRouter จะได้ไม่ retry ซ้ำโดยเปล่าประโยชน์
        };
        routerClientPool.set(poolKey, entry);
        return entry;
    })();

    routerClientConnecting.set(siteKey, attempt);
    try {
        return await attempt;
    } finally {
        routerClientConnecting.delete(siteKey);
    }
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
/**
 * สาขาที่ request นี้กำลังพูดถึง
 *
 * แยกออกมาเป็นฟังก์ชันเพราะมีที่อื่นต้องรู้คำตอบเดียวกันกับที่ executeOnRouter ใช้
 * (เช่นตอนจะเอาชื่อสาขาไปใส่ในข้อความแจ้งเตือน) ถ้าเขียนซ้ำสองที่แล้ววันหนึ่ง
 * ตรรกะขยับ ข้อความแจ้งเตือนจะระบุสาขาผิดโดยไม่มีอะไรฟ้อง
 *
 * ผู้ใช้ที่ถูกล็อกไว้กับสาขาเดียวจะเลือกสาขาอื่นไม่ได้ ไม่ว่าจะส่งอะไรมา
 */
function resolveSiteIdFromReq(req, explicitSiteId) {
    if (!req || typeof req !== 'object') return null;
    if (req.user && req.user.role !== 'admin' &&
        req.user.assignedSiteId && req.user.assignedSiteId !== 'all') {
        return req.user.assignedSiteId;
    }
    return explicitSiteId || req.query?.siteId || req.body?.siteId ||
           req.headers?.['x-site-id'] || null;
}

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
            targetSiteId = resolveSiteIdFromReq(arg1, arg3);
        }
    } else {
        fn = arg2 || arg1;
        targetSiteId = typeof arg1 === 'string' ? arg1 : (typeof arg2 === 'string' ? arg2 : null);
    }

    let poolEntry;
    let usedFreshConnection = false;
    try {
        poolEntry = await getPooledRouterClient(targetSiteId);
        usedFreshConnection = poolEntry.fresh === true;
        poolEntry.fresh = false; // ถูกใช้งานแล้ว ครั้งหน้าถือเป็น socket เก่าใน pool
        return await fn(poolEntry.client);
    } catch (err) {
        // retry มีไว้แก้กรณี "socket ใน pool ตายไปแล้วแต่เราเพิ่งรู้ตอนใช้"
        // ถ้าเพิ่งต่อสดแล้วยังพัง แปลว่าเราท์เตอร์มีปัญหาจริง การ retry มีแต่จะทำให้
        // ผู้ใช้รอนานเป็นสองเท่า (connect timeout 10 วิ x 2) โดยไม่ได้อะไรเพิ่ม
        if (!poolEntry) throw err;

        try { poolEntry.client.close(); } catch (_) {}
        routerClientPool.delete(poolEntry.poolKey);
        if (usedFreshConnection) throw err;

        poolEntry = await getPooledRouterClient(targetSiteId);
        poolEntry.fresh = false;
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
    // เก็บด้วยแฮชของ token ไม่ใช่ token จริง — ไฟล์ที่เขียนลงดิสก์จึงใช้ล็อกอินต่อไม่ได้
    activeSessions.set(sessionStore.hashToken(token), {
        user,
        expires: Date.now() + SESSION_EXPIRY_MS
    });
    persistSessionsSoon();
    
    db.addLog(user.username, 'เข้าสู่ระบบ', 'ล็อกอินเข้าสู่หน้าจัดการสำเร็จ');
    res.json({ token, user });
});

app.post('/api/auth/logout', requireAuth(), (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        activeSessions.delete(sessionStore.hashToken(authHeader.substring(7)));
        persistSessionsNow();   // ออกจากระบบต้องมีผลทันที ไม่รอรอบหน่วงเวลา
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
//
// สตรีมทีละหน้าแทนการดึงทีเดียวด้วย limit 99999 — ของเดิมตัดข้อมูลทิ้งเงียบ ๆ
// เมื่อมีเกิน 99,999 แถว และกองไฟล์ทั้งก้อนไว้ในหน่วยความจำก่อนส่ง
app.get('/api/logs/export-csv', requireAuth(['admin']), async (req, res) => {
    const { search, from, to } = req.query;
    const headers = ['วันเวลา', 'ผู้ใช้งาน', 'การกระทำ', 'รายละเอียด'];
    const filename = `activity_log_${new Date().toISOString().slice(0,10)}.csv`;

    const done = beginExport('Export Log CSV');
    if (!done) {
        return res.status(429).json({ error: 'มีการส่งออกอีกรายการกำลังทำงานอยู่ กรุณารอให้เสร็จก่อน' });
    }

    try {
        const n = await streamCsv(res, { filename, headers }, async (writeRow) => {
            await forEachPage(
                (p) => db.getLogs({ search, from, to, page: p.page, limit: p.limit }),
                async (rows) => {
                    for (const r of rows) {
                        await writeRow([r.timestamp, r.username, r.action, r.details]);
                    }
                }
            );
        });
        db.addLog(req.user.username, 'Export Log CSV', `Export activity log จำนวน ${n} รายการ`);
    } catch (err) {
        // header ถูกส่งไปแล้วตั้งแต่แถวแรก จึงเปลี่ยนเป็น 500 ไม่ได้ — ตัดสายให้ไฟล์เสีย
        // ชัด ๆ ดีกว่าปล่อยไฟล์ที่ดูสมบูรณ์แต่ข้อมูลขาด
        console.error('[Export] activity log ล้มเหลว:', err.message);
        res.destroy();
    } finally {
        done();
    }
});

// Export hotspot traffic logs as CSV (พรบ)
app.get('/api/hotspot-logs/export-csv', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { search, from, to, username, site } = req.query;
    const siteName = await resolveForcedSiteName(req, site);

    const headers = [
        'รหัส Log', 'เวลาเข้าใช้งาน', 'เวลาออก', 'ชื่อผู้ใช้',
        'IP Address', 'MAC Address', 'วิธีล็อกอิน',
        'ระยะเวลาใช้งาน', 'ดาวน์โหลด (bytes)', 'อัปโหลด (bytes)',
        'ไซต์งาน', 'สถานะ'
    ];
    const filename = `hotspot_traffic_log_${new Date().toISOString().slice(0,10)}.csv`;

    const done = beginExport('Export Hotspot Log CSV');
    if (!done) {
        return res.status(429).json({ error: 'มีการส่งออกอีกรายการกำลังทำงานอยู่ กรุณารอให้เสร็จก่อน' });
    }

    try {
        const n = await streamCsv(res, { filename, headers }, async (writeRow) => {
            await forEachPage(
                (p) => db.getHotspotLogs({ search, from, to, username, siteName, page: p.page, limit: p.limit }),
                async (rows) => {
                    for (const r of rows) {
                        await writeRow([
                            r.id, r.loginTime, r.logoutTime, r.username,
                            r.ipAddress, r.macAddress, r.loginBy,
                            r.uptime, r.bytesIn || 0, r.bytesOut || 0,
                            r.siteName, r.status
                        ]);
                    }
                }
            );
        });
        db.addLog(req.user.username, 'Export Hotspot Log CSV', `Export traffic log จำนวน ${n} รายการ`);
    } catch (err) {
        console.error('[Export] hotspot log ล้มเหลว:', err.message);
        res.destroy();
    } finally {
        done();
    }
});

/**
 * อ่าน DNS log จากสองแหล่งรวมกัน
 *
 * ตั้งแต่ 2026-08-30 ข้อมูลใหม่ถูกเขียนลงไฟล์รายวัน (lib/dns-log-store.js)
 * ส่วนแถวเก่าที่เคยเขียนลง Postgres ยังอยู่จนกว่าจะครบ 90 วันแล้วถูกลบตามกำหนด
 * ระหว่างนี้จึงต้องอ่านทั้งสองที่ ไม่งั้นข้อมูลเก่าจะหายไปจากหน้าค้นหาทันที
 *
 * แบ่งตามวันที่ไม่ทับกัน: วันไหนมีไฟล์ก็อ่านจากไฟล์ วันที่ไม่มีไฟล์จึงไปถามฐานข้อมูล
 * จึงไม่มีทางนับซ้ำ และไม่ต้องรวมผลลัพธ์ที่แบ่งหน้ามาแล้วเข้าด้วยกัน
 */
async function queryDnsLogs(opts) {
    const fileDays = dnsStore.listDays();
    const fromDay = opts.from ? String(opts.from).slice(0, 10) : null;
    const toDay = opts.to ? String(opts.to).slice(0, 10) : null;

    const inRange = fileDays.filter((d) => (!fromDay || d >= fromDay) && (!toDay || d <= toDay));
    const oldestFileDay = fileDays.length ? fileDays[0] : null;

    // ยังไม่มีไฟล์เลย (เพิ่งเปลี่ยนระบบ) -> ฐานข้อมูลล้วน
    if (!oldestFileDay) return db.getDnsQueryLogs(opts);

    // ช่วงที่ขอเริ่มตั้งแต่วันแรกที่มีไฟล์เป็นต้นไป -> ข้อมูลทั้งช่วงอยู่ในไฟล์หมดแล้ว
    if (fromDay && fromDay >= oldestFileDay) return await dnsStore.query(opts);

    // ช่วงที่ขอไม่แตะวันที่มีไฟล์เลย -> ฐานข้อมูลล้วน
    if (!inRange.length) return await db.getDnsQueryLogs(opts);

    // คาบเกี่ยวทั้งสองยุค: ไฟล์ใหม่กว่าแถวในฐานข้อมูล "ทุกแถว" เสมอ (ไฟล์เริ่มใช้วันที่
    // เลิกเขียนลงฐานข้อมูลพอดี) ลำดับรวมจึงเป็นไฟล์ทั้งก้อนแล้วต่อด้วยฐานข้อมูลทั้งก้อน
    // — ตัดหน้าได้ตรง ๆ โดยไม่ต้องดึงทั้งสองฝั่งมากองรวมกันก่อน
    //
    // ของเดิมดึงไฟล์มา 99,999 แถวเพื่อแสดงหน้าละ 100 แถว ซึ่งบังคับให้ dnsStore.query
    // เก็บอาร์เรย์เรียงลำดับขนาดแสนแถวไว้ต่อหนึ่งวัน และแทรกด้วย splice ทีละแถว
    // วันที่มี ~342,000 แถวจึงกลายเป็นการเลื่อนหน่วยความจำหลักร้อยล้านครั้งต่อวัน
    // คูณจำนวนวันในช่วง = คำขอเดียวกินเวลาเกิน 100 วินาที และ Cloudflare ตอบ 504
    // (เจอจริงบนโปรดักชัน 2026-09-04 ที่หน้าประวัติเว็บไซต์ ซึ่งเปิดมาแบบไม่กรองอะไรเลย)
    const limit = parseInt(opts.limit) || 100;
    const page = parseInt(opts.page) || 1;
    const skip = (page - 1) * limit;

    const fileResult = await dnsStore.query(Object.assign({}, opts, { page, limit }));
    const fileLogs = fileResult.logs || [];
    const need = limit - fileLogs.length;

    // ยังต้องรู้ยอดรวมฝั่งฐานข้อมูลเพื่อคำนวณจำนวนหน้า แม้หน้านี้จะเต็มจากไฟล์แล้ว
    // (ขอ 1 แถวก็ได้ count มาครบ)
    const dbResult = await db.getDnsQueryLogs(Object.assign({}, opts, {
        offset: Math.max(0, skip - fileResult.total),
        limit: need > 0 ? need : 1
    }));

    const total = fileResult.total + (dbResult.total || 0);

    return {
        logs: need > 0 ? fileLogs.concat(dbResult.logs || []) : fileLogs,
        total,
        page,
        limit,
        pages: Math.ceil(total / limit) || 0,
        // ต้องส่งต่อ ไม่ใช่กลืนไว้ — ถ้าช่วงที่ขอกว้างเกิน MAX_SCAN_DAYS ผลลัพธ์ไม่ครบ
        // และหน้าเว็บต้องบอกผู้ใช้ ไม่งั้นข้อมูลที่ขาดจะดูเหมือนข้อมูลที่ครบ
        truncated: !!fileResult.truncated,
        scannedDays: fileResult.scannedDays,
        source: 'file+db'
    };
}

// GET DNS query (domain visit history) logs with search/filter/pagination
app.get('/api/dns-logs', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { search, from, to, username, page, limit, site } = req.query;
    const siteName = await resolveForcedSiteName(req, site);
    res.json(await queryDnsLogs({ search, from, to, username, page, limit, siteName }));
});

// Export DNS query (domain visit history) logs as CSV
app.get('/api/dns-logs/export-csv', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const { search, from, to, username, site } = req.query;
    const siteName = await resolveForcedSiteName(req, site);
    const opts = { search, from, to, username, siteName };

    const headers = ['เวลา', 'ชื่อผู้ใช้', 'IP Address', 'MAC Address', 'โดเมนที่เข้าชม', 'ไซต์งาน'];
    const filename = `dns_visit_log_${new Date().toISOString().slice(0,10)}.csv`;
    const cells = (r) => [r.queryTime, r.username, r.ipAddress, r.macAddress, r.domain, r.siteName];
    // จัดรูปแบบตั้งแต่ตอนอ่านไฟล์ เพื่อให้ตัวเรียงลำดับในแต่ละวันถือแค่สตริงเดียวต่อแถว
    const lineOf = (r) => csvRow(cells(r));

    const done = beginExport('Export DNS Log CSV');
    if (!done) {
        return res.status(429).json({ error: 'มีการส่งออกอีกรายการกำลังทำงานอยู่ กรุณารอให้เสร็จก่อน' });
    }

    try {
        const n = await streamCsv(res, { filename, headers }, async (writeRow, writeRaw) => {
            // ไฟล์ส่งออกเรียงเก่า -> ใหม่ (ต่างจากหน้าเว็บที่เรียงใหม่ -> เก่า)
            // เหตุผลอยู่ในคำอธิบายของ dnsStore.exportAscending: การจะส่งออกแบบใหม่ -> เก่า
            // ต้องกลับลำดับทั้งวันในหน่วยความจำก่อน ซึ่งวัดแล้วดัน RSS ไป 404-465 MB
            // ชนเพดาน 500M ของ PM2 — เรียงเก่า -> ใหม่ทำให้อ่านไปส่งไปได้ ใช้หน่วยความจำคงที่
            //
            // แถวเก่าที่ยังค้างใน Postgres เก่ากว่าไฟล์รายวันทุกแถวเสมอ (ไฟล์เริ่มใช้วันที่
            // เลิกเขียนลงฐานข้อมูลพอดี) จึงต้องออกก่อน ลำดับรวมถึงจะเรียงต่อเนื่องกันจริง
            const fileDays = dnsStore.listDays();
            const oldest = fileDays.length ? fileDays[0] : null;
            const fromDay = from ? String(from).slice(0, 10) : null;
            const needDb = !(oldest && fromDay && fromDay >= oldest);

            if (needDb) {
                await forEachPageReverse(
                    (p) => db.getDnsQueryLogs({ search, from, to, username, siteName, offset: p.offset, limit: p.limit }),
                    async (rows) => {
                        for (const r of rows) await writeRow(cells(r));
                    }
                );
            }

            // exportAscending ไม่มีเพดาน MAX_SCAN_DAYS ต่างจากตอนกดดูบนหน้าเว็บ:
            // เพดานนั้นมีไว้กันหน้าค้าง ส่วนไฟล์หลักฐานขอมากี่วันต้องได้ครบเท่านั้น
            await dnsStore.exportAscending(opts, lineOf, (line) => writeRaw(line));
        });
        db.addLog(req.user.username, 'Export DNS Log CSV', `Export DNS visit log จำนวน ${n} รายการ`);
    } catch (err) {
        console.error('[Export] DNS log ล้มเหลว:', err.message);
        res.destroy();
    } finally {
        done();
    }
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

    const headers = ['เวลาเข้าใช้', 'เวลาออก', 'ห้อง', 'IP Address', 'ไซต์งาน', 'สถานะ', 'ดาวน์โหลด (bytes)', 'อัปโหลด (bytes)'];
    const filename = `pppoe_usage_log_${new Date().toISOString().slice(0,10)}.csv`;

    const done = beginExport('Export PPPoE Usage CSV');
    if (!done) {
        return res.status(429).json({ error: 'มีการส่งออกอีกรายการกำลังทำงานอยู่ กรุณารอให้เสร็จก่อน' });
    }

    try {
        const n = await streamCsv(res, { filename, headers }, async (writeRow) => {
            await forEachPage(
                (p) => db.getPppoeUsageLogs({ search, from, to, username, siteName, page: p.page, limit: p.limit }),
                async (rows) => {
                    for (const r of rows) {
                        await writeRow([
                            r.loginTime, r.logoutTime, r.username, r.ipAddress,
                            r.siteName, r.status, r.bytesIn || 0, r.bytesOut || 0
                        ]);
                    }
                }
            );
        });
        db.addLog(req.user.username, 'Export PPPoE Usage CSV', `Export PPPoE usage log จำนวน ${n} รายการ`);
    } catch (err) {
        console.error('[Export] PPPoE log ล้มเหลว:', err.message);
        res.destroy();
    } finally {
        done();
    }
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
// ==========================================
// Telegram — ช่องทางแจ้งเตือนของทีมแอดมิน (แยกจาก LINE ที่เป็นช่องทางลูกค้า)
// ใช้ https ของ Node ตรง ๆ ไม่เพิ่ม dependency
// ==========================================
function sendTelegramMessage(botToken, chatId, text) {
    return new Promise((resolve, reject) => {
        if (!botToken || !chatId) return reject(new Error('ยังไม่ได้ตั้งค่า Telegram Bot Token หรือ Chat ID'));
        const payload = JSON.stringify({
            chat_id: String(chatId),
            text: String(text),
            parse_mode: 'HTML',
            disable_web_page_preview: true
        });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${botToken}/sendMessage`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload)
            },
            timeout: 10000
        }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                let parsed = {};
                try { parsed = JSON.parse(body); } catch (_) {}
                if (res.statusCode >= 200 && res.statusCode < 300 && parsed.ok) return resolve(parsed);
                reject(new Error(parsed.description || `Telegram ตอบกลับ HTTP ${res.statusCode}`));
            });
        });
        // timeout ของ https.request ไม่ได้ยกเลิก request ให้เอง ต้อง destroy เอง
        // ไม่งั้นจะค้างจนกว่า OS จะ timeout (บทเรียนเดียวกับ routeros.js เมื่อ 2026-08-28)
        req.on('timeout', () => { req.destroy(new Error('Telegram ไม่ตอบกลับภายใน 10 วินาที')); });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

// ส่งแจ้งเตือนฝั่งปฏิบัติการ — เงียบไปเฉย ๆ ถ้ายังไม่ได้ตั้งค่า ไม่ทำให้ caller พัง
async function sendOpsAlert(text, kind) {
    try {
        const cfg = await db.getTelegramAlertConfig();
        if (!cfg || !cfg.enabled || !cfg.botToken || !cfg.chatId) return false;
        if (kind === 'offline' && cfg.alertOffline === false) return false;
        if (kind === 'online' && cfg.alertOnline === false) return false;
        if (kind === 'storage' && cfg.alertStorage === false) return false;
        // multiwan ยังไม่มีสวิตช์ในหน้าตั้งค่า จึงส่งเป็นค่าเริ่มต้น
        // เขียนเป็น === false ไว้ เพื่อให้เพิ่มสวิตช์ทีหลังได้โดยไม่ต้องแก้ตรงนี้
        if (kind === 'multiwan' && cfg.alertMultiwan === false) return false;
        await sendTelegramMessage(cfg.botToken, cfg.chatId, text);
        return true;
    } catch (e) {
        console.warn('[Ops Alert] ส่ง Telegram ไม่สำเร็จ:', e.message);
        return false;
    }
}

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
// ==========================================
// Telegram Ops Alerts — ตั้งค่า / ทดสอบ / หา Chat ID
// เฉพาะ admin เพราะเป็นช่องทางของทีมแอดมิน ไม่ใช่ของลูกค้า
// ==========================================

// ไม่คืน botToken กลับไปให้เบราว์เซอร์เด็ดขาด บอกแค่ว่ามีหรือยัง
// (หลักการเดียวกับ sanitizeSitePublic ที่ไม่คืนรหัสเราท์เตอร์)
function sanitizeTelegramConfig(cfg) {
    return {
        enabled: !!cfg.enabled,
        hasBotToken: !!cfg.botToken,
        botTokenPreview: cfg.botToken ? String(cfg.botToken).slice(0, 8) + '…' : '',
        chatId: cfg.chatId || '',
        alertOffline: cfg.alertOffline !== false,
        alertOnline: cfg.alertOnline !== false,
        alertStorage: cfg.alertStorage !== false
    };
}

app.get('/api/mikrotik/telegram-alert/config', requireAuth(['admin']), async (req, res) => {
    try {
        res.json(sanitizeTelegramConfig(await db.getTelegramAlertConfig()));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/mikrotik/telegram-alert/config', requireAuth(['admin']), async (req, res) => {
    try {
        const patch = {};
        if (req.body.enabled !== undefined) patch.enabled = !!req.body.enabled;
        // ส่ง botToken ว่างมา = ไม่แก้ (กันเผลอลบ token ตอนกดบันทึกจากฟอร์มที่ไม่ได้กรอกใหม่)
        if (req.body.botToken) patch.botToken = String(req.body.botToken).trim();
        if (req.body.chatId !== undefined) patch.chatId = String(req.body.chatId).trim();
        if (req.body.alertOffline !== undefined) patch.alertOffline = !!req.body.alertOffline;
        if (req.body.alertOnline !== undefined) patch.alertOnline = !!req.body.alertOnline;

        const updated = await db.saveTelegramAlertConfig(patch);
        db.addLog(req.user.username, 'ตั้งค่าแจ้งเตือน Telegram', `enabled=${updated.enabled} chatId=${updated.chatId || '-'}`);
        res.json(sanitizeTelegramConfig(updated));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/mikrotik/telegram-alert/test', requireAuth(['admin']), async (req, res) => {
    try {
        const cfg = await db.getTelegramAlertConfig();
        const botToken = (req.body && req.body.botToken) || cfg.botToken;
        const chatId = (req.body && req.body.chatId) || cfg.chatId;
        if (!botToken || !chatId) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า Bot Token หรือ Chat ID' });

        const nowStr = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
        await sendTelegramMessage(botToken, chatId,
            `🔔 <b>ทดสอบการแจ้งเตือน</b>

ระบบ MikroTik Dashboard เชื่อมต่อ Telegram สำเร็จแล้ว
⏱️ ${nowStr}

ช่องทางนี้ใช้แจ้งเตือนฝั่งแอดมิน (เราท์เตอร์ล่ม / เชื่อมต่อไม่ได้) แยกจาก LINE ที่ใช้แจ้งลูกค้า`);
        res.json({ success: true, message: 'ส่งข้อความทดสอบไป Telegram เรียบร้อยแล้ว' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ช่วยหา Chat ID: เพิ่มบอทเข้ากลุ่มแล้วพิมพ์อะไรก็ได้ในกลุ่ม จากนั้นกดปุ่มนี้
// ระบบจะอ่าน getUpdates แล้วคืนรายชื่อแชตที่บอทเห็นล่าสุด
app.post('/api/mikrotik/telegram-alert/discover-chats', requireAuth(['admin']), async (req, res) => {
    try {
        const cfg = await db.getTelegramAlertConfig();
        const botToken = (req.body && req.body.botToken) || cfg.botToken;
        if (!botToken) return res.status(400).json({ error: 'ยังไม่ได้ตั้งค่า Bot Token' });

        const updates = await new Promise((resolve, reject) => {
            const r = https.get(`https://api.telegram.org/bot${botToken}/getUpdates?limit=100`, { timeout: 10000 }, (resp) => {
                let body = '';
                resp.on('data', (c) => { body += c; });
                resp.on('end', () => {
                    try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('Telegram ตอบกลับไม่ใช่ JSON')); }
                });
            });
            r.on('timeout', () => { r.destroy(new Error('Telegram ไม่ตอบกลับภายใน 10 วินาที')); });
            r.on('error', reject);
        });

        if (!updates.ok) return res.status(400).json({ error: updates.description || 'Bot Token ไม่ถูกต้อง' });

        const seen = new Map();
        for (const u of (updates.result || [])) {
            const msg = u.message || u.channel_post || u.my_chat_member || {};
            const chat = msg.chat;
            if (!chat || seen.has(chat.id)) continue;
            seen.set(chat.id, {
                chatId: String(chat.id),
                type: chat.type,
                title: chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || '(ไม่มีชื่อ)'
            });
        }
        res.json({ chats: [...seen.values()] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// Log Archive — ปิดวันของ log ตาม พรบ. ม.26 แล้วผนึกด้วย SHA-256
//
// ระบบเก็บ log ครบตามกฎหมายอยู่แล้ว แต่เดิม "พิสูจน์ไม่ได้ว่าไม่ถูกแก้"
// การ export CSV เมื่อไรก็ได้ไม่ใช่หลักฐาน ส่วนไฟล์ที่ปิดผนึกพร้อม hash
// ที่ผู้รับตรวจซ้ำเองได้ด้วย sha256sum คือสิ่งที่ใช้ยืนยันได้จริง
// ==========================================

app.get('/api/mikrotik/log-archives', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const { logType, from, to, page, limit } = req.query;
        res.json(await db.getLogArchives({ logType, from, to, page, limit }));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ดาวน์โหลดไฟล์ปิดผนึก — ส่ง hash มาใน header ด้วย ผู้รับจะได้เทียบได้ทันที
app.get('/api/mikrotik/log-archives/:id/download', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const { buffer, record } = await logArchive.readArchiveFile(db, req.params.id);
        db.addLog(req.user.username, 'ดาวน์โหลดไฟล์ log ปิดผนึก', `${record.fileName} (${record.recordCount} รายการ)`);
        res.setHeader('Content-Type', 'application/gzip');
        res.setHeader('Content-Disposition', `attachment; filename="${record.fileName}"`);
        res.setHeader('X-Archive-SHA256', record.sha256);
        res.send(buffer);
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

// ตรวจสอบว่าไฟล์ยังตรงกับ hash ที่บันทึกไว้ตอนสร้าง
// อ่านไฟล์จริงทั้งบน VPS และ R2 แล้วคำนวณใหม่ ไม่ได้เชื่อค่าที่เก็บไว้
app.post('/api/mikrotik/log-archives/:id/verify', requireAuth(['admin', 'co-admin']), async (req, res) => {
    try {
        const result = await logArchive.verifyArchive(db, req.params.id);
        db.addLog(req.user.username, 'ตรวจสอบความถูกต้องของไฟล์ log',
            `${result.fileName}: ${result.ok ? 'ผ่าน' : 'ไม่ผ่าน'} (${result.checks.map(c => c.source + '=' + (c.ok ? 'ok' : 'fail')).join(', ')})`);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// สั่งปิดวันด้วยตัวเอง — ใช้ตอนเปิดใช้ฟีเจอร์ครั้งแรก หรือเมื่อคืนที่แล้วรันไม่สำเร็จ
app.post('/api/mikrotik/log-archives/run', requireAuth(['admin']), async (req, res) => {
    try {
        const { date, days, force } = req.body || {};
        const opts = { force: !!force, createdBy: req.user.username };
        const result = days
            ? await logArchive.backfill(db, Math.min(parseInt(days) || 7, 90), opts)
            : await logArchive.archiveDay(db, date, opts);
        db.addLog(req.user.username, 'สร้างไฟล์ log ปิดผนึก', days ? `ย้อนหลัง ${days} วัน` : `วันที่ ${date || 'เมื่อวาน'}`);
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// เฝ้าดูพื้นที่เก็บข้อมูล (Storage Monitor)
//
// ระบบเขียนข้อมูลลงที่เก็บ 3 แห่งตลอดเวลา (ดิสก์ VPS / Cloudflare R2 / Supabase)
// แต่ไม่เคยมีอะไรคอยดูว่าเหลือที่เท่าไร — เต็มเมื่อไรจะเห็นแค่ "ระบบพัง"
// โดยไม่มีสัญญาณเตือนล่วงหน้า และตรวจด้วยว่าการลบข้อมูลตาม ม.26 ยังทำงานอยู่จริง
// ==========================================

app.get('/api/mikrotik/storage', requireAuth(['admin']), async (req, res) => {
    try {
        res.json(await storageMonitor.buildReport(db));
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ตรวจเดี๋ยวนี้แล้วส่งเข้า Telegram — ใช้ทดสอบว่าการแจ้งเตือนถึงจริงไหม
// force = ส่งแม้ไม่มีปัญหา (ไม่งั้นตอนทุกอย่างปกติจะไม่มีอะไรส่งออกไป จนไม่รู้ว่าใช้ได้ไหม)
app.post('/api/mikrotik/storage/check-now', requireAuth(['admin']), async (req, res) => {
    try {
        const force = !!(req.body && req.body.force);
        const report = await storageMonitor.buildReport(db);
        let sent = false;

        if (report.issues.length || force) {
            const text = report.issues.length
                ? storageMonitor.formatAlert(report)
                : [
                    '🟢 <b>พื้นที่เก็บข้อมูลปกติ</b>',
                    '',
                    report.disk.available
                        ? `💽 ดิสก์: ${report.disk.human.used} / ${report.disk.human.total} (${report.disk.usedPercent}%) เหลือ ${report.disk.human.available}`
                        : '💽 ดิสก์: อ่านค่าไม่ได้',
                    `🗄 ฐานข้อมูล: ${(report.database.totalRows || 0).toLocaleString()} แถว ~${report.database.human}`,
                    report.r2 && report.r2.configured && !report.r2.error
                        ? `☁️ R2: ${report.r2.objects} ไฟล์ ${report.r2.human}` : '☁️ R2: ยังไม่ได้ตั้งค่า',
                    '',
                    '🕐 ' + new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })
                ].join('\n');
            sent = await sendOpsAlert(text, 'storage');
        }

        db.addLog(req.user.username, 'ตรวจพื้นที่เก็บข้อมูล',
            `พบ ${report.issues.length} เรื่องที่ต้องดู, ส่ง Telegram: ${sent ? 'สำเร็จ' : 'ไม่ได้ส่ง'}`);
        res.json({ success: true, sent, report });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// สวิตช์เปิด/ปิดการเก็บประวัติเข้าเว็บ (DNS)
//
// มีอยู่เป็นช่องติ๊กในหน้าแก้ไขสาขามาแต่เดิม แต่ซ่อนลึกเกินกว่าจะใช้ตัดสินใจเร็ว ๆ
// และไม่มีทางปิดทุกสาขาพร้อมกัน ทั้งที่เหตุผลที่อยากปิดมักเป็นเรื่องพื้นที่เต็ม
// ซึ่งเป็นปัญหาระดับทั้งระบบ ไม่ใช่ระดับสาขา
//
// การปิดที่นี่หยุดเฉพาะฝั่งแอป (poller เลิกอ่าน /log/print) ซึ่งเป็นจุดที่ทำให้
// ฐานข้อมูลโต ส่วนเราท์เตอร์ยังเขียน log ลงบัฟเฟอร์ในหน่วยความจำของตัวเองต่อไป
// ซึ่งไม่กินพื้นที่เพิ่มเพราะเป็นบัฟเฟอร์วนทับตัวเอง และทำให้เปิดกลับมาได้ทันที
// โดยไม่ต้องไปตั้งค่าเราท์เตอร์ใหม่
// ==========================================

app.get('/api/mikrotik/dns-logging', requireAuth(['admin']), async (req, res) => {
    try {
        const { sites } = await db.getSites();
        res.json({
            sites: sites.map((s) => ({
                id: s.id,
                name: s.name,
                enabled: s.dnsLoggingEnabled !== false
            })),
            enabledCount: sites.filter((s) => s.dnsLoggingEnabled !== false).length,
            totalCount: sites.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/mikrotik/dns-logging', requireAuth(['admin']), async (req, res) => {
    try {
        const { enabled, siteId } = req.body || {};
        if (typeof enabled !== 'boolean') {
            return res.status(400).json({ error: 'ต้องระบุ enabled เป็น true หรือ false' });
        }

        const { sites } = await db.getSites();
        const targets = siteId ? sites.filter((s) => s.id === siteId) : sites;
        if (!targets.length) return res.status(404).json({ error: 'ไม่พบสาขาที่ระบุ' });

        const changed = [];
        for (const s of targets) {
            if ((s.dnsLoggingEnabled !== false) === enabled) continue;   // ไม่ต้องเขียนถ้าค่าเดิมตรงอยู่แล้ว
            await db.updateSite(s.id, { dnsLoggingEnabled: enabled });
            changed.push(s.name);
        }

        // บันทึกไว้ในประวัติการใช้งานระบบเสมอ — การหยุดเก็บบันทึกตาม ม.26
        // ต้องตอบได้ว่าใครสั่งและเมื่อไร ไม่ใช่หายไปเฉย ๆ แล้วไม่มีใครรู้ที่มา
        db.addLog(req.user.username,
            enabled ? 'เปิดการเก็บประวัติเข้าเว็บ (DNS)' : 'ปิดการเก็บประวัติเข้าเว็บ (DNS)',
            changed.length
                ? `${siteId ? 'สาขา' : 'ทุกสาขา'}: ${changed.join(', ')}`
                : 'ไม่มีการเปลี่ยนแปลง (ค่าเดิมตรงอยู่แล้ว)');

        const after = await db.getSites();
        res.json({
            success: true,
            changed,
            sites: after.sites.map((s) => ({ id: s.id, name: s.name, enabled: s.dnsLoggingEnabled !== false }))
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/mikrotik/line-digest/config', requireAuth(['admin', 'co-admin']), async (req, res) => {
    const siteId = req.query.siteId || req.headers['x-site-id'];
    res.json(await db.getLineDigestConfig(siteId));
});

// วินิจฉัยว่า "ทำไมสาขานี้ไม่ได้รับแจ้งเตือนวันนี้"
// ตอบทุกสาขาพร้อมเหตุผลของแต่ละอัน โดยไม่เปิดเผย token (บอกแค่ว่ามีหรือไม่มี)
app.get('/api/mikrotik/line-digest/status', requireAuth(['admin']), async (req, res) => {
    try {
        const nowBkk = bangkokNow();
        const sitesData = await db.getSites();
        const sites = (sitesData && sitesData.sites && sitesData.sites.length > 0)
            ? sitesData.sites
            : [{ id: 'default', name: 'Main Site' }];

        const rows = [];
        for (const site of sites) {
            let config = null;
            let readError = null;
            try {
                config = await db.getLineDigestConfig(site.id);
            } catch (e) {
                readError = e.message || String(e);
            }
            const verdict = readError
                ? { due: false, reason: `อ่านการตั้งค่าไม่ได้: ${readError}` }
                : evaluateDigestDue(config, nowBkk);

            rows.push({
                siteId: site.id,
                siteName: site.name,
                enabled: !!(config && config.enabled),
                hasChannelAccessToken: !!(config && config.channelAccessToken),
                hasTargetId: !!(config && config.targetId),
                targetIdPreview: config && config.targetId
                    ? String(config.targetId).slice(0, 6) + '…' + String(config.targetId).slice(-4)
                    : null,
                digestTime: (config && config.digestTime) || null,
                lastSentDate: (config && config.lastSentDate) || null,
                sentToday: !!(config && config.lastSentDate === nowBkk.dateStr),
                dueNow: verdict.due,
                reason: verdict.reason
            });
        }

        res.json({
            serverTimeUtc: new Date().toISOString(),
            bangkokTime: nowBkk.hhmm,
            bangkokDate: nowBkk.dateStr,
            catchupMinutes: LINE_DIGEST_CATCHUP_MINUTES,
            sites: rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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
// เวลาที่ยอมให้ส่ง "ย้อนหลัง" ได้ ถ้าพลาดนาทีที่ตั้งไว้พอดี
// (เช่น server รีสตาร์ต, event loop ติด, หรือเราท์เตอร์ล่มชั่วคราวตอนถึงเวลา)
// เกินช่วงนี้แล้วข้ามไปเลย ไม่งั้นเปิดเครื่องตอนดึกจะยิงสรุปของเมื่อเช้าออกไป
const LINE_DIGEST_CATCHUP_MINUTES = 180;

/**
 * เวลาปัจจุบันตามเขตเวลาไทย
 *
 * วิธีเดิมคือ new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }))
 * ซึ่งแปลงเป็นเวลาไทยแล้วให้ new Date() ตีความสตริงนั้น "ตามเขตเวลาของเครื่อง" อีกที
 * พอเรียก .toISOString() ก็แปลงกลับเป็น UTC — สุทธิแล้วเลื่อนไป -7 ชม.
 * ผลคือ dateStr ได้ "วันที่ตาม UTC" ไม่ใช่วันที่ตามเวลาไทย และจะผิดไปหนึ่งวัน
 * ทุกครั้งที่เวลาไทยยังไม่ถึง 07:00 น. — ซึ่งคือช่วงที่งานกลางคืนทำงานพอดี
 * (พบ 2026-08-30: งานปิดวันเวลา 02:00 ปิดวันที่ 28 ทั้งที่ควรปิดวันที่ 29)
 *
 * ใช้ Intl แยกส่วนออกมาตรง ๆ แทน ได้ค่าที่ถูกไม่ว่าเครื่องจะตั้งเขตเวลาอะไรไว้
 */

// ตัดสินว่าสาขานี้ควรส่งสรุปตอนนี้หรือยัง — แยกออกมาเป็นฟังก์ชันเพื่อให้
// endpoint วินิจฉัย (/api/mikrotik/line-digest/status) ใช้ตรรกะชุดเดียวกันได้
function evaluateDigestDue(config, nowBkk) {
    if (!config) return { due: false, reason: 'ไม่มีการตั้งค่า LINE ของสาขานี้' };
    if (!config.enabled) return { due: false, reason: 'ปิดการแจ้งเตือนอยู่ (enabled = false)' };
    if (!config.channelAccessToken) return { due: false, reason: 'ยังไม่ได้ใส่ Channel Access Token' };
    if (!config.targetId) return { due: false, reason: 'ยังไม่ได้ใส่ Target ID / Group ID' };

    const target = parseHHMMToMinutes(config.digestTime);
    if (target === null) return { due: false, reason: `รูปแบบเวลาไม่ถูกต้อง: "${config.digestTime}"` };

    if (config.lastSentDate === nowBkk.dateStr) {
        return { due: false, reason: `ส่งไปแล้ววันนี้ (${config.lastSentDate})` };
    }
    if (nowBkk.minutes < target) {
        return { due: false, reason: `ยังไม่ถึงเวลา ${config.digestTime} (ตอนนี้ ${nowBkk.hhmm})` };
    }
    if (nowBkk.minutes - target > LINE_DIGEST_CATCHUP_MINUTES) {
        return { due: false, reason: `เลยเวลา ${config.digestTime} มาเกิน ${LINE_DIGEST_CATCHUP_MINUTES} นาที ข้ามรอบนี้` };
    }
    return { due: true, reason: `ถึงเวลาส่ง (ตั้งไว้ ${config.digestTime}, ตอนนี้ ${nowBkk.hhmm})` };
}

setInterval(async () => {
    let sites;
    try {
        const sitesData = await db.getSites();
        sites = (sitesData && sitesData.sites && sitesData.sites.length > 0) ? sitesData.sites : [{ id: 'default', name: 'Main Site' }];
    } catch (e) {
        console.error('[LINE OA Digest] อ่านรายชื่อสาขาไม่ได้:', e.message || e);
        return;
    }

    const nowBkk = bangkokNow();

    for (const site of sites) {
        // แต่ละสาขาต้องมี try/catch ของตัวเอง — เดิมใช้ try เดียวครอบทั้ง loop
        // สาขาแรกที่ error (เช่นเราท์เตอร์ offline ตอนถึงเวลาพอดี) จะทำให้สาขาที่เหลือ
        // ไม่ถูกประมวลผลเลยในรอบนั้น
        try {
            const config = await db.getLineDigestConfig(site.id);
            const verdict = evaluateDigestDue(config, nowBkk);
            if (!verdict.due) continue;

            console.log(`[LINE OA Digest] ส่งสรุปประจำวันของสาขา ${site.name} (${site.id}) — ${verdict.reason}`);
            const digest = await generateDailyExpiryDigest(site.id);
            const flexMsg = createDailyDigestFlex(digest);
            await sendLinePushMessage(config.channelAccessToken, config.targetId, flexMsg);
            await db.saveLineDigestConfig({ lastSentDate: nowBkk.dateStr }, site.id);
            db.addLog('System Auto', 'ส่งสรุป LINE OA ประจำวัน', `ส่งรายงาน Flex Card (${site.name}) สำเร็จ (${digest.totalItems} รายการ)`);
        } catch (e) {
            // ไม่บันทึก lastSentDate เมื่อพลาด เพื่อให้รอบถัดไปลองใหม่ภายในช่วง catch-up
            console.error(`[LINE OA Digest] สาขา ${site.name} (${site.id}) ส่งไม่สำเร็จ:`, e.message || e);
            db.addLog('System Auto', 'ส่งสรุป LINE OA ล้มเหลว', `สาขา ${site.name}: ${e.message || e}`);
        }
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

                    // แจ้งเตือนสถานะเราท์เตอร์ไปที่ Telegram เท่านั้น ไม่ส่งเข้า LINE
                    // LINE เป็นช่องทางของลูกค้า/ผู้เช่าห้อง ไม่ควรเห็นเรื่องเทคนิคของระบบ
                    // (2026-08-28: แจ้งเตือน Suksawad-CMU ล่ม เคยไปโผล่ในกลุ่มลูกค้าของ A4)
                    const nowStrUp = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
                    await sendOpsAlert(
                        `✅ <b>เราท์เตอร์กลับมาออนไลน์</b>

` +
                        `📍 สาขา: <b>${site.name}</b>
` +
                        `🌐 ${site.host || '-'}
` +
                        `⏱️ เวลา: ${nowStrUp}
` +
                        `🔄 ออฟไลน์ไปประมาณ: ${downDurationMin} นาที`,
                        'online'
                    );
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

                    // ไปที่ Telegram เท่านั้น (ดูคำอธิบายด้านบน)
                    const nowStrDown = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
                    await sendOpsAlert(
                        `🚨 <b>เราท์เตอร์ Offline</b>

` +
                        `📍 สาขา: <b>${site.name}</b>
` +
                        `🌐 ${site.host || '-'}:${site.port || 8728}
` +
                        `⏱️ ขาดการเชื่อมต่อเมื่อ: ${nowStrDown}
` +
                        `⚠️ สาเหตุ: ${connErr.message || 'ไม่สามารถติดต่อเราท์เตอร์ได้'}

` +
                        `ตรวจสอบไฟฟ้า/อินเทอร์เน็ตที่หน้างาน หรือรหัส API ในหน้าตั้งค่า`,
                        'offline'
                    );
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
        // ใช้ bangkokNow() ตัวเดียวกับที่อื่น — วิธีคำนวณวันที่แบบเดิมได้วันที่ตาม UTC
        // ซึ่งเพี้ยนไปหนึ่งวันตอนตีสอง ทำให้ log บอกวันที่ผิดและงานปิดวันปิดผิดวัน
        const bkk = bangkokNow();
        const currentHHMM = bkk.hhmm;
        const todayDateStr = bkk.dateStr;

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

                    // ลบของเก่าทันทีหลังสำรองสำเร็จเท่านั้น
                    // ถ้าสำรองพัง จะไม่ลบอะไรเลย — กันเคสลบของเก่าทิ้งแล้วของใหม่ก็ไม่มี
                    const cleanup = spawn(process.execPath, [path.join(__dirname, 'scripts', 'cleanup-old-backups.js'), '--apply'], {
                        stdio: 'inherit',
                        env: process.env
                    });
                    cleanup.on('close', (c) => {
                        if (c === 0) console.log('[Backup] ลบ backup/log ที่เก่าเกิน 90 วันเรียบร้อย');
                        else console.error(`[Backup] cleanup-old-backups exited with code ${c}`);
                    });

                    // ปิดวันของเมื่อวานแล้วผนึกด้วย SHA-256 (พรบ. ม.26)
                    // ทำหลังสำรองข้อมูลสำเร็จเท่านั้น และทำก่อนที่ retention จะลบอะไร
                    // ไม่ได้ await เพราะอยู่ใน callback — ให้มันทำงานเบื้องหลังไป
                    // runNightly ไล่ย้อนหลัง 7 วันเพื่ออุดวันที่ขาด ไม่ใช่ทำแค่เมื่อวาน
                    // วันที่ทำไปแล้วถูกข้ามอัตโนมัติ คืนปกติจึงไม่มีภาระเพิ่ม
                    logArchive.runNightly(db).then((r) => {
                        if (r.made.length) {
                            console.log(`[LogArchive] ปิดวันเรียบร้อย: ${r.made.join(', ')}`);
                            db.addLog('System Auto', 'สร้างไฟล์ log ปิดผนึก', `ปิดวัน: ${r.made.join(', ')}`);
                        }
                        if (r.failed.length) {
                            console.error('[LogArchive] มีวันที่ปิดไม่สำเร็จ:', r.failed.join(' | '));
                            db.addLog('System Auto', 'สร้างไฟล์ log ปิดผนึกไม่สำเร็จ', r.failed.join(' | '));
                        }
                    }).catch((e) => console.error('[LogArchive] ปิดวันไม่สำเร็จ:', e.message));
                } else {
                    console.error(`[Backup] Nightly backup exited with code ${code}`);
                }
            });
        }
    } catch (e) {
        console.error('[Backup] Scheduled backup error:', e.message || e);
    }
}, 60000);

// ตรวจพื้นที่เก็บข้อมูลวันละครั้ง เวลา 08:00 น. — เตือนเฉพาะตอนมีเรื่องต้องทำ
//
// ตั้งเป็น 08:00 ไม่ใช่ตอนกลางดึกพร้อมงานสำรองข้อมูล เพราะข้อความแบบนี้ต้องการ
// ให้คนเห็นแล้วลงมือแก้ได้เลย ส่งตอนตีสองไปก็จมอยู่ในแจ้งเตือนค้างคืน
// และเป็นเวลาหลังงานกลางคืนทำเสร็จหมดแล้ว ตัวเลขที่เห็นจึงเป็นภาพหลังลบของเก่าแล้วจริง
//
// ถ้ายังไม่ได้แก้ ก็จะเตือนซ้ำทุกวัน — ตั้งใจให้เป็นแบบนั้น เพราะพื้นที่ที่ใกล้เต็ม
// ไม่หายไปเอง การเงียบหลังเตือนครั้งแรกคือสาเหตุที่ปัญหาแบบนี้ถูกลืมจนสายเกินแก้
let lastStorageCheckDate = '';
setInterval(async () => {
    try {
        const bkk = bangkokNow();
        const currentHHMM = bkk.hhmm;
        const todayDateStr = bkk.dateStr;
        if (currentHHMM !== '08:00' || lastStorageCheckDate === todayDateStr) return;
        lastStorageCheckDate = todayDateStr;

        const report = await storageMonitor.buildReport(db);
        if (!report.issues.length) {
            console.log(`[Storage] ตรวจแล้ว ปกติดี — ดิสก์ ${report.disk.usedPercent || '?'}%, ฐานข้อมูล ${report.database.totalRows || 0} แถว`);
            return;
        }

        console.warn(`[Storage] พบ ${report.issues.length} เรื่องที่ต้องดู:`,
            report.issues.map((i) => `${i.area}: ${i.message}`).join(' | '));
        const sent = await sendOpsAlert(storageMonitor.formatAlert(report), 'storage');
        db.addLog('System Auto', 'เตือนพื้นที่เก็บข้อมูล',
            `${report.issues.map((i) => i.area + ' — ' + i.message).join('; ')}${sent ? '' : ' (ส่ง Telegram ไม่ได้)'}`);
    } catch (e) {
        console.error('[Storage] ตรวจพื้นที่ไม่สำเร็จ:', e.message || e);
    }
}, 60000);

// ===================== เฝ้าดูว่าสาขาไหนกำลังวิ่งบน backup line =====================
//
// failover ที่ทำงานถูกต้องจะสลับเงียบ ๆ ซึ่งเป็นเรื่องดีตอนเกิดเหตุ แต่แปลว่า
// สาขาจะวิ่งบน line ที่ช้ากว่าได้เป็นสัปดาห์โดยไม่มีใครรู้ จนลูกค้าบ่นหรือบิลมา
// ตัวนี้จึงเป็นส่วนที่ทำให้ failover "รู้ตัวได้" ไม่ใช่แค่ "ทำงานได้"
//
// 5 นาทีก็พอ — เป็นเรื่องที่ต้องรู้ภายในหลักนาที ไม่ใช่หลักวินาที และการอ่าน
// route ทุกสาขาถี่กว่านี้เปลืองการเชื่อมต่อโดยไม่ได้ประโยชน์เพิ่ม
const multiwanState = new Map();   // siteId -> ชื่อ interface ที่ใช้อยู่ครั้งก่อน
const MULTIWAN_STATE_FILE = path.join(__dirname, 'db', 'multiwan-state.json');

/**
 * จำไว้ว่าแต่ละสาขาวิ่งบน line ไหน ข้ามการ restart
 *
 * ถ้าไม่จำ แล้ว pm2 reload ตรงกับจังหวะที่สาขากำลัง failover พอดี รอบแรกหลัง
 * restart จะถือว่าค่าที่อ่านได้คือค่าตั้งต้น แล้วไม่แจ้งเตือน — สาขาจะวิ่งบน
 * backup ต่อไปเงียบ ๆ ซึ่งเป็นสิ่งเดียวที่ตัวเฝ้าดูนี้มีไว้ป้องกัน
 *
 * ไฟล์เสียหายไม่ใช่เรื่องคอขาดบาดตาย — เสียแค่การแจ้งเตือนหนึ่งรอบ
 * จึงห้ามทำให้เซิร์ฟเวอร์เริ่มไม่ขึ้นเด็ดขาด
 */
function loadMultiwanState() {
    try {
        const raw = JSON.parse(fs.readFileSync(MULTIWAN_STATE_FILE, 'utf8'));
        Object.entries(raw && raw.sites ? raw.sites : {}).forEach(([k, v]) => {
            if (typeof v === 'string') multiwanState.set(k, v);
        });
        if (multiwanState.size > 0) {
            console.log(`[Multi-WAN] กู้คืนสถานะ ${multiwanState.size} สาขา`);
        }
    } catch (_) { /* ไม่มีไฟล์ หรืออ่านไม่ออก = เริ่มใหม่ ไม่ใช่ความผิดพลาด */ }
}

function saveMultiwanState() {
    try {
        const sites = {};
        multiwanState.forEach((v, k) => { sites[k] = v; });
        const tmp = MULTIWAN_STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ version: 1, sites }), { mode: 0o600 });
        fs.renameSync(tmp, MULTIWAN_STATE_FILE);
    } catch (e) {
        console.warn('[Multi-WAN] บันทึกสถานะไม่สำเร็จ:', e.message);
    }
}

loadMultiwanState();

setInterval(async () => {
    try {
        const sitesData = await db.getSites();
        const sites = (sitesData && sitesData.sites) || [];
        for (const site of sites) {
            if (!site.host || !site.username) continue;
            try {
                const active = await executeOnRouter(site.id, async (client) => {
                    const routes = await client.exec('/ip/route/print');
                    return mwAnalyze.activeFailoverWan(routes);
                });
                if (!active) {
                    // สาขานี้ไม่ได้ลง failover (หรือเพิ่งถอนออก)
                    if (multiwanState.has(site.id)) {
                        multiwanState.delete(site.id);
                        saveMultiwanState();
                    }
                    continue;
                }

                const prev = multiwanState.get(site.id);
                if (prev === active.interface) continue;   // ไม่เปลี่ยน ไม่ต้องเขียนไฟล์
                multiwanState.set(site.id, active.interface);
                saveMultiwanState();
                if (prev === undefined) continue;          // เพิ่งเห็นครั้งแรก ยังไม่มีอะไรให้เทียบ

                if (!active.isPrimary) {
                    await sendOpsAlert(
                        `⚠️ Multi-WAN failover ทำงาน
` +
                        `สาขา: ${site.name}
` +
                        `สลับจาก ${prev} → ${active.interface} (distance ${active.distance})

` +
                        `ตอนนี้กำลังใช้ backup line อยู่ ซึ่งมักช้ากว่า line หลัก
` +
                        `ควรตรวจว่า line หลักเกิดอะไรขึ้น`, 'multiwan');
                    db.addLog('system', 'Multi-WAN failover',
                        `${site.name}: ${prev} → ${active.interface}`);
                } else {
                    await sendOpsAlert(
                        `✅ Multi-WAN กลับมาใช้ line หลัก
` +
                        `สาขา: ${site.name}
` +
                        `สลับจาก ${prev} → ${active.interface}`, 'multiwan');
                    db.addLog('system', 'Multi-WAN กลับสู่ line หลัก',
                        `${site.name}: ${prev} → ${active.interface}`);
                }
            } catch (_) {
                // ติดต่อสาขาไม่ได้เป็นหน้าที่ของตัวเฝ้าระวัง offline ที่มีอยู่แล้ว
                // ตรงนี้ไม่ต้องเตือนซ้ำ
            }
        }
    } catch (err) {
        console.warn('[Multi-WAN Monitor]', err.message);
    }
}, 300000);



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
        await executeOnRouter(req, async (client) => {
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
        const status = await executeOnRouter(req, async (client) => {
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
        const rules = await executeOnRouter(req, async (client) => {
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
        await executeOnRouter(req, async (client) => {
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
        await executeOnRouter(req, async (client) => {
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
        await executeOnRouter(req, async (client) => {
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
// watermark — instead we fingerprint each entry and keep a bounded recent-history
// set per site.
//
// The fingerprint MUST be keyed on the log line's own timestamp, not on the time
// we happened to process it. Measured on Suksawad-CMU 2026-08-29: the router's
// 3000-line dns buffer only spans ~10.5 minutes at that site's query rate, while
// the poller reads it every 5 minutes — so every line is read 2-3 times. With a
// processing-time key each re-read produced a different fingerprint and got
// inserted again, roughly doubling the stored rows. A log-time key is stable
// across re-reads, so the same query is stored exactly once.
let recentDnsFingerprintsBySite = new Map(); // siteId -> Set(fingerprint)

// Must comfortably exceed the number of distinct entries the router's buffer can
// hold, or entries age out of this set while still present in the buffer and get
// re-inserted. ~1,500 query lines per 10-minute buffer window at the busiest site,
// so 2,000 was cutting it far too close.
const MAX_DNS_FINGERPRINTS = 20000;

function getDnsFingerprintSet(siteId) {
    let set = recentDnsFingerprintsBySite.get(siteId);
    if (!set) {
        set = new Set();
        recentDnsFingerprintsBySite.set(siteId, set);
    }
    return set;
}

function rememberDnsFingerprint(siteId, fp) {
    const set = getDnsFingerprintSet(siteId);
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

            // Must be the live set from the map, not `... || new Set()`. When a site
            // had no entry yet, that fallback created a detached Set that was checked
            // but never written to (rememberDnsFingerprint stores its own), so the
            // very first batch after every restart was inserted with no dedupe at all.
            const siteDnsFingerprints = getDnsFingerprintSet(site.id);
            const newRows = [];
            for (const line of dnsLogLines) {
                const parsed = parseDnsLogMessage(line.message || '');
                if (!parsed) {
                    if (process.env.DEBUG_DNS_LOG) console.log('[DEBUG_DNS_LOG]', site.name, 'unmatched:', line.message);
                    continue;
                }

                // Keyed on the router's own log timestamp so re-reading the same
                // buffer entry on the next poll collapses instead of duplicating.
                // Falling back to the processing minute keeps the old behaviour for
                // entries whose time can't be trusted, rather than dropping them.
                const logTime = parseRouterOsLogTime(line.time);
                const fp = parsed.sourceIp + '|' + parsed.domain + '|' +
                    (logTime || 'p' + Math.floor(Date.now() / 60000));
                if (siteDnsFingerprints.has(fp)) continue;
                rememberDnsFingerprint(site.id, fp);

                const client = ipToClient.get(parsed.sourceIp);
                newRows.push({
                    queryTime: logTime || new Date().toISOString(),
                    username: client ? client.username : '',
                    ipAddress: parsed.sourceIp,
                    macAddress: client ? client.macAddress : '',
                    domain: parsed.domain,
                    siteName
                });
            }

            if (newRows.length > 0) {
                try {
                    // เขียนลงไฟล์รายวันแทนตารางใน Postgres — ข้อมูลชุดเดียวกันกินที่
                    // 85 MB/วันในฐานข้อมูล แต่เหลือ 5.8 MB/วันเมื่อเป็นไฟล์ที่บีบอัด
                    // และไม่ต้องพึ่งการเชื่อมต่อออกนอกเครื่องด้วย
                    dnsStore.appendRows(newRows);
                } catch (e) {
                    console.error('[DnsStore] เขียน DNS log ไม่สำเร็จ:', e.message);
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


// แปลง RouterOS uptime string เป็น milliseconds

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
    // ลบทั้งสองที่: แถวเก่าที่ยังค้างใน Postgres และไฟล์รายวันที่เกินกำหนด
    const purgedDns = await db.purgeOldDnsQueryLogs();
    if (purgedDns > 0) {
        db.addLog('System Auto', 'Purge DNS Log เก่า', `ลบ DNS query log เก่าเกิน 90 วัน จำนวน ${purgedDns} รายการ`);
    }
    try {
        const f = dnsStore.purgeOld(90);
        if (f.removedFiles > 0) {
            db.addLog('System Auto', 'Purge DNS Log เก่า (ไฟล์)',
                `ลบไฟล์ DNS ก่อนวันที่ ${f.cutoff} จำนวน ${f.removedFiles} ไฟล์ คืนพื้นที่ ${Math.round(f.freedBytes / 1048576)} MB`);
        }
    } catch (e) {
        console.error('[DnsStore] ลบไฟล์เก่าไม่สำเร็จ:', e.message);
    }
}, 24 * 60 * 60 * 1000);

// Server Listen — default 127.0.0.1 behind nginx; override with HOST=0.0.0.0 for local dev
const LISTEN_HOST = process.env.HOST || '127.0.0.1';
app.listen(PORT, LISTEN_HOST, () => {
    console.log(`[Server] MikroTik API Server running on http://${LISTEN_HOST}:${PORT}`);
});
