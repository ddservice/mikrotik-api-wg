<script setup>
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { apiFetch, activeSiteId, setActiveSiteId, sites, loadSites } from '../api.js';
import { toast } from '../toast.js';
import SiteModal from './SiteModal.vue';
import RouterOpsPanel from './RouterOpsPanel.vue';
import SiteDiagnosticsModal from './SiteDiagnosticsModal.vue';
import WireguardSetupModal from './WireguardSetupModal.vue';

const TABS = [
    { key: 'sites', label: 'สาขา / เราท์เตอร์', icon: 'fa-solid fa-network-wired' },
    { key: 'telegram', label: 'แจ้งเตือนแอดมิน (Telegram)', icon: 'fa-brands fa-telegram' },
    { key: 'line', label: 'แจ้งเตือนลูกค้า (LINE OA)', icon: 'fa-brands fa-line' },
    { key: 'storage', label: 'พื้นที่เก็บข้อมูล', icon: 'fa-solid fa-hard-drive' },
    { key: 'ops', label: 'จัดการเราท์เตอร์', icon: 'fa-solid fa-screwdriver-wrench' }
];

const tab = ref('sites');

// ---------- สาขา ----------
const siteStatus = ref({});      // siteId -> 'checking' | 'online' | 'offline'
const loadingSites = ref(false);
const siteModalOpen = ref(false);
const editingSite = ref(null);
const busySite = ref('');

// สถานะ peer จริงบน wg0 ของ VPS — ตอบคำถาม "สาขานี้เคยต่อเข้ามาไหม และล่าสุดเมื่อไหร่"
// ซึ่งเป็นคนละเรื่องกับ "API ล็อกอินผ่านไหม" ตอนสาขาล่มต้องแยกสองอย่างนี้ให้ออก
const wgPeers = ref({});

async function loadWgPeers() {
    try {
        wgPeers.value = await apiFetch('/api/wireguard/all-peers-status');
    } catch (_) {
        // อ่าน wg ไม่ได้ (สิทธิ์ หรือรันนอก VPS) — ไม่ใช่ความผิดพลาดของหน้านี้ แค่ไม่มีข้อมูลจะโชว์
        wgPeers.value = {};
    }
}

function wgPeerOf(s) {
    return s.wireguardIp ? wgPeers.value[s.wireguardIp] || null : null;
}

// แปลงวินาทีเป็นข้อความสั้น ๆ — handshake เก่ากว่า ~3 นาทีแปลว่าอุโมงค์เงียบไปแล้ว
function handshakeText(sec) {
    if (sec === null || sec === undefined) return 'ไม่เคยจับมือ';
    if (sec < 90) return `จับมือล่าสุด ${sec} วินาทีที่แล้ว`;
    if (sec < 3600) return `จับมือล่าสุด ${Math.floor(sec / 60)} นาทีที่แล้ว`;
    if (sec < 86400) return `จับมือล่าสุด ${Math.floor(sec / 3600)} ชม. ที่แล้ว`;
    return `จับมือล่าสุด ${Math.floor(sec / 86400)} วันที่แล้ว`;
}

// โหลดรายชื่อสาขาใหม่จาก state กลาง — dropdown ด้านบนของแอปเห็นผลทันทีด้วย
async function reloadSites() {
    loadingSites.value = true;
    try {
        await loadSites({ force: true });
        loadWgPeers();
        checkAll();
    } catch (err) {
        toast.error('โหลดรายชื่อสาขาไม่สำเร็จ: ' + err.message);
    } finally {
        loadingSites.value = false;
    }
}

// เช็คสถานะทีละสาขาแบบขนาน — สาขาที่ล่มจะรอ connect timeout ~10 วิ
// ถ้าเช็คเรียงกันทีละตัวจะรอรวมกันนานมากเมื่อมีหลายสาขาล่มพร้อมกัน
function checkAll() {
    sites.value.forEach((s) => {
        siteStatus.value[s.id] = 'checking';
        apiFetch('/api/mikrotik/test-connection?siteId=' + encodeURIComponent(s.id))
            .then(() => { siteStatus.value[s.id] = 'online'; })
            .catch(() => { siteStatus.value[s.id] = 'offline'; });
    });
}

// วินิจฉัย + ตั้งค่า WireGuard — สองอย่างนี้เดิมมีแต่ในหน้าเก่า ทำให้ v2 เปิดสาขาใหม่
// และแก้ปัญหาสาขาล่มเองไม่ได้ ซึ่งเป็นสองในสี่ขั้นของวงจรชีวิตสาขา
const diagOpen = ref(false);
const diagSite = ref(null);
const diagRef = ref(null);
const wgOpen = ref(false);
const wgSite = ref(null);

function openDiagnose(s) {
    diagSite.value = s;
    diagOpen.value = true;
    // เริ่มตรวจให้เลย ไม่ต้องกดซ้ำ — คนเปิดหน้านี้ตอนสาขาล่มอยู่แล้ว
    nextTick(() => diagRef.value && diagRef.value.run());
}

function openWireguard(s) {
    wgSite.value = s;
    wgOpen.value = true;
}

// เพิ่มสาขา WireGuard เสร็จแล้วเปิดขั้นถัดไปให้เลย — สาขายังใช้งานไม่ได้จนกว่าจะรัน
// สคริปต์บนเราท์เตอร์ การหยุดแค่ "บันทึกแล้ว" ทำให้คนคิดว่าเสร็จแล้วทั้งที่ยังไม่เสร็จ
async function onSiteSaved(info) {
    await reloadSites();
    const ip = info && info.newWireguardIp;
    if (!ip) return;
    const created = sites.value.find((x) => x.wireguardIp === ip || x.host === ip);
    if (!created) return;
    wgSite.value = created;
    wgOpen.value = true;
}

function openAddSite() {
    editingSite.value = null;
    siteModalOpen.value = true;
}

function openEditSite(s) {
    editingSite.value = s;
    siteModalOpen.value = true;
}

async function removeSite(s) {
    if (!window.confirm([
        `ลบสาขา "${s.name}" ออกจากระบบ?`,
        '',
        'ประวัติการใช้งานที่บันทึกไว้แล้วจะยังอยู่ครบ',
        'แต่จะไม่มีการเก็บ log ใหม่จากสาขานี้อีก'
    ].join('\n'))) return;

    busySite.value = s.id;
    try {
        await apiFetch('/api/sites/' + encodeURIComponent(s.id), { method: 'DELETE' });
        toast.success(`ลบสาขา "${s.name}" แล้ว`);
        await reloadSites();
    } catch (err) {
        toast.error('ลบไม่สำเร็จ: ' + err.message);
    } finally {
        busySite.value = '';
    }
}

// ---------- Telegram ----------
const tg = ref({ enabled: false, hasBotToken: false, botTokenPreview: '', chatId: '', alertOffline: true, alertOnline: true, alertStorage: true, alertHealth: true });
const tgToken = ref('');
const tgBusy = ref('');
const tgChats = ref(null);

