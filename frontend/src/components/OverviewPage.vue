<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { apiFetch, currentUser } from '../api.js';
import { formatUptime, formatMegabytes } from '../format.js';
import StatCard from './StatCard.vue';

const status = ref(null);
const hotspotOnline = ref(null);
const pppoeOnline = ref(null);
const error = ref('');
const lastUpdated = ref('');
let timer = null;

// endpoint สองตัวนี้จำกัดสิทธิ์ admin/co-admin — role 'user' จะได้ 403
// จึงไม่ยิงเลยเพื่อไม่ให้ขึ้น error โดยไม่จำเป็น (พฤติกรรมเดียวกับหน้าเดิม)
const canSeeLiveCounts = computed(() => {
    const role = currentUser.value?.role;
    return role === 'admin' || role === 'co-admin';
});

async function loadLiveCounts() {
    if (!canSeeLiveCounts.value) {
        hotspotOnline.value = null;
        pppoeOnline.value = null;
        return;
    }
    const [hs, pp] = await Promise.allSettled([
        apiFetch('/api/mikrotik/hotspot/active'),
        apiFetch('/api/mikrotik/pppoe/active')
    ]);
    hotspotOnline.value = hs.status === 'fulfilled' ? (hs.value?.length ?? 0) : null;
    pppoeOnline.value = pp.status === 'fulfilled' ? (pp.value?.length ?? 0) : null;
}

// เดิมหน้านี้ใช้ getElementById 30+ ครั้งใน fetchSystemStatus() เพื่อยัดค่าเข้า DOM ทีละช่อง
// ตอนนี้เหลือ ref เดียว แล้ว template ผูกค่าตามเอง — เพิ่มการ์ดใหม่ไม่ต้องแตะ JS เลย
async function load() {
    try {
        status.value = await apiFetch('/api/mikrotik/status');
        error.value = '';
        loadLiveCounts();
        lastUpdated.value = new Date().toLocaleTimeString('th-TH');
    } catch (err) {
        error.value = err.message;
        status.value = null;
    }
}

onMounted(() => {
    load();
    timer = setInterval(load, 10000);
});

// เดิม interval พวกนี้เป็นตัวแปร global (statsInterval, trafficInterval, ...) ที่ต้องจำเคลียร์เอง
// Vue เคลียร์ให้ตอน component ถูกถอดออก — timer รั่วไม่ได้อีก
onUnmounted(() => {
    if (timer) clearInterval(timer);
});

const connected = computed(() => !!status.value && !error.value);

const ram = computed(() => {
    if (!status.value) return '- / - MB';
    return `${formatMegabytes(status.value.freeMemory)} / ${formatMegabytes(status.value.totalMemory)} MB`;
});

const temperature = computed(() => {
    const s = status.value;
    if (!s) return '-';
    if (!s.temperature && !s.voltage) return 'ปกติ (ไม่มี sensor)';
    return `${s.temperature || ''} ${s.voltage ? '(' + s.voltage + ')' : ''}`.trim() || 'ปกติ';
});

const tempBadge = computed(() => {
    const t = parseFloat(status.value?.temperature);
    if (!Number.isFinite(t)) return { text: 'ปกติ', bg: '#dcfce7', color: '#15803d' };
    if (t >= 75) return { text: 'ร้อนสูง ⚠️', bg: '#fee2e2', color: '#dc2626' };
    if (t >= 60) return { text: 'อุ่น', bg: '#fef3c7', color: '#d97706' };
    return { text: 'ปกติ', bg: '#dcfce7', color: '#15803d' };
});

const hasUpdate = computed(() => {
    const s = status.value;
    return !!(s && s.hasUpdate && s.latestVersion && s.latestVersion !== s.currentVersion);
});

const firmwareNeedsUpgrade = computed(() => {
    const s = status.value;
    return !!(s && s.upgradeFirmware && s.upgradeFirmware !== 'N/A' && s.upgradeFirmware !== s.currentFirmware);
});

const emit = defineEmits(['open-upgrade']);
</script>

