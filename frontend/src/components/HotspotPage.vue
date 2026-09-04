<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { apiFetch, activeSiteId } from '../api.js';
import { formatBytes, formatUptime, parseUptimeToMs } from '../format.js';
import { toast } from '../toast.js';
import HotspotUserModal from './HotspotUserModal.vue';
import HotspotArchivePanel from './HotspotArchivePanel.vue';
import ProfileModal from './ProfileModal.vue';
import VoucherPanel from './VoucherPanel.vue';

const TABS = [
    { key: 'active', label: 'ผู้ใช้ที่กำลังเชื่อมต่อ', icon: 'fa-solid fa-signal' },
    { key: 'accounts', label: 'บัญชีผู้ใช้ทั้งหมด', icon: 'fa-solid fa-users' },
    { key: 'profiles', label: 'โปรไฟล์ / แพ็กเกจ', icon: 'fa-solid fa-layer-group' },
    { key: 'vouchers', label: 'สร้าง / พิมพ์คูปอง', icon: 'fa-solid fa-ticket' },
    { key: 'archive', label: 'ผู้ใช้ที่ถูกลบ / กู้คืน', icon: 'fa-solid fa-box-archive' }
];

// เพิ่ม/แก้/ลบโปรไฟล์ — ใช้ตอนออกแพ็กเกจใหม่หรือปรับความเร็ว
const profModalOpen = ref(false);
const editingProfile = ref(null);

function addProfile() { editingProfile.value = null; profModalOpen.value = true; }
function editProfile(p) { editingProfile.value = p; profModalOpen.value = true; }

async function deleteProfile(p) {
    const inUse = users.value.filter((u) => u.profile === p.name).length;
    const lines = [`ลบโปรไฟล์ "${p.name}"?`, ''];
    if (inUse) {
        lines.push(`มีผู้ใช้ ${inUse} คนใช้โปรไฟล์นี้อยู่ และจะใช้งานผิดปกติทันที`);
        lines.push('ควรย้ายผู้ใช้ไปโปรไฟล์อื่นให้หมดก่อนลบ');
    } else {
        lines.push('ยังไม่มีผู้ใช้คนไหนใช้โปรไฟล์นี้');
    }
    if (!window.confirm(lines.join('\n'))) return;
    try {
        await apiFetch('/api/mikrotik/hotspot/profiles/' + encodeURIComponent(p.id), { method: 'DELETE' });
        toast.success(`ลบโปรไฟล์ "${p.name}" แล้ว`);
        load({ quiet: true });
    } catch (err) {
        toast.error('ลบไม่สำเร็จ: ' + err.message);
    }
}

const tab = ref('active');

const active = ref([]);
const users = ref([]);
const profiles = ref([]);
const editorOpen = ref(false);
const editing = ref(null);
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

    const [a, u, p] = await Promise.allSettled([
        apiFetch('/api/mikrotik/hotspot/active'),
        apiFetch('/api/mikrotik/hotspot/users'),
        apiFetch('/api/mikrotik/hotspot/profiles')
    ]);

    if (myId !== requestId) return; // สลับสาขาระหว่างรอ — ทิ้งผลนี้

    if (a.status === 'fulfilled') active.value = a.value || [];
    if (u.status === 'fulfilled') users.value = u.value || [];
    if (p.status === 'fulfilled') profiles.value = p.value || [];

    const failed = [a, u].find((r) => r.status === 'rejected');
    error.value = failed ? (failed.reason?.message || 'ดึงข้อมูล Hotspot ไม่สำเร็จ') : '';
    if (!error.value) lastUpdated.value = new Date().toLocaleTimeString('th-TH');
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
    profiles.value = [];
    selected.value = new Set();
    error.value = '';
    load();
});

// เปิดแท็บคูปองแล้วค่อยเติมค่าเริ่มต้น — ชื่อสาขาต้องยิงขอเพิ่มอีกครั้ง
// ไม่ควรยิงตั้งแต่เข้าหน้า Hotspot ทั้งที่อาจไม่ได้เปิดแท็บนี้เลย
watch(tab, async (t) => {
    if (t !== 'vouchers') return;
    await nextTick();
    voucherRef.value && voucherRef.value.primeDefaults();
});

