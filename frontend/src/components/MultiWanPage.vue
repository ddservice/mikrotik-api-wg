<script setup>
/**
 * หน้า Multi-WAN สำรองอัตโนมัติ — เดินทีละขั้น อ่านก่อน แล้วดูแผน แล้วค่อยลง
 *
 * หน้าเดิมใน v1 เป็นฟอร์มให้กรอกชื่อ interface กับ gateway เอง แล้วมีปุ่ม Apply
 * ปุ่มเดียวที่ขึ้นว่า "สำเร็จ!" ทั้งที่ทำไม่ครบ — คนกดจึงไม่มีทางรู้ว่าเกิดอะไรขึ้นจริง
 *
 * อันนี้กลับด้าน: ไม่ให้กรอกอะไรที่เราอ่านเองได้ ไม่ให้ลงอะไรที่ยังไม่ได้ให้ดูก่อน
 * และไม่บอกว่าสำเร็จจนกว่าจะ ping ออกได้จริงหลังลง
 */
import { ref, computed } from 'vue';
import { apiFetch } from '../api.js';
import { toast } from '../toast.js';

const STAGE = { READ: 1, PLAN: 2, DONE: 3 };
const stage = ref(STAGE.READ);

const busy = ref('');
const analysis = ref(null);
const plan = ref(null);
const rollbackScript = ref('');
const result = ref(null);
const progress = ref([]);

// ความเร็วที่คนกรอก ใช้ตัดสินว่าควรทำ PCC ไหม — ไม่บังคับ
const speeds = ref({});
const order = ref([]);
const rollbackSeconds = ref(180);

const rec = computed(() => analysis.value && analysis.value.recommendation);
const wans = computed(() => (analysis.value && analysis.value.usable) || []);

async function readState() {
    busy.value = 'read';
    try {
        const q = Object.keys(speeds.value).length
            ? '?speeds=' + encodeURIComponent(JSON.stringify(speeds.value)) : '';
        const r = await apiFetch('/api/multiwan/analyze' + q);
        analysis.value = r.analysis;
        order.value = r.analysis.usable.map((w) => w.interface);
        plan.value = null;
        result.value = null;
        stage.value = STAGE.READ;
    } catch (e) {
        toast.error('อ่านค่าจากเราท์เตอร์ไม่สำเร็จ: ' + e.message);
    } finally {
        busy.value = '';
    }
}

async function buildPlan() {
    busy.value = 'plan';
    try {
        const r = await apiFetch('/api/multiwan/failover/plan', {
            method: 'POST',
            body: JSON.stringify({ order: order.value, speeds: speeds.value })
        });
        analysis.value = r.analysis;
        plan.value = r.plan;
        rollbackScript.value = r.rollbackScript;
        stage.value = STAGE.PLAN;
    } catch (e) {
        toast.error('สร้างแผนไม่สำเร็จ: ' + e.message);
    } finally {
        busy.value = '';
    }
}

async function applyPlan() {
    const primary = order.value[0];
    const ok = window.confirm(
        'กำลังจะแก้เส้นทางออกอินเทอร์เน็ตของสาขานี้จริง\n\n' +
        `สายหลัก: ${primary}\n` +
        `ถ้าไม่ได้ผล ระบบจะถอนคืนเองภายใน ${rollbackSeconds.value} วินาที\n\n` +
        'ระหว่างนี้เน็ตของสาขาอาจสะดุดสั้น ๆ — ยืนยันหรือไม่'
    );
    if (!ok) return;

    busy.value = 'apply';
    progress.value = [];
    try {
        const r = await apiFetch('/api/multiwan/failover/apply', {
            method: 'POST',
            body: JSON.stringify({
                order: order.value, speeds: speeds.value,
                rollbackSeconds: Number(rollbackSeconds.value) || 180
            })
        });
        result.value = r;
        progress.value = r.logs || [];
        stage.value = STAGE.DONE;
        if (r.success) toast.success('ลงสำเร็จ และตรวจแล้วว่ายังออกเน็ตได้');
        else toast.error('ไม่สำเร็จ — ถอนคืนแล้ว');
    } catch (e) {
        // แม้พังก็ยังต้องแสดงสิ่งที่เกิดขึ้น ไม่ใช่แค่ข้อความ error ลอย ๆ
        result.value = { success: false, error: e.message, rolledBack: null };
        stage.value = STAGE.DONE;
        toast.error(e.message);
    } finally {
        busy.value = '';
    }
}

