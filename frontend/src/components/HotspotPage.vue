<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { apiFetch, activeSiteId } from '../api.js';
import { formatBytes, formatUptime, parseUptimeToMs } from '../format.js';

const TABS = [
    { key: 'active', label: 'ผู้ใช้ที่กำลังเชื่อมต่อ', icon: 'fa-solid fa-signal' },
    { key: 'accounts', label: 'บัญชีผู้ใช้ทั้งหมด', icon: 'fa-solid fa-users' }
];

const tab = ref('active');

const active = ref([]);
const users = ref([]);
const loading = ref(false);
const error = ref('');
const lastUpdated = ref('');

const search = ref('');
const profileFilter = ref('');
const statusFilter = ref('all');

let timer = null;
let requestId = 0;

async function load({ quiet = false } = {}) {
    const myId = ++requestId;
    if (!quiet) loading.value = true;

    const [a, u] = await Promise.allSettled([
        apiFetch('/api/mikrotik/hotspot/active'),
        apiFetch('/api/mikrotik/hotspot/users')
    ]);

    if (myId !== requestId) return; // สลับสาขาระหว่างรอ — ทิ้งผลนี้

    if (a.status === 'fulfilled' && u.status === 'fulfilled') {
        active.value = a.value || [];
        users.value = u.value || [];
        error.value = '';
        lastUpdated.value = new Date().toLocaleTimeString('th-TH');
    } else {
        const reason = (a.status === 'rejected' ? a.reason : u.reason);
        error.value = reason?.message || 'ดึงข้อมูล Hotspot ไม่สำเร็จ';
    }
    loading.value = false;
}

onMounted(() => {
    load();
    timer = setInterval(() => load({ quiet: true }), 15000);
});

onUnmounted(() => {
    if (timer) clearInterval(timer);
});

watch(activeSiteId, () => {
    active.value = [];
    users.value = [];
    error.value = '';
    load();
});

// ชุดชื่อผู้ใช้ที่ออนไลน์อยู่ ใช้ติดป้าย "ออนไลน์" ในตารางบัญชี
const onlineNames = computed(() => new Set(active.value.map((s) => s.user)));

const profiles = computed(() => {
    const set = new Set(users.value.map((u) => u.profile).filter(Boolean));
    return [...set].sort();
});

// สถานะบัญชี — ใช้ตรรกะเดียวกับหน้าเดิม: เทียบ uptime สะสมกับ limit-uptime
// (parseUptimeToMs เข้าใจทั้งรูปแบบ 1w2d3h และ HH:MM:SS)
function accountStatus(u) {
    if (u.disabled) return { key: 'disabled', label: 'ปิดใช้งาน', tone: 'muted' };
    const limit = parseUptimeToMs(u.limitUptime);
    if (!limit) return { key: 'active', label: 'ใช้งานได้', tone: 'ok' };
    const used = parseUptimeToMs(u.uptime);
    if (used >= limit) return { key: 'expired', label: 'หมดอายุ', tone: 'bad' };
    if (limit - used <= limit * 0.1) return { key: 'warning', label: 'ใกล้หมด', tone: 'warn' };
    return { key: 'active', label: 'ใช้งานได้', tone: 'ok' };
}

const filteredUsers = computed(() => {
    const q = search.value.trim().toLowerCase();
    return users.value.filter((u) => {
        if (profileFilter.value && u.profile !== profileFilter.value) return false;
        if (statusFilter.value !== 'all' && accountStatus(u).key !== statusFilter.value) return false;
        if (!q) return true;
        return [u.name, u.profile, u.comment].some((f) => String(f || '').toLowerCase().includes(q));
    });
});

const filteredActive = computed(() => {
    const q = search.value.trim().toLowerCase();
    if (!q) return active.value;
    return active.value.filter((s) =>
        [s.user, s.address, s.macAddress].some((f) => String(f || '').toLowerCase().includes(q))
    );
});

const statusCounts = computed(() => {
    const c = { all: users.value.length, active: 0, expired: 0, warning: 0, disabled: 0 };
    users.value.forEach((u) => { c[accountStatus(u).key]++; });
    return c;
});

