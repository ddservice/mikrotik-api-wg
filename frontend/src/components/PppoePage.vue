<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { apiFetch, activeSiteId } from '../api.js';
import { formatBytes, formatUptime, formatLastSeen } from '../format.js';
import { toast } from '../toast.js';
import ProfileModal from './ProfileModal.vue';
import PppoeRoomModal from './PppoeRoomModal.vue';
import PppoeSetupPanel from './PppoeSetupPanel.vue';

// ค่า keepalive ของ PPPoE server — ใช้ตอนห้องไหนไฟดับแล้วตัดไม่สะอาด
// เซสชันจะค้างอยู่จนกว่าเราท์เตอร์จะตรวจเจอว่าปลายทางตายแล้ว ค่านี้คุมว่านานแค่ไหน
const srv = ref(null);
const srvKeepalive = ref('');
const srvBusy = ref('');

async function loadServerSettings() {
    srvBusy.value = 'load';
    try {
        const r = await apiFetch('/api/mikrotik/pppoe/server-settings');
        srv.value = r && r.id ? r : null;
        srvKeepalive.value = (r && r.keepaliveTimeout) || '';
    } catch (err) {
        srv.value = null;
        toast.error('อ่านค่า PPPoE Server ไม่ได้: ' + err.message);
    } finally {
        srvBusy.value = '';
    }
}

async function saveServerSettings() {
    const v = String(srvKeepalive.value || '').trim();
    if (!v) return toast.error('กรุณาระบุค่า Keepalive Timeout');
    srvBusy.value = 'save';
    try {
        await apiFetch('/api/mikrotik/pppoe/server-settings', {
            method: 'PUT',
            body: JSON.stringify({ keepaliveTimeout: v })
        });
        toast.success('บันทึกค่า Keepalive แล้ว');
        loadServerSettings();
    } catch (err) {
        toast.error(err.message);
    } finally {
        srvBusy.value = '';
    }
}

// เพิ่ม/แก้/ลบแพ็กเกจ — ใช้ตอนออกแพ็กเกจใหม่หรือปรับความเร็ว
const pkgModalOpen = ref(false);
const editingPkg = ref(null);

function addPackage() { editingPkg.value = null; pkgModalOpen.value = true; }
function editPackage(p) { editingPkg.value = p; pkgModalOpen.value = true; }

async function deletePackage(p) {
    if (!window.confirm([
        `ลบแพ็กเกจ "${p.name}"?`,
        '',
        'ห้องที่ใช้แพ็กเกจนี้อยู่จะใช้งานผิดปกติทันที',
        'ควรย้ายห้องไปแพ็กเกจอื่นให้หมดก่อนลบ'
    ].join('\n'))) return;
    try {
        await apiFetch('/api/mikrotik/pppoe/profiles/' + encodeURIComponent(p.id), { method: 'DELETE' });
        toast.success(`ลบแพ็กเกจ "${p.name}" แล้ว`);
        load({ quiet: true });
    } catch (err) {
        toast.error('ลบไม่สำเร็จ: ' + err.message);
    }
}

// เพิ่ม/แก้/ลบห้องพัก — งานประจำวันของระบบเช่าห้อง (ผู้เช่าเข้าใหม่ ย้ายแพ็กเกจ ย้ายออก)
const roomModalOpen = ref(false);
const editingRoom = ref(null);

function addRoom() { editingRoom.value = null; roomModalOpen.value = true; }
function editRoom(r) { editingRoom.value = r; roomModalOpen.value = true; }

async function deleteRoom(r) {
    // ลบทิ้งเลยกู้คืนไม่ได้ (ไม่มีคลังเก็บเหมือนคูปอง Hotspot) — ผู้เช่าย้ายออกชั่วคราว
    // ควรใช้ "ระงับการใช้งาน" แทน จะได้ไม่ต้องตั้งค่าเราท์เตอร์ห้องใหม่ตอนกลับมา
    if (!window.confirm([
        `ลบห้อง "${r.name}" ออกจากเราท์เตอร์?`,
        '',
        'ลบแล้วกู้คืนไม่ได้ ต้องสร้างใหม่และตั้งค่าเราท์เตอร์ของห้องใหม่ทั้งหมด',
        'ถ้าผู้เช่าแค่ย้ายออกชั่วคราวหรือค้างค่าเช่า ให้ใช้ "ระงับการใช้งาน" แทน'
    ].join('\n'))) return;

    busyRoom.value = r.name;
    try {
        await apiFetch('/api/mikrotik/pppoe/users/' + encodeURIComponent(r.id), { method: 'DELETE' });
        toast.success(`ลบห้อง "${r.name}" แล้ว`);
        await load({ quiet: true });
    } catch (err) {
        toast.error('ลบไม่สำเร็จ: ' + err.message);
    } finally {
        busyRoom.value = '';
    }
}

