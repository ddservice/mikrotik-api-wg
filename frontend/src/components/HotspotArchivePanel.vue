<script setup>
/**
 * ผู้ใช้ Hotspot ที่ถูกลบ + การตั้งค่าลบคูปองหมดอายุอัตโนมัติ
 *
 * ทำไมต้องมี: คูปองที่หมดอายุถูกลบออกจากเราท์เตอร์อัตโนมัติ ถ้าลบผิดคนหรือ
 * ลูกค้ามาต่ออายุทีหลัง ต้องสร้างใหม่ทั้งหมดด้วยมือ — หน้านี้ให้กดกู้คืนกลับเข้า
 * เราท์เตอร์ได้ในคลิกเดียว พร้อมรหัสผ่านและโปรไฟล์เดิม
 *
 * ตัวสวิตช์ลบอัตโนมัติอยู่ที่นี่ด้วย เพราะเป็นต้นทางของรายการในตารางนี้
 * คนที่มาดูว่า "ทำไมคูปองหาย" ควรเห็นทั้งสองอย่างในหน้าเดียว
 */
import { ref, onMounted } from 'vue';
import { apiFetch } from '../api.js';
import { toast } from '../toast.js';

const rows = ref([]);
const total = ref(0);
const loading = ref(false);
const busy = ref('');
const search = ref('');
const cleanup = ref({ autoCleanupExpired: false });

async function load() {
    loading.value = true;
    try {
        const q = search.value.trim() ? '?search=' + encodeURIComponent(search.value.trim()) : '';
        const r = await apiFetch('/api/mikrotik/hotspot/archived-users' + q);
        rows.value = r.users || [];
        total.value = r.total || 0;
    } catch (err) {
        toast.error('โหลดรายการไม่สำเร็จ: ' + err.message);
    } finally {
        loading.value = false;
    }
}

async function loadCleanup() {
    try {
        cleanup.value = await apiFetch('/api/mikrotik/hotspot/cleanup-config');
    } catch (_) { /* ไม่ใช่เรื่องคอขาดบาดตาย ปล่อยเป็นค่าเริ่มต้น */ }
}

async function toggleCleanup(enabled) {
    // ปิดแล้วคูปองหมดอายุจะค้างอยู่ในเราท์เตอร์เรื่อย ๆ ซึ่งอาจตั้งใจก็ได้
    // แต่เปิดแล้วมันลบของจริง จึงถามตอนเปิด ไม่ถามตอนปิด
    if (enabled && !window.confirm([
        'เปิดการลบคูปองหมดอายุอัตโนมัติ?',
        '',
        'ระบบจะลบคูปองที่ใช้เวลาครบแล้วออกจากเราท์เตอร์เอง',
        'รายการที่ถูกลบจะมาอยู่ในตารางนี้ และกดกู้คืนได้'
    ].join('\n'))) {
        loadCleanup();
        return;
    }
    busy.value = 'cleanup-config';
    try {
        cleanup.value = await apiFetch('/api/mikrotik/hotspot/cleanup-config', {
            method: 'POST',
            body: JSON.stringify({ autoCleanupExpired: enabled })
        });
        toast.success(enabled ? 'เปิดการลบอัตโนมัติแล้ว' : 'ปิดการลบอัตโนมัติแล้ว');
    } catch (err) {
        toast.error(err.message);
        loadCleanup();
    } finally {
        busy.value = '';
    }
}

async function cleanupNow() {
    if (!window.confirm([
        'ลบคูปองที่หมดอายุออกจากเราท์เตอร์เดี๋ยวนี้?',
        '',
        'เฉพาะคูปองที่ใช้เวลาครบแล้วเท่านั้น',
        'รายการที่ถูกลบจะมาอยู่ในตารางนี้ และกู้คืนได้'
    ].join('\n'))) return;

    busy.value = 'cleanup-now';
    try {
        const r = await apiFetch('/api/mikrotik/hotspot/cleanup-expired', { method: 'POST' });
        toast.success(r.deletedCount ? `ลบไป ${r.deletedCount} รายการ` : 'ไม่มีคูปองหมดอายุให้ลบ');
        load();
    } catch (err) {
        toast.error(err.message);
    } finally {
        busy.value = '';
    }
}

