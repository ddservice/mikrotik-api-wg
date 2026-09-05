<script setup>
import { ref, computed, watch } from 'vue';
import { apiFetch, nextFreeWireguardIp, siteHoldingWireguardIp } from '../api.js';
import { toast } from '../toast.js';
import BaseModal from './BaseModal.vue';

const props = defineProps({
    open: { type: Boolean, default: false },
    site: { type: Object, default: null }   // null = เพิ่มสาขาใหม่
});
const emit = defineEmits(['close', 'saved']);

const isEdit = computed(() => !!props.site);
let justCreatedWireguard = null;
const saving = ref(false);
const form = ref({});

watch(() => props.open, (isOpen) => {
    if (!isOpen) return;
    const s = props.site;
    form.value = {
        name: s?.name || '',
        connectionType: s?.connectionType || 'wireguard',
        host: s?.host || '',
        port: s?.port || 8728,
        username: s?.username || 'ddserviceapi',
        password: '',                        // เว้นว่างเสมอ = ไม่เปลี่ยนรหัสเดิม
        wireguardIp: s?.wireguardIp || '',
        dnsLoggingEnabled: s?.dnsLoggingEnabled !== false
    };
    saving.value = false;
    justCreatedWireguard = null;

    // สาขาใหม่แบบ WireGuard: จ่ายหมายเลขว่างให้เลย ไม่ต้องให้คนไปไล่ดูเองว่าตัวไหนว่าง
    // (แก้เองได้ แต่ค่าเริ่มต้นต้องถูกและไม่ซ้ำเสมอ)
    if (!s && form.value.connectionType === 'wireguard' && !form.value.wireguardIp) {
        form.value.wireguardIp = nextFreeWireguardIp();
    }
});

const isWireguard = computed(() => form.value.connectionType === 'wireguard');

// เปลี่ยนชนิดการเชื่อมต่อระหว่างกรอก — ถ้าเพิ่งเลือก WireGuard และยังไม่มีเลข ก็จ่ายให้
watch(() => form.value.connectionType, (t) => {
    if (t === 'wireguard' && !form.value.wireguardIp) {
        form.value.wireguardIp = nextFreeWireguardIp(props.site?.id || null);
    }
});

// เตือนทันทีที่พิมพ์ซ้ำกับสาขาอื่น ไม่ต้องรอกดบันทึกแล้วโดน server ปฏิเสธ
// (ฝั่ง server ยังตรวจซ้ำอยู่ อันนี้เป็นแค่การบอกให้เร็วขึ้น ไม่ได้แทนกัน)
const ipClash = computed(() => {
    if (!isWireguard.value) return null;
    return siteHoldingWireguardIp(form.value.wireguardIp, props.site?.id || null);
});

// สาขาที่ต่อผ่าน WireGuard ใช้ IP ในอุโมงค์เป็น host เสมอ
// กรอกซ้ำสองช่องแล้วไม่ตรงกันคือต้นเหตุที่ต่อไม่ติดแบบหาสาเหตุยาก
watch(() => form.value.wireguardIp, (ip) => {
    if (isWireguard.value && ip) form.value.host = ip;
});

