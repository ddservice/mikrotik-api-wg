<script setup>
/**
 * สร้างคูปองแบบกลุ่ม + พิมพ์บัตรคูปอง
 *
 * จงใจใช้ id="voucher-print-area" และคลาส .voucher-* ของ style.css เดิม
 * เพราะกฎ @media print ทั้งชุด (ซ่อนทุกอย่างยกเว้นพื้นที่นี้, จัด 3 คอลัมน์,
 * ไม่ตัดกลางใบ, บังคับขาวดำ) เขียนไว้กับ selector พวกนั้นอยู่แล้ว
 * ถ้าตั้งชื่อคลาสใหม่จะต้องเขียนกฎการพิมพ์ซ้ำอีกชุด และแบบพิมพ์จะเพี้ยนจากของเดิม
 */
import { ref, computed, nextTick } from 'vue';
import { apiFetch, loadSites, activeSiteName } from '../api.js';
import { toast } from '../toast.js';
import { formatBytes } from '../format.js';

const props = defineProps({
    profiles: { type: Array, default: () => [] }
});
const emit = defineEmits(['generated']);

// ชื่อสาขาใช้เป็นหัวบัตร — ดึงครั้งเดียวตอนเปิดแท็บนี้ ไม่ต้องให้หน้าแม่ส่งลงมา
const siteName = ref('');

const LIMIT_UPTIME = [
    { v: '', t: 'ไม่จำกัด' },
    { v: '01:00:00', t: '1 ชั่วโมง' },
    { v: '02:00:00', t: '2 ชั่วโมง' },
    { v: '06:00:00', t: '6 ชั่วโมง' },
    { v: '12:00:00', t: '12 ชั่วโมง' },
    { v: '1d', t: '1 วัน' },
    { v: '7d', t: '7 วัน' },
    { v: '30d', t: '30 วัน' }
];

const LIMIT_BYTES = [
    { v: '', t: 'ไม่จำกัด' },
    { v: '524288000', t: '500 MB' },
    { v: '1073741824', t: '1 GB' },
    { v: '3221225472', t: '3 GB' },
    { v: '5368709120', t: '5 GB' },
    { v: '10737418240', t: '10 GB' },
    { v: '21474836480', t: '20 GB' },
    { v: '53687091200', t: '50 GB' }
];

const form = ref({
    prefix: '',
    qty: 10,
    profile: '',
    limitUptime: '',
    limitBytesTotal: '',
    siteTitle: '',
    packageName: '',
    price: '',
    contact: ''
});

const busy = ref(false);
const cards = ref([]);          // ใบคูปองที่พร้อมพิมพ์
const printArea = ref(null);

const profileNames = computed(() => {
    const names = props.profiles.map((p) => p.name).filter(Boolean);
    return names.length ? names : ['default'];
});

// ตั้งค่าเริ่มต้นตอนเปิดแท็บ — โปรไฟล์แรกที่มีจริง และชื่อสาขาเป็นหัวบัตร
async function primeDefaults() {
    if (!form.value.profile || !profileNames.value.includes(form.value.profile)) {
        form.value.profile = profileNames.value[0];
    }
    if (!siteName.value) {
        try {
            await loadSites();
            siteName.value = activeSiteName();
        } catch (_) {
            // ไม่รู้ชื่อสาขาก็ยังสร้างคูปองได้ แค่ต้องพิมพ์หัวบัตรเอง
        }
    }
    if (!form.value.siteTitle) form.value.siteTitle = siteName.value;
}

function limitTextFromForm() {
    const u = LIMIT_UPTIME.find((o) => o.v === form.value.limitUptime);
    const b = LIMIT_BYTES.find((o) => o.v === String(form.value.limitBytesTotal || ''));
    const parts = [u && u.v ? u.t : '', b && b.v ? b.t : ''].filter(Boolean);
    return parts.join(' / ') || 'ไม่จำกัด';
}

async function generate() {
    const qty = parseInt(form.value.qty, 10);
    if (!Number.isFinite(qty) || qty < 1 || qty > 100) {
        return toast.error('จำนวนคูปองต้องอยู่ระหว่าง 1 ถึง 100 ใบ');
    }
    if (!form.value.profile) return toast.error('ต้องเลือกโปรไฟล์ Hotspot');

    busy.value = true;
    try {
        const res = await apiFetch('/api/mikrotik/hotspot/generate', {
            method: 'POST',
            body: JSON.stringify({
                prefix: form.value.prefix,
                qty,
                profile: form.value.profile,
                limitUptime: form.value.limitUptime,
                limitBytesTotal: form.value.limitBytesTotal ? parseInt(form.value.limitBytesTotal, 10) : undefined,
                siteTitle: form.value.siteTitle,
                packageName: form.value.packageName,
                price: form.value.price,
                contact: form.value.contact
            })
        });

        const limitText = limitTextFromForm();
        const fallbackTitle = form.value.siteTitle || siteName.value || 'HOTSPOT WI-FI';
        const fallbackPkg = form.value.packageName || `แพ็กเกจ ${form.value.profile}`;

        cards.value = (res.users || []).map((u) => ({
            username: u.username,
            password: u.password,
            siteTitle: u.siteTitle || fallbackTitle,
            packageName: u.packageName || fallbackPkg,
            price: u.price || form.value.price || '',
            contact: u.contact || form.value.contact || '',
            limitText
        }));

        toast.success(`สร้างคูปอง ${cards.value.length} ใบแล้ว — ตรวจสอบด้านล่างก่อนสั่งพิมพ์`);
        emit('generated');
        await nextTick();
        printArea.value && printArea.value.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
        // สร้างไปแล้วบางส่วนก่อนพัง — server บอกจำนวนมาในข้อความ ต้องไม่กลืนทิ้ง
        toast.error(err.message);
    } finally {
        busy.value = false;
    }
}

