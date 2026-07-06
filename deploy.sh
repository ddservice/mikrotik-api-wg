#!/bin/bash
# ============================================================
# deploy.sh — Auto Deploy Script
# Mikrotik API Dashboard — VPS Production
#
# วิธีใช้:
#   chmod +x deploy.sh
#   ./deploy.sh
#
# หรือ setup alias:
#   echo "alias deploy='cd /root/mikrotik-api-wg && ./deploy.sh'" >> ~/.bashrc
# ============================================================

set -e  # หยุดทันทีถ้ามี error

# ---- CONFIG ----
APP_DIR="/root/mikrotik-api-wg"
APP_NAME="mikrotik-dashboard"
BRANCH="main"
LOG_DIR="/var/log/mikrotik-dashboard"

# สี terminal
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}  🚀 Mikrotik Dashboard — Auto Deploy      ${NC}"
echo -e "${BLUE}  $(date '+%Y-%m-%d %H:%M:%S')             ${NC}"
echo -e "${BLUE}============================================${NC}"

# ---- 1. ไปที่โฟลเดอร์โปรเจกต์ ----
cd "$APP_DIR" || { echo -e "${RED}❌ ไม่พบโฟลเดอร์ $APP_DIR${NC}"; exit 1; }
echo -e "\n${YELLOW}📁 Working directory: $(pwd)${NC}"

# ---- 2. แสดง commit ปัจจุบัน ----
CURRENT_COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")
echo -e "${YELLOW}📌 Commit ปัจจุบัน: ${CURRENT_COMMIT}${NC}"

# ---- 3. Pull โค้ดใหม่จาก GitHub ----
echo -e "\n${BLUE}📥 กำลัง git pull จาก origin/${BRANCH}...${NC}"
git fetch origin
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")

if [ "$LOCAL" = "$REMOTE" ]; then
    echo -e "${GREEN}✅ โค้ดเป็นเวอร์ชันล่าสุดแล้ว ไม่มีอัปเดต${NC}"
    NEW_CHANGES=false
else
    git pull origin "$BRANCH"
    NEW_COMMIT=$(git rev-parse --short HEAD)
    echo -e "${GREEN}✅ อัปเดตสำเร็จ: ${CURRENT_COMMIT} → ${NEW_COMMIT}${NC}"
    NEW_CHANGES=true
fi

# ---- 4. สร้าง log directory ถ้ายังไม่มี ----
mkdir -p "$LOG_DIR"
echo -e "${GREEN}✅ Log directory: ${LOG_DIR}${NC}"

# ---- 5. ติดตั้ง dependencies (ถ้า package.json เปลี่ยน) ----
if [ "$NEW_CHANGES" = true ] || [ ! -d "node_modules" ]; then
    echo -e "\n${BLUE}📦 ติดตั้ง npm packages...${NC}"
    npm install --production --silent
    echo -e "${GREEN}✅ npm install สำเร็จ${NC}"
fi

# ---- 6. Restart หรือ Start PM2 ----
echo -e "\n${BLUE}🔄 กำลัง restart PM2 process...${NC}"

if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
    # Process มีอยู่แล้ว → reload (zero-downtime)
    pm2 reload ecosystem.config.js --update-env
    echo -e "${GREEN}✅ PM2 reload สำเร็จ (zero-downtime)${NC}"
else
    # ครั้งแรก → start
    pm2 start ecosystem.config.js
    echo -e "${GREEN}✅ PM2 start สำเร็จ${NC}"
fi

# ---- 7. บันทึก PM2 process list ----
pm2 save --force
echo -e "${GREEN}✅ PM2 process list saved${NC}"

# ---- 8. แสดงสถานะ ----
echo -e "\n${BLUE}============================================${NC}"
echo -e "${BLUE}  📊 สถานะปัจจุบัน${NC}"
echo -e "${BLUE}============================================${NC}"
pm2 list

echo -e "\n${GREEN}🎉 Deploy เสร็จสมบูรณ์!${NC}"
echo -e "${YELLOW}📋 ดู log: pm2 logs ${APP_NAME}${NC}"
echo -e "${YELLOW}📋 ดูสถานะ: pm2 monit${NC}"
