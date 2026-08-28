# frontend/ — Vue 3 + Vite (นำร่อง)

หน้าเว็บเวอร์ชันใหม่ที่กำลังทยอยย้ายมาจาก `public/index.html` + `public/app.js`
ตอนนี้ย้ายมาแล้ว **4 หน้า**: Overview, Hotspot, PPPoE, Logs (ดูรายละเอียดในหัวข้อ "ลำดับการย้าย" ท้ายไฟล์)

เข้าดูได้ที่ **`/v2/`** (เช่น `https://api.ddserviceth.com/v2/`) — มีหน้าล็อกอินของตัวเอง
และใช้ token ร่วมกับหน้าเดิมใน `localStorage` เข้าสลับไปมาได้ระหว่างช่วงย้ายระบบ

## สิ่งที่ไม่ถูกแตะเลย

`server.js`, PM2, nginx, พอร์ต 3001, `db.js` / `db-supabase.js`, RouterOS API client,
WireGuard, LINE OA webhook, background poller — **ทั้งหมดไม่เกี่ยวข้องกับงานนี้**
งานนี้เปลี่ยนแค่ไฟล์ที่เบราว์เซอร์โหลดเท่านั้น build ออกมาเป็น static file
แล้ววางใน `public/v2/` ซึ่ง Express เสิร์ฟเป็น static อยู่แล้ว

นี่คือข้อแตกต่างสำคัญจากการทดลอง Next.js เมื่อ 12-13 ส.ค. ที่ทำเว็บล่ม —
ครั้งนั้น Next ไป**แทนตัวเซิร์ฟเวอร์** ต้องมี process + พอร์ตของตัวเอง เลยชนพอร์ต
กับแอปอื่นบน VPS และ nginx ชี้ผิด upstream

## คำสั่ง

```bash
# ครั้งแรก
cd frontend && npm install

# พัฒนา (hot reload, proxy /api ไปที่ Express บนพอร์ต 3001)
npm run dev                       # จาก frontend/
npm run dev:frontend              # หรือจาก repo root
# ถ้า Express รันพอร์ตอื่น: API_TARGET=http://127.0.0.1:3099 npm run dev

# build ก่อน commit ทุกครั้งที่แก้อะไรใน frontend/src
npm run build                     # จาก frontend/
npm run build:frontend            # หรือจาก repo root
```

## ⚠️ ต้อง build บนเครื่อง dev แล้ว commit ผลลัพธ์

`public/v2/` **ถูก track ใน git โดยตั้งใจ** เพราะ VPS รัน `npm install --omit=dev`
และไม่มี vite/vue ติดตั้งอยู่เลย ขั้นตอน deploy จึงยังเป็น

```bash
git pull origin main && pm2 reload ecosystem.config.js --update-env
```

เหมือนเดิมทุกประการ ไม่มี build step บนเซิร์ฟเวอร์ ไม่มี dependency ใหม่บน VPS

**ถ้าแก้ `frontend/src` แล้วลืม `npm run build` ก่อน commit → ของที่ deploy จะเป็นเวอร์ชันเก่า**

## ทำไมถึงเลือก Vue

- template คือ HTML ปกติ → ย้าย markup ภาษาไทยจาก `index.html` ได้เกือบ copy-paste
  (React ต้องแปลงเป็น JSX ทุกบรรทัด = โอกาสพิมพ์ตกหล่นในข้อความไทยสูงกว่ามาก)
- compiler ปฏิเสธ build ถ้าแท็กไม่ปิด → บั๊ก 28 ส.ค. (`<div>` ไม่ปิด 3 จุด ทำให้
  โมดัล 8 ตัวไปซ้อนใน parent ที่ `opacity:0` แล้วเงียบสนิท) เกิดซ้ำไม่ได้
- `<Teleport to="body">` การันตีว่าโมดัลอยู่ใต้ `<body>` เสมอไม่ว่าจะเขียนซ้อนลึกแค่ไหน
- ชื่อไฟล์ build มี content hash → **ไม่ต้องมานั่ง bump `?v=` เองอีก** และ Cloudflare
  cache ของเก่าไว้ก็ไม่กระทบ เพราะไฟล์ใหม่คนละชื่อ

