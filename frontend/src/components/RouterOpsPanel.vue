<script setup>
/**
 * คำสั่งจัดการเราท์เตอร์ — ระบบควบคุม ตรวจสอบ และจัดการพื้นที่
 *
 * ทุกปุ่มในนี้สั่งงานเราท์เตอร์ที่ลูกค้ากำลังใช้อยู่จริง จึงแยกเป็นสองกลุ่มชัดเจน:
 * กลุ่มตรวจสอบ/จัดการไฟล์ (ไม่กระทบผู้ใช้) กับกลุ่มที่กระทบ (รีบูตทำให้เน็ตหลุดทั้งสาขา)
 * และกลุ่มหลังต้องยืนยันก่อนเสมอ
 */
import { ref } from 'vue';
import { apiFetch } from '../api.js';
import { toast } from '../toast.js';
import { formatBytes } from '../format.js';
import FullUpgradeModal from './FullUpgradeModal.vue';

const busy = ref('');
const pingResult = ref(null);
const qualityResult = ref(null);
const updateInfo = ref(null);
const upgradeOpen = ref(false);
const upgradeMode = ref('full');

const pingHost = ref('8.8.8.8');
const pingCount = ref(4);

// ข้อมูลไฟล์และพื้นที่ในเราท์เตอร์
const filesData = ref(null);

async function run(key, fn, okMsg) {
    busy.value = key;
    try {
        const r = await fn();
        if (okMsg) toast.success(typeof okMsg === 'function' ? okMsg(r) : okMsg);
        return r;
    } catch (err) {
        toast.error(err.message);
        return null;
    } finally {
        busy.value = '';
    }
}

function flushDns() {
    run('flush', () => apiFetch('/api/mikrotik/system/flush-dns', { method: 'POST' }),
        'ล้างแคช DNS ของเราท์เตอร์แล้ว');
}

const cfgResult = ref(null);

// สำรองคอนฟิกออกมาไว้นอกเราท์เตอร์ — ต่างจากปุ่มด้านล่างที่เก็บไว้ในเครื่องเอง
async function backupConfig() {
    busy.value = 'cfgbackup';
    cfgResult.value = null;
    try {
        const r = await apiFetch('/api/mikrotik/backup/config', { method: 'POST' });
        cfgResult.value = r;
        toast.success('สำรองคอนฟิกแล้ว — ' + r.fileName);
    } catch (err) {
        toast.error('สำรองไม่สำเร็จ: ' + err.message);
    } finally {
        busy.value = '';
    }
}

function backup() {
    run('backup', () => apiFetch('/api/mikrotik/system/backup', { method: 'POST' }),
        'สั่งสำรองค่าเราท์เตอร์แล้ว — ไฟล์ .backup อยู่ในเราท์เตอร์');
}

async function pingTest() {
    pingResult.value = null;
    const r = await run('ping', () => apiFetch('/api/mikrotik/system/ping-test', {
        method: 'POST',
        body: JSON.stringify({ host: pingHost.value.trim() || '8.8.8.8', count: Number(pingCount.value) || 4 })
    }));
    if (r) pingResult.value = r;
}

async function qualityTest() {
    qualityResult.value = null;
    const r = await run('quality', () => apiFetch('/api/mikrotik/system/quality-test', { method: 'POST' }));
    if (r) qualityResult.value = r;
}

/**
 * หลังอัปเกรดเสร็จ ผลตรวจอัปเดตเดิมกลายเป็นข้อมูลเก่าทันที
 * ถ้าปล่อยไว้จะยังขึ้นว่า "มีเวอร์ชันใหม่" ทั้งที่ลงไปแล้ว
 */
async function onUpgradeDone() {
    updateInfo.value = null;
    await checkUpdate();
}

async function checkUpdate() {
    updateInfo.value = null;
    const r = await run('update', () => apiFetch('/api/mikrotik/system/update-check'));
    if (r) updateInfo.value = r;
}

// โหลดรายการไฟล์และคำนวณพื้นที่
async function loadFiles() {
    const r = await run('loadfiles', () => apiFetch('/api/mikrotik/files'));
    if (r) filesData.value = r;
}

