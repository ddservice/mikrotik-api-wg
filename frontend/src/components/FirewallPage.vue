<script setup>
import { ref, onMounted, watch } from 'vue';
import { apiFetch, activeSiteId } from '../api.js';
import { toast } from '../toast.js';

// ต้องตรงกับคีย์ใน FIREWALL_SERVICES ของ server.js เป๊ะ ๆ
// ถ้าสะกดไม่ตรง server จะตอบ "Invalid service" กลับมา
const SERVICES = [
    { key: 'youtube', label: 'YouTube', icon: 'fa-brands fa-youtube', color: '#ef4444' },
    { key: 'tiktok', label: 'TikTok', icon: 'fa-brands fa-tiktok', color: '#0f172a' },
    { key: 'facebook', label: 'Facebook', icon: 'fa-brands fa-facebook', color: '#1877f2' },
    { key: 'line', label: 'LINE', icon: 'fa-brands fa-line', color: '#06c755' },
    { key: 'netflix', label: 'Netflix', icon: 'fa-solid fa-film', color: '#e50914' },
    { key: 'games', label: 'เกมมือถือ', icon: 'fa-solid fa-gamepad', color: '#8b5cf6' },
    { key: 'steam', label: 'Steam', icon: 'fa-brands fa-steam', color: '#1b2838' },
    { key: 'adult', label: 'เว็บผู้ใหญ่', icon: 'fa-solid fa-ban', color: '#be123c' },
    { key: 'torrent', label: 'BitTorrent', icon: 'fa-solid fa-download', color: '#0891b2' },
    { key: 'crypto', label: 'ขุดเหรียญ (Crypto)', icon: 'fa-brands fa-bitcoin', color: '#f59e0b' },
    { key: 'ads', label: 'โฆษณา & ตัวติดตาม', icon: 'fa-solid fa-rectangle-ad', color: '#64748b' }
];

const DAYS = [
    { k: 'mon', t: 'จ' }, { k: 'tue', t: 'อ' }, { k: 'wed', t: 'พ' }, { k: 'thu', t: 'พฤ' },
    { k: 'fri', t: 'ศ' }, { k: 'sat', t: 'ส' }, { k: 'sun', t: 'อา' }
];

const status = ref({});
const rules = ref([]);
const loading = ref(false);
const error = ref('');
const busy = ref('');
const expanded = ref('');

const newDomain = ref('');
const newNote = ref('');
const addingRule = ref(false);

async function load() {
    loading.value = true;
    error.value = '';
    try {
        const [st, cr] = await Promise.allSettled([
            apiFetch('/api/mikrotik/firewall/status'),
            apiFetch('/api/mikrotik/firewall/custom-rules')
        ]);
        if (st.status === 'fulfilled') status.value = st.value || {};
        if (cr.status === 'fulfilled') rules.value = cr.value || [];
        const failed = [st, cr].find((r) => r.status === 'rejected');
        if (failed) error.value = failed.reason?.message || 'ดึงข้อมูล Firewall ไม่สำเร็จ';
    } finally {
        loading.value = false;
    }
}

onMounted(load);
watch(activeSiteId, () => { status.value = {}; rules.value = []; load(); });

function svc(key) {
    return status.value[key] || { blocked: false, scheduleEnabled: false, timeStart: '', timeEnd: '', days: [] };
}

// ส่งสถานะทั้งชุดทุกครั้ง — endpoint สร้างกฎใหม่ทับของเดิม
// ถ้าส่งไปแค่ block:true โดยไม่แนบตารางเวลา กฎที่เคยตั้งเวลาไว้จะกลายเป็นบล็อกตลอดวัน
async function push(key, patch) {
    const cur = svc(key);
    const body = {
        service: key,
        block: patch.block !== undefined ? patch.block : cur.blocked,
        scheduleEnabled: patch.scheduleEnabled !== undefined ? patch.scheduleEnabled : cur.scheduleEnabled,
        timeStart: patch.timeStart !== undefined ? patch.timeStart : cur.timeStart,
        timeEnd: patch.timeEnd !== undefined ? patch.timeEnd : cur.timeEnd,
        days: patch.days !== undefined ? patch.days : cur.days
    };
    busy.value = key;
    try {
        await apiFetch('/api/mikrotik/firewall/toggle', { method: 'POST', body: JSON.stringify(body) });
        status.value = { ...status.value, [key]: { ...cur, blocked: body.block, scheduleEnabled: body.scheduleEnabled, timeStart: body.timeStart, timeEnd: body.timeEnd, days: body.days } };
        const label = SERVICES.find((s) => s.key === key)?.label || key;
        toast.success(body.block ? `บล็อก ${label} แล้ว` : `เลิกบล็อก ${label} แล้ว`);
    } catch (err) {
        toast.error('ทำรายการไม่สำเร็จ: ' + err.message);
        await load();
    } finally {
        busy.value = '';
    }
}

