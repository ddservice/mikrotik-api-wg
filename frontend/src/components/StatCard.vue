<script setup>
// การ์ดสถิติหนึ่งใบ — แทน .stat-card ที่เดิมเขียนซ้ำ 9 ครั้งใน index.html
// ใช้ class เดิมจาก public/style.css ทั้งหมด หน้าตาเลยออกมาเหมือนเดิมเป๊ะ
defineProps({
    icon: { type: String, required: true },
    iconClass: { type: String, default: '' },
    iconStyle: { type: Object, default: () => ({}) },
    title: { type: String, required: true },
    value: { type: [String, Number], default: '-' },
    valueTitle: { type: String, default: '' },
    clickable: { type: Boolean, default: false },
    live: { type: Boolean, default: false },
    cardTitle: { type: String, default: '' }
});
</script>

<template>
    <div
        class="stat-card"
        :style="clickable ? { cursor: 'pointer' } : null"
        :title="cardTitle || undefined"
    >
        <div class="stat-icon" :class="iconClass" :style="iconStyle">
            <i :class="icon"></i>
        </div>
        <div class="stat-info" style="min-width: 0; flex: 1">
            <div class="stat-card-heading">
                <h3>{{ title }}</h3>
                <!-- badge เล็กมุมขวา เช่นสถานะอุณหภูมิ -->
                <slot name="badge" />
            </div>
            <p class="stat-card-value" :title="valueTitle || undefined">
                <slot name="value">{{ value }}</slot>
            </p>
            <slot name="footer" />
        </div>
        <span v-if="live" class="stat-live-dot" title="อัปเดตอัตโนมัติ"></span>
    </div>
</template>

<style scoped>
.stat-card-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
}

.stat-card-value {
    font-size: 1.15rem;
    font-weight: 700;
    color: #1e293b;
    margin: 2px 0 0;
    word-break: break-word;
    line-height: 1.3;
}
</style>
