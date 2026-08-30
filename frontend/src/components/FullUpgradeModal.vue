<script setup>
import { ref, computed, watch } from 'vue';
import { apiFetch } from '../api.js';

const props = defineProps({
    open: { type: Boolean, default: false },
    // 'full'     = อัปเดต RouterOS แล้วต่อด้วย Firmware (4 ขั้น)
    // 'firmware' = ข้ามขั้น RouterOS ไปเลย ใช้ตอน ROS อัปครบแล้วเหลือแต่ Firmware (2 ขั้น)
    mode: { type: String, default: 'full' }
});
const emit = defineEmits(['close', 'done']);

const STEPS_FULL = [
    { key: 'ros-install', title: 'ดาวน์โหลด & ติดตั้ง RouterOS Package', desc: 'รอเริ่มคำสั่ง...' },
    { key: 'ros-reboot', title: 'รอเราท์เตอร์รีสตาร์ทเข้า RouterOS ใหม่', desc: 'รอการเริ่มต้นใหม่...' },
    { key: 'fw-upgrade', title: 'อัปเกรด RouterBOARD Firmware', desc: 'รอการตรวจสอบ Firmware...' },
    { key: 'fw-reboot', title: 'รีบูตรอบสุดท้าย & พร้อมใช้งาน', desc: 'รอเสร็จสิ้น...' }
];

const STEPS_FIRMWARE = [
    { key: 'fw-upgrade', title: 'อัปเกรด RouterBOARD Firmware', desc: 'รอเริ่มคำสั่ง...' },
    { key: 'fw-reboot', title: 'รีบูต & ตรวจสอบว่ากลับมาออนไลน์', desc: 'รอเสร็จสิ้น...' }
];

const stepDefs = computed(() => (props.mode === 'firmware' ? STEPS_FIRMWARE : STEPS_FULL));
const isFirmwareOnly = computed(() => props.mode === 'firmware');

const steps = ref(STEPS_FULL.map((s) => ({ ...s, state: 'waiting' })));
const running = ref(false);
const finished = ref(false);
const failure = ref('');

watch(
    () => props.open,
    (isOpen) => {
        if (!isOpen) return;
        steps.value = stepDefs.value.map((s) => ({ ...s, state: 'waiting' }));
        running.value = false;
        finished.value = false;
        failure.value = '';
    }
);

function setStep(i, state, desc) {
    steps.value[i] = { ...steps.value[i], state, desc: desc ?? steps.value[i].desc };
}

async function pollUntilOnline(maxWaitSec, onTick) {
    const startedAt = Date.now();
    await new Promise((r) => setTimeout(r, 15000));
    while ((Date.now() - startedAt) / 1000 < maxWaitSec) {
        onTick(Math.round((Date.now() - startedAt) / 1000));
        try {
            const s = await apiFetch('/api/mikrotik/status');
            if (s && s.version && s.version !== 'N/A') return s;
        } catch (_) {
            /* เราท์เตอร์กำลังรีบูต — ปกติ */
        }
        await new Promise((r) => setTimeout(r, 4000));
    }
    throw new Error('หมดเวลาการรอคอย เราท์เตอร์ยังไม่ตอบกลับ API (กรุณาตรวจเช็คที่หน้างาน)');
}

async function runFullUpgrade() {
    setStep(0, 'active', 'กำลังส่งคำสั่งดาวน์โหลดและติดตั้ง RouterOS Packages...');
    await apiFetch('/api/mikrotik/system/update-install', { method: 'POST' });
    setStep(0, 'done', 'ติดตั้ง RouterOS สำเร็จแล้ว เราท์เตอร์กำลัง Reboot');

    setStep(1, 'active', 'เราท์เตอร์กำลังเริ่มต้นใหม่ (Rebooting)... กรุณารอสักครู่');
    const ros = await pollUntilOnline(180, (sec) =>
        setStep(1, 'active', `กำลังรอเราท์เตอร์รีบูตเข้า RouterOS ใหม่... (${sec} วินาที)`)
    );
    setStep(1, 'done', `ออนไลน์แล้ว! RouterOS: ${ros.version}`);

    setStep(2, 'active', 'กำลังสั่งอัปเกรด RouterBOARD Firmware...');
    await new Promise((r) => setTimeout(r, 2000));
    await apiFetch('/api/mikrotik/system/full-upgrade-stage2', { method: 'POST' });
    setStep(2, 'done', 'สั่งอัปเกรด Firmware สำเร็จแล้ว เราท์เตอร์กำลัง Reboot ครั้งสุดท้าย');

    setStep(3, 'active', 'กำลังรอการรีบูตรอบสุดท้ายเพื่อให้ Firmware ใหม่มีผล...');
    const final = await pollUntilOnline(150, (sec) =>
        setStep(3, 'active', `กำลังรอรีบูตครั้งสุดท้าย... (${sec} วินาที)`)
    );
    setStep(3, 'done', `เสร็จสมบูรณ์! Firmware: ${final.currentFirmware || final.version}`);
}

