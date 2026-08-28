<script setup>
import { ref, computed, onMounted } from 'vue';
import { apiFetch, token, currentUser, activeSiteId, setActiveSiteId } from './api.js';
import OverviewPage from './components/OverviewPage.vue';
import FullUpgradeModal from './components/FullUpgradeModal.vue';

const sites = ref([]);
const upgradeOpen = ref(false);
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
</script>

<template>
    <div v-if="!loggedIn" class="v2-gate">
        <div class="v2-gate-card">
            <h2>ยังไม่ได้เข้าสู่ระบบ</h2>
            <p>
                หน้านี้เป็นเวอร์ชันนำร่อง (Vue) ใช้ session เดียวกับหน้าเดิม
                กรุณาเข้าสู่ระบบที่หน้าหลักก่อน แล้วกลับมาที่ <code>/v2/</code> อีกครั้ง
            </p>
            <a class="btn btn-primary" href="/">ไปหน้าเข้าสู่ระบบ</a>
        </div>
    </div>

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
                    class="form-control select-sm"
                    :value="activeSiteId"
                    @change="setActiveSiteId($event.target.value)"
                >
                    <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.name }}</option>
                </select>
                <span class="v2-user">
                    {{ currentUser?.displayName || currentUser?.username }}
                    <em>{{ currentUser?.role }}</em>
                </span>
                <a class="btn btn-secondary btn-sm" href="/">กลับหน้าเดิม</a>
            </div>
        </header>

        <main class="v2-main">
            <div v-if="loadError" class="v2-load-error">{{ loadError }}</div>
            <OverviewPage @open-upgrade="upgradeOpen = true" />
        </main>

        <FullUpgradeModal :open="upgradeOpen" @close="upgradeOpen = false" />
    </div>
</template>

<style scoped>
.v2-gate {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
}

.v2-gate-card {
    background: #fff;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    padding: 32px;
    max-width: 460px;
    text-align: center;
    box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
}

.v2-gate-card h2 {
    margin: 0 0 10px;
    font-size: 1.2rem;
    color: #1e293b;
}

.v2-gate-card p {
    color: #64748b;
    font-size: 0.9rem;
    line-height: 1.6;
    margin: 0 0 20px;
}

.v2-shell {
    min-height: 100vh;
    background: #f1f5f9;
}

.v2-topbar {
    background: #fff;
    border-bottom: 1px solid #e2e8f0;
    padding: 12px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
}

.v2-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #1e293b;
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
    font-size: 0.85rem;
    color: #475569;
    font-weight: 600;
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
