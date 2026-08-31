<script setup>
/**
 * คำสั่งจัดการเราท์เตอร์ — ย้ายมาจากแท็บที่ 4 ของหน้าตั้งค่าในระบบเดิม
 *
 * ทุกปุ่มในนี้สั่งงานเราท์เตอร์ที่ลูกค้ากำลังใช้อยู่จริง จึงแยกเป็นสองกลุ่มชัดเจน:
 * กลุ่มตรวจสอบ (ไม่กระทบผู้ใช้) กับกลุ่มที่กระทบ (รีบูตทำให้เน็ตหลุดทั้งสาขา)
 * และกลุ่มหลังต้องยืนยันก่อนเสมอ
 */
import { ref } from 'vue';
import { apiFetch } from '../api.js';
import { toast } from '../toast.js';
import BaseModal from './BaseModal.vue';
import FullUpgradeModal from './FullUpgradeModal.vue';

const busy = ref('');
const pingResult = ref(null);
const qualityResult = ref(null);
const updateInfo = ref(null);
const upgradeOpen = ref(false);
const upgradeMode = ref('full');

const pingHost = ref('8.8.8.8');
const pingCount = ref(4);

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

    <!-- กระทบผู้ใช้ — ต้องยืนยัน -->
    <div class="panel danger">
        <div class="ptitle"><i class="fa-solid fa-triangle-exclamation"></i> คำสั่งที่กระทบผู้ใช้งาน</div>
        <div class="sub warnline">
            สามอย่างนี้ทำให้ผู้ใช้ในสาขาหลุดจากอินเทอร์เน็ตชั่วคราว ควรทำนอกเวลาใช้งานหนัก
        </div>

        <div class="opsgrid">
            <div class="op">
                <div class="opname">สำรองค่าเราท์เตอร์</div>
                <div class="sub">สร้างไฟล์ .backup เก็บไว้ในเราท์เตอร์ ใช้เวลาสักครู่</div>
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
.result { margin-top: 4px; padding: 8px 10px; border-radius: 8px; background: var(--v2-primary-soft); font-size: .82rem; }
.result .ok { color: var(--v2-success); font-weight: 600; }
.result .bad { color: var(--v2-danger); font-weight: 600; }
.grade { display: inline-block; font-weight: 700; font-size: 1.1rem; margin-right: 8px; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
