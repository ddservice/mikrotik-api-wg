#!/bin/bash
# ============================================================
# logs.sh — ดู Log ทุกอย่างบน VPS
# Mikrotik API Dashboard
#
# วิธีใช้: ./logs.sh [option]
#   ./logs.sh app        → ดู PM2 app log
#   ./logs.sh error      → ดูเฉพาะ error log
#   ./logs.sh nginx      → ดู nginx access log
#   ./logs.sh hotspot    → ดู hotspot_logs.json (พรบ)
#   ./logs.sh activity   → ดู logs.json (activity log)
#   ./logs.sh monitor    → PM2 real-time monitor
#   ./logs.sh status     → สถานะ PM2 + disk usage
# ============================================================

APP_NAME="mikrotik-dashboard"
APP_DIR="/root/mikrotik-api-wg"
PM2_OUT="/var/log/mikrotik-dashboard/out.log"
PM2_ERR="/var/log/mikrotik-dashboard/error.log"
HOTSPOT_LOG="$APP_DIR/db/hotspot_logs.json"
ACTIVITY_LOG="$APP_DIR/db/logs.json"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

show_header() {
    echo -e "${BLUE}============================================${NC}"
    echo -e "${BLUE}  📋 Mikrotik Dashboard — Log Viewer       ${NC}"
    echo -e "${BLUE}  $(date '+%Y-%m-%d %H:%M:%S')             ${NC}"
    echo -e "${BLUE}============================================${NC}\n"
}

case "${1:-help}" in

    # ---- PM2 App Log (stdout) ----
    app)
        show_header
        echo -e "${GREEN}📄 PM2 Application Log (กด Ctrl+C เพื่อออก)${NC}\n"
        pm2 logs "$APP_NAME" --lines 100
        ;;

    # ---- PM2 Error Log ----
    error)
        show_header
        echo -e "${RED}❌ PM2 Error Log${NC}\n"
        if [ -f "$PM2_ERR" ]; then
            tail -n 100 "$PM2_ERR" | grep -E "Error|error|WARN|warn|fatal" --color=always
        else
            pm2 logs "$APP_NAME" --err --lines 100
        fi
        ;;

    # ---- Nginx Access Log ----
    nginx)
        show_header
        echo -e "${BLUE}🌐 Nginx Access Log (100 รายการล่าสุด)${NC}\n"
        if [ -f "/var/log/nginx/mikrotik-access.log" ]; then
            tail -n 100 /var/log/nginx/mikrotik-access.log
        else
            echo -e "${YELLOW}⚠️  ไม่พบ nginx log — อาจยังไม่ได้ตั้งค่า nginx${NC}"
        fi
        ;;

    # ---- Hotspot Traffic Log (พรบ) ----
    hotspot)
        show_header
        echo -e "${RED}🔒 Hotspot Traffic Log (ตามพรบ คอมพิวเตอร์ มาตรา 26)${NC}\n"
        if [ -f "$HOTSPOT_LOG" ]; then
            COUNT=$(python3 -c "import json; data=json.load(open('$HOTSPOT_LOG')); print(len(data))" 2>/dev/null || echo "ไม่ทราบ")
            echo -e "${YELLOW}📊 จำนวน session ทั้งหมด: ${COUNT} รายการ${NC}\n"
            echo -e "${BLUE}10 รายการล่าสุด:${NC}"
            python3 -c "
