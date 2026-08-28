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
