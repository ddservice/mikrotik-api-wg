/**
 * lib/storage-monitor.js — เฝ้าดูพื้นที่เก็บข้อมูล และเตือนก่อนเต็ม
 *
 * ทำไมต้องมี: ระบบนี้เขียนข้อมูลลงที่เก็บ 3 แห่งตลอดเวลา แต่ไม่เคยมีอะไรคอยดูว่า
 * แต่ละแห่งเหลือที่เท่าไร — ดิสก์ VPS (log/สำรองข้อมูล/ไฟล์ปิดผนึก), Cloudflare R2
 * และ Postgres บน Supabase (แพ็กเกจฟรีให้ 500 MB) ถ้าที่ใดที่หนึ่งเต็ม
 * อาการที่เห็นคือ "ระบบพัง" โดยไม่มีสัญญาณเตือนล่วงหน้าเลย
 *
 * อีกเรื่องที่สำคัญไม่แพ้กันและตรวจไปพร้อมกันคือ การลบข้อมูลเกิน 90 วันตาม ม.26
 * ยังทำงานอยู่จริงหรือไม่ — ถ้าแถวที่เก่าที่สุดอายุเกินกำหนด แปลว่า purge พัง
 * ที่ผ่านมาไม่มีใครรู้ได้เลยเพราะไม่เคยมีอะไรตรวจย้อนกลับ (บทเรียนเดียวกับที่
 * DNS log ตายไป 50 วันโดยไม่มีใครสังเกต — สิ่งที่ "ควรจะทำงาน" ต้องมีคนคอยตรวจ)
 *
 * ออกแบบให้เรียกได้บ่อยโดยไม่แพง: อ่านขนาดโฟลเดอร์เป็นการอ่าน metadata อย่างเดียว
 * ไม่ได้เปิดอ่านเนื้อไฟล์ ส่วนฝั่งฐานข้อมูลใช้ head-count ไม่ได้ดึงแถวจริงมา
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const r2 = require('./r2');

const ROOT = path.join(__dirname, '..');
const R2_SITE_NAME = process.env.R2_SITE_NAME || 'Mikrotikapi-db';

// เกณฑ์เตือน — ตั้งไว้ 80/90 เพื่อให้มีเวลาแก้ก่อนเต็มจริง
// ถ้ารอถึง 95% มักสายเกินไปแล้ว เพราะบางงาน (เช่น สำรองข้อมูล) ต้องใช้ที่ว่างชั่วคราว
const DISK_WARN_PERCENT = Number(process.env.STORAGE_WARN_PERCENT || 80);
const DISK_CRITICAL_PERCENT = Number(process.env.STORAGE_CRITICAL_PERCENT || 90);

// ...แต่เปอร์เซ็นต์อย่างเดียวเตือนผิดได้ง่าย: ดิสก์ 4 TB ที่ใช้ไป 95% ยังเหลือ 200 GB
// ซึ่งไม่ใช่เรื่องด่วนเลย ขณะที่ดิสก์ 20 GB ที่ใช้ไป 90% เหลือแค่ 2 GB คือเรื่องด่วนจริง
// สิ่งที่ทำให้ระบบพังคือ "ที่ว่างเป็นไบต์ไม่พอเขียน" ไม่ใช่ตัวเลขเปอร์เซ็นต์
//
// จึงใช้สองเงื่อนไขคู่กัน: ที่ว่างจริงต่ำกว่าขั้นต่ำ = เตือนทันทีไม่สนเปอร์เซ็นต์
// ส่วนเปอร์เซ็นต์สูงจะเตือนก็ต่อเมื่อที่ว่างเหลือน้อยกว่า HEADROOM ด้วย
// (พบตอนทดสอบบนเครื่อง dev 2026-08-29 — เกณฑ์เดิมเตือน critical ทั้งที่เหลือ 200 GB)
const DISK_CRITICAL_FREE_BYTES = Number(process.env.STORAGE_CRITICAL_FREE_BYTES || 3 * 1024 * 1024 * 1024);
const DISK_WARN_FREE_BYTES = Number(process.env.STORAGE_WARN_FREE_BYTES || 10 * 1024 * 1024 * 1024);
const DISK_HEADROOM_BYTES = Number(process.env.STORAGE_HEADROOM_BYTES || 20 * 1024 * 1024 * 1024);

function diskLevel(usedPercent, availBytes) {
    if (availBytes < DISK_CRITICAL_FREE_BYTES) return 'critical';
    if (usedPercent >= DISK_CRITICAL_PERCENT && availBytes < DISK_HEADROOM_BYTES) return 'critical';
    if (availBytes < DISK_WARN_FREE_BYTES) return 'warn';
    if (usedPercent >= DISK_WARN_PERCENT && availBytes < DISK_HEADROOM_BYTES) return 'warn';
    return 'ok';
}

// Supabase แพ็กเกจฟรีให้ 500 MB — เตือนที่ 70% เพราะการขยับแพ็กเกจต้องใช้เวลาตัดสินใจ
const DB_QUOTA_BYTES = Number(process.env.SUPABASE_QUOTA_BYTES || 500 * 1024 * 1024);
const DB_WARN_PERCENT = Number(process.env.SUPABASE_WARN_PERCENT || 70);

// เตือนเมื่อคาดว่าจะเต็มภายในกี่วัน — 30 วันให้เวลาพอที่จะตัดสินใจเรื่องแพ็กเกจ
// หรือเปลี่ยนวิธีเก็บ โดยไม่ต้องรีบร้อนตอนเหลือไม่กี่วัน
const DB_FORECAST_WARN_DAYS = Number(process.env.SUPABASE_FORECAST_WARN_DAYS || 30);

// โฟลเดอร์ที่ต้องจับตา — growing = โตขึ้นเรื่อย ๆ ตามการใช้งาน
// ตัวที่ไม่ growing ใส่ไว้เพื่อให้เห็นภาพรวมว่าอะไรกินที่ ไม่ใช่เพื่อเตือน
const WATCHED_DIRS = [
    { key: 'archives', label: 'ไฟล์ log ปิดผนึก', dir: path.join(ROOT, 'archives'), growing: true },
    { key: 'logs', label: 'log ของ PM2', dir: path.join(ROOT, 'logs'), growing: true },
    { key: 'backups', label: 'สำรองข้อมูล', dir: path.join(os.homedir(), 'backups'), growing: true },
    { key: 'db', label: 'ฐานข้อมูล JSON (สำรอง)', dir: path.join(ROOT, 'db'), growing: false },
    { key: 'node_modules', label: 'ไลบรารี', dir: path.join(ROOT, 'node_modules'), growing: false },
    { key: 'public', label: 'หน้าเว็บ', dir: path.join(ROOT, 'public'), growing: false }
];

function formatBytes(n) {
    if (!n || n < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
}

/**
 * พื้นที่ดิสก์ของ partition ที่แอปอยู่
 *
 * คิดเปอร์เซ็นต์แบบเดียวกับคำสั่ง df คือ used / (used + available)
 * ไม่ใช่ used / total — เพราะ ext4 กันพื้นที่ไว้ให้ root ประมาณ 5%
 * ซึ่ง user ธรรมดาเขียนไม่ได้ ถ้าคิดจาก total ตัวเลขจะดูดีเกินจริง
 * และไม่ตรงกับที่ผู้ใช้เห็นตอนรัน df -h เอง
 */
