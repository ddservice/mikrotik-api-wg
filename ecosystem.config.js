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

            // ไฟล์หลักที่รัน
            script: 'server.js',

            // โฟลเดอร์ที่รัน (ปรับตาม path จริงบน VPS)
            cwd: '/root/mikrotik-api-wg',

            // จำนวน instance (1 = single process, 'max' = ทุก CPU core)
            instances: 1,

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
                PORT: 3000
            },

            // Log files
            out_file: '/var/log/mikrotik-dashboard/out.log',
            error_file: '/var/log/mikrotik-dashboard/error.log',
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