function toggleBlock(key) {
    push(key, { block: !svc(key).blocked });
}

function toggleDay(key, day) {
    const cur = svc(key);
    const days = cur.days.includes(day) ? cur.days.filter((d) => d !== day) : [...cur.days, day];
    push(key, { days });
}

function applySchedule(key) {
    const cur = svc(key);
    if (cur.scheduleEnabled && (!cur.timeStart || !cur.timeEnd)) {
        return toast.error('ต้องระบุทั้งเวลาเริ่มและเวลาสิ้นสุด');
    }
    push(key, {});
}

async function addRule() {
    if (!newDomain.value.trim()) return toast.error('ต้องระบุโดเมนหรือ IP');
    addingRule.value = true;
    try {
        await apiFetch('/api/mikrotik/firewall/custom-rules', {
            method: 'POST',
            body: JSON.stringify({ domain: newDomain.value.trim(), note: newNote.value.trim() })
        });
        toast.success(`บล็อก ${newDomain.value.trim()} แล้ว`);
        newDomain.value = '';
        newNote.value = '';
        await load();
    } catch (err) {
        toast.error(err.message);
    } finally {
        addingRule.value = false;
    }
}

async function removeRule(r) {
    if (!window.confirm(`เลิกบล็อก "${r.comment || r.id}"?`)) return;
    busy.value = r.id;
    try {
        await apiFetch('/api/mikrotik/firewall/custom-rules/' + encodeURIComponent(r.id), { method: 'DELETE' });
        toast.success('ลบกฎแล้ว');
        await load();
    } catch (err) {
        toast.error('ลบไม่สำเร็จ: ' + err.message);
    } finally {
        busy.value = '';
    }
}
</script>

