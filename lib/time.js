/**
 * lib/time.js — การจัดการเวลาและวันที่ทั้งหมดของระบบ รวมไว้ที่เดียว
 *
 * ทำไมต้องรวม: บั๊กเกือบทุกตัวที่เจอในช่วง 2026-08-28 ถึง 2026-08-30 เป็นเรื่องเวลา
 * ทั้งสิ้น — ตัวกรองช่วงวันที่ตัดวันสุดท้ายทิ้ง, query_time เก็บเวลาที่บันทึกแทนเวลา
 * ที่ query จริง, และงานปิดวันตอนตีสองปิดผิดวันเพราะคำนวณวันที่ตามเวลาไทยผิด
 * ทั้งหมดเกิดจากตรรกะเวลาที่กระจายอยู่หลายไฟล์และเขียนซ้ำกันคนละแบบ
 *
 * กฎของไฟล์นี้: ทุกฟังก์ชันต้องบริสุทธิ์ (รับค่าเข้า คืนค่าออก ไม่แตะ I/O)
 * เพื่อให้ทดสอบได้จริงใน test/ โดยไม่ต้องเปิด server
 */

const BANGKOK_TZ = 'Asia/Bangkok';

// เวลาเราท์เตอร์ — ไทยคือ UTC+7 ตลอดปี ไม่มี DST
const ROUTER_TZ_OFFSET_MIN = Number(process.env.ROUTER_TZ_OFFSET_MIN || 420);

const LOG_MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

/**
 * เวลาปัจจุบันตามเขตเวลาไทย
 *
 * วิธีที่เคยใช้คือ new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }))
 * แล้วเรียก .toISOString().slice(0,10) — ขั้นแรกได้เวลาไทยเป็นสตริง ขั้นที่สอง
 * new Date() ตีความสตริงนั้นตามเขตเวลา "ของเครื่อง" แล้ว toISOString() แปลงกลับ
 * เป็น UTC สุทธิแล้วเลื่อน -7 ชม. ผลคือได้วันที่ตาม UTC ไม่ใช่วันที่ตามเวลาไทย
 * และผิดไปหนึ่งวันทุกครั้งที่เวลาไทยยังไม่ถึง 07:00 น.
 *
 * ของจริงที่เจอ 2026-08-30: งานปิดวันตอน 02:00 น. ไปปิดวันที่ 28 ทั้งที่ควรปิด 29
 *
 * ใช้ Intl แยกส่วนออกมาตรง ๆ แทน ได้ค่าถูกไม่ว่าเครื่องตั้งเขตเวลาอะไรไว้
 */
function bangkokNow(at) {
    const now = at || new Date();
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: BANGKOK_TZ,
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
    }).formatToParts(now).reduce((acc, p) => {
        if (p.type !== 'literal') acc[p.type] = p.value;
        return acc;
    }, {});

    // hour12:false บาง runtime คืน "24" ตอนเที่ยงคืนแทนที่จะเป็น "00"
    const hour = parts.hour === '24' ? '00' : parts.hour;
    const hh = parseInt(hour, 10);
    const mm = parseInt(parts.minute, 10);

    return {
        date: new Date(now),
        hhmm: String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0'),
        minutes: hh * 60 + mm,
        dateStr: `${parts.year}-${parts.month}-${parts.day}`
    };
}

/** วันที่ "วันนี้" ตามเวลาไทย รูปแบบ YYYY-MM-DD */
function bangkokToday(at) {
    return (at || new Date()).toLocaleDateString('en-CA', { timeZone: BANGKOK_TZ });
}

/** เลื่อนวันที่รูปแบบ YYYY-MM-DD ไปกี่วันก็ได้ (ลบได้) */
function shiftDate(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

/** "09:00" -> 540 นาที; คืน null ถ้ารูปแบบไม่ถูก */
function parseHHMMToMinutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
}

/**
 * แปลงค่า uptime ของ RouterOS เป็นมิลลิวินาที
 * รับได้ทั้งแบบมีหน่วย (1w2d3h4m5s) และแบบ HH:MM:SS
 */