// ล้างไฟล์ชั่วคราวและไฟล์ขยะ 1-Click
async function cleanTempFiles() {
    const ok = window.confirm('ยืนยันลบไฟล์ชั่วคราวและไฟล์ขยะทั้งหมดในเราท์เตอร์? (ไฟล์คอนฟิกหลักจะไม่ถูกลบ)');
    if (!ok) return;

    const r = await run('cleantemp', () => apiFetch('/api/mikrotik/files/clean-temporary', { method: 'POST' }),
        (res) => `ลบไฟล์ชั่วคราวแล้ว ${res.deletedCount || 0} ไฟล์ (คืนพื้นที่ ${formatBytes(res.freedBytes || 0)})`);
    if (r) {
        await loadFiles();
    }
}

// ลบไฟล์เดี่ยว
async function deleteSingleFile(fileName) {
    const ok = window.confirm(`ยืนยันลบไฟล์ "${fileName}" ออกจากเราท์เตอร์?`);
    if (!ok) return;

    const r = await run(`del-${fileName}`, () => apiFetch(`/api/mikrotik/files/${encodeURIComponent(fileName)}`, { method: 'DELETE' }),
        `ลบไฟล์ "${fileName}" สำเร็จ`);
    if (r) {
        await loadFiles();
    }
}

// รีบูตทำให้ทั้งสาขาเน็ตหลุด 1-3 นาที — ต้องพิมพ์ยืนยัน ไม่ใช่แค่กด OK
async function reboot() {
    const ok = window.confirm([
        'รีบูตเราท์เตอร์ของสาขานี้?',
        '',
        'ผู้ใช้ทุกคนในสาขาจะหลุดจากอินเทอร์เน็ต 1-3 นาที',
        'รวมถึงลูกค้าที่กำลังใช้งานอยู่ตอนนี้',
        '',
        'กด OK เพื่อยืนยัน'
    ].join('\n'));
    if (!ok) return;
    await run('reboot', () => apiFetch('/api/mikrotik/system/reboot', { method: 'POST' }),
        'สั่งรีบูตแล้ว — เราท์เตอร์จะกลับมาใน 1-3 นาที');
}

function openUpgrade(mode) {
    upgradeMode.value = mode;
    upgradeOpen.value = true;
}

// ping ของ RouterOS คืนค่าเป็นรายการต่อครั้ง ต้องสรุปเองให้อ่านง่าย
function pingSummary(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const times = list.map((r) => parseInt(r.time)).filter((n) => !isNaN(n));
    const sent = list.length;
    const recv = times.length;
    return {
        sent,
        recv,
        lossPct: sent ? Math.round(((sent - recv) / sent) * 100) : 0,
        avg: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
        min: times.length ? Math.min(...times) : null,
        max: times.length ? Math.max(...times) : null
    };
}
</script>

