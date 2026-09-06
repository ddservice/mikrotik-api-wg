#!/bin/bash
# ============================================================
# scripts/restore-from-r2.sh — กู้คืนข้อมูลจาก Cloudflare R2
#
#   bash scripts/restore-from-r2.sh --list          ดูว่ามี backup ชุดไหนบ้าง
#   bash scripts/restore-from-r2.sh --check         ตรวจชุดล่าสุดว่ากู้คืนได้จริงไหม
#   bash scripts/restore-from-r2.sh 2026-09-05      ดาวน์โหลดชุดนั้นมาไว้ให้ตรวจ
#
# ------------------------------------------------------------
# ไฟล์เดิม (ถึง 2026-09-06) อ้างว่าเป็น "1-Click Disaster Recovery" แต่ทำแบบนี้:
#
#     cp "$RESTORE_TMP/"*.json "$APP_DIR/db/" 2>/dev/null || true
#     echo "🎉 Disaster Recovery Restore completed successfully!"
#
# ใน R2 ไม่มีไฟล์ .json แม้แต่ไฟล์เดียว (ตรวจจริง: 118 ไฟล์ = 44 csv + 73 jsonl.gz)
# glob จึงไม่ตรงอะไรเลย `|| true` กลืน error แล้วมันพิมพ์ว่าสำเร็จ
# **การกู้คืนไม่เคยทำงาน และไม่เคยมีทางทำงานได้** จะรู้ตัวก็วันที่ต้องใช้จริง
#
# และมันคัดลอกไฟล์ลง db/*.json ซึ่งเป็นที่เก็บของโหมด JSON เท่านั้น
# ขณะที่ production รันบน Supabase — ต่อให้ไฟล์มีอยู่จริงก็ไม่มีผลกับระบบจริง
#
# ไฟล์นี้จึง **ไม่เขียนทับอะไรอัตโนมัติอีกต่อไป** มันดาวน์โหลด ตรวจสอบ แล้วบอกว่า
# ต้องทำอะไรต่อ การเขียนข้อมูลกลับเข้าฐานข้อมูลที่ยังให้บริการอยู่เป็นการตัดสินใจ
# ของคน ไม่ใช่ของสคริปต์ที่รันแล้วจบ
#
# คีย์ R2 อ่านจาก ecosystem.config.js / env เท่านั้น — ไม่ฝังไว้ในไฟล์นี้อีกแล้ว
# (ของเดิมฝัง access key + secret ไว้ตรง ๆ ในไฟล์ที่ commit ลง git)
# ============================================================

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

case "${1:-}" in
    --list|-l|list)
        exec node scripts/verify-backup.js --list
        ;;
    --check|-c|"")
        exec node scripts/verify-backup.js
        ;;
    -h|--help)
        sed -n '2,10p' "${BASH_SOURCE[0]}"
        exit 0
        ;;
esac

TARGET_DATE="$1"
OUT_DIR="${2:-/tmp/mikrotik-r2-restore/$TARGET_DATE}"

echo "ดาวน์โหลด backup ชุดวันที่ $TARGET_DATE ไปไว้ที่ $OUT_DIR"
echo "(ดาวน์โหลดและตรวจสอบเท่านั้น — ไม่เขียนทับฐานข้อมูลหรือไฟล์ใด ๆ ของระบบ)"
echo

node scripts/verify-backup.js "$TARGET_DATE" --out "$OUT_DIR"

cat <<EOF

ขั้นต่อไป — ต้องตัดสินใจเอง ไม่ใช่รันคำสั่งเดียวจบ
------------------------------------------------------------
ไฟล์อยู่ที่ $OUT_DIR แล้ว ตรวจสอบผ่านแล้วว่าครบและไม่เพี้ยน

  โหมด Local JSON   คัดลอก *_<วันที่>.json ทับไฟล์ใน db/ (สำรองของเดิมไว้ก่อน)
                    แล้ว pm2 reload

  โหมด Supabase     นำเข้าผ่าน SQL Editor หรือสคริปต์นำเข้าทีละตาราง
                    **อย่าเขียนทับตารางที่ยังให้บริการอยู่โดยไม่ดูก่อนว่าของเดิมมีอะไร**
                    ตารางที่ต้องกู้ก่อนเพื่อให้ระบบกลับมาทำงาน:
                    sites → dashboard_users → app_settings → log_archives
                    ส่วนตาราง log กู้ทีหลังได้ ระบบทำงานได้โดยไม่มีมัน

  ถ้า manifest บอกว่า includesSecrets=false รหัสผ่านเราท์เตอร์และ token
  จะเป็น __REDACTED__ ต้องใส่ใหม่เองผ่านหน้า Router Settings
EOF