<template>
    <div class="overview-head">
        <div>
            <h1>ข้อมูลทั่วไป (Overview)</h1>
            <p>ภาพรวมสถานะเราท์เตอร์และทราฟฟิกอินเตอร์เฟส</p>
        </div>
        <div class="overview-status">
            <span class="status-dot" :class="connected ? 'status-online' : 'status-offline'"></span>
            {{ connected ? 'Connected' : 'Disconnected' }}
            <span v-if="lastUpdated" class="overview-timestamp">· อัปเดต {{ lastUpdated }}</span>
        </div>
    </div>

    <div v-if="error" class="overview-error">
        <i class="fa-solid fa-triangle-exclamation"></i> {{ error }}
    </div>

    <div class="stats-grid">
        <StatCard
            icon="fa-solid fa-microchip"
            icon-class="cpu"
            title="CPU Load"
            :value="status ? status.cpuLoad + ' %' : '- %'"
        />

        <StatCard
            icon="fa-solid fa-memory"
            icon-class="ram"
            title="RAM Memory"
            :value="ram"
        />

        <StatCard
            icon="fa-solid fa-temperature-half"
            :icon-style="{ background: '#ccfbf1', color: '#0f766e' }"
            title="อุณหภูมิ & Voltage"
            :value="temperature"
            card-title="อุณหภูมิและแรงดันไฟฟ้าอุปกรณ์เราท์เตอร์ (Hardware Temperature & Voltage)"
        >
            <template #badge>
                <span
                    class="temp-badge"
                    :style="{ background: tempBadge.bg, color: tempBadge.color }"
                >{{ tempBadge.text }}</span>
            </template>
        </StatCard>

        <StatCard
            icon="fa-solid fa-clock-rotate-left"
            icon-class="uptime"
            title="Uptime (เปิดทำงาน)"
            :value="formatUptime(status?.uptime)"
            :value-title="status?.uptime ? 'Uptime เต็ม: ' + status.uptime : ''"
            card-title="ระยะเวลาเปิดทำงานต่อเนื่องของเราท์เตอร์"
        />

        <StatCard
            icon="fa-solid fa-server"
            icon-class="model"
            title="Router Model"
            :value="status?.model || (error ? 'Cannot Connect' : '-')"
        />

        <StatCard
            icon="fa-solid fa-code-branch"
            :icon-style="{ background: '#e0f2fe', color: '#0284c7' }"
            title="RouterOS Version"
            :value="status?.version || '-'"
            clickable
            card-title="คลิกเพื่อเปิดระบบอัปเกรดเต็มรูปแบบอัตโนมัติ 1-Click (RouterOS + Firmware)"
            @click="emit('open-upgrade')"
        >
            <template #footer>
                <div v-if="status" class="ros-badge">
                    <template v-if="hasUpdate">
                        <span class="ros-badge-new">
                            <i class="fa-solid fa-circle-arrow-up"></i> มีเวอร์ชัน v{{ status.latestVersion }}
                        </span>
                        <button
                            type="button"
                            class="btn btn-sm btn-primary ros-upgrade-btn"
                            title="คลิกเพื่ออัปเกรด RouterOS + Firmware แบบ 1-Click"
                            @click.stop="emit('open-upgrade')"
                        >
                            <i class="fa-solid fa-wand-magic-sparkles"></i> 1-Click อัปเกรด
                        </button>
                    </template>
                    <span v-else class="ros-badge-ok">
                        <i class="fa-solid fa-circle-check"></i> เวอร์ชันล่าสุดแล้ว
                    </span>
                </div>
            </template>
        </StatCard>

        <StatCard
            icon="fa-solid fa-microchip"
            :icon-style="{ background: '#fef3c7', color: '#d97706' }"
            title="Firmware / Boot"
        >
            <template #value>
                {{ status?.currentFirmware || status?.version || '-' }}
                <span v-if="firmwareNeedsUpgrade" class="fw-upgrade">
                    (อัปเกรด: {{ status.upgradeFirmware }})
                </span>
            </template>
        </StatCard>

        <StatCard
            icon="fa-solid fa-users"
            icon-class="hotspot-online"
            title="ผู้ใช้ Hotspot ออนไลน์"
            :value="hotspotOnline === null ? '-' : hotspotOnline + ' คน'"
            clickable
            live
            card-title="จำนวนผู้ใช้ที่ล็อกอิน Hotspot อยู่ในขณะนี้"
        />

        <StatCard
            icon="fa-solid fa-door-closed"
            icon-class="model"
            title="ห้อง PPPoE ออนไลน์"
            :value="pppoeOnline === null ? '-' : pppoeOnline + ' ห้อง'"
            clickable
            live
            card-title="จำนวนห้องพักที่เชื่อมต่อ PPPoE อยู่ในขณะนี้"
        />
    </div>
</template>

<style scoped>
.overview-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 20px;
}

.overview-head h1 {
    margin: 0;
    font-size: 1.6rem;
    font-weight: 700;
    color: #1e293b;
}

.overview-head p {
    margin: 4px 0 0;
    font-size: 0.85rem;
    color: #64748b;
}

.overview-status {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.85rem;
    color: #475569;
    font-weight: 600;
}

.overview-timestamp {
    color: #94a3b8;
    font-weight: 400;
}

.overview-error {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #b91c1c;
    padding: 10px 14px;
    border-radius: 8px;
    font-size: 0.85rem;
    margin-bottom: 16px;
}

.temp-badge {
    font-size: 0.68rem;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 10px;
    white-space: nowrap;
}

.ros-badge {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    flex-wrap: wrap;
    margin-top: 6px;
    font-size: 0.75rem;
}

.ros-badge-new {
    color: #d97706;
    font-weight: 700;
}

.ros-badge-ok {
    color: #15803d;
    font-weight: 600;
}

.ros-upgrade-btn {
    padding: 4px 10px;
    font-size: 0.72rem;
    white-space: nowrap;
    height: auto;
    border-radius: 10px;
    font-weight: 700;
    background: linear-gradient(135deg, #2563eb, #1d4ed8);
    border: none;
    box-shadow: 0 2px 6px rgba(37, 99, 235, 0.3);
    color: #fff;
    cursor: pointer;
}

.fw-upgrade {
    color: #d97706;
    font-size: 0.75rem;
    font-weight: 700;
}
</style>
