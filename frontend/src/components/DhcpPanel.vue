<script setup>
/**
 * DHCP lease — ตอบคำถามที่ต้องเปิด WinBox บ่อยที่สุด
 *
 *   "เครื่องนี้ได้ IP อะไร" · "IP นี้ใครถืออยู่" · "จองให้มันถาวรหน่อย"
 *
 * ทั้งหมดเป็นการอ่านกับคำสั่งสั้น ๆ ที่ไม่แตะเส้นทาง traffic จึงปลอดภัยพอที่จะมีปุ่มได้
 * ต่างจากงานอย่าง Multi-WAN ที่ต้องให้คนตัดสินใจเอง
 */
import { ref, computed, onMounted, watch } from 'vue';
import { apiFetch, activeSiteId } from '../api.js';
import { toast } from '../toast.js';

const data = ref(null);
const loading = ref(false);
const error = ref('');
const busy = ref('');
const search = ref('');
const filter = ref('all');       // all | bound | static | dynamic
const expanded = ref(false);
const COLLAPSED_ROWS = 8;

async function load() {
    loading.value = true;
    error.value = '';
    try {
        data.value = await apiFetch('/api/mikrotik/dhcp/leases');
    } catch (err) {
        error.value = err.message;
        data.value = null;
    } finally {
        loading.value = false;
    }
}

onMounted(load);
watch(activeSiteId, () => { data.value = null; load(); });

const leases = computed(() => {
    const all = (data.value && data.value.leases) || [];
    const q = search.value.trim().toLowerCase();
    return all.filter((l) => {
        if (filter.value === 'static' && l.dynamic) return false;
        if (filter.value === 'dynamic' && !l.dynamic) return false;
        if (filter.value === 'bound' && String(l.status).toLowerCase() !== 'bound') return false;
        if (!q) return true;
        return [l.address, l.macAddress, l.hostName, l.comment]
            .some((f) => String(f || '').toLowerCase().includes(q));
    });
});

// เรียงตามเลขท้ายของ IP ไม่ใช่ตามตัวอักษร — ไม่งั้น .101 จะมาก่อน .50
const sorted = computed(() => leases.value.slice().sort((a, b) => {
    const n = (ip) => String(ip || '').split('.').reduce((acc, p) => acc * 256 + (parseInt(p, 10) || 0), 0);
    return n(a.address) - n(b.address);
}));

// แสดงบางส่วนก่อน — หน้า Overview มีหลายส่วนซ้อนกัน ตารางยาว ๆ ดันของอื่นตกจอ
const visible = computed(() => expanded.value ? sorted.value : sorted.value.slice(0, COLLAPSED_ROWS));
const hiddenCount = computed(() => Math.max(0, sorted.value.length - COLLAPSED_ROWS));

const counts = computed(() => {
    const all = (data.value && data.value.leases) || [];
    return {
        all: all.length,
        bound: all.filter((l) => String(l.status).toLowerCase() === 'bound').length,
        static: all.filter((l) => !l.dynamic).length,
        dynamic: all.filter((l) => l.dynamic).length
    };
});

async function makeStatic(l) {
    if (!window.confirm([
        `ตั้ง ${l.address} เป็น Static ให้เครื่องนี้?`,
        '',
        `MAC: ${l.macAddress}`,
        l.hostName ? `ชื่อเครื่อง: ${l.hostName}` : '',
        '',
        'เครื่องนี้จะได้ IP เดิมทุกครั้งที่ต่อเข้ามา และ IP นี้จะไม่ถูกแจกให้เครื่องอื่น'
    ].filter(Boolean).join('\n'))) return;

    busy.value = l.id;
    try {
        await apiFetch(`/api/mikrotik/dhcp/leases/${encodeURIComponent(l.id)}/make-static`, {
            method: 'POST',
            body: JSON.stringify({ comment: l.hostName || '' })
        });
        toast.success(`ตั้ง ${l.address} เป็น Static แล้ว`);
        await load();
    } catch (err) {
        toast.error('ตั้ง Static ไม่สำเร็จ: ' + err.message);
    } finally {
        busy.value = '';
    }
}

