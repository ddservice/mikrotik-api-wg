// ============================================================
// PM2 Ecosystem Config — Mikrotik API Dashboard
// วิธีใช้:
//   pm2 start ecosystem.config.js
//   pm2 save
//   pm2 startup
// ============================================================

module.exports = {
    apps: [
        {
            // ชื่อ process ที่แสดงใน pm2 list
            name: 'mikrotik-dashboard',

            // ไฟล์หลักที่รัน — ต้องเป็น Express server.js เท่านั้น (ห้าม next start)
            script: 'server.js',

            // โฟลเดอร์ที่รัน (ปรับตาม path จริงบน VPS)
            cwd: '/home/ddservice/mikrotik',

            // จำนวน instance (1 = single process) — ห้าม cluster กับ Express listen เดียว
            instances: 1,
            exec_mode: 'fork',

            // Auto-restart เมื่อ crash
            autorestart: true,

            // รอ 5 วินาทีก่อน restart เพื่อไม่ให้ loop
            restart_delay: 5000,

            // จำนวนครั้ง restart สูงสุดใน 15 วินาที (ป้องกัน crash loop)
            max_restarts: 10,

            // Watch file changes (ปิดไว้ใน production)
            watch: false,

            // Environment variables
            env: {
                NODE_ENV: 'production',
                // MikroTik ONLY — do not use 3000/3002/3005/3011/4000/5000 (other VPS apps)
                PORT: 3001,
                // Behind nginx: bind loopback. Local UI testing: HOST=0.0.0.0
                HOST: '127.0.0.1',

                // ==========================================
                // Supabase — ใส่ของจริงเท่านั้น
                // ห้ามปล่อย YOUR_PROJECT_ID แล้ว pm2 --update-env
                // ถ้ายังไม่มี key จริง ให้คอมเมนต์ 2 บรรทัดนี้ออก (ใช้ JSON fallback)
                // ==========================================
                // SUPABASE_URL: 'https://xxxx.supabase.co',
                // SUPABASE_SERVICE_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9....',

                // CORS origins (ถ้ามี domain)
                // ALLOWED_ORIGINS: 'https://yourdomain.com'

                // Public HTTPS URL of this dashboard (no trailing slash) —
                // used to embed an auto-registration callback in generated
                // WireGuard setup scripts so MikroTik routers can self-register
                // their public key without manual copy-paste. Optional: if
                // unset, WireGuard scripts still work, just fall back to the
                // fully-manual paste-back flow.
                // PUBLIC_APP_URL: 'https://yourdomain.com'
            },

            // Log files
            out_file: '/home/ddservice/mikrotik/logs/out.log',
            error_file: '/home/ddservice/mikrotik/logs/error.log',
            merge_logs: true,

            // Log rotation (ต้องติดตั้ง pm2-logrotate ด้วย)
            log_date_format: 'YYYY-MM-DD HH:mm:ss',

            // Maximum memory ก่อน auto-restart (ป้องกัน memory leak)
            max_memory_restart: '500M',

            // Graceful shutdown timeout (ms)
            kill_timeout: 5000,

            // รอ app พร้อมก่อน mark as "online"
            listen_timeout: 10000,
        }
    ]
};