const TABS = [
    { key: 'active', label: 'สถานะออนไลน์', icon: 'fa-solid fa-signal' },
    { key: 'rooms', label: 'ห้องพักทั้งหมด', icon: 'fa-solid fa-door-open' },
    { key: 'packages', label: 'แพ็กเกจ', icon: 'fa-solid fa-layer-group' }
];

const tab = ref('active');
const active = ref([]);
const rooms = ref([]);
const packages = ref([]);
const loading = ref(false);
const error = ref('');
const lastUpdated = ref('');
const search = ref('');
const statusFilter = ref('all');
const busyRoom = ref('');

let timer = null;
let requestId = 0;

async function load({ quiet = false } = {}) {
    const myId = ++requestId;
    if (!quiet) loading.value = true;

    const [a, u, p] = await Promise.allSettled([
        apiFetch('/api/mikrotik/pppoe/active'),
        apiFetch('/api/mikrotik/pppoe/users'),
        apiFetch('/api/mikrotik/pppoe/profiles')
    ]);

    if (myId !== requestId) return; // สลับสาขาระหว่างรอ — ทิ้งผลนี้

    if (a.status === 'fulfilled') active.value = a.value || [];
    if (u.status === 'fulfilled') rooms.value = u.value || [];
    if (p.status === 'fulfilled') packages.value = p.value || [];

    const failed = [a, u, p].find((r) => r.status === 'rejected');
    error.value = failed ? (failed.reason?.message || 'ดึงข้อมูล PPPoE ไม่สำเร็จ') : '';
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
    rooms.value = [];
    packages.value = [];
    error.value = '';
    load();
});

// ห้องที่ระงับการใช้งาน = /ppp/secret ถูก disable
// ใช้คำว่า "ระงับการใช้งาน" ตามคอนเวนชันของระบบ (ไม่ใช่ "ล็อก"/"ปิดใช้งาน")
function roomStatus(r) {
    if (r.disabled) return { key: 'suspended', label: 'ระงับการใช้งาน', tone: 'bad' };
    if (r.isOnline) return { key: 'online', label: 'ออนไลน์', tone: 'ok' };
    return { key: 'offline', label: 'ออฟไลน์', tone: 'muted' };
}

const counts = computed(() => {
    const c = { all: rooms.value.length, online: 0, offline: 0, suspended: 0 };
    rooms.value.forEach((r) => { c[roomStatus(r).key]++; });
    return c;
});

const filteredRooms = computed(() => {
    const q = search.value.trim().toLowerCase();
    return rooms.value.filter((r) => {
        if (statusFilter.value !== 'all' && roomStatus(r).key !== statusFilter.value) return false;
        if (!q) return true;
        return [r.name, r.profile, r.comment].some((f) => String(f || '').toLowerCase().includes(q));
    });
});

const filteredActive = computed(() => {
    const q = search.value.trim().toLowerCase();
    if (!q) return active.value;
    return active.value.filter((s) =>
        [s.name, s.address, s.callerId].some((f) => String(f || '').toLowerCase().includes(q))
    );
});

async function toggleSuspend(room) {
    const suspend = !room.disabled;
    const msg = suspend
        ? `ระงับการใช้งานห้อง "${room.name}"?\n\nบัญชีจะถูกปิด และถ้ากำลังออนไลน์อยู่จะถูกตัดทันที`
        : `ยกเลิกการระงับห้อง "${room.name}"?\n\nห้องจะกลับมาเชื่อมต่อได้ตามปกติ`;
    if (!window.confirm(msg)) return;

    busyRoom.value = room.name;
    try {
        await apiFetch(`/api/mikrotik/pppoe/users/by-name/${encodeURIComponent(room.name)}/suspend`, {
            method: 'PATCH',
            body: JSON.stringify({ suspend })
        });
        await load({ quiet: true });
    } catch (err) {
        window.alert('ทำรายการไม่สำเร็จ: ' + err.message);
    } finally {
        busyRoom.value = '';
    }
}

