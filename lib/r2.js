/**
 * lib/r2.js — ไคลเอนต์ Cloudflare R2 แบบไม่มี dependency (AWS SigV4 เขียนเอง)
 *
 * หมายเหตุ: backup.js มีตัว uploader ของตัวเองอยู่ก่อนแล้วและทำงานได้ดี
 * จงใจไม่ไปแก้ของเดิม (ทำงานอยู่บน production ทุกคืน) โมดูลนี้จึงเป็นตัวใหม่
 * สำหรับโค้ดที่เขียนหลังจากนี้ — ถ้าจะรวมกันในอนาคต ให้ย้าย backup.js มาใช้ตัวนี้
 * แล้วทดสอบการสำรองข้อมูลจริงหนึ่งรอบก่อน
 */

const crypto = require('crypto');
const https = require('https');

function cfg() {
    return {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
        endpoint: process.env.R2_ENDPOINT || '',
        bucket: process.env.R2_BUCKET || 'ddservicedb'
    };
}

function isConfigured() {
    const c = cfg();
    return !!(c.accessKeyId && c.secretAccessKey && c.endpoint);
}

function signingKey(secret, dateStamp, region, service) {
    const kDate = crypto.createHmac('sha256', 'AWS4' + secret).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    return crypto.createHmac('sha256', kService).update('aws4_request').digest();
}

/**
 * ยิง request ไป R2 พร้อมลายเซ็น SigV4
 * @param {object} opts
 *   method       - 'GET' | 'PUT' | 'POST' | 'DELETE'
 *   key          - object key (ไม่ต้องมี bucket นำหน้า) — เว้นว่างได้สำหรับ list
 *   body         - Buffer หรือ string
 *   query        - object ของ query string
 *   contentType  - สำหรับ PUT
 *   raw          - true = คืน Buffer ดิบ (ใช้ตอนดาวน์โหลดไฟล์ .gz)
 */
function request(opts) {
    return new Promise((resolve, reject) => {
        const c = cfg();
        if (!isConfigured()) return reject(new Error('ยังไม่ได้ตั้งค่า R2 (R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_ENDPOINT)'));

        const host = new URL(c.endpoint).hostname;
        const region = 'auto';
        const service = 's3';
        const payload = opts.body || '';
        const payloadBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);

        const now = new Date();
        const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
        const dateStamp = amzDate.slice(0, 8);
        const payloadHash = crypto.createHash('sha256').update(payloadBuf).digest('hex');

        // path-style: /<bucket>/<key>
        const canonicalUri = '/' + encodeURI(c.bucket + (opts.key ? '/' + opts.key : ''));

        // query string ต้องเรียงตามตัวอักษรตอนเซ็น ไม่งั้นลายเซ็นไม่ตรง
        const qs = Object.entries(opts.query || {})
            .map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)])
            .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
            .map(([k, v]) => `${k}=${v}`)
            .join('&');

        const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
        const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
        const canonicalRequest = [opts.method, canonicalUri, qs, canonicalHeaders, signedHeaders, payloadHash].join('\n');

        const scope = `${dateStamp}/${region}/${service}/aws4_request`;
        const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope,
            crypto.createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');
        const sig = crypto.createHmac('sha256', signingKey(c.secretAccessKey, dateStamp, region, service))
            .update(stringToSign).digest('hex');

        const headers = {
            Host: host,
            'x-amz-date': amzDate,
            'x-amz-content-sha256': payloadHash,
            Authorization: `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`
        };
        if (payloadBuf.length) {
            headers['Content-Length'] = payloadBuf.length;
            headers['Content-Type'] = opts.contentType || 'application/octet-stream';
        }

        const req = https.request({
            hostname: host,
            path: canonicalUri + (qs ? '?' + qs : ''),
            method: opts.method,
            headers,
            timeout: opts.timeoutMs || 60000
        }, (res) => {
            const chunks = [];
            res.on('data', (ch) => chunks.push(ch));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    return resolve(opts.raw ? buf : buf.toString('utf8'));
                }
                reject(new Error(`R2 ${opts.method} ${opts.key || ''} -> HTTP ${res.statusCode}: ${buf.toString('utf8').slice(0, 300)}`));
            });
        });

        // option `timeout` ของ https ตั้งแค่ตัวจับเวลา socket ไม่ยกเลิก request ให้
        // ต้อง destroy เอง ไม่งั้นค้างจนกว่า OS จะ timeout (บทเรียนเดิมจาก routeros.js)
        req.on('timeout', () => req.destroy(new Error('R2 ไม่ตอบกลับภายในเวลาที่กำหนด')));
        req.on('error', reject);
        if (payloadBuf.length) req.write(payloadBuf);
        req.end();
    });
}

async function putObject(key, buffer, contentType) {
    await request({ method: 'PUT', key, body: buffer, contentType });
    return key;
}

async function getObject(key) {
    return request({ method: 'GET', key, raw: true });
}

module.exports = { isConfigured, putObject, getObject, request, cfg };
