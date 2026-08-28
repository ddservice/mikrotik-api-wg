#!/usr/bin/env node
/**
 * validate-html.js — โครงสร้าง HTML sanity check สำหรับ public/index.html
 *
 * เพิ่มมาหลังเหตุการณ์ 2026-08-28: `<div>` ที่ไม่ปิด 3 จุดทำให้เบราว์เซอร์
 * เอาโมดัล 8 ตัวไปซ้อนอยู่ในโมดัลอื่น (ที่มี opacity:0) — ปุ่มกดแล้ว "ไม่มีอะไร
 * เกิดขึ้น" ทั้งที่ JS ทำงานถูกต้อง กินเวลาแก้ผิดจุดไป 3 คอมมิต
 *
 * ตรวจ 4 อย่าง (ทั้งหมดเป็น static — ไม่ต้องเปิดเบราว์เซอร์ ไม่ต้องมี dependency):
 *   1. แท็กปิดครบ — ไล่ stack หา <tag> ที่เปิดค้าง / </tag> ที่เกินมา
 *   2. id ซ้ำ — getElementById จะคืนตัวแรกเสมอ ทำให้ตัวที่สองกลายเป็น dead markup
 *   3. <form> ซ้อน <form> — HTML ห้าม เบราว์เซอร์จะทิ้งฟอร์มด้านในไปเลย
 *   4. .modal-wrapper ทุกตัวต้องอยู่ระดับบนสุด ไม่ซ้อนกันเอง
 *
 * ใช้: node scripts/validate-html.js [file...]   (default: public/index.html)
 * exit 0 = ผ่าน, exit 1 = เจอปัญหา
 */

const fs = require('fs');
const path = require('path');

const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

// แทนที่เนื้อหาด้วยช่องว่างจำนวนเท่าเดิม เพื่อให้เลขบรรทัดยังตรงกับไฟล์จริง
function blankOut(src, regex) {
    return src.replace(regex, (m) => m.replace(/[^\n]/g, ' '));
}

function lineOf(src, index) {
    let line = 1;
    for (let i = 0; i < index; i++) if (src[i] === '\n') line++;
    return line;
}

function validate(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');
    const errors = [];

    // เอา comment / script / style ออกก่อน (แต่คงเลขบรรทัดไว้)
    let src = blankOut(raw, /<!--[\s\S]*?-->/g);
    src = blankOut(src, /<script\b[^>]*>[\s\S]*?<\/script>/gi);
    src = blankOut(src, /<style\b[^>]*>[\s\S]*?<\/style>/gi);

    const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*?)(\/?)>/g;
    const stack = [];
    const ids = new Map();
    const modalStack = [];
    let match;

    while ((match = tagRe.exec(src)) !== null) {
        const [, closing, rawTag, attrs, selfClosing] = match;
        const tag = rawTag.toLowerCase();
        const line = lineOf(src, match.index);

        if (!closing) {
            const idMatch = /\bid\s*=\s*["']([^"']+)["']/.exec(attrs);
            if (idMatch) {
                const id = idMatch[1];
                if (ids.has(id)) {
                    errors.push(
                        `id ซ้ำ: "${id}" ที่บรรทัด ${line} (ตัวแรกอยู่บรรทัด ${ids.get(id)}) ` +
                        `— getElementById จะเห็นแค่ตัวแรก`
                    );
                } else {
                    ids.set(id, line);
                }
            }

            const isModal = /\bclass\s*=\s*["'][^"']*\bmodal-wrapper\b/.test(attrs);
            if (isModal) {
                if (modalStack.length) {
                    errors.push(
                        `.modal-wrapper ซ้อนกัน: ${idMatch ? '#' + idMatch[1] : '<' + tag + '>'} ` +
                        `ที่บรรทัด ${line} อยู่ข้างใน ${modalStack[modalStack.length - 1].label} ` +
                        `(บรรทัด ${modalStack[modalStack.length - 1].line}) — โมดัลแม่ที่ opacity:0 ` +
                        `จะทำให้โมดัลลูกมองไม่เห็นตลอดกาล`
                    );
                }
                if (!VOID_TAGS.has(tag) && selfClosing !== '/') {
                    modalStack.push({
                        depth: stack.length,
                        line,
                        label: idMatch ? '#' + idMatch[1] : '<' + tag + '>'
                    });
                }
            }

            if (tag === 'form') {
                const outerForm = stack.find((e) => e.tag === 'form');
                if (outerForm) {
                    errors.push(
                        `<form> ซ้อน <form>: บรรทัด ${line} อยู่ใน <form> บรรทัด ${outerForm.line} ` +
                        `— เบราว์เซอร์จะทิ้งฟอร์มด้านในทั้งอัน`
                    );
                }
            }

            if (!VOID_TAGS.has(tag) && selfClosing !== '/') {
                stack.push({ tag, line });
            }
            continue;
        }

        if (VOID_TAGS.has(tag)) continue;

        const top = stack[stack.length - 1];
        if (top && top.tag === tag) {
            stack.pop();
        } else {
            // หาแท็กเดียวกันที่เปิดค้างอยู่ลึกลงไป — ทุกตัวที่อยู่เหนือมันคือตัวที่ลืมปิด
            let found = -1;
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].tag === tag) { found = i; break; }
            }
            if (found === -1) {
                errors.push(`</${tag}> เกินมา ที่บรรทัด ${line} — ไม่มีแท็กเปิดคู่กัน`);
            } else {
                for (let i = stack.length - 1; i > found; i--) {
                    errors.push(
                        `<${stack[i].tag}> ที่เปิดบรรทัด ${stack[i].line} ไม่ได้ปิด ` +
                        `(เจอตอน </${tag}> บรรทัด ${line} ปิดข้ามหัวมัน)`
                    );
                }
                stack.length = found;
            }
        }

        while (modalStack.length && modalStack[modalStack.length - 1].depth >= stack.length) {
            modalStack.pop();
        }
    }

    stack.forEach((e) => {
        errors.push(`<${e.tag}> ที่เปิดบรรทัด ${e.line} ไม่ได้ปิดจนจบไฟล์`);
    });

    return errors;
}

const targets = process.argv.slice(2);
const files = targets.length
    ? targets
    : [path.join(__dirname, '..', 'public', 'index.html')];

let failed = false;
for (const file of files) {
    const rel = path.relative(process.cwd(), file) || file;
    if (!fs.existsSync(file)) {
        console.error(`✗ ${rel} — ไม่พบไฟล์`);
        failed = true;
        continue;
    }
    const errors = validate(file);
    if (errors.length) {
        failed = true;
        console.error(`✗ ${rel} — เจอ ${errors.length} ปัญหา:`);
        errors.forEach((e) => console.error(`    • ${e}`));
    } else {
        console.log(`✓ ${rel} — โครงสร้าง HTML สมบูรณ์`);
    }
}

process.exit(failed ? 1 : 0);