async function kick(session) {
    if (!window.confirm(`ตัดการเชื่อมต่อห้อง "${session.name}"?\n\nเราท์เตอร์ปลายทางจะเชื่อมต่อกลับมาเองภายในไม่กี่วินาที`)) return;
    busyRoom.value = session.id;
    try {
        await apiFetch('/api/mikrotik/pppoe/active/' + encodeURIComponent(session.id), { method: 'DELETE' });
        await load({ quiet: true });
    } catch (err) {
        window.alert('ตัดการเชื่อมต่อไม่สำเร็จ: ' + err.message);
    } finally {
        busyRoom.value = '';
    }
}
</script>

<template>
    <div class="head">
        <div>
            <h1>จัดการระบบ PPPoE</h1>
            <p>ห้องพักที่เช่าอยู่ สถานะการเชื่อมต่อ และแพ็กเกจความเร็ว</p>
        </div>
        <button type="button" class="refresh" :disabled="loading" @click="load()">
            <i class="fa-solid" :class="loading ? 'fa-spinner fa-spin' : 'fa-rotate'"></i>
            {{ loading ? 'กำลังโหลด...' : 'รีเฟรช' }}
            <span v-if="lastUpdated && !loading" class="v2-num stamp">{{ lastUpdated }}</span>
        </button>
    </div>

    <div v-if="error" class="alert"><i class="fa-solid fa-triangle-exclamation"></i> {{ error }}</div>

    <div class="summary">
        <div class="chip"><span class="dot ok"></span> ออนไลน์ <b class="v2-num">{{ counts.online }}</b></div>
        <div class="chip"><span class="dot muted"></span> ออฟไลน์ <b class="v2-num">{{ counts.offline }}</b></div>
        <div class="chip"><span class="dot bad"></span> ระงับ <b class="v2-num">{{ counts.suspended }}</b></div>
        <div class="chip total">ห้องทั้งหมด <b class="v2-num">{{ counts.all }}</b></div>
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
            <span class="count v2-num">
                {{ t.key === 'active' ? active.length : t.key === 'rooms' ? rooms.length : packages.length }}
            </span>
        </button>
    </div>

    <div v-if="tab !== 'packages'" class="toolbar">
        <div class="search">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input v-model="search" type="search" placeholder="ค้นหาเลขห้อง, แพ็กเกจ, IP, MAC...">
        </div>
        <div v-if="tab === 'rooms'" class="pills">
            <button
                v-for="f in [
                    { k: 'all', t: 'ทั้งหมด' },
                    { k: 'online', t: 'ออนไลน์' },
                    { k: 'offline', t: 'ออฟไลน์' },
                    { k: 'suspended', t: 'ระงับ' }
                ]"
                :key="f.k"
                type="button"
                class="fpill"
                :class="{ on: statusFilter === f.k }"
                @click="statusFilter = f.k"
            >{{ f.t }} <span class="v2-num">{{ counts[f.k] }}</span></button>
        </div>
        <span class="result v2-num">
            {{ tab === 'active' ? filteredActive.length : filteredRooms.length }} รายการ
        </span>
    </div>

    <!-- ===== สถานะออนไลน์ ===== -->
    <div v-if="tab === 'active'" class="panel">
        <div class="tablewrap">
            <table>
                <thead>
                    <tr>
                        <th>ห้อง</th>
                        <th>IP Address</th>
                        <th>MAC Address</th>
                        <th class="num">เวลาเชื่อมต่อ</th>
                        <th class="num">ดาวน์โหลด</th>
                        <th class="num">อัปโหลด</th>
                        <th class="right">จัดการ</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-if="!filteredActive.length">
                        <td colspan="7" class="empty">{{ loading ? 'กำลังโหลด...' : 'ไม่มีห้องที่เชื่อมต่ออยู่ในขณะนี้' }}</td>
                    </tr>
                    <tr v-for="s in filteredActive" :key="s.id">
                        <td class="strong">{{ s.name }}</td>
                        <td class="v2-num">{{ s.address || '-' }}</td>
                        <td class="v2-num mono">{{ s.callerId || '-' }}</td>
                        <td class="num v2-num">{{ formatUptime(s.uptime) }}</td>
                        <td class="num v2-num">{{ formatBytes(s.bytesIn) }}</td>
                        <td class="num v2-num">{{ formatBytes(s.bytesOut) }}</td>
                        <td class="right">
                            <button type="button" class="danger-btn" :disabled="busyRoom === s.id" @click="kick(s)">
                                <i class="fa-solid" :class="busyRoom === s.id ? 'fa-spinner fa-spin' : 'fa-plug-circle-xmark'"></i>
                                ตัดการเชื่อมต่อ
                            </button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>

    <!-- ===== ห้องพักทั้งหมด ===== -->
    <div v-else-if="tab === 'rooms'" class="panel">
        <div class="roombar">
            <button type="button" class="v2-btn primary" @click="addRoom">
                <i class="fa-solid fa-plus"></i> เพิ่มห้องพัก
            </button>
            <span class="sub">ผู้เช่าเข้าใหม่ให้เพิ่มห้อง · ค้างค่าเช่าให้ใช้ "ระงับการใช้งาน" ไม่ใช่ลบ</span>
        </div>
        <div class="tablewrap">
            <table>
                <thead>
                    <tr>
                        <th>ห้อง / รหัสผ่าน</th>
                        <th>แพ็กเกจ</th>
                        <th>สถานะ</th>
                        <th>ออนไลน์ล่าสุด</th>
                        <th>หมายเหตุ</th>
                        <th class="right">จัดการ</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-if="!filteredRooms.length">
                        <td colspan="6" class="empty">{{ loading ? 'กำลังโหลด...' : 'ไม่พบห้องที่ตรงกับเงื่อนไข' }}</td>
                    </tr>
                    <tr v-for="r in filteredRooms" :key="r.id">
                        <td>
                            <div class="strong">{{ r.name }}</div>
                            <div class="sub mono v2-num">{{ r.password || '—' }}</div>
                        </td>
                        <td>{{ r.profile || '-' }}</td>
                        <td><span class="badge" :class="'b-' + roomStatus(r).tone">{{ roomStatus(r).label }}</span></td>
                        <td class="v2-num sub-strong">
                            <template v-if="r.isOnline">เชื่อมต่ออยู่ {{ formatUptime(r.currentUptime) }}</template>
                            <template v-else>{{ formatLastSeen(r.lastLoggedOut) }}</template>
                        </td>
                        <td class="cmt">{{ r.comment || '—' }}</td>
                        <td class="right">
                            <div class="rowbtns">
                                <button
                                    type="button"
                                    :class="r.disabled ? 'ok-btn' : 'danger-btn'"
                                    :disabled="busyRoom === r.name"
                                    @click="toggleSuspend(r)"
                                >
                                    <i class="fa-solid" :class="busyRoom === r.name ? 'fa-spinner fa-spin' : (r.disabled ? 'fa-play' : 'fa-ban')"></i>
                                    {{ r.disabled ? 'ยกเลิกระงับ' : 'ระงับการใช้งาน' }}
                                </button>
                                <button type="button" class="v2-btn ghost sm" title="แก้ไขห้อง" :disabled="busyRoom === r.name" @click="editRoom(r)">
                                    <i class="fa-solid fa-pen"></i>
                                </button>
                                <button type="button" class="v2-btn danger sm" title="ลบห้อง" :disabled="busyRoom === r.name" @click="deleteRoom(r)">
                                    <i class="fa-solid fa-trash"></i>
                                </button>
                            </div>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>

    <!-- ===== แพ็กเกจ ===== -->
    <!-- ค่า Keepalive ของ PPPoE Server — วางไว้กับแพ็กเกจเพราะเป็นการตั้งค่าฝั่งเซิร์ฟเวอร์เหมือนกัน -->
    <div v-else class="panel srvpanel">
        <div class="ptitle"><i class="fa-solid fa-plug-circle-bolt"></i> การตั้งค่า PPPoE Server</div>
        <div class="sub">
            เมื่อห้องไหนไฟดับหรือถอดสายโดยไม่ตัดการเชื่อมต่อให้เรียบร้อย เซสชันจะค้างอยู่
            จนกว่าเราท์เตอร์จะตรวจเจอว่าปลายทางไม่ตอบแล้ว ค่านี้คือระยะเวลารอนั้น
            (ค่าที่ใช้กันทั่วไปคือ <code>10</code> วินาที)
        </div>
        <div class="srvrow">
            <button type="button" class="v2-btn ghost" :disabled="srvBusy === 'load'" @click="loadServerSettings">
                <i class="fa-solid" :class="srvBusy === 'load' ? 'fa-spinner fa-spin' : 'fa-rotate'"></i> อ่านค่าจากเราท์เตอร์
            </button>
            <template v-if="srv">
                <span class="sub">อินเทอร์เฟซ <strong>{{ srv.interfaceName || '—' }}</strong>
                    · service <strong>{{ srv.serviceName || '—' }}</strong></span>
                <input v-model="srvKeepalive" class="v2-input ka" placeholder="10">
                <button type="button" class="v2-btn primary" :disabled="srvBusy === 'save'" @click="saveServerSettings">
                    <i class="fa-solid" :class="srvBusy === 'save' ? 'fa-spinner fa-spin' : 'fa-floppy-disk'"></i> บันทึก
                </button>
            </template>
            <span v-else-if="srvBusy !== 'load'" class="sub">
                กด "อ่านค่าจากเราท์เตอร์" เพื่อดูและแก้ค่า (สาขานี้ต้องตั้ง PPPoE Server ไว้แล้ว)
            </span>
        </div>
    </div>

    <div v-if="tab === 'packages'" class="panel">
        <div class="pkgbar">
            <button type="button" class="v2-btn primary" @click="addPackage">
                <i class="fa-solid fa-plus"></i> เพิ่มแพ็กเกจ
            </button>
        </div>
        <div class="tablewrap">
            <table>
                <thead>
                    <tr>
                        <th>ชื่อแพ็กเกจ</th>
                        <th>ความเร็ว (Rate Limit)</th>
                        <th>Local Address</th>
                        <th>Remote Address / Pool</th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-if="!packages.length">
                        <td colspan="4" class="empty">{{ loading ? 'กำลังโหลด...' : 'ยังไม่มีแพ็กเกจ' }}</td>
                    </tr>
                    <tr v-for="p in packages" :key="p.id">
                        <td class="strong">{{ p.name }}</td>
                        <td class="v2-num">{{ p.rateLimit === 'Unlimited' ? 'ไม่จำกัด' : p.rateLimit }}</td>
                        <td class="v2-num">{{ p.localAddress || '—' }}</td>
                        <td class="v2-num">{{ p.remoteAddress || '—' }}</td>
                        <td class="rowact">
                            <button type="button" class="v2-btn ghost sm" title="แก้ไข" @click="editPackage(p)">
                                <i class="fa-solid fa-pen"></i>
                            </button>
                            <button type="button" class="v2-btn danger sm" title="ลบ" @click="deletePackage(p)">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
    <!-- สคริปต์ตั้ง PPPoE Server ครั้งแรกของสาขา — อยู่คู่กับการตั้งค่าฝั่งเซิร์ฟเวอร์อื่น ๆ -->
    <PppoeSetupPanel v-if="tab === 'packages'" />

    <ProfileModal
        :open="pkgModalOpen" kind="pppoe" :profile="editingPkg"
        @close="pkgModalOpen = false" @saved="load({ quiet: true })"
    />
    <PppoeRoomModal
        :open="roomModalOpen" :room="editingRoom" :packages="packages"
        @close="roomModalOpen = false" @saved="load({ quiet: true })"
    />