import json, sys
from datetime import datetime
data = json.load(open('$HOTSPOT_LOG'))
for entry in data[:10]:
    login = entry.get('loginTime','')[:19].replace('T',' ')
    logout = (entry.get('logoutTime','') or 'กำลังใช้งาน')[:19].replace('T',' ')
    status = '🟢' if entry.get('status') == 'connected' else '⚫'
    print(f\"{status} {login} | {entry.get('username','-'):12} | {entry.get('ipAddress','-'):15} | {entry.get('macAddress','-')}\")
" 2>/dev/null || cat "$HOTSPOT_LOG" | python3 -m json.tool | head -80
        else
            echo -e "${YELLOW}⚠️  ยังไม่มีข้อมูล — จะเริ่มบันทึกอัตโนมัติเมื่อมีผู้ใช้ Hotspot${NC}"
        fi
        ;;

    # ---- Activity Log ----
    activity)
        show_header
        echo -e "${BLUE}🛡️  Activity Log (กิจกรรมระบบ)${NC}\n"
        if [ -f "$ACTIVITY_LOG" ]; then
            COUNT=$(python3 -c "import json; data=json.load(open('$ACTIVITY_LOG')); print(len(data))" 2>/dev/null || echo "ไม่ทราบ")
            echo -e "${YELLOW}📊 จำนวน log ทั้งหมด: ${COUNT} รายการ${NC}\n"
            echo -e "${BLUE}20 รายการล่าสุด:${NC}"
            python3 -c "
import json
data = json.load(open('$ACTIVITY_LOG'))
for entry in data[:20]:
    ts = entry.get('timestamp','')[:19].replace('T',' ')
    user = entry.get('username','-')
    action = entry.get('action','-')
    details = entry.get('details','-')[:60]
    print(f\"{ts} | {user:10} | {action:20} | {details}\")
" 2>/dev/null || tail -n 50 "$ACTIVITY_LOG"
        else
            echo -e "${YELLOW}⚠️  ยังไม่มีข้อมูล${NC}"
        fi
        ;;

    # ---- PM2 Real-time Monitor ----
    monitor)
        echo -e "${GREEN}📊 เปิด PM2 Monitor (กด Ctrl+C เพื่อออก)${NC}\n"
        pm2 monit
        ;;

    # ---- Status Overview ----
    status)
        show_header
        echo -e "${BLUE}📊 PM2 Process Status${NC}"
        pm2 list
        echo ""

        echo -e "${BLUE}💾 Disk Usage${NC}"
        df -h "$APP_DIR" 2>/dev/null || df -h /
        echo ""

        echo -e "${BLUE}🧠 Memory Usage${NC}"
        free -h
        echo ""

        echo -e "${BLUE}📁 Log Files Size${NC}"
        [ -f "$PM2_OUT" ] && echo "  PM2 stdout: $(du -sh $PM2_OUT | cut -f1)"
        [ -f "$PM2_ERR" ] && echo "  PM2 error:  $(du -sh $PM2_ERR | cut -f1)"
        [ -f "$HOTSPOT_LOG" ] && echo "  Hotspot log: $(du -sh $HOTSPOT_LOG | cut -f1) ($(python3 -c "import json; print(len(json.load(open('$HOTSPOT_LOG'))))" 2>/dev/null || echo '?') records)"
        [ -f "$ACTIVITY_LOG" ] && echo "  Activity log: $(du -sh $ACTIVITY_LOG | cut -f1) ($(python3 -c "import json; print(len(json.load(open('$ACTIVITY_LOG'))))" 2>/dev/null || echo '?') records)"
        echo ""

        echo -e "${BLUE}🌐 Network Listening Ports${NC}"
        ss -tlnp | grep -E "3000|80|443" || netstat -tlnp 2>/dev/null | grep -E "3000|80|443"
        ;;

    # ---- Help ----
    *)
        show_header
        echo -e "วิธีใช้:"
        echo -e "  ${GREEN}./logs.sh app${NC}       → ดู PM2 app log (stdout)"
        echo -e "  ${RED}./logs.sh error${NC}     → ดูเฉพาะ error log"
        echo -e "  ${BLUE}./logs.sh nginx${NC}     → ดู nginx access log"
        echo -e "  ${RED}./logs.sh hotspot${NC}   → ดู traffic log (พรบ)"
        echo -e "  ${BLUE}./logs.sh activity${NC}  → ดู activity log"
        echo -e "  ${GREEN}./logs.sh monitor${NC}   → PM2 real-time monitor"
        echo -e "  ${YELLOW}./logs.sh status${NC}    → สถานะรวม + disk usage"
        ;;
esac
