<script setup>
/**
 * รอบบิลค่าเช่าห้อง
 *
 * ก่อนหน้านี้วันครบกำหนดของทุกห้องอยู่ในช่อง comment ของเราท์เตอร์เท่านั้น
 * พิมพ์ผิดหรือลืมใส่ = ห้องนั้นหายไปจากทุกรายงานเงียบ ๆ ไม่มีใครตามเก็บเงิน
 * หน้านี้จึงขึ้น "ยังไม่ตั้งรอบบิล" ให้เห็นชัด แทนที่จะเงียบไปเหมือนเดิม
 *
 * ระบบยังเขียน comment กลับลงเราท์เตอร์ทุกครั้ง คนที่เปิด WinBox จึงยังเห็น
 * วันครบกำหนดตรงที่เคยเห็น ไม่ต้องเปลี่ยนวิธีทำงานพร้อมกันทั้งทีม
 */
import { ref, computed, onMounted, watch } from 'vue';
import { apiFetch, activeSiteId } from '../api.js';
import { toast } from '../toast.js';
import BaseModal from './BaseModal.vue';

const data = ref(null);
const loading = ref(false);
const busy = ref('');
const month = ref('');
const filter = ref('attention');   // attention | all | overdue | nodue

const FILTERS = [
    { key: 'attention', label: 'ต้องจัดการ' },
    { key: 'overdue', label: 'เลยกำหนด' },
    { key: 'nodue', label: 'ยังไม่ตั้งรอบบิล' },
    { key: 'all', label: 'ทุกห้อง' }
];

async function load() {
    loading.value = true;
    try {
        const q = month.value ? '?month=' + encodeURIComponent(month.value) : '';
        data.value = await apiFetch('/api/mikrotik/billing' + q);
        if (!month.value) month.value = data.value.month;
    } catch (e) {
        toast.error('ดึงข้อมูลรอบบิลไม่สำเร็จ: ' + e.message);
        data.value = null;
    } finally {
        loading.value = false;
    }
}

onMounted(() => { load(); loadClaims(); });
watch(activeSiteId, () => { data.value = null; month.value = ''; claims.value = []; load(); loadClaims(); });
watch(month, (v, old) => { if (old && v && v !== old) load(); });

const today = computed(() => (data.value && data.value.today) || '');

function statusOf(r) {
    if (!r.inTable || !r.dueDate) return 'nodue';
    if (r.active === false) return 'inactive';
    if (r.dueDate < today.value) return 'overdue';
    return 'ok';
}

const STATUS_TH = {
    nodue: 'ยังไม่ตั้งรอบบิล',
    overdue: 'เลยกำหนด',
    inactive: 'ห้องว่าง',
    ok: 'ปกติ'
};

const rows = computed(() => {
    const all = (data.value && data.value.rooms) || [];
    const withStatus = all.map((r) => ({ ...r, _s: statusOf(r) }));
    const rank = { overdue: 0, nodue: 1, ok: 2, inactive: 3 };
    withStatus.sort((a, b) => (rank[a._s] - rank[b._s]) ||
                              String(a.dueDate || '').localeCompare(String(b.dueDate || '')));
    if (filter.value === 'all') return withStatus;
    if (filter.value === 'overdue') return withStatus.filter((r) => r._s === 'overdue');
    if (filter.value === 'nodue') return withStatus.filter((r) => r._s === 'nodue');
    return withStatus.filter((r) => r._s === 'overdue' || r._s === 'nodue');
});

function daysFrom(due) {
    if (!due || !today.value) return null;
    return Math.round((Date.parse(due + 'T00:00:00Z') - Date.parse(today.value + 'T00:00:00Z')) / 86400000);
}

// ---------- สลิปแจ้งชำระที่ส่งมาทาง LINE ----------
//
// ระบบรับเรื่องไว้เท่านั้น ไม่อนุมัติเอง — รูปสลิปไม่ใช่หลักฐานการชำระเงิน
// คนที่เปิดดูยอดในบัญชีธนาคารจริงเป็นคนกรอกจำนวนและกดยืนยัน
const claims = ref([]);
const pendingCount = computed(() => claims.value.filter((c) => c.status === 'pending').length);
const showAllClaims = ref(false);
const shownClaims = computed(() => showAllClaims.value
    ? claims.value
    : claims.value.filter((c) => c.status === 'pending'));

