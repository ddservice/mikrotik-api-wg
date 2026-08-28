# sql/ — schema changes ที่ต้องรันด้วยมือ

โปรเจกต์นี้**ไม่มี migration framework** ตามที่ระบุใน CLAUDE.md หัวข้อ
"Database migrations" — schema เปลี่ยนโดยรัน SQL ผ่าน **Supabase SQL Editor**
โฟลเดอร์นี้เก็บไฟล์ SQL เหล่านั้นไว้เพื่อให้มีประวัติว่าเคยรันอะไรไปบ้าง
(ก่อนหน้านี้ SQL ลอยอยู่ในบทสนทนาหรือในคอมเมนต์ของสคริปต์ ไม่มีที่เก็บ)

## วิธีรัน

1. เปิด **Supabase Dashboard → SQL Editor → New query**
   ลิงก์ตรงของโปรเจกต์นี้:
   `https://supabase.com/dashboard/project/ebbbtatxrlmjkrxkrjdi/sql/new`
2. เปิดไฟล์ `.sql` ที่ต้องการ คัดลอกทั้งไฟล์ไปวาง
3. กด **Run** (หรือ `Ctrl + Enter`)

> SQL Editor ของ Supabase ไม่มีปุ่มอัปโหลดไฟล์ ต้องคัดลอกไปวาง —
> ไฟล์ในโฟลเดอร์นี้จึงออกแบบให้ **วางทั้งไฟล์ได้เลย** ไม่ต้องตัดส่วนคอมเมนต์ออก

## กติกาของไฟล์ในโฟลเดอร์นี้

- ตั้งชื่อ `YYYY-MM-DD_สิ่งที่ทำ.sql`
- ต้อง **รันซ้ำได้โดยไม่เกิดผลข้างเคียง** — ใช้ `IF NOT EXISTS` / `IF EXISTS` เสมอ
- ตารางใหม่ต้อง `ENABLE ROW LEVEL SECURITY` โดย**ไม่ใส่ policy**
  (backend ใช้ service role key ซึ่ง bypass RLS อยู่แล้ว การเปิด RLS โดยไม่มี policy
  จึงเท่ากับ "มีแต่ backend เท่านั้นที่แตะได้" ตรงกับสถาปัตยกรรมของแอปนี้)
- ชื่อคอลัมน์ต้องตรงกับที่ `db-supabase.js` ประกอบ row ขึ้นมาเป๊ะ ๆ (snake_case)
  ไม่งั้น insert จะล้มเหลวเงียบ ๆ เพราะโค้ดครอบ try/catch ไว้
- เขียนที่มาไว้หัวไฟล์เสมอ ว่าทำไมต้องมี migration นี้

## รายการ

| ไฟล์ | สถานะ | เรื่อง |
|---|---|---|
| `2026-08-28_archived_hotspot_users.sql` | ⬜ รอรัน | สร้างตารางคลังคูปองที่ถูกลบ ซึ่งไม่เคยถูกสร้างเลยตั้งแต่ฟีเจอร์ขึ้น 2026-08-26 |

หลังรันไฟล์นี้เสร็จ ให้รัน
`node scripts/migrate-json-to-supabase.js --apply`
เพื่อย้าย 3 รายการที่ยังค้างอยู่ใน `db/archived_hotspot_users.json` เข้า Supabase
