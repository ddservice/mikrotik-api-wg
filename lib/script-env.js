/**
 * lib/script-env.js — โหลดคีย์ Supabase/R2 จาก ecosystem.config.js ให้สคริปต์ใน scripts/
 *
 * ทำไมต้องมี: สคริปต์ 7 ตัวใน scripts/ ต่างเขียนตรรกะเดียวกันนี้เองคนละแบบ
 * ในชื่อ loadEnv / loadPm2Env / loadPm2EnvFallback ซึ่งต่างกันในรายละเอียดเล็ก ๆ
 * เช่น บางตัวเช็ค placeholder YOUR_PROJECT_ID บางตัวไม่เช็ค
 *
 * ผลของการไม่เช็ค placeholder เคยทำให้ production ตกไปใช้ Local JSON เงียบ ๆ
 * นานหลายสัปดาห์ (2026-08-28) จึงควรมีที่มาเดียวที่เช็คถูกต้องเสมอ
 *
 * ค่าใน env ที่ตั้งมาแล้วจะไม่ถูกทับ — สั่งรันด้วย env ของตัวเองได้ตามปกติ
 */

'use strict';

const path = require('path');

const PLACEHOLDER = /YOUR_PROJECT_ID|YOUR_SERVICE_ROLE_KEY|YOUR_/;

/**
 * @param {object} [opts]
 * @param {RegExp} [opts.match] คีย์ที่จะโหลด (ค่าเริ่มต้น: SUPABASE_* และ R2_*)
 * @returns {boolean} โหลดจากไฟล์จริงหรือไม่
 */
function loadScriptEnv(opts = {}) {
    const match = opts.match || /^SUPABASE_|^R2_/;

    // ตั้งมาเองแล้วและไม่ใช่ค่า placeholder ก็ไม่ต้องไปอ่านไฟล์
    if (process.env.SUPABASE_URL && !PLACEHOLDER.test(process.env.SUPABASE_URL)) return false;

    try {
        const eco = require(path.join(__dirname, '..', 'ecosystem.config.js'));
        const env = (eco.apps && eco.apps[0] && eco.apps[0].env) || {};
        let loaded = 0;
        Object.keys(env).forEach((k) => {
            if (!match.test(k)) return;
            if (PLACEHOLDER.test(String(env[k]))) return;   // ข้ามค่า placeholder เสมอ
            process.env[k] = env[k];
            loaded++;
        });
        return loaded > 0;
    } catch (_) {
        return false;   // ไม่มีไฟล์ = รันในโหมด Local JSON ซึ่งเป็นเรื่องปกติบนเครื่อง dev
    }
}

/** true ถ้าตอนนี้ตั้งค่าให้ใช้ Supabase จริง (ไม่ใช่ placeholder) */
function usingSupabase() {
    return !!(process.env.SUPABASE_URL && !PLACEHOLDER.test(process.env.SUPABASE_URL));
}

module.exports = { loadScriptEnv, usingSupabase, PLACEHOLDER };