async function removeLease(l) {
    // lease ที่เราท์เตอร์แจกเองจะกลับมาใหม่เองเมื่อเครื่องต่อเข้ามา
    // แต่ที่จองถาวรไว้ ลบแล้วหายเลย ต้องบอกให้ต่างกัน
    const msg = l.dynamic
        ? [`ลบ lease ของ ${l.address}?`, '', 'เครื่องนี้จะขอ IP ใหม่เมื่อเชื่อมต่อครั้งถัดไป (อาจได้เลขอื่น)']
        : [`ลบ Static lease ของ ${l.address}?`, '', 'IP นี้จะกลับเข้ากองให้เครื่องอื่นใช้ได้',
           'และเครื่องเดิมจะไม่ได้ IP นี้อีกโดยอัตโนมัติ'];
    if (!window.confirm(msg.join('\n'))) return;

    busy.value = l.id;
    try {
        await apiFetch('/api/mikrotik/dhcp/leases/' + encodeURIComponent(l.id), { method: 'DELETE' });
        toast.success(`ลบ lease ${l.address} แล้ว`);
        await load();
    } catch (err) {
        toast.error('ลบไม่สำเร็จ: ' + err.message);
    } finally {
        busy.value = '';
    }
}
</script>

<template>
    <div class="panel">
        <div class="phead">
            <h3><i class="fa-solid fa-network-wired"></i> DHCP — เครื่องที่ได้รับ IP</h3>
            <button type="button" class="v2-btn ghost sm" :disabled="loading" @click="load">
                <i class="fa-solid" :class="loading ? 'fa-spinner fa-spin' : 'fa-rotate'"></i> รีเฟรช
            </button>
        </div>

        <div v-if="error" class="err"><i class="fa-solid fa-triangle-exclamation"></i> {{ error }}</div>

        <template v-if="data">
            <div class="bar">
                <div class="pills">
                    <button
                        v-for="f in [
                            { k: 'all', t: 'ทั้งหมด', n: counts.all },
                            { k: 'bound', t: 'ใช้งานอยู่', n: counts.bound },
                            { k: 'static', t: 'Static', n: counts.static },
                            { k: 'dynamic', t: 'DHCP', n: counts.dynamic }
                        ]"
                        :key="f.k" type="button" class="pill" :class="{ on: filter === f.k }"
                        @click="filter = f.k"
                    >{{ f.t }} <span class="v2-num">{{ f.n }}</span></button>
                </div>
                <input v-model="search" class="v2-input" placeholder="ค้นหา IP, MAC, ชื่อเครื่อง...">
            </div>

            <div v-if="data.servers.length" class="srvline sub">
                <i class="fa-solid fa-server"></i>
                <span v-for="s in data.servers" :key="s.name">
                    {{ s.name }} · {{ s.interface }} · pool {{ s.addressPool }} · lease {{ s.leaseTime }}
                </span>
            </div>

            <div class="tablewrap">
                <table>
                    <thead>
                        <tr>
                            <th>IP Address</th><th>MAC Address</th><th>Host name</th>
                            <th>ชนิด lease</th><th>สถานะ</th><th>Last seen</th><th class="right">จัดการ</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr v-if="!sorted.length">
                            <td colspan="7" class="empty">
                                {{ loading ? 'กำลังโหลด...' : 'ไม่พบรายการที่ตรงกับเงื่อนไข' }}
                            </td>
                        </tr>
                        <tr v-for="l in visible" :key="l.id">
                            <td class="strong v2-num">{{ l.address }}</td>
                            <td class="mono v2-num">{{ l.macAddress || '—' }}</td>
                            <td>
                                {{ l.hostName || '—' }}
                                <div v-if="l.comment" class="sub">{{ l.comment }}</div>
                            </td>
                            <td>
                                <span class="badge" :class="l.dynamic ? 'b-dyn' : 'b-static'">
                                    {{ l.dynamic ? 'DHCP' : 'Static' }}
                                </span>
                            </td>
                            <td>
                                <span class="badge" :class="String(l.status).toLowerCase() === 'bound' ? 'b-ok' : 'b-muted'">
                                    {{ l.status || '—' }}
                                </span>
                            </td>
                            <td class="sub v2-num">
                                {{ l.lastSeen || '—' }}
                                <div v-if="l.expiresAfter" class="sub">หมดอายุใน {{ l.expiresAfter }}</div>
                            </td>
                            <td class="right">
                                <div class="rowbtns">
                                    <button
                                        v-if="l.dynamic" type="button" class="v2-btn ghost sm"
                                        title="ให้เครื่องนี้ได้ IP เดิมทุกครั้ง (make static)"
                                        :disabled="busy === l.id" @click="makeStatic(l)"
                                    >
                                        <i class="fa-solid" :class="busy === l.id ? 'fa-spinner fa-spin' : 'fa-thumbtack'"></i> ตั้งเป็น Static
                                    </button>
                                    <button
                                        type="button" class="v2-btn danger sm" title="ลบ lease"
                                        :disabled="busy === l.id" @click="removeLease(l)"
                                    >
                                        <i class="fa-solid fa-trash"></i>
                                    </button>
                                </div>
                            </td>
                        </tr>
                    </tbody>
                </table>
            </div>

            <button v-if="hiddenCount && !expanded" type="button" class="more" @click="expanded = true">
                ดูอีก {{ hiddenCount }} รายการ <i class="fa-solid fa-chevron-down"></i>
            </button>
            <button v-else-if="expanded && hiddenCount" type="button" class="more" @click="expanded = false">
                ย่อลง <i class="fa-solid fa-chevron-up"></i>
            </button>
        </template>
    </div>
