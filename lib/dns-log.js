/**
 * lib/dns-log.js — อ่านบรรทัด log ของ RouterOS ที่มี topic "dns"
 *
 * แยกออกมาจาก server.js เพื่อให้ทดสอบได้โดยไม่ต้องเปิด server
 * (ถ้อยคำของ log ต่างกันไปตามรุ่น RouterOS จึงเป็น parser แบบยืดหยุ่น
 *  ปรับเทียบกับของจริงได้โดยตั้ง DEBUG_DNS_LOG=1 แล้วดู "[DEBUG_DNS_LOG] unmatched:"
 *  ใน `pm2 logs` ว่ามีรูปแบบไหนที่ยังจับไม่ได้)
 */

/**
 * แปลง message เป็น { sourceIp, domain } หรือ null ถ้าไม่ใช่บรรทัด DNS query
 *
 * หมายเหตุ: คำว่า "dns" ที่เห็นนำหน้าใน WinBox/terminal มาจากฟิลด์ `topics`
 * ที่ถูกนำมาต่อกันตอนแสดงผล ไม่ได้อยู่ในฟิลด์ `message` ที่ API ส่งมา
 * (ยืนยันกับ output จริงของเราท์เตอร์แล้ว)
 */
function parseDnsLogMessage(msg) {
    if (!msg) return null;

    // แบบ A: "query from 172.16.1.247: #3 example.com. A"
    let m = String(msg).match(
        /query from (\d{1,3}(?:\.\d{1,3}){3}).*?\s([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\.?\s/i
    );
    if (m) return { sourceIp: m[1], domain: m[2].toLowerCase() };

    // แบบ B: "resolving example.com from 172.16.1.247"
    m = String(msg).match(
        /resolving\s+([a-z0-9][a-z0-9.-]*\.[a-z]{2,})\.?\s+from\s+(\d{1,3}(?:\.\d{1,3}){3})/i
    );
    if (m) return { sourceIp: m[2], domain: m[1].toLowerCase() };

    return null;
}

module.exports = { parseDnsLogMessage };