const kicking = ref('');
async function kick(session) {
    if (!window.confirm(`เตะผู้ใช้ "${session.user}" ออกจากระบบ?\n\nผู้ใช้จะต้องล็อกอินใหม่`)) return;
    kicking.value = session.id;
    try {
        await apiFetch('/api/mikrotik/hotspot/active/' + encodeURIComponent(session.id), { method: 'DELETE' });
        await load({ quiet: true });
    } catch (err) {
        window.alert('เตะผู้ใช้ไม่สำเร็จ: ' + err.message);
    } finally {
        kicking.value = '';
    }
}
</script>

<template>
    <div class="head">
        <div>
            <h1>จัดการระบบ Hotspot</h1>
            <p>ผู้ใช้ที่กำลังเชื่อมต่อและบัญชีคูปองทั้งหมดของสาขาที่เลือก</p>
        </div>
        <button type="button" class="refresh" :disabled="loading" @click="load()">
            <i class="fa-solid" :class="loading ? 'fa-spinner fa-spin' : 'fa-rotate'"></i>
            {{ loading ? 'กำลังโหลด...' : 'รีเฟรช' }}
            <span v-if="lastUpdated && !loading" class="v2-num stamp">{{ lastUpdated }}</span>
        </button>
    </div>

    <div v-if="error" class="alert">
        <i class="fa-solid fa-triangle-exclamation"></i> {{ error }}
    </div>

    <div class="tabs">
        <button
            v-for="t in TABS"
            :key="t.key"
            type="button"
            class="tab"
            :class="{ on: tab === t.key }"
            @click="tab = t.key"
        >
            <i :class="t.icon"></i> {{ t.label }}
            <span class="count v2-num">{{ t.key === 'active' ? active.length : users.length }}</span>
        </button>
    </div>

    <div class="toolbar">
        <div class="search">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input
                v-model="search"
                type="search"
                :placeholder="tab === 'active' ? 'ค้นหา username, IP, MAC...' : 'ค้นหา username, โปรไฟล์, หมายเหตุ...'"
            >
        </div>

        <template v-if="tab === 'accounts'">
            <select v-model="profileFilter" class="select">
                <option value="">— ทุกโปรไฟล์ —</option>
                <option v-for="p in profiles" :key="p" :value="p">{{ p }}</option>
            </select>
            <div class="pills">
                <button
                    v-for="f in [
                        { k: 'all', t: 'ทั้งหมด' },
                        { k: 'active', t: 'ใช้งานได้' },
                        { k: 'warning', t: 'ใกล้หมด' },
                        { k: 'expired', t: 'หมดอายุ' },
                        { k: 'disabled', t: 'ปิดใช้งาน' }
                    ]"
                    :key="f.k"
                    type="button"
                    class="fpill"
                    :class="{ on: statusFilter === f.k }"
                    @click="statusFilter = f.k"
                >
                    {{ f.t }} <span class="v2-num">{{ statusCounts[f.k] }}</span>
                </button>
            </div>
        </template>

        <span class="result v2-num">
            {{ tab === 'active' ? filteredActive.length : filteredUsers.length }} รายการ
        </span>
    </div>

    <!-- ===== ผู้ใช้ที่กำลังเชื่อมต่อ ===== -->
    <div v-if="tab === 'active'" class="panel">
        <div class="tablewrap">
            <table>
                <thead>
                    <tr>
                        <th>ชื่อผู้ใช้</th>
                        <th>IP Address</th>
                        <th>MAC Address</th>
                        <th>ล็อกอินผ่าน</th>
                        <th class="num">เวลาใช้งาน</th>
                        <th class="num">ดาวน์โหลด</th>
                        <th class="num">อัปโหลด</th>
                        <th class="right">จัดการ</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-if="!filteredActive.length">
                        <td colspan="8" class="empty">
                            {{ loading ? 'กำลังโหลด...' : 'ไม่มีผู้ใช้เชื่อมต่ออยู่ในขณะนี้' }}
                        </td>
                    </tr>
                    <tr v-for="s in filteredActive" :key="s.id">
                        <td class="strong">{{ s.user }}</td>
                        <td class="v2-num">{{ s.address || '-' }}</td>
                        <td class="v2-num mono">{{ s.macAddress || '-' }}</td>
                        <td>{{ s.loginBy || '-' }}</td>
                        <td class="num v2-num">{{ formatUptime(s.uptime) }}</td>
                        <td class="num v2-num">{{ formatBytes(s.bytesIn) }}</td>
                        <td class="num v2-num">{{ formatBytes(s.bytesOut) }}</td>
                        <td class="right">
                            <button
                                type="button"
                                class="danger-btn"
                                :disabled="kicking === s.id"
                                @click="kick(s)"
                            >
                                <i class="fa-solid" :class="kicking === s.id ? 'fa-spinner fa-spin' : 'fa-right-from-bracket'"></i>
                                เตะออก
                            </button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>

    <!-- ===== บัญชีผู้ใช้ทั้งหมด ===== -->
    <div v-else class="panel">
        <div class="note">
            <i class="fa-solid fa-circle-info"></i>
            หน้านี้ยังแสดงผลอย่างเดียว — การเพิ่ม/แก้ไข/ต่ออายุ/พิมพ์คูปอง ยังทำที่
            <a href="/">หน้าเดิม</a> จนกว่าจะย้ายครบ
        </div>
        <div class="tablewrap">
            <table>
                <thead>
                    <tr>
                        <th>ชื่อผู้ใช้ / รหัสผ่าน</th>
                        <th>โปรไฟล์</th>
                        <th>สถานะ</th>
                        <th class="num">เวลาใช้ / จำกัด</th>
                        <th class="num">ดาวน์โหลด</th>
                        <th class="num">อัปโหลด</th>
                        <th>หมายเหตุ</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-if="!filteredUsers.length">
                        <td colspan="7" class="empty">
                            {{ loading ? 'กำลังโหลด...' : 'ไม่พบบัญชีที่ตรงกับเงื่อนไข' }}
                        </td>
                    </tr>
                    <tr v-for="u in filteredUsers" :key="u.id">
                        <td>
                            <div class="strong">
                                {{ u.name }}
                                <span v-if="onlineNames.has(u.name)" class="online" title="กำลังออนไลน์"></span>
                            </div>
                            <div class="sub mono v2-num">{{ u.password || '—' }}</div>
                        </td>
                        <td>{{ u.profile || '-' }}</td>
                        <td>
                            <span class="badge" :class="'b-' + accountStatus(u).tone">{{ accountStatus(u).label }}</span>
                        </td>
                        <td class="num v2-num">
                            {{ formatUptime(u.uptime) }}
                            <span class="sub">/ {{ u.limitUptime === 'Unlimited' ? 'ไม่จำกัด' : formatUptime(u.limitUptime) }}</span>
                        </td>
                        <td class="num v2-num">{{ formatBytes(u.bytesIn) }}</td>
                        <td class="num v2-num">{{ formatBytes(u.bytesOut) }}</td>
                        <td class="cmt">{{ u.comment || '—' }}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</template>

