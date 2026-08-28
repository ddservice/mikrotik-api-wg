<script setup>
import { ref, computed, onMounted } from 'vue';
import { apiFetch, token, currentUser, activeSiteId, setActiveSiteId, logout } from './api.js';
import LoginPage from './components/LoginPage.vue';
import OverviewPage from './components/OverviewPage.vue';
import FullUpgradeModal from './components/FullUpgradeModal.vue';

const sites = ref([]);
const upgradeOpen = ref(false);
const upgradeMode = ref('full');
const overviewRef = ref(null);
const loadError = ref('');

const loggedIn = computed(() => !!token.value && !!currentUser.value);

async function loadSites() {
    try {
        const data = await apiFetch('/api/sites');
        sites.value = data.sites || [];
        if (!activeSiteId.value && data.activeSiteId) setActiveSiteId(data.activeSiteId);
    } catch (err) {
        loadError.value = err.message;
    }
}

onMounted(() => {
    if (loggedIn.value) loadSites();
});

async function onLoggedIn() {
    loadError.value = '';
    await loadSites();
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
</script>

<template>
    <LoginPage v-if="!loggedIn" @logged-in="onLoggedIn" />

    <div v-else class="v2-shell">
        <header class="v2-topbar">
            <div class="v2-brand">
                <i class="fa-solid fa-diagram-project"></i>
                <div>
                    <strong>MT Management</strong>
                    <span class="v2-pilot-tag">Vue pilot</span>
                </div>
            </div>
            <div class="v2-topbar-right">
                <select
                    class="v2-site-select"
                    :value="activeSiteId"
                    @change="setActiveSiteId($event.target.value)"
                >
                    <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.name }}</option>
                </select>
                <span class="v2-user">
                    {{ currentUser?.displayName || currentUser?.username }}
                    <em>{{ currentUser?.role }}</em>
                </span>
                <a class="v2-ghost-btn" href="/">หน้าเดิม</a>
                <button type="button" class="v2-ghost-btn is-icon" title="ออกจากระบบ" @click="doLogout">
                    <i class="fa-solid fa-power-off"></i>
                </button>
            </div>
        </header>

        <main class="v2-main">
            <div v-if="loadError" class="v2-load-error">{{ loadError }}</div>
            <OverviewPage
                ref="overviewRef"
                @open-upgrade="openUpgrade('full')"
                @open-firmware-upgrade="openUpgrade('firmware')"
            />
        </main>

        <FullUpgradeModal
            :open="upgradeOpen"
            :mode="upgradeMode"
            @close="upgradeOpen = false"
            @done="overviewRef?.reload()"
        />
    </div>
</template>

<style scoped>
.v2-shell {
    min-height: 100vh;
    background: var(--v2-bg);
}

.v2-topbar {
    background: var(--v2-surface);
    border-bottom: 1px solid var(--v2-border);
    padding: 11px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    flex-wrap: wrap;
    position: sticky;
    top: 0;
    z-index: 20;
}

.v2-site-select {
    font: inherit;
    font-size: .84rem;
    font-weight: 500;
    color: var(--v2-text);
    background: var(--v2-bg);
    border: 1px solid var(--v2-border);
    border-radius: 9px;
    padding: 7px 30px 7px 12px;
    max-width: 230px;
    cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%237c8ba1' stroke-width='3'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
}

.v2-site-select:focus-visible {
    outline: 2px solid var(--v2-primary);
    outline-offset: 1px;
}

.v2-ghost-btn {
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
    transition: background .15s ease, color .15s ease;
}

.v2-ghost-btn:hover {
    background: #eef2f7;
    color: var(--v2-text);
}

.v2-ghost-btn.is-icon {
    padding: 7px 11px;
}

.v2-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--v2-text);
    font-weight: 600;
    letter-spacing: -0.01em;
}

.v2-brand i {
    color: #2563eb;
    font-size: 1.2rem;
}

.v2-pilot-tag {
    display: inline-block;
    margin-left: 8px;
    font-size: 0.68rem;
    font-weight: 700;
    background: #e0f2fe;
    color: #0369a1;
    padding: 2px 8px;
    border-radius: 10px;
    vertical-align: middle;
}

.v2-topbar-right {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
}

.v2-user {
    font-size: 0.82rem;
    color: var(--v2-text-soft);
    font-weight: 600;
    white-space: nowrap;
}

.v2-user em {
    font-style: normal;
    font-size: 0.7rem;
    background: #ede9fe;
    color: #6d28d9;
    padding: 2px 7px;
    border-radius: 8px;
    margin-left: 6px;
    font-weight: 700;
}

.v2-main {
    padding: 24px;
    max-width: 1440px;
    margin: 0 auto;
}

.v2-load-error {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #b91c1c;
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 0.85rem;
    margin-bottom: 16px;
}
</style>