async function loadClaims() {
    try {
        const r = await apiFetch('/api/mikrotik/payment-claims');
        claims.value = r.claims || [];
    } catch (e) {
        claims.value = [];   // ข้อมูลเสริม ไม่ควรทำให้ทั้งหน้าพัง
    }
}

const slipUrl = (c) => '/api/mikrotik/payment-claims/' + c.id + '/slip';
const slipOpen = ref(false);
const slipClaim = ref(null);
const slipSrc = ref('');

// รูปสลิปต้องใช้ token เหมือน API อื่น ๆ จึงใส่ใน <img src> ตรง ๆ ไม่ได้
// (ใส่ token ลง URL ก็ไม่ควร เพราะจะไปโผล่ใน log ของ proxy)
async function openSlip(c) {
    slipClaim.value = c;
    slipSrc.value = '';
    slipOpen.value = true;
    try {
        const res = await fetch(slipUrl(c), {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
        });
        if (!res.ok) throw new Error('ไม่พบรูปสลิป');
        slipSrc.value = URL.createObjectURL(await res.blob());
    } catch (e) {
        slipSrc.value = '';
        toast.error(e.message);
    }
}

const approveOpen = ref(false);
const approve = ref({ id: '', username: '', amount: '', months: 1, paidOn: '' });

function openApprove(c) {
    approve.value = {
        id: c.id, username: c.username || '', amount: '', months: 1, paidOn: today.value
    };
    approveOpen.value = true;
}

async function saveApprove() {
    if (!approve.value.username) return toast.error('ต้องระบุว่าเป็นห้องไหน');
    const amt = Number(approve.value.amount);
    if (!isFinite(amt) || amt <= 0) return toast.error('จำนวนเงินต้องมากกว่า 0');
    busy.value = 'approve';
    try {
        const r = await apiFetch('/api/mikrotik/payment-claims/' + approve.value.id + '/approve', {
            method: 'POST',
            body: JSON.stringify({
                username: approve.value.username, amount: amt,
                months: Number(approve.value.months) || 1, paidOn: approve.value.paidOn
            })
        });
        toast.success('ยืนยันแล้ว — ครบกำหนดใหม่ ' + r.dueDate +
                      (r.notified ? ' และแจ้งลูกค้าทาง LINE แล้ว' : ' (ส่งข้อความหาลูกค้าไม่สำเร็จ)'));
        approveOpen.value = false;
        slipOpen.value = false;
        await Promise.all([load(), loadClaims()]);
    } catch (e) {
        toast.error(e.message);
    } finally {
        busy.value = '';
    }
}

async function rejectClaim(c) {
    const reason = window.prompt(
        'ไม่อนุมัติสลิปของ ' + (c.username || 'รายการนี้') + '\n\n' +
        'เหตุผลจะถูกส่งให้ลูกค้าทาง LINE — เขียนให้ชัดว่าต้องแก้อะไร\n' +
        'เช่น "ยอดไม่ตรงกับที่เข้าบัญชี" หรือ "เป็นสลิปของเดือนที่แล้ว"'
    );
    if (reason === null) return;
    if (!reason.trim()) return toast.error('ต้องระบุเหตุผล');
    busy.value = 'reject';
    try {
        await apiFetch('/api/mikrotik/payment-claims/' + c.id + '/reject', {
            method: 'POST', body: JSON.stringify({ reason: reason.trim() })
        });
        toast.success('บันทึกว่าไม่อนุมัติ และแจ้งลูกค้าแล้ว');
        await loadClaims();
    } catch (e) {
        toast.error(e.message);
    } finally {
        busy.value = '';
    }
}

function claimTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleString('th-TH', { day: '2-digit', month: 'short',
                                                       hour: '2-digit', minute: '2-digit' });
}

