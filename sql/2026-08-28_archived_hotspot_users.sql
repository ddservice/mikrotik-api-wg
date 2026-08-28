-- ============================================================================
-- 2026-08-28_archived_hotspot_users.sql
--
-- สร้างตาราง archived_hotspot_users ที่ "ไม่เคยถูกสร้าง" ใน Postgres
--
-- ที่มา: ฟีเจอร์คลังคูปองที่ถูกลบ (getArchivedHotspotUsers /
-- archiveDeletedHotspotUser) ขึ้น production เมื่อ 2026-08-26 แต่ไม่เคยมีใครรัน
-- CREATE TABLE โค้ดใน db-supabase.js ครอบ try/catch ไว้ error จึงถูกกลืนเงียบ ๆ
-- ผลคือคูปองที่ถูกลบอัตโนมัติทุกใบตั้งแต่วันนั้น "ไม่ได้ถูกเก็บประวัติเลย"
-- และปุ่ม Restore ในหน้าเว็บก็ไม่มีข้อมูลให้กู้
--
-- วิธีรัน:
--   Supabase Dashboard -> SQL Editor -> New query -> วางไฟล์นี้ทั้งไฟล์ -> Run
--   ลิงก์ตรง: https://supabase.com/dashboard/project/ebbbtatxrlmjkrxkrjdi/sql/new
--
-- ปลอดภัย: มีแต่คำสั่งสร้าง ไม่มี DROP / DELETE / UPDATE / ALTER COLUMN
--          ทุกคำสั่งเป็น IF NOT EXISTS จึงรันซ้ำได้โดยไม่เกิดผลข้างเคียง
--
-- หลังรันเสร็จ: แจ้งให้รัน `node scripts/migrate-json-to-supabase.js --apply`
--              เพื่อย้าย 3 รายการที่ยังค้างอยู่ใน db/archived_hotspot_users.json
-- ============================================================================

-- ชื่อคอลัมน์ต้องตรงกับ row ที่ archiveDeletedHotspotUser() ใน db-supabase.js
-- ประกอบขึ้นมาเป๊ะ ๆ (snake_case) มิฉะนั้น insert จะล้มเหลวเงียบเหมือนเดิม
CREATE TABLE IF NOT EXISTS public.archived_hotspot_users (
    id                 text PRIMARY KEY,
    username           text        NOT NULL DEFAULT '',
    password           text        NOT NULL DEFAULT '',
    profile            text        NOT NULL DEFAULT 'default',
    limit_uptime       text        NOT NULL DEFAULT '',
    limit_bytes_total  bigint      NOT NULL DEFAULT 0,
    comment            text        NOT NULL DEFAULT '',
    site_name          text        NOT NULL DEFAULT '',
    expired_at         timestamptz,
    deleted_at         timestamptz NOT NULL DEFAULT now(),
    deleted_by         text        NOT NULL DEFAULT 'System',
    reason             text        NOT NULL DEFAULT 'manual_delete'
);

-- หน้าเว็บเรียงตามวันที่ลบล่าสุดเสมอ
CREATE INDEX IF NOT EXISTS archived_hotspot_users_deleted_at_idx
    ON public.archived_hotspot_users (deleted_at DESC);

-- และกรองตามสาขา
CREATE INDEX IF NOT EXISTS archived_hotspot_users_site_name_idx
    ON public.archived_hotspot_users (site_name);

-- เปิด RLS โดยไม่ใส่ policy ใด ๆ = มีแต่ backend ที่ใช้ service role key เท่านั้น
-- ที่เข้าถึงได้ (service role bypass RLS โดยดีไซน์) ตรงกับสถาปัตยกรรมของแอปนี้
-- ที่ไม่มีอะไรเรียก Supabase จากเบราว์เซอร์โดยตรง — ดูหัวข้อ Database migrations
-- ใน CLAUDE.md
ALTER TABLE public.archived_hotspot_users ENABLE ROW LEVEL SECURITY;

-- ตรวจผล: ควรได้ 12 แถว (จำนวนคอลัมน์)
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'archived_hotspot_users'
ORDER BY ordinal_position;
