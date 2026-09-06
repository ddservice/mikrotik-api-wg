-- ============================================================
-- 2026-09-06_payment_claims.sql
--
-- การแจ้งชำระเงินด้วยสลิปผ่าน LINE
--
-- ระบบรับเรื่องไว้เท่านั้น **ไม่อนุมัติเอง** — รูปสลิปไม่ใช่หลักฐานการชำระเงิน
-- แก้ไขได้ ส่งซ้ำได้ ส่งสลิปเก่าได้ และยอดในรูปกับยอดที่เข้าบัญชีจริงไม่จำเป็นต้องตรงกัน
-- คนที่เปิดดูยอดในบัญชีธนาคารจริงเป็นคนกรอกจำนวนและกดอนุมัติ
--
-- หน้าที่ของตารางนี้คือ "ไม่ทำหาย" — สลิปที่ส่งมาตอนตีสองต้องยังอยู่ตอนเช้า
-- พร้อมบอกว่าใครส่ง ห้องไหน เมื่อไหร่ และยังไม่มีใครดู
--
-- ต้องรัน sql/2026-09-06_room_billing.sql ก่อนไฟล์นี้
-- รันใน Supabase SQL Editor · รันซ้ำได้ปลอดภัย
-- ============================================================

CREATE TABLE IF NOT EXISTS payment_claims (
    id            BIGSERIAL PRIMARY KEY,
    -- ว่างได้: ลูกค้าที่ยังไม่ได้พิมพ์ "ผูกบัญชี" เราจะไม่รู้ว่าห้องไหน
    -- แต่ยังต้องรับเรื่องไว้ ทิ้งไปเท่ากับลูกค้าจ่ายเงินแล้วไม่มีใครรู้
    site_id       TEXT,
    site_name     TEXT,
    username      TEXT,
    line_user_id  TEXT,
    source_id     TEXT,
    -- unique: LINE ส่ง webhook ซ้ำได้เมื่อไม่ได้รับ 200 ทัน
    -- ถ้าไม่กัน สลิปใบเดียวจะกลายเป็นสองรายการและอาจถูกอนุมัติสองครั้ง
    message_id    TEXT NOT NULL UNIQUE,
    slip_file     TEXT,
    status        TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
    -- ว่างจนกว่าจะอนุมัติ — จำนวนเงินมาจากคนกรอก ไม่ใช่จากรูป
    amount        NUMERIC(10, 2),
    months        INTEGER,
    reviewed_by   TEXT,
    reviewed_at   TIMESTAMPTZ,
    reject_reason TEXT,
    payment_id    BIGINT,
    received_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_claims_status
    ON payment_claims (status, received_at);
CREATE INDEX IF NOT EXISTS idx_payment_claims_site
    ON payment_claims (site_id, received_at DESC);

ALTER TABLE payment_claims ENABLE ROW LEVEL SECURITY;
