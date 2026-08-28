// แจ้งผลการทำงานแบบ toast แทน alert() ของหน้าเดิม
//
// alert() บล็อก event loop ทั้งเส้น และบนมือถือมันเด้งกลางจอทับทุกอย่าง
// พอทำงานหลายรายการติดกัน (เช่นลบคูปองทีละใบ) จะกลายเป็นกด OK รัว ๆ
// toast ไม่บล็อกและซ้อนกันได้
//
// ยกเว้น: การยืนยันก่อนทำสิ่งที่ย้อนกลับไม่ได้ (ลบ, รีบูต, ระงับ) ยังใช้
// window.confirm() อยู่ เพราะต้องบล็อกจริง ๆ จนกว่าผู้ใช้จะตัดสินใจ

import { ref } from 'vue';

let seq = 0;
export const toasts = ref([]);

function push(type, message, ttl) {
    const id = ++seq;
    toasts.value.push({ id, type, message });
    setTimeout(() => dismiss(id), ttl);
    return id;
}

export function dismiss(id) {
    const i = toasts.value.findIndex((t) => t.id === id);
    if (i >= 0) toasts.value.splice(i, 1);
}

export const toast = {
    success: (m) => push('success', m, 3500),
    error: (m) => push('error', m, 7000),   // error อยู่นานกว่า ผู้ใช้ต้องได้อ่าน
    info: (m) => push('info', m, 3500)
};