async function loadTelegram() {
    try {
        tg.value = await apiFetch('/api/mikrotik/telegram-alert/config');
    } catch (err) {
        toast.error('โหลดการตั้งค่า Telegram ไม่สำเร็จ: ' + err.message);
    }
}

function tgPayload() {
    const body = {
        enabled: tg.value.enabled,
        chatId: String(tg.value.chatId || '').trim(),
        alertOffline: tg.value.alertOffline,
        alertOnline: tg.value.alertOnline,
        alertStorage: tg.value.alertStorage,
        alertHealth: tg.value.alertHealth
    };
    // ส่ง token เฉพาะตอนกรอกใหม่ ช่องว่าง = ใช้ตัวเดิมที่บันทึกไว้
    if (tgToken.value.trim()) body.botToken = tgToken.value.trim();
    return body;
}

async function saveTelegram() {
    tgBusy.value = 'save';
    try {
        tg.value = await apiFetch('/api/mikrotik/telegram-alert/config', {
            method: 'POST',
            body: JSON.stringify(tgPayload())
        });
        tgToken.value = '';
        toast.success('บันทึกการตั้งค่า Telegram แล้ว');
    } catch (err) {
        toast.error(err.message);
    } finally {
        tgBusy.value = '';
    }
}

async function testTelegram() {
    tgBusy.value = 'test';
    try {
        const body = { chatId: String(tg.value.chatId || '').trim() };
        if (tgToken.value.trim()) body.botToken = tgToken.value.trim();
        const res = await apiFetch('/api/mikrotik/telegram-alert/test', { method: 'POST', body: JSON.stringify(body) });
        toast.success(res.message || 'ส่งข้อความทดสอบแล้ว');
    } catch (err) {
        toast.error(err.message);
    } finally {
        tgBusy.value = '';
    }
}

async function discoverChats() {
    tgBusy.value = 'discover';
    tgChats.value = null;
    try {
        const body = {};
        if (tgToken.value.trim()) body.botToken = tgToken.value.trim();
        const res = await apiFetch('/api/mikrotik/telegram-alert/discover-chats', { method: 'POST', body: JSON.stringify(body) });
        tgChats.value = res.chats || [];
        if (!tgChats.value.length) {
            toast.info('ยังไม่เห็นแชตใด — เพิ่มบอทเข้ากลุ่มแล้วพิมพ์ข้อความในกลุ่มก่อน');
        }
    } catch (err) {
        toast.error(err.message);
    } finally {
        tgBusy.value = '';
    }
}

// ---------- LINE OA ----------
const lineSiteId = ref('');
const line = ref({ enabled: false, channelAccessToken: '', targetId: '', digestTime: '09:00', lastSentDate: '' });
const lineBusy = ref('');

async function loadLine() {
    const sid = lineSiteId.value || activeSiteId.value;
    if (!sid) return;
    try {
        line.value = await apiFetch('/api/mikrotik/line-digest/config?siteId=' + encodeURIComponent(sid));
    } catch (err) {
        toast.error('โหลดการตั้งค่า LINE ไม่สำเร็จ: ' + err.message);
    }
}

async function saveLine() {
    const sid = lineSiteId.value || activeSiteId.value;
    lineBusy.value = 'save';
    try {
        line.value = await apiFetch('/api/mikrotik/line-digest/config?siteId=' + encodeURIComponent(sid), {
            method: 'POST',
            body: JSON.stringify({
                enabled: line.value.enabled,
                channelAccessToken: line.value.channelAccessToken,
                targetId: line.value.targetId,
                digestTime: line.value.digestTime
            })
        });
        toast.success('บันทึกการตั้งค่า LINE ของสาขานี้แล้ว');
    } catch (err) {
        toast.error(err.message);
    } finally {
        lineBusy.value = '';
    }
}

// ส่งของจริงออกไปหาลูกค้า ไม่ใช่ข้อความทดสอบ จึงถามยืนยันก่อน
async function runDigestNow() {
    const sid = lineSiteId.value || activeSiteId.value;
    const site = sites.value.find((s) => s.id === sid);
    if (!window.confirm(
        `ส่งสรุปวันหมดอายุของสาขา "${site ? site.name : sid}" เข้า LINE เดี๋ยวนี้?\n\n` +
        'ข้อความจะไปถึงกลุ่ม/ผู้ใช้ที่ตั้งค่าไว้จริง ไม่ใช่ข้อความทดสอบ'
    )) return;
    lineBusy.value = 'digest';
    try {
        const r = await apiFetch('/api/mikrotik/line-digest/run-now?siteId=' + encodeURIComponent(sid), { method: 'POST' });
        toast.success(r.message || 'ส่งสรุปวันหมดอายุแล้ว');
        loadLine();
    } catch (err) {
        toast.error(err.message);
    } finally {
        lineBusy.value = '';
    }
}

async function runHealthNow() {
    if (!window.confirm('ส่งรายงานสุขภาพรวมทุกสาขาเข้า LINE เดี๋ยวนี้?')) return;
    lineBusy.value = 'health';
    try {
        const r = await apiFetch('/api/mikrotik/line-health/run-now', { method: 'POST' });
        toast.success(r.message || 'ส่งรายงานสุขภาพแล้ว');
    } catch (err) {
        toast.error(err.message);
    } finally {
        lineBusy.value = '';
    }
}

async function testLine() {
    const sid = lineSiteId.value || activeSiteId.value;
    lineBusy.value = 'test';
    try {
        const res = await apiFetch('/api/mikrotik/line-digest/test?siteId=' + encodeURIComponent(sid), { method: 'POST' });
        toast.success(res.message || 'ส่งข้อความทดสอบไป LINE แล้ว');
    } catch (err) {
        toast.error(err.message);
    } finally {
        lineBusy.value = '';
    }
}

// ---------- พื้นที่เก็บข้อมูล ----------
const st = ref(null);
const stBusy = ref('');

// ตัวเลขขนาดต้องคิดแบบเดียวกับฝั่ง server (lib/storage-monitor.js) ไม่งั้นหน้าเว็บ
// กับข้อความใน Telegram จะบอกตัวเลขไม่ตรงกัน ซึ่งทำให้ไม่รู้ว่าอันไหนเชื่อได้
function fmtBytes(n) {
    if (!n || n < 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + ' ' + units[i];
}

function shortDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: '2-digit' });
}