async function removeAll() {
    if (!window.confirm('ถอนการตั้งค่าสำรองอัตโนมัติออกทั้งหมด และคืนค่าเดิม — ยืนยันหรือไม่')) return;
    busy.value = 'remove';
    try {
        const r = await apiFetch('/api/multiwan/failover/remove', { method: 'POST' });
        toast.success(`ถอนแล้ว: เส้นทาง ${r.removed.routes} เส้น, NAT ${r.removed.nat} ข้อ`);
        await readState();
    } catch (e) {
        toast.error(e.message);
    } finally {
        busy.value = '';
    }
}

function moveUp(i) {
    if (i <= 0) return;
    const a = order.value.slice();
    [a[i - 1], a[i]] = [a[i], a[i - 1]];
    order.value = a;
    plan.value = null;
}
</script>

<template>
<div class="mw">
    <div class="head">
        <div>
            <h2>Multi-WAN — สำรองอัตโนมัติ</h2>
            <p class="sub">
                เมื่อสายหลักตาย เราท์เตอร์จะสลับไปสายสำรองเองภายในไม่กี่วินาที
                โดยไม่ต้องมีคนไปกด
            </p>
        </div>
        <button class="v2-btn ghost" :disabled="busy === 'read'" @click="readState">
            <i class="fa-solid" :class="busy === 'read' ? 'fa-spinner fa-spin' : 'fa-rotate'"></i>
            อ่านค่าจากเราท์เตอร์
        </button>
    </div>

    <div class="stages">
        <div class="st" :class="{ on: stage >= 1 }"><b>1</b> อ่านของจริง</div>
        <div class="st" :class="{ on: stage >= 2 }"><b>2</b> ดูแผนก่อนลง</div>
        <div class="st" :class="{ on: stage >= 3 }"><b>3</b> ลงและตรวจ</div>
    </div>

    <div v-if="!analysis" class="v2-callout info">
        <i class="fa-solid fa-circle-info"></i>
        <span>กด "อ่านค่าจากเราท์เตอร์" เพื่อเริ่ม — ขั้นนี้อ่านอย่างเดียว ไม่แก้อะไรทั้งนั้น</span>
    </div>

    <template v-else>
        <!-- ============ สายที่เจอจริง ============ -->
        <section class="card">
            <h3>สายที่เจอบนเราท์เตอร์</h3>
            <p class="note">อ่านจาก PPPoE client และ DHCP client จริง ไม่ได้ให้กรอกเอง จึงพิมพ์ชื่อผิดไม่ได้</p>
            <table class="tbl">
                <thead><tr>
                    <th>ลำดับ</th><th>Interface</th><th>ชนิด</th><th>Gateway</th>
                    <th>สถานะ</th><th>NAT</th><th>ความเร็ว (Mbps)</th><th></th>
                </tr></thead>
                <tbody>
                    <tr v-for="(name, i) in order" :key="name">
                        <td><span class="rank" :class="{ primary: i === 0 }">{{ i === 0 ? 'หลัก' : 'สำรอง ' + i }}</span></td>
                        <td class="mono">{{ name }}</td>
                        <td>{{ (wans.find(w => w.interface === name) || {}).kind }}</td>
                        <td class="mono sm">{{ (wans.find(w => w.interface === name) || {}).gateway }}</td>
                        <td>
                            <span class="dot" :class="(wans.find(w => w.interface === name) || {}).running ? 'ok' : 'bad'"></span>
                            {{ (wans.find(w => w.interface === name) || {}).running ? 'ขึ้น' : 'ไม่ขึ้น' }}
                        </td>
                        <td>{{ (wans.find(w => w.interface === name) || {}).hasNat ? 'มี' : 'จะเพิ่มให้' }}</td>
                        <td>
                            <input type="number" class="v2-input sm" placeholder="ไม่ทราบ"
                                   :value="speeds[name]"
                                   @input="speeds[name] = Number($event.target.value) || undefined; plan = null">
                        </td>
                        <td>
                            <button v-if="i > 0" class="v2-btn ghost sm" title="เลื่อนขึ้นเป็นสายหลัก"
                                    @click="moveUp(i)"><i class="fa-solid fa-arrow-up"></i></button>
                        </td>
                    </tr>
                </tbody>
            </table>
            <p class="note">
                กรอกความเร็วแต่ละสายเพื่อให้ระบบบอกได้ว่าควรแบ่งโหลด (PCC) ด้วยหรือไม่ — ไม่กรอกก็ทำสำรองได้ตามปกติ
            </p>
        </section>

        <!-- ============ คำแนะนำจากระบบ ============ -->
        <section class="card rec" v-if="rec">
            <h3><i class="fa-solid fa-lightbulb"></i> ระบบวิเคราะห์ให้แล้ว</h3>
            <div class="rec-title">{{ rec.title }}</div>
            <ul class="why"><li v-for="(w, i) in rec.why" :key="i">{{ w }}</li></ul>
            <div v-if="rec.rejected" class="rejected">
                <b>ทำไมไม่แนะนำ PCC ตอนนี้</b>
                <ul><li v-for="(b, i) in rec.rejected.because" :key="i">{{ b }}</li></ul>
            </div>
        </section>

        <div v-for="(w, i) in analysis.warnings" :key="'w' + i" class="v2-callout warn">
            <i class="fa-solid fa-triangle-exclamation"></i><span>{{ w.message }}</span>
        </div>
        <div v-for="(b, i) in analysis.blockers" :key="'b' + i" class="v2-callout danger">
            <i class="fa-solid fa-circle-xmark"></i><span>{{ b.message }}</span>
        </div>

        <div class="actions" v-if="analysis.canFailover && stage === 1">
            <button class="v2-btn primary" :disabled="busy === 'plan'" @click="buildPlan">
                <i class="fa-solid" :class="busy === 'plan' ? 'fa-spinner fa-spin' : 'fa-list-check'"></i>
                ดูแผนก่อนลง
            </button>
            <button class="v2-btn ghost" :disabled="busy === 'remove'" @click="removeAll">
                <i class="fa-solid fa-eraser"></i> ถอนของที่เคยลงไว้
            </button>
        </div>

        <!-- ============ แผน ============ -->
        <section class="card" v-if="plan && stage >= 2">
            <h3>จะทำอะไรบ้าง ({{ plan.steps.length }} ขั้น)</h3>
            <ol class="steps">
                <li v-for="s in plan.steps" :key="s.id" :class="'r-' + s.risk">
                    <div class="s-title">{{ s.title }} <span class="risk">{{ s.risk }}</span></div>
                    <div class="s-why">{{ s.why }}</div>
                    <code class="s-cmd">{{ s.apply.cmd }}</code>
                </li>
            </ol>

            <div class="v2-callout ok">
                <i class="fa-solid fa-shield-halved"></i>
                <span>
                    <strong>ถอยกลับได้ทุกกรณี:</strong> สำรองค่าทั้งเครื่องก่อน · ฝากคำสั่งถอนไว้บนเราท์เตอร์
                    ก่อนแตะอะไร (ถ้าเราหลุด มันคืนค่าเอง) · เส้นทางเดิมไม่ถูกลบ แค่ถูกดันไปลำดับหลัง
                    จึงตกกลับไปใช้ได้ · ลงเสร็จต้อง ping ผ่านจริงถึงจะยืนยัน
                </span>
            </div>

            <div class="v2-field inline">
                <label>ถอนคืนอัตโนมัติถ้าไม่ได้ยืนยันภายใน</label>
                <input type="number" class="v2-input sm" v-model="rollbackSeconds"> วินาที
            </div>

            <details class="raw">
                <summary>ดูคำสั่งถอนที่จะฝากไว้บนเราท์เตอร์</summary>
                <pre>{{ rollbackScript }}</pre>
            </details>

            <div class="actions">
                <button class="v2-btn danger" :disabled="busy === 'apply'" @click="applyPlan">
                    <i class="fa-solid" :class="busy === 'apply' ? 'fa-spinner fa-spin' : 'fa-play'"></i>
                    ลงจริงบนเราท์เตอร์
                </button>
                <button class="v2-btn ghost" @click="stage = 1; plan = null">ย้อนกลับ</button>
            </div>
        </section>

        <!-- ============ ผล ============ -->
        <section class="card" v-if="result && stage === 3">
            <h3>ผลการลง</h3>
            <div class="v2-callout" :class="result.success ? 'ok' : 'danger'">
                <i class="fa-solid" :class="result.success ? 'fa-circle-check' : 'fa-circle-xmark'"></i>
                <span v-if="result.success">
                    สำเร็จ — ลงไป {{ result.applied }} ขั้น และตรวจแล้วว่ายังออกเน็ตได้จริง
                </span>
                <span v-else>
                    ไม่สำเร็จ: {{ result.error }}
                    <template v-if="result.rolledBack"> — <strong>ถอนคืนเรียบร้อย เราท์เตอร์กลับสู่สภาพเดิม</strong></template>
                    <template v-else-if="result.rolledBack === false">
                        — ถอนอัตโนมัติไม่สำเร็จ ตัวถอนที่ฝากไว้บนเราท์เตอร์จะทำงานเองเมื่อครบเวลา
                    </template>
                </span>
            </div>

            <div v-if="result.checks" class="checks">
                <div v-for="c in result.checks" :key="c.interface" class="chk" :class="{ bad: !c.ok }">
                    <span class="dot" :class="c.ok ? 'ok' : 'bad'"></span>
                    <span class="mono">{{ c.interface }}</span>
                    <span class="sm">ping {{ c.host }} — ตอบกลับ {{ c.replies }}/{{ c.sent }}</span>
                </div>
            </div>

            <details v-if="progress.length" class="raw" open>
                <summary>บันทึกทีละขั้น</summary>
                <div v-for="(p, i) in progress" :key="i" class="line">
                    <span class="ph">{{ p.phase }}</span> {{ p.message }}
                </div>
            </details>

            <div class="actions">
                <button class="v2-btn ghost" @click="readState">อ่านค่าใหม่อีกครั้ง</button>
                <button class="v2-btn ghost" :disabled="busy === 'remove'" @click="removeAll">
                    <i class="fa-solid fa-eraser"></i> ถอนออก
                </button>
            </div>
        </section>
    </template>
