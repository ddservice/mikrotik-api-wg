<script setup>
/**
 * สคริปต์ตั้ง PPPoE Server ครั้งแรกของสาขา
 *
 * ทำครั้งเดียวต่อสาขา แต่เป็นขั้นที่ "สร้างระบบห้องเช่า" ขึ้นมา — ถ้าไม่มีใน v2
 * การเปิดสาขาใหม่ยังต้องกลับไปหน้าเดิม ซึ่งขัดกับหลักที่วางไว้ว่า v2 ต้องครบวงจรชีวิตสาขา
 *
 * จงใจให้เป็นแค่ตัวสร้างข้อความ ไม่มีปุ่มสั่งลงเราท์เตอร์: สคริปต์นี้สร้าง VLAN,
 * IP pool และเปิด PPPoE server บนอินเทอร์เฟซที่ระบุ ถ้าเลือกอินเทอร์เฟซผิดเป็นขาที่
 * ใช้เชื่อมออกอินเทอร์เน็ตหรือขาที่เราคุยอยู่ สาขาจะหลุดทันที — คนต้องอ่านก่อนรัน
 */
import { ref } from 'vue';
import { apiFetch } from '../api.js';
import { toast } from '../toast.js';

const open = ref(false);
const busy = ref(false);
const script = ref('');
const form = ref({
    interfaceName: '',
    vlanId: '',
    poolStart: '',
    poolEnd: '',
    serverAddress: '',
    keepaliveTimeout: '10'
});

async function generate() {
    const f = form.value;
    if (!f.interfaceName || !f.poolStart || !f.poolEnd || !f.serverAddress) {
        return toast.error('ต้องระบุ Interface, IP Pool (ต้น-ปลาย) และ Server Address ให้ครบ');
    }
    busy.value = true;
    try {
        const r = await apiFetch('/api/mikrotik/pppoe/generate-script', {
            method: 'POST',
            body: JSON.stringify({
                interfaceName: f.interfaceName.trim(),
                vlanId: String(f.vlanId || '').trim(),
                poolStart: f.poolStart.trim(),
                poolEnd: f.poolEnd.trim(),
                serverAddress: f.serverAddress.trim(),
                keepaliveTimeout: String(f.keepaliveTimeout || '10').trim()
            })
        });
        script.value = r.script || '';
    } catch (err) {
        toast.error(err.message);
    } finally {
        busy.value = false;
    }
}

async function copy() {
    try {
        await navigator.clipboard.writeText(script.value);
        toast.success('คัดลอกแล้ว — ไปวางใน WinBox → New Terminal');
    } catch (_) {
        toast.error('คัดลอกอัตโนมัติไม่ได้ — เลือกข้อความแล้วกด Ctrl+C');
    }
}
</script>

