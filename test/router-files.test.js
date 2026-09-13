/**
 * เทสต์ lib/router-files.js — การจัดหมวดหมู่และวางแผนล้างไฟล์บน MikroTik RouterOS
 */

const assert = require('assert');
const rf = require('../lib/router-files');

describe('router-files — categorizeRouterFile', () => {
    it('จัดหมวดหมู่ไฟล์ประเภทต่าง ๆ ได้ถูกต้อง', () => {
        assert.strictEqual(rf.categorizeRouterFile('backup-2026-08-01.backup', 'backup'), 'backup');
        assert.strictEqual(rf.categorizeRouterFile('old_config.backup', ''), 'backup');
        assert.strictEqual(rf.categorizeRouterFile('routeros-7.24.1-arm.npk', 'package'), 'package');
        assert.strictEqual(rf.categorizeRouterFile('crash.dmp', 'crash dump'), 'dump');
        assert.strictEqual(rf.categorizeRouterFile('autosupout.rif', ''), 'supout');
        assert.strictEqual(rf.categorizeRouterFile('setup.rsc', 'script'), 'script');
        assert.strictEqual(rf.categorizeRouterFile('flash/skins', 'directory'), 'directory');
        assert.strictEqual(rf.categorizeRouterFile('hotspot/', ''), 'directory');
        assert.strictEqual(rf.categorizeRouterFile('notes.txt', ''), 'other');
    });
});

describe('router-files — parseRouterFiles & summary', () => {
    const rawList = [
        { '.id': '*1', name: 'backup-1.backup', type: 'backup', size: '150000', 'creation-time': 'aug/01/2026 10:00:00' },
        { '.id': '*2', name: 'update.npk', type: 'package', size: '10000000', 'creation-time': 'sep/01/2026 12:00:00' },
        { '.id': '*3', name: 'crash.dmp', type: 'crash dump', size: '50000', 'creation-time': 'sep/02/2026 04:00:00' },
        { '.id': '*4', name: 'hotspot', type: 'directory', size: '4096', 'creation-time': 'jan/01/1970 00:00:00' }
    ];

    it('แปลงรายการและคำนวณขนาดสรุปถูกต้อง', () => {
        const parsed = rf.parseRouterFiles(rawList);
        assert.strictEqual(parsed.files.length, 4);
        assert.strictEqual(parsed.summary.totalFiles, 3, 'ไม่นับ directory ในจำนวนไฟล์');
        assert.strictEqual(parsed.summary.backupBytes, 150000);
        assert.strictEqual(parsed.summary.packageBytes, 10000000);
        assert.strictEqual(parsed.summary.dumpBytes, 50000);
        assert.strictEqual(parsed.summary.totalBytes, 10200000);
    });

    it('รับค่า null/undefined ได้โดยไม่พัง', () => {
        const empty = rf.parseRouterFiles(null);
        assert.strictEqual(empty.files.length, 0);
        assert.strictEqual(empty.summary.totalFiles, 0);
    });
});

describe('router-files — planCleanup', () => {
    const parsedFiles = [
        { id: '*1', name: 'backup-1.backup', category: 'backup', size: 150000 },
        { id: '*2', name: 'update.npk', category: 'package', size: 10000000 },
        { id: '*3', name: 'crash.dmp', category: 'dump', size: 50000 },
        { id: '*4', name: 'autosupout.rif', category: 'supout', size: 80000 },
        { id: '*5', name: 'hotspot', category: 'directory', size: 4096 }
    ];

    it('เลือกไฟล์ชั่วคราวตาม default categories (package, dump, supout)', () => {
        const plan = rf.planCleanup(parsedFiles);
        assert.strictEqual(plan.toDelete.length, 3);
        const names = plan.toDelete.map((f) => f.name);
        assert.ok(names.includes('update.npk'));
        assert.ok(names.includes('crash.dmp'));
        assert.ok(names.includes('autosupout.rif'));
        assert.ok(!names.includes('backup-1.backup'));
        assert.ok(!names.includes('hotspot'));
        assert.strictEqual(plan.totalFreedBytes, 10000000 + 50000 + 80000);
    });

    it('ระบุ targetCategories เองได้', () => {
        const plan = rf.planCleanup(parsedFiles, ['backup']);
        assert.strictEqual(plan.toDelete.length, 1);
        assert.strictEqual(plan.toDelete[0].name, 'backup-1.backup');
        assert.strictEqual(plan.totalFreedBytes, 150000);
    });
});
