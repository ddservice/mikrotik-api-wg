<script setup>
/**
 * ตารางอินเทอร์เฟซ + กราฟ traffic แบบเรียลไทม์
 *
 * ความเร็วไม่ได้มาจากเราท์เตอร์ตรง ๆ — /interface/print ให้ตัวนับสะสม (rx-byte/tx-byte)
 * เท่านั้น จึงต้องคิดเองจากผลต่างของตัวนับหารด้วยเวลาที่ผ่านไปจริงระหว่างสองครั้งที่อ่าน
 * (ไม่ใช่ค่าคาบเวลาที่ตั้งไว้ เพราะ timer ของเบราว์เซอร์เลื่อนได้ และแท็บที่ถูกพักไว้
 * จะยิงห่างกว่าที่ตั้งมาก ถ้าหารด้วยค่าคงที่จะได้ความเร็วสูงเกินจริงหลายเท่า)
 *
 * วาดด้วย SVG ไม่ใช่ canvas: ปรับขนาดตามความกว้างจอได้เอง คมบนจอความละเอียดสูง
 * และไม่ต้องจัดการขนาดพิกเซลเองเหมือนของเดิม
 */
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { apiFetch, activeSiteId } from '../api.js';
import { formatBytes } from '../format.js';

const POINTS = 30;          // เท่าหน้าเดิม — ที่ 5 วิ/จุด = ย้อนหลังราว 2 นาทีครึ่ง
const PERIOD_MS = 5000;

/**
 * เลือกพอร์ตตั้งต้นให้ตรงกับสิ่งที่คนเปิดหน้านี้อยากดูจริง
 *
 * คนเปิดกราฟ traffic เพื่อดู "เน็ตขาออกตอนนี้เป็นยังไง" ซึ่งคือขา WAN
 * ทุกสาขาต่อออกผ่าน PPPoE จึงเริ่มที่ pppoe-out ก่อน แล้วค่อยไล่ลงมา
 * ของเดิมเลือก ether ตัวแรกที่เจอ ซึ่งมักเป็นขา LAN หรือขาที่ไม่ได้ใช้
 * เปิดมาแล้วกราฟนิ่งเป็นศูนย์ ทั้งที่เน็ตใช้งานอยู่
 */
function pickDefaultInterface(list) {
    const enabled = list.filter((i) => !i.disabled);
    const name = (i) => String(i.name || '').toLowerCase();
    const find = (pred) => enabled.find(pred);

    const pick =
        // ขา WAN จริง เรียงจากที่เจาะจงที่สุดก่อน
        find((i) => name(i).startsWith('pppoe-out')) ||
        find((i) => name(i).startsWith('pppoe')) ||
        find((i) => String(i.type || '').toLowerCase().includes('pppoe')) ||
        // ไม่มี PPPoE (สาขาที่ต่อผ่าน DHCP/IP นิ่ง) — เอาขาที่ลิงก์ขึ้นอยู่ก่อน
        find((i) => name(i).startsWith('ether') && i.running) ||
        find((i) => name(i).startsWith('ether')) ||
        enabled[0] ||
        list[0];

    return (pick && pick.name) || '';
}

const interfaces = ref([]);
const selected = ref('');
const error = ref('');
const loading = ref(false);

const rxHist = ref(Array(POINTS).fill(0));
const txHist = ref(Array(POINTS).fill(0));
let last = { rx: 0, tx: 0, time: 0 };
let timer = null;

function resetHistory() {
    rxHist.value = Array(POINTS).fill(0);
    txHist.value = Array(POINTS).fill(0);
    last = { rx: 0, tx: 0, time: 0 };
}

