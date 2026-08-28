// Router เล็ก ๆ ที่ใช้ hash — ไม่ต้องพึ่ง vue-router และไม่ต้องแก้ nginx
// (ถ้าใช้ history mode จะต้องเพิ่ม rewrite ฝั่ง server ซึ่งแปลว่าไปแตะ production config
// ผิดหลักที่วางไว้ว่า "งานฝั่งหน้าเว็บต้องไม่กระทบ server")
//
// ของเดิมไม่มี URL แยกหน้าเลย ทั้งแอปเป็นหน้าเดียวสลับ display:none
// อันนี้เลยได้ของแถม: กด refresh แล้วอยู่หน้าเดิม และ bookmark หน้าที่ต้องการได้

import { ref } from 'vue';

const DEFAULT_ROUTE = 'overview';

function parseHash() {
    const raw = String(window.location.hash || '').replace(/^#\/?/, '').trim();
    return raw ? raw.split('?')[0] : DEFAULT_ROUTE;
}

export const currentRoute = ref(parseHash());

export function navigate(route) {
    if (!route) return;
    if (parseHash() === route) {
        currentRoute.value = route;
        return;
    }
    window.location.hash = '#/' + route;
}

window.addEventListener('hashchange', () => {
    currentRoute.value = parseHash();
});

export { DEFAULT_ROUTE };
