<script setup>
import { visibleMenus, NOT_MIGRATED_YET } from '../menu.js';
import { currentRoute, navigate } from '../router.js';

defineProps({
    open: { type: Boolean, default: false }
});
const emit = defineEmits(['close']);

function go(menu) {
    // หน้าที่ยังไม่ได้ย้ายมา Vue ให้ส่งไปหน้าเดิมที่ / แทน
    // ผู้ใช้จะได้ทำงานต่อได้ทันที ไม่เจอหน้าว่าง ๆ ระหว่างช่วงย้ายระบบ
    if (NOT_MIGRATED_YET.has(menu.route)) {
        window.location.href = '/';
        return;
    }
    navigate(menu.route);
    emit('close');
}
</script>

<template>
    <div class="scrim" :class="{ show: open }" @click="emit('close')"></div>

    <aside class="sidebar" :class="{ open }">
        <div class="brand">
            <i class="fa-solid fa-diagram-project"></i>
            <div class="brand-text">
                <strong>MT Management</strong>
                <span class="tag">v2</span>
            </div>
        </div>

        <nav class="menu">
            <button
                v-for="m in visibleMenus"
                :key="m.key"
                type="button"
                class="item"
                :class="{ active: currentRoute === m.route, legacy: NOT_MIGRATED_YET.has(m.route) }"
                :title="NOT_MIGRATED_YET.has(m.route) ? 'หน้านี้ยังอยู่ในระบบเดิม — กดแล้วจะพาไปหน้าเดิม' : m.title"
                @click="go(m)"
            >
                <i :class="m.icon"></i>
                <span class="label">{{ m.title }}</span>
                <i v-if="NOT_MIGRATED_YET.has(m.route)" class="fa-solid fa-arrow-up-right-from-square ext"></i>
            </button>
        </nav>

        <a class="back-legacy" href="/v1/">
            <i class="fa-solid fa-rotate-left"></i> กลับไปหน้าเดิม
        </a>
    </aside>
</template>

<style scoped>
.sidebar {
    width: 258px;
    flex-shrink: 0;
    background: var(--v2-surface);
    border-right: 1px solid var(--v2-border);
    display: flex;
    flex-direction: column;
    padding: 16px 12px;
    gap: 18px;
    position: sticky;
    top: 0;
    height: 100vh;
}

.brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 8px 0;
    color: var(--v2-text);
}

.brand i {
    color: var(--v2-primary);
    font-size: 1.25rem;
}

.brand-text strong {
    font-weight: 700;
    letter-spacing: -0.01em;
    display: block;
    line-height: 1.2;
}

.tag {
    font-size: .64rem;
    font-weight: 700;
    background: #e8f1ff;
    color: #1d4ed8;
    padding: 1px 7px;
    border-radius: 999px;
}

.menu {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    overflow-y: auto;
}

.item {
    display: flex;
    align-items: center;
    gap: 11px;
    width: 100%;
    padding: 10px 12px;
    border: none;
    background: transparent;
    border-radius: 10px;
    font: inherit;
    font-size: .87rem;
    font-weight: 500;
    color: var(--v2-text-soft);
    cursor: pointer;
    text-align: left;
    transition: background .14s ease, color .14s ease;
}

.item i:first-child {
    width: 18px;
    text-align: center;
    font-size: .95rem;
    flex-shrink: 0;
}

.item .label {
    flex: 1;
    min-width: 0;
}

.item:hover {
    background: var(--v2-bg);
    color: var(--v2-text);
}

.item.active {
    background: var(--v2-primary-soft);
    color: var(--v2-primary);
    font-weight: 600;
}

.item:focus-visible {
    outline: 2px solid var(--v2-primary);
    outline-offset: -2px;
}

/* เมนูที่ยังชี้ไประบบเดิม ทำให้ดูจางลงและมีไอคอนลิงก์ออก
   จะได้รู้ทันทีว่ากดแล้วออกจากหน้าใหม่ */
.item.legacy .label {
    opacity: .68;
}

.ext {
    font-size: .62rem;
    opacity: .5;
}

.back-legacy {
    font-size: .78rem;
    color: var(--v2-text-muted);
    text-decoration: none;
    padding: 10px 12px;
    border-top: 1px solid var(--v2-border);
    display: flex;
    align-items: center;
    gap: 8px;
}

.back-legacy:hover {
    color: var(--v2-primary);
}

.scrim {
    display: none;
}

@media (max-width: 900px) {
    .sidebar {
        position: fixed;
        left: 0;
        top: 0;
        z-index: 60;
        transform: translateX(-100%);
        transition: transform .22s ease;
        box-shadow: 0 0 40px rgba(15, 23, 42, .18);
    }

    .sidebar.open {
        transform: translateX(0);
    }

    .scrim {
        display: block;
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, .45);
        opacity: 0;
        pointer-events: none;
        transition: opacity .22s ease;
        z-index: 55;
    }

    .scrim.show {
        opacity: 1;
        pointer-events: auto;
    }
}
</style>
