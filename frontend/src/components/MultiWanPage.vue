<script setup>
/**
 * หน้า Multi-WAN Failover — เดินทีละขั้น: read → review → apply
 *
 * หน้าเดิมใน v1 เป็นฟอร์มให้กรอกชื่อ interface กับ gateway เอง แล้วมีปุ่ม Apply
 * ปุ่มเดียวที่ขึ้นว่า "สำเร็จ!" ทั้งที่ทำไม่ครบ — คนกดจึงไม่มีทางรู้ว่าเกิดอะไรขึ้นจริง
 *
 * อันนี้กลับด้าน: ไม่ให้กรอกอะไรที่อ่านจากเราท์เตอร์เองได้ ไม่ apply อะไรที่ยังไม่ได้
 * ให้ดูก่อน และไม่บอกว่าสำเร็จจนกว่าจะ ping ออกได้จริงหลัง apply
 *
 * ศัพท์เทคนิคใช้ภาษาอังกฤษทั้งหน้าโดยตั้งใจ — คำแปลไทยของศัพท์เครือข่าย
 * (route/distance/gateway/mangle) อ่านแล้วสับสนกว่าเดิมสำหรับคนที่ทำงานกับ RouterOS
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

// bandwidth ที่คนกรอก ใช้ตัดสินว่าควรทำ PCC ไหม — ไม่บังคับ
const speeds = ref({});
const order = ref([]);
const rollbackSeconds = ref(180);

const rec = computed(() => analysis.value && analysis.value.recommendation);
const wans = computed(() => (analysis.value && analysis.value.usable) || []);
const activeWan = computed(() => analysis.value && analysis.value.activeWan);

function wanOf(name) {
    return wans.value.find((w) => w.interface === name) || {};
}

async function readState() {
    busy.value = 'read';
    try {
        const q = Object.keys(speeds.value).length
            ? '?speeds=' + encodeURIComponent(JSON.stringify(speeds.value)) : '';
        const r = await apiFetch('/api/multiwan/analyze' + q);
        analysis.value = r.analysis;
        // ใช้ลำดับที่ระบบแนะนำเป็นค่าตั้งต้น (เรียงตาม bandwidth จากมากไปน้อย)
        order.value = (r.analysis.recommendation && r.analysis.recommendation.order)
            || r.analysis.usable.map((w) => w.interface);
        plan.value = null;
        result.value = null;
        stage.value = STAGE.READ;
    } catch (e) {
        toast.error('อ่าน config จากเราท์เตอร์ไม่สำเร็จ: ' + e.message);
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
        toast.error('สร้าง plan ไม่สำเร็จ: ' + e.message);
    } finally {
        busy.value = '';
    }
}

async function applyPlan() {
    const ok = window.confirm(
        'กำลังจะแก้ routing table ของสาขานี้จริง\n\n' +
        'PRIMARY: ' + order.value[0] + '\n' +
        'BACKUP : ' + order.value.slice(1).join(', ') + '\n\n' +
        'ถ้า verify ไม่ผ่าน ระบบจะ rollback เอง และ scheduler บนเราท์เตอร์จะคืนค่าให้\n' +
        'ภายใน ' + rollbackSeconds.value + ' วินาทีถ้า session หลุด\n\n' +
        'ระหว่างนี้ internet ของสาขาอาจสะดุดสั้น ๆ — ยืนยันหรือไม่'
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
        if (r.success) toast.success('Apply สำเร็จ และ verify แล้วว่ายังออก internet ได้');
        else toast.error('ไม่สำเร็จ — rollback แล้ว');
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
    if (!window.confirm('Remove failover config ทั้งหมด และคืน default-route-distance เดิม — ยืนยันหรือไม่')) return;
    busy.value = 'remove';
    try {
        const r = await apiFetch('/api/multiwan/failover/remove', { method: 'POST' });
        toast.success(`ถอนแล้ว: routes ${r.removed.routes}, NAT ${r.removed.nat}`);
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
            <h2>Multi-WAN Failover</h2>
            <p class="sub">
                เมื่อ primary WAN down เราท์เตอร์จะสลับไป backup line เองภายใน ~20–30 วินาที
                ด้วย recursive route + <code>check-gateway=ping</code> —
                ไม่ใช้ mangle จึงไม่ต้องปิด FastTrack และไม่เสีย throughput
            </p>
        </div>
        <button class="v2-btn ghost" :disabled="busy === 'read'" @click="readState">
            <i class="fa-solid" :class="busy === 'read' ? 'fa-spinner fa-spin' : 'fa-rotate'"></i>
            Read current config
        </button>
    </div>

    <div class="stages">
        <div class="st" :class="{ on: stage >= 1 }"><b>1</b> Read config</div>
        <div class="st" :class="{ on: stage >= 2 }"><b>2</b> Review plan</div>
        <div class="st" :class="{ on: stage >= 3 }"><b>3</b> Apply &amp; verify</div>
    </div>

    <div v-if="!analysis" class="v2-callout info">
        <i class="fa-solid fa-circle-info"></i>
        <span>กด <strong>Read current config</strong> เพื่อเริ่ม — ขั้นนี้ read-only ไม่เขียนอะไรลงเราท์เตอร์</span>
    </div>

    <template v-else>
        <!-- กำลังวิ่งบน backup อยู่หรือเปล่า — เรื่องที่ต้องเห็นก่อนอย่างอื่น -->
        <div v-if="activeWan && !activeWan.isPrimary" class="v2-callout warn">
            <i class="fa-solid fa-triangle-exclamation"></i>
            <span>
                <strong>ตอนนี้กำลังใช้ backup line อยู่:</strong>
                <code>{{ activeWan.interface }}</code> (distance {{ activeWan.distance }}) —
                แปลว่า primary line ตรวจไม่ผ่านอยู่ ควรตรวจว่าเกิดอะไรขึ้น
            </span>
        </div>
        <div v-else-if="activeWan" class="v2-callout ok">
            <i class="fa-solid fa-circle-check"></i>
            <span>
                Failover ติดตั้งอยู่แล้ว และกำลังใช้ primary line
                <code>{{ activeWan.interface }}</code> ตามปกติ
            </span>
        </div>

        <!-- ============ WAN lines ============ -->
        <section class="card">
            <h3>WAN lines ที่ตรวจพบ</h3>
            <p class="note">
                อ่านจาก <code>/interface/pppoe-client</code> และ <code>/ip/dhcp-client</code> จริง —
                ไม่ได้ให้กรอกเอง จึงพิมพ์ชื่อ interface ผิดไม่ได้
            </p>
            <div class="tbl-wrap">
                <table class="tbl">
                    <thead><tr>
                        <th>Role</th><th>Interface</th><th>Type</th><th>WAN IP</th>
                        <th>Gateway</th><th>Status</th><th>NAT</th>
                        <th>Bandwidth (Mbps)</th><th></th>
                    </tr></thead>
                    <tbody>
                        <tr v-for="(name, i) in order" :key="name">
                            <td>
                                <span class="rank" :class="{ primary: i === 0 }">
                                    {{ i === 0 ? 'PRIMARY' : 'BACKUP ' + i }}
                                </span>
                            </td>
                            <td class="mono">{{ name }}</td>
                            <td class="up">{{ wanOf(name).kind }}</td>
                            <td class="mono sm">{{ wanOf(name).address || '—' }}</td>
                            <td class="mono sm">{{ wanOf(name).gateway }}</td>
                            <td>
                                <span class="dot" :class="wanOf(name).running ? 'ok' : 'bad'"></span>
                                {{ wanOf(name).running ? 'running' : 'down' }}
                            </td>
                            <td>{{ wanOf(name).hasNat ? 'ok' : 'will add' }}</td>
                            <td>
                                <input type="number" class="v2-input sm" placeholder="unknown"
                                       :value="speeds[name]"
                                       @input="speeds[name] = Number($event.target.value) || undefined; plan = null">
                            </td>
                            <td>
                                <button v-if="i > 0" class="v2-btn ghost sm"
                                        title="เลื่อนขึ้นให้ distance ต่ำลง" @click="moveUp(i)">
                                    <i class="fa-solid fa-arrow-up"></i>
                                </button>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <p class="note">
                กรอก bandwidth ของแต่ละ line เพื่อให้ระบบคำนวณได้ว่าควรทำ PCC load balancing ด้วยหรือไม่
                — ไม่กรอกก็ทำ failover ได้ตามปกติ · แถวบนสุด = <code>distance 1</code> = primary
            </p>
        </section>

        <!-- ============ คำแนะนำ ============ -->
        <section class="card rec" v-if="rec">
            <h3><i class="fa-solid fa-lightbulb"></i> Recommended topology</h3>
            <div class="rec-title">{{ rec.title }}</div>
            <ul class="why"><li v-for="(w, i) in rec.why" :key="i">{{ w }}</li></ul>
            <div v-if="rec.rejected" class="rejected">
                <b>ทำไมยังไม่แนะนำ PCC</b>
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
                Review plan
            </button>
            <button class="v2-btn ghost" :disabled="busy === 'remove'" @click="removeAll">
                <i class="fa-solid fa-eraser"></i> Remove existing config
            </button>
        </div>

        <!-- ============ plan ============ -->
        <section class="card" v-if="plan && stage >= 2">
            <h3>Plan — {{ plan.steps.length }} steps</h3>
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
                    <strong>Rollback ได้ทุกกรณี:</strong>
                    <code>/system/backup/save</code> ก่อน ·
                    ฝาก rollback scheduler ไว้บนเราท์เตอร์ <em>ก่อน</em> เขียนอะไร
                    (ถ้า session หลุดกลางคัน มันคืนค่าเอง) ·
                    default route เดิมไม่ถูกลบ แค่เพิ่ม distance จึง fall back ได้ ·
                    ต้อง ping ผ่านจริงหลัง apply ถึงจะ commit
                </span>
            </div>

            <div class="v2-field inline">
                <label>Auto-rollback ถ้าไม่ได้ commit ภายใน</label>
                <input type="number" class="v2-input sm" v-model="rollbackSeconds"> วินาที
            </div>

            <details class="raw">
                <summary>ดู rollback script ที่จะฝากไว้บนเราท์เตอร์</summary>
                <pre>{{ rollbackScript }}</pre>
            </details>

            <div class="actions">
                <button class="v2-btn danger" :disabled="busy === 'apply'" @click="applyPlan">
                    <i class="fa-solid" :class="busy === 'apply' ? 'fa-spinner fa-spin' : 'fa-play'"></i>
                    Apply to router
                </button>
                <button class="v2-btn ghost" @click="stage = 1; plan = null">Back</button>
            </div>
        </section>

        <!-- ============ result ============ -->
        <section class="card" v-if="result && stage === 3">
            <h3>Result</h3>
            <div class="v2-callout" :class="result.success ? 'ok' : 'danger'">
                <i class="fa-solid" :class="result.success ? 'fa-circle-check' : 'fa-circle-xmark'"></i>
                <span v-if="result.success">
                    สำเร็จ — apply {{ result.applied }} steps และ verify แล้วว่ายังออก internet ได้จริง
                    · ส่งสรุปพร้อม WAN IP ของทุก line เข้า Telegram ทีมแอดมินแล้ว
                </span>
                <span v-else>
                    ไม่สำเร็จ: {{ result.error }}
                    <template v-if="result.rolledBack">
                        — <strong>rollback เรียบร้อย เราท์เตอร์กลับสู่ config เดิม</strong>
                    </template>
                    <template v-else-if="result.rolledBack === false">
                        — rollback อัตโนมัติไม่สำเร็จ scheduler ที่ฝากไว้บนเราท์เตอร์จะทำงานเองเมื่อครบเวลา
                    </template>
                </span>
            </div>

            <div v-if="result.checks" class="checks">
                <div v-for="c in result.checks" :key="c.interface" class="chk" :class="{ bad: !c.ok }">
                    <span class="dot" :class="c.ok ? 'ok' : 'bad'"></span>
                    <span class="mono">{{ c.interface }}</span>
                    <span class="sm">ping {{ c.host }} — {{ c.replies }}/{{ c.sent }} replies</span>
                </div>
            </div>

            <details v-if="progress.length" class="raw" open>
                <summary>Step-by-step log</summary>
                <div v-for="(p, i) in progress" :key="i" class="line">
                    <span class="ph">{{ p.phase }}</span> {{ p.message }}
                </div>
            </details>

            <div class="actions">
                <button class="v2-btn ghost" @click="readState">Re-read config</button>
                <button class="v2-btn ghost" :disabled="busy === 'remove'" @click="removeAll">
                    <i class="fa-solid fa-eraser"></i> Remove failover config
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
.sub { margin: 4px 0 0; color: var(--v2-text-muted); font-size: .86rem; max-width: 72ch; line-height: 1.7; }
.stages { display: flex; gap: 8px; flex-wrap: wrap; }
.st { display: flex; align-items: center; gap: 8px; padding: 6px 14px; border-radius: 999px;
      border: 1px solid var(--v2-border); font-size: .82rem; color: var(--v2-text-muted); }
.st.on { border-color: var(--v2-primary); color: var(--v2-primary); background: var(--v2-primary-soft); }
.st b { display: inline-flex; width: 20px; height: 20px; align-items: center; justify-content: center;
        border-radius: 50%; background: var(--v2-primary-soft); color: var(--v2-primary); font-size: .72rem; }
.st.on b { background: var(--v2-primary); color: #fff; }
.card { border: 1px solid var(--v2-border); border-radius: 12px; padding: 16px; background: var(--v2-surface, #fff); }
.card h3 { margin: 0 0 4px; font-size: 1rem; }
.note { margin: 4px 0 10px; font-size: .8rem; color: var(--v2-text-muted); line-height: 1.7; }
.tbl-wrap { overflow-x: auto; }
.tbl { width: 100%; border-collapse: collapse; font-size: .84rem; min-width: 720px; }
.tbl th { text-align: left; font-weight: 600; padding: 8px 10px; border-bottom: 1px solid var(--v2-border);
          color: var(--v2-text-muted); font-size: .76rem; white-space: nowrap; }
.tbl td { padding: 8px 10px; border-bottom: 1px solid var(--v2-border); vertical-align: middle; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.sm { font-size: .78rem; }
.up { text-transform: uppercase; font-size: .74rem; letter-spacing: .03em; }
.rank { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: .68rem;
        background: var(--v2-border); letter-spacing: .04em; white-space: nowrap; }
.rank.primary { background: var(--v2-primary); color: #fff; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
.dot.ok { background: var(--v2-success, #16a34a); }
.dot.bad { background: var(--v2-danger, #dc2626); }
.rec { border-left: 3px solid var(--v2-primary); }
.rec-title { font-size: 1.02rem; font-weight: 600; color: var(--v2-primary); margin: 6px 0 8px; }
.why { margin: 0; padding-left: 20px; font-size: .85rem; line-height: 1.8; }
.rejected { margin-top: 12px; padding: 10px 12px; border-radius: 8px; background: var(--v2-bg-soft, #f8fafc); font-size: .82rem; }
.rejected ul { margin: 6px 0 0; padding-left: 20px; line-height: 1.75; }
.steps { margin: 8px 0 14px; padding-left: 22px; display: grid; gap: 10px; }
.steps li { padding-left: 4px; }
.s-title { font-weight: 600; font-size: .86rem; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.risk { font-size: .66rem; padding: 1px 7px; border-radius: 999px; margin-left: 6px;
        background: var(--v2-border); text-transform: uppercase; font-family: inherit; }
.r-high .risk { background: var(--v2-danger, #dc2626); color: #fff; }
.r-medium .risk { background: #f59e0b; color: #fff; }
.s-why { font-size: .8rem; color: var(--v2-text-muted); margin: 3px 0 4px; line-height: 1.7; }
.s-cmd { font-size: .72rem; background: var(--v2-bg-soft, #f8fafc); padding: 2px 6px; border-radius: 4px; }
.actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.v2-field.inline { display: flex; align-items: center; gap: 10px; margin-top: 12px; font-size: .84rem; }
.v2-input.sm { width: 96px; }
.raw { margin-top: 12px; font-size: .8rem; }
.raw pre { background: var(--v2-bg-soft, #f8fafc); padding: 12px; border-radius: 8px;
           overflow-x: auto; font-size: .74rem; line-height: 1.6; }
.line { padding: 3px 0; border-bottom: 1px dashed var(--v2-border); }
.ph { display: inline-block; min-width: 74px; font-size: .7rem; color: var(--v2-primary); text-transform: uppercase; }
.checks { display: grid; gap: 6px; margin: 10px 0; }
.chk { display: flex; align-items: center; gap: 10px; font-size: .84rem; }
code { background: var(--v2-primary-soft); padding: 1px 5px; border-radius: 4px;
       font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }
</style>
