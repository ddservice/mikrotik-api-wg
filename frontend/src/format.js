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