async function getDiskUsage() {
    if (typeof fsp.statfs !== 'function') {
        return { available: false, reason: 'Node รุ่นนี้ไม่รองรับ fs.statfs (ต้อง 18.15 ขึ้นไป)' };
    }
    try {
        const st = await fsp.statfs(ROOT);
        const blockSize = st.bsize;
        const totalBytes = st.blocks * blockSize;
        const freeBytes = st.bfree * blockSize;
        const availBytes = st.bavail * blockSize;      // ที่ว่างที่ user ธรรมดาใช้ได้จริง
        const usedBytes = totalBytes - freeBytes;
        const denom = usedBytes + availBytes;
        const usedPercent = denom > 0 ? Math.round((usedBytes / denom) * 100) : 0;

        return {
            available: true,
            path: ROOT,
            totalBytes: totalBytes,
            usedBytes: usedBytes,
            availBytes: availBytes,
            usedPercent: usedPercent,
            level: diskLevel(usedPercent, availBytes),
            human: {
                total: formatBytes(totalBytes),
                used: formatBytes(usedBytes),
                available: formatBytes(availBytes)
            }
        };
    } catch (e) {
        return { available: false, reason: e.message };
    }
}

/**
 * ขนาดรวมของโฟลเดอร์ (ไล่ลงโฟลเดอร์ย่อย)
 *
 * ไม่เดินตาม symlink เพราะเสี่ยงวนไม่รู้จบและอาจนับซ้ำของที่อยู่นอกโฟลเดอร์
 * มีเพดานจำนวนไฟล์กันกรณี node_modules บวมผิดปกติจนสแกนนานเกินควร
 */
