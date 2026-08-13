#!/usr/bin/env node
/**
 * Rotate MikroTik API user passwords for sites stored in the dashboard DB,
 * then write the new password back to the same site row (Supabase or local JSON).
 *
 * Why: db/config.json was once committed with a live router password. That
 * credential must be treated as burned even after git untracking.
 *
 * Usage (on VPS, from /home/ddservice/mikrotik, with real SUPABASE_* in env
 * or via: node -r ./scripts/load-pm2-env.js …):
 *
 *   node scripts/rotate-mikrotik-api-password.js              # dry-run
 *   node scripts/rotate-mikrotik-api-password.js --apply       # all ready sites
 *   node scripts/rotate-mikrotik-api-password.js --apply --site <id|name>
 *
 * New passwords are written once to:
 *   ~/backups/mikrotik-api-passwords-YYYYMMDD-HHMMSS.txt  (mode 0600)
 * Read that file, store offline, then delete it.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const RouterOSClient = require('../routeros');

function loadPm2EnvFallback() {
    const ecoPath = path.join(__dirname, '..', 'ecosystem.config.js');
    if (!fs.existsSync(ecoPath)) return;
    try {
        const eco = require(ecoPath);
        const env = (eco.apps && eco.apps[0] && eco.apps[0].env) || {};
        for (const [k, v] of Object.entries(env)) {
            if (process.env[k] == null && v != null && v !== '') process.env[k] = String(v);
        }
    } catch (_) {
        /* ignore */
    }
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
    const out = { apply: false, site: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--apply') out.apply = true;
        else if (a === '--site') out.site = argv[++i] || null;
        else if (a.startsWith('--site=')) out.site = a.slice('--site='.length);
    }
    return out;
}

function genPassword(bytes = 18) {
    // URL-safe, no ambiguous punctuation that WinBox/scripts mishandle
    return crypto.randomBytes(bytes).toString('base64url');
}

async function findUserId(client, username) {
    const users = await client.exec('/user/print');
    const hit = (users || []).find((u) => u.name === username);
    if (!hit) throw new Error(`RouterOS user "${username}" not found`);
    return hit['.id'];
}

async function rotateOne(site, { apply, secretsOut }) {
    const label = `${site.name} (${site.id})`;
    if (!site.host || !site.username) {
        return { label, status: 'skip', detail: 'missing host/username' };
    }
    if (!site.password) {
        return { label, status: 'skip', detail: 'no password in DB — set via UI first' };
    }

    const client = new RouterOSClient(site.host, site.port || 8728, site.username, site.password);
    try {
        await client.connect();
    } catch (err) {
        return { label, status: 'fail', detail: `connect with current DB password: ${err.message}` };
    }

    try {
        await findUserId(client, site.username);
        if (!apply) {
            client.close();
            return { label, status: 'dry-run-ok', detail: `can login as ${site.username}@${site.host}:${site.port || 8728}` };
        }

        const newPassword = genPassword();
        const userId = await findUserId(client, site.username);
        await client.exec('/user/set', { '.id': userId, password: newPassword });
        client.close();

        // Verify new password before updating DB
        const verify = new RouterOSClient(site.host, site.port || 8728, site.username, newPassword);
        try {
            await verify.connect();
            verify.close();
        } catch (err) {
            return {
                label,
                status: 'fail',
                detail: `router password changed but verify failed (${err.message}). DB NOT updated — fix manually on router.`
            };
        }

        await db.updateSite(site.id, { password: newPassword });
        secretsOut.push({
            siteId: site.id,
            siteName: site.name,
            host: site.host,
            port: site.port || 8728,
            username: site.username,
            password: newPassword,
            rotatedAt: new Date().toISOString()
        });
        return { label, status: 'rotated', detail: 'router + DB updated' };
    } catch (err) {
        try { client.close(); } catch (_) { /* ignore */ }
        return { label, status: 'fail', detail: err.message };
    }
}

async function main() {
    const args = parseArgs(process.argv);
    console.log(`[rotate] DB backend: ${useSupabase ? 'supabase' : 'local-json'}`);
    console.log(`[rotate] mode: ${args.apply ? 'APPLY' : 'dry-run (pass --apply to change)'}`);

    const data = await db.getSites();
    let sites = data.sites || [];
    if (args.site) {
        const q = String(args.site).toLowerCase();
        sites = sites.filter((s) => s.id === args.site || String(s.name).toLowerCase() === q);
        if (!sites.length) {
            console.error(`[rotate] no site matched --site ${args.site}`);
            process.exit(1);
        }
    }

    const secretsOut = [];
    const results = [];
    for (const site of sites) {
        // getSites may sanitize password away — reload full config per site
        const full = await db.getConfig(site.id);
        const merged = { ...site, ...full, id: site.id, name: site.name || full.name };
        const r = await rotateOne(merged, { apply: args.apply, secretsOut });
        results.push(r);
        console.log(`[${r.status}] ${r.label} — ${r.detail}`);
    }

    if (args.apply && secretsOut.length) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const dir = path.join(os.homedir(), 'backups');
        fs.mkdirSync(dir, { recursive: true });
        const outFile = path.join(dir, `mikrotik-api-passwords-${stamp}.txt`);
        const body = [
            '# MikroTik API passwords — READ ONCE, store offline, then DELETE this file',
            `# generated: ${new Date().toISOString()}`,
            '',
            ...secretsOut.map((s) =>
                [
                    `site: ${s.siteName}`,
                    `id: ${s.siteId}`,
                    `host: ${s.host}`,
                    `port: ${s.port}`,
                    `username: ${s.username}`,
                    `password: ${s.password}`,
                    `rotatedAt: ${s.rotatedAt}`,
                    '---'
                ].join('\n')
            )
        ].join('\n');
        fs.writeFileSync(outFile, body, { mode: 0o600 });
        try { fs.chmodSync(outFile, 0o600); } catch (_) { /* Windows */ }
        console.log(`[rotate] wrote ${secretsOut.length} secret(s) to ${outFile}`);
        console.log('[rotate] copy secrets offline, then: rm ' + outFile);
    }

    const failed = results.filter((r) => r.status === 'fail');
    if (failed.length) process.exit(2);
}

main().catch((err) => {
    console.error('[rotate] fatal:', err.message || err);
    process.exit(1);
});
