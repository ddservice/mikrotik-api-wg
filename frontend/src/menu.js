// นิยามเมนูและสิทธิ์การมองเห็น — สะท้อน ALL_CONFIGURABLE_MENUS และ
// DEFAULT_MENU_PERMISSIONS_FALLBACK ใน public/app.js แบบตรงตัว เพื่อให้หน้าเก่ากับ
// หน้าใหม่แสดงเมนูเหมือนกันเป๊ะระหว่างช่วงย้ายระบบ
//
// ย้ำจาก CLAUDE.md: การซ่อนเมนูเป็นแค่ "คำใบ้ทาง UI" เท่านั้น
// ตัว API ฝั่ง server บังคับสิทธิ์ด้วย requireAuth([...]) ของมันเองอยู่แล้ว
// ห้ามคิดว่าเมนูที่ซ่อน = route ที่ล็อกแล้ว

import { ref } from 'vue';
import { apiFetch } from './api.js';

// เมนูที่ผู้ดูแลเปิด/ปิดให้แต่ละ role ได้ผ่านหน้าตั้งค่า
export const CONFIGURABLE_MENUS = [
    { key: 'hotspot', route: 'hotspot', title: 'จัดการระบบ Hotspot', icon: 'fa-solid fa-wifi' },
    { key: 'pppoe', route: 'pppoe', title: 'จัดการระบบ PPPoE', icon: 'fa-solid fa-door-open' },
    { key: 'multiwan', route: 'multiwan', title: 'จัดการ Multi-WAN & Failover', icon: 'fa-solid fa-network-wired' },
    { key: 'firewall', route: 'firewall', title: 'จัดการบล็อกเว็บ (Firewall)', icon: 'fa-solid fa-fire-burner' },
    { key: 'logs', route: 'logs', title: 'ประวัติการใช้งาน (Log)', icon: 'fa-solid fa-file-lines' }
];

// เมนูที่เห็นได้เฉพาะ admin ปรับผ่านหน้าตั้งค่าไม่ได้
export const ADMIN_ONLY_MENUS = [
    { key: 'admins', route: 'admins', title: 'ผู้ใช้งานระบบ Dashboard', icon: 'fa-solid fa-users-gear' },
    { key: 'settings', route: 'settings', title: 'จัดการระบบเราท์เตอร์ & แจ้งเตือน', icon: 'fa-solid fa-gears' }
];

export const OVERVIEW_MENU = {
    key: 'overview',
    route: 'overview',
    title: 'ข้อมูลทั่วไป (Overview)',
    icon: 'fa-solid fa-chart-line'
};

const FALLBACK_PERMISSIONS = {
    'co-admin': ['hotspot', 'pppoe', 'multiwan', 'firewall', 'logs'],
    user: ['hotspot', 'firewall']
};

// หน้าที่ยังไม่ได้ย้ายมา Vue — กดแล้วเด้งไปหน้าเดิมแทนที่จะโชว์หน้าว่าง
// ลบ key ออกจากชุดนี้เมื่อย้ายหน้านั้นเสร็จ
export const NOT_MIGRATED_YET = new Set(['multiwan', 'firewall', 'logs', 'admins', 'settings']);

export const visibleMenus = ref([OVERVIEW_MENU]);

export async function loadMenusForRole(role) {
    if (role === 'admin') {
        visibleMenus.value = [OVERVIEW_MENU, ...CONFIGURABLE_MENUS, ...ADMIN_ONLY_MENUS];
        return;
    }

    let allowed;
    try {
        const perms = await apiFetch('/api/settings/menu-permissions');
        allowed = perms[role] || [];
    } catch (_) {
        allowed = FALLBACK_PERMISSIONS[role] || [];
    }

    visibleMenus.value = [
        OVERVIEW_MENU,
        ...CONFIGURABLE_MENUS.filter((m) => allowed.includes(m.key))
    ];
}

export function canOpen(routeKey) {
    return visibleMenus.value.some((m) => m.route === routeKey);
}
