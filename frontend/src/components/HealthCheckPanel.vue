<script setup>
/**
 * ตรวจสุขภาพเราท์เตอร์ปุ่มเดียว
 *
 * รวมทุกอย่างที่ระบบรู้ให้จบในคำขอเดียว แล้วสรุปว่า "เจออะไร แปลว่าอะไร ทำอะไรต่อ"
 * แทนที่จะให้คนไปเปิดดูทีละหน้า (CPU/RAM หน้าหนึ่ง, log อีกหน้า, DHCP อีกหน้า)
 * แล้วประกอบภาพเอง ซึ่งต้องรู้อยู่แล้วว่าต้องดูอะไรถึงจะทำได้
 *
 * เป็นการอ่านล้วน ไม่แก้ค่าอะไรบนเราท์เตอร์ จึงกดได้โดยไม่ต้องกลัว
 * จงใจไม่มีปุ่ม "แก้ให้อัตโนมัติ" — เราท์เตอร์แต่ละตัวมีของที่เราไม่รู้เสมอ
 */
import { ref, watch } from 'vue';
import { apiFetch, activeSiteId } from '../api.js';

const result = ref(null);
const loading = ref(false);
const error = ref('');

async function run() {
    loading.value = true;
    error.value = '';
    result.value = null;
    try {
        result.value = await apiFetch('/api/mikrotik/health-check');
    } catch (err) {
        error.value = err.message;
    } finally {
        loading.value = false;
    }
}

// สลับสาขาแล้วผลเก่าใช้ไม่ได้ ต้องล้างทิ้ง ไม่ใช่ปล่อยให้เข้าใจผิดว่าเป็นของสาขาใหม่
watch(activeSiteId, () => { result.value = null; error.value = ''; });

const ICON = { critical: 'fa-circle-exclamation', warning: 'fa-triangle-exclamation' };
</script>

<template>
    <div class="panel">
        <div class="phead">
            <div>
                <h3><i class="fa-solid fa-stethoscope"></i> ตรวจสุขภาพเราท์เตอร์</h3>
                <p class="sub">
                    ตรวจ CPU · หน่วยความจำ · พื้นที่ · อุณหภูมิ · log ที่เราท์เตอร์บันทึกไว้ ·
                    พอร์ตที่หลุด · DHCP — จบในปุ่มเดียว และไม่แก้ค่าอะไรบนเราท์เตอร์
                </p>
            </div>
            <button type="button" class="v2-btn primary" :disabled="loading" @click="run">
                <i class="fa-solid" :class="loading ? 'fa-spinner fa-spin' : 'fa-play'"></i>
                {{ loading ? 'กำลังตรวจ...' : 'ตรวจเลย' }}
            </button>
        </div>

        <div v-if="error" class="err"><i class="fa-solid fa-circle-xmark"></i> {{ error }}</div>

        <div v-else-if="result" class="body">
            <div class="chips">
                <span class="chip">{{ result.router.boardName || 'ไม่ทราบรุ่น' }}</span>
                <span class="chip">RouterOS {{ result.router.version || '—' }}</span>
                <span class="chip">CPU <b class="v2-num">{{ result.router.cpuLoad }}%</b></span>
                <span class="chip">
                    RAM <b class="v2-num">{{ result.router.freeMemoryMb }}</b> / {{ result.router.totalMemoryMb }} MB
                </span>
                <span v-if="result.router.temperature" class="chip">
                    <b class="v2-num">{{ result.router.temperature }}</b>°C
                </span>
                <span class="chip">อ่าน log <b class="v2-num">{{ result.logSummary.total }}</b> บรรทัด</span>
            </div>

            <div v-if="result.healthy" class="v2-callout ok verdict">
                <i class="fa-solid fa-circle-check"></i>
                <span><strong>ไม่พบปัญหา</strong> — ทุกอย่างที่ตรวจได้อยู่ในเกณฑ์ปกติ</span>
            </div>

            <div v-else class="v2-callout" :class="result.counts.critical ? 'danger' : 'warn'">
                <i class="fa-solid fa-clipboard-list"></i>
                <span>
                    พบ <strong>{{ result.findings.length }} เรื่อง</strong>
                    <template v-if="result.counts.critical">
                        — ร้ายแรง {{ result.counts.critical }}
                    </template>
                    <template v-if="result.counts.warning">
                        · ควรดู {{ result.counts.warning }}
                    </template>
                    <br>เรียงจากเรื่องที่ควรจัดการก่อน
                </span>
            </div>

            <ol v-if="!result.healthy" class="findings">
                <li v-for="(f, i) in result.findings" :key="i" :class="f.severity">
                    <div class="ftop">
                        <i class="fa-solid" :class="ICON[f.severity] || 'fa-circle-info'"></i>
                        <b>{{ f.title }}</b>
                        <span class="sev" :class="f.severity">
                            {{ f.severity === 'critical' ? 'ร้ายแรง' : 'ควรดู' }}
                        </span>
                    </div>
                    <div class="fdetail">{{ f.detail }}</div>
                    <div class="faction"><i class="fa-solid fa-wrench"></i> {{ f.action }}</div>
                </li>
            </ol>

            <p class="stamp sub">
                ตรวจเมื่อ {{ new Date(result.checkedAt).toLocaleString('th-TH') }}
            </p>
        </div>

        <div v-else class="body">
            <div class="v2-callout info">
                <i class="fa-solid fa-circle-info"></i>
                <span>กด <strong>ตรวจเลย</strong> เพื่อเริ่ม — ใช้เวลาไม่กี่วินาที และไม่เปลี่ยนค่าอะไรบนเราท์เตอร์</span>
            </div>
        </div>
    </div>