// ใช้ตอน RouterOS อัปครบแล้ว เหลือแต่ Firmware ของบอร์ด
// full-upgrade-stage2 คือ /system/routerboard/upgrade แล้วสั่งรีบูตต่อให้อัตโนมัติ
async function runFirmwareUpgrade() {
    setStep(0, 'active', 'กำลังสั่งอัปเกรด RouterBOARD Firmware...');
    await apiFetch('/api/mikrotik/system/full-upgrade-stage2', { method: 'POST' });
    setStep(0, 'done', 'สั่งอัปเกรด Firmware สำเร็จแล้ว เราท์เตอร์กำลังรีบูต');

    setStep(1, 'active', 'กำลังรอเราท์เตอร์รีบูตเพื่อให้ Firmware ใหม่มีผล...');
    const final = await pollUntilOnline(150, (sec) =>
        setStep(1, 'active', `กำลังรอเราท์เตอร์กลับมาออนไลน์... (${sec} วินาที)`)
    );
    setStep(1, 'done', `เสร็จสมบูรณ์! Firmware ปัจจุบัน: ${final.currentFirmware || final.version}`);
}

const CONFIRM_FIRMWARE = [
    '⚠️ ยืนยันอัปเกรด RouterBOARD Firmware?',
    '',
    'เราท์เตอร์จะรีบูต 1 ครั้ง เน็ตจะหลุดชั่วคราวราว 1-3 นาที',
    'ห้ามปิดหน้านี้จนกว่าจะขึ้นว่าเสร็จสมบูรณ์'
].join('\n');

const CONFIRM_FULL = [
    '⚠️ ยืนยันอัปเกรดระบบเต็มรูปแบบ?',
    '',
    'เราท์เตอร์จะรีบูต 2 ครั้ง เน็ตจะหลุดชั่วคราวราว 2-5 นาที',
    'ห้ามปิดหน้านี้จนกว่าจะขึ้นว่าเสร็จสมบูรณ์'
].join('\n');

async function start() {
    const ok = window.confirm(isFirmwareOnly.value ? CONFIRM_FIRMWARE : CONFIRM_FULL);
    if (!ok) return;

    running.value = true;
    failure.value = '';
    try {
        if (isFirmwareOnly.value) await runFirmwareUpgrade();
        else await runFullUpgrade();
        finished.value = true;
        emit('done');
    } catch (err) {
        failure.value = err.message;
        const idx = steps.value.findIndex((s) => s.state === 'active');
        if (idx >= 0) setStep(idx, 'error', err.message);
    } finally {
        running.value = false;
    }
}
</script>

<template>
    <!--
      Teleport ย้าย DOM ของโมดัลไปแปะที่ <body> เสมอ ไม่ว่าจะเขียน component นี้
      ซ้อนอยู่ลึกแค่ไหน — บั๊ก 28 ส.ค. (โมดัลไปติดอยู่ใน parent ที่ opacity:0)
      เกิดซ้ำไม่ได้อีกในเชิงโครงสร้าง ไม่ใช่แค่ "ระวังตอนเขียน"
    -->
    <Teleport to="body">
        <div v-if="open" class="v2-modal-backdrop" @click.self="!running && emit('close')">
            <div class="v2-modal-card">
                <div class="v2-modal-header">
                    <h4>
                        <i class="fa-solid" :class="isFirmwareOnly ? 'fa-bolt' : 'fa-wand-magic-sparkles'"></i>
                        {{ isFirmwareOnly ? 'อัปเกรด RouterBOARD Firmware' : 'อัปเกรดระบบเต็มรูปแบบ 1-Click (ROS + Firmware)' }}
                    </h4>
                    <button
                        type="button"
                        class="v2-modal-close"
                        :disabled="running"
                        @click="emit('close')"
                    >&times;</button>
                </div>

                <div class="v2-modal-body">
                    <div class="v2-alert">
                        <i class="fa-solid fa-circle-info"></i>
                        <template v-if="isFirmwareOnly">
                            RouterOS เป็นเวอร์ชันล่าสุดแล้ว เหลือเฉพาะ Firmware ของบอร์ด:
                            <strong>1. อัปเกรด Firmware</strong> ➔ <strong>2. รีบูต 1 ครั้ง</strong>
                        </template>
                        <template v-else>
                            ระบบจะทำตามขั้นตอนอัตโนมัติ:
                            <strong>1. อัปเดต RouterOS</strong> ➔
                            <strong>2. รีบูตรอบที่ 1</strong> ➔
                            <strong>3. อัปเกรด Firmware</strong> ➔
                            <strong>4. รีบูตรอบสุดท้าย</strong>
                        </template>
                    </div>

                    <div class="v2-steps">
                        <div
                            v-for="(step, i) in steps"
                            :key="i"
                            class="v2-step"
                            :class="'is-' + step.state"
                        >
                            <div class="v2-step-icon">
                                <i v-if="step.state === 'active'" class="fa-solid fa-spinner fa-spin"></i>
                                <i v-else-if="step.state === 'done'" class="fa-solid fa-check"></i>
                                <i v-else-if="step.state === 'error'" class="fa-solid fa-xmark"></i>
                                <template v-else>{{ i + 1 }}</template>
                            </div>
                            <div class="v2-step-text">
                                <div class="v2-step-title">{{ step.title }}</div>
                                <div class="v2-step-desc">{{ step.desc }}</div>
                            </div>
                        </div>
                    </div>

                    <div v-if="failure" class="v2-failure">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        <div class="msg">
                            <div class="head">อัปเกรดไม่สำเร็จ</div>
                            <!-- ข้อความจาก server อาจมีหลายบรรทัด (คำอธิบาย + วิธีแก้ + ข้อความดิบ)
                                 ถ้าไม่คง newline ไว้จะติดกันเป็นพืดจนอ่านไม่รู้เรื่อง -->
                            <div class="detail">{{ failure }}</div>
                        </div>
                    </div>
                    <div v-else-if="finished" class="v2-success">
                        🎉 {{ isFirmwareOnly ? 'อัปเกรด Firmware สำเร็จเรียบร้อยแล้วครับ' : 'อัปเกรดสำเร็จสมบูรณ์ทั้ง RouterOS และ Firmware เรียบร้อยแล้วครับ' }}
                    </div>
                </div>

                <div class="v2-modal-footer">
                    <button
                        type="button"
                        class="btn btn-secondary"
                        :disabled="running"
                        @click="emit('close')"
                    >ปิด</button>
                    <button
                        v-if="!finished"
                        type="button"
                        class="btn btn-primary"
                        :disabled="running"
                        @click="start"
                    >
                        <i class="fa-solid" :class="running ? 'fa-spinner fa-spin' : 'fa-play'"></i>
                        {{ running ? 'กำลังดำเนินการ...' : (isFirmwareOnly ? 'เริ่มอัปเกรด Firmware ทันที' : 'เริ่มอัปเกรดเต็มรูปแบบทันที') }}
                    </button>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<style scoped>
