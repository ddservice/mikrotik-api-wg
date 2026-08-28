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