</template>

<style scoped>
.panel {
    margin-top: 18px; background: var(--v2-surface); border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius); box-shadow: var(--v2-shadow); overflow: hidden;
}
.phead { display: flex; align-items: flex-start; gap: 14px; padding: 14px 16px; border-bottom: 1px solid var(--v2-border); flex-wrap: wrap; }
.phead h3 { margin: 0; font-size: .95rem; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.phead h3 i { color: var(--v2-primary); }
.phead button { margin-left: auto; flex-shrink: 0; }
.sub { margin: 4px 0 0; font-size: .78rem; color: var(--v2-text-muted); line-height: 1.6; max-width: 68ch; }
.err { padding: 11px 16px; background: var(--v2-danger-soft); color: var(--v2-danger); font-size: .84rem; }
.body { padding: 14px 16px 16px; }

.chips { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.chip {
    font-size: .76rem; padding: 4px 11px; border-radius: 999px;
    background: var(--v2-bg); border: 1px solid var(--v2-border); color: var(--v2-text-soft);
}

.verdict { margin: 0; }

.findings { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 10px; }
.findings li {
    border: 1px solid var(--v2-border); border-left-width: 4px;
    border-radius: 10px; padding: 11px 14px; background: var(--v2-surface);
}
.findings li.critical { border-left-color: var(--v2-danger); }
.findings li.warning { border-left-color: var(--v2-warn); }

.ftop { display: flex; align-items: center; gap: 9px; font-size: .89rem; }
.ftop i { font-size: .82rem; }
.findings li.critical .ftop i { color: var(--v2-danger); }
.findings li.warning .ftop i { color: var(--v2-warn); }
.sev {
    margin-left: auto; font-size: .7rem; font-weight: 700; padding: 2px 9px; border-radius: 999px;
}
.sev.critical { background: var(--v2-danger-soft); color: var(--v2-danger); }
.sev.warning { background: var(--v2-warn-soft); color: var(--v2-warn); }

.fdetail { margin-top: 5px; font-size: .81rem; color: var(--v2-text-soft); line-height: 1.65; }
.faction {
    margin-top: 7px; font-size: .81rem; color: var(--v2-primary);
    background: var(--v2-primary-soft); border-radius: 8px; padding: 7px 11px; line-height: 1.6;
}
.faction i { margin-right: 6px; }
.stamp { margin-top: 12px; }
</style>
