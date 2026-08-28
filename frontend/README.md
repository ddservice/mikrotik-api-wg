# frontend/ — Vue 3 + Vite (นำร่อง)

หน้าเว็บเวอร์ชันใหม่ที่กำลังทยอยย้ายมาจาก `public/index.html` + `public/app.js`
ตอนนี้มี **หน้า Overview หน้าเดียว** เป็นตัวอย่างให้เทียบกับของเดิม

เข้าดูได้ที่ **`/v2/`** (เช่น `https://api.ddserviceth.com/v2/`) — ต้องล็อกอินที่หน้าเดิม
ก่อน เพราะทั้งสองหน้าใช้ token ตัวเดียวกันใน `localStorage`

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
    ├── format.js                 # formatUptime ฯลฯ ยกมาจาก app.js
    ├── App.vue                   # shell + site selector
    └── components/
        ├── StatCard.vue          # แทน .stat-card ที่เดิมเขียนซ้ำ 9 รอบ
        ├── OverviewPage.vue      # การ์ดสถิติ 9 ใบ
        └── FullUpgradeModal.vue  # โมดัล 1-Click (ใช้ Teleport)
```

## ลำดับการย้ายที่วางไว้

ย้ายทีละหน้า ของเดิมยังทำงานอยู่ตลอด ย้อนกลับได้ทุกจุด:

1. ✅ Overview (เสร็จ — เป็นตัวอย่างให้เทียบ)
2. Login + shell (sidebar, site switcher, role gating)
3. Hotspot — บัญชี, active, โปรไฟล์, voucher generator
4. PPPoE — ห้องพัก, active, แพ็กเกจ
5. Settings — ไซต์, LINE OA, Router Operations
6. Logs / Firewall / Multi-WAN
7. ตัดหน้าหลัก `/` มาใช้ของใหม่ แล้วลบ `public/app.js` + `public/index.html` เดิม

ข้อ 7 ทำเป็นข้อสุดท้ายเท่านั้น และทำหลังจากคลิกทดสอบครบทุกหน้าแล้ว
