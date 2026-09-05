<script setup>
import { ref, computed, onMounted } from 'vue';
import { apiFetch, currentUser, sites, loadSites } from '../api.js';
import { CONFIGURABLE_MENUS, ADMIN_ONLY_MENUS, OVERVIEW_MENU } from '../menu.js';
import { toast } from '../toast.js';
import BaseModal from './BaseModal.vue';

const ROLES = [
    { key: 'admin', label: 'Super Admin', desc: 'เข้าถึงทุกอย่าง รวมตั้งค่าระบบและจัดการผู้ใช้', tone: 'admin' },
    { key: 'co-admin', label: 'Co-Admin', desc: 'จัดการงานประจำวันได้ แต่แตะการตั้งค่าระบบไม่ได้', tone: 'co' },
    { key: 'user', label: 'User', desc: 'สิทธิ์จำกัดตามเมนูที่เปิดให้', tone: 'user' }
];

const users = ref([]);
const perms = ref({ 'co-admin': [], user: [] });

// ยกเมนูมาให้ครบทุกตัว ไม่ใช่เฉพาะที่ปรับได้ — ถ้าเห็นแค่ 5 จาก 8 คนตั้งค่าจะไม่รู้ว่า
// เมนูที่เหลือหายไปไหน แล้วเข้าใจผิดว่าลืมเปิดให้ ทั้งที่มันตั้งใจให้เป็นแบบนั้น
const ALL_MENU_ROWS = [
    { ...OVERVIEW_MENU, lock: 'always', note: 'ทุกบทบาทเห็นเสมอ — เป็นหน้าแรกหลังล็อกอิน' },
    ...CONFIGURABLE_MENUS.map((m) => ({ ...m, lock: null })),
    ...ADMIN_ONLY_MENUS.map((m) => ({ ...m, lock: 'admin', note: 'เฉพาะ Super Admin — ปรับไม่ได้' }))
];

// เปิด/ปิดทั้งหมดในบทบาทเดียว — มี 5 ช่องต่อบทบาท การกดทีละช่องเสียเวลาโดยไม่จำเป็น
function setAll(role, on) {
    perms.value = { ...perms.value, [role]: on ? CONFIGURABLE_MENUS.map((m) => m.key) : [] };
}

const permCount = computed(() => ({
    'co-admin': (perms.value['co-admin'] || []).length,
    user: (perms.value.user || []).length,
    total: CONFIGURABLE_MENUS.length
}));
const loading = ref(false);
const busy = ref('');
const savingPerms = ref(false);

const modalOpen = ref(false);
const editing = ref(null);
const form = ref({});
const saving = ref(false);

async function load() {
    loading.value = true;
    try {
        const [u, s, p] = await Promise.allSettled([
            apiFetch('/api/users'),
            loadSites(),
            apiFetch('/api/settings/menu-permissions')
        ]);
        if (u.status === 'fulfilled') users.value = u.value || [];
        // sites เป็น state กลาง loadSites() เติมให้เองแล้ว ไม่ต้องรับค่ากลับมาใส่
        if (p.status === 'fulfilled') {
            perms.value = {
                'co-admin': p.value['co-admin'] || [],
                user: p.value.user || []
            };
        }
        const failed = [u, s, p].find((r) => r.status === 'rejected');
        if (failed) toast.error(failed.reason?.message || 'โหลดข้อมูลไม่สำเร็จ');
    } finally {
        loading.value = false;
    }
}

onMounted(load);

function siteName(id) {
    if (!id || id === 'all') return 'ทุกสาขา';
    return sites.value.find((s) => s.id === id)?.name || id;
}

function roleOf(key) {
    return ROLES.find((r) => r.key === key) || ROLES[2];
}

function openCreate() {
    editing.value = null;
    form.value = { username: '', name: '', password: '', role: 'user', assignedSiteId: 'all' };
    modalOpen.value = true;
}

function openEdit(u) {
    editing.value = u;
    form.value = {
        username: u.username,
        name: u.name || '',
        password: '',                       // ว่างเสมอ = ไม่เปลี่ยนรหัส
        role: u.role,
        assignedSiteId: u.assignedSiteId || 'all'
    };
    modalOpen.value = true;
}