.v2-modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.65);
    backdrop-filter: blur(6px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px 12px;
    overflow-y: auto;
    z-index: 99999;
}

.v2-modal-card {
    background: #fff;
    border-radius: 12px;
    width: 100%;
    max-width: 580px;
    margin: auto;
    box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 40px);
    overflow: hidden;
}

.v2-modal-header {
    padding: 18px 24px;
    border-bottom: 1px solid #e2e8f0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
}

.v2-modal-header h4 {
    margin: 0;
    font-size: 1.02rem;
    font-weight: 700;
    color: #1e293b;
}

.v2-modal-header i {
    color: #2563eb;
}

.v2-modal-close {
    background: none;
    border: none;
    font-size: 1.6rem;
    line-height: 1;
    color: #94a3b8;
    cursor: pointer;
}

.v2-modal-close:disabled {
    opacity: 0.4;
    cursor: not-allowed;
}

.v2-modal-body {
    padding: 20px 24px;
    overflow-y: auto;
}

.v2-alert {
    font-size: 0.85rem;
    padding: 10px 14px;
    margin-bottom: 16px;
    border-radius: 6px;
    background: #eff6ff;
    color: #1e40af;
    border: 1px solid #bfdbfe;
}

.v2-steps {
    display: flex;
    flex-direction: column;
    gap: 12px;
}

.v2-step {
    background: #f8fafc;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 12px;
    display: flex;
    gap: 12px;
    align-items: center;
    transition: background 0.2s ease, border-color 0.2s ease;
}

.v2-step.is-active { background: #eff6ff; border-color: #93c5fd; }
.v2-step.is-done { background: #f0fdf4; border-color: #86efac; }
.v2-step.is-error { background: #fef2f2; border-color: #fca5a5; }
.v2-failure .msg { min-width: 0; }
.v2-failure .head { font-weight: 700; margin-bottom: 4px; }
.v2-failure .detail { white-space: pre-line; line-height: 1.6; font-weight: 400; }

.v2-step-icon {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: #e2e8f0;
    color: #64748b;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 700;
    font-size: 0.85rem;
    flex-shrink: 0;
}

.is-active .v2-step-icon { background: #2563eb; color: #fff; }
.is-done .v2-step-icon { background: #16a34a; color: #fff; }
.is-error .v2-step-icon { background: #dc2626; color: #fff; }

.v2-step-title {
    font-weight: 700;
    color: #1e293b;
    font-size: 0.9rem;
}

.v2-step-desc {
    white-space: pre-line;
    font-size: 0.8rem;
    color: #64748b;
}

.v2-failure,
.v2-success {
    margin-top: 16px;
    padding: 10px 14px;
    border-radius: 6px;
    font-size: 0.85rem;
}

.v2-failure {
    background: #fef2f2;
    border: 1px solid #fecaca;
    color: #b91c1c;
    display: flex;
    gap: 10px;
    align-items: flex-start;
}
.v2-failure > i { margin-top: 3px; flex-shrink: 0; }

.v2-success {
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    color: #15803d;
}

.v2-modal-footer {
    padding: 16px 24px;
    border-top: 1px solid #e2e8f0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
}
</style>
