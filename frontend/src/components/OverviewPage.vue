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

defineExpose({ reload: load });

const connected = computed(() => !!status.value && !error.value);

const cpu = computed(() => {
    const v = status.value?.cpuLoad;
    if (v === undefined || v === null || v === '') return '-';
    // RouterOS ส่งมาเป็น '0' บ้าง '0%' บ้าง — กัน '0% %' แบบที่หน้าเดิมเคยขึ้น
    return String(v).trim().endsWith('%') ? String(v).trim() : `${v}%`;
});

const ram = computed(() => {
    if (!status.value) return '-';
    return `${formatMegabytes(status.value.freeMemory)} / ${formatMegabytes(status.value.totalMemory)} MB`;
});

const hasSensor = computed(() => !!(status.value?.temperature || status.value?.voltage));

const temperature = computed(() => {
    const s = status.value;
    if (!s) return '-';
    if (!hasSensor.value) return 'ไม่มีเซ็นเซอร์';
    return `${s.temperature || ''}${s.voltage ? ' · ' + s.voltage : ''}`.trim();
});

const tempBadge = computed(() => {
    if (!hasSensor.value) return null;
    const t = parseFloat(status.value?.temperature);
    if (!Number.isFinite(t)) return { text: 'ปกติ', tone: 'ok' };
    if (t >= 75) return { text: 'ร้อนสูง', tone: 'bad' };
    if (t >= 60) return { text: 'อุ่น', tone: 'warn' };
    return { text: 'ปกติ', tone: 'ok' };
});

const hasRosUpdate = computed(() => {
    const s = status.value;
    return !!(s && s.hasUpdate && s.latestVersion && s.latestVersion !== s.currentVersion);
});

const firmwareNeedsUpgrade = computed(() => {
    const s = status.value;
    return !!(s && s.upgradeFirmware && s.upgradeFirmware !== 'N/A' && s.upgradeFirmware !== s.currentFirmware);
});

const emit = defineEmits(['open-upgrade', 'open-firmware-upgrade']);
</script>

<template>
    <div class="head">
        <div class="head-text">
            <h1>ข้อมูลทั่วไป</h1>
            <p>ภาพรวมสถานะเราท์เตอร์ของสาขาที่เลือกอยู่</p>
        </div>
        <div class="head-status" :class="connected ? 'is-up' : 'is-down'">
            <span class="dot"></span>
            {{ connected ? 'เชื่อมต่ออยู่' : 'ขาดการเชื่อมต่อ' }}
            <span v-if="lastUpdated" class="stamp v2-num">· {{ lastUpdated }}</span>
        </div>
    </div>

    <div v-if="error" class="alert alert-danger">
        <i class="fa-solid fa-triangle-exclamation"></i> {{ error }}
    </div>

    <div class="grid">
        <StatCard icon="fa-solid fa-microchip" tone="blue" title="CPU Load" :value="cpu" />

        <StatCard icon="fa-solid fa-memory" tone="violet" title="RAM (ว่าง / ทั้งหมด)" :value="ram" />

        <StatCard
            icon="fa-solid fa-temperature-half"
            tone="teal"
            title="อุณหภูมิ & แรงดัน"
            :value="temperature"
            card-title="อุณหภูมิและแรงดันไฟฟ้าของบอร์ด"
        >
            <template #badge>
                <span v-if="tempBadge" class="pill" :class="'pill-' + tempBadge.tone">{{ tempBadge.text }}</span>
            </template>
        </StatCard>

        <StatCard
            icon="fa-solid fa-clock-rotate-left"
            tone="slate"
            title="Uptime"
            :value="formatUptime(status?.uptime)"
            :value-title="status?.uptime ? 'ค่าดิบจากเราท์เตอร์: ' + status.uptime : ''"
            card-title="ระยะเวลาเปิดทำงานต่อเนื่อง"
        />

        <StatCard
            icon="fa-solid fa-server"
            tone="amber"
            title="รุ่นเราท์เตอร์"
            :value="status?.model || (error ? 'เชื่อมต่อไม่ได้' : '-')"
        />

        <StatCard
            icon="fa-solid fa-code-branch"
            tone="blue"
            title="RouterOS"
            :value="status?.version || '-'"
        >
            <template #footer>
                <div v-if="status" class="foot-row">
                    <template v-if="hasRosUpdate">
                        <span class="pill pill-warn">
                            <i class="fa-solid fa-circle-arrow-up"></i> มี v{{ status.latestVersion }}
                        </span>
                        <button type="button" class="mini-btn" @click.stop="emit('open-upgrade')">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> อัปเกรด
                        </button>
                    </template>
                    <span v-else class="pill pill-ok">
                        <i class="fa-solid fa-circle-check"></i> ล่าสุดแล้ว
                    </span>
                </div>
            </template>
        </StatCard>

        <StatCard
            icon="fa-solid fa-hard-drive"
            tone="amber"
            title="Firmware (บอร์ด)"
            :value="status?.currentFirmware || status?.version || '-'"
        >
            <template #footer>
                <!--
                  เดิมปุ่มอัปเกรดมีเฉพาะตอน RouterOS มีเวอร์ชันใหม่ พอ ROS อัปครบแล้ว
                  เหลือแต่ Firmware ก็เลยไม่มีปุ่มให้กด ต้องแยกปุ่มของ Firmware ออกมาต่างหาก
                -->
                <div v-if="status" class="foot-row">
                    <template v-if="firmwareNeedsUpgrade">
                        <span class="pill pill-warn">
                            <i class="fa-solid fa-circle-arrow-up"></i> มี {{ status.upgradeFirmware }}
                        </span>
                        <button type="button" class="mini-btn" @click.stop="emit('open-firmware-upgrade')">
                            <i class="fa-solid fa-bolt"></i> อัปเกรด
                        </button>
                    </template>
                    <span v-else class="pill pill-ok">
                        <i class="fa-solid fa-circle-check"></i> ล่าสุดแล้ว
                    </span>
                </div>
            </template>
        </StatCard>

        <StatCard
            icon="fa-solid fa-users"
            tone="green"
            title="Hotspot ออนไลน์"
            :value="hotspotOnline === null ? '-' : hotspotOnline + ' คน'"
            live
            card-title="ผู้ใช้ที่ล็อกอิน Hotspot อยู่ในขณะนี้"
        />

        <StatCard
            icon="fa-solid fa-door-closed"
            tone="slate"
            title="ห้อง PPPoE ออนไลน์"
            :value="pppoeOnline === null ? '-' : pppoeOnline + ' ห้อง'"
            live
            card-title="ห้องพักที่เชื่อมต่อ PPPoE อยู่ในขณะนี้"
        />
    </div>
