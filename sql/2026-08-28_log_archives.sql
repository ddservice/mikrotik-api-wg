-- ============================================================================
-- 2026-08-28_log_archives.sql
--
-- ตาราง manifest ของไฟล์ archive ประจำวัน (พรบ. คอมพิวเตอร์ มาตรา 26)
--
-- ปัญหาที่แก้: ตอนนี้ระบบเก็บ log ครบตามกฎหมาย แต่ "พิสูจน์ไม่ได้ว่าไม่ถูกแก้"
-- export CSV ออกมาเมื่อไรก็ได้ ใครแก้ตัวเลขกลางทางก็ไม่มีใครรู้
-- ถ้าโดนหมายเรียก สิ่งที่ต้องแสดงคือหลักฐานที่ตรวจสอบความครบถ้วนได้
--
-- วิธีทำงาน: ทุกคืนหลังสำรองข้อมูล ระบบจะ "ปิดวัน" ของเมื่อวาน
--   1. ดึง hotspot_logs + dns_query_logs ของวันนั้นออกมาเป็น JSONL
--   2. gzip แล้วคำนวณ SHA-256 ของไฟล์ .gz
--   3. บันทึกแถวในตารางนี้ + อัปขึ้น Cloudflare R2
--   4. ใครก็ตามที่ได้ไฟล์ไป รัน `sha256sum <ไฟล์>` แล้วเทียบกับค่าในระบบได้
--
-- archive เฉพาะ "วันที่ปิดแล้ว" เท่านั้น ไม่ archive วันปัจจุบัน
-- เพราะ log ยังเขียนเพิ่มได้ ค่า hash จะเปลี่ยนไปเรื่อย ๆ ไม่มีความหมาย
--
-- วิธีรัน: Supabase Dashboard -> SQL Editor -> New query -> วางทั้งไฟล์ -> Run
--   https://supabase.com/dashboard/project/ebbbtatxrlmjkrxkrjdi/sql/new
--
-- ปลอดภัย: มีแต่คำสั่งสร้าง ไม่มี DROP / DELETE / UPDATE และเป็น IF NOT EXISTS
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.log_archives (
    id              text PRIMARY KEY,          -- '<archive_date>_<log_type>'
    archive_date    date        NOT NULL,      -- วันที่ของ log ที่อยู่ในไฟล์ (เวลาไทย)
    log_type        text        NOT NULL,      -- 'dns' | 'hotspot'
    site_name       text        NOT NULL DEFAULT 'ALL',
    record_count    integer     NOT NULL DEFAULT 0,
    file_name       text        NOT NULL,      -- เช่น 2026-08-27-dns.jsonl.gz
    file_size       bigint      NOT NULL DEFAULT 0,
    sha256          text        NOT NULL,      -- ของไฟล์ .gz ตรงกับ sha256sum
    storage_r2_key  text,                      -- path บน R2 (null = อัปไม่สำเร็จ)
    storage_local   text,                      -- path บน VPS
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      text        NOT NULL DEFAULT 'System Auto'
);

-- หน้าเว็บเรียงจากวันล่าสุดเสมอ
CREATE INDEX IF NOT EXISTS log_archives_date_idx
    ON public.log_archives (archive_date DESC);

-- กันสร้างซ้ำวันเดียวกัน/ชนิดเดียวกัน (id เป็น PK อยู่แล้ว แต่ index นี้ช่วยตอน query)
CREATE UNIQUE INDEX IF NOT EXISTS log_archives_date_type_uidx
    ON public.log_archives (archive_date, log_type, site_name);

-- RLS เปิดโดยไม่มี policy = เข้าถึงได้เฉพาะ backend ที่ใช้ service role key
-- ตรงกับสถาปัตยกรรมของแอปนี้ (ไม่มีอะไรเรียก Supabase จากเบราว์เซอร์)
ALTER TABLE public.log_archives ENABLE ROW LEVEL SECURITY;

-- ตรวจผล: ควรได้ 12 แถว
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'log_archives'
ORDER BY ordinal_position;