</div>
</template>

<style scoped>
.mw { display: flex; flex-direction: column; gap: 14px; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap; }
h2 { margin: 0; font-size: 1.25rem; }
.sub { margin: 4px 0 0; color: var(--v2-text-muted); font-size: .86rem; max-width: 62ch; }
.stages { display: flex; gap: 8px; flex-wrap: wrap; }
.st { display: flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 999px;
      border: 1px solid var(--v2-border); font-size: .82rem; color: var(--v2-text-muted); }
.st.on { border-color: var(--v2-primary); color: var(--v2-primary); background: var(--v2-primary-soft); }
.st b { display: inline-flex; width: 20px; height: 20px; align-items: center; justify-content: center;
        border-radius: 50%; background: var(--v2-primary-soft); color: var(--v2-primary); font-size: .72rem; }
.st.on b { background: var(--v2-primary); color: #fff; }
.card { border: 1px solid var(--v2-border); border-radius: 12px; padding: 16px; background: var(--v2-surface, #fff); }
.card h3 { margin: 0 0 4px; font-size: 1rem; }
.note { margin: 4px 0 10px; font-size: .8rem; color: var(--v2-text-muted); }
.tbl { width: 100%; border-collapse: collapse; font-size: .84rem; }
.tbl th { text-align: left; font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--v2-border);
          color: var(--v2-text-muted); font-size: .78rem; }
.tbl td { padding: 8px 10px; border-bottom: 1px solid var(--v2-border); vertical-align: middle; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.sm { font-size: .78rem; }
.rank { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: .74rem;
        background: var(--v2-border); }
.rank.primary { background: var(--v2-primary); color: #fff; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.dot.ok { background: var(--v2-success, #16a34a); }
.dot.bad { background: var(--v2-danger, #dc2626); }
.rec { border-left: 3px solid var(--v2-primary); }
.rec-title { font-size: 1.02rem; font-weight: 600; color: var(--v2-primary); margin: 6px 0 8px; }
.why { margin: 0; padding-left: 20px; font-size: .85rem; line-height: 1.75; }
.rejected { margin-top: 12px; padding: 10px 12px; border-radius: 8px; background: var(--v2-bg-soft, #f8fafc); font-size: .82rem; }
.rejected ul { margin: 6px 0 0; padding-left: 20px; line-height: 1.7; }
.steps { margin: 8px 0 14px; padding-left: 22px; display: grid; gap: 10px; }
.steps li { padding-left: 4px; }
.s-title { font-weight: 600; font-size: .88rem; }
.risk { font-size: .68rem; padding: 1px 7px; border-radius: 999px; margin-left: 6px;
        background: var(--v2-border); text-transform: uppercase; }
.r-high .risk { background: var(--v2-danger, #dc2626); color: #fff; }
.r-medium .risk { background: #f59e0b; color: #fff; }
.s-why { font-size: .8rem; color: var(--v2-text-muted); margin: 2px 0 4px; }
.s-cmd { font-size: .72rem; background: var(--v2-bg-soft, #f8fafc); padding: 2px 6px; border-radius: 4px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.v2-field.inline { display: flex; align-items: center; gap: 10px; margin-top: 12px; font-size: .84rem; }
.v2-input.sm { width: 96px; }
.raw { margin-top: 12px; font-size: .8rem; }
.raw pre { background: var(--v2-bg-soft, #f8fafc); padding: 12px; border-radius: 8px;
           overflow-x: auto; font-size: .74rem; line-height: 1.6; }
.line { padding: 3px 0; border-bottom: 1px dashed var(--v2-border); }
.ph { display: inline-block; min-width: 74px; font-size: .7rem; color: var(--v2-primary);
      text-transform: uppercase; }
.checks { display: grid; gap: 6px; margin: 10px 0; }
.chk { display: flex; align-items: center; gap: 10px; font-size: .84rem; }
</style>
