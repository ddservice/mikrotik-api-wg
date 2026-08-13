#!/usr/bin/env node
/**
 * Probe live PPPoE sessions and confirm dynamic interface names expose rx/tx.
 *
 *   node scripts/verify-pppoe-bytes.js
 *   node scripts/verify-pppoe-bytes.js --site <id|name>
 */

'use strict';

const fs = require('fs');
const path = require('path');
const RouterOSClient = require('../routeros');
const { resolvePppoeIface, pppoeIfaceCandidates } = require('../lib/pppoe-iface');

function loadPm2EnvFallback() {
    const ecoPath = path.join(__dirname, '..', 'ecosystem.config.js');
    if (!fs.existsSync(ecoPath)) return;
    try {
        const eco = require(ecoPath);
        const env = (eco.apps && eco.apps[0] && eco.apps[0].env) || {};
        for (const [k, v] of Object.entries(env)) {
            if (process.env[k] == null && v != null && v !== '') process.env[k] = String(v);
        }
    } catch (_) { /* ignore */ }
}

loadPm2EnvFallback();

const useSupabase = !!(
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_KEY &&
    !String(process.env.SUPABASE_URL).includes('YOUR_PROJECT_ID') &&
    process.env.SUPABASE_SERVICE_KEY !== 'YOUR_SERVICE_ROLE_KEY'
);
const db = useSupabase ? require('../db-supabase') : require('../db');

function parseArgs(argv) {
    let site = null;
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--site') site = argv[++i] || null;
        else if (argv[i].startsWith('--site=')) site = argv[i].slice('--site='.length);
    }
    return { site };
}

async function probeSite(site) {
    const full = await db.getConfig(site.id);
    const host = full.host || site.host;
    const username = full.username || site.username;
    const password = full.password || site.password;
    const port = full.port || site.port || 8728;
    if (!host || !username || !password) {
        return { site: site.name, status: 'skip', detail: 'incomplete credentials' };
    }

    const client = new RouterOSClient(host, port, username, password);
    await client.connect();
    try {
        const [active, interfaces] = await Promise.all([
            client.exec('/ppp/active/print'),
            client.exec('/interface/print')
        ]);
        const ifaceByName = new Map((interfaces || []).map((i) => [i.name, i]));
        const sessions = (active || []).filter((i) => i.service === 'pppoe');
        const rows = sessions.map((item) => {
            const iface = resolvePppoeIface(ifaceByName, item.name);
            const matched = iface ? iface.name : null;
            return {
                user: item.name,
                matched,
                tried: pppoeIfaceCandidates(item.name),
                rx: iface ? parseInt(iface['rx-byte'], 10) || 0 : null,
                tx: iface ? parseInt(iface['tx-byte'], 10) || 0 : null
            };
        });
        const unmatched = rows.filter((r) => !r.matched).length;
        const zeroBoth = rows.filter((r) => r.matched && r.rx === 0 && r.tx === 0).length;
        return {
            site: site.name,
            status: 'ok',
            sessions: rows.length,
            unmatched,
            zeroBoth,
            sampleIfaceNames: [...ifaceByName.keys()].filter((n) => /pppoe/i.test(n)).slice(0, 12),
            rows
        };
    } finally {
        client.close();
    }
}

async function main() {
    const args = parseArgs(process.argv);
    console.log(`[verify-pppoe] DB: ${useSupabase ? 'supabase' : 'local-json'}`);
    const data = await db.getSites();
    let sites = data.sites || [];
    if (args.site) {
        const q = String(args.site).toLowerCase();
        sites = sites.filter((s) => s.id === args.site || String(s.name).toLowerCase() === q);
    }
    for (const site of sites) {
        try {
            const r = await probeSite(site);
            console.log(JSON.stringify(r, null, 2));
        } catch (err) {
            console.log(JSON.stringify({ site: site.name, status: 'fail', detail: err.message }, null, 2));
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