async function load() {
    loading.value = true;
    try {
        const list = await apiFetch('/api/mikrotik/interfaces');
        interfaces.value = Array.isArray(list) ? list : [];
        error.value = '';

        if (!selected.value || !interfaces.value.some((i) => i.name === selected.value)) {
            selected.value = pickDefaultInterface(interfaces.value);
            resetHistory();
        }

        const cur = interfaces.value.find((i) => i.name === selected.value);
        if (!cur) return;

        const now = Date.now();
        if (last.time) {
            const secs = (now - last.time) / 1000;
            // ตัวนับถูกรีเซ็ตตอนเราท์เตอร์รีบูตหรือตอนสลับอินเทอร์เฟซ -> ผลต่างติดลบ ให้นับเป็น 0
            const rx = Math.max(0, cur.rxByte - last.rx);
            const tx = Math.max(0, cur.txByte - last.tx);
            rxHist.value = rxHist.value.slice(1).concat(Math.round((rx * 8) / secs));
            txHist.value = txHist.value.slice(1).concat(Math.round((tx * 8) / secs));
        }
        last = { rx: cur.rxByte, tx: cur.txByte, time: now };
    } catch (err) {
        error.value = err.message;
    } finally {
        loading.value = false;
    }
}

onMounted(() => {
    load();
    timer = setInterval(load, PERIOD_MS);
});
onUnmounted(() => { if (timer) clearInterval(timer); });

watch(activeSiteId, () => {
    interfaces.value = [];
    selected.value = '';
    resetHistory();
    load();
});

watch(selected, resetHistory);

function fmtBps(bps) {
    if (!bps) return '0 bps';
    if (bps >= 1e9) return (bps / 1e9).toFixed(2) + ' Gbps';
    if (bps >= 1e6) return (bps / 1e6).toFixed(2) + ' Mbps';
    if (bps >= 1e3) return (bps / 1e3).toFixed(1) + ' Kbps';
    return bps + ' bps';
}

// แกน Y ขยายตามค่าสูงสุดที่เห็น แต่ไม่ต่ำกว่า 1 Mbps — ไม่งั้นตอนไม่มี traffic
// สัญญาณรบกวนไม่กี่ไบต์จะถูกขยายจนดูเหมือนใช้งานหนัก
const peak = computed(() => Math.max(...rxHist.value, ...txHist.value, 1e6));

const W = 600;
const H = 160;

