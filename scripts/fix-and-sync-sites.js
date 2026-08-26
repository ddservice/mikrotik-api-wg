#!/usr/bin/env node
/**
 * scripts/fix-and-sync-sites.js
 * Automatically repair site configurations, WireGuard IP mappings, and test passwords.
 * 
 * Run on VPS:
 *   node scripts/fix-and-sync-sites.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const RouterOSClient = require('../routeros');

function loadPm2Env() {
    const ecoPath = path.join(__dirname, '..', 'ecosystem.config.js');
    if (!fs.existsSync(ecoPath)) return;
    try {
        const eco = require(ecoPath);
        const env = (eco.apps && eco.apps[0] && eco.apps[0].env) || {};
        for (const [k, v] of Object.entries(env)) {
            if (process.env[k] == null && v != null && v !== '') process.env[k] = String(v);
        }
    } catch (_) {}
}

loadPm2Env();

const useSupabase = !!(
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_KEY &&
    !String(process.env.SUPABASE_URL).includes('YOUR_PROJECT_ID') &&
    process.env.SUPABASE_SERVICE_KEY !== 'YOUR_SERVICE_ROLE_KEY'
);

const db = useSupabase ? require('../db-supabase') : require('../db');

// Candidate passwords from history/rotation backups
const candidatePasswords = [
    '$Atmin04910',
    'ddservice2026',
    'admin',
    ''
];

// Look for rotated passwords in ~/backups/
try {
    const backupDir = path.join(process.env.HOME || '/home/ddservice', 'backups');
    if (fs.existsSync(backupDir)) {
        const files = fs.readdirSync(backupDir).filter(f => f.startsWith('mikrotik-api-passwords-'));
        for (const file of files) {
            const content = fs.readFileSync(path.join(backupDir, file), 'utf8');
            const matches = content.matchAll(/password:\s*([^\s\r\n]+)/g);
            for (const m of matches) {
                if (m[1] && !candidatePasswords.includes(m[1])) {
                    candidatePasswords.unshift(m[1]);
                }
            }
        }
    }
} catch (_) {}

console.log('\n============================================================');
console.log('  🛠️ Repairing and Connecting All MikroTik Sites');
console.log('============================================================\n');

async function testCredentials(host, port, username, password) {
    const client = new RouterOSClient(host, port, username, password);
    try {
        await client.connect();
        const res = await client.exec('/system/resource/print');
        const ident = await client.exec('/system/identity/print');
        const routerName = (ident[0] && ident[0].name) || 'MikroTik';
        const board = (res[0] && (res[0]['board-name'] || res[0].platform)) || 'RouterOS';
        const ver = (res[0] && res[0].version) || 'v7';
        const uptime = (res[0] && res[0].uptime) || '-';
        client.close();
        return {
            ok: true,
            routerName,
            board,
            ver,
            uptime,
            password
        };
    } catch (err) {
        try { client.close(); } catch (_) {}
        return { ok: false, error: err.message };
    }
}

async function findWorkingPassword(hosts, port, username, existingPassword) {
    const pwList = [existingPassword, ...candidatePasswords].filter((v, i, a) => v !== undefined && a.indexOf(v) === i);
    for (const host of hosts) {
        for (const pw of pwList) {
            const result = await testCredentials(host, port, username, pw);
            if (result.ok) {
                return { host, port, username, password: pw, info: result };
            }
        }
    }
    return null;
}

async function main() {
    const sitesDef = [
        {
            name: 'Auioun@WiFi (Main Site)',
            hosts: ['b4a00a4696aa.sn.mynetname.net', '10.10.88.1'],
            port: 8927,
            username: 'ddserviceapi',
            connectionType: 'direct',
            wireguardIp: '10.10.88.1'
        },
        {
            name: 'TingTing@WiFi',
            hosts: ['10.10.88.2'],
            port: 8728,
            username: 'ddserviceapi',
            connectionType: 'wireguard',
            wireguardIp: '10.10.88.2'
        },
        {
            name: 'A4-Residence',
            hosts: ['10.10.88.3', 'hm60b50qefv.sn.mynetname.net'],
            port: 8728,
            username: 'ddserviceapi',
            connectionType: 'wireguard',
            wireguardIp: '10.10.88.3'
        },
        {
            name: 'Suksawad-cmu',
            hosts: ['10.10.88.4'],
            port: 8728,
            username: 'ddserviceapi',
            connectionType: 'wireguard',
            wireguardIp: '10.10.88.4'
        }
    ];

    const currentData = await db.getSites();
    const existingSites = currentData.sites || [];

    const repairedSites = [];

    for (const def of sitesDef) {
        console.log(`Testing connection for ${def.name}...`);
        const existing = existingSites.find(s => 
            (s.name && s.name.toLowerCase().includes(def.name.toLowerCase().split(' ')[0])) ||
            (s.wireguardIp === def.wireguardIp)
        );
        const existingPw = existing ? (await db.getConfig(existing.id)).password : '';

        const working = await findWorkingPassword(def.hosts, def.port, def.username, existingPw);

        if (working) {
            console.log(`  🟢 CONNECTED: "${working.info.routerName}" (${working.info.board}) on ${working.host}:${working.port}`);
            repairedSites.push({
                id: existing ? existing.id : 'site_' + Date.now() + '_' + def.wireguardIp.replace(/\./g, '_'),
                name: working.info.routerName || def.name,
                host: working.host,
                port: working.port,
                username: working.username,
                password: working.password,
                connectionType: def.connectionType,
                wireguardIp: def.wireguardIp,
                wireguardPublicKey: existing ? (existing.wireguardPublicKey || '') : '',
                dnsLoggingEnabled: true,
                is_active: repairedSites.length === 0
            });
        } else {
            console.log(`  ⚠️ Could not auto-authenticate ${def.name} with candidate passwords.`);
            repairedSites.push({
                id: existing ? existing.id : 'site_' + Date.now() + '_' + def.wireguardIp.replace(/\./g, '_'),
                name: def.name,
                host: def.hosts[0],
                port: def.port,
                username: def.username,
                password: existingPw || '$Atmin04910',
                connectionType: def.connectionType,
                wireguardIp: def.wireguardIp,
                wireguardPublicKey: existing ? (existing.wireguardPublicKey || '') : '',
                dnsLoggingEnabled: true,
                is_active: repairedSites.length === 0
            });
        }
    }

    // Save repaired sites into local db/config.json
    const configPath = path.join(__dirname, '..', 'db', 'config.json');
    const newConfigData = {
        activeSiteId: repairedSites[0].id,
        sites: repairedSites
    };

    fs.writeFileSync(configPath, JSON.stringify(newConfigData, null, 4), 'utf8');
    console.log(`\n✅ Saved ${repairedSites.length} repaired sites into ${configPath}`);

    // If Supabase is active, also sync to Supabase
    if (useSupabase) {
        try {
            for (const s of repairedSites) {
                await db.updateSite(s.id, s).catch(async () => {
                    await db.addSite(s);
                });
            }
            console.log(`✅ Synced repaired sites to Supabase.`);
        } catch (supErr) {
            console.warn(`[Supabase sync warning]:`, supErr.message);
        }
    }

    console.log('\n🎉 Repair Complete! Run: pm2 reload ecosystem.config.js --update-env\n');
}

main().catch(console.error);
