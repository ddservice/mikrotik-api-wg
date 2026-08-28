<script setup>
import { watch, onUnmounted } from 'vue';

// โมดัลกลางของทั้งแอป — ทุกโมดัลต้องใช้ตัวนี้ ห้ามเขียน backdrop เองซ้ำ
//
// ใช้ <Teleport to="body"> เสมอ ทำให้ DOM ของโมดัลไปอยู่ใต้ <body> ตรง ๆ
// ไม่ว่าจะเขียน component นี้ซ้อนอยู่ลึกแค่ไหน — บั๊ก 2026-08-28 ที่โมดัล 8 ตัว
// ไปติดอยู่ใน parent ที่ opacity:0 แล้วเงียบสนิท จึงเกิดซ้ำไม่ได้ในเชิงโครงสร้าง
const props = defineProps({
    open: { type: Boolean, default: false },
    title: { type: String, default: '' },
    icon: { type: String, default: '' },
    width: { type: String, default: '560px' },
    busy: { type: Boolean, default: false }   // กันปิดระหว่างกำลังบันทึก
});
const emit = defineEmits(['close']);

function close() {
    if (!props.busy) emit('close');
}

function onKey(e) {
    if (e.key === 'Escape') close();
}

// ล็อกการเลื่อนหน้าหลังตอนโมดัลเปิด ไม่งั้นเลื่อนทะลุไปโดนตารางข้างหลัง
watch(() => props.open, (isOpen) => {
    if (isOpen) {
        document.body.style.overflow = 'hidden';
        window.addEventListener('keydown', onKey);
    } else {
        document.body.style.overflow = '';
        window.removeEventListener('keydown', onKey);
    }
});

onUnmounted(() => {
    document.body.style.overflow = '';
    window.removeEventListener('keydown', onKey);
});
</script>

<template>
    <Teleport to="body">
        <Transition name="v2m">
            <div v-if="open" class="backdrop" @click.self="close">
                <div class="card" :style="{ maxWidth: width }" role="dialog" aria-modal="true">
                    <header class="head">
                        <h4>
                            <i v-if="icon" :class="icon"></i>
                            {{ title }}
                        </h4>
                        <button type="button" class="x" :disabled="busy" @click="close">&times;</button>
                    </header>

                    <div class="body"><slot /></div>

                    <footer v-if="$slots.footer" class="foot"><slot name="footer" /></footer>
                </div>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
.backdrop {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, .6);
    backdrop-filter: blur(5px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px 14px;
    overflow-y: auto;
    z-index: 9000;
}

.card {
    background: var(--v2-surface);
    border-radius: 14px;
    width: 100%;
    margin: auto;
    box-shadow: 0 24px 60px -12px rgba(15, 23, 42, .35);
    display: flex;
    flex-direction: column;
    max-height: calc(100vh - 40px);
    overflow: hidden;
}

.head {
    padding: 16px 20px;
    border-bottom: 1px solid var(--v2-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-shrink: 0;
}

.head h4 {
    margin: 0;
    font-size: 1rem;
    font-weight: 700;
    color: var(--v2-text);
    display: flex;
    align-items: center;
    gap: 9px;
}

.head i { color: var(--v2-primary); }

.x {
    background: none;
    border: none;
    font-size: 1.6rem;
    line-height: 1;
    color: var(--v2-text-muted);
    cursor: pointer;
    padding: 0 4px;
}

.x:hover:not(:disabled) { color: var(--v2-text); }
.x:disabled { opacity: .4; cursor: not-allowed; }

.body {
    padding: 20px;
    overflow-y: auto;
}

.foot {
    padding: 14px 20px;
    border-top: 1px solid var(--v2-border);
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    flex-shrink: 0;
    background: #fbfcfe;
}

.v2m-enter-active, .v2m-leave-active { transition: opacity .16s ease; }
.v2m-enter-from, .v2m-leave-to { opacity: 0; }
.v2m-enter-active .card, .v2m-leave-active .card { transition: transform .16s ease; }
.v2m-enter-from .card, .v2m-leave-to .card { transform: translateY(12px); }
</style>