async function save() {
    if (!form.value.name.trim()) return toast.error('ต้องระบุชื่อสาขา');
    if (!form.value.host.trim()) return toast.error('ต้องระบุ Host หรือ WireGuard IP');
    if (ipClash.value) {
        return toast.error(`WireGuard IP ${form.value.wireguardIp} ถูกใช้อยู่แล้วโดยสาขา "${ipClash.value.name}"`);
    }
    if (isWireguard.value && !/^10\.10\.88\.\d{1,3}$/.test(form.value.wireguardIp.trim())) {
        return toast.error('WireGuard IP ต้องอยู่ในรูปแบบ 10.10.88.x');
    }

    saving.value = true;
    try {
        const body = {
            name: form.value.name.trim(),
            host: form.value.host.trim(),
            port: parseInt(form.value.port) || 8728,
            username: form.value.username.trim(),
            connectionType: form.value.connectionType,
            wireguardIp: form.value.wireguardIp.trim(),
            dnsLoggingEnabled: !!form.value.dnsLoggingEnabled
        };
        // ส่งรหัสผ่านเฉพาะตอนกรอกใหม่ — ช่องว่าง = คงรหัสเดิมไว้
        // กันเผลอล้างรหัสเราท์เตอร์ตอนกดบันทึกเพื่อแก้แค่ชื่อสาขา
        if (form.value.password) body.password = form.value.password;

        if (isEdit.value) {
            await apiFetch('/api/sites/' + encodeURIComponent(props.site.id), {
                method: 'PUT',
                body: JSON.stringify(body)
            });
            toast.success(`บันทึกสาขา "${body.name}" แล้ว`);
        } else {
            if (!body.password) {
                saving.value = false;
                return toast.error('สาขาใหม่ต้องระบุรหัสผ่าน API');
            }
            await apiFetch('/api/sites', { method: 'POST', body: JSON.stringify(body) });
            toast.success(`เพิ่มสาขา "${body.name}" แล้ว`);
            // สาขา WireGuard ใหม่ยังต่อไม่ได้จนกว่าจะรันสคริปต์บนเราท์เตอร์
            // บอกหน้าแม่ให้เปิดขั้นถัดไปต่อเลย ไม่ต้องให้คนหาปุ่มเอง
            justCreatedWireguard = body.connectionType === 'wireguard' ? body.wireguardIp : null;
        }
        emit('saved', { newWireguardIp: justCreatedWireguard });
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
        :title="isEdit ? 'แก้ไขสาขา' : 'เพิ่มสาขาใหม่'"
        :icon="isEdit ? 'fa-solid fa-pen' : 'fa-solid fa-plus'"
        width="600px"
        @close="emit('close')"
    >
        <div class="v2-field">
            <label>ชื่อสาขา <span class="req">*</span></label>
            <input v-model="form.name" class="v2-input" :disabled="saving" placeholder="เช่น A4-Residence">
        </div>

        <div class="v2-field">
            <label>รูปแบบการเชื่อมต่อ</label>
            <select v-model="form.connectionType" class="v2-select" :disabled="saving">
                <option value="wireguard">WireGuard VPN (แนะนำ — เราท์เตอร์อยู่หลัง NAT)</option>
                <option value="direct">ต่อตรง (มี Public IP หรือ DDNS)</option>
            </select>
        </div>

        <div v-if="isWireguard" class="v2-field">
            <label>WireGuard IP <span class="req">*</span></label>
            <input
                v-model="form.wireguardIp" class="v2-input mono" :disabled="saving"
                :class="{ bad: ipClash }" placeholder="เช่น 10.10.88.5"
            >
            <span v-if="ipClash" class="v2-hint warn">
                <i class="fa-solid fa-triangle-exclamation"></i>
                หมายเลขนี้ถูกใช้อยู่แล้วโดยสาขา <strong>{{ ipClash.name }}</strong> — เลือกหมายเลขอื่น
            </span>
            <span v-else class="v2-hint">
                <i class="fa-solid fa-wand-magic-sparkles"></i>
                ระบบเลือกหมายเลขว่างถัดไปให้อัตโนมัติแล้ว (แก้เองได้)  ·
                VPS เป็นฮับที่ <code>10.10.88.0/24</code> · Host จะถูกตั้งให้ตรงกับค่านี้เอง
            </span>
        </div>

        <div class="v2-row-2">
            <div class="v2-field">
                <label>Host <span class="req">*</span></label>
                <input
                    v-model="form.host" class="v2-input mono"
                    :disabled="saving || isWireguard"
                    placeholder="เช่น xxxx.sn.mynetname.net"
                >
            </div>
            <div class="v2-field">
                <label>พอร์ต API</label>
                <input v-model="form.port" type="number" class="v2-input" :disabled="saving" placeholder="8728">
            </div>
        </div>

        <div class="v2-row-2">
            <div class="v2-field">
                <label>ชื่อผู้ใช้ API</label>
                <input v-model="form.username" class="v2-input mono" :disabled="saving">
            </div>
            <div class="v2-field">
                <label>รหัสผ่าน API <span v-if="!isEdit" class="req">*</span></label>
                <input
                    v-model="form.password" type="password" class="v2-input mono"
                    :disabled="saving" autocomplete="new-password"
                    :placeholder="isEdit ? 'เว้นว่าง = ใช้รหัสเดิม' : 'รหัสผ่านของ user API บนเราท์เตอร์'"
                >
            </div>
        </div>

        <div class="v2-field">
            <label class="chk">
                <input v-model="form.dnsLoggingEnabled" type="checkbox" :disabled="saving">
                <span>เก็บประวัติการเข้าเว็บ (DNS) ของสาขานี้</span>
            </label>
            <span class="v2-hint">
                จำเป็นตาม พรบ. คอมพิวเตอร์ มาตรา 26 สำหรับสาขาที่ให้บริการอินเทอร์เน็ตแก่ผู้อื่น ·
                บันทึกเฉพาะชื่อโดเมน ไม่เก็บเนื้อหา
            </span>
        </div>

        <div class="v2-callout warn">
            <i class="fa-solid fa-key"></i>
            <span>
                user API บนเราท์เตอร์ควรมีสิทธิ์ <code>read, write, api, sensitive</code> —
                ถ้าขาด <code>sensitive</code> รหัสผ่านคูปอง Hotspot จะแสดงเป็น <code>*</code> และพิมพ์คูปองไม่ได้
            </span>
        </div>

        <template #footer>
            <button type="button" class="v2-btn ghost" :disabled="saving" @click="emit('close')">ยกเลิก</button>
            <button type="button" class="v2-btn primary" :disabled="saving" @click="save">
                <i class="fa-solid" :class="saving ? 'fa-spinner fa-spin' : 'fa-floppy-disk'"></i>
                {{ saving ? 'กำลังบันทึก...' : (isEdit ? 'บันทึก' : 'เพิ่มสาขา') }}
            </button>
        </template>
    </BaseModal>
</template>

<style scoped>
.chk { display: flex; align-items: center; gap: 9px; cursor: pointer; font-weight: 500 !important; }
.chk input { width: 16px; height: 16px; cursor: pointer; }
code {
    background: var(--v2-bg); padding: 1px 5px; border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em;
}
</style>