<template>
    <div class="panel">
        <button type="button" class="head" @click="open = !open">
            <i class="fa-solid fa-screwdriver-wrench"></i>
            <span class="t">ตั้ง PPPoE Server ครั้งแรกของสาขานี้</span>
            <span class="sub">ทำครั้งเดียวตอนเปิดสาขา — สร้าง VLAN, IP pool และเปิดเซิร์ฟเวอร์</span>
            <i class="fa-solid chev" :class="open ? 'fa-chevron-up' : 'fa-chevron-down'"></i>
        </button>

        <div v-if="open" class="body">
            <div class="v2-callout warn">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span>
                    เลือก interface ให้เป็น<strong>ขาที่ต่อไปยังห้องพัก</strong>เท่านั้น
                    ถ้าเผลอใส่ขาที่ใช้ออกอินเทอร์เน็ตหรือขาที่ระบบนี้ใช้คุยกับเราท์เตอร์อยู่
                    สาขาจะหลุดทันทีที่รันสคริปต์
                </span>
            </div>

            <div class="v2-row-2">
                <div class="v2-field">
                    <label>Interface ที่ต่อไปห้องพัก <span class="req">*</span></label>
                    <input v-model="form.interfaceName" class="v2-input mono" placeholder="เช่น ether5 หรือ bridge-rooms">
                </div>
                <div class="v2-field">
                    <label>VLAN ID (ถ้ามี)</label>
                    <input v-model="form.vlanId" class="v2-input mono" placeholder="เช่น 100">
                    <span class="v2-hint">เว้นว่างถ้าต่อตรงไม่ผ่าน VLAN</span>
                </div>
            </div>

            <div class="v2-row-2">
                <div class="v2-field">
                    <label>IP Pool เริ่มต้น <span class="req">*</span></label>
                    <input v-model="form.poolStart" class="v2-input mono" placeholder="เช่น 10.20.0.2">
                </div>
                <div class="v2-field">
                    <label>IP Pool สิ้นสุด <span class="req">*</span></label>
                    <input v-model="form.poolEnd" class="v2-input mono" placeholder="เช่น 10.20.0.254">
                </div>
            </div>

            <div class="v2-row-2">
                <div class="v2-field">
                    <label>Server Address <span class="req">*</span></label>
                    <input v-model="form.serverAddress" class="v2-input mono" placeholder="เช่น 10.20.0.1">
                    <span class="v2-hint">IP ฝั่งเราท์เตอร์ที่ห้องจะมองเห็นเป็น gateway</span>
                </div>
                <div class="v2-field">
                    <label>Keepalive Timeout</label>
                    <input v-model="form.keepaliveTimeout" class="v2-input mono" placeholder="10">
                    <span class="v2-hint">วินาทีที่รอก่อนถือว่าห้องหลุด (ปกติ 10)</span>
                </div>
            </div>

            <div class="actions">
                <button type="button" class="v2-btn primary" :disabled="busy" @click="generate">
                    <i class="fa-solid" :class="busy ? 'fa-spinner fa-spin' : 'fa-file-code'"></i> สร้างสคริปต์
                </button>
            </div>

            <template v-if="script">
                <div class="scriptbar">
                    <span class="sub">วางใน WinBox → New Terminal แล้วกด Enter</span>
                    <button type="button" class="v2-btn ghost sm" @click="copy">
                        <i class="fa-solid fa-copy"></i> คัดลอก
                    </button>
                </div>
                <textarea class="script mono" readonly :value="script" spellcheck="false"></textarea>
                <p class="fine">
                    หลังรันเสร็จ ให้สร้าง "แพ็กเกจ" อย่างน้อยหนึ่งอันในแท็บนี้ก่อน แล้วค่อยไปเพิ่มห้องพัก
                </p>
            </template>
        </div>
    </div>
</template>

<style scoped>
.panel {
    margin-top: 16px; background: var(--v2-surface); border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius); box-shadow: var(--v2-shadow); overflow: hidden;
}
.head {
    width: 100%; display: flex; align-items: center; gap: 10px; font: inherit; text-align: left;
    background: none; border: none; padding: 14px 16px; cursor: pointer; color: var(--v2-text);
}
.head:hover { background: var(--v2-bg); }
.head > i:first-child { color: var(--v2-primary); }
.head .t { font-weight: 700; font-size: .92rem; }
.head .sub { font-size: .78rem; color: var(--v2-text-muted); }
.head .chev { margin-left: auto; font-size: .72rem; color: var(--v2-text-muted); }

.body { padding: 0 16px 16px; }
.actions { display: flex; justify-content: flex-end; margin-top: 8px; }
.req { color: var(--v2-danger); }
.scriptbar { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 14px; }
.sub { font-size: .78rem; color: var(--v2-text-muted); }
.fine { margin: 8px 0 0; font-size: .77rem; color: var(--v2-text-muted); }
.script {
    width: 100%; min-height: 220px; margin-top: 6px; padding: 12px; border-radius: 8px;
    border: 1px solid var(--v2-border); background: var(--v2-bg);
    font-size: .75rem; line-height: 1.6; resize: vertical; white-space: pre; overflow-x: auto;
}
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
</style>