</template>

<style scoped>
.pkgbar { margin-bottom: 12px; }
.roombar {
    display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
    padding: 12px 16px; border-bottom: 1px solid var(--v2-border);
}
.rowbtns { display: flex; gap: 6px; justify-content: flex-end; }
.rowact { display: flex; gap: 6px; }
.srvpanel { margin-bottom: 16px; }
.ptitle { font-weight: 600; font-size: .9rem; margin-bottom: 8px; display: flex; align-items: center; gap: 8px; }
.srvrow { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 10px; }
.srvrow .ka { max-width: 110px; }
code { background: var(--v2-primary-soft); padding: 1px 5px; border-radius: 4px; }

.head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.head h1 { margin: 0; font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; }
.head p { margin: 3px 0 0; font-size: .85rem; color: var(--v2-text-muted); }

.refresh {
    display: inline-flex; align-items: center; gap: 8px; font: inherit; font-size: .82rem; font-weight: 600;
    padding: 8px 14px; border-radius: 9px; border: 1px solid var(--v2-border);
    background: var(--v2-surface); color: var(--v2-text-soft); cursor: pointer;
}
.refresh:hover:not(:disabled) { border-color: var(--v2-border-strong); color: var(--v2-text); }
.refresh:disabled { opacity: .6; cursor: default; }
.stamp { color: var(--v2-text-muted); font-weight: 500; }