<style scoped>
.head {
    display: flex;
    justify-content: space-between;
    align-items: flex-end;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 18px;
}

.head h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 700;
    letter-spacing: -0.02em;
}

.head p {
    margin: 3px 0 0;
    font-size: .85rem;
    color: var(--v2-text-muted);
}

.refresh {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font: inherit;
    font-size: .82rem;
    font-weight: 600;
    padding: 8px 14px;
    border-radius: 9px;
    border: 1px solid var(--v2-border);
    background: var(--v2-surface);
    color: var(--v2-text-soft);
    cursor: pointer;
}

.refresh:hover:not(:disabled) { border-color: var(--v2-border-strong); color: var(--v2-text); }
.refresh:disabled { opacity: .6; cursor: default; }
.stamp { color: var(--v2-text-muted); font-weight: 500; }

.alert {
    background: var(--v2-danger-soft);
    border: 1px solid #fecaca;
    color: var(--v2-danger);
    padding: 11px 15px;
    border-radius: 10px;
    font-size: .86rem;
    margin-bottom: 16px;
}

.tabs {
    display: flex;
    gap: 6px;
    border-bottom: 1px solid var(--v2-border);
    margin-bottom: 16px;
    overflow-x: auto;
}

.tab {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font: inherit;
    font-size: .87rem;
    font-weight: 600;
    color: var(--v2-text-muted);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    padding: 10px 14px;
    cursor: pointer;
    white-space: nowrap;
}