// ---------- นำเข้าจาก comment ----------
async function importFromRouter() {
    const ok = window.confirm(
        'อ่านวันครบกำหนดจากช่อง comment ของทุกห้องบนเราท์เตอร์ เข้ามาเก็บในระบบ\n\n' +
        'ห้องที่ตั้งรอบบิลไว้แล้วจะถูกข้าม ไม่ถูกทับ\n' +
        'ห้องที่ comment ไม่มีวันที่ จะถูกสร้างไว้แบบยังไม่มีวันครบกำหนด เพื่อให้เห็นว่ายังต้องจัดการ\n\n' +
        'ขั้นนี้ไม่เขียนอะไรลงเราท์เตอร์'
    );
    if (!ok) return;
    busy.value = 'import';
    try {
        const r = await apiFetch('/api/mikrotik/billing/import', { method: 'POST', body: '{}' });
        toast.success('นำเข้าแล้ว — สร้าง ' + r.created + ' ห้อง, ข้าม ' + r.skipped +
                      (r.withoutDate ? ', ไม่มีวันที่ใน comment ' + r.withoutDate : ''));
        await load();
    } catch (e) {
        toast.error('นำเข้าไม่สำเร็จ: ' + e.message);
    } finally {
        busy.value = '';
    }
}

// ---------- ตั้งรอบบิล ----------
const editOpen = ref(false);
const edit = ref({ username: '', tenant: '', rent: '', dueDate: '', active: true, note: '' });

function openEdit(r) {
    edit.value = {
        username: r.username, tenant: r.tenant || '', rent: r.rent ?? '',
        dueDate: r.dueDate || r.commentDueDate || '', active: r.active !== false, note: r.note || ''
    };
    editOpen.value = true;
}

async function saveEdit() {
    if (!edit.value.dueDate) return toast.error('ต้องระบุวันครบกำหนด');
    busy.value = 'save';
    try {
        const r = await apiFetch('/api/mikrotik/billing/' + encodeURIComponent(edit.value.username), {
            method: 'PUT',
            body: JSON.stringify({
                tenant: edit.value.tenant, rent: edit.value.rent === '' ? null : Number(edit.value.rent),
                dueDate: edit.value.dueDate, active: edit.value.active, note: edit.value.note
            })
        });
        toast.success('บันทึกแล้ว' + (r.commentWritten ? ' และเขียนกลับลงเราท์เตอร์แล้ว' : ''));
        if (!r.commentWritten && r.commentError) {
            toast.error('บันทึกในระบบแล้ว แต่เขียน comment ลงเราท์เตอร์ไม่ได้: ' + r.commentError);
        }
        editOpen.value = false;
        await load();
    } catch (e) {
        toast.error(e.message);
    } finally {
        busy.value = '';
    }
}

// ---------- รับชำระ ----------
const payOpen = ref(false);
const pay = ref({ username: '', amount: '', paidOn: '', months: 1, method: 'โอน', note: '', currentDue: null });

function openPay(r) {
    pay.value = {
        username: r.username, amount: r.rent ?? '', paidOn: today.value,
        months: 1, method: 'โอน', note: '', currentDue: r.dueDate
    };
    payOpen.value = true;
}

const payPreview = computed(() => {
    const p = pay.value;
    if (!p.currentDue || !p.paidOn) return null;
    const [y, m, d] = p.currentDue.split('-').map(Number);
    const months = Math.max(1, Math.min(24, Number(p.months) || 1));
    const t = new Date(Date.UTC(y, m - 1 + months, 1));
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    const next = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, last)))
        .toISOString().slice(0, 10);
    return next < p.paidOn ? null : next;   // ค้างเกินรอบ — ให้ server เป็นคนตัดสิน
});

async function savePay() {
    const amt = Number(pay.value.amount);
    if (!isFinite(amt) || amt <= 0) return toast.error('จำนวนเงินต้องมากกว่า 0');
    busy.value = 'pay';
    try {
        const r = await apiFetch('/api/mikrotik/billing/' + encodeURIComponent(pay.value.username) + '/payment', {
            method: 'POST',
            body: JSON.stringify({
                amount: amt, paidOn: pay.value.paidOn, months: Number(pay.value.months) || 1,
                method: pay.value.method, note: pay.value.note
            })
        });
        toast.success('รับชำระแล้ว — ครบกำหนดใหม่ ' + r.dueDate +
                      (r.resetFromPayment ? ' (ค้างเกินรอบ จึงเริ่มนับจากวันที่จ่าย)' : ''));
        if (!r.commentWritten && r.commentError) {
            toast.error('บันทึกการชำระแล้ว แต่เขียน comment ลงเราท์เตอร์ไม่ได้: ' + r.commentError);
        }
        payOpen.value = false;
        await load();
    } catch (e) {
        toast.error(e.message);
    } finally {
        busy.value = '';
    }
}