// สรุปสี่ตัวเลขที่ตอบคำถาม "ตอนนี้โอเคไหม" ได้ทันทีโดยไม่ต้องเลื่อนหน้า
//
// หน้าเดิมมีข้อมูลครบแต่วางเรียงกันยาวเป็นหน้าเดียว ต้องอ่านทั้งหน้าถึงจะรู้ว่า
// มีอะไรต้องทำหรือเปล่า ซึ่งกลับหัวกับสิ่งที่คนเปิดหน้านี้มาถาม
const vitals = computed(() => {
    if (!st.value) return [];
    const v = [];
    const d = st.value.disk;
    v.push(d.available
        ? { key: 'disk', label: 'ดิสก์ VPS', icon: 'fa-solid fa-hard-drive',
            value: d.usedPercent + '%', sub: 'เหลือ ' + d.human.available, level: d.level }
        : { key: 'disk', label: 'ดิสก์ VPS', icon: 'fa-solid fa-hard-drive',
            value: '—', sub: 'อ่านค่าไม่ได้', level: 'warn' });

    const db = st.value.database;
    v.push({
        key: 'db', label: 'ฐานข้อมูล', icon: 'fa-solid fa-database',
        value: db.backend === 'supabase' ? (db.quotaPercent + '%') : db.human,
        // วันที่จะเต็มคือตัวเลขที่บอกว่าต้องรีบแค่ไหน ยอดรวมบอกแค่ปัจจุบัน
        sub: db.daysUntilFull !== null && db.backend === 'supabase'
            ? (db.daysUntilFull <= 0 ? 'เกินโควตาแล้ว' : 'เต็มในอีก ~' + db.daysUntilFull + ' วัน')
            : (db.totalRows || 0).toLocaleString() + ' แถว',
        level: db.daysUntilFull !== null && db.daysUntilFull <= 7 ? 'critical'
            : db.daysUntilFull !== null && db.daysUntilFull <= 30 ? 'warn' : 'ok'
    });

    const r2 = st.value.r2;
    v.push({
        key: 'r2', label: 'สำเนานอกเครื่อง', icon: 'fa-solid fa-cloud',
        value: r2.configured && !r2.error ? r2.human : '—',
        sub: !r2.configured ? 'ยังไม่ได้ตั้งค่า' : r2.error ? 'เชื่อมต่อไม่ได้' : r2.objects.toLocaleString() + ' ไฟล์',
        level: !r2.configured || r2.error ? 'warn' : 'ok'
    });

    const dl = st.value.dnsLogging;
    if (dl && dl.totalCount) {
        v.push({
            key: 'dns', label: 'เก็บประวัติเข้าเว็บ (ม.26)', icon: 'fa-solid fa-globe',
            value: dl.enabledCount + '/' + dl.totalCount,
            sub: dl.enabledCount === dl.totalCount ? 'เก็บครบทุกสาขา' : 'มีสาขาที่ปิดอยู่',
            level: dl.enabledCount === dl.totalCount ? 'ok' : 'warn'
        });
    }
    return v;
});

// ตารางไหนบ้างที่มีข้อมูลแยกสาขา — เลือกดูทีละตาราง ดีกว่าเทออกมาทั้งหมด
const bySiteTables = computed(() =>
    ((st.value && st.value.database.tables) || []).filter((t) => t.bySite && t.bySite.length));
const bySitePick = ref('');
const bySiteRows = computed(() => {
    const list = bySiteTables.value;
    if (!list.length) return null;
    return list.find((t) => t.table === bySitePick.value) || list[0];
});

// แถวของ DNS ในตาราง — ใช้โชว์อัตราโตข้าง ๆ สวิตช์ ให้เห็นผลของการกดทันที
const dnsTable = computed(() =>
    (st.value?.database?.tables || []).find((t) => t.table === 'dns_query_logs') || null
);

async function setDnsLogging(enabled, siteId) {
    stBusy.value = 'dns';
    try {
        const body = siteId ? { enabled, siteId } : { enabled };
        const r = await apiFetch('/api/mikrotik/dns-logging', {
            method: 'POST',
            body: JSON.stringify(body)
        });
        // อัปเดตเฉพาะส่วนสถานะ ไม่ต้องสแกนพื้นที่ใหม่ทั้งหมดซึ่งใช้เวลาหลายวินาที
        if (st.value) {
            st.value.dnsLogging = {
                sites: r.sites,
                enabledCount: r.sites.filter((x) => x.enabled).length,
                totalCount: r.sites.length
            };
        }
        if (!r.changed.length) toast.info('ค่าเดิมตรงอยู่แล้ว ไม่มีอะไรเปลี่ยน');
        else if (enabled) toast.success('เปิดการเก็บประวัติเข้าเว็บแล้ว: ' + r.changed.join(', '));
        else toast.success('ปิดการเก็บประวัติเข้าเว็บแล้ว: ' + r.changed.join(', '));
    } catch (err) {
        toast.error('เปลี่ยนค่าไม่สำเร็จ: ' + err.message);
        loadStorage();   // ดึงสถานะจริงกลับมา กันหน้าจอค้างที่ค่าที่ยังไม่ได้บันทึก
    } finally {
        stBusy.value = '';
    }
}

// ปิดคือการหยุดเก็บบันทึกตามกฎหมาย จึงถามยืนยันเสมอ ส่วนการเปิดไม่ต้องถาม
function toggleDnsAll(enabled) {
    if (!enabled && !window.confirm([
        'ปิดการเก็บประวัติเข้าเว็บ (DNS) ทุกสาขา?',
        '',
        'พรบ. คอมพิวเตอร์ ม.26 กำหนดให้เก็บย้อนหลัง 90 วัน',
        'ช่วงเวลาที่ปิดไว้จะไม่มีบันทึก และย้อนกลับไปเก็บไม่ได้',
        '',
        'ระบบจะเตือนทุกวันจนกว่าจะเปิดกลับ'
    ].join('\n'))) {
        loadStorage();   // คืนสวิตช์กลับสถานะจริง เพราะ checkbox ขยับไปแล้วตอนกด
        return;
    }
    setDnsLogging(enabled);
}

function toggleDnsSite(site, enabled) {
    if (!enabled && !window.confirm(
        `ปิดการเก็บประวัติเข้าเว็บของสาขา "${site.name}"?\n\n` +
        'ช่วงที่ปิดจะไม่มีบันทึกตาม ม.26 และย้อนกลับไปเก็บไม่ได้'
    )) {
        loadStorage();
        return;
    }
    setDnsLogging(enabled, site.id);
}

async function loadStorage() {
    stBusy.value = 'load';
    try {
        st.value = await apiFetch('/api/mikrotik/storage');
    } catch (err) {
        toast.error('ตรวจพื้นที่เก็บข้อมูลไม่สำเร็จ: ' + err.message);
    } finally {
        stBusy.value = '';
    }
}

async function sendStorageReport() {
    stBusy.value = 'send';
    try {
        // force = ส่งแม้ทุกอย่างปกติ ไม่งั้นตอนไม่มีปัญหาจะไม่มีอะไรออกไป
        // แล้วจะไม่มีทางรู้ว่าช่องทางแจ้งเตือนใช้ได้จริงหรือเปล่า
        const r = await apiFetch('/api/mikrotik/storage/check-now', {
            method: 'POST',
            body: JSON.stringify({ force: true })
        });
        st.value = r.report;
        if (r.sent) toast.success('ส่งรายงานเข้า Telegram แล้ว');
        else toast.error('ส่งไม่ได้ — ตรวจการตั้งค่า Telegram ในแท็บแจ้งเตือนแอดมิน');
    } catch (err) {
        toast.error('ส่งรายงานไม่สำเร็จ: ' + err.message);
    } finally {
        stBusy.value = '';
    }
}