// ชุดชื่อผู้ใช้ที่ออนไลน์อยู่ ใช้ติดป้าย "ออนไลน์" ในตารางบัญชี
const onlineNames = computed(() => new Set(active.value.map((s) => s.user)));

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

// ---------- เลือกบัญชีเพื่อพิมพ์คูปองซ้ำ ----------
// ใช้ตอนคูปองใบเดิมหายหรือพิมพ์ตกไปบางใบ — ไม่สร้างบัญชีใหม่บนเราท์เตอร์
const voucherRef = ref(null);
const selected = ref(new Set());

function toggleSelect(id) {
    const next = new Set(selected.value);
    next.has(id) ? next.delete(id) : next.add(id);
    selected.value = next;
}

const allVisibleSelected = computed(() =>
    filteredUsers.value.length > 0 && filteredUsers.value.every((u) => selected.value.has(u.id))
);

function toggleSelectAll() {
    selected.value = allVisibleSelected.value
        ? new Set()
        : new Set(filteredUsers.value.map((u) => u.id));
}

async function printSelected() {
    const picked = users.value.filter((u) => selected.value.has(u.id));
    if (!picked.length) return toast.error('เลือกบัญชีที่ต้องการพิมพ์อย่างน้อย 1 รายการก่อน');
    tab.value = 'vouchers';
    await nextTick();
    if (!voucherRef.value) return;
    await voucherRef.value.primeDefaults();
    voucherRef.value.showReprint(picked);
}

const busy = ref('');

async function runAction(key, fn, okMsg, failMsg) {
    busy.value = key;
    try {
        await fn();
        toast.success(okMsg);
        await load({ quiet: true });
    } catch (err) {
        toast.error(failMsg + ': ' + err.message);
    } finally {
        busy.value = '';
    }
}

// ข้อความยืนยันประกอบด้วย ask() เพื่อไม่ต้องเขียน escape ขึ้นบรรทัดใหม่กระจายทั่วไฟล์
function ask(lines) {
    return window.confirm(lines.join('\n'));
}

function kick(session) {
    if (!ask([
        `เตะผู้ใช้ "${session.user}" ออกจากระบบ?`,
        '',
        'ผู้ใช้จะต้องล็อกอินใหม่'
    ])) return;
    runAction(
        session.id,
        () => apiFetch('/api/mikrotik/hotspot/active/' + encodeURIComponent(session.id), { method: 'DELETE' }),
        'เตะ "' + session.user + '" ออกจากระบบแล้ว',
        'เตะผู้ใช้ไม่สำเร็จ'
    );
}

function openCreate() {
    editing.value = null;
    editorOpen.value = true;
}

function openEdit(u) {
    editing.value = u;
    editorOpen.value = true;
}

function removeUser(u) {
    // ยังใช้ confirm ที่บล็อกจริง เพราะย้อนกลับจากหน้านี้ไม่ได้ (ต้องไปกู้ในคลังคูปอง)
    if (!ask([
        `ลบบัญชี "${u.name}" ออกจากเราท์เตอร์?`,
        '',
        'ข้อมูลจะถูกเก็บเข้าคลังคูปองที่ถูกลบ และกู้คืนได้ภายหลัง'
    ])) return;
    runAction(
        u.id,
        () => apiFetch('/api/mikrotik/hotspot/users/' + encodeURIComponent(u.id), { method: 'DELETE' }),
        'ลบ "' + u.name + '" แล้ว (เก็บเข้าคลังคูปองเรียบร้อย)',
        'ลบไม่สำเร็จ'
    );
}