<template>
    <div class="head">
        <div>
            <h1>จัดการบล็อกเว็บ</h1>
            <p>เปิด/ปิดการบล็อกบริการยอดนิยม ตั้งเวลาบล็อก และเพิ่มโดเมนเอง</p>
        </div>
        <button type="button" class="v2-btn ghost" :disabled="loading" @click="load">
            <i class="fa-solid" :class="loading ? 'fa-spinner fa-spin' : 'fa-rotate'"></i> รีเฟรช
        </button>
    </div>

    <div v-if="error" class="alert"><i class="fa-solid fa-triangle-exclamation"></i> {{ error }}</div>

    <div class="grid">
        <div v-for="s in SERVICES" :key="s.key" class="card" :class="{ on: svc(s.key).blocked }">
            <div class="top">
                <span class="ico" :style="{ background: svc(s.key).blocked ? s.color : '#eef2f7', color: svc(s.key).blocked ? '#fff' : '#94a3b8' }">
                    <i :class="s.icon"></i>
                </span>
                <div class="txt">
                    <div class="name">{{ s.label }}</div>
                    <div class="state">
                        {{ svc(s.key).blocked ? (svc(s.key).scheduleEnabled ? 'บล็อกตามเวลา' : 'บล็อกอยู่') : 'ไม่บล็อก' }}
                    </div>
                </div>
                <label class="sw">
                    <input type="checkbox" :checked="svc(s.key).blocked" :disabled="busy === s.key" @change="toggleBlock(s.key)">
                    <span></span>
                </label>
            </div>

            <button
                v-if="svc(s.key).blocked" type="button" class="schedbtn"
                @click="expanded = expanded === s.key ? '' : s.key"
            >
                <i class="fa-solid fa-clock"></i>
                {{ svc(s.key).scheduleEnabled ? `${svc(s.key).timeStart || '--:--'} – ${svc(s.key).timeEnd || '--:--'}` : 'ตั้งเวลาบล็อก' }}
                <i class="fa-solid" :class="expanded === s.key ? 'fa-chevron-up' : 'fa-chevron-down'"></i>
            </button>

            <div v-if="expanded === s.key && svc(s.key).blocked" class="sched">
                <label class="chk">
                    <input type="checkbox" :checked="svc(s.key).scheduleEnabled"
                           @change="push(s.key, { scheduleEnabled: $event.target.checked })">
                    <span>บล็อกเฉพาะช่วงเวลาที่กำหนด</span>
                </label>

                <template v-if="svc(s.key).scheduleEnabled">
                    <div class="times">
                        <input type="time" class="v2-input" :value="svc(s.key).timeStart"
                               @change="status[s.key].timeStart = $event.target.value">
                        <span>ถึง</span>
                        <input type="time" class="v2-input" :value="svc(s.key).timeEnd"
                               @change="status[s.key].timeEnd = $event.target.value">
                    </div>
                    <div class="days">
                        <button
                            v-for="d in DAYS" :key="d.k" type="button" class="day"
                            :class="{ on: svc(s.key).days.includes(d.k) }"
                            :disabled="busy === s.key" @click="toggleDay(s.key, d.k)"
                        >{{ d.t }}</button>
                    </div>
                    <span class="hint">ไม่เลือกวันใดเลย = บล็อกทุกวันในช่วงเวลานี้</span>
                    <button type="button" class="v2-btn primary sm" :disabled="busy === s.key" @click="applySchedule(s.key)">
                        <i class="fa-solid" :class="busy === s.key ? 'fa-spinner fa-spin' : 'fa-check'"></i> บันทึกเวลา
                    </button>
                </template>
            </div>
        </div>
    </div>

    <!-- โดเมนที่บล็อกเอง -->
    <div class="panel">
        <div class="phead">
            <h3><i class="fa-solid fa-list-check"></i> โดเมน / IP ที่บล็อกเพิ่มเอง</h3>
            <span class="cnt v2-num">{{ rules.length }} รายการ</span>
        </div>

        <div class="addrow">
            <input v-model="newDomain" class="v2-input" placeholder="โดเมนหรือ IP เช่น example.com หรือ 1.2.3.4"
                   :disabled="addingRule" @keyup.enter="addRule">
            <input v-model="newNote" class="v2-input" placeholder="หมายเหตุ (ไม่บังคับ)" :disabled="addingRule" @keyup.enter="addRule">
            <button type="button" class="v2-btn primary" :disabled="addingRule" @click="addRule">
                <i class="fa-solid" :class="addingRule ? 'fa-spinner fa-spin' : 'fa-plus'"></i> เพิ่ม
            </button>
        </div>

        <div class="tablewrap">
            <table>
                <thead><tr><th>รายการ</th><th>สถานะ</th><th class="right">จัดการ</th></tr></thead>
                <tbody>
                    <tr v-if="!rules.length"><td colspan="3" class="empty">{{ loading ? 'กำลังโหลด...' : 'ยังไม่มีโดเมนที่บล็อกเพิ่มเอง' }}</td></tr>
                    <tr v-for="r in rules" :key="r.id">
                        <td class="strong">{{ r.comment || r.id }}</td>
                        <td>
                            <span class="badge" :class="r.disabled ? 'b-muted' : 'b-bad'">
                                {{ r.disabled ? 'ปิดอยู่' : 'บล็อกอยู่' }}
                            </span>
                        </td>
                        <td class="right">
                            <button type="button" class="v2-btn danger sm" :disabled="busy === r.id" @click="removeRule(r)">
                                <i class="fa-solid" :class="busy === r.id ? 'fa-spinner fa-spin' : 'fa-trash'"></i> ลบ
                            </button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div class="note">
            <i class="fa-solid fa-circle-info"></i>
            สคริปต์ RouterOS v7 Hardened Security Preset (กันยิงรหัส WinBox/SSH, กัน DNS amplification)
            เป็นการตั้งค่าครั้งเดียว ยังทำที่ <a href="/">หน้าเดิม</a>
        </div>
    </div>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; }
.head h1 { margin: 0; font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; }
.head p { margin: 3px 0 0; font-size: .85rem; color: var(--v2-text-muted); }

.alert {
    background: var(--v2-danger-soft); border: 1px solid #fecaca; color: var(--v2-danger);
    padding: 11px 15px; border-radius: 10px; font-size: .86rem; margin-bottom: 14px;
}

.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(270px, 1fr)); gap: 12px; margin-bottom: 20px; }