<template>
    <div class="v2-callout info">
        <i class="fa-solid fa-circle-info"></i>
        <span>
            คำสั่งเหล่านี้ทำงานกับ<strong>สาขาที่เลือกอยู่ด้านบน</strong>
            กลุ่มตรวจสอบไม่กระทบผู้ใช้ ส่วนกลุ่มที่กระทบจะถามยืนยันก่อนเสมอ
        </span>
    </div>

    <!-- ตรวจสอบ — ปลอดภัย กดได้ตลอด -->
    <div class="panel">
        <div class="ptitle"><i class="fa-solid fa-stethoscope"></i> ตรวจสอบ (ไม่กระทบผู้ใช้)</div>

        <div class="opsgrid">
            <div class="op">
                <div class="opname">ทดสอบ Ping</div>
                <div class="sub">วัดว่าเราท์เตอร์ออกอินเทอร์เน็ตได้ไหมและช้าแค่ไหน</div>
                <div class="inline">
                    <input v-model="pingHost" class="v2-input mono" placeholder="8.8.8.8">
                    <input v-model="pingCount" type="number" min="1" max="20" class="v2-input num">
                    <button type="button" class="v2-btn ghost" :disabled="busy === 'ping'" @click="pingTest">
                        <i class="fa-solid" :class="busy === 'ping' ? 'fa-spinner fa-spin' : 'fa-play'"></i> ทดสอบ
                    </button>
                </div>
                <div v-if="pingResult" class="result">
                    <template v-for="s in [pingSummary(pingResult.results)]" :key="'p'">
                        <span :class="s.lossPct > 0 ? 'bad' : 'ok'">
                            ส่ง {{ s.sent }} ตอบ {{ s.recv }} ({{ s.lossPct }}% หาย)
                        </span>
                        <span v-if="s.avg !== null"> · เฉลี่ย {{ s.avg }} ms (ต่ำสุด {{ s.min }} / สูงสุด {{ s.max }})</span>
                    </template>
                </div>
            </div>

            <div class="op">
                <div class="opname">ทดสอบคุณภาพสาย</div>
                <div class="sub">วัด jitter และ packet loss พร้อมให้เกรดคุณภาพ</div>
                <button type="button" class="v2-btn ghost" :disabled="busy === 'quality'" @click="qualityTest">
                    <i class="fa-solid" :class="busy === 'quality' ? 'fa-spinner fa-spin' : 'fa-gauge-high'"></i> ทดสอบคุณภาพ
                </button>
                <div v-if="qualityResult" class="result">
                    <span class="grade">{{ qualityResult.qualityScore }}</span>
                    <span>{{ qualityResult.quality }}</span>
                    <div class="sub">
                        เฉลี่ย {{ qualityResult.avgMs }} ms · jitter {{ qualityResult.jitterMs }} ms ·
                        หาย {{ qualityResult.packetLoss }} (ไปที่ {{ qualityResult.target }})
                    </div>
                </div>
            </div>

            <div class="op">
                <div class="opname">ตรวจอัปเดต RouterOS</div>
                <div class="sub">ดูว่ามีเวอร์ชันใหม่ให้ติดตั้งหรือยัง</div>
                <button type="button" class="v2-btn ghost" :disabled="busy === 'update'" @click="checkUpdate">
                    <i class="fa-solid" :class="busy === 'update' ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-down'"></i> ตรวจอัปเดต
                </button>
                <div v-if="updateInfo" class="result">
                    <div>ติดตั้งอยู่ <strong>{{ updateInfo.installedVersion || updateInfo.currentVersion || '-' }}</strong></div>
                    <div>ล่าสุด <strong>{{ updateInfo.latestVersion || '-' }}</strong></div>
                    <div :class="updateInfo.isNewAvailable ? 'bad' : 'ok'">
                        {{ updateInfo.isNewAvailable ? 'มีเวอร์ชันใหม่' : 'เป็นเวอร์ชันล่าสุดแล้ว' }}
                    </div>
                </div>
            </div>

            <div class="op">
                <div class="opname">ล้างแคช DNS</div>
                <div class="sub">ใช้เมื่อเว็บบางเว็บเข้าไม่ได้เพราะ DNS ค้างของเก่า</div>
                <button type="button" class="v2-btn ghost" :disabled="busy === 'flush'" @click="flushDns">
                    <i class="fa-solid" :class="busy === 'flush' ? 'fa-spinner fa-spin' : 'fa-broom'"></i> ล้างแคช DNS
                </button>
            </div>
        </div>
    </div>

    <!-- จัดการพื้นที่และไฟล์ในเราท์เตอร์ -->
    <div class="panel">
        <div class="ptitle">
            <i class="fa-solid fa-folder-open"></i> จัดการพื้นที่และไฟล์ในเราท์เตอร์
            <button type="button" class="v2-btn ghost sm ml-auto" :disabled="busy === 'loadfiles'" @click="loadFiles">
                <i class="fa-solid" :class="busy === 'loadfiles' ? 'fa-spinner fa-spin' : 'fa-rotate'"></i> ดูไฟล์ในเราท์เตอร์
            </button>
        </div>
        <div class="sub" style="margin-bottom: 12px;">
            ตรวจสอบไฟล์ตกค้าง เช่น backup เก่า, ไฟล์ autosave, supout.rif เพื่อคืนพื้นที่ว่างให้ flash storage
        </div>

        <div v-if="filesData" class="files-container">
            <!-- ข้อมูลพื้นที่จัดเก็บ -->
            <div class="storage-summary-bar">
                <div class="storage-item">
                    <span class="slabel">พื้นที่ใช้ไป:</span>
                    <span class="sval v2-num">{{ formatBytes(filesData.usedHdd || 0) }} / {{ formatBytes(filesData.totalHdd || 0) }}</span>
                </div>
                <div class="storage-item">
                    <span class="slabel">พื้นที่ว่าง:</span>
                    <span class="sval v2-num" :class="filesData.freeHdd < 1600000 ? 'bad' : 'ok'">{{ formatBytes(filesData.freeHdd || 0) }}</span>
                </div>
                <div class="storage-item">
                    <span class="slabel">ไฟล์ชั่วคราว/ขยะ:</span>
                    <span class="sval v2-num">{{ filesData.tempFilesCount || 0 }} ไฟล์ ({{ formatBytes(filesData.tempFilesBytes || 0) }})</span>
                </div>
                <button v-if="filesData.tempFilesCount > 0" type="button" class="v2-btn danger sm" :disabled="busy === 'cleantemp'" @click="cleanTempFiles">
                    <i class="fa-solid" :class="busy === 'cleantemp' ? 'fa-spinner fa-spin' : 'fa-trash-can'"></i> ล้างไฟล์ขยะ 1-Click
                </button>
            </div>

            <!-- ตารางรายการไฟล์ -->
            <div v-if="filesData.files && filesData.files.length" class="table-wrap">
                <table class="ftable">
                    <thead>
                        <tr>
                            <th>ชื่อไฟล์</th>
                            <th>ประเภท</th>
                            <th>ขนาด</th>
                            <th>วันที่สร้าง</th>
                            <th style="text-align: right;">จัดการ</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-for="f in filesData.files" :key="f.name">
                            <td class="mono font-bold">{{ f.name }}</td>
                            <td>
                                <span class="tag" :class="f.category">{{ f.category }}</span>
                            </td>
                            <td class="v2-num">{{ formatBytes(f.size || 0) }}</td>
                            <td class="v2-num">{{ f.creationTime || '-' }}</td>
                            <td style="text-align: right;">
                                <button type="button" class="v2-btn danger sm" :disabled="busy === 'del-' + f.name" @click="deleteSingleFile(f.name)">
                                    <i class="fa-solid fa-trash"></i>
                                </button>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div v-else class="sub empty-files">
                ไม่พบไฟล์เพิ่มเติมในเราท์เตอร์
            </div>
        </div>
    </div>

    <!-- กระทบผู้ใช้ — ต้องยืนยัน -->
    <div class="panel danger">
        <div class="ptitle"><i class="fa-solid fa-triangle-exclamation"></i> คำสั่งที่กระทบผู้ใช้งาน</div>
        <div class="sub warnline">
            สามอย่างนี้ทำให้ผู้ใช้ในสาขาหลุดจากอินเทอร์เน็ตชั่วคราว ควรทำนอกเวลาใช้งานหนัก
        </div>

        <div class="opsgrid">
            <div class="op">
                <div class="opname">สำรองคอนฟิกออกมาเก็บไว้</div>
                <div class="sub">
                    ดึงคอนฟิกออกมาเก็บที่เซิร์ฟเวอร์ + R2 พร้อม SHA-256 —
                    <strong>ใช้กู้ได้จริงแม้เราท์เตอร์พังหรือหาย</strong>
                    (ระบบทำให้เองทุกคืน 02:30 น. เฉพาะวันที่คอนฟิกเปลี่ยน)
                </div>
                <button type="button" class="v2-btn primary" :disabled="busy === 'cfgbackup'" @click="backupConfig">
                    <i class="fa-solid" :class="busy === 'cfgbackup' ? 'fa-spinner fa-spin' : 'fa-cloud-arrow-up'"></i>
                    สำรองตอนนี้
                </button>
                <div v-if="cfgResult" class="cfgok">
                    <i class="fa-solid fa-circle-check"></i>
                    {{ cfgResult.fileName }} · {{ cfgResult.commandLines }} บรรทัด ·
                    {{ cfgResult.sizeBytes }} bytes{{ cfgResult.storedOnR2 ? ' · ขึ้น R2 แล้ว' : ' · เก็บที่เซิร์ฟเวอร์' }}
                </div>
            </div>

            <div class="op">
                <div class="opname">สำรองค่าไว้ในเราท์เตอร์</div>
                <div class="sub">
                    สร้างไฟล์ .backup เก็บไว้<strong>บนตัวเราท์เตอร์เอง</strong> —
                    ใช้ย้อนค่าเร็ว ๆ ได้ แต่หายไปพร้อมเราท์เตอร์ถ้าเครื่องพัง
                </div>
                <button type="button" class="v2-btn ghost" :disabled="busy === 'backup'" @click="backup">
                    <i class="fa-solid" :class="busy === 'backup' ? 'fa-spinner fa-spin' : 'fa-floppy-disk'"></i> สำรองค่า
                </button>
            </div>

            <div class="op">
                <div class="opname">อัปเกรด 1 คลิก</div>
                <div class="sub">ติดตั้ง RouterOS + เฟิร์มแวร์ แล้วรีบูตอัตโนมัติ</div>
                <div class="inline">
                    <button type="button" class="v2-btn ghost" @click="openUpgrade('full')">
                        <i class="fa-solid fa-rocket"></i> RouterOS + เฟิร์มแวร์
                    </button>
                    <button type="button" class="v2-btn ghost" @click="openUpgrade('firmware')">
                        <i class="fa-solid fa-microchip"></i> เฉพาะเฟิร์มแวร์
                    </button>
                </div>
            </div>

            <div class="op">
                <div class="opname">รีบูตเราท์เตอร์</div>
                <div class="sub">ผู้ใช้ทั้งสาขาหลุด 1-3 นาที</div>
                <button type="button" class="v2-btn danger" :disabled="busy === 'reboot'" @click="reboot">
                    <i class="fa-solid" :class="busy === 'reboot' ? 'fa-spinner fa-spin' : 'fa-power-off'"></i> รีบูต
                </button>
            </div>
        </div>
    </div>

    <FullUpgradeModal :open="upgradeOpen" :mode="upgradeMode"
        @close="upgradeOpen = false" @done="onUpgradeDone" />