async function dirSize(dir, opts) {
    const maxEntries = (opts && opts.maxEntries) || 200000;
    let total = 0;
    let files = 0;
    let truncated = false;
    const stack = [dir];

    while (stack.length) {
        const cur = stack.pop();
        let entries;
        try {
            entries = await fsp.readdir(cur, { withFileTypes: true });
        } catch (_) {
            continue;   // อ่านไม่ได้ (สิทธิ์ไม่พอ / ถูกลบระหว่างสแกน) ก็ข้ามไป
        }
        for (const ent of entries) {
            if (ent.isSymbolicLink()) continue;
            const full = path.join(cur, ent.name);
            if (ent.isDirectory()) {
                stack.push(full);
            } else if (ent.isFile()) {
                files++;
                if (files > maxEntries) { truncated = true; stack.length = 0; break; }
                try {
                    const st = await fsp.stat(full);
                    total += st.size;
                } catch (_) {}
            }
        }
    }
    return { bytes: total, files: files, truncated: truncated };
}

async function getDirUsage() {
    return Promise.all(WATCHED_DIRS.map(async (d) => {
        if (!fs.existsSync(d.dir)) {
            return { key: d.key, label: d.label, dir: d.dir, growing: d.growing,
                     exists: false, bytes: 0, files: 0, human: '0 B' };
        }
        const s = await dirSize(d.dir);
        return { key: d.key, label: d.label, dir: d.dir, growing: d.growing, exists: true,
                 bytes: s.bytes, files: s.files, truncated: s.truncated, human: formatBytes(s.bytes) };
    }));
}

/**
 * พื้นที่ที่ใช้บน Cloudflare R2 แยกตามหมวด
 * R2 ไม่มีโควตาตายตัวแบบดิสก์ แต่คิดเงินตามที่ใช้ จึงต้องเห็นว่าโตแค่ไหน
 */
async function getR2Usage() {
    if (!r2.isConfigured()) return { configured: false };
    try {
        const objects = await r2.listObjects(R2_SITE_NAME + '/');
        const groups = new Map();
        let bytes = 0;
        let newest = null;

        for (const o of objects) {
            bytes += o.size;
            if (o.lastModified && (!newest || o.lastModified > newest)) newest = o.lastModified;
            // จัดกลุ่มตามโฟลเดอร์ชั้นถัดจากชื่อไซต์ เช่น log-archives / 2026-08-28
            const rest = o.key.slice(R2_SITE_NAME.length + 1);
            const group = rest.indexOf('/') >= 0 ? rest.split('/')[0] : '(ไฟล์เดี่ยว)';
            const g = groups.get(group) || { group: group, objects: 0, bytes: 0 };
            g.objects++;
            g.bytes += o.size;
            groups.set(group, g);
        }

        return {
            configured: true,
            bucket: r2.cfg().bucket,
            prefix: R2_SITE_NAME,
            objects: objects.length,
            bytes: bytes,
            human: formatBytes(bytes),
            newest: newest,
            groups: [...groups.values()]
                .map((g) => ({ group: g.group, objects: g.objects, bytes: g.bytes, human: formatBytes(g.bytes) }))
                .sort((a, b) => b.bytes - a.bytes)
        };
    } catch (e) {
        return { configured: true, error: e.message };
    }
}

