<script setup>
import { ref, onMounted } from 'vue';
import { apiFetch, activeSiteId, setActiveSiteId } from '../api.js';
import { toast } from '../toast.js';
import SiteModal from './SiteModal.vue';

const TABS = [
    { key: 'sites', label: 'สาขา / เราท์เตอร์', icon: 'fa-solid fa-network-wired' },
    { key: 'telegram', label: 'แจ้งเตือนแอดมิน (Telegram)', icon: 'fa-brands fa-telegram' },
    { key: 'line', label: 'แจ้งเตือนลูกค้า (LINE OA)', icon: 'fa-brands fa-line' }
];

const tab = ref('sites');

// ---------- สาขา ----------
const sites = ref([]);
const siteStatus = ref({});      // siteId -> 'checking' | 'online' | 'offline'
const loadingSites = ref(false);
const siteModalOpen = ref(false);
const editingSite = ref(null);
const busySite = ref('');

async function loadSites() {
    loadingSites.value = true;
    try {
        const data = await apiFetch('/api/sites');
        sites.value = data.sites || [];
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
        await loadSites();
    } catch (err) {
        toast.error('ลบไม่สำเร็จ: ' + err.message);
    } finally {
        busySite.value = '';
    }
}

// ---------- Telegram ----------
const tg = ref({ enabled: false, hasBotToken: false, botTokenPreview: '', chatId: '', alertOffline: true, alertOnline: true });
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
        alertOnline: tg.value.alertOnline
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

onMounted(async () => {
    await loadSites();
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
            <button type="button" class="v2-btn ghost" :disabled="loadingSites" @click="loadSites">
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
            <div class="note">
                <i class="fa-solid fa-circle-info"></i>
                สร้างสคริปต์ตั้งค่า WireGuard บนเราท์เตอร์ และเครื่องมือวินิจฉัยการเชื่อมต่อ 5 ขั้น
                ยังทำที่ <a href="/">หน้าเดิม</a>
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
    <template v-else>
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
            </div>
        </div>
    </template>

    <SiteModal :open="siteModalOpen" :site="editingSite" @close="siteModalOpen = false" @saved="loadSites" />
</template>

<style scoped>
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

.note {
    display: flex; align-items: center; gap: 8px; padding: 11px 16px;
    background: var(--v2-primary-soft); color: #1d4ed8; font-size: .81rem; border-top: 1px solid var(--v2-border);
}
.note a { color: inherit; font-weight: 700; }

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
