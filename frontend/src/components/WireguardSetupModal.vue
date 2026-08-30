<script setup>
/**
 * สร้างสคริปต์ตั้งค่า WireGuard สำหรับเราท์เตอร์สาขาใหม่
 *
 * ทำไมต้องมีใน v2: นี่คือขั้นตอนที่ "สร้างการเชื่อมต่อ" ถ้าไม่มี v2 จะเพิ่มได้แค่
 * แถวข้อมูลสาขา แต่ต่อเข้าเราท์เตอร์จริงไม่ได้เลย และ 3 ใน 4 สาขาที่ใช้อยู่
 * ต่อผ่าน WireGuard ทั้งหมด — v2 จึงแทนหน้าเดิมไม่ได้จนกว่าจะมีอันนี้
 *
 * ตัวสคริปต์แค่ประกอบข้อความ ความเสี่ยงอยู่ที่ฝั่งเราท์เตอร์ซึ่งคนต้องเอาไปวางเอง
 * และดูก่อนรันได้ — จงใจไม่ทำให้กดแล้วสั่งเราท์เตอร์โดยตรง
 */
import { ref, watch, computed } from 'vue';
import { apiFetch } from '../api.js';
import { toast } from '../toast.js';
import BaseModal from './BaseModal.vue';

const props = defineProps({
    open: { type: Boolean, default: false },
    site: { type: Object, default: null },
    usedIps: { type: Array, default: () => [] }
});
const emit = defineEmits(['close', 'registered']);

const wireguardIp = ref('');
const port = ref(8728);
const script = ref('');
const autoRegistered = ref(false);
const busy = ref('');
const err = ref('');
const peer = ref(null);

// เสนอ IP ว่างตัวถัดไปในวง 10.10.88.x ให้ ไม่ต้องไปไล่ดูเองว่าตัวไหนว่าง
const suggestedIp = computed(() => {
    const used = new Set(props.usedIps.filter(Boolean));
    for (let i = 2; i < 250; i++) {
        const ip = '10.10.88.' + i;
        if (!used.has(ip)) return ip;
    }
    return '';
});

watch(() => props.open, (v) => {
    if (!v) return;
    script.value = '';
    err.value = '';
    peer.value = null;
    autoRegistered.value = false;
    wireguardIp.value = (props.site && props.site.wireguardIp) || suggestedIp.value;
    port.value = (props.site && props.site.port) || 8728;
});

async function generate() {
    const ip = String(wireguardIp.value || '').trim();
    if (!/^10\.10\.88\.\d{1,3}$/.test(ip)) {
        return toast.error('WireGuard IP ต้องอยู่ในรูปแบบ 10.10.88.x');
    }
    busy.value = 'gen';
    err.value = '';
    try {
        const r = await apiFetch('/api/wireguard/generate-script', {
            method: 'POST',
            body: JSON.stringify({
                wireguardIp: ip,
                port: Number(port.value) || 8728,
                siteId: props.site ? props.site.id : null
            })
        });
        script.value = r.script || '';
        autoRegistered.value = !!r.autoRegistered;
    } catch (e) {
        err.value = e.message;
    } finally {
        busy.value = '';
    }
}

async function copy() {
    try {
        await navigator.clipboard.writeText(script.value);
        toast.success('คัดลอกสคริปต์แล้ว — ไปวางใน WinBox → New Terminal');
    } catch (_) {
        // คลิปบอร์ดถูกบล็อกได้ในบางเบราว์เซอร์/บริบท ต้องมีทางสำรองเสมอ
        toast.error('คัดลอกอัตโนมัติไม่ได้ — กรุณาเลือกข้อความแล้วกด Ctrl+C');
    }
}

// ตรวจว่าเราท์เตอร์โทรกลับมาลงทะเบียนแล้วหรือยัง
async function checkPeer() {
    const ip = String(wireguardIp.value || '').trim();
    busy.value = 'check';
    try {
        const r = await apiFetch('/api/wireguard/peer-status?wireguardIp=' + encodeURIComponent(ip));
        peer.value = r;
        if (r && r.connected) {
            toast.success('เราท์เตอร์เชื่อมต่อเข้ามาแล้ว');
            emit('registered');
        }
    } catch (e) {
        toast.error('ตรวจสถานะไม่สำเร็จ: ' + e.message);
    } finally {
        busy.value = '';
    }
}
</script>

