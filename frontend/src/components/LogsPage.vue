<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { apiFetch, activeSiteId, currentUser, token, sites, loadSites } from '../api.js';
import { formatBytes } from '../format.js';
import { toast } from '../toast.js';

// พรบ. คอมพิวเตอร์ ม.26: hotspot_logs และ dns_query_logs เก็บ 90 วัน (ขั้นต่ำตามกฎหมาย)
// ส่วน pppoe_usage_logs เป็นข้อมูลคิดเงิน เก็บถาวรโดยตั้งใจ ห้ามใส่ auto-purge
const TABS = [
    { key: 'dns', label: 'ประวัติเข้าเว็บ (DNS)', icon: 'fa-solid fa-globe', legal: true },
    { key: 'hotspot', label: 'ประวัติใช้งาน Hotspot', icon: 'fa-solid fa-wifi', legal: true },
    { key: 'pppoe', label: 'สรุปการใช้งาน PPPoE', icon: 'fa-solid fa-door-open' },
    { key: 'activity', label: 'ประวัติการใช้งานระบบ', icon: 'fa-solid fa-user-shield', adminOnly: true },
    { key: 'archives', label: 'ไฟล์ปิดผนึก (SHA-256)', icon: 'fa-solid fa-file-shield', seal: true }
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

// ช่วงที่ขอกว้างเกินกว่าที่ระบบยอมอ่านในครั้งเดียว -> ผลลัพธ์บนจอไม่ครบ
// ต้องบอกให้เห็น ไม่ใช่ปล่อยให้ข้อมูลที่ขาดดูเหมือนข้อมูลที่ครบ
const truncated = ref(false);
const scannedDays = ref(0);

const search = ref('');
const username = ref('');
const from = ref('');
const to = ref('');
const month = ref(new Date().toISOString().slice(0, 7));
const pppoeRooms = ref([]);

// ---------- ตัวกรองสาขา ----------
// log ไม่ได้ถูกกรองด้วยตัวเลือกสาขาด้านบนโดยอัตโนมัติ เพราะเป็นแถวในฐานข้อมูล
// ที่ติดป้ายชื่อสาขาไว้ ไม่ใช่การยิงไปเราท์เตอร์ (header X-Site-Id จึงไม่มีผล)
// ฝั่ง server กรองให้ก็ต่อเมื่อส่ง ?site=<ชื่อสาขา> ไปเท่านั้น
//
// ตั้งค่าเริ่มต้นเป็นสาขาที่เลือกอยู่ ให้ตรงกับที่ตัวเลือกด้านบนบอก แต่ทำเป็น
// dropdown ที่มองเห็นได้ ไม่ใช่กรองเงียบ ๆ แบบหน้าเดิม — ผู้ใช้ต้องรู้ว่ากำลังดูของสาขาไหน
// และต้องเลือก "ทุกสาขา" ได้ เพราะการส่งข้อมูลตาม ม.26 บางครั้งขอมาทั้งระบบ
const siteFilter = ref('');          // '' = ทุกสาขา, อื่น ๆ = ชื่อสาขา
const siteFilterReady = ref(false);

// ประวัติการใช้งานระบบเป็นการกระทำของผู้ดูแล (ใครกดอะไร) ไม่ได้ผูกกับสาขา
// ตาราง activity_logs ไม่มีคอลัมน์สาขาเลย จึงกรองไม่ได้จริง ๆ ไม่ใช่แค่ยังไม่ได้ทำ
const SITE_FILTERABLE = ['dns', 'hotspot', 'pppoe'];
const canFilterSite = computed(() => SITE_FILTERABLE.includes(tab.value));

async function primeSiteFilter() {
    try {
        await loadSites();
        const cur = sites.value.find((s) => s.id === activeSiteId.value);
        siteFilter.value = cur ? cur.name : '';
    } catch (_) {
        // อ่านรายชื่อสาขาไม่ได้ = ไม่มี dropdown ให้เลือก แต่ยังดู log รวมได้ตามปกติ
    } finally {
        siteFilterReady.value = true;
    }
}

// ไฟล์ปิดผนึกรายวัน
const archives = ref([]);
const verifyResults = ref({});   // id -> ผลการตรวจ
const archiveBusy = ref('');

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
    if (canFilterSite.value && siteFilter.value) q.set('site', siteFilter.value);
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
        if (tab.value === 'archives') {
            const res = await apiFetch(`/api/mikrotik/log-archives?page=${page.value}&limit=${limit}`);
            if (myId !== requestId) return;
            archives.value = res.archives || [];
            total.value = res.total || 0;
            pages.value = res.pages || 1;
        } else if (tab.value === 'pppoe') {
            const sq = siteFilter.value ? `&site=${encodeURIComponent(siteFilter.value)}` : '';
            const res = await apiFetch(`/api/pppoe-usage?month=${encodeURIComponent(month.value)}${sq}`);
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
            truncated.value = !!res.truncated;
            scannedDays.value = res.scannedDays || 0;
        }
    } catch (err) {
        if (myId !== requestId) return;
        error.value = err.message;
        rows.value = [];
        pppoeRooms.value = [];
        archives.value = [];
    } finally {
        if (myId === requestId) loading.value = false;
    }
}

