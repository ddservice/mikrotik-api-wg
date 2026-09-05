/**
 * lib/router-health.js — ตัดสินว่าเราท์เตอร์มีเรื่องต้องจัดการอะไรบ้าง
 *
 * แยกออกมาเป็นฟังก์ชันบริสุทธิ์เพราะมีผู้เรียกสองทางที่ต้องได้คำตอบตรงกันเสมอ:
 *   1. ปุ่ม "ตรวจเลย" ที่คนกดเอง
 *   2. งานเฝ้าระวังรายวันที่ส่งเข้า Telegram
 * ถ้าเขียนตรรกะไว้สองที่ วันหนึ่งมันจะบอกคนละอย่าง แล้วคนจะเลิกเชื่อทั้งคู่
 *
 * รับ state ที่อ่านมาแล้ว ไม่ต่อเน็ตเอง — เทสต์ได้โดยไม่ต้องมีเราท์เตอร์
 */

'use strict';

const routerLog = require('./router-log');

// เกณฑ์รวมไว้ที่เดียว จะได้ปรับได้โดยไม่ต้องไล่แก้หลายจุด
const T = {
    memCritical: 10, memWarning: 25,      // % ที่เหลือ
    diskCritical: 10,                     // % ที่เหลือ
    cpuCritical: 90, cpuWarning: 70,      // % โหลด
    tempCritical: 70, tempWarning: 60,    // องศาเซลเซียส
    maxLogGroups: 6                       // อย่าให้ log ท่วมรายการจนเรื่องอื่นหาย
};

const RANK = { critical: 0, warning: 1, info: 2 };

function num(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 0;
}

/**
 * @param {object} state { resource, logs, ifaces, leases, health }
 * @returns {object} { findings, counts, healthy, router, logSummary }
 */