function areaPath(hist) {
    const step = W / (POINTS - 1);
    const pts = hist.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / peak.value) * H).toFixed(1)}`);
    return `M0,${H} L${pts.join(' L')} L${W},${H} Z`;
}

function linePath(hist) {
    const step = W / (POINTS - 1);
    return 'M' + hist.map((v, i) => `${(i * step).toFixed(1)},${(H - (v / peak.value) * H).toFixed(1)}`).join(' L');
}

const curRx = computed(() => rxHist.value[POINTS - 1] || 0);
const curTx = computed(() => txHist.value[POINTS - 1] || 0);
</script>

<template>
    <div class="panel">
        <div class="phead">
            <h3><i class="fa-solid fa-chart-area"></i> Traffic รายพอร์ตแบบเรียลไทม์</h3>
            <select v-model="selected" class="sel">
                <option v-if="!interfaces.length" value="">— กำลังโหลด —</option>
                <option v-for="i in interfaces.filter((x) => !x.disabled)" :key="i.id" :value="i.name">
                    {{ i.name }} ({{ i.type }})
                </option>
            </select>
        </div>

        <div v-if="error" class="err"><i class="fa-solid fa-triangle-exclamation"></i> {{ error }}</div>

        <div class="chartwrap">
            <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="chart">
                <line v-for="n in 3" :key="n" x1="0" :y1="(H / 4) * n" :x2="W" :y2="(H / 4) * n" class="grid" />
                <path :d="areaPath(rxHist)" class="a-dl" />
                <path :d="linePath(rxHist)" class="l-dl" />
                <path :d="areaPath(txHist)" class="a-ul" />
                <path :d="linePath(txHist)" class="l-ul" />
            </svg>
            <div class="peak v2-num">สูงสุดในกราฟ {{ fmtBps(peak) }}</div>
        </div>

        <div class="legend">
            <span><i class="sw dl"></i> ดาวน์โหลด <b class="v2-num">{{ fmtBps(curRx) }}</b></span>
            <span><i class="sw ul"></i> อัปโหลด <b class="v2-num">{{ fmtBps(curTx) }}</b></span>
            <span class="note">อัปเดตทุก {{ PERIOD_MS / 1000 }} วินาที · คิดจากผลต่างตัวนับของเราท์เตอร์</span>
        </div>

        <div class="tablewrap">
            <table>
                <thead>
                    <tr>
                        <th>อินเทอร์เฟซ</th><th>ชนิด</th><th>สถานะ</th>
                        <th class="r">รับสะสม</th><th class="r">ส่งสะสม</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-if="!interfaces.length">
                        <td colspan="5" class="empty">{{ loading ? 'กำลังโหลด...' : 'อ่านรายการอินเทอร์เฟซไม่ได้' }}</td>
                    </tr>
                    <tr v-for="i in interfaces" :key="i.id" :class="{ sel: i.name === selected }">
                        <td>
                            <div class="strong">{{ i.name }}</div>
                            <div v-if="i.comment" class="sub">{{ i.comment }}</div>
                        </td>
                        <td class="sub">{{ i.type }}</td>
                        <td>
                            <span class="badge" :class="i.disabled ? 'b-off' : (i.running ? 'b-ok' : 'b-warn')">
                                {{ i.disabled ? 'ปิดอยู่' : (i.running ? 'เชื่อมต่อแล้ว' : 'ไม่มีสัญญาณ') }}
                            </span>
                        </td>
                        <td class="r v2-num">{{ formatBytes(i.rxByte) }}</td>
                        <td class="r v2-num">{{ formatBytes(i.txByte) }}</td>
                    </tr>
                </tbody>
            </table>
        </div>
    </div>
</template>

<style scoped>
.panel {
    margin-top: 18px; background: var(--v2-surface); border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius); box-shadow: var(--v2-shadow); overflow: hidden;
}
.phead { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--v2-border); flex-wrap: wrap; }
.phead h3 { margin: 0; font-size: .95rem; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.phead h3 i { color: var(--v2-primary); }
.sel {
    margin-left: auto; font: inherit; font-size: .82rem; padding: 7px 11px; border-radius: 9px;
    border: 1px solid var(--v2-border); background: var(--v2-surface); color: var(--v2-text); cursor: pointer;
}
.err { padding: 10px 16px; background: var(--v2-danger-soft); color: var(--v2-danger); font-size: .82rem; }

.chartwrap { position: relative; padding: 14px 16px 0; }
.chart { width: 100%; height: 170px; display: block; }
.grid { stroke: rgba(15, 23, 42, .07); stroke-width: 1; }
.a-dl { fill: rgba(37, 99, 235, .16); }
.l-dl { fill: none; stroke: #2563eb; stroke-width: 1.6; vector-effect: non-scaling-stroke; }
.a-ul { fill: rgba(22, 163, 74, .14); }
.l-ul { fill: none; stroke: #16a34a; stroke-width: 1.6; vector-effect: non-scaling-stroke; }
.peak { position: absolute; top: 16px; right: 20px; font-size: .72rem; color: var(--v2-text-muted); }

.legend { display: flex; align-items: center; gap: 18px; padding: 8px 16px 14px; font-size: .8rem; flex-wrap: wrap; }
.legend .sw { width: 10px; height: 10px; border-radius: 3px; display: inline-block; margin-right: 6px; }
.legend .dl { background: #2563eb; }
.legend .ul { background: #16a34a; }
.legend b { margin-left: 4px; }
.legend .note { margin-left: auto; color: var(--v2-text-muted); font-size: .74rem; }

.tablewrap { overflow-x: auto; border-top: 1px solid var(--v2-border); }
table { width: 100%; border-collapse: collapse; font-size: .84rem; }
th { text-align: left; font-weight: 600; font-size: .74rem; color: var(--v2-text-muted);
     padding: 10px 16px; border-bottom: 1px solid var(--v2-border); background: #fbfcfe; white-space: nowrap; }
td { padding: 9px 16px; border-bottom: 1px solid #f1f5f9; }
tbody tr:last-child td { border-bottom: none; }
tbody tr.sel td { background: var(--v2-primary-soft); }
.r, th.r { text-align: right; }
.strong { font-weight: 600; }
.sub { font-size: .74rem; color: var(--v2-text-muted); }
.empty { text-align: center; color: var(--v2-text-muted); padding: 26px 14px; }
.badge { font-size: .71rem; font-weight: 600; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
.b-ok { background: var(--v2-success-soft); color: var(--v2-success); }
.b-warn { background: var(--v2-warn-soft); color: var(--v2-warn); }
.b-off { background: #eef2f7; color: var(--v2-text-muted); }
</style>
