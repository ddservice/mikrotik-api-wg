// API client — ยึดสัญญาเดิมของ apiFetch() ใน public/app.js ทุกอย่าง
// (Bearer token จาก localStorage, header X-Site-Id, ข้อความ error ภาษาไทย)
// เพื่อให้หน้าเก่ากับหน้าใหม่ล็อกอินร่วม session เดียวกันได้ระหว่างช่วงย้ายระบบ

import { ref } from 'vue';

const TOKEN_KEY = 'token';
const USER_KEY = 'user';
const SITE_KEY = 'activeSiteId';

function readJson(key) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
    } catch (_) {
        return null;
    }
}

// state ที่ใช้ร่วมกันทั้งแอป — component ไหน import ก็เห็นค่าเดียวกันและอัปเดตตามกันเอง
export const token = ref(localStorage.getItem(TOKEN_KEY) || '');
export const currentUser = ref(readJson(USER_KEY));
export const activeSiteId = ref(localStorage.getItem(SITE_KEY) || '');

export function setSession(newToken, user) {
    token.value = newToken || '';
    currentUser.value = user || null;
    if (newToken) localStorage.setItem(TOKEN_KEY, newToken);
    else localStorage.removeItem(TOKEN_KEY);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(USER_KEY);
}

export function setActiveSiteId(siteId) {
    activeSiteId.value = siteId || '';
    if (siteId) localStorage.setItem(SITE_KEY, siteId);
    else localStorage.removeItem(SITE_KEY);
}

export function logout() {
    setSession('', null);
    sites.value = [];
    sitesLoadedAt.value = 0;
}

// ---------- รายชื่อสาขา (state กลาง) ----------
//
// เดิมมี 5 จุดต่างคนต่างยิง /api/sites แล้วเก็บสำเนาของตัวเอง (App, Settings, Logs,
// Admins, Voucher) พอเพิ่มสาขาใหม่ในหน้าตั้งค่า มีแค่สำเนาของหน้านั้นที่อัปเดต
// dropdown ด้านบนยังถือของเก่าอยู่ ต้องรีเฟรชทั้งหน้าถึงจะเห็นสาขาใหม่
//
// ย้ายมาไว้ที่เดียว ใครแก้ข้อมูลสาขาก็เรียก loadSites({ force: true }) แล้วทุกหน้า
// ที่ import ตัวนี้เห็นพร้อมกันทันที
export const sites = ref([]);
export const sitesLoadedAt = ref(0);

const SITES_TTL_MS = 15000;
let sitesInFlight = null;

export async function loadSites({ force = false } = {}) {
    // หลายหน้าเรียกพร้อมกันตอนเปิดแอป — ให้ใช้คำขอเดียวกัน ไม่ยิงซ้ำ
    if (sitesInFlight) return sitesInFlight;
    if (!force && sites.value.length && Date.now() - sitesLoadedAt.value < SITES_TTL_MS) {
        return sites.value;
    }

    sitesInFlight = (async () => {
        try {
            const data = await apiFetch('/api/sites');
            sites.value = data.sites || [];
            sitesLoadedAt.value = Date.now();
            // ยังไม่เคยเลือกสาขา -> ใช้ค่าที่ server บอกว่ากำลังใช้อยู่
            if (!activeSiteId.value && data.activeSiteId) setActiveSiteId(data.activeSiteId);
            return sites.value;
        } finally {
            sitesInFlight = null;
        }
    })();
    return sitesInFlight;
}

/** ชื่อสาขาที่กำลังเลือกอยู่ — ใช้บ่อยจนควรมีที่เดียว */
export function activeSiteName() {
    const s = sites.value.find((x) => x.id === activeSiteId.value);
    return s ? s.name : '';
}

// ---------- หมายเลข IP ในอุโมงค์ WireGuard ----------
//
// วง 10.10.88.0/24 โดย .1 เป็นของ VPS เสมอ สาขาเริ่มที่ .2
// ต้องมีที่เดียวที่ตัดสินว่า "ตัวไหนว่าง" — ถ้าหน้าเพิ่มสาขากับหน้าสร้างสคริปต์
// คำนวณกันคนละที่ แล้วเสนอเลขต่างกัน จะได้สาขาที่ IP ไม่ตรงกับสคริปต์ที่รันไป
// ซึ่งเป็นความผิดพลาดที่หาสาเหตุยากมากเพราะทุกอย่างดู "ถูก" หมด
export const WG_SUBNET_PREFIX = '10.10.88.';

/** IP ที่ถูกใช้ไปแล้ว รวมทั้งช่อง host ด้วย เพราะสาขา WireGuard ใช้ IP เดียวกันทั้งสองช่อง */
export function usedWireguardIps(excludeSiteId = null) {
    const used = new Set([WG_SUBNET_PREFIX + '1']);   // .1 = VPS ห้ามแจก
    sites.value.forEach((s) => {
        if (excludeSiteId && s.id === excludeSiteId) return;
        [s.wireguardIp, s.host].forEach((v) => {
            if (v && String(v).startsWith(WG_SUBNET_PREFIX)) used.add(String(v).trim());
        });
    });
    return used;
}

/** หมายเลขว่างตัวถัดไป — คืน '' ถ้าเต็มวง (ซึ่งแปลว่ามีสาขาเกิน 250 แห่ง) */
export function nextFreeWireguardIp(excludeSiteId = null) {
    const used = usedWireguardIps(excludeSiteId);
    for (let i = 2; i < 255; i++) {
        const ip = WG_SUBNET_PREFIX + i;
        if (!used.has(ip)) return ip;
    }
    return '';
}

/** สาขาที่ถือ IP นี้อยู่ (ไว้เตือนตอนกรอกซ้ำ) — null ถ้าว่าง */
export function siteHoldingWireguardIp(ip, excludeSiteId = null) {
    const target = String(ip || '').trim();
    if (!target) return null;
    return sites.value.find((s) =>
        s.id !== excludeSiteId &&
        (String(s.wireguardIp || '').trim() === target || String(s.host || '').trim() === target)
    ) || null;
}

export async function apiFetch(endpoint, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };

    if (token.value) headers['Authorization'] = `Bearer ${token.value}`;

    // ส่ง X-Site-Id เสมอเมื่อมีไซต์ที่เลือกอยู่ — executeOnRouter ฝั่ง server
    // อ่านค่านี้เพื่อยิงไปเราท์เตอร์ของสาขาที่ถูกต้อง (ดู CLAUDE.md 2026-08-26 (4))
    if (activeSiteId.value && !headers['X-Site-Id'] && !headers['x-site-id']) {
        headers['X-Site-Id'] = activeSiteId.value;
    }

    let response;
    try {
        response = await fetch(endpoint, { ...options, headers });
    } catch (_) {
        throw new Error('ไม่สามารถเชื่อมต่อ Server ได้ กรุณาตรวจสอบว่า Node.js (node server.js) กำลังทำงานอยู่');
    }

    if (response.status === 401) {
        logout();
        throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    }

    const text = await response.text().catch(() => '');
    let data = {};
    if (text) {
        try {
            data = JSON.parse(text);
        } catch (_) {
            data = { error: text };
        }
    }

    if (!response.ok) {
        const err = new Error(data.error || `เกิดข้อผิดพลาด (${response.status})`);
        err.status = response.status;
        throw err;
    }

    return data;
}