function baht(n) {
    return (Number(n) || 0).toLocaleString('th-TH');
}
</script>

<template>
<section class="bill">
    <div class="bhead">
        <div class="btitle"><i class="fa-solid fa-file-invoice-dollar"></i> รอบบิลค่าเช่า</div>
        <div class="bactions">
            <input v-model="month" type="month" class="v2-input sm" title="เดือนที่ดูยอด">
            <button type="button" class="v2-btn ghost sm" :disabled="loading" @click="load">
                <i class="fa-solid" :class="loading ? 'fa-spinner fa-spin' : 'fa-rotate'"></i>
            </button>
            <button type="button" class="v2-btn ghost sm" :disabled="busy === 'import'" @click="importFromRouter">
                <i class="fa-solid fa-file-import"></i> นำเข้าจากเราท์เตอร์
            </button>
        </div>
    </div>

    <div v-if="!data && loading" class="bnote">กำลังโหลด…</div>

    <template v-else-if="data">
        <div v-if="!data.routerReachable" class="v2-callout warn">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <span>อ่านเราท์เตอร์ไม่ได้ตอนนี้ — แสดงเฉพาะห้องที่มีในระบบ ยอดเงินยังถูกต้อง</span>
        </div>

        <!-- สลิปที่รอตรวจ — ขึ้นก่อนตัวเลขทั้งหมด เพราะมีคนจ่ายเงินไปแล้วและกำลังรออยู่ -->
        <div v-if="pendingCount || showAllClaims" class="claims">
            <div class="chead">
                <span class="ctitle">
                    <i class="fa-brands fa-line"></i>
                    สลิปแจ้งชำระที่รอตรวจ
                    <b v-if="pendingCount" class="cbadge">{{ pendingCount }}</b>
                </span>
                <button type="button" class="v2-btn ghost sm" @click="showAllClaims = !showAllClaims">
                    {{ showAllClaims ? 'ดูเฉพาะที่รออยู่' : 'ดูที่ตรวจแล้วด้วย' }}
                </button>
            </div>
            <p class="bnote">
                ระบบ<b>ไม่ยืนยันให้อัตโนมัติ</b> — รูปสลิปแก้ไขได้และยอดในรูปอาจไม่ตรงกับที่เข้าบัญชีจริง
                กดดูรูป เทียบกับยอดในบัญชีธนาคาร แล้วกรอกจำนวนที่<b>เข้าจริง</b>
            </p>
            <div v-if="!shownClaims.length" class="bnote">ไม่มีรายการ</div>
            <div v-for="c in shownClaims" :key="c.id" class="claim" :class="c.status">
                <div class="cinfo">
                    <b class="mono">{{ c.username || 'ยังไม่ผูกบัญชี' }}</b>
                    <span class="csub">{{ claimTime(c.receivedAt) }}</span>
                    <span v-if="c.status !== 'pending'" class="tag" :class="c.status">
                        {{ c.status === 'approved' ? 'ยืนยันแล้ว ฿' + baht(c.amount) : 'ไม่อนุมัติ' }}
                    </span>
                    <span v-if="c.rejectReason" class="csub">— {{ c.rejectReason }}</span>
                </div>
                <div class="cacts">
                    <button type="button" class="v2-btn ghost sm" @click="openSlip(c)">
                        <i class="fa-solid fa-image"></i> ดูสลิป
                    </button>
                    <template v-if="c.status === 'pending'">
                        <button type="button" class="v2-btn primary sm" @click="openApprove(c)">ยืนยัน</button>
                        <button type="button" class="v2-btn ghost sm" :disabled="busy === 'reject'"
                                @click="rejectClaim(c)">ไม่อนุมัติ</button>
                    </template>
                </div>
            </div>
        </div>

        <div class="cards">
            <div class="card">
                <div class="clab">เก็บได้เดือนนี้</div>
                <div class="cnum v2-num">฿{{ baht(data.summary.collected) }}</div>
                <div class="csub">{{ data.summary.paymentCount }} รายการ · ควรได้ ฿{{ baht(data.summary.expected) }}</div>
            </div>
            <div class="card" :class="{ bad: data.summary.overdueCount }">
                <div class="clab">ค้างชำระ</div>
                <div class="cnum v2-num">{{ data.summary.overdueCount }}</div>
                <div class="csub">฿{{ baht(data.summary.overdueAmount) }} จาก {{ data.summary.roomCount }} ห้อง</div>
            </div>
            <div class="card" :class="{ warn: data.summary.noDueDateCount || data.summary.notInTable }">
                <div class="clab">ยังไม่ตั้งรอบบิล</div>
                <div class="cnum v2-num">{{ data.summary.noDueDateCount + data.summary.notInTable }}</div>
                <div class="csub">ห้องพวกนี้ไม่ขึ้นในรายงานและไม่มีการแจ้งเตือน</div>
            </div>
        </div>

        <div class="pills">
            <button v-for="f in FILTERS" :key="f.key" type="button"
                    class="pill" :class="{ on: filter === f.key }" @click="filter = f.key">
                {{ f.label }}
            </button>
            <span class="bnote" style="margin-left:auto">แสดง {{ rows.length }} ห้อง</span>
        </div>

        <div v-if="!rows.length" class="bnote">ไม่มีห้องในกลุ่มนี้</div>

        <div v-else class="tablewrap">
            <table>
                <thead>
                    <tr><th>ห้อง</th><th>ผู้เช่า</th><th class="r">ค่าเช่า</th><th>ครบกำหนด</th>
                        <th>สถานะ</th><th></th></tr>
                </thead>
                <tbody>
                    <tr v-for="r in rows" :key="r.username" :class="r._s">
                        <td class="mono">{{ r.username }}</td>
                        <td>{{ r.tenant || '—' }}</td>
                        <td class="r v2-num">{{ r.rent ? '฿' + baht(r.rent) : '—' }}</td>
                        <td class="mono">
                            {{ r.dueDate || '—' }}
                            <span v-if="r.dueDate" class="days">
                                {{ daysFrom(r.dueDate) < 0 ? 'เกิน ' + Math.abs(daysFrom(r.dueDate)) + ' วัน'
                                   : 'อีก ' + daysFrom(r.dueDate) + ' วัน' }}
                            </span>
                        </td>
                        <td><span class="tag" :class="r._s">{{ STATUS_TH[r._s] }}</span></td>
                        <td class="acts">
                            <button type="button" class="v2-btn ghost sm" @click="openEdit(r)">ตั้งค่า</button>
                            <button type="button" class="v2-btn primary sm"
                                    :disabled="!r.dueDate" :title="r.dueDate ? '' : 'ต้องตั้งวันครบกำหนดก่อน'"
                                    @click="openPay(r)">รับชำระ</button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
    </template>

    <!-- ตั้งรอบบิล -->
    <BaseModal :open="editOpen" :title="'ตั้งรอบบิล — ' + edit.username" @close="editOpen = false">
        <div class="frm">
            <label>ชื่อผู้เช่า<input v-model="edit.tenant" class="v2-input" placeholder="ไม่บังคับ"></label>
            <label>ค่าเช่าต่อเดือน (บาท)<input v-model="edit.rent" type="number" min="0" class="v2-input"></label>
            <label>วันครบกำหนดถัดไป<input v-model="edit.dueDate" type="date" class="v2-input"></label>
            <label class="chk"><input v-model="edit.active" type="checkbox"> ห้องนี้มีผู้เช่าอยู่ (ไม่ติ๊ก = ห้องว่าง ไม่นับในยอดที่ควรได้)</label>
            <label>หมายเหตุ<input v-model="edit.note" class="v2-input" placeholder="ไม่บังคับ"></label>
            <p class="bnote">
                ระบบจะเขียนวันครบกำหนดกลับลงช่อง comment ของห้องนี้บนเราท์เตอร์ด้วย
                ข้อความเดิมที่พนักงานจดไว้จะถูกเก็บไว้ ไม่ถูกลบ
            </p>
        </div>
        <template #footer>
            <button type="button" class="v2-btn ghost" @click="editOpen = false">ยกเลิก</button>
            <button type="button" class="v2-btn primary" :disabled="busy === 'save'" @click="saveEdit">บันทึก</button>
        </template>
    </BaseModal>

    <!-- ดูรูปสลิป -->
    <BaseModal :open="slipOpen" :title="'สลิป — ' + (slipClaim ? (slipClaim.username || 'ยังไม่ผูกบัญชี') : '')"
               @close="slipOpen = false">
        <div class="sliparea">
            <img v-if="slipSrc" :src="slipSrc" alt="สลิปแจ้งชำระ">
            <p v-else class="bnote">
                ไม่มีรูปสลิปเก็บไว้ — อาจโหลดจาก LINE ไม่สำเร็จตอนที่ลูกค้าส่งมา
                รายการยังอยู่ ตรวจสอบยอดในบัญชีแล้วยืนยันได้ตามปกติ
            </p>
        </div>
        <template #footer>
            <button type="button" class="v2-btn ghost" @click="slipOpen = false">ปิด</button>
            <button v-if="slipClaim && slipClaim.status === 'pending'" type="button"
                    class="v2-btn primary" @click="openApprove(slipClaim)">ยืนยันการชำระ</button>
        </template>
    </BaseModal>

    <!-- ยืนยันสลิป -->
    <BaseModal :open="approveOpen" title="ยืนยันการชำระจากสลิป" @close="approveOpen = false">
        <div class="frm">
            <label>ห้อง<input v-model="approve.username" class="v2-input" placeholder="เช่น rm301"></label>
            <label>จำนวนเงินที่<b>เข้าบัญชีจริง</b> (บาท)
                <input v-model="approve.amount" type="number" min="1" class="v2-input"></label>
            <label>วันที่ชำระ<input v-model="approve.paidOn" type="date" class="v2-input"></label>
            <label>ต่ออายุกี่เดือน<input v-model="approve.months" type="number" min="1" max="24" class="v2-input"></label>
            <p class="bnote">
                กดยืนยันแล้วระบบจะบันทึกการชำระ ต่อวันครบกำหนด เขียนกลับลงเราท์เตอร์
                และส่งข้อความแจ้งลูกค้าทาง LINE ทั้งหมดในครั้งเดียว
            </p>
        </div>
        <template #footer>
            <button type="button" class="v2-btn ghost" @click="approveOpen = false">ยกเลิก</button>
            <button type="button" class="v2-btn primary" :disabled="busy === 'approve'" @click="saveApprove">
                ยืนยันการชำระ
            </button>
        </template>
    </BaseModal>

    <!-- รับชำระ -->
    <BaseModal :open="payOpen" :title="'รับชำระ — ' + pay.username" @close="payOpen = false">
        <div class="frm">
            <label>จำนวนเงิน (บาท)<input v-model="pay.amount" type="number" min="1" class="v2-input"></label>
            <label>วันที่ชำระ<input v-model="pay.paidOn" type="date" class="v2-input"></label>
            <label>จ่ายกี่เดือน<input v-model="pay.months" type="number" min="1" max="24" class="v2-input"></label>
            <label>ช่องทาง
                <select v-model="pay.method" class="v2-input">
                    <option>โอน</option><option>เงินสด</option><option>อื่น ๆ</option>
                </select>
            </label>
            <label>หมายเหตุ<input v-model="pay.note" class="v2-input" placeholder="ไม่บังคับ"></label>
            <p class="bnote">
                ครบกำหนดเดิม <b class="mono">{{ pay.currentDue || '—' }}</b> →
                <b class="mono">{{ payPreview || 'ระบบจะคำนวณให้' }}</b><br>
                ต่ออายุจาก<b>วันครบกำหนดเดิม</b> ไม่ใช่จากวันที่จ่าย ลูกค้าที่จ่ายช้าจึงไม่ได้เดือนนั้นยาวขึ้นฟรี
                — ยกเว้นค้างเกินหนึ่งรอบเต็ม ระบบจะเริ่มนับจากวันที่จ่ายแทนและแจ้งให้ทราบ
            </p>
        </div>
        <template #footer>
            <button type="button" class="v2-btn ghost" @click="payOpen = false">ยกเลิก</button>
            <button type="button" class="v2-btn primary" :disabled="busy === 'pay'" @click="savePay">
                บันทึกการชำระ
            </button>
        </template>
    </BaseModal>
