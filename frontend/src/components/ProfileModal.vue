<script setup>
/**
 * เพิ่ม/แก้ไขโปรไฟล์ Hotspot หรือแพ็กเกจ PPPoE
 *
 * ใช้ตัวเดียวกันทั้งสองระบบเพราะฟิลด์ส่วนใหญ่ซ้ำกัน (ชื่อ + ความเร็ว + timeout)
 * ต่างกันแค่ Hotspot มี shared-users ส่วน PPPoE มี local/remote address และ idle-timeout
 * แยกเป็นสองไฟล์จะได้โค้ดซ้ำโดยไม่ได้อะไรกลับมา
 */
import { ref, computed, watch } from 'vue';
import { apiFetch } from '../api.js';
import { toast } from '../toast.js';
import BaseModal from './BaseModal.vue';

const props = defineProps({
    open: { type: Boolean, default: false },
    kind: { type: String, default: 'hotspot' },   // 'hotspot' | 'pppoe'
    profile: { type: Object, default: null }      // null = เพิ่มใหม่
});
const emit = defineEmits(['close', 'saved']);

const isPppoe = computed(() => props.kind === 'pppoe');
const isEdit = computed(() => !!(props.profile && props.profile.id));
const saving = ref(false);

const form = ref({});

function blank() {
    return {
        name: '',
        rateLimit: '',
        sharedUsers: '1',
        sessionTimeout: '',
        idleTimeout: '',
        localAddress: '',
        remoteAddress: ''
    };
}

watch(() => props.open, (v) => {
    if (!v) return;
    const p = props.profile;
    form.value = p ? {
        name: p.name || '',
        // ค่า "Unlimited" มาจากฝั่งแสดงผล ไม่ใช่ค่าที่เราท์เตอร์เก็บจริง ส่งกลับไปไม่ได้
        rateLimit: (p.rateLimit && p.rateLimit !== 'Unlimited') ? p.rateLimit : '',
        sharedUsers: String(p.sharedUsers || '1'),
        sessionTimeout: p.sessionTimeout || '',
        idleTimeout: p.idleTimeout || '',
        localAddress: p.localAddress || '',
        remoteAddress: p.remoteAddress || ''
    } : blank();
});

const base = computed(() => isPppoe.value ? '/api/mikrotik/pppoe/profiles' : '/api/mikrotik/hotspot/profiles');

async function save() {
    const name = String(form.value.name || '').trim();
    if (!name) return toast.error(isPppoe.value ? 'ต้องระบุชื่อแพ็กเกจ' : 'ต้องระบุชื่อโปรไฟล์');

    const body = { name, rateLimit: String(form.value.rateLimit || '').trim() };
    if (isPppoe.value) {
        body.localAddress = String(form.value.localAddress || '').trim();
        body.remoteAddress = String(form.value.remoteAddress || '').trim();
        body.idleTimeout = String(form.value.idleTimeout || '').trim();
        body.sessionTimeout = String(form.value.sessionTimeout || '').trim();
    } else {
        body.sharedUsers = String(form.value.sharedUsers || '1').trim();
        body.sessionTimeout = String(form.value.sessionTimeout || '').trim();
    }

    saving.value = true;
    try {
        await apiFetch(isEdit.value ? `${base.value}/${encodeURIComponent(props.profile.id)}` : base.value, {
            method: isEdit.value ? 'PUT' : 'POST',
            body: JSON.stringify(body)
        });
        toast.success(isEdit.value ? `บันทึก "${name}" แล้ว` : `เพิ่ม "${name}" แล้ว`);
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
        :open="open" :busy="saving"
        :title="(isEdit ? 'แก้ไข' : 'เพิ่ม') + (isPppoe ? 'แพ็กเกจ PPPoE' : 'โปรไฟล์ Hotspot')"
        width="520px"
        @close="emit('close')"
    >
        <div class="v2-field">
            <label>{{ isPppoe ? 'ชื่อแพ็กเกจ' : 'ชื่อโปรไฟล์' }} <span class="req">*</span></label>
            <input v-model="form.name" class="v2-input" :disabled="isEdit || saving" placeholder="เช่น 30Mbps-1Month">
            <span v-if="isEdit" class="v2-hint">เปลี่ยนชื่อไม่ได้ — ถ้าต้องการชื่อใหม่ให้สร้างอันใหม่แทน</span>
        </div>

        <div class="v2-field">
            <label>จำกัดความเร็ว (rate-limit)</label>
            <input v-model="form.rateLimit" class="v2-input mono" :disabled="saving" placeholder="เช่น 30M/30M">
            <span class="v2-hint">รูปแบบ <code>ขาขึ้น/ขาลง</code> เช่น <code>10M/30M</code> · เว้นว่าง = ไม่จำกัด</span>
        </div>

        <div class="v2-row-2">
            <div v-if="!isPppoe" class="v2-field">
                <label>ใช้พร้อมกันได้กี่เครื่อง</label>
                <input v-model="form.sharedUsers" type="number" min="1" class="v2-input" :disabled="saving">
                <span class="v2-hint">1 = ล็อกอินซ้อนไม่ได้</span>
            </div>

            <div class="v2-field">
                <label>Session Timeout</label>
                <input v-model="form.sessionTimeout" class="v2-input mono" :disabled="saving" placeholder="เช่น 30d">
                <span class="v2-hint">
                    ตัดการเชื่อมต่อเมื่อครบเวลาที่นับจาก<strong>ตอนเริ่มเชื่อมต่อ</strong> · เว้นว่าง = ไม่จำกัด
                </span>
            </div>
        </div>

        <template v-if="isPppoe">
            <div class="v2-field">
                <label>Idle Timeout</label>
                <input v-model="form.idleTimeout" class="v2-input mono" :disabled="saving" placeholder="เช่น 10m">
                <span class="v2-hint">
                    ตัดเซสชันที่เงียบไปนานเกินกำหนด ช่วยเคลียร์ห้องที่ไฟดับแล้วตัดไม่สะอาด
                </span>
            </div>

            <div class="v2-row-2">
                <div class="v2-field">
                    <label>Local Address</label>
                    <input v-model="form.localAddress" class="v2-input mono" :disabled="saving" placeholder="เช่น 10.20.0.1">
                </div>
                <div class="v2-field">
                    <label>Remote Address (IP Pool)</label>
                    <input v-model="form.remoteAddress" class="v2-input mono" :disabled="saving" placeholder="เช่น pppoe-pool">
                </div>
            </div>
        </template>

        <template #footer>
            <button type="button" class="v2-btn ghost" :disabled="saving" @click="emit('close')">ยกเลิก</button>
            <button type="button" class="v2-btn primary" :disabled="saving" @click="save">
                <i class="fa-solid" :class="saving ? 'fa-spinner fa-spin' : 'fa-floppy-disk'"></i> บันทึก
            </button>
        </template>
    </BaseModal>
</template>

<style scoped>
.req { color: var(--v2-danger); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
code { background: var(--v2-primary-soft); padding: 1px 5px; border-radius: 4px; }
</style>