function analyzeHealth(state) {
    const s = state || {};
    const r = s.resource || {};
    const findings = [];
    const add = (severity, title, detail, action) => findings.push({ severity, title, detail, action });

    // ---- หน่วยความจำ ----
    const freeMem = num(r['free-memory']);
    const totalMem = num(r['total-memory']);
    if (totalMem > 0) {
        const freePct = Math.round((freeMem / totalMem) * 100);
        if (freePct < T.memCritical) {
            add('critical', 'หน่วยความจำเหลือน้อยมาก',
                `เหลือ ${freePct}% (${Math.round(freeMem / 1048576)} MB จาก ${Math.round(totalMem / 1048576)} MB)`,
                'เราท์เตอร์อาจค้างหรือรีบูตเอง — ลดขนาด log buffer หรือปิดฟีเจอร์ที่ไม่ได้ใช้');
        } else if (freePct < T.memWarning) {
            add('warning', 'หน่วยความจำเริ่มน้อย', `เหลือ ${freePct}%`,
                'ยังใช้งานได้ แต่ควรเฝ้าดู ถ้าลดลงเรื่อย ๆ แปลว่ามีอะไรกินหน่วยความจำเพิ่มขึ้น');
        }
    }

    // ---- พื้นที่เก็บข้อมูล ----
    const freeHdd = num(r['free-hdd-space']);
    const totalHdd = num(r['total-hdd-space']);
    if (totalHdd > 0 && (freeHdd / totalHdd) * 100 < T.diskCritical) {
        add('critical', 'พื้นที่เก็บข้อมูลบนเราท์เตอร์ใกล้เต็ม',
            `เหลือ ${Math.round(freeHdd / 1024)} KB จาก ${Math.round(totalHdd / 1024)} KB`,
            'ลบไฟล์เก่าในเมนู Files โดยเฉพาะไฟล์สำรองและ log ที่ไม่ใช้แล้ว');
    }

    // ---- CPU ----
    const cpu = num(r['cpu-load']);
    if (cpu >= T.cpuCritical) {
        add('critical', 'CPU ทำงานเต็มกำลัง', `โหลด ${cpu}%`,
            'เน็ตจะช้าและหน่วง — ตรวจว่ามีการโจมตี มีลูปในเครือข่าย หรือเปิด PCC/queue มากเกินกำลังรุ่นนี้');
    } else if (cpu >= T.cpuWarning) {
        add('warning', 'CPU ทำงานหนัก', `โหลด ${cpu}%`, 'เฝ้าดูว่าลดลงไหมหลังชั่วโมงเร่งด่วน');
    }

    // ---- อุณหภูมิ ----
    const temp = num((s.health || {}).temperature);
    if (temp >= T.tempCritical) {
        add('critical', 'อุณหภูมิสูงเกินไป', `${temp}°C`,
            'ตรวจการระบายอากาศและฝุ่นที่พัดลม อุณหภูมิสูงเรื้อรังทำให้อุปกรณ์พังเร็ว');
    } else if (temp >= T.tempWarning) {
        add('warning', 'อุณหภูมิค่อนข้างสูง', `${temp}°C`, 'ตรวจการระบายอากาศรอบตัวเครื่อง');
    }

    // ---- log ที่เราท์เตอร์บันทึกไว้ ----
    const logSummary = routerLog.summarize(s.logs);
    logSummary.groups
        .filter((g) => g.severity !== 'info' && g.title)
        .slice(0, T.maxLogGroups)
        .forEach((g) => {
            add(g.severity, g.title,
                `${g.meaning} · เกิด ${g.count} ครั้ง (ล่าสุด ${g.lastTime || '-'})`,
                g.action);
        });

    // ---- พอร์ตที่ลิงก์หลุด ----
    const downPorts = (s.ifaces || []).filter((i) =>
        String(i.disabled) !== 'true' &&
        String(i.running) === 'false' &&
        String(i.type || '').startsWith('ether'));
    if (downPorts.length) {
        add('warning', 'มีพอร์ตที่ไม่มีสัญญาณ', downPorts.map((i) => i.name).join(', '),
            'ปกติถ้าไม่ได้เสียบสายไว้ แต่ถ้าเป็นพอร์ตที่ควรมีอุปกรณ์ต่ออยู่ ให้ตรวจสายและปลายทาง');
    }

    // ---- DHCP ----
    const leases = s.leases || [];
    const bound = leases.filter((l) => String(l.status).toLowerCase() === 'bound').length;
    if (leases.length > 0 && bound === 0) {
        add('warning', 'ไม่มีเครื่องไหนได้รับ IP จาก DHCP เลย',
            `มี lease ${leases.length} รายการแต่ไม่มีตัวไหน bound`,
            'ตรวจว่า DHCP server ยังเปิดอยู่และ pool ยังมี IP เหลือ');
    }

    findings.sort((a, b) => RANK[a.severity] - RANK[b.severity]);

    return {
        router: {
            version: r.version || '',
            boardName: r['board-name'] || '',
            uptime: r.uptime || '',
            cpuLoad: cpu,
            freeMemoryMb: Math.round(freeMem / 1048576),
            totalMemoryMb: Math.round(totalMem / 1048576),
            temperature: temp || null
        },
        findings,
        counts: {
            critical: findings.filter((f) => f.severity === 'critical').length,
            warning: findings.filter((f) => f.severity === 'warning').length
        },
        logSummary: { total: logSummary.total, counts: logSummary.counts },
        healthy: findings.length === 0
    };
}

/**
 * ข้อความแจ้งเตือนสำหรับ Telegram
 *
 * ใส่เฉพาะเรื่องร้ายแรงกับวิธีแก้ ไม่ยัดทุกอย่างลงไป — ข้อความที่ยาวเกินจะไม่ถูกอ่าน
 * และเรื่อง "ควรดู" ไม่ควรปลุกใครตอนกลางคืน
 */
function formatAlert(siteName, report) {
    const crit = report.findings.filter((f) => f.severity === 'critical');
    if (!crit.length) return null;

    const lines = [
        `🔧 [เราท์เตอร์ต้องดูแล] สาขา: ${siteName}`,
        `${report.router.boardName || ''} ${report.router.version || ''}`.trim(),
        ''
    ];
    crit.forEach((f, i) => {
        lines.push(`${i + 1}. ${f.title}`);
        lines.push(`   ${f.detail}`);
        lines.push(`   ➜ ${f.action}`);
    });

    const warn = report.counts.warning;
    if (warn) lines.push('', `(มีอีก ${warn} เรื่องระดับ "ควรดู" — ดูได้ในหน้า Overview)`);
    return lines.join('\n');
}

module.exports = { analyzeHealth, formatAlert, THRESHOLDS: T };