onMounted(async () => {
    // ต้องรู้ชื่อสาขาก่อนยิงครั้งแรก ไม่งั้นครั้งแรกจะได้ทุกสาขาแล้วค่อยกระพริบเป็นสาขาเดียว
    await primeSiteFilter();
    load();
});

watch(tab, () => {
    page.value = 1;
    rows.value = [];
    pppoeRooms.value = [];
    archives.value = [];
    verifyResults.value = {};
    load();
});

// สลับสาขาด้านบน -> เลื่อนตัวกรองตาม แล้วโหลดใหม่
// ถ้าผู้ใช้ตั้งไว้เป็น "ทุกสาขา" เองก็เคารพค่านั้น ไม่ดึงกลับมาเป็นสาขาเดียว
watch(activeSiteId, () => {
    if (siteFilter.value) {
        const cur = sites.value.find((s) => s.id === activeSiteId.value);
        siteFilter.value = cur ? cur.name : siteFilter.value;
    }
    page.value = 1;
    load();
});

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
    // ไฟล์ที่ได้ต้องตรงกับที่เห็นบนจอ — ส่งออกได้ทุกสาขาทั้งที่หน้าจอกรองไว้สาขาเดียว
    // เป็นความผิดพลาดที่มองไม่เห็นจนกว่าจะเปิดไฟล์ และร้ายแรงถ้าเป็นเอกสารส่งตาม ม.26
    if (canFilterSite.value && siteFilter.value) q.set('site', siteFilter.value);

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

async function verifyArchive(a) {
    archiveBusy.value = a.id;
    try {
        const res = await apiFetch(`/api/mikrotik/log-archives/${encodeURIComponent(a.id)}/verify`, { method: 'POST' });
        verifyResults.value = { ...verifyResults.value, [a.id]: res };
        if (res.ok) toast.success(`${a.fileName} — ค่า SHA-256 ตรงกับตอนสร้าง ไฟล์ไม่ถูกแก้`);
        else toast.error(`${a.fileName} — ค่า SHA-256 ไม่ตรง! ไฟล์ถูกแก้หรือเสียหาย`);
    } catch (err) {
        toast.error(err.message);
    } finally {
        archiveBusy.value = '';
    }
}

