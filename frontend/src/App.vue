<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { apiFetch, token, currentUser, activeSiteId, setActiveSiteId, logout } from './api.js';
import { loadMenusForRole, canOpen, NOT_MIGRATED_YET } from './menu.js';
import { currentRoute, navigate, DEFAULT_ROUTE } from './router.js';
import LoginPage from './components/LoginPage.vue';
import AppSidebar from './components/AppSidebar.vue';
import OverviewPage from './components/OverviewPage.vue';
import HotspotPage from './components/HotspotPage.vue';
import PppoePage from './components/PppoePage.vue';
import FullUpgradeModal from './components/FullUpgradeModal.vue';

const sites = ref([]);
const upgradeOpen = ref(false);
const upgradeMode = ref('full');
const overviewRef = ref(null);
const loadError = ref('');
const sidebarOpen = ref(false);

const loggedIn = computed(() => !!token.value && !!currentUser.value);

// กันเปิดหน้าที่ role นี้ไม่มีสิทธิ์ หรือหน้าที่ยังไม่ได้ย้ายมา
// (การซ่อนเมนูเป็นแค่คำใบ้ทาง UI — API ยังบังคับสิทธิ์ของมันเองอยู่แล้ว)
const resolvedRoute = computed(() => {
    const r = currentRoute.value;
    if (NOT_MIGRATED_YET.has(r) || !canOpen(r)) return DEFAULT_ROUTE;
    return r;
});

async function loadSites() {
    try {
        const data = await apiFetch('/api/sites');
        sites.value = data.sites || [];
        if (!activeSiteId.value && data.activeSiteId) setActiveSiteId(data.activeSiteId);
    } catch (err) {
        loadError.value = err.message;
    }
}

async function bootstrap() {
    loadError.value = '';
    await Promise.all([
        loadSites(),
        loadMenusForRole(currentUser.value?.role || 'user')
    ]);
}

onMounted(() => {
    if (loggedIn.value) bootstrap();
});

watch(resolvedRoute, () => { sidebarOpen.value = false; });

async function onLoggedIn() {
    await bootstrap();
    navigate(DEFAULT_ROUTE);
}

function openUpgrade(mode) {
    upgradeMode.value = mode;
    upgradeOpen.value = true;
}

async function doLogout() {
    try {
        await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch (_) {
        // token หมดอายุฝั่ง server อยู่แล้วก็ไม่เป็นไร — เคลียร์ฝั่ง client ต่อได้เลย
    }
    logout();
    sites.value = [];
}

const activeSiteName = computed(() => {
    const s = sites.value.find((x) => x.id === activeSiteId.value);
    return s ? s.name : '';
});
</script>

<template>
    <LoginPage v-if="!loggedIn" @logged-in="onLoggedIn" />

    <div v-else class="shell">
        <AppSidebar :open="sidebarOpen" @close="sidebarOpen = false" />

        <div class="main">
            <header class="topbar">
                <button type="button" class="burger" title="เมนู" @click="sidebarOpen = !sidebarOpen">
                    <i class="fa-solid fa-bars"></i>
                </button>

                <div class="site-picker">
                    <i class="fa-solid fa-location-dot"></i>
                    <select
                        :value="activeSiteId"
                        :title="activeSiteName"
                        @change="setActiveSiteId($event.target.value)"
                    >
                        <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.name }}</option>
                    </select>
                </div>

                <div class="spacer"></div>

                <span class="user">
                    {{ currentUser?.displayName || currentUser?.username }}
                    <em>{{ currentUser?.role }}</em>
                </span>
                <a class="ghost" href="/" title="เปิดหน้าเดิมที่มีครบทุกฟีเจอร์">หน้าเดิม</a>
                <button type="button" class="ghost icon" title="ออกจากระบบ" @click="doLogout">
                    <i class="fa-solid fa-power-off"></i>
                </button>
            </header>

            <main class="content">
                <div v-if="loadError" class="load-error">{{ loadError }}</div>

                <OverviewPage
                    v-if="resolvedRoute === 'overview'"
                    ref="overviewRef"
                    @open-upgrade="openUpgrade('full')"
                    @open-firmware-upgrade="openUpgrade('firmware')"
                />
                <HotspotPage v-else-if="resolvedRoute === 'hotspot'" />
                <PppoePage v-else-if="resolvedRoute === 'pppoe'" />
            </main>
        </div>

        <FullUpgradeModal
            :open="upgradeOpen"
            :mode="upgradeMode"
            @close="upgradeOpen = false"
            @done="overviewRef?.reload()"
        />
    </div>
</template>

<style scoped>
.shell {
    min-height: 100vh;
    background: var(--v2-bg);
    display: flex;
    align-items: flex-start;
}

.main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
}

.topbar {
    background: var(--v2-surface);
    border-bottom: 1px solid var(--v2-border);
    padding: 11px 22px;
    display: flex;
    align-items: center;
    gap: 12px;
    position: sticky;
    top: 0;
    z-index: 20;
}

.burger {
    display: none;
    font: inherit;
    font-size: 1rem;
    background: var(--v2-bg);
    border: 1px solid var(--v2-border);
    color: var(--v2-text-soft);
    border-radius: 9px;
    padding: 7px 11px;
    cursor: pointer;
}

.site-picker {
    display: flex;
    align-items: center;
    gap: 7px;
    background: var(--v2-bg);
    border: 1px solid var(--v2-border);
    border-radius: 9px;
    padding: 0 11px;
    max-width: 260px;
}

.site-picker i {
    color: var(--v2-text-muted);
    font-size: .78rem;
    flex-shrink: 0;
}

.site-picker select {
    font: inherit;
    font-size: .84rem;
    font-weight: 500;
    color: var(--v2-text);
    background: transparent;
    border: none;
    padding: 8px 4px 8px 0;
    cursor: pointer;
    max-width: 210px;
}

.site-picker select:focus-visible { outline: none; }
.site-picker:focus-within { border-color: var(--v2-primary); }

.spacer { flex: 1; }

.user {
    font-size: .82rem;
    color: var(--v2-text-soft);
    font-weight: 600;
    white-space: nowrap;
}

.user em {
    font-style: normal;
    font-size: .68rem;
    background: #ede9fe;
    color: #6d28d9;
    padding: 2px 7px;
    border-radius: 8px;
    margin-left: 6px;
    font-weight: 700;
}

.ghost {
    font: inherit;
    font-size: .8rem;
    font-weight: 600;
    color: var(--v2-text-soft);
    background: var(--v2-bg);
    border: 1px solid var(--v2-border);
    border-radius: 9px;
    padding: 7px 13px;
    cursor: pointer;
    text-decoration: none;
    line-height: 1.4;
    white-space: nowrap;
}

.ghost:hover { background: #eef2f7; color: var(--v2-text); }
.ghost.icon { padding: 7px 11px; }

.content {
    padding: 24px;
    max-width: 1360px;
    width: 100%;
    margin: 0 auto;
}

.load-error {
    background: var(--v2-danger-soft);
    border: 1px solid #fecaca;
    color: var(--v2-danger);
    padding: 10px 14px;
    border-radius: 9px;
    font-size: .85rem;
    margin-bottom: 16px;
}

@media (max-width: 900px) {
    .burger { display: inline-flex; }
    .content { padding: 18px 14px; }
    .topbar { padding: 10px 14px; }
    .user { display: none; }
}
</style>
