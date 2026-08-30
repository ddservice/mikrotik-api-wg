<script setup>
/**
 * ค้นหาทั่วระบบ (Ctrl+K) — ค้นข้ามทุกสาขาพร้อมกัน
 *
 * ปัญหาที่แก้: เวลาลูกค้าโทรมาบอกแค่ชื่อผู้ใช้หรือเลขห้อง แอดมินต้องไล่เปิดทีละสาขา
 * เพื่อหาว่าอยู่สาขาไหน หน้านี้ค้นทุกสาขาในครั้งเดียวแล้วกดกระโดดไปได้เลย
 *
 * ฝั่ง server ต่อเข้าเราท์เตอร์ทุกสาขาเพื่อค้น จึงหน่วงก่อนยิง ไม่ยิงทุกตัวอักษร
 */
import { ref, onMounted, onUnmounted, nextTick } from 'vue';
import { apiFetch, setActiveSiteId } from '../api.js';
import { navigate } from '../router.js';
import BaseModal from './BaseModal.vue';

const open = ref(false);
const q = ref('');
const results = ref([]);
const loading = ref(false);
const searched = ref(false);
const cursor = ref(0);
const inputEl = ref(null);

let debounce = null;
let seq = 0;

function show() {
    open.value = true;
    nextTick(() => inputEl.value && inputEl.value.focus());
}

function close() {
    open.value = false;
    q.value = '';
    results.value = [];
    searched.value = false;
    cursor.value = 0;
}

async function run() {
    const term = q.value.trim();
    if (term.length < 2) {
        results.value = [];
        searched.value = false;
        return;
    }
    const my = ++seq;
    loading.value = true;
    try {
        const r = await apiFetch('/api/search/global?q=' + encodeURIComponent(term));
        // คำตอบที่มาช้ากว่าคำค้นล่าสุดต้องทิ้ง ไม่งั้นผลเก่าทับผลใหม่
        if (my !== seq) return;
        results.value = r.results || [];
        cursor.value = 0;
        searched.value = true;
    } catch (_) {
        if (my === seq) { results.value = []; searched.value = true; }
    } finally {
        if (my === seq) loading.value = false;
    }
}

function onType() {
    clearTimeout(debounce);
    // 350 มิลลิวินาที — การค้นแต่ละครั้งต่อเข้าเราท์เตอร์จริงทุกสาขา ยิงถี่ไม่ไหว
    debounce = setTimeout(run, 350);
}

// ไปที่ผลลัพธ์: สลับสาขาให้ก่อน แล้วค่อยเปิดหน้าที่เกี่ยวข้อง
function go(item) {
    if (item.siteId) setActiveSiteId(item.siteId);
    if (item.type === 'hotspot') navigate('hotspot');
    else if (item.type === 'pppoe') navigate('pppoe');
    else if (item.type === 'site') navigate('settings');
    close();
}

function onKeydown(e) {
    // Ctrl+K / Cmd+K เปิดได้จากทุกหน้า
    if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
        e.preventDefault();
        open.value ? close() : show();
        return;
    }
    if (!open.value) return;
    if (e.key === 'Escape') { close(); return; }
    if (!results.value.length) return;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        cursor.value = (cursor.value + 1) % results.value.length;
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        cursor.value = (cursor.value - 1 + results.value.length) % results.value.length;
    } else if (e.key === 'Enter') {
        e.preventDefault();
        go(results.value[cursor.value]);
    }
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => { window.removeEventListener('keydown', onKeydown); clearTimeout(debounce); });

defineExpose({ show });
</script>

<template>
    <BaseModal :open="open" title="ค้นหาทั่วระบบ" @close="close">
        <div class="searchbox">
            <i class="fa-solid fa-magnifying-glass"></i>
            <input
                ref="inputEl" v-model="q" class="v2-input"
                placeholder="ชื่อผู้ใช้ Hotspot, ห้อง PPPoE, ชื่อสาขา, IP…"
                @input="onType"
            >
            <i v-if="loading" class="fa-solid fa-spinner fa-spin"></i>
        </div>

        <div class="hint">
            ค้นทุกสาขาพร้อมกัน · <kbd>↑</kbd><kbd>↓</kbd> เลื่อน · <kbd>Enter</kbd> เปิด · <kbd>Esc</kbd> ปิด
        </div>

        <div v-if="q.trim().length && q.trim().length < 2" class="empty">พิมพ์อย่างน้อย 2 ตัวอักษร</div>
        <div v-else-if="loading && !results.length" class="empty">กำลังค้นทุกสาขา…</div>
        <div v-else-if="searched && !results.length" class="empty">ไม่พบ "{{ q.trim() }}" ในสาขาใดเลย</div>

        <ul v-else-if="results.length" class="results">
            <li
                v-for="(r, i) in results" :key="r.type + '-' + r.siteId + '-' + r.title + '-' + i"
                :class="{ on: i === cursor }"
                @mouseenter="cursor = i"
                @click="go(r)"
            >
                <i :class="r.icon || 'fa-solid fa-circle'"></i>
                <span class="body">
                    <span class="title">{{ r.title }}</span>
                    <span class="subtitle">{{ r.subtitle }}</span>
                </span>
                <span class="cat">{{ r.category }}</span>
            </li>
        </ul>
    </BaseModal>
</template>

<style scoped>
.searchbox { display: flex; align-items: center; gap: 10px; }
.searchbox .v2-input { flex: 1; font-size: 1rem; }
.hint { font-size: .76rem; color: var(--v2-text-muted); margin: 8px 0 4px; }
kbd { border: 1px solid var(--v2-border); border-bottom-width: 2px; border-radius: 4px;
      padding: 0 5px; font-size: .72rem; margin: 0 2px; font-family: inherit; }
.empty { padding: 22px 4px; text-align: center; color: var(--v2-text-muted); font-size: .86rem; }
.results { list-style: none; margin: 8px 0 0; padding: 0; max-height: 52vh; overflow-y: auto; }
.results li { display: flex; align-items: center; gap: 12px; padding: 10px 12px;
              border-radius: 8px; cursor: pointer; }
.results li.on { background: var(--v2-primary-soft); }
.results li > i { width: 18px; text-align: center; color: var(--v2-primary); flex-shrink: 0; }
.body { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.title { font-weight: 600; font-size: .88rem; }
.subtitle { font-size: .76rem; color: var(--v2-text-muted); overflow: hidden;
            text-overflow: ellipsis; white-space: nowrap; }
.cat { font-size: .72rem; color: var(--v2-text-muted); white-space: nowrap; flex-shrink: 0; }
</style>