## โครงสร้าง

```
frontend/
├── index.html                    # entry (โหลด /style.css ชุดเดียวกับหน้าเดิม)
├── vite.config.js                # build → ../public/v2, base '/v2/'
└── src/
    ├── main.js
    ├── api.js                    # apiFetch + session state (ยึดสัญญาเดิมจาก app.js)
    ├── menu.js                   # นิยามเมนู + สิทธิ์ตาม role (สะท้อนของเดิม)
    ├── router.js                 # hash router เล็ก ๆ ไม่ต้องแก้ nginx
    ├── format.js                 # formatUptime / formatBytes / parseRouterOSDate ยกมาจากของเดิม
    ├── App.vue                   # shell + site selector
    └── components/
        ├── AppSidebar.vue        # เมนูข้าง + ตัวชี้ว่าหน้าไหนยังอยู่ระบบเดิม
        ├── LoginPage.vue
        ├── StatCard.vue          # แทน .stat-card ที่เดิมเขียนซ้ำ 9 รอบ
        ├── OverviewPage.vue      # การ์ดสถิติ 9 ใบ
        ├── HotspotPage.vue       # ผู้ใช้ออนไลน์ + บัญชีทั้งหมด
        ├── PppoePage.vue         # สถานะออนไลน์ + ห้องพัก + แพ็กเกจ
        ├── LogsPage.vue          # DNS / Hotspot / PPPoE / ประวัติผู้ดูแล
        ├── BaseModal.vue         # โมดัลกลาง (Teleport to body เสมอ)
        ├── ToastHost.vue         # แจ้งผลแบบ toast แทน alert()
        ├── HotspotUserModal.vue  # เพิ่ม/แก้ไขบัญชี + ตรรกะต่ออายุ
        └── FullUpgradeModal.vue  # โมดัล 1-Click (ใช้ Teleport)
```

## ลำดับการย้ายที่วางไว้

ย้ายทีละหน้า ของเดิมยังทำงานอยู่ตลอด ย้อนกลับได้ทุกจุด:

1. ✅ Overview — การ์ดสถิติ 9 ใบ + โมดัลอัปเกรด (ROS / Firmware)
2. ✅ Login + shell — sidebar, hash router (`#/hotspot` refresh แล้วอยู่หน้าเดิม),
   site switcher, role gating ตาม `/api/settings/menu-permissions`
3. ✅ Hotspot — ผู้ใช้ออนไลน์ (เตะออกได้), บัญชีทั้งหมด + ตัวกรองสถานะ
   *ยังขาด: เพิ่ม/แก้ไข/ต่ออายุ/พิมพ์คูปอง/โปรไฟล์/voucher generator/คลังคูปองที่ลบ*
4. ✅ PPPoE — สถานะออนไลน์ (ตัดการเชื่อมต่อได้), ห้องพักทั้งหมด + ระงับ/ยกเลิกระงับ, แพ็กเกจ
   *ยังขาด: เพิ่ม/แก้ไขห้องและแพ็กเกจ, server settings, สคริปต์ติดตั้ง*
5. ✅ Logs — DNS (ม.26), Hotspot (ม.26), สรุป PPPoE รายเดือน, ประวัติผู้ดูแล (admin)
   พร้อมค้นหา/กรองช่วงวัน/แบ่งหน้า/ส่งออก CSV
6. Settings — ไซต์, LINE OA, Telegram, Router Operations
7. Firewall / Multi-WAN / ผู้ใช้งาน Dashboard
8. ตัดหน้าหลัก `/` มาใช้ของใหม่ แล้วลบ `public/app.js` + `public/index.html` เดิม

ข้อ 7 ทำเป็นข้อสุดท้ายเท่านั้น และทำหลังจากคลิกทดสอบครบทุกหน้าแล้ว