.alert {
    background: var(--v2-danger-soft); border: 1px solid #fecaca; color: var(--v2-danger);
    padding: 11px 15px; border-radius: 10px; font-size: .86rem; margin-bottom: 16px;
}

.summary { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
.chip {
    display: inline-flex; align-items: center; gap: 7px; font-size: .81rem; font-weight: 600;
    color: var(--v2-text-soft); background: var(--v2-surface); border: 1px solid var(--v2-border);
    border-radius: 999px; padding: 7px 14px;
}
.chip b { color: var(--v2-text); }
.chip.total { background: var(--v2-primary-soft); border-color: #bfdbfe; color: #1d4ed8; }
.chip.total b { color: #1d4ed8; }
.dot { width: 7px; height: 7px; border-radius: 50%; }
.dot.ok { background: #22c55e; }
.dot.muted { background: #cbd5e1; }
.dot.bad { background: #ef4444; }

.tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--v2-border); margin-bottom: 16px; overflow-x: auto; }
.tab {
    display: inline-flex; align-items: center; gap: 8px; font: inherit; font-size: .87rem; font-weight: 600;
    color: var(--v2-text-muted); background: none; border: none; border-bottom: 2px solid transparent;
    padding: 10px 14px; cursor: pointer; white-space: nowrap;
}
.tab.on { color: var(--v2-primary); border-bottom-color: var(--v2-primary); }
.tab .count { font-size: .72rem; background: var(--v2-bg); border-radius: 999px; padding: 1px 8px; font-weight: 700; }
.tab.on .count { background: var(--v2-primary-soft); }

.toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
.search { position: relative; flex: 1; min-width: 220px; }
.search i { position: absolute; left: 13px; top: 50%; transform: translateY(-50%); color: var(--v2-text-muted); font-size: .82rem; }
.search input {
    font: inherit; font-size: .85rem; border: 1px solid var(--v2-border); border-radius: 9px;
    background: var(--v2-surface); color: var(--v2-text); padding: 9px 12px 9px 36px; width: 100%;
}
.search input:focus-visible { outline: 2px solid var(--v2-primary); outline-offset: 1px; }

.pills { display: flex; gap: 5px; flex-wrap: wrap; }
.fpill {
    font: inherit; font-size: .76rem; font-weight: 600; padding: 7px 12px; border-radius: 999px;
    border: 1px solid var(--v2-border); background: var(--v2-surface); color: var(--v2-text-soft); cursor: pointer;
}
.fpill.on { background: var(--v2-primary); border-color: var(--v2-primary); color: #fff; }
.fpill span { opacity: .7; margin-left: 3px; }
.result { font-size: .8rem; color: var(--v2-text-muted); font-weight: 600; margin-left: auto; }

.panel {
    background: var(--v2-surface); border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius); box-shadow: var(--v2-shadow); overflow: hidden;
}
.note {
    display: flex; align-items: center; gap: 8px; padding: 11px 16px;
    background: var(--v2-primary-soft); color: #1d4ed8; font-size: .81rem; border-bottom: 1px solid var(--v2-border);
}
.note a { color: inherit; font-weight: 700; }

.tablewrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .85rem; }
th {
    text-align: left; font-weight: 600; font-size: .76rem; color: var(--v2-text-muted);
    padding: 11px 14px; border-bottom: 1px solid var(--v2-border); white-space: nowrap; background: #fbfcfe;
}
td { padding: 11px 14px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover td { background: #fbfcfe; }
.num, th.num { text-align: right; }
.right, th.right { text-align: right; }
.strong { font-weight: 600; color: var(--v2-text); }
.sub { font-size: .74rem; color: var(--v2-text-muted); }
.sub-strong { font-size: .8rem; color: var(--v2-text-soft); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem; }
.cmt { color: var(--v2-text-soft); max-width: 200px; }
.empty { text-align: center; color: var(--v2-text-muted); padding: 34px 14px; }

.badge { font-size: .72rem; font-weight: 600; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
.b-ok { background: var(--v2-success-soft); color: var(--v2-success); }
.b-bad { background: var(--v2-danger-soft); color: var(--v2-danger); }
.b-muted { background: #eef2f7; color: var(--v2-text-muted); }

.danger-btn, .ok-btn {
    font: inherit; font-size: .76rem; font-weight: 600; padding: 6px 12px;
    border-radius: 8px; cursor: pointer; white-space: nowrap;
}
.danger-btn { border: 1px solid #fecaca; background: var(--v2-danger-soft); color: var(--v2-danger); }
.danger-btn:hover:not(:disabled) { background: #fee2e2; }
.ok-btn { border: 1px solid #bbf7d0; background: var(--v2-success-soft); color: var(--v2-success); }
.ok-btn:hover:not(:disabled) { background: #dcfce7; }
.danger-btn:disabled, .ok-btn:disabled { opacity: .6; cursor: default; }
</style>