/**
 * พิมพ์ซ้ำจากบัญชีที่มีอยู่แล้ว (ไม่สร้างใหม่บนเราท์เตอร์)
 * ใช้ตอนคูปองใบเดิมหาย หรือพิมพ์ตกไปบางใบ
 */
function showReprint(users, siteTitle) {
    cards.value = users.map((u) => {
        const t = u.limitUptime && u.limitUptime !== '00:00:00' && u.limitUptime !== 'Unlimited' ? u.limitUptime : '';
        const b = u.limitBytesTotal ? formatBytes(u.limitBytesTotal) : '';
        return {
            username: u.name,
            password: u.password || '(ไม่มี)',
            siteTitle: siteTitle || siteName.value || 'HOTSPOT WI-FI',
            packageName: `โปรไฟล์ ${u.profile || 'default'}`,
            price: '',
            contact: '',
            limitText: [t, b].filter(Boolean).join(' / ') || 'ไม่จำกัด'
        };
    });
    nextTick(() => printArea.value && printArea.value.scrollIntoView({ behavior: 'smooth' }));
}

function print() {
    window.print();
}

defineExpose({ showReprint, primeDefaults });
</script>

<template>
    <div class="panel">
        <div class="phead">
            <h3><i class="fa-solid fa-ticket"></i> สร้างคูปองแบบกลุ่ม</h3>
            <span class="sub">สร้างชื่อผู้ใช้และรหัสผ่านแบบสุ่มลงเราท์เตอร์ แล้วจัดหน้าให้พิมพ์ตัดเป็นใบ ๆ</span>
        </div>

        <div class="body">
            <div class="v2-callout info">
                <i class="fa-solid fa-circle-info"></i>
                <span>
                    รหัสจะสุ่มจากตัวอักษรที่ไม่ชวนอ่านผิด (ไม่มี <code>1 l 0 o</code>)
                    เพราะลูกค้าต้องพิมพ์เองจากกระดาษ · สร้างได้ครั้งละไม่เกิน 100 ใบ
                </span>
            </div>

            <div class="grid">
                <div class="v2-field">
                    <label>คำขึ้นต้นชื่อผู้ใช้ (Prefix)</label>
                    <input v-model="form.prefix" class="v2-input" placeholder="เช่น mt- หรือ vip-">
                    <span class="v2-hint">เว้นว่างได้ — ใช้แยกว่าคูปองชุดนี้มาจากล็อตไหน</span>
                </div>
                <div class="v2-field">
                    <label>จำนวนที่ต้องการ <span class="req">*</span></label>
                    <input v-model="form.qty" type="number" min="1" max="100" class="v2-input">
                </div>
                <div class="v2-field">
                    <label>โปรไฟล์ Hotspot <span class="req">*</span></label>
                    <select v-model="form.profile" class="v2-select">
                        <option v-for="n in profileNames" :key="n" :value="n">{{ n }}</option>
                    </select>
                </div>
                <div class="v2-field">
                    <label>จำกัดเวลาใช้งาน</label>
                    <select v-model="form.limitUptime" class="v2-select">
                        <option v-for="o in LIMIT_UPTIME" :key="o.v" :value="o.v">{{ o.t }}</option>
                    </select>
                </div>
                <div class="v2-field">
                    <label>จำกัดปริมาณข้อมูลรวม</label>
                    <select v-model="form.limitBytesTotal" class="v2-select">
                        <option v-for="o in LIMIT_BYTES" :key="o.v" :value="o.v">{{ o.t }}</option>
                    </select>
                </div>
            </div>

            <div class="specs">
                <h4><i class="fa-solid fa-pen-to-square"></i> ข้อความที่จะพิมพ์ลงบนบัตร</h4>
                <div class="grid">
                    <div class="v2-field">
                        <label>ชื่อร้าน / สถานที่</label>
                        <input v-model="form.siteTitle" class="v2-input" :placeholder="siteName || 'HOTSPOT WI-FI'">
                    </div>
                    <div class="v2-field">
                        <label>ชื่อแพ็กเกจ</label>
                        <input v-model="form.packageName" class="v2-input" placeholder="เช่น บัตร 1 วัน">
                    </div>
                    <div class="v2-field">
                        <label>ราคา</label>
                        <input v-model="form.price" class="v2-input" placeholder="เช่น 50 บาท">
                    </div>
                    <div class="v2-field">
                        <label>เบอร์ติดต่อ / หมายเหตุ</label>
                        <input v-model="form.contact" class="v2-input" placeholder="เช่น โทร. 081-234-5678">
                    </div>
                </div>
            </div>

            <div class="actions">
                <button type="button" class="v2-btn primary" :disabled="busy" @click="generate">
                    <i class="fa-solid" :class="busy ? 'fa-spinner fa-spin' : 'fa-wand-magic-sparkles'"></i>
                    สร้างคูปองและเตรียมพิมพ์
                </button>
            </div>
        </div>
    </div>

    <!--
      id + คลาสตรงกับหน้าเดิมเป๊ะ ๆ เพื่อให้กฎ @media print ของ style.css ทำงาน
      ถ้าไม่มีใบคูปองก็ไม่ต้องเรนเดอร์ กัน print() ออกกระดาษเปล่า
    -->
    <div v-if="cards.length" id="voucher-print-area" ref="printArea" class="voucher-print-area">
        <div class="print-area-header">
            <div>
                <h5><i class="fa-solid fa-ticket"></i> บัตรคูปองพร้อมพิมพ์ ({{ cards.length }} ใบ)</h5>
                <p class="sub">ตรวจชื่อผู้ใช้/รหัสผ่านให้ครบก่อนสั่งพิมพ์ · กระดาษ 1 แผ่นได้ 3 คอลัมน์ ตัดตามเส้นประ</p>
            </div>
            <div class="print-actions">
                <button type="button" class="v2-btn ghost" @click="cards = []">
                    <i class="fa-solid fa-xmark"></i> ล้างหน้าพิมพ์
                </button>
                <button type="button" class="v2-btn primary" @click="print">
                    <i class="fa-solid fa-print"></i> สั่งพิมพ์คูปอง
                </button>
            </div>
        </div>

        <div class="voucher-grid" id="voucher-result-grid">
            <div v-for="(c, i) in cards" :key="c.username + '-' + i" class="voucher-card">
                <div class="voucher-scissors"><i class="fa-solid fa-scissors"></i></div>
                <div class="voucher-header">
                    <div class="site-brand"><i class="fa-solid fa-wifi"></i> {{ c.siteTitle }}</div>
                    <div class="price-badge" :class="{ free: !c.price }">{{ c.price || 'VIP PASS' }}</div>
                </div>
                <div class="voucher-pkg-bar">
                    <span class="pkg-name"><i class="fa-solid fa-cube"></i> {{ c.packageName }}</span>
                    <span class="pkg-limit">{{ c.limitText }}</span>
                </div>
                <div class="voucher-body">
                    <div class="voucher-credentials">
                        <div class="voucher-field">
                            <div class="voucher-label">USERNAME</div>
                            <div class="voucher-value">{{ c.username }}</div>
                        </div>
                        <div class="voucher-divider-v"></div>
                        <div class="voucher-field">
                            <div class="voucher-label">PASSWORD</div>
                            <div class="voucher-value pwd">{{ c.password }}</div>
                        </div>
                    </div>
                </div>
                <div class="voucher-footer">
                    <div class="instruction"><span>1. Connect Wi-Fi</span> <span>2. Enter Login Code</span></div>
                    <div v-if="c.contact" class="contact-info"><i class="fa-solid fa-headset"></i> {{ c.contact }}</div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.panel {
    background: var(--v2-surface); border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius); box-shadow: var(--v2-shadow); overflow: hidden;
}
.phead { padding: 14px 16px; border-bottom: 1px solid var(--v2-border); }
.phead h3 { margin: 0; font-size: .95rem; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.phead i { color: var(--v2-primary); }
.sub { font-size: .78rem; color: var(--v2-text-muted); margin: 3px 0 0; }

.body { padding: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 0 14px; }

.specs {
    margin-top: 6px; padding: 14px 14px 4px; border: 1px dashed var(--v2-border);
    border-radius: 10px; background: var(--v2-bg);
}
.specs h4 { margin: 0 0 10px; font-size: .84rem; font-weight: 700; display: flex; align-items: center; gap: 7px; }
.specs h4 i { color: var(--v2-primary); }

.actions { display: flex; justify-content: flex-end; margin-top: 14px; }
.req { color: var(--v2-danger); }
code { background: var(--v2-primary-soft); padding: 1px 5px; border-radius: 4px; }

.voucher-print-area { margin-top: 20px; }
.print-area-header {
    display: flex; justify-content: space-between; align-items: flex-end;
    gap: 14px; flex-wrap: wrap; margin-bottom: 14px;
}
.print-area-header h5 { margin: 0; font-size: .95rem; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.print-area-header h5 i { color: var(--v2-primary); }
.print-actions { display: flex; gap: 8px; }
</style>
