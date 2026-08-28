<script setup>
import { ref, computed, watch } from 'vue';
import { apiFetch } from '../api.js';
import { toast } from '../toast.js';
import BaseModal from './BaseModal.vue';

const props = defineProps({
    open: { type: Boolean, default: false },
    user: { type: Object, default: null },      // null = เพิ่มใหม่
    profiles: { type: Array, default: () => [] }
});
const emit = defineEmits(['close', 'saved']);

const isEdit = computed(() => !!props.user);
const saving = ref(false);
const form = ref({});
const originalLimitUptime = ref('');
const renewMode = ref('none');
const renewTouched = ref(false);

watch(() => props.open, (isOpen) => {
    if (!isOpen) return;
    const u = props.user;
    form.value = {
        name: u?.name || '',
        password: u?.password || '',
        profile: u?.profile || (props.profiles[0]?.name || 'default'),
        limitUptime: u?.limitUptime && u.limitUptime !== 'Unlimited' ? u.limitUptime : '',
        limitBytesTotal: u?.limitBytesTotal || 0,
        comment: u?.comment || ''
    };
    originalLimitUptime.value = form.value.limitUptime;
    renewMode.value = 'none';
    renewTouched.value = false;
    saving.value = false;
});

// เหตุผลที่ต้องมีตัวนี้ (จาก CLAUDE.md 2026-07-29 (2) และ 2026-08-02):
// /ip/hotspot/user เก็บ uptime แบบสะสม RouterOS ไม่รีเซ็ตให้เอง
// ถ้าลูกค้าเติมเงินด้วย username เดิม แล้วสแตฟฟ์แค่แก้ limit-uptime อย่างเดียว
// uptime สะสมเดิมยังอยู่ ลูกค้าจะขึ้น "reached uptime limit" ทันที
// -> พอแก้ช่อง "จำกัดเวลา" ให้เดาเจตนาว่ากำลังต่ออายุ แล้วเลือกโหมดรีเซ็ตให้อัตโนมัติ
//    แต่ถ้าสแตฟฟ์เลือกโหมดเองแล้ว ห้ามไปเปลี่ยนทับ
watch(() => form.value.limitUptime, (val) => {
    if (!isEdit.value || renewTouched.value) return;
    renewMode.value = val !== originalLimitUptime.value ? 'reset' : 'none';
});

const limitChanged = computed(() =>
    isEdit.value && form.value.limitUptime !== originalLimitUptime.value
);

function onRenewPicked() {
    renewTouched.value = true;
}

async function save() {
    if (!form.value.name.trim()) return toast.error('ต้องระบุชื่อผู้ใช้');
    saving.value = true;
    try {
        const body = {
            name: form.value.name.trim(),
            password: form.value.password,
            profile: form.value.profile,
            limitUptime: form.value.limitUptime.trim(),
            limitBytesTotal: parseInt(form.value.limitBytesTotal) || 0,
            comment: form.value.comment
        };
        if (isEdit.value) {
            body.resetCounters = renewMode.value === 'reset';
            body.recreate = renewMode.value === 'recreate';
            await apiFetch('/api/mikrotik/hotspot/users/' + encodeURIComponent(props.user.id), {
                method: 'PUT',
                body: JSON.stringify(body)
            });
            toast.success(
                renewMode.value === 'none'
                    ? `บันทึก "${body.name}" แล้ว`
                    : `ต่ออายุ "${body.name}" แล้ว (${renewMode.value === 'recreate' ? 'สร้างใหม่' : 'ล้างเวลาสะสม'})`
            );
        } else {
            await apiFetch('/api/mikrotik/hotspot/users', { method: 'POST', body: JSON.stringify(body) });
            toast.success(`เพิ่มบัญชี "${body.name}" แล้ว`);
        }
        emit('saved');
        emit('close');
    } catch (err) {
        toast.error(err.message);
    } finally {
        saving.value = false;
    }
}
</script>