async function saveUser() {
    if (!form.value.username.trim()) return toast.error('ต้องระบุชื่อผู้ใช้');
    if (!editing.value && !form.value.password) return toast.error('ผู้ใช้ใหม่ต้องตั้งรหัสผ่าน');

    saving.value = true;
    try {
        const body = {
            username: form.value.username.trim(),
            name: form.value.name.trim(),
            role: form.value.role,
            assignedSiteId: form.value.assignedSiteId
        };
        if (form.value.password) body.password = form.value.password;

        if (editing.value) {
            await apiFetch('/api/users/' + encodeURIComponent(editing.value.id), {
                method: 'PUT',
                body: JSON.stringify(body)
            });
            toast.success(`บันทึกผู้ใช้ "${body.username}" แล้ว`);
        } else {
            await apiFetch('/api/users', { method: 'POST', body: JSON.stringify(body) });
            toast.success(`เพิ่มผู้ใช้ "${body.username}" แล้ว`);
        }
        modalOpen.value = false;
        await load();
    } catch (err) {
        toast.error(err.message);
    } finally {
        saving.value = false;
    }
}

async function removeUser(u) {
    if (!window.confirm([
        `ลบผู้ใช้ "${u.username}" ออกจากระบบ?`,
        '',
        'ผู้ใช้จะเข้าสู่ระบบไม่ได้อีก และเซสชันที่เปิดอยู่จะถูกตัดทันที'
    ].join('\n'))) return;

    busy.value = u.id;
    try {
        await apiFetch('/api/users/' + encodeURIComponent(u.id), { method: 'DELETE' });
        toast.success(`ลบผู้ใช้ "${u.username}" แล้ว`);
        await load();
    } catch (err) {
        toast.error('ลบไม่สำเร็จ: ' + err.message);
    } finally {
        busy.value = '';
    }
}

function togglePerm(role, key) {
    const list = perms.value[role];
    const i = list.indexOf(key);
    if (i >= 0) list.splice(i, 1);
    else list.push(key);
}

async function savePerms() {
    savingPerms.value = true;
    try {
        await apiFetch('/api/settings/menu-permissions', {
            method: 'POST',
            body: JSON.stringify(perms.value)
        });
        toast.success('บันทึกสิทธิ์เมนูแล้ว — ผู้ใช้ต้องเข้าสู่ระบบใหม่จึงจะเห็นผล');
    } catch (err) {
        toast.error(err.message);
    } finally {
        savingPerms.value = false;
    }
}

// ห้ามลบตัวเอง — ถ้า admin คนสุดท้ายลบตัวเองจะไม่มีใครเข้าระบบได้อีก
const isSelf = (u) => u.username === currentUser.value?.username;
const adminCount = computed(() => users.value.filter((u) => u.role === 'admin').length);
</script>