function parseUptimeToMs(uptime) {
    if (!uptime || uptime === 'Unlimited' || uptime === '00:00:00') return 0;
    let ms = 0;
    const w = String(uptime).match(/(\d+)w/); if (w) ms += parseInt(w[1]) * 7 * 24 * 3600000;
    const d = String(uptime).match(/(\d+)d/); if (d) ms += parseInt(d[1]) * 24 * 3600000;
    const h = String(uptime).match(/(\d+)h/); if (h) ms += parseInt(h[1]) * 3600000;
    const m = String(uptime).match(/(\d+)m/); if (m) ms += parseInt(m[1]) * 60000;
    const s = String(uptime).match(/(\d+)s/); if (s) ms += parseInt(s[1]) * 1000;
    if (ms === 0 && String(uptime).includes(':')) {
        const parts = String(uptime).split(':').map(Number);
        if (parts.length === 3 && !parts.some(isNaN)) {
            ms = (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
        }
    }
    return ms;
}

/**
 * แปลงค่า time จาก /log/print ของ RouterOS เป็น ISO timestamp
 *
 * ค่านี้ถูกเก็บลง dns_query_logs.query_time ซึ่งเป็นฟิลด์ที่ต้องใช้ยืนยันตาม ม.26
 * จึงต้องเป็นเวลาที่ query เกิดขึ้นจริง ไม่ใช่เวลาที่ poller อ่านมาเจอ
 * (ของเดิมใส่ new Date() ทุกแถวใน batch เดียวกันจึงมีเวลาเท่ากันหมด และช้าได้ถึง 5 นาที)
 *
 * รูปแบบที่เจอจริงบน ROS 7.24.1 คือ "2026-08-29 04:51:51"
 * รุ่นเก่าใช้ "aug/29 04:51:51" หรือ "04:51:51" สำหรับวันนี้ จึงรองรับทั้งหมด
 *
 * คืน null เมื่อค่าเชื่อถือไม่ได้ ให้ผู้เรียกตัดสินใจใช้เวลาสำรองแทน —
 * เราท์เตอร์ที่นาฬิกาเพี้ยนต้องไม่เขียนเวลาผิด ๆ ลงบันทึกทางกฎหมาย
 */
function parseRouterOsLogTime(raw, now = new Date()) {
    const s = String(raw || '').trim();
    if (!s) return null;

    let y, mo, d, hh, mm, ss;
    let m;

    if ((m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s))) {
        y = +m[1]; mo = +m[2] - 1; d = +m[3]; hh = +m[4]; mm = +m[5]; ss = +m[6];
    } else if ((m = /^([a-z]{3})\/(\d{1,2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/i.exec(s))) {
        mo = LOG_MONTHS[m[1].toLowerCase()];
        if (mo === undefined) return null;
        d = +m[2]; y = +m[3]; hh = +m[4]; mm = +m[5]; ss = +m[6];
    } else if ((m = /^([a-z]{3})\/(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})$/i.exec(s))) {
        mo = LOG_MONTHS[m[1].toLowerCase()];
        if (mo === undefined) return null;
        d = +m[2]; hh = +m[3]; mm = +m[4]; ss = +m[5];
        y = null;   // เดาปีด้านล่าง
    } else if ((m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(s))) {
        hh = +m[1]; mm = +m[2]; ss = +m[3];
        y = mo = d = null;   // "วันนี้" ของเราท์เตอร์
    } else {
        return null;
    }

    // เติมส่วนที่ RouterOS ไม่ได้ส่งมา โดยอิง "วันนี้" ตามเวลาเราท์เตอร์
    const nowLocal = new Date(now.getTime() + ROUTER_TZ_OFFSET_MIN * 60000);
    if (y === null || d === null) {
        if (d === null) { mo = nowLocal.getUTCMonth(); d = nowLocal.getUTCDate(); }
        y = nowLocal.getUTCFullYear();
        // ถ้าได้วันที่ในอนาคต แปลว่าเป็นของปีที่แล้ว (RouterOS ตัดปีทิ้ง
        // log ปลายธันวาคมที่อ่านตอนมกราคมจึงต้องถอยปี)
        if (Date.UTC(y, mo, d, hh, mm, ss) > nowLocal.getTime() + 86400000) y -= 1;
    }

    const localMs = Date.UTC(y, mo, d, hh, mm, ss);
    if (isNaN(localMs)) return null;
    const utcMs = localMs - ROUTER_TZ_OFFSET_MIN * 60000;

    // กันนาฬิกาเราท์เตอร์เพี้ยน: ล้ำหน้าเกิน 2 ชม. หรือเก่ากว่า 7 วัน ถือว่าเชื่อไม่ได้
    const drift = utcMs - now.getTime();
    if (drift > 2 * 3600000 || drift < -7 * 86400000) return null;

    return new Date(utcMs).toISOString();
}

module.exports = {
    BANGKOK_TZ,
    ROUTER_TZ_OFFSET_MIN,
    bangkokNow,
    bangkokToday,
    shiftDate,
    parseHHMMToMinutes,
    parseUptimeToMs,
    parseRouterOsLogTime
};