<template>
    <BaseModal
        :open="open" width="760px"
        :title="'ตั้งค่า WireGuard — ' + (site ? site.name : 'สาขาใหม่')"
        @close="emit('close')"
    >
        <div class="v2-callout warn">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <span>
                สคริปต์นี้จะ<strong>ลบและสร้าง interface WireGuard ใหม่</strong>บนเราท์เตอร์
                ถ้าเราท์เตอร์ตัวนั้นต่ออยู่ผ่านอุโมงค์เดิม จะหลุดชั่วครู่ระหว่างรัน
                — ควรทำตอนต่อผ่านสายในพื้นที่ หรือมีทางเข้าสำรอง
            </span>
        </div>

        <div class="v2-row-2">
            <div class="v2-field">
                <label>WireGuard IP ของสาขานี้ <span class="req">*</span></label>
                <input v-model="wireguardIp" class="v2-input mono" placeholder="10.10.88.5">
                <span class="v2-hint">
                    ต้องไม่ซ้ำกับสาขาอื่น
                    <template v-if="suggestedIp">· ว่างถัดไป: <code>{{ suggestedIp }}</code></template>
                </span>
            </div>
            <div class="v2-field">
                <label>พอร์ต API ของเราท์เตอร์</label>
                <input v-model="port" type="number" class="v2-input mono">
                <span class="v2-hint">ปกติ 8728 (API) — สคริปต์จะเปิดพอร์ตนี้ให้เฉพาะวงอุโมงค์</span>
            </div>
        </div>

        <div class="actions">
            <button type="button" class="v2-btn primary" :disabled="busy === 'gen'" @click="generate">
                <i class="fa-solid" :class="busy === 'gen' ? 'fa-spinner fa-spin' : 'fa-file-code'"></i>
                สร้างสคริปต์
            </button>
        </div>

        <div v-if="err" class="v2-callout danger">
            <i class="fa-solid fa-circle-xmark"></i>
            <span>{{ err }}</span>
        </div>

        <template v-if="script">
            <div class="v2-callout" :class="autoRegistered ? 'ok' : 'info'">
                <i class="fa-solid" :class="autoRegistered ? 'fa-wand-magic-sparkles' : 'fa-circle-info'"></i>
                <span v-if="autoRegistered">
                    <strong>ลงทะเบียนอัตโนมัติ:</strong> สคริปต์มีคำสั่งให้เราท์เตอร์ส่ง public key
                    กลับมาเอง ไม่ต้องคัดลอกคีย์ด้วยมือ — <strong>ใช้ได้ครั้งเดียวและหมดอายุใน 30 นาที</strong>
                    ถ้าเกินให้กดสร้างใหม่
                </span>
                <span v-else>
                    ยังไม่ได้ตั้ง <code>PUBLIC_APP_URL</code> จึงไม่มีการลงทะเบียนอัตโนมัติ —
                    ต้องคัดลอก public key จากเราท์เตอร์มาใส่เองหลังรันสคริปต์
                </span>
            </div>

            <div class="steps">
                <div class="s"><b>1</b> เปิด WinBox ต่อเข้าเราท์เตอร์สาขานี้</div>
                <div class="s"><b>2</b> เมนู <code>New Terminal</code></div>
                <div class="s"><b>3</b> วางสคริปต์ทั้งหมดแล้วกด Enter</div>
                <div class="s"><b>4</b> กลับมากด "ตรวจสถานะ" ด้านล่าง</div>
            </div>

            <div class="scriptbar">
                <span class="sub">สคริปต์สำหรับ {{ wireguardIp }}</span>
                <button type="button" class="v2-btn ghost sm" @click="copy">
                    <i class="fa-solid fa-copy"></i> คัดลอก
                </button>
            </div>
            <textarea class="script mono" readonly :value="script" spellcheck="false"></textarea>

            <div class="actions">
                <button type="button" class="v2-btn ghost" :disabled="busy === 'check'" @click="checkPeer">
                    <i class="fa-solid" :class="busy === 'check' ? 'fa-spinner fa-spin' : 'fa-satellite-dish'"></i>
                    ตรวจสถานะการเชื่อมต่อ
                </button>
            </div>

            <div v-if="peer" class="v2-callout" :class="peer.connected ? 'ok' : 'warn'">
                <i class="fa-solid" :class="peer.connected ? 'fa-circle-check' : 'fa-hourglass-half'"></i>
                <span v-if="peer.connected">
                    เชื่อมต่อแล้ว — handshake ล่าสุด {{ peer.lastHandshakeSecondsAgo ?? '-' }} วินาทีที่แล้ว
                </span>
                <span v-else>
                    ยังไม่มีการเชื่อมต่อเข้ามา — ตรวจว่ารันสคริปต์บนเราท์เตอร์แล้ว
                    และเราท์เตอร์ออกอินเทอร์เน็ตได้
                </span>
            </div>
        </template>

        <template #footer>
            <button type="button" class="v2-btn ghost" @click="emit('close')">ปิด</button>
        </template>
    </BaseModal>
</template>

<style scoped>
.req { color: var(--v2-danger); }
.actions { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; }
.steps { margin: 12px 0; display: grid; gap: 6px; }
.s { font-size: .84rem; display: flex; align-items: center; gap: 10px; }
.s b { display: inline-flex; width: 22px; height: 22px; align-items: center; justify-content: center;
       border-radius: 50%; background: var(--v2-primary-soft); color: var(--v2-primary); font-size: .75rem; flex-shrink: 0; }
.scriptbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 10px; }
.sub { font-size: .8rem; color: var(--v2-text-muted); }
.script { width: 100%; min-height: 240px; margin-top: 6px; padding: 12px; border-radius: 8px;
          border: 1px solid var(--v2-border); background: var(--v2-bg-soft, #f8fafc);
          font-size: .76rem; line-height: 1.6; resize: vertical; white-space: pre; overflow-x: auto; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
code { background: var(--v2-primary-soft); padding: 1px 5px; border-radius: 4px; }
</style>