// ดาวน์โหลดผ่าน fetch + Blob เหมือน CSV — ไม่ส่ง token ทาง URL
async function downloadArchive(a) {
    archiveBusy.value = a.id;
    try {
        const res = await fetch(`/api/mikrotik/log-archives/${encodeURIComponent(a.id)}/download`, {
            headers: { Authorization: `Bearer ${token.value}` }
        });
        if (!res.ok) throw new Error(`ดาวน์โหลดไม่สำเร็จ (HTTP ${res.status})`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const el = document.createElement('a');
        el.href = url;
        el.download = a.fileName;
        document.body.appendChild(el);
        el.click();
        el.remove();
        URL.revokeObjectURL(url);
        toast.success('ดาวน์โหลดแล้ว — ตรวจสอบด้วย sha256sum ' + a.fileName);
    } catch (err) {
        toast.error(err.message);
    } finally {
        archiveBusy.value = '';
    }
}

async function copyHash(a) {
    try {
        await navigator.clipboard.writeText(a.sha256);
        toast.success('คัดลอกค่า SHA-256 แล้ว');
    } catch (_) {
        toast.error('คัดลอกไม่สำเร็จ — เบราว์เซอร์ไม่อนุญาต');
    }
}

const runningArchive = ref(false);
async function runArchiveNow() {
    if (!window.confirm([
        'สร้างไฟล์ปิดผนึกย้อนหลัง 30 วัน?',
        '',
        'ระบบจะปิดวันที่ยังไม่ได้ทำ และข้ามวันที่ทำไปแล้ว',
        'ปกติงานนี้รันเองทุกคืนตอน 02:00 — ใช้ปุ่มนี้ตอนเปิดใช้ครั้งแรกหรือเมื่อคืนรันไม่สำเร็จ'
    ].join('\n'))) return;

    runningArchive.value = true;
    try {
        await apiFetch('/api/mikrotik/log-archives/run', { method: 'POST', body: JSON.stringify({ days: 30 }) });
        toast.success('สร้างไฟล์ปิดผนึกเรียบร้อย');
        await load();
    } catch (err) {
        toast.error(err.message);
    } finally {
        runningArchive.value = false;
    }
}

function fmtSize(n) {
    if (!n) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(i ? 1 : 0) + ' ' + u[i];
}

const TYPE_LABEL = { dns: 'ประวัติเข้าเว็บ (DNS)', hotspot: 'ประวัติใช้งาน Hotspot' };

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
        <button
            v-if="tab === 'archives'" type="button" class="v2-btn ghost"
            :disabled="runningArchive" @click="runArchiveNow"
        >
            <i class="fa-solid" :class="runningArchive ? 'fa-spinner fa-spin' : 'fa-file-shield'"></i>
            {{ runningArchive ? 'กำลังสร้าง...' : 'สร้างย้อนหลัง 30 วัน' }}
        </button>
        <button v-else type="button" class="v2-btn ghost" :disabled="loading || exporting" @click="exportCsv">
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
            <span v-if="t.seal" class="seal" title="ไฟล์ปิดผนึกพร้อมค่าตรวจสอบ">SHA-256</span>
        </button>
    </div>

    <!-- ตัวกรอง -->
    <div v-if="tab !== 'archives'" class="filters">
        <div v-if="canFilterSite && sites.length > 1" class="fld">
            <label>สาขา</label>
            <select v-model="siteFilter" class="v2-input" @change="applyFilters">
                <option value="">ทุกสาขา</option>
                <option v-for="s in sites" :key="s.id" :value="s.name">{{ s.name }}</option>
            </select>
        </div>

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
            <span v-if="canFilterSite" class="scope">{{ siteFilter || 'ทุกสาขา' }}</span>
            <span v-else-if="tab === 'activity'" class="scope">ทั้งระบบ</span>
        </span>
    </div>

    <div v-if="tab === 'activity'" class="v2-callout info sitenote">
        <i class="fa-solid fa-circle-info"></i>
        <span>
            ประวัติการใช้งานระบบเป็นการกระทำของผู้ดูแล (ใครกดอะไร เมื่อไหร่) จึงไม่ผูกกับสาขา
            และแยกตามสาขาไม่ได้ — ถ้าต้องการดูแยกสาขา ให้ใช้สามแท็บแรก
        </span>
    </div>

    <div v-if="truncated" class="v2-callout warn sitenote">
        <i class="fa-solid fa-triangle-exclamation"></i>
        <span>
            <strong>ผลลัพธ์บนหน้านี้ไม่ครบ</strong> — ช่วงวันที่ขอกว้างเกินกว่าที่ระบบอ่านในครั้งเดียว
            จึงอ่านเฉพาะ {{ scannedDays }} วันล่าสุดของช่วงนั้น ยอดรวมที่แสดงจึงนับไม่ครบด้วย
            <br>
            ให้ค้นทีละช่วงสั้นลง หรือถ้าต้องการข้อมูลครบทั้งช่วงเพื่อใช้เป็นหลักฐาน
            <strong>ให้กด "ส่งออก CSV"</strong> ซึ่งอ่านครบทุกวันที่ขอเสมอ ไม่มีการตัด
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

            <!-- ไฟล์ปิดผนึกรายวัน -->
            <table v-else-if="tab === 'archives'">
                <thead>
                    <tr>
                        <th>วันที่</th><th>ชนิด</th><th class="num">จำนวน</th><th class="num">ขนาด</th>
                        <th>SHA-256</th><th>ที่เก็บ</th><th class="right">จัดการ</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-if="!archives.length">
                        <td colspan="7" class="empty">
                            {{ loading ? 'กำลังโหลด...' : 'ยังไม่มีไฟล์ปิดผนึก — กดปุ่มสร้างย้อนหลังเพื่อเริ่มต้น' }}
                        </td>
                    </tr>
                    <tr v-for="a in archives" :key="a.id">
                        <td class="v2-num nowrap strong">{{ a.archiveDate }}</td>
                        <td>{{ TYPE_LABEL[a.logType] || a.logType }}</td>
                        <td class="num v2-num">{{ (a.recordCount || 0).toLocaleString('th-TH') }}</td>
                        <td class="num v2-num">{{ fmtSize(a.fileSize) }}</td>
                        <td>
                            <button type="button" class="hash" :title="a.sha256" @click="copyHash(a)">
                                {{ a.sha256.slice(0, 10) }}…{{ a.sha256.slice(-6) }}
                                <i class="fa-solid fa-copy"></i>
                            </button>
                            <div v-if="verifyResults[a.id]" class="vres" :class="verifyResults[a.id].ok ? 'ok' : 'bad'">
                                <i class="fa-solid" :class="verifyResults[a.id].ok ? 'fa-circle-check' : 'fa-circle-xmark'"></i>
                                {{ verifyResults[a.id].ok ? 'ตรวจแล้ว ไฟล์ไม่ถูกแก้' : 'ไฟล์ถูกแก้หรือเสียหาย!' }}
                                <span class="sub">({{ verifyResults[a.id].checks.map(c => c.source).join(', ') }})</span>
                            </div>
                        </td>
                        <td>
                            <span class="loc" :class="{ dim: !a.storageLocal }">VPS</span>
                            <span class="loc" :class="{ dim: !a.storageR2Key }">R2</span>
                        </td>
                        <td class="right">
                            <div class="rowbtns">
                                <button type="button" class="v2-btn ghost sm" :disabled="archiveBusy === a.id" @click="verifyArchive(a)">
                                    <i class="fa-solid" :class="archiveBusy === a.id ? 'fa-spinner fa-spin' : 'fa-shield-halved'"></i> ตรวจสอบ
                                </button>
                                <button type="button" class="v2-btn ghost sm" :disabled="archiveBusy === a.id" @click="downloadArchive(a)">
                                    <i class="fa-solid fa-download"></i>
                                </button>
                            </div>
                        </td>
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

        <div v-if="tab === 'archives'" class="howto">
            <i class="fa-solid fa-circle-info"></i>
            <span>
                <strong>วิธีพิสูจน์ว่าไฟล์ไม่ถูกแก้:</strong> ดาวน์โหลดไฟล์ แล้วรัน
                <code>sha256sum &lt;ชื่อไฟล์&gt;</code> บนเครื่องตัวเอง เทียบกับค่าในตารางนี้ —
                ตรงกันแปลว่าเป็นชุดเดียวกับที่ระบบปิดผนึกไว้ตอนสิ้นวัน ·
                ปุ่ม "ตรวจสอบ" ให้ระบบอ่านไฟล์จริงแล้วคำนวณค่าใหม่ทั้งบน VPS และ R2 ·
                ระบบปิดวันอัตโนมัติทุกคืน 02:00 และปิดเฉพาะวันที่ผ่านไปแล้ว
            </span>
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
/* บอกขอบเขตของตัวเลขไว้ข้าง ๆ กันเข้าใจผิดว่า "2.9 ล้านรายการ" คือของสาขาเดียว */
.scope {
    display: inline-block; margin-left: 7px; padding: 2px 9px; border-radius: 999px;
    background: var(--v2-primary-soft); color: var(--v2-primary); font-size: .72rem; font-weight: 700;
}
.sitenote { margin-bottom: 14px; }

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

.seal {
    font-size: .6rem; font-weight: 700; background: #ecfdf3; color: #15803d;
    padding: 1px 6px; border-radius: 999px; letter-spacing: .02em;
}
.rowbtns { display: inline-flex; gap: 5px; justify-content: flex-end; }
.hash {
    font: inherit; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .76rem;
    background: var(--v2-bg); border: 1px solid var(--v2-border); border-radius: 6px;
    padding: 3px 8px; cursor: pointer; color: var(--v2-text-soft);
    display: inline-flex; align-items: center; gap: 6px;
}
.hash:hover { border-color: var(--v2-primary); color: var(--v2-primary); }
.hash i { font-size: .68rem; opacity: .6; }
.vres { font-size: .74rem; margin-top: 4px; display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.vres.ok { color: var(--v2-success); }
.vres.bad { color: var(--v2-danger); font-weight: 600; }
.loc {
    display: inline-block; font-size: .66rem; font-weight: 700; padding: 2px 7px;
    border-radius: 999px; background: #dcfce7; color: #15803d; margin-right: 4px;
}
.loc.dim { background: #f1f5f9; color: #cbd5e1; }
.howto {
    display: flex; gap: 9px; padding: 12px 16px; background: var(--v2-primary-soft);
    color: #1d4ed8; font-size: .79rem; line-height: 1.6; border-top: 1px solid var(--v2-border);
}
.howto i { margin-top: 3px; flex-shrink: 0; }
.howto code { background: rgba(255,255,255,.7); padding: 1px 5px; border-radius: 4px; font-family: ui-monospace, monospace; }
</style>
