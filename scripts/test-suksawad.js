#!/usr/bin/env node
/**
 * scripts/test-suksawad.js
 * Test connectivity, ports, and credentials specifically for Suksawad-cmu (10.10.88.4)
 * 
 * Run on VPS:
 *   node scripts/test-suksawad.js [username] [password]
 */

'use strict';

const net = require('net');
const RouterOSClient = require('../routeros');

const targetIp = '10.10.88.4';
const customUser = process.argv[2];
const customPw = process.argv[3];

console.log('\n============================================================');
console.log(`  🔍 Testing Suksawad-cmu Router (${targetIp})`);
console.log('============================================================\n');

async function testTcp(port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(3000);
        socket.on('connect', () => {
            socket.destroy();
            resolve({ ok: true });
        });
        socket.on('timeout', () => {
            socket.destroy();
            resolve({ ok: false, error: 'Connection Timeout' });
        });
        socket.on('error', (err) => {
            socket.destroy();
            resolve({ ok: false, error: err.message });
        });
        socket.connect(port, targetIp);
    });
}

async function testLogin(port, username, password) {
    const client = new RouterOSClient(targetIp, port, username, password);
    try {
        await client.connect();
        const res = await client.exec('/system/resource/print');
        const ident = await client.exec('/system/identity/print');
        const name = (ident[0] && ident[0].name) || 'MikroTik';
        const board = (res[0] && (res[0]['board-name'] || res[0].platform)) || 'RouterOS';
        const ver = (res[0] && res[0].version) || 'v7';
        client.close();
        return { ok: true, name, board, ver };
    } catch (e) {
        try { client.close(); } catch (_) {}
        return { ok: false, error: e.message };
    }
}

async function run() {
    // 1. Port Scan
    console.log('1. Checking TCP Ports on 10.10.88.4:');
    for (const port of [8728, 8927, 8729, 80, 8291]) {
        const r = await testTcp(port);
        console.log(`   - Port ${port}: ${r.ok ? '🟢 OPEN (Connected)' : '🔴 CLOSED / TIMEOUT (' + r.error + ')'}`);
    }

    // 2. Credential Test
    console.log('\n2. Testing API Login (Port 8728):');

    if (customUser !== undefined) {
        console.log(`   Trying provided user "${customUser}" with password "${customPw || ''}"...`);
        const res = await testLogin(8728, customUser, customPw || '');
        if (res.ok) {
            console.log(`   🟢 SUCCESS! Identity: "${res.name}", Model: ${res.board}, ROS: ${res.ver}`);
            return;
        } else {
            console.log(`   🔴 FAILED: ${res.error}`);
        }
    }

    const testList = [
        { u: 'admin', p: '' },
        { u: 'admin', p: 'admin' },
        { u: 'admin', p: '$Atmin04910' },
        { u: 'ddserviceapi', p: '$Atmin04910' },
        { u: 'ddserviceapi', p: '' },
        { u: 'ddservice', p: '$Atmin04910' },
        { u: 'ddservice', p: 'ddservice2026' }
    ];

    for (const item of testList) {
        const res = await testLogin(8728, item.u, item.p);
        if (res.ok) {
            console.log(`   🟢 SUCCESS with username "${item.u}" & password "${item.p}"!`);
            console.log(`      Identity: "${res.name}", Model: ${res.board}, ROS: ${res.ver}`);
            
            // Auto update config.json
            const fs = require('fs');
            const path = require('path');
            const cfgPath = path.join(__dirname, '..', 'db', 'config.json');
            if (fs.existsSync(cfgPath)) {
                const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
                const site = cfg.sites.find(s => s.wireguardIp === '10.10.88.4' || s.host === '10.10.88.4');
                if (site) {
                    site.username = item.u;
                    site.password = item.p;
                    site.name = res.name || site.name;
                    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 4), 'utf8');
                    console.log(`\n   ✅ Automatically saved correct credentials to db/config.json!`);
                }
            }
            return;
        } else {
            console.log(`   ❌ [${item.u}] ${res.error}`);
        }
    }

    console.log('\n👉 If all above failed, specify username and password manually:');
    console.log('   node scripts/test-suksawad.js <username> <password>\n');
}

run().catch(console.error);
