/**
 * เทสต์ lib/multiwan-mangle.js
 *
 * ที่มา (2026-09-05): หน้า Multi-WAN อ่าน config มาแล้วบอกว่ามีกฎ mangle ขวางอยู่
 * "ต้องปิดหรือลบก่อน" แล้วจบแค่นั้น ไม่มีปุ่มอะไรให้กด — เป็นทางตัน
 * โมดูลนี้เติมขั้นที่หายไป และสิ่งที่ต้องกันไว้คือ "ปิดแล้วคืนไม่ได้"
 */

const assert = require('assert');
const mm = require('../lib/multiwan-mangle');

const rules = [
    { '.id': '*1', chain: 'prerouting', action: 'mark-routing', 'new-routing-mark': 'to-wan1',
      comment: 'PCC balance A' },
    { '.id': '*2', chain: 'prerouting', action: 'mark-connection',
      'per-connection-classifier': 'both-addresses:2/0' },
    { '.id': '*3', chain: 'prerouting', action: 'mark-routing', 'new-routing-mark': 'to-wan2',
      disabled: 'true', comment: 'ลูกค้าปิดไว้เอง' }
];

describe('multiwan-mangle — ปิดกฎที่ขวาง', () => {
    it('ปิดเฉพาะข้อที่ยังเปิดอยู่', () => {
        const p = mm.planDisable(rules);
        assert.strictEqual(p.count, 2);
        assert.deepStrictEqual(p.steps.map((s) => s.id), ['*1', '*2']);
        p.steps.forEach((s) => assert.strictEqual(s.args.disabled, 'yes'));
    });

    it('ติดป้ายทุกข้อ และเก็บ comment เดิมไว้', () => {
        const p = mm.planDisable(rules);
        assert.strictEqual(p.steps[0].args.comment, 'PCC balance A ' + mm.MARKER);
        // กฎที่ไม่เคยมี comment ต้องไม่ได้ช่องว่างนำหน้า
        assert.strictEqual(p.steps[1].args.comment, mm.MARKER);
    });

    it('เตือนเรื่อง PCC — ปิดแล้วความเร็วรวมลดลงทันที ไม่ใช่แค่เตรียมพร้อม', () => {
        const p = mm.planDisable(rules);
        assert.ok(p.notes.some((n) => n.includes('PCC')));
    });

    it('ไม่มีอะไรให้ปิด = บอกตรง ๆ ไม่ใช่เงียบแล้วรายงานสำเร็จ', () => {
        const p = mm.planDisable([]);
        assert.strictEqual(p.count, 0);
        assert.ok(p.notes.length);
    });
});

describe('multiwan-mangle — คืนค่า', () => {
    it('คืนเฉพาะข้อที่เราปิด ไม่แตะที่ลูกค้าปิดไว้เอง', () => {
        const after = [
            { '.id': '*1', disabled: 'true', comment: 'PCC balance A ' + mm.MARKER },
            { '.id': '*2', disabled: 'true', comment: mm.MARKER },
            { '.id': '*3', disabled: 'true', comment: 'ลูกค้าปิดไว้เอง' }
        ];
        const p = mm.planRestore(after);
        assert.deepStrictEqual(p.steps.map((s) => s.id), ['*1', '*2']);
        p.steps.forEach((s) => assert.strictEqual(s.args.disabled, 'no'));
    });

    it('ลบป้ายออกจนหมด ไม่ทิ้งขยะไว้บนเราท์เตอร์', () => {
        const p = mm.planRestore([{ '.id': '*1', comment: 'PCC balance A ' + mm.MARKER }]);
        assert.strictEqual(p.steps[0].args.comment, 'PCC balance A');
    });

    it('กฎที่ไม่เคยมี comment ต้องคืนเป็นค่าว่าง ไม่ใช่ช่องว่าง', () => {
        const p = mm.planRestore([{ '.id': '*2', comment: mm.MARKER }]);
        assert.strictEqual(p.steps[0].args.comment, '');
    });

    it('ปิดแล้วคืน ต้องได้ comment เดิมกลับมาเป๊ะ — ไม่งั้นการปิดเป็นทางเดียว', () => {
        const disable = mm.planDisable(rules);
        const onRouter = disable.steps.map((s) => ({ '.id': s.id, disabled: 'true', args: null,
                                                     comment: s.args.comment }));
        const restore = mm.planRestore(onRouter);
        assert.strictEqual(restore.count, 2);
        assert.strictEqual(restore.steps[0].args.comment, 'PCC balance A');
        assert.strictEqual(restore.steps[1].args.comment, '');
    });

    it('countOurs นับเฉพาะที่มีป้าย', () => {
        assert.strictEqual(mm.countOurs([{ comment: mm.MARKER }, { comment: 'อื่น' }, {}]), 1);
    });
});