.card {
    background: var(--v2-surface); border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius); box-shadow: var(--v2-shadow); padding: 14px 16px;
    transition: border-color .15s ease;
}
.card.on { border-color: #fecaca; }

.top { display: flex; align-items: center; gap: 11px; }
.ico { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; font-size: .95rem; flex-shrink: 0; transition: background .15s ease; }
.txt { flex: 1; min-width: 0; }
.name { font-weight: 600; font-size: .9rem; color: var(--v2-text); }
.state { font-size: .75rem; color: var(--v2-text-muted); }

.sw { position: relative; display: inline-block; width: 42px; height: 23px; flex-shrink: 0; }
.sw input { opacity: 0; width: 0; height: 0; }
.sw span { position: absolute; inset: 0; background: #cbd5e1; border-radius: 999px; cursor: pointer; transition: background .18s ease; }
.sw span::before { content: ''; position: absolute; width: 17px; height: 17px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: transform .18s ease; }
.sw input:checked + span { background: #ef4444; }
.sw input:checked + span::before { transform: translateX(19px); }
.sw input:disabled + span { opacity: .5; cursor: wait; }
/* input ถูกซ่อนด้วย opacity:0 ขนาด 0x0 ผู้ใช้คีย์บอร์ดจึงไม่เห็นว่าโฟกัสอยู่ที่ไหน
   ย้ายวงโฟกัสไปไว้ที่ track ที่มองเห็นจริงแทน */
.sw input:focus-visible + span { outline: 2px solid var(--v2-primary); outline-offset: 2px; }

.schedbtn {
    width: 100%; margin-top: 11px; display: flex; align-items: center; gap: 8px;
    font: inherit; font-size: .78rem; font-weight: 600; color: var(--v2-text-soft);
    background: var(--v2-bg); border: 1px solid var(--v2-border); border-radius: 8px;
    padding: 7px 11px; cursor: pointer;
}
.schedbtn i:last-child { margin-left: auto; font-size: .68rem; }
.schedbtn:hover { color: var(--v2-text); }

.sched { margin-top: 11px; padding-top: 11px; border-top: 1px dashed var(--v2-border); display: flex; flex-direction: column; gap: 9px; }
.chk { display: flex; align-items: center; gap: 8px; font-size: .8rem; cursor: pointer; }
.chk input { width: 15px; height: 15px; cursor: pointer; }
.times { display: flex; align-items: center; gap: 7px; font-size: .8rem; color: var(--v2-text-muted); }
.times .v2-input { padding: 6px 9px; font-size: .8rem; }
.days { display: flex; gap: 4px; flex-wrap: wrap; }
.day {
    font: inherit; font-size: .72rem; font-weight: 600; width: 30px; height: 28px;
    border-radius: 7px; border: 1px solid var(--v2-border); background: var(--v2-surface);
    color: var(--v2-text-muted); cursor: pointer;
}
.day.on { background: var(--v2-primary); border-color: var(--v2-primary); color: #fff; }
.hint { font-size: .72rem; color: var(--v2-text-muted); }

.panel {
    background: var(--v2-surface); border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius); box-shadow: var(--v2-shadow); overflow: hidden;
}
.phead { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--v2-border); }
.phead h3 { margin: 0; font-size: .95rem; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.phead i { color: var(--v2-primary); }
.cnt { margin-left: auto; font-size: .78rem; color: var(--v2-text-muted); font-weight: 600; }

.addrow { display: flex; gap: 9px; padding: 14px 16px; border-bottom: 1px solid var(--v2-border); flex-wrap: wrap; }
.addrow .v2-input { flex: 1; min-width: 170px; }

.tablewrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .85rem; }
th { text-align: left; font-weight: 600; font-size: .75rem; color: var(--v2-text-muted); padding: 10px 16px; border-bottom: 1px solid var(--v2-border); background: #fbfcfe; }
td { padding: 10px 16px; border-bottom: 1px solid #f1f5f9; }
tbody tr:last-child td { border-bottom: none; }
.right, th.right { text-align: right; }
.strong { font-weight: 600; color: var(--v2-text); }
.empty { text-align: center; color: var(--v2-text-muted); padding: 28px 14px; }
.badge { font-size: .72rem; font-weight: 600; padding: 3px 9px; border-radius: 999px; }
.b-bad { background: var(--v2-danger-soft); color: var(--v2-danger); }
.b-muted { background: #eef2f7; color: var(--v2-text-muted); }

.note {
    display: flex; align-items: center; gap: 8px; padding: 11px 16px;
    background: var(--v2-primary-soft); color: #1d4ed8; font-size: .81rem; border-top: 1px solid var(--v2-border);
}
.note a { color: inherit; font-weight: 700; }
</style>
