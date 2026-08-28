// helper แปลงค่าที่ RouterOS คืนมาให้อ่านง่าย — ยกมาจาก public/app.js ตรง ๆ
// เพื่อให้ผลลัพธ์บนหน้าใหม่ตรงกับหน้าเดิมทุกตัวอักษร

export function formatUptime(uptimeStr) {
    if (!uptimeStr || uptimeStr === '-' || uptimeStr === 'N/A') return '-';

    const str = String(uptimeStr).trim();
    const num = (re) => {
        const m = str.match(re);
        return m ? parseInt(m[1], 10) : 0;
    };

    const weeks = num(/(\d+)w/i);
    const days = num(/(\d+)d/i);
    const hours = num(/(\d+)h/i);
    const mins = num(/(\d+)m/i);
    const secs = num(/(\d+)s/i);

    const parts = [];
    if (weeks > 0) parts.push(`${weeks} สัปดาห์`);
    if (days > 0) parts.push(`${days} วัน`);
    if (hours > 0 && parts.length < 2) parts.push(`${hours} ชม.`);
    if (mins > 0 && parts.length < 2) parts.push(`${mins} นาที`);
    if (parts.length === 0 && secs > 0) parts.push(`${secs} วินาที`);
    if (parts.length > 0) return parts.join(' ');

    if (str.includes(':')) {
        const t = str.split(':');
        if (t.length === 3) {
            const h = parseInt(t[0], 10) || 0;
            const m = parseInt(t[1], 10) || 0;
            return h > 0 ? `${h} ชม. ${m} นาที` : `${m} นาที`;
        }
    }

    return str;
}

export function formatMegabytes(bytes) {
    if (!bytes && bytes !== 0) return '-';
    return Math.round(bytes / (1024 * 1024));
}

// ยกมาจาก formatBytes ใน public/app.js ให้ผลลัพธ์ตรงกันทุกตัวอักษร
export function formatBytes(bytes, decimals = 2) {
    if (!bytes || bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// ยกมาจาก parseUptimeToMs ใน server.js — เข้าใจทั้ง 1w2d3h4m5s และ HH:MM:SS
// ใช้ตัดสินว่าคูปองหมดอายุหรือยัง จึงต้องให้ผลตรงกับฝั่ง server เป๊ะ ๆ
export function parseUptimeToMs(uptime) {
    if (!uptime || uptime === 'Unlimited' || uptime === '00:00:00') return 0;
    const str = String(uptime);
    let ms = 0;
    const grab = (re, mult) => { const m = str.match(re); if (m) ms += parseInt(m[1], 10) * mult; };
    grab(/(\d+)w/, 7 * 24 * 3600000);
    grab(/(\d+)d/, 24 * 3600000);
    grab(/(\d+)h/, 3600000);
    grab(/(\d+)m/, 60000);
    grab(/(\d+)s/, 1000);
    if (ms === 0 && str.includes(':')) {
        const parts = str.split(':').map(Number);
        if (parts.length === 3 && !parts.some(isNaN)) {
            ms = (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
        }
    }
    return ms;
}

// RouterOS ส่ง last-logged-out มาเป็น "aug/12/2026 19:45:10" ซึ่ง new Date() แปลไม่ได้
// ยกมาจาก parseRouterOSDate ใน public/app.js — ค่า jan/01/1970 คือ "ไม่เคยออนไลน์"
export function parseRouterOSDate(str) {
    if (!str || typeof str !== 'string') return null;

    const iso = new Date(str);
    if (!isNaN(iso.getTime())) return iso.getFullYear() <= 1970 ? null : iso;

    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const parts = str.trim().split(/[\s/:]+/);
    if (parts.length < 3) return null;
    const month = months[parts[0].toLowerCase()];
    if (month === undefined) return null;
    const d = new Date(
        parseInt(parts[2], 10), month, parseInt(parts[1], 10),
        parseInt(parts[3] || 0, 10), parseInt(parts[4] || 0, 10), parseInt(parts[5] || 0, 10)
    );
    if (isNaN(d.getTime()) || d.getFullYear() <= 1970) return null;
    return d;
}

// "12 ส.ค. 19:45 น. (3 ชม. ที่แล้ว)" — รูปแบบเดียวกับหน้าเดิม
export function formatLastSeen(raw) {
    const d = parseRouterOSDate(raw);
    if (!d) return 'ไม่เคยออนไลน์';

    const dateStr = d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' }) +
        ' ' + d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }) + ' น.';

    const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
    let rel;
    if (diffMin < 1) rel = 'เมื่อสักครู่';
    else if (diffMin < 60) rel = `${diffMin} นาทีที่แล้ว`;
    else if (diffMin < 1440) rel = `${Math.floor(diffMin / 60)} ชม. ที่แล้ว`;
    else rel = `${Math.floor(diffMin / 1440)} วันที่แล้ว`;

    return `${dateStr} (${rel})`;
}
