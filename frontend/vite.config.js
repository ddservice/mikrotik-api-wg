import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

// Build output ไปที่ ../public/v2 — Express เสิร์ฟ public/ เป็น static อยู่แล้ว
// ทำให้เข้าถึงได้ที่ /v2/ โดยไม่ต้องแตะ server.js, PM2, nginx หรือพอร์ตใด ๆ
//
// สำคัญ: build ทำบนเครื่อง dev แล้ว commit ผลลัพธ์ลง git
// VPS รัน `npm install --omit=dev` และไม่เคยเห็น vite/vue เลย
// ขั้นตอน deploy ยังเป็น `git pull && pm2 reload` เหมือนเดิมทุกประการ
export default defineConfig({
    plugins: [vue()],
    base: '/v2/',
    build: {
        outDir: fileURLToPath(new URL('../public/v2', import.meta.url)),
        emptyOutDir: true,
        // ชื่อไฟล์มี content hash อยู่แล้ว -> ไม่ต้องมานั่ง bump ?v= เองอีก
        // และ Cloudflare cache ไฟล์เก่าไว้ก็ไม่เป็นไร เพราะชื่อไฟล์ใหม่คนละชื่อ
        rollupOptions: {
            output: {
                entryFileNames: 'assets/[name]-[hash].js',
                chunkFileNames: 'assets/[name]-[hash].js',
                assetFileNames: 'assets/[name]-[hash][extname]'
            }
        }
    },
    server: {
        port: 5173,
        // dev mode: proxy /api ไปหา Express ที่รันอยู่ เพื่อให้ hot reload
        // ทำงานได้โดยไม่ต้อง build ทุกครั้ง
        proxy: {
            '/api': {
                target: process.env.API_TARGET || 'http://127.0.0.1:3001',
                changeOrigin: true
            }
        }
    }
});