/**
 * ประกอบรายงานฉบับเต็ม แล้วสรุปออกมาเป็นรายการ "เรื่องที่ต้องรู้"
 * ให้คนอ่านเห็นทันทีว่ามีอะไรต้องทำไหม ไม่ต้องไล่ตัวเลขเอง
 */
async function buildReport(db) {
    const parts = await Promise.all([
        getDiskUsage(),
        getDirUsage(),
        getR2Usage(),
        db.getStorageStats().catch((e) => ({ error: e.message, tables: [] })),
        // สถานะสวิตช์ DNS มาอยู่ในรายงานเดียวกัน เพราะเป็นปุ่มที่คนจะกดตอบสนอง
        // ต่อตัวเลขในรายงานนี้ ไม่ควรต้องไปเปิดอีกหน้าเพื่อดูว่าตอนนี้เปิดอยู่ไหม
        //
        // ต้องห่อด้วย Promise.resolve() — getSites() ของชั้น Supabase เป็น async
        // แต่ของชั้น JSON เป็น sync คืน object ธรรมดาที่ไม่มี .then
        // (บั๊กเดิมแบบเดียวกับ 2026-08-13 (6) ที่ check-db-parity.js ตั้งขึ้นมาดักโดยเฉพาะ)
        Promise.resolve(db.getSites())
            .then((d) => ((d && d.sites) || []).map((x) => ({
                id: x.id, name: x.name, enabled: x.dnsLoggingEnabled !== false
            })))
            .catch(() => [])
    ]);
    const disk = parts[0];
    const dirs = parts[1];
    const r2usage = parts[2];
    const dbStats = parts[3];
    const dnsSites = parts[4];

    const issues = [];

    if (disk.available && disk.level !== 'ok') {
        issues.push({
            level: disk.level,
            area: 'ดิสก์ VPS',
            message: `เหลือที่ว่าง ${disk.human.available} จาก ${disk.human.total} (ใช้ไป ${disk.usedPercent}%)`,
            action: 'ลบไฟล์เก่าหรือขยายดิสก์'
        });
    }

    // การลบข้อมูลตามกำหนดยังทำงานอยู่ไหม — เรื่องนี้สำคัญกว่าพื้นที่เต็มเสียอีก
    // เพราะเก็บข้อมูลไว้เกินกำหนดก็ขัดกับหลักการของ ม.26 เหมือนกัน
    (dbStats.tables || []).forEach((t) => {
        if (t.retentionDays && t.retentionOk === false) {
            issues.push({
                level: 'warn',
                area: t.label,
                message: `ข้อมูลเก่าสุดอายุ ${t.oldestAgeDays} วัน เกินกำหนดเก็บ ${t.retentionDays} วัน`,
                action: 'ตรวจว่าการลบข้อมูลอัตโนมัติยังทำงานอยู่'
            });
        }
    });

    const dbBytes = dbStats.estimatedBytes || 0;
    const dbPercent = DB_QUOTA_BYTES > 0 ? Math.round((dbBytes / DB_QUOTA_BYTES) * 100) : 0;
    if (dbStats.backend === 'supabase' && dbPercent >= DB_WARN_PERCENT) {
        issues.push({
            level: dbPercent >= 90 ? 'critical' : 'warn',
            area: 'ฐานข้อมูล Supabase',
            message: `ข้อมูลประมาณ ${formatBytes(dbBytes)} จากโควตา ${formatBytes(DB_QUOTA_BYTES)} (~${dbPercent}%)`,
            action: 'ลดระยะเก็บข้อมูล หรืออัปเกรดแพ็กเกจ'
        });
    }

    // เตือนล่วงหน้าจาก "อัตราโต" ไม่ใช่รอจนเต็ม
    //
    // เปอร์เซ็นต์ปัจจุบันบอกแค่อดีต ตารางที่ตอนนี้ใช้ 9% แต่โตวันละ 51 MB จะเต็ม
    // ภายในสัปดาห์เดียว ซึ่งเป็นสิ่งที่ต้องรู้ตั้งแต่ตอนนี้ ไม่ใช่ตอนเหลือ 3 วัน
    // (สถานการณ์จริงของ dns_query_logs เมื่อ 2026-08-29)
    const growthBytesPerDay = (dbStats.tables || []).reduce((sum, t) => {
        return sum + ((t.rowsLast24h || 0) * (t.avgRowBytes || 0));
    }, 0);
    const daysUntilFull = growthBytesPerDay > 0
        ? Math.floor((DB_QUOTA_BYTES - dbBytes) / growthBytesPerDay)
        : null;

    if (dbStats.backend === 'supabase' && daysUntilFull !== null && daysUntilFull <= DB_FORECAST_WARN_DAYS) {
        issues.push({
            level: daysUntilFull <= 7 ? 'critical' : 'warn',
            area: 'ฐานข้อมูลจะเต็ม',
            message: daysUntilFull <= 0
                ? `โตวันละ ~${formatBytes(growthBytesPerDay)} และเกินโควตาแล้ว`
                : `โตวันละ ~${formatBytes(growthBytesPerDay)} จะเต็มโควตาในอีกประมาณ ${daysUntilFull} วัน`,
            action: 'ปิดการเก็บ DNS ชั่วคราว ลดระยะเก็บ หรืออัปเกรดแพ็กเกจ'
        });
    }

    // ตารางที่เก็บตามกำหนดแต่ปริมาณคาดการณ์เกินโควตาไปเลย — บอกให้เห็นตั้งแต่ต้น
    // ว่าต่อให้ purge ทำงานถูกต้อง ก็ยังไม่พออยู่ดี
    (dbStats.tables || []).forEach((t) => {
        if (dbStats.backend !== 'supabase' || !t.projectedBytes) return;
        if (t.projectedBytes <= DB_QUOTA_BYTES) return;
        issues.push({
            level: 'warn',
            area: t.label,
            message: `อัตราปัจจุบัน (${(t.rowsLast24h || 0).toLocaleString()} แถว/วัน) เมื่อเก็บครบ ` +
                `${t.retentionDays} วันจะใช้ ~${formatBytes(t.projectedBytes)} ซึ่งเกินโควตา ${formatBytes(DB_QUOTA_BYTES)}`,
            action: 'ปิดการเก็บชั่วคราว หรือย้ายไปเก็บที่อื่น'
        });
    });

    // ปิดการเก็บ DNS ไว้ = ไม่มีบันทึกตาม ม.26 ในช่วงนั้น และกู้คืนย้อนหลังไม่ได้
    // (บทเรียนตรง ๆ จากช่วง 10 ก.ค. - 28 ส.ค. ที่หายไปถาวร) จึงต้องเตือนทุกวัน
    // ที่ยังปิดอยู่ เพื่อไม่ให้ "ปิดชั่วคราว" กลายเป็นปิดค้างไว้โดยไม่มีใครสังเกต
    if (dnsSites.length && dnsSites.every((x) => !x.enabled)) {
        issues.push({
            level: 'warn',
            area: 'การเก็บประวัติเข้าเว็บ (ม.26)',
            message: 'ปิดอยู่ทุกสาขา — ช่วงที่ปิดจะไม่มีบันทึกและย้อนกลับไปเก็บไม่ได้',
            action: 'เปิดกลับเมื่อจัดการเรื่องพื้นที่เรียบร้อยแล้ว'
        });
    } else if (dnsSites.some((x) => !x.enabled)) {
        const off = dnsSites.filter((x) => !x.enabled).map((x) => x.name);
        issues.push({
            level: 'warn',
            area: 'การเก็บประวัติเข้าเว็บ (ม.26)',
            message: `ปิดอยู่ ${off.length} สาขา: ${off.join(', ')}`,
            action: 'ตรวจว่าตั้งใจปิดไว้จริง'
        });
    }

    // ไฟล์ปิดผนึกควรขึ้น R2 ด้วยเสมอ ถ้าขึ้นไม่ได้แปลว่าเหลือสำเนาเดียวบน VPS
    // ซึ่งขัดกับเหตุผลที่ทำไฟล์ปิดผนึกตั้งแต่แรก
    if (r2usage.configured && r2usage.error) {
        issues.push({
            level: 'warn',
            area: 'Cloudflare R2',
            message: 'เชื่อมต่อไม่ได้: ' + r2usage.error,
            action: 'ตรวจคีย์ R2 ใน ecosystem.config.js'
        });
    }

    return {
        generatedAt: new Date().toISOString(),
        disk: disk,
        dirs: dirs,
        r2: r2usage,
        database: Object.assign({}, dbStats, {
            quotaBytes: DB_QUOTA_BYTES,
            quotaPercent: dbPercent,
            human: formatBytes(dbBytes),
            growthBytesPerDay: growthBytesPerDay,
            growthHuman: formatBytes(growthBytesPerDay),
            daysUntilFull: daysUntilFull
        }),
        dnsLogging: {
            sites: dnsSites,
            enabledCount: dnsSites.filter((x) => x.enabled).length,
            totalCount: dnsSites.length
        },
        thresholds: {
            diskWarnPercent: DISK_WARN_PERCENT,
            diskCriticalPercent: DISK_CRITICAL_PERCENT,
            diskWarnFreeBytes: DISK_WARN_FREE_BYTES,
            diskCriticalFreeBytes: DISK_CRITICAL_FREE_BYTES,
            diskHeadroomBytes: DISK_HEADROOM_BYTES,
            dbWarnPercent: DB_WARN_PERCENT,
            dbForecastWarnDays: DB_FORECAST_WARN_DAYS
        },
        issues: issues,
        level: issues.some((i) => i.level === 'critical') ? 'critical'
            : issues.length ? 'warn' : 'ok'
    };
}