</template>

<style scoped>
.panel {
    margin-top: 18px; background: var(--v2-surface); border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius); box-shadow: var(--v2-shadow); overflow: hidden;
}
.phead { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--v2-border); }
.phead h3 { margin: 0; font-size: .95rem; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.phead h3 i { color: var(--v2-primary); }
.phead button { margin-left: auto; }
.err { padding: 10px 16px; background: var(--v2-danger-soft); color: var(--v2-danger); font-size: .82rem; }

.chips { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 16px 0; }
.chip {
    font-size: .76rem; padding: 4px 11px; border-radius: 999px;
    background: var(--v2-bg); border: 1px solid var(--v2-border); color: var(--v2-text-soft);
}
.chip.ok { background: var(--v2-success-soft); border-color: #bbf7d0; color: var(--v2-success); }
.chip.srv { background: var(--v2-primary-soft); border-color: #bfdbfe; color: var(--v2-primary); }

.bar { display: flex; align-items: center; gap: 12px; padding: 12px 16px; flex-wrap: wrap; }
.bar .v2-input { flex: 1; min-width: 180px; max-width: 320px; margin-left: auto; }
.pills { display: flex; gap: 5px; flex-wrap: wrap; }
.pill {
    font: inherit; font-size: .77rem; font-weight: 600; padding: 6px 12px; border-radius: 999px;
    border: 1px solid var(--v2-border); background: var(--v2-surface); color: var(--v2-text-soft); cursor: pointer;
}
.pill.on { background: var(--v2-primary); border-color: var(--v2-primary); color: #fff; }
.pill span { opacity: .7; margin-left: 3px; }
.srvline { display: flex; gap: 14px; flex-wrap: wrap; padding: 0 16px 10px; }
.srvline i { color: var(--v2-text-muted); }
.more {
    width: 100%; font: inherit; font-size: .8rem; font-weight: 600; color: var(--v2-primary);
    background: var(--v2-bg); border: none; border-top: 1px solid var(--v2-border);
    padding: 10px; cursor: pointer;
}
.more:hover { background: var(--v2-primary-soft); }

.tablewrap { overflow-x: auto; border-top: 1px solid var(--v2-border); }
table { width: 100%; border-collapse: collapse; font-size: .84rem; }
th {
    text-align: left; font-weight: 600; font-size: .74rem; color: var(--v2-text-muted);
    padding: 10px 16px; border-bottom: 1px solid var(--v2-border); background: #fbfcfe; white-space: nowrap;
}
td { padding: 9px 16px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
tbody tr:last-child td { border-bottom: none; }
.right, th.right { text-align: right; }
.rowbtns { display: flex; gap: 6px; justify-content: flex-end; }
.strong { font-weight: 600; }
.sub { font-size: .74rem; color: var(--v2-text-muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem; }
.empty { text-align: center; color: var(--v2-text-muted); padding: 26px 14px; }
.badge { font-size: .71rem; font-weight: 600; padding: 3px 9px; border-radius: 999px; white-space: nowrap; }
.b-ok { background: var(--v2-success-soft); color: var(--v2-success); }
.b-muted { background: #eef2f7; color: var(--v2-text-muted); }
.b-static { background: var(--v2-primary-soft); color: var(--v2-primary); }
.b-dyn { background: #eef2f7; color: var(--v2-text-muted); }
</style>
