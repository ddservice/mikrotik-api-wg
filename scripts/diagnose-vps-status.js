#!/usr/bin/env node
/**
 * scripts/diagnose-vps-status.js
 * Comprehensive diagnostic tool to inspect all sites, WireGuard status, and test router connections.
 * 
 * Run on VPS:
 *   node scripts/diagnose-vps-status.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns').promises;
const { execSync } = require('child_process');

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
const RouterOSClient = require('../routeros');

console.log('\n============================================================');
console.log('  🔍 MikroTik Dashboard — Complete System & Site Diagnostics');
console.log('============================================================');
console.log(`📌 Database Mode: ${useSupabase ? 'Supabase Cloud Database (' + process.env.SUPABASE_URL + ')' : 'Local File JSON (db/config.json)'}`);

// Check WireGuard on VPS
console.log('\n--- 1. WireGuard Status on VPS (`wg show wg0`) ---');
try {
    const wgShow = execSync('sudo wg show wg0', { encoding: 'utf8' });
    console.log(wgShow.trim());
} catch (e) {
    console.log(`[!] Could not run sudo wg show wg0: ${e.message}`);
}

async function testTcp(host, port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(3500);
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
        socket.connect(port, host);
    });
}

async function run() {
    console.log('\n--- 2. Checking Registered Sites in Database ---');
    let sitesData;
    try {
        sitesData = await db.getSites();
    } catch (e) {
        console.error(`❌ Failed to read sites from DB: ${e.message}`);
        return;
    }

    const sites = (sitesData && sitesData.sites) || [];
    console.log(`Found ${sites.length} site(s) in database (Active Site: ${sitesData.activeSiteId}):\n`);

    for (let i = 0; i < sites.length; i++) {
        const s = sites[i];
        const cfg = await db.getConfig(s.id);
        console.log(`------------------------------------------------------------`);
        console.log(`📍 Site #${i + 1}: ${cfg.name} (ID: ${cfg.id})`);
        console.log(`   Host: ${cfg.host}:${cfg.port} | User: ${cfg.username} | Has Password: ${!!cfg.password} | Connection: ${cfg.connectionType}`);

        // Step A: DNS
        let resolvedIp = cfg.host;
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(cfg.host)) {
            try {
                const lookup = await dns.lookup(cfg.host);
                resolvedIp = lookup.address;
                console.log(`   [DNS] ✅ Resolved ${cfg.host} -> ${resolvedIp}`);
            } catch (err) {
                console.log(`   [DNS] ❌ Failed to resolve ${cfg.host}: ${err.message}`);
                continue;
            }
        }

        // Step B: TCP Port
        const tcp = await testTcp(resolvedIp, cfg.port);
        if (!tcp.ok) {
            console.log(`   [TCP Socket] ❌ Port ${cfg.port} unreachable: ${tcp.error}`);
            console.log(`   👉 TIP: Check if WireGuard peer is connected or if RouterOS API service is enabled on port ${cfg.port}`);
            continue;
        }
        console.log(`   [TCP Socket] ✅ Connected to ${resolvedIp}:${cfg.port}`);

        // Step C: API Auth
        const client = new RouterOSClient(cfg.host, cfg.port, cfg.username, cfg.password);
        try {
            await client.connect();
            const res = await client.exec('/system/resource/print');
            const ident = await client.exec('/system/identity/print');
            const routerName = (ident[0] && ident[0].name) || 'MikroTik';
            const board = (res[0] && (res[0]['board-name'] || res[0].platform)) || 'RouterOS';
            const ver = (res[0] && res[0].version) || 'v7';
            const uptime = (res[0] && res[0].uptime) || '-';
            console.log(`   [RouterOS API] 🟢 ONLINE! Identity: "${routerName}", Model: ${board}, ROS: ${ver}, Uptime: ${uptime}`);
            client.close();
        } catch (authErr) {
            console.log(`   [RouterOS API] 🔴 AUTH/API ERROR: ${authErr.message}`);
            console.log(`   👉 TIP: Verify username "${cfg.username}" and password on the router.`);
            try { client.close(); } catch (_) {}
        }
    }
    console.log(`\n============================================================\n`);
}

run().catch(console.error);