<template>
    <BaseModal
        :open="open"
        :busy="saving"
        :title="isEdit ? 'แก้ไขบัญชี Hotspot' : 'เพิ่มบัญชี Hotspot'"
        :icon="isEdit ? 'fa-solid fa-pen' : 'fa-solid fa-user-plus'"
        @close="emit('close')"
    >
        <div class="v2-row-2">
            <div class="v2-field">
                <label>ชื่อผู้ใช้ (Username) <span class="req">*</span></label>
                <input v-model="form.name" class="v2-input" :disabled="saving" placeholder="เช่น rm204">
            </div>
            <div class="v2-field">
                <label>รหัสผ่าน</label>
                <input v-model="form.password" class="v2-input mono" :disabled="saving" placeholder="เว้นว่าง = ไม่ต้องใช้รหัส">
            </div>
        </div>

        <div class="v2-row-2">
            <div class="v2-field">
                <label>โปรไฟล์</label>
                <select v-model="form.profile" class="v2-select" :disabled="saving">
                    <option v-for="p in profiles" :key="p.id" :value="p.name">
                        {{ p.name }}{{ p.rateLimit && p.rateLimit !== 'Unlimited' ? ' — ' + p.rateLimit : '' }}
                    </option>
                    <option v-if="!profiles.length" value="default">default</option>
                </select>
            </div>
            <div class="v2-field">
                <label>จำกัดเวลาใช้งาน (Limit Uptime)</label>
                <input v-model="form.limitUptime" class="v2-input" :disabled="saving" placeholder="เช่น 30d, 12:00:00 — เว้นว่าง = ไม่จำกัด">
            </div>
        </div>

        <div class="v2-field">
            <label>หมายเหตุ</label>
            <input v-model="form.comment" class="v2-input" :disabled="saving" placeholder="เช่น ห้อง 204">
        </div>

        <!-- ส่วนต่ออายุ โผล่เฉพาะตอนแก้ไข — เพิ่มบัญชีใหม่ uptime เริ่มที่ 0 อยู่แล้ว -->
        <template v-if="isEdit">
            <div v-if="limitChanged" class="v2-callout warn">
                <i class="fa-solid fa-triangle-exclamation"></i>
                <span>
                    ตรวจพบว่ามีการแก้ "จำกัดเวลาใช้งาน" — ระบบเลือกโหมดต่ออายุให้อัตโนมัติแล้ว
                    ถ้าไม่ได้กำลังเติมเงินให้ลูกค้า ให้เปลี่ยนกลับเป็น "ไม่ต่ออายุ"
                </span>
            </div>

            <div class="v2-field">
                <label>ต่ออายุ / เติมเงิน</label>
                <select v-model="renewMode" class="v2-select" :disabled="saving" @change="onRenewPicked">
                    <option value="none">ไม่ต่ออายุ — แก้ข้อมูลเฉย ๆ (เวลาสะสมคงเดิม)</option>
                    <option value="reset">ล้างเวลาใช้งานสะสม (Reset Counters) — แนะนำสำหรับเติมเงิน</option>
                    <option value="recreate">ลบแล้วสร้างใหม่ — เริ่มนับใหม่หมดจด (แนะนำสำหรับคูปองใช้ครั้งเดียว)</option>
                </select>
                <span class="v2-hint">
                    RouterOS นับเวลาใช้งานแบบสะสมและไม่รีเซ็ตให้เอง ถ้าเติมเงินด้วยชื่อเดิมโดยไม่ล้างค่า
                    ลูกค้าจะขึ้น "reached uptime limit" ทันที · ทั้งสองโหมดจะเตะเซสชันที่ค้างอยู่ให้ด้วย
                </span>
            </div>
        </template>

        <template #footer>
            <button type="button" class="v2-btn ghost" :disabled="saving" @click="emit('close')">ยกเลิก</button>
            <button type="button" class="v2-btn primary" :disabled="saving" @click="save">
                <i class="fa-solid" :class="saving ? 'fa-spinner fa-spin' : 'fa-floppy-disk'"></i>
                {{ saving ? 'กำลังบันทึก...' : (isEdit ? 'บันทึก' : 'เพิ่มบัญชี') }}
            </button>
        </template>
    </BaseModal>
</template>