// ต่ออายุด่วน — ใช้ limit-uptime เดิม แต่ล้างเวลาสะสมและเตะเซสชันให้
// ครอบเคสที่พบบ่อยที่สุด: ลูกค้าเติมแพ็กเกจเดิมซ้ำด้วย username เดิม
function quickRenew(u) {
    const limit = u.limitUptime && u.limitUptime !== 'Unlimited' ? u.limitUptime : '';
    if (!ask([
        `ต่ออายุ "${u.name}" ด้วยแพ็กเกจเดิม?`,
        '',
        `จำกัดเวลา: ${limit || 'ไม่จำกัด'}`,
        'ระบบจะล้างเวลาใช้งานสะสมและเตะเซสชันที่ค้างอยู่ให้'
    ])) return;
    runAction(
        u.id,
        () => apiFetch('/api/mikrotik/hotspot/users/' + encodeURIComponent(u.id) + '/renew', {
            method: 'POST',
            body: JSON.stringify({ name: u.name, limitUptime: limit, limitBytesTotal: u.limitBytesTotal || 0 })
        }),
        'ต่ออายุ "' + u.name + '" แล้ว — เวลาใช้งานเริ่มนับใหม่',
        'ต่ออายุไม่สำเร็จ'
    );
}
</script>

<template>
    <div class="head">
        <div>
            <h1>จัดการระบบ Hotspot</h1>
            <p>ผู้ใช้ที่กำลังเชื่อมต่อและบัญชีคูปองทั้งหมดของสาขาที่เลือก</p>
        </div>
        <div class="head-actions">
            <button type="button" class="refresh" :disabled="loading" @click="load()">
                <i class="fa-solid" :class="loading ? 'fa-spinner fa-spin' : 'fa-rotate'"></i>
                {{ loading ? 'กำลังโหลด...' : 'รีเฟรช' }}
                <span v-if="lastUpdated && !loading" class="v2-num stamp">{{ lastUpdated }}</span>
            </button>
            <button type="button" class="v2-btn primary" @click="openCreate">
                <i class="fa-solid fa-user-plus"></i> เพิ่มบัญชี
            </button>
        </div>
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
            <span v-if="['active', 'accounts', 'profiles'].includes(t.key)" class="count v2-num">
                {{ t.key === 'active' ? active.length : (t.key === 'profiles' ? profiles.length : users.length) }}
            </span>
        </button>
    </div>

    <div v-if="tab === 'active' || tab === 'accounts'" class="toolbar">
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
                <option v-for="p in profiles" :key="p.id" :value="p.name">{{ p.name }}</option>
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
            <button
                type="button" class="v2-btn ghost sm"
                :disabled="!selected.size"
                :title="selected.size ? 'พิมพ์คูปองซ้ำจากบัญชีที่เลือก' : 'ติ๊กเลือกบัญชีในตารางก่อน'"
                @click="printSelected"
            >
                <i class="fa-solid fa-print"></i> พิมพ์คูปองที่เลือก
                <span v-if="selected.size" class="v2-num">({{ selected.size }})</span>
            </button>
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
                                :disabled="busy === s.id"
                                @click="kick(s)"
                            >
                                <i class="fa-solid" :class="busy === s.id ? 'fa-spinner fa-spin' : 'fa-right-from-bracket'"></i>
                                เตะออก
                            </button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>

    <!-- ===== บัญชีผู้ใช้ทั้งหมด ===== -->
    <div v-else-if="tab === 'accounts'" class="panel">
        <div class="tablewrap">
            <table>
                <thead>
                    <tr>
                        <th class="chkcol">
                            <input
                                type="checkbox" title="เลือกทั้งหมดที่แสดงอยู่"
                                :checked="allVisibleSelected" :disabled="!filteredUsers.length"
                                @change="toggleSelectAll"
                            >
                        </th>
                        <th>ชื่อผู้ใช้ / รหัสผ่าน</th>
                        <th>โปรไฟล์</th>
                        <th>สถานะ</th>
                        <th class="num">เวลาใช้ / จำกัด</th>
                        <th class="num">ดาวน์โหลด</th>
                        <th class="num">อัปโหลด</th>
                        <th>หมายเหตุ</th>
                        <th class="right">จัดการ</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-if="!filteredUsers.length">
                        <td colspan="9" class="empty">
                            {{ loading ? 'กำลังโหลด...' : 'ไม่พบบัญชีที่ตรงกับเงื่อนไข' }}
                        </td>
                    </tr>
                    <tr v-for="u in filteredUsers" :key="u.id" :class="{ picked: selected.has(u.id) }">
                        <td class="chkcol">
                            <input type="checkbox" :checked="selected.has(u.id)" @change="toggleSelect(u.id)">
                        </td>
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
                        <td class="right">
                            <div class="rowbtns">
                                <button
                                    type="button" class="v2-btn ghost sm" title="ต่ออายุด้วยแพ็กเกจเดิม (ล้างเวลาสะสม)"
                                    :disabled="busy === u.id" @click="quickRenew(u)"
                                >
                                    <i class="fa-solid" :class="busy === u.id ? 'fa-spinner fa-spin' : 'fa-rotate-right'"></i> ต่ออายุ
                                </button>
                                <button type="button" class="v2-btn ghost sm" title="แก้ไข" :disabled="busy === u.id" @click="openEdit(u)">
                                    <i class="fa-solid fa-pen"></i>
                                </button>
                                <button type="button" class="v2-btn danger sm" title="ลบ" :disabled="busy === u.id" @click="removeUser(u)">
                                    <i class="fa-solid fa-trash"></i>
                                </button>
                            </div>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>

    <!-- ===== โปรไฟล์ / แพ็กเกจ ===== -->
    <div v-else-if="tab === 'profiles'" class="panel">
        <div class="pkgbar">
            <button type="button" class="v2-btn primary" @click="addProfile">
                <i class="fa-solid fa-plus"></i> เพิ่มโปรไฟล์
            </button>
            <span class="sub">โปรไฟล์คือแพ็กเกจความเร็วและเงื่อนไขที่ผูกกับคูปองแต่ละใบ</span>
        </div>
        <div class="tablewrap">
            <table>
                <thead>
                    <tr>
                        <th>ชื่อโปรไฟล์</th>
                        <th>ความเร็ว</th>
                        <th>ใช้พร้อมกัน</th>
                        <th>Session Timeout</th>
                        <th>ใช้อยู่</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-if="!profiles.length">
                        <td colspan="6" class="sub center">ยังไม่มีโปรไฟล์ในสาขานี้</td>
                    </tr>
                    <tr v-for="p in profiles" :key="p.id">
                        <td class="strong">{{ p.name }}</td>
                        <td class="v2-num">{{ p.rateLimit === 'Unlimited' || !p.rateLimit ? 'ไม่จำกัด' : p.rateLimit }}</td>
                        <td class="v2-num">{{ p.sharedUsers || 1 }}</td>
                        <td class="v2-num">{{ p.sessionTimeout || '—' }}</td>
                        <td class="v2-num sub">{{ users.filter((u) => u.profile === p.name).length }} คน</td>
                        <td class="rowact">
                            <button type="button" class="v2-btn ghost sm" title="แก้ไข" @click="editProfile(p)">
                                <i class="fa-solid fa-pen"></i>
                            </button>
                            <button type="button" class="v2-btn danger sm" title="ลบ" @click="deleteProfile(p)">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>

    <!-- ===== สร้าง / พิมพ์คูปอง ===== -->
    <VoucherPanel
        v-else-if="tab === 'vouchers'"
        ref="voucherRef"
        :profiles="profiles"
        @generated="load({ quiet: true })"
    />

    <!-- ===== ผู้ใช้ที่ถูกลบ / กู้คืน ===== -->
    <HotspotArchivePanel v-else />

    <ProfileModal
        :open="profModalOpen" kind="hotspot" :profile="editingProfile"
        @close="profModalOpen = false" @saved="load({ quiet: true })"
    />

    <HotspotUserModal
        :open="editorOpen"
        :user="editing"
        :profiles="profiles"
        @close="editorOpen = false"
        @saved="load({ quiet: true })"
    />
</template>

<style scoped>
.pkgbar { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.rowact { display: flex; gap: 6px; }
.center { text-align: center; }

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

.chkcol { width: 34px; padding-right: 0; }
.chkcol input { width: 15px; height: 15px; cursor: pointer; }
tbody tr.picked td { background: var(--v2-primary-soft); }

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
