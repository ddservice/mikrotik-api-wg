/**
 * เทสต์การคำนวณสัดส่วนแบ่งโหลด PCC
 *
 * ถ้าสัดส่วนผิด line ที่ช้ากว่าจะรับงานเกินตัวและกลายเป็นคอขวดของทั้งสาขา —
 * ซึ่งจะดูเหมือน "ทำโหลดบาลานซ์แล้วเน็ตแย่ลง" ทั้งที่ตั้งค่าครบทุกอย่าง
 */

const assert = require('assert');
const { gcd, pccWeights, describeWeights, MAX_TOTAL_WEIGHT } = require('../lib/pcc-weights');

describe('pcc-weights — gcd', () => {
    it('หารร่วมมากพื้นฐาน', () => {
        assert.strictEqual(gcd(1000, 500), 500);
        assert.strictEqual(gcd(300, 200), 100);
        assert.strictEqual(gcd(7, 13), 1);
    });
    it('สลับลำดับได้ผลเท่ากัน', () => {
        assert.strictEqual(gcd(500, 1000), gcd(1000, 500));
    });
    it('ศูนย์ไม่ทำให้พัง', () => {
        assert.strictEqual(gcd(0, 5), 5);
        assert.strictEqual(gcd(0, 0), 0);
    });
});

describe('pcc-weights — pccWeights', () => {
    it('1000/500 ย่อเหลือ 2:1', () => {
        assert.deepStrictEqual(pccWeights([1000, 500]), [2, 1]);
    });

    it('ความเร็วเท่ากันได้ 1:1 ไม่ใช่ 500:500', () => {
        assert.deepStrictEqual(pccWeights([500, 500]), [1, 1]);
    });

    it('รองรับ 3 lines', () => {
        assert.deepStrictEqual(pccWeights([600, 300, 300]), [2, 1, 1]);
    });

    it('ตัวเลขที่หารกันไม่ลงตัวก็ยังได้อัตราส่วนที่ใช้ได้', () => {
        const w = pccWeights([700, 300]);
        assert.strictEqual(w.length, 2);
        assert.ok(w[0] > w[1], 'line ที่เร็วกว่าต้องได้ weight มากกว่า');
        assert.ok(w.every((x) => Number.isInteger(x) && x >= 1));
    });

    it('line ที่เร็วเท่ากันต้องได้ weight เท่ากันเสมอ แม้ตอนย่อ', () => {
        // บั๊กจริงที่เจอตอนรันกับเราท์เตอร์จำลอง: 500/500/50 ออกมาเป็น 9:10:1
        // เพราะวิธีย่อเดิมไล่ตัดตัวที่ใหญ่ที่สุดทีละหนึ่ง ทำให้ line ที่เท่ากัน
        // กลายเป็นไม่เท่ากัน — สาขาจะเอียงไป line หนึ่งโดยไม่มีเหตุผล
        assert.deepStrictEqual(pccWeights([500, 500, 50]), [10, 10, 1]);
        const w = pccWeights([900, 900, 900, 7]);
        assert.strictEqual(w[0], w[1]);
        assert.strictEqual(w[1], w[2]);
    });

    it('ไม่ปล่อยให้ผลรวมใหญ่จนกลายเป็น mangle เป็นร้อยข้อ', () => {
        // 997:31 ถ้าไม่ย่อจะได้กฎ mangle 1028 ข้อ ซึ่งกินซีพียูทุกแพ็กเก็ต
        const w = pccWeights([997, 31]);
        const total = w.reduce((a, b) => a + b, 0);
        assert.ok(total <= MAX_TOTAL_WEIGHT, 'ผลรวมต้องไม่เกินเพดาน แต่ได้ ' + total);
        assert.ok(w.every((x) => x >= 1), 'ทุก line ต้องได้อย่างน้อย 1 ไม่งั้นถูกตัดออกจากการแบ่งโหลด');
        assert.ok(w[0] > w[1], 'ย่อแล้วสัดส่วนต้องยังสะท้อนว่า line แรกเร็วกว่ามาก');
        // 997/31 = 32.2 เท่า ย่อแล้วต้องยังใกล้เคียง ไม่ใช่เพี้ยนไปคนละเรื่อง
        assert.ok(w[0] / w[1] > 20, 'สัดส่วนหลังย่อต้องยังใกล้ของจริง');
    });

    it('ไม่รู้ความเร็วแม้ line เดียว = คำนวณไม่ได้ ต้องคืน null ไม่ใช่เดา', () => {
        assert.strictEqual(pccWeights([500, 0]), null);
        assert.strictEqual(pccWeights([500, null]), null);
        assert.strictEqual(pccWeights([500, undefined]), null);
    });

    it('มี line เดียวหรือไม่มีเลย = null', () => {
        assert.strictEqual(pccWeights([500]), null);
        assert.strictEqual(pccWeights([]), null);
        assert.strictEqual(pccWeights(null), null);
    });
});

describe('pcc-weights — describeWeights', () => {
    it('อธิบายเป็นประโยคที่คนอ่านแล้วเห็นภาพ', () => {
        const t = describeWeights(['pppoe-out1', 'ether2'], [2, 1]);
        assert.ok(t.includes('2:1'));
        assert.ok(t.includes('ทุก 3 connection'));
        assert.ok(t.includes('pppoe-out1 2'));
    });
    it('ไม่มี weight = ข้อความว่าง ไม่พัง', () => {
        assert.strictEqual(describeWeights(['a'], []), '');
        assert.strictEqual(describeWeights(['a'], null), '');
    });
});