.tab.on { color: var(--v2-primary); border-bottom-color: var(--v2-primary); }
.tab .count {
    font-size: .72rem;
    background: var(--v2-bg);
    border-radius: 999px;
    padding: 1px 8px;
    font-weight: 700;
}
.tab.on .count { background: var(--v2-primary-soft); }

.toolbar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    margin-bottom: 14px;
}

.search {
    position: relative;
    flex: 1;
    min-width: 220px;
}

.search i {
    position: absolute;
    left: 13px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--v2-text-muted);
    font-size: .82rem;
}

.search input,
.select {
    font: inherit;
    font-size: .85rem;
    border: 1px solid var(--v2-border);
    border-radius: 9px;
    background: var(--v2-surface);
    color: var(--v2-text);
    padding: 9px 12px;
    width: 100%;
}

.search input { padding-left: 36px; }
.select { width: auto; min-width: 170px; cursor: pointer; }
.search input:focus-visible,
.select:focus-visible { outline: 2px solid var(--v2-primary); outline-offset: 1px; }

.pills { display: flex; gap: 5px; flex-wrap: wrap; }

.fpill {
    font: inherit;
    font-size: .76rem;
    font-weight: 600;
    padding: 7px 12px;
    border-radius: 999px;
    border: 1px solid var(--v2-border);
    background: var(--v2-surface);
    color: var(--v2-text-soft);
    cursor: pointer;
}

.fpill.on { background: var(--v2-primary); border-color: var(--v2-primary); color: #fff; }
.fpill span { opacity: .7; margin-left: 3px; }

.result { font-size: .8rem; color: var(--v2-text-muted); font-weight: 600; margin-left: auto; }

.panel {
    background: var(--v2-surface);
    border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius);
    box-shadow: var(--v2-shadow);
    overflow: hidden;
}

.note {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 11px 16px;
    background: var(--v2-primary-soft);
    color: #1d4ed8;
    font-size: .81rem;
    border-bottom: 1px solid var(--v2-border);
}

.note a { color: inherit; font-weight: 700; }

/* ตารางกว้างเกินจอให้เลื่อนในกล่องตัวเอง ไม่ดันทั้งหน้าให้เลื่อนแนวนอน */
.tablewrap { overflow-x: auto; }

table { width: 100%; border-collapse: collapse; font-size: .85rem; }

th {
    text-align: left;
    font-weight: 600;
    font-size: .76rem;
    color: var(--v2-text-muted);
    padding: 11px 14px;
    border-bottom: 1px solid var(--v2-border);
    white-space: nowrap;
    background: #fbfcfe;
}

td { padding: 11px 14px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover td { background: #fbfcfe; }

.num, th.num { text-align: right; }
.right, th.right { text-align: right; }
.strong { font-weight: 600; color: var(--v2-text); }
.sub { font-size: .74rem; color: var(--v2-text-muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem; }
.cmt { color: var(--v2-text-soft); max-width: 220px; }
.empty { text-align: center; color: var(--v2-text-muted); padding: 34px 14px; }

.online {
    display: inline-block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #22c55e;
    margin-left: 6px;
    box-shadow: 0 0 0 3px rgba(34, 197, 94, .16);
    vertical-align: middle;
}

.badge {
    font-size: .72rem;
    font-weight: 600;
    padding: 3px 9px;
    border-radius: 999px;
    white-space: nowrap;
}

.b-ok { background: var(--v2-success-soft); color: var(--v2-success); }
.b-warn { background: var(--v2-warn-soft); color: var(--v2-warn); }
.b-bad { background: var(--v2-danger-soft); color: var(--v2-danger); }
.b-muted { background: #eef2f7; color: var(--v2-text-muted); }

.danger-btn {
    font: inherit;
    font-size: .76rem;
    font-weight: 600;
    padding: 6px 12px;
    border-radius: 8px;
    border: 1px solid #fecaca;
    background: var(--v2-danger-soft);
    color: var(--v2-danger);
    cursor: pointer;
    white-space: nowrap;
}

.danger-btn:hover:not(:disabled) { background: #fee2e2; }
.danger-btn:disabled { opacity: .6; cursor: default; }
</style>