<template>
    <div class="head">
        <div>
            <h1>ผู้ใช้งานระบบ Dashboard</h1>
            <p>บัญชีสำหรับสแตฟฟ์ที่เข้ามาจัดการระบบ และสิทธิ์การเห็นเมนูของแต่ละบทบาท</p>
        </div>
        <button type="button" class="v2-btn primary" @click="openCreate">
            <i class="fa-solid fa-user-plus"></i> เพิ่มผู้ใช้
        </button>
    </div>

    <div class="panel">
        <div class="tablewrap">
            <table>
                <thead>
                    <tr><th>ผู้ใช้</th><th>บทบาท</th><th>สาขาที่เข้าถึงได้</th><th class="right">จัดการ</th></tr>
                </thead>
                <tbody>
                    <tr v-if="!users.length"><td colspan="4" class="empty">{{ loading ? 'กำลังโหลด...' : 'ยังไม่มีผู้ใช้' }}</td></tr>
                    <tr v-for="u in users" :key="u.id">
                        <td>
                            <div class="strong">
                                {{ u.name || u.username }}
                                <span v-if="isSelf(u)" class="me">คุณ</span>
                            </div>
                            <div class="sub mono">{{ u.username }}</div>
                        </td>
                        <td><span class="rl" :class="roleOf(u.role).tone">{{ roleOf(u.role).label }}</span></td>
                        <td>
                            <span :class="{ sub: u.assignedSiteId === 'all' || !u.assignedSiteId }">
                                {{ siteName(u.assignedSiteId) }}
                            </span>
                            <div v-if="u.assignedSiteId && u.assignedSiteId !== 'all'" class="sub">
                                ถูกล็อกให้เห็นเฉพาะสาขานี้
                            </div>
                        </td>
                        <td class="right">
                            <div class="rowbtns">
                                <button type="button" class="v2-btn ghost sm" title="แก้ไข" :disabled="busy === u.id" @click="openEdit(u)">
                                    <i class="fa-solid fa-pen"></i>
                                </button>
                                <button
                                    type="button" class="v2-btn danger sm"
                                    :title="isSelf(u) ? 'ลบบัญชีตัวเองไม่ได้' : (u.role === 'admin' && adminCount <= 1 ? 'ลบ Super Admin คนสุดท้ายไม่ได้' : 'ลบ')"
                                    :disabled="busy === u.id || isSelf(u) || (u.role === 'admin' && adminCount <= 1)"
                                    @click="removeUser(u)"
                                >
                                    <i class="fa-solid" :class="busy === u.id ? 'fa-spinner fa-spin' : 'fa-trash'"></i>
                                </button>
                            </div>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>

    <!-- สิทธิ์เมนู -->
    <div class="panel perms">
        <div class="phead">
            <h3><i class="fa-solid fa-list-check"></i> เมนูที่แต่ละบทบาทมองเห็น</h3>
        </div>

        <div class="v2-callout warn">
            <i class="fa-solid fa-shield-halved"></i>
            <span>
                <strong>นี่คือการซ่อนเมนูเท่านั้น ไม่ใช่การล็อกสิทธิ์จริง</strong> —
                API แต่ละเส้นบังคับสิทธิ์ของตัวเองอยู่แล้ว การซ่อนเมนูจึงเป็นเรื่องความสะดวก
                ไม่ใช่มาตรการความปลอดภัย · Super Admin เห็นทุกเมนูเสมอ ปรับไม่ได้
            </span>
        </div>

        <div class="ptable">
            <div class="prow phdr">
                <div>เมนู</div>
                <div>
                    Co-Admin
                    <div class="allbtns">
                        <button type="button" @click="setAll('co-admin', true)">ทั้งหมด</button>
                        <button type="button" @click="setAll('co-admin', false)">ไม่เลือก</button>
                    </div>
                </div>
                <div>
                    User
                    <div class="allbtns">
                        <button type="button" @click="setAll('user', true)">ทั้งหมด</button>
                        <button type="button" @click="setAll('user', false)">ไม่เลือก</button>
                    </div>
                </div>
            </div>
            <div v-for="m in ALL_MENU_ROWS" :key="m.key" class="prow" :class="{ locked: m.lock }">
                <div class="mname">
                    <i :class="m.icon"></i> {{ m.title }}
                    <div v-if="m.note" class="mnote">{{ m.note }}</div>
                </div>
                <template v-if="m.lock === 'always'">
                    <div class="fixed"><i class="fa-solid fa-check"></i> เห็น</div>
                    <div class="fixed"><i class="fa-solid fa-check"></i> เห็น</div>
                </template>
                <template v-else-if="m.lock === 'admin'">
                    <div class="fixed off"><i class="fa-solid fa-minus"></i> ไม่เห็น</div>
                    <div class="fixed off"><i class="fa-solid fa-minus"></i> ไม่เห็น</div>
                </template>
                <template v-else>
                <div>
                    <label class="cbox">
                        <input type="checkbox" :checked="perms['co-admin'].includes(m.key)" @change="togglePerm('co-admin', m.key)">
                        <span></span>
                    </label>
                </div>
                <div>
                    <label class="cbox">
                        <input type="checkbox" :checked="perms.user.includes(m.key)" @change="togglePerm('user', m.key)">
                        <span></span>
                    </label>
                </div>
            </template>
            </div>
        </div>

        <div class="pfoot">
            <button type="button" class="v2-btn primary" :disabled="savingPerms" @click="savePerms">
                <i class="fa-solid" :class="savingPerms ? 'fa-spinner fa-spin' : 'fa-floppy-disk'"></i> บันทึกสิทธิ์เมนู
            </button>
            <span class="pcount">
                Co-Admin เห็น {{ permCount['co-admin'] }}/{{ permCount.total }} เมนู ·
                User เห็น {{ permCount.user }}/{{ permCount.total }} เมนู
                <template v-if="permCount.user === 0 || permCount['co-admin'] === 0">
                    — บทบาทที่ไม่เลือกเลยจะเห็นแค่หน้าภาพรวม
                </template>
            </span>
        </div>
    </div>

    <!-- โมดัลเพิ่ม/แก้ไขผู้ใช้ -->
    <BaseModal
        :open="modalOpen" :busy="saving"
        :title="editing ? 'แก้ไขผู้ใช้' : 'เพิ่มผู้ใช้ใหม่'"
        :icon="editing ? 'fa-solid fa-pen' : 'fa-solid fa-user-plus'"
        @close="modalOpen = false"
    >
        <div class="v2-row-2">
            <div class="v2-field">
                <label>ชื่อผู้ใช้ (Username) <span class="req">*</span></label>
                <input v-model="form.username" class="v2-input mono" :disabled="saving" autocomplete="off">
            </div>
            <div class="v2-field">
                <label>ชื่อที่แสดง</label>
                <input v-model="form.name" class="v2-input" :disabled="saving" placeholder="เช่น สมชาย (แอดมิน A4)">
            </div>
        </div>

        <div class="v2-field">
            <label>รหัสผ่าน <span v-if="!editing" class="req">*</span></label>
            <input v-model="form.password" type="password" class="v2-input" :disabled="saving" autocomplete="new-password"
                   :placeholder="editing ? 'เว้นว่าง = ใช้รหัสเดิม' : 'ตั้งรหัสผ่านให้ผู้ใช้'">
        </div>

        <div class="v2-field">
            <label>บทบาท</label>
            <div class="roles">
                <label v-for="r in ROLES" :key="r.key" class="rcard" :class="{ on: form.role === r.key }">
                    <input v-model="form.role" type="radio" :value="r.key" :disabled="saving">
                    <div>
                        <div class="rname">{{ r.label }}</div>
                        <div class="rdesc">{{ r.desc }}</div>
                    </div>
                </label>
            </div>
        </div>

        <div class="v2-field">
            <label>สาขาที่เข้าถึงได้</label>
            <select v-model="form.assignedSiteId" class="v2-select" :disabled="saving || form.role === 'admin'">
                <option value="all">ทุกสาขา</option>
                <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
            <span class="v2-hint">
                เลือกสาขาเดียว = ผู้ใช้จะเห็นและสั่งงานได้เฉพาะสาขานั้น รวมถึง log และไฟล์ส่งออกด้วย ·
                Super Admin เข้าถึงทุกสาขาเสมอ
            </span>
        </div>

        <template #footer>
            <button type="button" class="v2-btn ghost" :disabled="saving" @click="modalOpen = false">ยกเลิก</button>
            <button type="button" class="v2-btn primary" :disabled="saving" @click="saveUser">
                <i class="fa-solid" :class="saving ? 'fa-spinner fa-spin' : 'fa-floppy-disk'"></i>
                {{ saving ? 'กำลังบันทึก...' : (editing ? 'บันทึก' : 'เพิ่มผู้ใช้') }}
            </button>
        </template>
    </BaseModal>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.head h1 { margin: 0; font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; }
