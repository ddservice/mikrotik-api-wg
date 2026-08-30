<script setup>
/**
 * วินิจฉัยการเชื่อมต่อสาขา 5 ขั้น
 *
 * ใช้ตอนสาขาใช้งานไม่ได้ — คำถามแรกเสมอคือ "ติดตรงไหน" เพราะเน็ตหน้างานล่ม,
 * อุโมงค์ VPN ไม่ขึ้น, พอร์ตถูกบล็อก และรหัสผิด เป็นคนละปัญหาที่คนละคนต้องแก้
 *
 * แสดงผลแบบไล่ทีละชั้นโดยตั้งใจ ให้เห็นว่าผ่านถึงชั้นไหนแล้วไปตายตรงไหน
 * ไม่ใช่แค่บอกว่า "ต่อไม่ได้" ซึ่งไม่ช่วยให้ตัดสินใจอะไรได้เลย
 */
import { ref, computed } from 'vue';
import { apiFetch } from '../api.js';
import BaseModal from './BaseModal.vue';

const props = defineProps({
    open: { type: Boolean, default: false },
    site: { type: Object, default: null }
});
const emit = defineEmits(['close']);

const running = ref(false);
const result = ref(null);
const error = ref('');

const TONE = {
    ok: { icon: 'fa-circle-check', cls: 'ok', label: 'ผ่าน' },
    warn: { icon: 'fa-triangle-exclamation', cls: 'warn', label: 'ควรดู' },
    fail: { icon: 'fa-circle-xmark', cls: 'fail', label: 'ไม่ผ่าน' }
};

// ชั้นที่ยังไม่ได้ตรวจเพราะหยุดกลางทาง — ต้องแยกจาก "ตรวจแล้วผ่าน" ให้ชัด
const ALL_STEPS = 5;
const notReached = computed(() => {
    if (!result.value) return 0;
    const done = result.value.steps.length;
    // สาขาต่อตรงไม่มีชั้น WireGuard จึงมีแค่ 4 ชั้น
    const total = result.value.steps.some((s) => s.step.startsWith('3.')) ? ALL_STEPS : ALL_STEPS - 1;
    return Math.max(0, total - done);
});

async function run() {
    if (!props.site) return;
    running.value = true;
    result.value = null;
    error.value = '';
    try {
        result.value = await apiFetch(
            '/api/mikrotik/diagnose-site?siteId=' + encodeURIComponent(props.site.id)
        );
    } catch (err) {
        error.value = err.message;
    } finally {
        running.value = false;
    }
}

function close() {
    result.value = null;
    error.value = '';
    emit('close');
}

defineExpose({ run });
</script>

<template>
    <BaseModal
        :open="open" :busy="running" width="680px"
        :title="'วินิจฉัยการเชื่อมต่อ — ' + (site ? site.name : '')"
        @close="close"
    >
        <div class="v2-callout info">
            <i class="fa-solid fa-circle-info"></i>
            <span>
                ตรวจไล่ทีละชั้นจากทะเบียนสาขาไปจนถึงล็อกอินเราท์เตอร์จริง
                <strong>อ่านอย่างเดียว ไม่แก้อะไรบนเราท์เตอร์</strong>
            </span>
        </div>

        <button type="button" class="v2-btn primary" :disabled="running || !site" @click="run">
            <i class="fa-solid" :class="running ? 'fa-spinner fa-spin' : 'fa-stethoscope'"></i>
            {{ running ? 'กำลังตรวจ…' : (result ? 'ตรวจอีกครั้ง' : 'เริ่มตรวจ') }}
        </button>

        <div v-if="error" class="v2-callout danger mt">
            <i class="fa-solid fa-circle-xmark"></i>
            <span>เรียกการตรวจไม่สำเร็จ: {{ error }}</span>
        </div>

        <div v-if="running && !result" class="waiting">
            กำลังไล่ตรวจทีละชั้น… ชั้นที่ต่อเราท์เตอร์อาจใช้เวลาถึง 10 วินาทีถ้าสาขาล่ม
        </div>

        <template v-if="result">
            <div class="verdict" :class="result.success ? 'ok' : 'fail'">
                <i class="fa-solid" :class="result.success ? 'fa-circle-check' : 'fa-circle-xmark'"></i>
                {{ result.success ? 'เชื่อมต่อได้ครบทุกชั้น' : 'ติดที่ชั้นสุดท้ายที่แสดงด้านล่าง' }}
            </div>

            <ol class="steps">
                <li v-for="(s, i) in result.steps" :key="i" :class="TONE[s.status]?.cls || ''">
                    <i class="fa-solid" :class="TONE[s.status]?.icon || 'fa-circle'"></i>
                    <div class="body">
                        <div class="name">
                            {{ s.step }}
                            <span class="tag">{{ TONE[s.status]?.label || s.status }}</span>
                        </div>
                        <div class="detail">{{ s.detail }}</div>
                    </div>
                </li>

                <!-- ชั้นที่ไม่ได้ตรวจเพราะหยุดก่อน — ไม่ใช่ผ่าน และไม่ใช่ไม่ผ่าน -->
                <li v-for="n in notReached" :key="'skip-' + n" class="skipped">
                    <i class="fa-solid fa-minus"></i>
                    <div class="body">
                        <div class="name">ยังไม่ได้ตรวจ</div>
                        <div class="detail">หยุดก่อนถึงชั้นนี้ เพราะชั้นก่อนหน้าไม่ผ่าน</div>
                    </div>
                </li>
            </ol>
        </template>

        <template #footer>
            <button type="button" class="v2-btn ghost" @click="close">ปิด</button>
        </template>
    </BaseModal>
</template>

<style scoped>
.mt { margin-top: 12px; }
.waiting { margin-top: 14px; font-size: .85rem; color: var(--v2-text-muted); }
.verdict { margin: 14px 0 10px; padding: 10px 12px; border-radius: 8px; font-weight: 600; font-size: .9rem;
           display: flex; align-items: center; gap: 8px; }
.verdict.ok { background: var(--v2-success-soft); color: var(--v2-success); }
.verdict.fail { background: var(--v2-danger-soft); color: var(--v2-danger); }

.steps { list-style: none; margin: 0; padding: 0; }
.steps li { display: flex; gap: 12px; padding: 10px 0; border-top: 1px solid var(--v2-border); }
.steps li > i { width: 18px; text-align: center; flex-shrink: 0; margin-top: 2px; }
.steps li.ok > i { color: var(--v2-success); }
.steps li.warn > i { color: var(--v2-warn); }
.steps li.fail > i { color: var(--v2-danger); }
.steps li.skipped { opacity: .5; }
.body { min-width: 0; }
.name { font-weight: 600; font-size: .85rem; display: flex; align-items: center; gap: 8px; }
.tag { font-size: .7rem; font-weight: 500; padding: 1px 7px; border-radius: 999px; border: 1px solid var(--v2-border); }
.ok .tag { border-color: color-mix(in srgb, var(--v2-success) 35%, transparent); color: var(--v2-success); }
.warn .tag { border-color: color-mix(in srgb, var(--v2-warn) 35%, transparent); color: var(--v2-warn); }
.fail .tag { border-color: color-mix(in srgb, var(--v2-danger) 35%, transparent); color: var(--v2-danger); }
.detail { font-size: .8rem; color: var(--v2-text-muted); margin-top: 3px; line-height: 1.55; word-break: break-word; }
</style>