async function restore(u) {
    if (!window.confirm(
        `กู้คืน "${u.username}" กลับเข้าเราท์เตอร์?\n\n` +
        `โปรไฟล์: ${u.profile}   เวลาที่ให้: ${u.limitUptime || 'ไม่จำกัด'}\n` +
        'เวลาใช้งานจะเริ่มนับใหม่จากศูนย์'
    )) return;

    busy.value = u.id;
    try {
        await apiFetch(`/api/mikrotik/hotspot/archived-users/${encodeURIComponent(u.id)}/restore`, { method: 'POST' });
        toast.success(`กู้คืน "${u.username}" กลับเข้าเราท์เตอร์แล้ว`);
        load();
    } catch (err) {
        toast.error('กู้คืนไม่สำเร็จ: ' + err.message);
    } finally {
        busy.value = '';
    }
}

async function removeOne(u) {
    if (!window.confirm(`ลบประวัติของ "${u.username}" ออกจากตารางนี้?\n\nหลังลบจะกู้คืนผู้ใช้รายนี้ไม่ได้อีก`)) return;
    busy.value = u.id;
    try {
        await apiFetch(`/api/mikrotik/hotspot/archived-users/${encodeURIComponent(u.id)}`, { method: 'DELETE' });
        toast.success('ลบประวัติแล้ว');
        load();
    } catch (err) {
        toast.error(err.message);
    } finally {
        busy.value = '';
    }
}

async function clearAll() {
    if (!window.confirm([
        `ล้างประวัติทั้งหมด ${total.value} รายการ?`,
        '',
        'หลังล้างจะกู้คืนผู้ใช้เหล่านี้ไม่ได้อีกเลย',
        'การกระทำนี้ย้อนกลับไม่ได้'
    ].join('\n'))) return;

    busy.value = 'clear';
    try {
        await apiFetch('/api/mikrotik/hotspot/archived-users', { method: 'DELETE' });
        toast.success('ล้างประวัติทั้งหมดแล้ว');
        load();
    } catch (err) {
        toast.error(err.message);
    } finally {
        busy.value = '';
    }
}

function when(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return isNaN(d) ? '—' : d.toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
}

const REASONS = {
    expired: 'หมดอายุ',
    manual_delete: 'ลบเอง',
    auto_cleanup: 'ลบอัตโนมัติ'
};

onMounted(() => { load(); loadCleanup(); });
</script>

