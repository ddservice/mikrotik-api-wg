<script setup>
// การ์ดสถิติหนึ่งใบ — มี CSS ของตัวเอง ไม่พึ่ง .stat-card ของ style.css เดิมแล้ว
// เพราะการ์ดเดิมออกแบบมาสำหรับค่าสั้น ๆ พอเจอค่ายาว (เช่น RBD52G-5HacD2HnD)
// หัวข้อกับค่าจะตัดบรรทัดมั่วจนอ่านยาก
defineProps({
    icon: { type: String, required: true },
    tone: {
        type: String,
        default: 'slate',
        validator: (v) => ['slate', 'blue', 'violet', 'teal', 'amber', 'green'].includes(v)
    },
    title: { type: String, required: true },
    value: { type: [String, Number], default: '-' },
    valueTitle: { type: String, default: '' },
    clickable: { type: Boolean, default: false },
    live: { type: Boolean, default: false },
    cardTitle: { type: String, default: '' }
});
</script>

<template>
    <component
        :is="clickable ? 'button' : 'div'"
        class="card"
        :class="{ 'is-clickable': clickable }"
        :type="clickable ? 'button' : undefined"
        :title="cardTitle || undefined"
    >
        <div class="head">
            <span class="icon" :class="'tone-' + tone"><i :class="icon"></i></span>
            <span class="label">{{ title }}</span>
            <slot name="badge" />
            <span v-if="live" class="live" title="อัปเดตอัตโนมัติ"></span>
        </div>

        <div class="value v2-num" :title="valueTitle || undefined">
            <slot name="value">{{ value }}</slot>
        </div>

        <div class="foot"><slot name="footer" /></div>
    </component>
</template>

<style scoped>
.card {
    background: var(--v2-surface);
    border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius);
    box-shadow: var(--v2-shadow);
    padding: 16px 18px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 0;
    text-align: left;
    font: inherit;
    color: inherit;
    width: 100%;
    transition: box-shadow .18s ease, transform .18s ease, border-color .18s ease;
}

.card.is-clickable {
    cursor: pointer;
}

.card.is-clickable:hover {
    box-shadow: var(--v2-shadow-lift);
    border-color: var(--v2-border-strong);
    transform: translateY(-1px);
}

.card.is-clickable:focus-visible {
    outline: 2px solid var(--v2-primary);
    outline-offset: 2px;
}

.head {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
}

.icon {
    width: 30px;
    height: 30px;
    border-radius: 9px;
    display: grid;
    place-items: center;
    font-size: .82rem;
    flex-shrink: 0;
}

.tone-slate { background: #eef2f7; color: #475569; }
.tone-blue { background: #e8f1ff; color: #1d4ed8; }
.tone-violet { background: #f1ecfe; color: #6d28d9; }
.tone-teal { background: #ddf7f2; color: #0f766e; }
.tone-amber { background: #fef3c7; color: #b45309; }
.tone-green { background: #dcfce7; color: #15803d; }

.label {
    /* หัวข้อบีบให้อยู่บรรทัดเดียวเสมอ ยาวเกินก็ตัด ... แทนที่จะดันการ์ดสูงไม่เท่ากัน */
    font-size: .78rem;
    font-weight: 600;
    color: var(--v2-text-muted);
    letter-spacing: .01em;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
}

.live {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #22c55e;
    flex-shrink: 0;
    box-shadow: 0 0 0 3px rgba(34, 197, 94, .16);
    animation: v2pulse 2s ease-in-out infinite;
}

@keyframes v2pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: .35; }
}

.value {
    font-size: 1.45rem;
    font-weight: 700;
    color: var(--v2-text);
    line-height: 1.2;
    /* ค่ายาว ๆ อย่างชื่อรุ่นเราท์เตอร์ให้ย่อขนาดลงแทนการตัดบรรทัด */
    overflow-wrap: anywhere;
}

.foot:empty {
    display: none;
}

@media (max-width: 480px) {
    .value { font-size: 1.25rem; }
}
</style>