</template>

<style scoped>
.head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 22px;
}

.head h1 {
    margin: 0;
    font-size: 1.55rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--v2-text);
}

.head p {
    margin: 3px 0 0;
    font-size: .86rem;
    color: var(--v2-text-muted);
}

.head-status {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: .8rem;
    font-weight: 600;
    padding: 6px 12px;
    border-radius: 999px;
    border: 1px solid var(--v2-border);
    background: var(--v2-surface);
}

.head-status .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
}

.head-status.is-up { color: var(--v2-success); }
.head-status.is-up .dot { background: #22c55e; box-shadow: 0 0 0 3px rgba(34, 197, 94, .16); }
.head-status.is-down { color: var(--v2-danger); }
.head-status.is-down .dot { background: #ef4444; box-shadow: 0 0 0 3px rgba(239, 68, 68, .16); }

.stamp {
    color: var(--v2-text-muted);
    font-weight: 500;
}

.alert {
    padding: 11px 15px;
    border-radius: 10px;
    font-size: .86rem;
    margin-bottom: 18px;
}

.alert-danger {
    background: var(--v2-danger-soft);
    border: 1px solid #fecaca;
    color: var(--v2-danger);
}

.grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(238px, 1fr));
    gap: 14px;
}

.foot-row {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
}

.pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: .72rem;
    font-weight: 600;
    padding: 3px 9px;
    border-radius: 999px;
    white-space: nowrap;
}

.pill-ok { background: var(--v2-success-soft); color: var(--v2-success); }
.pill-warn { background: var(--v2-warn-soft); color: var(--v2-warn); }
.pill-bad { background: var(--v2-danger-soft); color: var(--v2-danger); }

.mini-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font: inherit;
    font-size: .74rem;
    font-weight: 600;
    padding: 5px 11px;
    border-radius: 999px;
    border: 1px solid transparent;
    background: var(--v2-primary);
    color: #fff;
    cursor: pointer;
    transition: background .15s ease, transform .15s ease;
}

.mini-btn:hover {
    background: #1d4ed8;
    transform: translateY(-1px);
}

.mini-btn:focus-visible {
    outline: 2px solid var(--v2-primary);
    outline-offset: 2px;
}
</style>
