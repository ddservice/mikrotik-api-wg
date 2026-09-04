<script setup>
/**
 * เพิ่ม/แก้ไขห้องพัก PPPoE (/ppp/secret)
 *
 * นี่คืองานประจำวันจริง ๆ ของระบบเช่าห้อง: มีผู้เช่าเข้าใหม่ก็เพิ่มห้อง
 * ย้ายแพ็กเกจก็แก้ห้อง — v2 เดิมทำได้แค่ระงับ/ยกเลิกระงับ ต้องกลับไปหน้าเก่าทุกครั้ง
 */
import { ref, computed, watch } from 'vue';
import { apiFetch } from '../api.js';
import { toast } from '../toast.js';
import BaseModal from './BaseModal.vue';

const props = defineProps({
    open: { type: Boolean, default: false },
    room: { type: Object, default: null },       // null = เพิ่มห้องใหม่
    packages: { type: Array, default: () => [] }
});
const emit = defineEmits(['close', 'saved']);

const isEdit = computed(() => !!(props.room && props.room.id));
const saving = ref(false);
const form = ref({ name: '', password: '', profile: '', comment: '' });

watch(() => props.open, (v) => {
    if (!v) return;
    const r = props.room;
    form.value = r
        ? { name: r.name || '', password: '', profile: r.profile || '', comment: r.comment || '' }
        : { name: '', password: '', profile: (props.packages[0] && props.packages[0].name) || 'default', comment: '' };
});

async function save() {
    const name = String(form.value.name || '').trim();
    const password = String(form.value.password || '').trim();
    if (!name) return toast.error('ต้องระบุเลขห้อง');
    // ตอนเพิ่มใหม่ RouterOS ต้องมีรหัสผ่านเสมอ ส่วนตอนแก้ไข เว้นว่าง = ใช้รหัสเดิมต่อ
    if (!isEdit.value && !password) return toast.error('ต้องระบุรหัสผ่านสำหรับห้องใหม่');

    const body = {
        name,
        profile: form.value.profile || 'default',
        comment: String(form.value.comment || '').trim()
    };
    if (password) body.password = password;

    saving.value = true;
    try {
        await apiFetch(
            isEdit.value ? '/api/mikrotik/pppoe/users/' + encodeURIComponent(props.room.id) : '/api/mikrotik/pppoe/users',
            { method: isEdit.value ? 'PUT' : 'POST', body: JSON.stringify(body) }
        );
        toast.success(isEdit.value ? `บันทึกห้อง "${name}" แล้ว` : `เพิ่มห้อง "${name}" แล้ว`);
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
        :title="isEdit ? `แก้ไขห้อง ${room && room.name}` : 'เพิ่มห้องพักใหม่'"
        width="520px"
        @close="emit('close')"
    >
        <div class="v2-row-2">
            <div class="v2-field">
                <label>เลขห้อง (username) <span class="req">*</span></label>
                <input v-model="form.name" class="v2-input mono" :disabled="saving" placeholder="เช่น rm319">
                <span class="v2-hint">ต้องตรงกับที่ตั้งไว้ในเราท์เตอร์ของห้องนั้น</span>
            </div>
            <div class="v2-field">
                <label>รหัสผ่าน <span v-if="!isEdit" class="req">*</span></label>
                <input v-model="form.password" class="v2-input mono" :disabled="saving"
                       :placeholder="isEdit ? 'เว้นว่าง = ใช้รหัสเดิม' : 'ตั้งรหัสให้ห้องนี้'">
                <span v-if="isEdit" class="v2-hint">
                    เปลี่ยนรหัสแล้วห้องจะต่อไม่ได้จนกว่าจะไปแก้ที่เราท์เตอร์ของห้องด้วย
                </span>
            </div>
        </div>

        <div class="v2-field">
            <label>แพ็กเกจ (PPP Profile)</label>
            <select v-model="form.profile" class="v2-select" :disabled="saving">
                <option v-for="p in packages" :key="p.id" :value="p.name">{{ p.name }}</option>
                <option v-if="!packages.length" value="default">default</option>
            </select>
            <span class="v2-hint">กำหนดความเร็วและ timeout ของห้องนี้</span>
        </div>

        <div class="v2-field">
            <label>หมายเหตุ</label>
            <input v-model="form.comment" class="v2-input" :disabled="saving" placeholder="เช่น ชื่อผู้เช่า, วันที่เข้าอยู่">
        </div>

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
</style>
