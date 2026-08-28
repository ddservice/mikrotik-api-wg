<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { apiFetch, activeSiteId, currentUser, token } from '../api.js';
import { formatBytes } from '../format.js';
import { toast } from '../toast.js';

// พรบ. คอมพิวเตอร์ ม.26: hotspot_logs และ dns_query_logs เก็บ 90 วัน (ขั้นต่ำตามกฎหมาย)
// ส่วน pppoe_usage_logs เป็นข้อมูลคิดเงิน เก็บถาวรโดยตั้งใจ ห้ามใส่ auto-purge
const TABS = [
    { key: 'dns', label: 'ประวัติเข้าเว็บ (DNS)', icon: 'fa-solid fa-globe', legal: true },
    { key: 'hotspot', label: 'ประวัติใช้งาน Hotspot', icon: 'fa-solid fa-wifi', legal: true },
    { key: 'pppoe', label: 'สรุปการใช้งาน PPPoE', icon: 'fa-solid fa-door-open' },
    { key: 'activity', label: 'ประวัติการใช้งานระบบ', icon: 'fa-solid fa-user-shield', adminOnly: true }
];

const isAdmin = computed(() => currentUser.value?.role === 'admin');
const visibleTabs = computed(() => TABS.filter((t) => !t.adminOnly || isAdmin.value));

const tab = ref('dns');
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pages = ref(1);
const limit = 100;
const loading = ref(false);
const error = ref('');

const search = ref('');
const username = ref('');
const from = ref('');
const to = ref('');
const month = ref(new Date().toISOString().slice(0, 7));
const pppoeRooms = ref([]);

let requestId = 0;

const ENDPOINTS = {
    dns: '/api/dns-logs',
    hotspot: '/api/hotspot-logs',
    activity: '/api/logs'
};

function buildQuery(extra = {}) {
    const q = new URLSearchParams();
    if (search.value.trim()) q.set('search', search.value.trim());
    if (username.value.trim()) q.set('username', username.value.trim());
    if (from.value) q.set('from', from.value);
    if (to.value) q.set('to', to.value);
    q.set('page', String(page.value));
    q.set('limit', String(limit));
    Object.entries(extra).forEach(([k, v]) => q.set(k, v));
    return q.toString();
}

async function load() {
    const myId = ++requestId;
    loading.value = true;
    error.value = '';
    try {
        if (tab.value === 'pppoe') {
            const res = await apiFetch(`/api/pppoe-usage?month=${encodeURIComponent(month.value)}`);
            if (myId !== requestId) return;
            pppoeRooms.value = (res.rooms || []).sort((a, b) =>
                (b.bytesIn + b.bytesOut) - (a.bytesIn + a.bytesOut)
            );
            total.value = pppoeRooms.value.length;
            pages.value = 1;
        } else {
            const res = await apiFetch(`${ENDPOINTS[tab.value]}?${buildQuery()}`);
            if (myId !== requestId) return;
            rows.value = res.logs || [];
            total.value = res.total || 0;
            pages.value = res.pages || 1;
        }
    } catch (err) {
        if (myId !== requestId) return;
        error.value = err.message;
        rows.value = [];
        pppoeRooms.value = [];
    } finally {
        if (myId === requestId) loading.value = false;
    }
}

onMounted(load);

watch(tab, () => {
    page.value = 1;
    rows.value = [];
    pppoeRooms.value = [];
    load();
});

// สลับสาขา -> โหลดใหม่ทันที (log ฝั่ง server กรองตามสาขาให้อยู่แล้ว)
watch(activeSiteId, () => { page.value = 1; load(); });

function applyFilters() {
    page.value = 1;
    load();
}

function clearFilters() {
    search.value = '';
    username.value = '';
    from.value = '';
    to.value = '';
    page.value = 1;
    load();
}

function goPage(n) {
    if (n < 1 || n > pages.value || n === page.value) return;
    page.value = n;
    load();
}

const CSV_ENDPOINTS = {
    dns: '/api/dns-logs/export-csv',
    hotspot: '/api/hotspot-logs/export-csv',
    activity: '/api/logs/export-csv',
    pppoe: '/api/pppoe-usage/export-csv'
};

const exporting = ref(false);

