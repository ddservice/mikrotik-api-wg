-- ============================================================
-- 2026-09-06_room_billing.sql
--
-- รอบบิลค่าเช่าห้อง PPPoE — ย้ายวันครบกำหนดออกจากช่อง comment ของเราท์เตอร์
--
-- ทำไมต้องมีตารางนี้
--   จนถึงวันที่เขียนนี้ วันครบกำหนดของทุกห้องอยู่ในช่อง comment ของ /ppp/secret
--   บนเราท์เตอร์เท่านั้น ซึ่งแปลว่า:
--     - พิมพ์ผิดหรือลืมใส่ = ห้องนั้นหายไปจากทุกรายงานเงียบ ๆ ไม่มีใครตามเก็บเงิน
--     - เราท์เตอร์ถูก reset หรือเปลี่ยนเครื่อง = วันครบกำหนดหายทั้งสาขาพร้อมกัน
--     - ตอบไม่ได้ว่าเดือนนี้เก็บได้เท่าไหร่ ใครยังค้าง เพราะไม่มีที่ไหนบันทึกการชำระ
--
--   ระบบยังเขียน comment กลับลงเราท์เตอร์เหมือนเดิม ของเดิมจึงทำงานต่อได้ทั้งหมด
--   และคนที่เปิด WinBox ยังเห็นวันครบกำหนดตรงที่เคยเห็น
--
-- รันไฟล์นี้ใน Supabase SQL Editor ก่อนใช้ฟีเจอร์ (โปรเจกต์นี้ไม่มี migration framework)
-- รันซ้ำได้ปลอดภัย
-- ============================================================

CREATE TABLE IF NOT EXISTS room_billing (
    site_id     TEXT NOT NULL,
    username    TEXT NOT NULL,          -- ชื่อห้องใน /ppp/secret เช่น rm319
    tenant      TEXT,                   -- ชื่อผู้เช่า
    rent        NUMERIC(10, 2),         -- ค่าเช่าต่อเดือน
    due_date    DATE,                   -- วันครบกำหนดถัดไป
    active      BOOLEAN NOT NULL DEFAULT TRUE,   -- false = ห้องว่าง ไม่นับในยอดที่ควรได้
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (site_id, username)
);

CREATE TABLE IF NOT EXISTS room_payments (
    id              BIGSERIAL PRIMARY KEY,
    site_id         TEXT NOT NULL,
    username        TEXT NOT NULL,
    amount          NUMERIC(10, 2) NOT NULL,
    paid_on         DATE NOT NULL,
    months          INTEGER NOT NULL DEFAULT 1,   -- จ่ายกี่เดือน
    method          TEXT,                          -- เงินสด / โอน / อื่น ๆ
    note            TEXT,
    recorded_by     TEXT,                          -- ใครเป็นคนบันทึก
    -- เก็บวันครบกำหนดก่อนและหลังไว้ในรายการชำระเอง
    -- เพื่อให้ย้อนดูได้ว่ารายการนี้ต่ออายุจากวันไหนไปวันไหน โดยไม่ต้องเดาจากลำดับ
    due_date_before DATE,
    due_date_after  DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_room_payments_site_paid
    ON room_payments (site_id, paid_on DESC);
CREATE INDEX IF NOT EXISTS idx_room_payments_username
    ON room_payments (site_id, username, paid_on DESC);

-- เปิด RLS โดยไม่มี policy = มีแต่ backend (service role key) ที่แตะได้
-- ตรงกับสถาปัตยกรรมของแอปนี้ ที่ไม่มีอะไรเรียก Supabase จากเบราว์เซอร์โดยตรง
ALTER TABLE room_billing  ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_payments ENABLE ROW LEVEL SECURITY;