</section>
</template>

<style scoped>
.claims { border: 1px solid var(--v2-border); border-left: 3px solid #06c755;
          border-radius: 8px; padding: 10px 12px; margin: 12px 0; }
.chead { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.ctitle { font-weight: 700; font-size: .88rem; display: flex; align-items: center; gap: 7px; }
.ctitle i { color: #06c755; }
.cbadge { background: var(--v2-danger); color: #fff; border-radius: 999px;
          font-size: .7rem; padding: 1px 8px; }
.claim { display: flex; align-items: center; justify-content: space-between; gap: 10px;
         flex-wrap: wrap; padding: 7px 0; border-top: 1px solid var(--v2-border); }
.cinfo { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: .82rem; }
.csub { font-size: .74rem; color: var(--v2-text-muted); }
.cacts { display: flex; gap: 5px; }
.tag.approved { color: var(--v2-success); border-color: color-mix(in srgb, var(--v2-success) 35%, transparent); }
.tag.rejected { color: var(--v2-danger); border-color: color-mix(in srgb, var(--v2-danger) 35%, transparent); }
.sliparea { text-align: center; }
.sliparea img { max-width: 100%; max-height: 65vh; border-radius: 8px; border: 1px solid var(--v2-border); }

.bill {
    background: var(--v2-surface); border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius); padding: 14px 16px; margin-bottom: 14px;
}
.bhead { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.btitle { font-weight: 700; font-size: .95rem; display: flex; align-items: center; gap: 8px; }
.bactions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.bnote { font-size: .78rem; color: var(--v2-text-muted); line-height: 1.6; margin: 8px 0 0; }

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; margin: 12px 0; }
.card { border: 1px solid var(--v2-border); border-left: 3px solid var(--v2-success); border-radius: 8px; padding: 10px 12px; }
.card.bad { border-left-color: var(--v2-danger); }
.card.warn { border-left-color: var(--v2-warn); }
.clab { font-size: .74rem; color: var(--v2-text-muted); }
.cnum { font-size: 1.4rem; font-weight: 700; letter-spacing: -.02em; }
.csub { font-size: .72rem; color: var(--v2-text-muted); }

.pills { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.pill { border: 1px solid var(--v2-border); background: #fff; border-radius: 999px;
        padding: 4px 11px; font-size: .76rem; font-family: inherit; cursor: pointer; color: var(--v2-text); }
.pill.on { background: var(--v2-primary); border-color: var(--v2-primary); color: #fff; }

.tablewrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .82rem; }
th { text-align: left; font-size: .72rem; font-weight: 600; color: var(--v2-text-muted);
     padding: 6px 8px; border-bottom: 1px solid var(--v2-border); }
td { padding: 7px 8px; border-bottom: 1px solid var(--v2-border); }
th.r, td.r { text-align: right; }
tr.overdue td:first-child { box-shadow: inset 3px 0 0 var(--v2-danger); }
tr.nodue td:first-child { box-shadow: inset 3px 0 0 var(--v2-warn); }
.days { display: block; font-size: .68rem; color: var(--v2-text-muted); }
.tag { font-size: .72rem; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--v2-border); }
.tag.overdue { color: var(--v2-danger); border-color: color-mix(in srgb, var(--v2-danger) 35%, transparent); }
.tag.nodue { color: var(--v2-warn); border-color: color-mix(in srgb, var(--v2-warn) 35%, transparent); }
.tag.ok { color: var(--v2-success); border-color: color-mix(in srgb, var(--v2-success) 35%, transparent); }
.acts { display: flex; gap: 5px; justify-content: flex-end; }

.frm { display: flex; flex-direction: column; gap: 11px; }
.frm label { display: flex; flex-direction: column; gap: 4px; font-size: .82rem; font-weight: 500; }
.frm label.chk { flex-direction: row; align-items: center; gap: 8px; font-weight: 400; }
</style>