// ดึงไฟล์ด้วย fetch แล้วสร้าง Blob ให้เบราว์เซอร์เซฟ
//
// ตั้งใจไม่ใช้ window.open(url + '?token=...') เพราะ <a download> แนบ header ไม่ได้
// จึงต้องส่ง token ทาง query ซึ่งจะไปโผล่ใน access log ของ nginx และ Cloudflare
// รวมถึงประวัติเบราว์เซอร์ — session token ไม่ควรอยู่ใน URL เด็ดขาด
// วิธีนี้ token อยู่ใน header เหมือน request อื่น ๆ ทั้งหมด
async function exportCsv() {
    const base = CSV_ENDPOINTS[tab.value];
    if (!base) return toast.error('แท็บนี้ยังไม่รองรับการส่งออก');

    const q = new URLSearchParams();
    if (tab.value === 'pppoe') {
        // /api/pppoe-usage/export-csv ส่งออก session ดิบและรับ from/to ไม่ใช่ month
        // ถ้าส่ง month ไปมันจะถูกเมิน แล้วได้ไฟล์ที่มีทุกเดือนปนกัน
        // จึงแปลงเดือนที่เลือกเป็นช่วงวันที่ให้ตรงกับที่ endpoint เข้าใจ
        const [y, m] = month.value.split('-').map(Number);
        const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
        q.set('from', `${month.value}-01`);
        q.set('to', `${month.value}-${String(lastDay).padStart(2, '0')}`);
    } else {
        if (search.value.trim()) q.set('search', search.value.trim());
        if (username.value.trim()) q.set('username', username.value.trim());
        if (from.value) q.set('from', from.value);
        if (to.value) q.set('to', to.value);
    }

    exporting.value = true;
    try {
        const headers = { Authorization: `Bearer ${token.value}` };
        if (activeSiteId.value) headers['X-Site-Id'] = activeSiteId.value;
        const res = await fetch(`${base}?${q.toString()}`, { headers });
        if (!res.ok) throw new Error(`ส่งออกไม่สำเร็จ (HTTP ${res.status})`);

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${tab.value}-logs-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        toast.success('ส่งออก CSV เรียบร้อย — ตรวจดูที่โฟลเดอร์ดาวน์โหลด');
    } catch (err) {
        toast.error(err.message);
    } finally {
        exporting.value = false;
    }
}

function fmtTime(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'medium' });
}

const pageWindow = computed(() => {
    const out = [];
    const start = Math.max(1, page.value - 2);
    const end = Math.min(pages.value, start + 4);
    for (let i = start; i <= end; i++) out.push(i);
    return out;
});
</script>