<template>
    <!-- ต้นทางของรายการในตารางนี้ วางไว้บนสุดเพื่อให้คนที่สงสัยว่า "คูปองหายไปไหน" เห็นทันที -->
    <div class="panel">
        <div class="switchrow">
            <div>
                <div class="strong">ลบคูปองหมดอายุอัตโนมัติ</div>
                <div class="sub">
                    ลบคูปองที่ใช้เวลาครบแล้วออกจากเราท์เตอร์เอง
                    รายการที่ถูกลบจะมาอยู่ในตารางด้านล่างและกู้คืนได้
                </div>
            </div>
            <label class="sw">
                <input
                    type="checkbox" :checked="cleanup.autoCleanupExpired" :disabled="busy === 'cleanup-config'"
                    @change="toggleCleanup($event.target.checked)"
                >
                <span></span>
            </label>
        </div>
        <button type="button" class="v2-btn ghost" :disabled="busy === 'cleanup-now'" @click="cleanupNow">
            <i class="fa-solid" :class="busy === 'cleanup-now' ? 'fa-spinner fa-spin' : 'fa-broom'"></i>
            ลบคูปองหมดอายุเดี๋ยวนี้
        </button>
    </div>

    <div class="bar">
        <input
            v-model="search" class="v2-input" placeholder="ค้นหาชื่อผู้ใช้ / โปรไฟล์ / คอมเมนต์"
            @keyup.enter="load"
        >
        <button type="button" class="v2-btn ghost" :disabled="loading" @click="load">
            <i class="fa-solid" :class="loading ? 'fa-spinner fa-spin' : 'fa-magnifying-glass'"></i> ค้นหา
        </button>
        <span class="count">{{ total.toLocaleString() }} รายการ</span>
        <button
            v-if="total" type="button" class="v2-btn danger sm" :disabled="busy === 'clear'"
            @click="clearAll"
        >
            <i class="fa-solid fa-trash"></i> ล้างทั้งหมด
        </button>
    </div>

    <div v-if="!rows.length && !loading" class="v2-callout ok">
        <i class="fa-solid fa-circle-check"></i>
        <span>ยังไม่มีผู้ใช้ที่ถูกลบ</span>
    </div>

    <div v-else class="tablewrap">
        <table>
            <thead>
                <tr>
                    <th>ชื่อผู้ใช้</th><th>รหัสผ่าน</th><th>โปรไฟล์</th><th>เวลาที่ให้</th>
                    <th>สาขา</th><th>สาเหตุ</th><th>ลบเมื่อ</th><th>โดย</th><th></th>
                </tr>
            </thead>
            <tbody>
                <tr v-for="u in rows" :key="u.id">
                    <td class="mono strong">{{ u.username }}</td>
                    <td class="mono sub">{{ u.password || '—' }}</td>
                    <td>{{ u.profile }}</td>
                    <td class="mono">{{ u.limitUptime || 'ไม่จำกัด' }}</td>
                    <td class="sub">{{ u.siteName || '—' }}</td>
                    <td><span class="badge">{{ REASONS[u.reason] || u.reason }}</span></td>
                    <td class="sub">{{ when(u.deletedAt) }}</td>
                    <td class="sub">{{ u.deletedBy }}</td>
                    <td class="actions">
                        <button
                            type="button" class="v2-btn primary sm" :disabled="busy === u.id"
                            title="สร้างผู้ใช้รายนี้กลับเข้าเราท์เตอร์" @click="restore(u)"
                        >
                            <i class="fa-solid" :class="busy === u.id ? 'fa-spinner fa-spin' : 'fa-rotate-left'"></i> กู้คืน
                        </button>
                        <button
                            type="button" class="v2-btn ghost sm" :disabled="busy === u.id"
                            title="ลบประวัติรายการนี้" @click="removeOne(u)"
                        >
                            <i class="fa-solid fa-xmark"></i>
                        </button>
                    </td>
                </tr>
            </tbody>
        </table>
    </div>
</template>

<style scoped>
.panel { border: 1px solid var(--v2-border); border-radius: 12px; padding: 16px; margin-bottom: 16px; background: var(--v2-surface); }
.switchrow { display: flex; align-items: center; justify-content: space-between; gap: 16px;
             padding-bottom: 14px; margin-bottom: 14px; border-bottom: 1px solid var(--v2-border); }
.strong { font-weight: 600; font-size: .88rem; }
.sub { font-size: .8rem; color: var(--v2-text-muted); }
.sw { position: relative; display: inline-block; width: 44px; height: 24px; flex-shrink: 0; }
.sw input { opacity: 0; width: 0; height: 0; }
.sw span { position: absolute; inset: 0; background: #cbd5e1; border-radius: 999px; cursor: pointer; transition: background .18s ease; }
.sw span::before { content: ''; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px;
                   background: #fff; border-radius: 50%; transition: transform .18s ease; }
.sw input:checked + span { background: var(--v2-primary); }
.sw input:checked + span::before { transform: translateX(20px); }
.sw input:focus-visible + span { outline: 2px solid var(--v2-primary); outline-offset: 2px; }
.bar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.bar .v2-input { max-width: 320px; }
.count { font-size: .82rem; color: var(--v2-text-muted); }
.tablewrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: .84rem; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--v2-border); white-space: nowrap; }
th { font-weight: 600; font-size: .78rem; color: var(--v2-text-muted); }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.actions { display: flex; gap: 6px; }
.badge { display: inline-block; font-size: .72rem; padding: 1px 8px; border-radius: 999px;
         border: 1px solid var(--v2-border); color: var(--v2-text-muted); }
</style>