/** ข้อความแจ้งเตือนสำหรับ Telegram (HTML) */
function formatAlert(report) {
    const icon = report.level === 'critical' ? '🔴' : '🟠';
    const lines = [icon + ' <b>เตือนพื้นที่เก็บข้อมูล</b>', ''];

    report.issues.forEach((i) => {
        lines.push((i.level === 'critical' ? '🔴' : '🟠') + ' <b>' + i.area + '</b>');
        lines.push('   ' + i.message);
        lines.push('   ➜ ' + i.action);
        lines.push('');
    });

    if (report.disk.available) {
        lines.push(`💽 ดิสก์: ${report.disk.human.used} / ${report.disk.human.total} (${report.disk.usedPercent}%) เหลือ ${report.disk.human.available}`);
    }
    if (report.database && report.database.totalRows) {
        lines.push(`🗄 ฐานข้อมูล: ${report.database.totalRows.toLocaleString()} แถว ~${report.database.human}`);
        if (report.database.growthBytesPerDay > 0) {
            const d = report.database.daysUntilFull;
            lines.push(`   โตวันละ ~${report.database.growthHuman}` +
                (d !== null && d >= 0 ? ` · เต็มในอีก ~${d} วัน` : ''));
        }
    }
    if (report.r2 && report.r2.configured && !report.r2.error) {
        lines.push(`☁️ R2: ${report.r2.objects} ไฟล์ ${report.r2.human}`);
    }
    lines.push('');
    lines.push('🕐 ' + new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }));
    return lines.join('\n');
}

module.exports = {
    DISK_WARN_PERCENT: DISK_WARN_PERCENT,
    DISK_CRITICAL_PERCENT: DISK_CRITICAL_PERCENT,
    DISK_WARN_FREE_BYTES: DISK_WARN_FREE_BYTES,
    DISK_CRITICAL_FREE_BYTES: DISK_CRITICAL_FREE_BYTES,
    DISK_HEADROOM_BYTES: DISK_HEADROOM_BYTES,
    diskLevel: diskLevel,
    DB_QUOTA_BYTES: DB_QUOTA_BYTES,
    DB_FORECAST_WARN_DAYS: DB_FORECAST_WARN_DAYS,
    WATCHED_DIRS: WATCHED_DIRS,
    formatBytes: formatBytes,
    getDiskUsage: getDiskUsage,
    getDirUsage: getDirUsage,
    getR2Usage: getR2Usage,
    dirSize: dirSize,
    buildReport: buildReport,
    formatAlert: formatAlert
};