</template>

<style scoped>
.panel { border: 1px solid var(--v2-border); border-radius: 12px; padding: 16px; margin-bottom: 16px; background: var(--v2-surface); }
.panel.danger { border-color: color-mix(in srgb, var(--v2-danger) 35%, transparent); }
.ptitle { font-weight: 600; font-size: .9rem; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
.panel.danger .ptitle { color: var(--v2-danger); }
.warnline { margin: -4px 0 12px; }
.opsgrid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.op { border: 1px solid var(--v2-border); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
.opname { font-weight: 600; font-size: .85rem; }
.sub { font-size: .8rem; color: var(--v2-text-muted); }
.inline { display: flex; gap: 8px; flex-wrap: wrap; }
.inline .v2-input { flex: 1; min-width: 90px; }
.inline .v2-input.num { max-width: 72px; flex: 0 0 72px; }
.cfgok {
    margin-top: 9px; font-size: .78rem; color: var(--v2-success);
    background: var(--v2-success-soft); border-radius: 8px; padding: 7px 10px; line-height: 1.55;
}
.cfgok i { margin-right: 5px; }
.result { margin-top: 4px; padding: 8px 10px; border-radius: 8px; background: var(--v2-primary-soft); font-size: .82rem; }
.result .ok { color: var(--v2-success); font-weight: 600; }
.result .bad { color: var(--v2-danger); font-weight: 600; }
.grade { display: inline-block; font-weight: 700; font-size: 1.1rem; margin-right: 8px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.ml-auto { margin-left: auto; }

/* File manager styles */
.files-container {
    margin-top: 10px;
    border: 1px solid var(--v2-border);
    border-radius: 10px;
    padding: 12px;
    background: var(--v2-bg);
}
.storage-summary-bar {
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    margin-bottom: 12px;
    padding-bottom: 10px;
    border-bottom: 1px solid var(--v2-border);
}
.storage-item {
    font-size: .82rem;
    display: flex;
    gap: 6px;
}
.slabel { color: var(--v2-text-muted); }
.sval { font-weight: 600; }
.sval.ok { color: var(--v2-success); }
.sval.bad { color: var(--v2-danger); }
.table-wrap { overflow-x: auto; }
.ftable { width: 100%; border-collapse: collapse; font-size: .8rem; }
.ftable th, .ftable td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--v2-border); }
.ftable th { font-weight: 600; color: var(--v2-text-muted); font-size: .75rem; text-transform: uppercase; }
.ftable tr:last-child td { border-bottom: none; }
.font-bold { font-weight: 600; }
.tag {
    display: inline-block; padding: 2px 7px; border-radius: 6px; font-size: .72rem; font-weight: 600;
}
.tag.temp, .tag.log { background: #fee2e2; color: #b91c1c; }
.tag.backup, .tag.config { background: #e0f2fe; color: #0369a1; }
.tag.package { background: #fef3c7; color: #b45309; }
.tag.other { background: #f1f5f9; color: #475569; }
.empty-files { padding: 12px 0; text-align: center; }
</style>