// โหลดตอนเปิดแท็บครั้งแรกเท่านั้น — การสแกนโฟลเดอร์กับนับแถวในฐานข้อมูลมีต้นทุน
// ไม่ควรยิงทุกครั้งที่สลับแท็บไปมา ถ้าอยากได้ค่าล่าสุดมีปุ่ม "ตรวจใหม่" ให้กด
watch(tab, (v) => {
    if (v === 'storage' && !st.value && !stBusy.value) loadStorage();
});

onMounted(async () => {
    await reloadSites();
    lineSiteId.value = activeSiteId.value || (sites.value[0]?.id || '');
    loadTelegram();
    loadLine();
});
</script>

<template>
    <div class="head">
        <div>
            <h1>จัดการระบบเราท์เตอร์ &amp; แจ้งเตือน</h1>
            <p>สาขาและการเชื่อมต่อ · ช่องทางแจ้งเตือนแอดมินและลูกค้า</p>
        </div>
    </div>

    <div class="tabs">
        <button
            v-for="t in TABS" :key="t.key" type="button" class="tab"
            :class="{ on: tab === t.key }" @click="tab = t.key"
        >
            <i :class="t.icon"></i> {{ t.label }}
        </button>
    </div>

    <!-- ================= สาขา ================= -->
    <template v-if="tab === 'sites'">
        <div class="bar">
            <button type="button" class="v2-btn ghost" :disabled="loadingSites" @click="reloadSites">
                <i class="fa-solid" :class="loadingSites ? 'fa-spinner fa-spin' : 'fa-rotate'"></i> ตรวจสถานะใหม่
            </button>
            <button type="button" class="v2-btn primary" @click="openAddSite">
                <i class="fa-solid fa-plus"></i> เพิ่มสาขา
            </button>
        </div>

        <div class="panel">
            <div class="tablewrap">
                <table>
                    <thead>
                        <tr>
                            <th>สาขา</th><th>การเชื่อมต่อ</th><th>Host</th>
                            <th>สถานะ</th><th>DNS Log</th><th class="right">จัดการ</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-if="!sites.length">
                            <td colspan="6" class="empty">{{ loadingSites ? 'กำลังโหลด...' : 'ยังไม่มีสาขา' }}</td>
                        </tr>
                        <tr v-for="s in sites" :key="s.id">
                            <td>
                                <div class="strong">
                                    {{ s.name }}
                                    <span v-if="s.id === activeSiteId" class="cur">กำลังใช้งาน</span>
                                </div>
                                <div class="sub mono">{{ s.id }}</div>
                            </td>
                            <td>
                                <span class="tag" :class="s.connectionType === 'wireguard' ? 'wg' : 'dir'">
                                    {{ s.connectionType === 'wireguard' ? 'WireGuard' : 'ต่อตรง' }}
                                </span>
                                <div v-if="s.wireguardIp" class="sub mono">{{ s.wireguardIp }}</div>
                                <template v-if="s.connectionType === 'wireguard'">
                                    <div v-if="wgPeerOf(s) && wgPeerOf(s).endpoint" class="sub mono peer">
                                        {{ wgPeerOf(s).endpoint }}
                                        <span :class="wgPeerOf(s).connected ? 'hs-ok' : 'hs-old'">
                                            {{ handshakeText(wgPeerOf(s).lastHandshakeSecondsAgo) }}
                                        </span>
                                    </div>
                                    <div v-else class="sub peer hs-old">ยังไม่เคยต่อเข้า VPS</div>
                                </template>
                            </td>
                            <td class="mono v2-num">
                                {{ s.host || '—' }}<span v-if="s.port" class="sub">:{{ s.port }}</span>
                                <div v-if="!s.hasPassword" class="warnhint">
                                    <i class="fa-solid fa-triangle-exclamation"></i> ยังไม่ได้ตั้งรหัส API
                                </div>
                            </td>
                            <td>
                                <span class="dot" :class="siteStatus[s.id] || 'checking'"></span>
                                <span class="stxt">
                                    {{ siteStatus[s.id] === 'online' ? 'ออนไลน์'
                                        : siteStatus[s.id] === 'offline' ? 'ออฟไลน์' : 'กำลังตรวจ...' }}
                                </span>
                            </td>
                            <td>
                                <span class="badge" :class="s.dnsLoggingEnabled ? 'b-ok' : 'b-muted'">
                                    {{ s.dnsLoggingEnabled ? 'เปิด' : 'ปิด' }}
                                </span>
                            </td>
                            <td class="right">
                                <div class="rowbtns">
                                    <button
                                        v-if="s.id !== activeSiteId" type="button" class="v2-btn ghost sm"
                                        title="สลับมาใช้สาขานี้" @click="setActiveSiteId(s.id)"
                                    >
                                        <i class="fa-solid fa-right-left"></i>
                                    </button>
                                    <button type="button" class="v2-btn ghost sm" title="วินิจฉัยการเชื่อมต่อ 5 ขั้น" @click="openDiagnose(s)">
                                        <i class="fa-solid fa-stethoscope"></i>
                                    </button>
                                    <button
                                        v-if="s.connectionType === 'wireguard'"
                                        type="button" class="v2-btn ghost sm" title="สร้างสคริปต์ตั้งค่า WireGuard"
                                        @click="openWireguard(s)"
                                    >
                                        <i class="fa-solid fa-shield-halved"></i>
                                    </button>
                                    <button type="button" class="v2-btn ghost sm" title="แก้ไข" :disabled="busySite === s.id" @click="openEditSite(s)">
                                        <i class="fa-solid fa-pen"></i>
                                    </button>
                                    <button type="button" class="v2-btn danger sm" title="ลบสาขา" :disabled="busySite === s.id" @click="removeSite(s)">
                                        <i class="fa-solid" :class="busySite === s.id ? 'fa-spinner fa-spin' : 'fa-trash'"></i>
                                    </button>
                                </div>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
    </template>

    <!-- ================= Telegram ================= -->
    <template v-else-if="tab === 'telegram'">
        <div class="v2-callout info">
            <i class="fa-solid fa-circle-info"></i>
            <span>
                <strong>แยกช่องทางตามผู้รับ:</strong> Telegram = ทีมแอดมิน (เราท์เตอร์ล่ม, เชื่อมต่อไม่ได้) ·
                LINE OA = ลูกค้า/ผู้เช่าห้อง (สรุปวันหมดอายุ) — ตั้งค่าแยกกัน ไม่ปะปน
            </span>
        </div>

        <div class="panel form">
            <div class="switchrow">
                <div>
                    <div class="strong">เปิดใช้งานแจ้งเตือน Telegram</div>
                    <div class="sub">แจ้งเมื่อเราท์เตอร์สาขาใดล่มหรือเชื่อมต่อไม่ได้</div>
                </div>
                <label class="sw">
                    <input v-model="tg.enabled" type="checkbox">
                    <span></span>
                </label>
            </div>

            <div class="v2-row-2">
                <div class="v2-field">
                    <label>Bot Token</label>
                    <input v-model="tgToken" type="password" class="v2-input mono" autocomplete="off"
                           :placeholder="tg.hasBotToken ? 'เว้นว่าง = ใช้ตัวเดิมที่บันทึกไว้' : 'จาก @BotFather'">
                    <span class="v2-hint">
                        {{ tg.hasBotToken ? `บันทึกไว้แล้ว (${tg.botTokenPreview})` : 'สร้างบอทที่ @BotFather แล้วนำ token มาวาง' }}
                    </span>
                </div>
                <div class="v2-field">
                    <label>Chat ID (กลุ่มหรือผู้ใช้)</label>
                    <div class="inline">
                        <input v-model="tg.chatId" class="v2-input mono" placeholder="เช่น -1001234567890">
                        <button type="button" class="v2-btn ghost" :disabled="tgBusy === 'discover'" @click="discoverChats">
                            <i class="fa-solid" :class="tgBusy === 'discover' ? 'fa-spinner fa-spin' : 'fa-magnifying-glass'"></i> ค้นหา
                        </button>
                    </div>
                    <span class="v2-hint">เพิ่มบอทเข้ากลุ่ม พิมพ์ข้อความอะไรก็ได้ในกลุ่ม แล้วกดค้นหา</span>
                </div>
            </div>

            <div v-if="tgChats" class="chats">
                <div v-if="!tgChats.length" class="sub">ยังไม่เห็นแชตใด — เพิ่มบอทเข้ากลุ่มแล้วพิมพ์ข้อความก่อน</div>
                <template v-else>
                    <div class="sub strong">แชตที่บอทเห็น (กดเพื่อเลือก):</div>
                    <button
                        v-for="c in tgChats" :key="c.chatId" type="button" class="v2-btn ghost sm"
                        @click="tg.chatId = c.chatId"
                    >
                        {{ c.type === 'private' ? '👤' : '👥' }} {{ c.title }}
                        <code>{{ c.chatId }}</code>
                    </button>
                </template>
            </div>

            <div class="checks">
                <label class="chk"><input v-model="tg.alertOffline" type="checkbox"> แจ้งเมื่อเราท์เตอร์ Offline</label>
                <label class="chk"><input v-model="tg.alertOnline" type="checkbox"> แจ้งเมื่อกลับมาออนไลน์</label>
                <label class="chk"><input v-model="tg.alertStorage" type="checkbox"> แจ้งเมื่อพื้นที่เก็บข้อมูลใกล้เต็ม</label>
                <label class="chk"><input v-model="tg.alertHealth" type="checkbox"> แจ้งเมื่อเราท์เตอร์มีเรื่องต้องดูแล (ตรวจทุกวัน 08:30 น. เฉพาะเรื่องร้ายแรง)</label>
            </div>

            <div class="actions">
                <button type="button" class="v2-btn primary" :disabled="tgBusy === 'save'" @click="saveTelegram">
                    <i class="fa-solid" :class="tgBusy === 'save' ? 'fa-spinner fa-spin' : 'fa-floppy-disk'"></i> บันทึก
                </button>
                <button type="button" class="v2-btn ghost" :disabled="tgBusy === 'test'" @click="testTelegram">
                    <i class="fa-brands fa-telegram"></i> ส่งข้อความทดสอบ
                </button>
            </div>
        </div>
    </template>

    <!-- ================= LINE ================= -->
    <template v-else-if="tab === 'line'">
        <div class="v2-callout warn">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <span>
                ตั้งค่า <strong>แยกรายสาขา</strong> — สาขาที่ยังไม่ได้ตั้งค่าจะไม่ส่งอะไรเลย
                และจะไม่ยืม Token/กลุ่มของสาขาอื่นมาใช้
            </span>
        </div>

        <div class="panel form">
            <div class="v2-field">
                <label>เลือกสาขาที่จะตั้งค่า</label>
                <select v-model="lineSiteId" class="v2-select" @change="loadLine">
                    <option v-for="s in sites" :key="s.id" :value="s.id">{{ s.name }}</option>
                </select>
            </div>

            <div class="switchrow">
                <div>
                    <div class="strong">ส่งสรุปวันหมดอายุประจำวัน</div>
                    <div class="sub">
                        ส่งล่าสุด: {{ line.lastSentDate || 'ยังไม่เคยส่ง' }}
                    </div>
                </div>
                <label class="sw">
                    <input v-model="line.enabled" type="checkbox">
                    <span></span>
                </label>
            </div>

            <div class="v2-field">
                <label>Channel Access Token</label>
                <input v-model="line.channelAccessToken" type="password" class="v2-input mono" autocomplete="off"
                       placeholder="จาก LINE Developers Console">
            </div>

            <div class="v2-row-2">
                <div class="v2-field">
                    <label>Target ID / Group ID</label>
                    <input v-model="line.targetId" class="v2-input mono" placeholder="เช่น Cxxxxxxxx">
                    <span class="v2-hint">พิมพ์ <code>id</code> หรือ <code>groupid</code> ในกลุ่ม LINE เพื่อให้บอทตอบ ID กลับมา</span>
                </div>
                <div class="v2-field">
                    <label>เวลาส่งประจำวัน</label>
                    <input v-model="line.digestTime" type="time" class="v2-input">
                    <span class="v2-hint">ถ้าพลาดเวลานี้ ระบบยังส่งย้อนหลังได้ภายใน 3 ชั่วโมง</span>
                </div>
            </div>

            <div class="actions">
                <button type="button" class="v2-btn primary" :disabled="lineBusy === 'save'" @click="saveLine">
                    <i class="fa-solid" :class="lineBusy === 'save' ? 'fa-spinner fa-spin' : 'fa-floppy-disk'"></i> บันทึก
                </button>
                <button type="button" class="v2-btn ghost" :disabled="lineBusy === 'test'" @click="testLine">
                    <i class="fa-brands fa-line"></i> ส่งข้อความทดสอบ
                </button>
                <button type="button" class="v2-btn ghost" :disabled="lineBusy === 'digest'" @click="runDigestNow">
                    <i class="fa-solid" :class="lineBusy === 'digest' ? 'fa-spinner fa-spin' : 'fa-paper-plane'"></i>
                    ส่งสรุปวันหมดอายุทันที
                </button>
                <button type="button" class="v2-btn ghost" :disabled="lineBusy === 'health'" @click="runHealthNow">
                    <i class="fa-solid" :class="lineBusy === 'health' ? 'fa-spinner fa-spin' : 'fa-heart-pulse'"></i>
                    ส่งรายงานสุขภาพทุกสาขา
                </button>
            </div>
        </div>
    </template>

    <!-- ================= พื้นที่เก็บข้อมูล ================= -->
    <template v-else-if="tab === 'storage'">
        <div class="bar">
            <button type="button" class="v2-btn ghost" :disabled="stBusy === 'load'" @click="loadStorage">
                <i class="fa-solid" :class="stBusy === 'load' ? 'fa-spinner fa-spin' : 'fa-rotate'"></i> ตรวจใหม่
            </button>
            <button type="button" class="v2-btn ghost" :disabled="stBusy === 'send'" @click="sendStorageReport">
                <i class="fa-brands fa-telegram"></i> ส่งรายงานเข้า Telegram
            </button>
            <span v-if="st" class="sub">ตรวจเมื่อ {{ new Date(st.generatedAt).toLocaleString('th-TH') }}</span>
        </div>

        <div v-if="!st && stBusy === 'load'" class="sub">กำลังตรวจ…</div>

        <template v-else-if="st">
            <!-- สี่ตัวเลขที่ตอบว่า "ตอนนี้โอเคไหม" โดยไม่ต้องเลื่อนอ่านทั้งหน้า -->
            <div class="vitals">
                <div v-for="v in vitals" :key="v.key" class="vital" :class="v.level">
                    <div class="v-top"><i :class="v.icon"></i> {{ v.label }}</div>
                    <div class="v-num">{{ v.value }}</div>
                    <div class="v-sub">{{ v.sub }}</div>
                </div>
            </div>

            <!-- เรื่องที่ต้องทำ อยู่บนสุดเสมอ ถ้าไม่มีก็บอกว่าไม่มี ไม่ปล่อยให้เดา -->
            <div v-if="!st.issues.length" class="v2-callout ok">
                <i class="fa-solid fa-circle-check"></i>
                <span>ทุกอย่างปกติ — ไม่มีเรื่องที่ต้องจัดการตอนนี้</span>
            </div>
            <div
                v-for="(i, idx) in st.issues" :key="idx"
                class="v2-callout" :class="i.level === 'critical' ? 'danger' : 'warn'"
            >
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span><strong>{{ i.area }}:</strong> {{ i.message }} — <em>{{ i.action }}</em></span>
            </div>

            <div class="v2-row-2">
                <!-- ดิสก์ VPS -->
                <div class="panel">
                    <div class="ptitle"><i class="fa-solid fa-hard-drive"></i> ดิสก์เครื่อง VPS</div>
                    <template v-if="st.disk.available">
                        <div class="bignum" :class="st.disk.level">{{ st.disk.usedPercent }}%</div>
                        <div class="meter"><span :class="st.disk.level" :style="{ width: st.disk.usedPercent + '%' }"></span></div>
                        <div class="sub">
                            ใช้ {{ st.disk.human.used }} / {{ st.disk.human.total }} ·
                            <strong>เหลือ {{ st.disk.human.available }}</strong>
                        </div>
                    </template>
                    <div v-else class="sub">อ่านค่าไม่ได้: {{ st.disk.reason }}</div>

                    <div class="dirs">
                        <div v-for="d in st.dirs" :key="d.key" class="dirrow">
                            <span>
                                <i v-if="d.growing" class="fa-solid fa-arrow-trend-up grow" title="โตขึ้นเรื่อย ๆ ตามการใช้งาน"></i>
                                {{ d.label }}
                            </span>
                            <span class="mono">{{ d.human }}</span>
                        </div>
                    </div>
                </div>

                <!-- Cloudflare R2 -->
                <div class="panel">
                    <div class="ptitle"><i class="fa-solid fa-cloud"></i> Cloudflare R2 (สำเนานอกเครื่อง)</div>
                    <template v-if="!st.r2.configured">
                        <div class="sub">ยังไม่ได้ตั้งค่า R2 — ข้อมูลสำรองมีสำเนาเดียวบน VPS เท่านั้น</div>
                    </template>
                    <template v-else-if="st.r2.error">
                        <div class="sub err">เชื่อมต่อไม่ได้: {{ st.r2.error }}</div>
                    </template>
                    <template v-else>
                        <div class="bignum">{{ st.r2.human }}</div>
                        <div class="sub">{{ st.r2.objects.toLocaleString() }} ไฟล์ ใน {{ st.r2.bucket }}/{{ st.r2.prefix }}</div>
                        <div class="dirs">
                            <div v-for="g in st.r2.groups" :key="g.group" class="dirrow">
                                <span>{{ g.group }} <span class="sub">({{ g.objects }} ไฟล์)</span></span>
                                <span class="mono">{{ g.human }}</span>
                            </div>
                        </div>
                    </template>
                </div>
            </div>

            <!-- สวิตช์เก็บประวัติเข้าเว็บ — วางไว้ติดกับตัวเลขที่ใช้ตัดสินใจ -->
            <div v-if="st.dnsLogging && st.dnsLogging.totalCount" class="panel">
                <div class="ptitle"><i class="fa-solid fa-globe"></i> การเก็บประวัติเข้าเว็บ (DNS)</div>

                <div class="v2-callout warn">
                    <i class="fa-solid fa-scale-balanced"></i>
                    <span>
                        <strong>พรบ. คอมพิวเตอร์ ม.26 กำหนดให้เก็บย้อนหลัง 90 วัน</strong> —
                        ช่วงเวลาที่ปิดไว้จะไม่มีบันทึกเลย และ<strong>ย้อนกลับไปเก็บไม่ได้</strong>
                        ปิดเฉพาะเมื่อจำเป็น เช่น รอจัดการเรื่องพื้นที่ แล้วเปิดกลับทันทีที่พร้อม
                    </span>
                </div>

                <div class="switchrow">
                    <div>
                        <div class="strong">
                            เปิดใช้งานทุกสาขา
                            <span class="badge" :class="st.dnsLogging.enabledCount ? 'ok' : 'bad'">
                                เปิดอยู่ {{ st.dnsLogging.enabledCount }}/{{ st.dnsLogging.totalCount }}
                            </span>
                        </div>
                        <div class="sub">
                            <template v-if="dnsTable">
                                ตอนนี้เก็บวันละ ~{{ (dnsTable.rowsLast24h || 0).toLocaleString() }} แถว
                                <template v-if="dnsTable.projectedBytes">
                                    · ครบ {{ dnsTable.retentionDays }} วันจะใช้ ~{{ fmtBytes(dnsTable.projectedBytes) }}
                                </template>
                            </template>
                            <template v-else>ปิดแล้วฐานข้อมูลจะหยุดโตจากส่วนนี้ทันที</template>
                        </div>
                    </div>
                    <label class="sw">
                        <input
                            type="checkbox"
                            :checked="st.dnsLogging.enabledCount === st.dnsLogging.totalCount"
                            :disabled="stBusy === 'dns'"
                            @change="toggleDnsAll($event.target.checked)"
                        >
                        <span></span>
                    </label>
                </div>

                <div class="dirs">
                    <div v-for="s in st.dnsLogging.sites" :key="s.id" class="dirrow dnsrow">
                        <span>
                            {{ s.name }}
                            <span class="badge" :class="s.enabled ? 'ok' : 'bad'">{{ s.enabled ? 'เก็บอยู่' : 'ปิดอยู่' }}</span>
                        </span>
                        <label class="sw sm">
                            <input
                                type="checkbox" :checked="s.enabled" :disabled="stBusy === 'dns'"
                                @change="toggleDnsSite(s, $event.target.checked)"
                            >
                            <span></span>
                        </label>
                    </div>
                </div>
            </div>

            <!-- ฐานข้อมูล -->
            <div class="panel">
                <div class="ptitle">
                    <i class="fa-solid fa-database"></i> ฐานข้อมูล
                    <span class="sub">({{ st.database.backend === 'supabase' ? 'Supabase' : 'ไฟล์ JSON' }})</span>
                </div>
                <div class="sub">
                    รวม {{ (st.database.totalRows || 0).toLocaleString() }} แถว ·
                    <template v-if="st.database.backend === 'supabase'">
                        ประมาณ {{ st.database.human }} จากโควตา {{ fmtBytes(st.database.quotaBytes) }}
                        (~{{ st.database.quotaPercent }}%)
                        <span class="note">— ขนาดเป็นค่าประมาณจากการสุ่มวัดแถว ไม่ใช่ขนาดจริงบนดิสก์ของ Postgres</span>
                    </template>
                    <template v-else>{{ st.database.human }} (ขนาดไฟล์จริง)</template>
                </div>

                <!-- อัตราโต: ตัวเลขที่บอกว่าต้องรีบแค่ไหน ต่างจากยอดรวมที่บอกแค่ปัจจุบัน -->
                <div v-if="st.database.growthBytesPerDay > 0" class="growth"
                     :class="st.database.daysUntilFull !== null && st.database.daysUntilFull <= 30 ? 'urgent' : ''">
                    <i class="fa-solid fa-arrow-trend-up"></i>
                    โตวันละ ~{{ st.database.growthHuman }}
                    <template v-if="st.database.daysUntilFull !== null && st.database.backend === 'supabase'">
                        · <strong>{{ st.database.daysUntilFull <= 0
                            ? 'เกินโควตาแล้ว'
                            : 'จะเต็มในอีกประมาณ ' + st.database.daysUntilFull + ' วัน' }}</strong>
                    </template>
                </div>

                <div class="tablewrap">
                    <table>
                        <thead>
                            <tr>
                                <th>ข้อมูล</th><th class="r">จำนวนแถว</th><th class="r">ต่อวัน</th><th class="r">ขนาด</th>
                                <th>เก่าสุด</th><th>ใหม่สุด</th><th>การลบตามกำหนด</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="t in st.database.tables" :key="t.table">
                                <td>
                                    {{ t.label }}
                                    <span v-if="t.law" class="badge law">{{ t.law }}</span>
                                </td>
                                <td class="r mono">{{ (t.rows || 0).toLocaleString() }}</td>
                                <td class="r mono sub">{{ (t.rowsLast24h || 0).toLocaleString() }}</td>
                                <td class="r mono">{{ fmtBytes(t.estimatedBytes) }}</td>
                                <td class="mono sub">{{ shortDate(t.oldest) }}</td>
                                <td class="mono sub">{{ shortDate(t.newest) }}</td>
                                <td>
                                    <span v-if="!t.retentionDays" class="badge">เก็บถาวร</span>
                                    <span v-else-if="t.retentionOk" class="badge ok">
                                        ปกติ ({{ t.retentionDays }} วัน)
                                    </span>
                                    <span v-else class="badge bad">
                                        เก่าสุด {{ t.oldestAgeDays }} วัน เกิน {{ t.retentionDays }}
                                    </span>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>

                <!-- แยกตามสาขา: เลือกดูทีละตาราง — เดิมเทออกมาทุกตารางพร้อมกัน
                     กลายเป็นรายการยาวที่ไม่มีใครอ่านจนจบ -->
                <div v-if="bySiteRows" class="sitebreak">
                    <div class="sbhead">
                        <span class="sub strong">แยกตามสาขา</span>
                        <select v-model="bySitePick" class="v2-input sm">
                            <option v-for="t in bySiteTables" :key="t.table" :value="t.table">{{ t.label }}</option>
                        </select>
                    </div>
                    <div v-for="b in bySiteRows.bySite" :key="b.siteName" class="dirrow">
                        <span>
                            {{ b.siteName }}
                            <span v-if="b.unmatched" class="badge warn" title="ชื่อนี้ไม่อยู่ในทะเบียนสาขาแล้ว — เป็นข้อมูลเก่าจากตอนที่ยังใช้ชื่อเดิม">ชื่อเดิม</span>
                        </span>
                        <span class="mono">{{ b.rows.toLocaleString() }}</span>
                    </div>
                </div>
            </div>
        </template>
    </template>

    <!-- ================= จัดการเราท์เตอร์ ================= -->
    <template v-else>
        <RouterOpsPanel />
    </template>

    <SiteDiagnosticsModal
        ref="diagRef" :open="diagOpen" :site="diagSite" @close="diagOpen = false"
    />
    <WireguardSetupModal
        :open="wgOpen" :site="wgSite"
        @close="wgOpen = false" @registered="reloadSites"
    />

    <SiteModal :open="siteModalOpen" :site="editingSite" @close="siteModalOpen = false" @saved="onSiteSaved" />