<template>
    <div class="head">
        <div>
            <h1>ประวัติการใช้งาน</h1>
            <p>บันทึกการเข้าเว็บ การใช้งาน Hotspot/PPPoE และการกระทำของผู้ดูแลระบบ</p>
        </div>
        <button type="button" class="v2-btn ghost" :disabled="loading || exporting" @click="exportCsv">
            <i class="fa-solid" :class="exporting ? 'fa-spinner fa-spin' : 'fa-file-csv'"></i>
            {{ exporting ? 'กำลังเตรียมไฟล์...' : 'ส่งออก CSV' }}
        </button>
    </div>

    <div class="v2-callout info">
        <i class="fa-solid fa-scale-balanced"></i>
        <span>
            <strong>พรบ. คอมพิวเตอร์ มาตรา 26:</strong>
            ประวัติเข้าเว็บและการใช้งาน Hotspot เก็บย้อนหลัง <strong>90 วัน</strong> (ขั้นต่ำตามกฎหมาย) —
            บันทึกเฉพาะระดับชื่อโดเมน ไม่เก็บเนื้อหา ·
            สรุปการใช้งาน PPPoE เป็นข้อมูลคิดเงิน เก็บถาวรไม่มีลบอัตโนมัติ
        </span>
    </div>

    <div class="tabs">
        <button
            v-for="t in visibleTabs"
            :key="t.key"
            type="button"
            class="tab"
            :class="{ on: tab === t.key }"
            @click="tab = t.key"
        >
            <i :class="t.icon"></i> {{ t.label }}
            <span v-if="t.legal" class="legal" title="เก็บตามกฎหมาย 90 วัน">ม.26</span>
        </button>
    </div>

    <!-- ตัวกรอง -->
    <div class="filters">
        <template v-if="tab === 'pppoe'">
            <div class="fld">
                <label>เดือน</label>
                <input v-model="month" type="month" class="v2-input" @change="load">
            </div>
        </template>
        <template v-else>
            <div class="fld grow">
                <label>ค้นหา</label>
                <input
                    v-model="search"
                    class="v2-input"
                    :placeholder="tab === 'dns' ? 'โดเมน, IP, MAC...' : (tab === 'activity' ? 'การกระทำ, รายละเอียด...' : 'username, IP, MAC...')"
                    @keyup.enter="applyFilters"
                >
            </div>
            <div v-if="tab !== 'activity'" class="fld">
                <label>ชื่อผู้ใช้</label>
                <input v-model="username" class="v2-input" placeholder="เช่น rm204" @keyup.enter="applyFilters">
            </div>
            <div class="fld">
                <label>ตั้งแต่</label>
                <input v-model="from" type="date" class="v2-input">
            </div>
            <div class="fld">
                <label>ถึง</label>
                <input v-model="to" type="date" class="v2-input">
            </div>
            <div class="fld btns">
                <button type="button" class="v2-btn primary" :disabled="loading" @click="applyFilters">
                    <i class="fa-solid" :class="loading ? 'fa-spinner fa-spin' : 'fa-magnifying-glass'"></i> ค้นหา
                </button>
                <button type="button" class="v2-btn ghost" :disabled="loading" @click="clearFilters">ล้าง</button>
            </div>
        </template>
        <span class="result v2-num">
            {{ tab === 'pppoe' ? pppoeRooms.length + ' ห้อง' : total.toLocaleString('th-TH') + ' รายการ' }}
        </span>
    </div>

    <div v-if="error" class="alert"><i class="fa-solid fa-triangle-exclamation"></i> {{ error }}</div>

    <div class="panel">
        <div class="tablewrap">
            <!-- DNS -->
            <table v-if="tab === 'dns'">
                <thead>
                    <tr>
                        <th>เวลา</th><th>ผู้ใช้</th><th>IP</th><th>MAC</th><th>โดเมนที่เข้า</th><th>สาขา</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-if="!rows.length"><td colspan="6" class="empty">{{ loading ? 'กำลังโหลด...' : 'ไม่พบข้อมูล' }}</td></tr>
                    <tr v-for="r in rows" :key="r.id">
                        <td class="v2-num nowrap">{{ fmtTime(r.queryTime) }}</td>
                        <td class="strong">{{ r.username || '—' }}</td>
                        <td class="v2-num">{{ r.ipAddress || '—' }}</td>
                        <td class="v2-num mono">{{ r.macAddress || '—' }}</td>
                        <td class="domain">{{ r.domain }}</td>
                        <td class="sub">{{ r.siteName || '—' }}</td>
                    </tr>
                </tbody>
            </table>

            <!-- Hotspot -->
            <table v-else-if="tab === 'hotspot'">
                <thead>
                    <tr>
                        <th>เข้าใช้งาน</th><th>ออกจากระบบ</th><th>ผู้ใช้</th><th>IP</th><th>MAC</th>
                        <th class="num">เวลาใช้</th><th class="num">ดาวน์โหลด</th><th class="num">อัปโหลด</th><th>สาขา</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-if="!rows.length"><td colspan="9" class="empty">{{ loading ? 'กำลังโหลด...' : 'ไม่พบข้อมูล' }}</td></tr>
                    <tr v-for="r in rows" :key="r.id">
                        <td class="v2-num nowrap">{{ fmtTime(r.loginTime) }}</td>
                        <td class="v2-num nowrap sub">{{ r.logoutTime ? fmtTime(r.logoutTime) : 'ยังเชื่อมต่ออยู่' }}</td>
                        <td class="strong">{{ r.username }}</td>
                        <td class="v2-num">{{ r.ipAddress || '—' }}</td>
                        <td class="v2-num mono">{{ r.macAddress || '—' }}</td>
                        <td class="num v2-num">{{ r.uptime || '—' }}</td>
                        <td class="num v2-num">{{ formatBytes(r.bytesIn) }}</td>
                        <td class="num v2-num">{{ formatBytes(r.bytesOut) }}</td>
                        <td class="sub">{{ r.siteName || '—' }}</td>
                    </tr>
                </tbody>
            </table>

            <!-- PPPoE สรุปรายเดือน -->
            <table v-else-if="tab === 'pppoe'">
                <thead>
                    <tr><th>ห้อง</th><th class="num">ดาวน์โหลด</th><th class="num">อัปโหลด</th><th class="num">รวม</th></tr>
                </thead>
                <tbody>
                    <tr v-if="!pppoeRooms.length"><td colspan="4" class="empty">{{ loading ? 'กำลังโหลด...' : 'ไม่มีข้อมูลในเดือนนี้' }}</td></tr>
                    <tr v-for="r in pppoeRooms" :key="r.username">
                        <td class="strong">{{ r.username }}</td>
                        <td class="num v2-num">{{ formatBytes(r.bytesIn) }}</td>
                        <td class="num v2-num">{{ formatBytes(r.bytesOut) }}</td>
                        <td class="num v2-num strong">{{ formatBytes(r.bytesIn + r.bytesOut) }}</td>
                    </tr>
                </tbody>
            </table>

            <!-- Activity (admin เท่านั้น) -->
            <table v-else>
                <thead>
                    <tr><th>เวลา</th><th>ผู้ใช้</th><th>การกระทำ</th><th>รายละเอียด</th></tr>
                </thead>
                <tbody>
                    <tr v-if="!rows.length"><td colspan="4" class="empty">{{ loading ? 'กำลังโหลด...' : 'ไม่พบข้อมูล' }}</td></tr>
                    <tr v-for="(r, i) in rows" :key="i">
                        <td class="v2-num nowrap">{{ fmtTime(r.timestamp) }}</td>
                        <td class="strong">{{ r.username }}</td>
                        <td>{{ r.action }}</td>
                        <td class="sub">{{ r.details }}</td>
                    </tr>
                </tbody>
            </table>
        </div>

        <div v-if="tab !== 'pppoe' && pages > 1" class="pager">
            <button type="button" class="v2-btn ghost sm" :disabled="page === 1 || loading" @click="goPage(page - 1)">
                <i class="fa-solid fa-chevron-left"></i> ก่อนหน้า
            </button>
            <button
                v-for="n in pageWindow"
                :key="n"
                type="button"
                class="v2-btn sm"
                :class="n === page ? 'primary' : 'ghost'"
                :disabled="loading"
                @click="goPage(n)"
            >{{ n }}</button>
            <button type="button" class="v2-btn ghost sm" :disabled="page === pages || loading" @click="goPage(page + 1)">
                ถัดไป <i class="fa-solid fa-chevron-right"></i>
            </button>
            <span class="pageinfo v2-num">หน้า {{ page }} / {{ pages }}</span>
        </div>
    </div>
