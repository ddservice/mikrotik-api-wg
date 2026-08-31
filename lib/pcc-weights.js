/**
 * lib/pcc-weights.js — คำนวณสัดส่วนแบ่งโหลด PCC จาก bandwidth จริงของแต่ละ line
 *
 * PCC กระจาย connection ตามอัตราส่วนจำนวนเต็ม เช่น 2:1 แปลว่าทุก 3 connection
 * จะไป line แรก 2 และ line ที่สอง 1 — ถ้าใส่อัตราส่วนไม่ตรงกับความเร็วจริง
 * line ที่ช้ากว่าจะรับงานเกินตัวและกลายเป็นคอขวดของทั้งสาขา
 *
 * ตรรกะนี้เคยอยู่ใน public/app.js ที่เดียว (autoCalculatePccWeights) จึงเทสต์ไม่ได้
 * และ v2 เรียกใช้ไม่ได้ ย้ายมาที่นี่ตามกฎของโปรเจกต์ที่ว่าตรรกะบริสุทธิ์ต้องอยู่ lib/
 */

'use strict';

/** ตัวหารร่วมมาก ใช้ย่ออัตราส่วนให้เล็กที่สุด */
function gcd(a, b) {
    a = Math.abs(Math.round(a));
    b = Math.abs(Math.round(b));
    while (b) { [a, b] = [b, a % b]; }
    return a;
}

/**
 * เพดานของผลรวม weight
 *
 * PCC สร้าง mangle rule หนึ่งข้อต่อหนึ่งหน่วยของอัตราส่วน อัตราส่วนอย่าง
 * 997:31 จึงกลายเป็นกฎเป็นพันข้อ ซึ่งกินซีพียูทุกแพ็กเก็ตและอ่านไม่ออกเวลาแก้ปัญหา
 * ถ้าเกินเพดานจะย่อลงมาแบบรักษาสัดส่วนไว้ให้ใกล้เคียงที่สุด
 */
const MAX_TOTAL_WEIGHT = 32;

/**
 * แปลง bandwidth เป็น weight จำนวนเต็มที่ย่อแล้ว
 *
 * @param {number[]} speeds Mbps ของแต่ละ line เรียงตามลำดับ line
 * @returns {number[]|null} weight ของแต่ละ line, null ถ้าคำนวณไม่ได้
 */
function pccWeights(speeds) {
    const list = (Array.isArray(speeds) ? speeds : []).map((s) => Number(s) || 0);
    if (list.length < 2 || list.some((s) => s <= 0)) return null;

    let g = list[0];
    for (let i = 1; i < list.length; i++) g = gcd(g, list[i]);
    if (g <= 0) return null;

    const base = list.map((s) => Math.max(1, Math.round(s / g)));
    if (base.reduce((a, b) => a + b, 0) <= MAX_TOTAL_WEIGHT) return base;

    // เกินเพดาน — หารทุกตัวด้วยตัวเลขเดียวกันจนผลรวมพอดี
    //
    // ต้องหารด้วยตัวเดียวกันทั้งหมด ไม่ใช่ไล่ตัดตัวที่ใหญ่ที่สุดทีละหนึ่ง
    // วิธีไล่ตัดทำให้ line ที่เร็วเท่ากันได้ weight ไม่เท่ากัน (500/500/50
    // เคยออกมาเป็น 9:10:1 ทั้งที่สองตัวแรกเท่ากันเป๊ะ) การหารร่วมรักษา
    // ความเท่ากันไว้เสมอเพราะเลขที่เท่ากันหารด้วยตัวเดียวกันย่อมได้เท่ากัน
    for (let d = 2; d <= 10000; d++) {
        const w = base.map((x) => Math.max(1, Math.round(x / d)));
        if (w.reduce((a, b) => a + b, 0) <= MAX_TOTAL_WEIGHT) return w;
    }
    return base.map(() => 1);   // ไปไม่ถึงตรงนี้ในทางปฏิบัติ แต่ต้องไม่คืนค่าพัง
}

/** อธิบายอัตราส่วนให้คนอ่าน เช่น "2:1 — ทุก 3 connection ไป WAN1 2, WAN2 1" */
function describeWeights(names, weights) {
    if (!Array.isArray(weights) || weights.length === 0) return '';
    const total = weights.reduce((a, b) => a + b, 0);
    const ratio = weights.join(':');
    const parts = names.map((n, i) => `${n} ${weights[i]}`).join(', ');
    return `${ratio} — ทุก ${total} connection จะไป ${parts}`;
}

module.exports = { gcd, pccWeights, describeWeights, MAX_TOTAL_WEIGHT };