</template>

<style scoped>
/* ---- พื้นที่เก็บข้อมูล ---- */
.vitals {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(178px, 1fr));
    gap: 10px; margin-bottom: 14px;
}
.vital {
    background: var(--v2-surface); border: 1px solid var(--v2-border);
    border-left: 3px solid var(--v2-border);
    border-radius: var(--v2-radius); padding: 12px 14px;
}
.vital.ok       { border-left-color: var(--v2-success); }
.vital.warn     { border-left-color: var(--v2-warn); }
.vital.critical { border-left-color: var(--v2-danger); }
.v-top { font-size: .74rem; color: var(--v2-text-muted); display: flex; align-items: center; gap: 6px;
         white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.v-num { font-size: 1.55rem; font-weight: 700; letter-spacing: -.02em; line-height: 1.25; font-variant-numeric: tabular-nums; }
.vital.warn .v-num     { color: var(--v2-warn); }
.vital.critical .v-num { color: var(--v2-danger); }
.v-sub { font-size: .74rem; color: var(--v2-text-muted); }
.sbhead { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 6px; }
.growth { margin-top: 10px; padding: 8px 12px; border-radius: 8px; font-size: .82rem;
          background: var(--v2-primary-soft); color: var(--v2-primary); display: flex; align-items: center; gap: 8px; }
.growth.urgent { background: var(--v2-warn-soft); color: var(--v2-warn); }
.dnsrow { align-items: center; padding: 6px 0; }
.ptitle { font-weight: 600; font-size: .9rem; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
.bignum { font-size: 1.9rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; }
.bignum.warn { color: var(--v2-warn); }
.bignum.critical { color: var(--v2-danger); }
.meter { height: 8px; border-radius: 999px; background: var(--v2-border); overflow: hidden; margin: 8px 0; }
.meter span { display: block; height: 100%; border-radius: 999px; background: var(--v2-primary); transition: width .3s; }
.meter span.warn { background: var(--v2-warn); }
.meter span.critical { background: var(--v2-danger); }
.dirs { margin-top: 12px; border-top: 1px solid var(--v2-border); padding-top: 8px; }
.dirrow { display: flex; justify-content: space-between; gap: 12px; padding: 3px 0; font-size: .82rem; }
.dirrow .grow { color: var(--v2-primary); font-size: .7rem; margin-right: 2px; }
.sitebreak { margin-top: 14px; border-top: 1px solid var(--v2-border); padding-top: 10px; }
.note { font-size: .78rem; opacity: .8; }
.err { color: var(--v2-danger); }
.badge { display: inline-block; font-size: .72rem; padding: 1px 7px; border-radius: 999px;
         border: 1px solid var(--v2-border); color: var(--v2-text-muted); }
.badge.ok { border-color: color-mix(in srgb, var(--v2-success) 35%, transparent); color: var(--v2-success); }
.badge.bad { border-color: color-mix(in srgb, var(--v2-danger) 35%, transparent); color: var(--v2-danger); }
.badge.warn { border-color: color-mix(in srgb, var(--v2-warn) 35%, transparent); color: var(--v2-warn); }
.badge.law { border-color: var(--v2-primary); color: var(--v2-primary); margin-left: 6px; }
th.r, td.r { text-align: right; }

.head { margin-bottom: 16px; }
.head h1 { margin: 0; font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; }
.head p { margin: 3px 0 0; font-size: .85rem; color: var(--v2-text-muted); }

.tabs { display: flex; gap: 6px; border-bottom: 1px solid var(--v2-border); margin-bottom: 16px; overflow-x: auto; }
.tab {
    display: inline-flex; align-items: center; gap: 8px; font: inherit; font-size: .86rem; font-weight: 600;
    color: var(--v2-text-muted); background: none; border: none; border-bottom: 2px solid transparent;
    padding: 10px 14px; cursor: pointer; white-space: nowrap;
}
.tab.on { color: var(--v2-primary); border-bottom-color: var(--v2-primary); }

.bar { display: flex; gap: 9px; justify-content: flex-end; margin-bottom: 14px; flex-wrap: wrap; }

.panel {
    background: var(--v2-surface); border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius); box-shadow: var(--v2-shadow); overflow: hidden;
}
.panel.form { padding: 20px; }

.tablewrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .85rem; }
th {
    text-align: left; font-weight: 600; font-size: .75rem; color: var(--v2-text-muted);
    padding: 10px 14px; border-bottom: 1px solid var(--v2-border); white-space: nowrap; background: #fbfcfe;
}
td { padding: 11px 14px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
tbody tr:last-child td { border-bottom: none; }
.right, th.right { text-align: right; }
.strong { font-weight: 600; color: var(--v2-text); }
.sub { font-size: .75rem; color: var(--v2-text-muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .79rem; }
.empty { text-align: center; color: var(--v2-text-muted); padding: 34px 14px; }
.rowbtns { display: inline-flex; gap: 5px; justify-content: flex-end; }

.cur {
    font-size: .66rem; font-weight: 700; background: var(--v2-primary-soft); color: #1d4ed8;
    padding: 2px 7px; border-radius: 999px; margin-left: 6px;
}
.tag { font-size: .72rem; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
.tag.wg { background: #ede9fe; color: #6d28d9; }
.tag.dir { background: #eef2f7; color: #475569; }

.dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 6px; }
.dot.online { background: #22c55e; box-shadow: 0 0 0 3px rgba(34,197,94,.16); }
.dot.offline { background: #ef4444; box-shadow: 0 0 0 3px rgba(239,68,68,.16); }
.dot.checking { background: #cbd5e1; animation: blink 1s ease-in-out infinite; }
@keyframes blink { 50% { opacity: .3; } }
.stxt { font-size: .8rem; }

.badge { font-size: .72rem; font-weight: 600; padding: 3px 9px; border-radius: 999px; }
.b-ok { background: var(--v2-success-soft); color: var(--v2-success); }
.b-muted { background: #eef2f7; color: var(--v2-text-muted); }

.warnhint { font-size: .72rem; color: var(--v2-warn); margin-top: 3px; font-family: inherit; }

.peer { margin-top: 2px; font-size: .71rem; }
.hs-ok { color: var(--v2-success); font-family: inherit; margin-left: 4px; }
.hs-old { color: var(--v2-text-muted); font-family: inherit; margin-left: 4px; }

.switchrow {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding-bottom: 16px; margin-bottom: 16px; border-bottom: 1px solid var(--v2-border);
}
.sw { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; }
.sw input { opacity: 0; width: 0; height: 0; }
.sw span {
    position: absolute; inset: 0; background: #cbd5e1; border-radius: 999px;
    cursor: pointer; transition: background .18s ease;
}
.sw span::before {
    content: ''; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px;
    background: #fff; border-radius: 50%; transition: transform .18s ease;
}
.sw input:checked + span { background: var(--v2-primary); }
.sw input:checked + span::before { transform: translateX(20px); }
/* input ถูกซ่อนด้วย opacity:0 ขนาด 0x0 ผู้ใช้คีย์บอร์ดจึงไม่เห็นว่าโฟกัสอยู่ที่ไหน
   ย้ายวงโฟกัสไปไว้ที่ track ที่มองเห็นจริงแทน */
.sw input:focus-visible + span { outline: 2px solid var(--v2-primary); outline-offset: 2px; }

/* สวิตช์ขนาดเล็กสำหรับรายสาขา — คำนวณให้ thumb อยู่กึ่งกลางเท่ากันทุกด้าน
   track 36x20, thumb 14, ขอบ 3 -> ระยะเลื่อน = 36 - 14 - 3*2 = 16 */
.sw.sm { width: 36px; height: 20px; }
.sw.sm span::before { width: 14px; height: 14px; left: 3px; top: 3px; }
.sw.sm input:checked + span::before { transform: translateX(16px); }

.inline { display: flex; gap: 8px; }
.inline .v2-input { flex: 1; }

.chats {
    display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    padding: 12px 14px; background: var(--v2-bg); border-radius: 9px; margin-bottom: 14px;
}
.chats code { background: var(--v2-surface); padding: 1px 5px; border-radius: 4px; margin-left: 5px; }

.checks { display: flex; gap: 20px; flex-wrap: wrap; margin-bottom: 18px; }
.chk { display: flex; align-items: center; gap: 8px; font-size: .85rem; cursor: pointer; }
.chk input { width: 15px; height: 15px; cursor: pointer; }

.actions { display: flex; gap: 10px; flex-wrap: wrap; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
</style>