</template>

<style scoped>
.head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
.head h1 { margin: 0; font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; }
.head p { margin: 3px 0 0; font-size: .85rem; color: var(--v2-text-muted); }

.tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--v2-border); margin: 16px 0; overflow-x: auto; }
.tab {
    display: inline-flex; align-items: center; gap: 8px; font: inherit; font-size: .86rem; font-weight: 600;
    color: var(--v2-text-muted); background: none; border: none; border-bottom: 2px solid transparent;
    padding: 10px 14px; cursor: pointer; white-space: nowrap;
}
.tab.on { color: var(--v2-primary); border-bottom-color: var(--v2-primary); }
.legal {
    font-size: .62rem; font-weight: 700; background: #fef3c7; color: #b45309;
    padding: 1px 6px; border-radius: 999px; letter-spacing: .02em;
}

.filters {
    display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; margin-bottom: 14px;
    background: var(--v2-surface); border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius); padding: 14px 16px;
}
.fld { display: flex; flex-direction: column; gap: 5px; }
.fld.grow { flex: 1; min-width: 200px; }
.fld > label { font-size: .74rem; font-weight: 600; color: var(--v2-text-muted); }
.fld.btns { flex-direction: row; gap: 8px; }
.result { font-size: .8rem; color: var(--v2-text-muted); font-weight: 600; margin-left: auto; align-self: center; }

.alert {
    background: var(--v2-danger-soft); border: 1px solid #fecaca; color: var(--v2-danger);
    padding: 11px 15px; border-radius: 10px; font-size: .86rem; margin-bottom: 14px;
}

.panel {
    background: var(--v2-surface); border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius); box-shadow: var(--v2-shadow); overflow: hidden;
}
.tablewrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .84rem; }
th {
    text-align: left; font-weight: 600; font-size: .75rem; color: var(--v2-text-muted);
    padding: 10px 13px; border-bottom: 1px solid var(--v2-border); white-space: nowrap; background: #fbfcfe;
}
td { padding: 9px 13px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover td { background: #fbfcfe; }
.num, th.num { text-align: right; }
.nowrap { white-space: nowrap; }
.strong { font-weight: 600; color: var(--v2-text); }
.sub { font-size: .78rem; color: var(--v2-text-muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .77rem; }
.domain { word-break: break-all; max-width: 420px; }
.empty { text-align: center; color: var(--v2-text-muted); padding: 34px 14px; }

.pager {
    display: flex; align-items: center; gap: 6px; padding: 12px 16px;
    border-top: 1px solid var(--v2-border); flex-wrap: wrap; background: #fbfcfe;
}
.pageinfo { margin-left: auto; font-size: .78rem; color: var(--v2-text-muted); font-weight: 600; }
</style>
