/**
 * lib/router-files.js — จัดหมวดหมู่และวิเคราะห์ไฟล์บน MikroTik RouterOS
 *
 * ช่วยแก้ปัญหา Flash 16MB เต็ม (hAP ac^2, hEX, hAP mini) จากไฟล์ backup เก่า,
 * ไฟล์อัปเกรด .npk ที่ค้างอยู่ หรือ crash dump .dmp
 *
 * ฟังก์ชันบริสุทธิ์ทั้งหมด รับข้อมูลดิบ ไม่ต่อเราท์เตอร์เอง เพื่อให้เทสต์ได้
 */

'use strict';

/**
 * จัดหมวดหมู่ของไฟล์บนเราท์เตอร์
 * @param {string} name 
 * @param {string} type 
 * @returns {'backup'|'package'|'dump'|'supout'|'script'|'directory'|'other'}
 */
function categorizeRouterFile(name, type) {
    const n = String(name || '').toLowerCase();
    const t = String(type || '').toLowerCase();
    if (t === 'directory' || n.endsWith('/')) return 'directory';
    if (n.endsWith('.backup') || t === 'backup') return 'backup';
    if (n.endsWith('.npk') || t === 'package') return 'package';
    if (n.endsWith('.dmp') || t === 'crash dump') return 'dump';
    if (n.endsWith('.rif') || n.includes('autosupout') || t.includes('supout')) return 'supout';
    if (n.endsWith('.rsc') || n.endsWith('.auto.rsc') || t === 'script') return 'script';
    return 'other';
}

/**
 * แปลงรายการไฟล์ดิบจาก /file/print ให้พร้อมใช้งานบน UI และสรุปขนาด
 * @param {Array<object>} rawList 
 * @returns {{ files: Array<object>, summary: object }}
 */
function parseRouterFiles(rawList) {
    const list = Array.isArray(rawList) ? rawList : [];
    const files = list.map((item) => {
        const name = String(item.name || '');
        const type = String(item.type || '');
        const size = parseInt(item.size, 10) || 0;
        const category = categorizeRouterFile(name, type);
        return {
            id: item['.id'] || name,
            name,
            type,
            size,
            creationTime: item['creation-time'] || '',
            category,
            isDeletable: category !== 'directory'
        };
    });

    const summary = {
        totalFiles: files.filter((f) => f.category !== 'directory').length,
        totalBytes: files.reduce((acc, f) => acc + (f.category !== 'directory' ? f.size : 0), 0),
        backupBytes: files.filter((f) => f.category === 'backup').reduce((acc, f) => acc + f.size, 0),
        packageBytes: files.filter((f) => f.category === 'package').reduce((acc, f) => acc + f.size, 0),
        dumpBytes: files.filter((f) => f.category === 'dump' || f.category === 'supout').reduce((acc, f) => acc + f.size, 0)
    };

    return { files, summary };
}

/**
 * วางแผนลบไฟล์ที่ไม่จำเป็นเพื่อคืนพื้นที่
 * @param {Array<object>} files 
 * @param {Array<string>} [targetCategories] 
 * @returns {{ toDelete: Array<object>, totalFreedBytes: number }}
 */
function planCleanup(files, targetCategories) {
    const allowed = Array.isArray(targetCategories) && targetCategories.length
        ? targetCategories
        : ['package', 'dump', 'supout'];

    const toDelete = (Array.isArray(files) ? files : []).filter((f) =>
        allowed.includes(f.category) && f.category !== 'directory');

    const totalFreedBytes = toDelete.reduce((acc, f) => acc + (f.size || 0), 0);

    return { toDelete, totalFreedBytes };
}

module.exports = {
    categorizeRouterFile,
    parseRouterFiles,
    planCleanup
};