.head p { margin: 3px 0 0; font-size: .85rem; color: var(--v2-text-muted); }

.panel {
    background: var(--v2-surface); border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius); box-shadow: var(--v2-shadow); overflow: hidden; margin-bottom: 18px;
}
.tablewrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .85rem; }
th { text-align: left; font-weight: 600; font-size: .75rem; color: var(--v2-text-muted); padding: 10px 16px; border-bottom: 1px solid var(--v2-border); background: #fbfcfe; }
td { padding: 11px 16px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
tbody tr:last-child td { border-bottom: none; }
.right, th.right { text-align: right; }
.strong { font-weight: 600; color: var(--v2-text); }
.sub { font-size: .75rem; color: var(--v2-text-muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem; }
.empty { text-align: center; color: var(--v2-text-muted); padding: 30px 14px; }
.rowbtns { display: inline-flex; gap: 5px; justify-content: flex-end; }

.me { font-size: .66rem; font-weight: 700; background: var(--v2-primary-soft); color: #1d4ed8; padding: 2px 7px; border-radius: 999px; margin-left: 6px; }
.rl { font-size: .74rem; font-weight: 600; padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
.rl.admin { background: #ede9fe; color: #6d28d9; }
.rl.co { background: #e0f2fe; color: #0369a1; }
.rl.user { background: #eef2f7; color: #475569; }

.perms { padding: 0 0 0 0; }
.phead { padding: 14px 16px; border-bottom: 1px solid var(--v2-border); }
.phead h3 { margin: 0; font-size: .95rem; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.phead i { color: var(--v2-primary); }
.perms .v2-callout { margin: 16px; }

.ptable { border-top: 1px solid var(--v2-border); }
.prow {
    display: grid; grid-template-columns: 1fr 120px 120px; align-items: center;
    padding: 10px 16px; border-bottom: 1px solid #f1f5f9;
}
.prow > div:not(:first-child) { text-align: center; }
.phdr { background: #fbfcfe; font-size: .75rem; font-weight: 600; color: var(--v2-text-muted); }
.mname { display: flex; align-items: center; gap: 9px; font-size: .86rem; font-weight: 500; flex-wrap: wrap; }
.mnote { flex-basis: 100%; padding-left: 25px; font-size: .7rem; color: var(--v2-text-muted); font-weight: 400; }
.prow.locked { background: #fcfcfd; }
.fixed { font-size: .72rem; color: var(--v2-success, #16a34a); font-weight: 600; }
.fixed.off { color: var(--v2-text-muted); }
.allbtns { display: flex; gap: 4px; justify-content: center; margin-top: 5px; }
.allbtns button {
    border: 1px solid var(--v2-border); background: #fff; border-radius: 5px;
    padding: 2px 7px; font-size: .66rem; font-family: inherit; color: var(--v2-text-muted); cursor: pointer;
}
.allbtns button:hover { border-color: var(--v2-primary); color: var(--v2-primary); }
.mname i { width: 16px; text-align: center; color: var(--v2-text-muted); }

.cbox { display: inline-flex; cursor: pointer; }
.cbox input { position: absolute; opacity: 0; }
.cbox span {
    width: 20px; height: 20px; border-radius: 6px; border: 1.5px solid var(--v2-border-strong);
    display: grid; place-items: center; transition: all .14s ease; background: var(--v2-surface);
}
.cbox span::after { content: '✓'; color: #fff; font-size: .78rem; font-weight: 700; opacity: 0; }
.cbox input:checked + span { background: var(--v2-primary); border-color: var(--v2-primary); }
.cbox input:checked + span::after { opacity: 1; }
.cbox input:focus-visible + span { outline: 2px solid var(--v2-primary); outline-offset: 2px; }

.pfoot { padding: 14px 16px; background: #fbfcfe; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.pcount { font-size: .74rem; color: var(--v2-text-muted); }

.roles { display: flex; flex-direction: column; gap: 8px; }
.rcard {
    display: flex; align-items: flex-start; gap: 10px; padding: 11px 13px;
    border: 1px solid var(--v2-border); border-radius: 10px; cursor: pointer; transition: all .14s ease;
}
.rcard.on { border-color: var(--v2-primary); background: var(--v2-primary-soft); }
.rcard input { margin-top: 3px; }
.rname { font-weight: 600; font-size: .87rem; }
.rdesc { font-size: .76rem; color: var(--v2-text-muted); margin-top: 2px; }
</style>
