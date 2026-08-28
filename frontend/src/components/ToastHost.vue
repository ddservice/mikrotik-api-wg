<script setup>
import { toasts, dismiss } from '../toast.js';

const ICONS = {
    success: 'fa-solid fa-circle-check',
    error: 'fa-solid fa-circle-exclamation',
    info: 'fa-solid fa-circle-info'
};
</script>

<template>
    <Teleport to="body">
        <div class="host" role="status" aria-live="polite">
            <TransitionGroup name="t">
                <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type" @click="dismiss(t.id)">
                    <i :class="ICONS[t.type]"></i>
                    <span>{{ t.message }}</span>
                </div>
            </TransitionGroup>
        </div>
    </Teleport>
</template>

<style scoped>
/* z-index สูงกว่าโมดัล (9000) เพราะต้องเห็นผลลัพธ์ทับโมดัลที่ยังเปิดอยู่ได้ */
.host {
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 9500;
    display: flex;
    flex-direction: column;
    gap: 9px;
    align-items: flex-end;
    pointer-events: none;
}

.toast {
    pointer-events: auto;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    max-width: 380px;
    padding: 12px 16px;
    border-radius: 11px;
    font-size: .86rem;
    font-weight: 500;
    line-height: 1.45;
    box-shadow: 0 10px 30px -8px rgba(15, 23, 42, .28);
    cursor: pointer;
    border: 1px solid;
}

.toast i { margin-top: 2px; flex-shrink: 0; }

.success { background: #f0fdf4; border-color: #bbf7d0; color: #15803d; }
.error { background: #fef2f2; border-color: #fecaca; color: #b91c1c; }
.info { background: #eff6ff; border-color: #bfdbfe; color: #1d4ed8; }

.t-enter-active, .t-leave-active { transition: all .22s ease; }
.t-enter-from { opacity: 0; transform: translateX(24px); }
.t-leave-to { opacity: 0; transform: translateX(24px); }
.t-move { transition: transform .22s ease; }

@media (max-width: 600px) {
    .host { left: 14px; right: 14px; bottom: 14px; align-items: stretch; }
    .toast { max-width: none; }
}
</style>
