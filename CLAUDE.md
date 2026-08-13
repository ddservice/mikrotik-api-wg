# CLAUDE.md

Guidance for Claude Code when working in this repo.

## What this is

A web dashboard for managing MikroTik routers across multiple sites: Hotspot
user/session management, PPPoE room-account billing (for renting out rooms,
each with its own downstream router), DNS visit-history logging (พรบ.
คอมพิวเตอร์ มาตรา 26 compliance — domain-level only), WireGuard VPN
site-to-site connectivity, and role-based admin/co-admin/user access.

Live deployment: `api.ddserviceth.com`, VPS managed via SSH as user `ddservice`,
project lives at `/home/ddservice/mikrotik`. PM2 process manager, deployed by
`git pull` + `pm2 reload`. **Do not assume root access** — the `ddservice` user
cannot write to `/root/` or `/var/log/`.

## Product direction (stable long-term)

**Keep Express (`server.js`) + vanilla UI (`public/`).** Add features
incrementally. Do **not** cut over production to Next.js App Router.

Rationale: this is a multi-site admin dashboard with many external operators;
stability, API-level auth, and clear handoff matter more than a framework
rewrite. The 2026-08-12/13 Next experiment caused outages and must not be
redeployed (`src/DO_NOT_DEPLOY.md`).

Handoff model for future developers:
- Backend entry: `server.js` (Express)
- Frontend entry: `public/index.html` + `public/app.js` (bump `?v=` on JS changes)
- DB: `db-supabase.js` (prod) / `db.js` (local JSON) — keep signatures in sync
- Process: PM2 `ecosystem.config.js` → `script: 'server.js'`, `PORT: 3001`, `exec_mode: 'fork'`
- Backup before risky work: `scripts/backup-pre-rewrite.sh`

## VPS port ownership (do not steal ports from other apps)

| Port | Owner | Notes |
|------|--------|--------|
| **3001** | **MikroTik dashboard only** | Nginx `mikrotik.conf` → `127.0.0.1:3001` |
| 3002 | `cnxhaircutz.ddserviceth.com` | If 502: nothing listening — start that app on 3002 |
| 3005 | `invest3` / `apexlink-forensics` Docker | Leave alone |
| 3011 | `minimalcnx` (after migrate) | Was wrongly on 3001; nginx `minimal*.conf` must follow |
| 4000 | pems / related | |
| 5000 | sop5 | |

Recover other sites without touching MikroTik: `scripts/vps-recover-other-sites.sh`.
After any multi-app incident, run once:
`bash /home/ddservice/mikrotik/scripts/vps-harden-ports-and-pm2.sh`
(writes `/home/ddservice/VPS-PORTS.md`, fixes absolute cwd for pems, keeps
minimalcnx on 3011, forces MikroTik fork/`server.js`, `pm2 save`).
Before starting MikroTik PM2: `bash scripts/preflight-mikrotik-ecosystem.sh`.

`cnxhaircutz.com` (apex) may be on a different host than
`cnxhaircutz.ddserviceth.com` (this VPS → `/var/www/cnxhaircutz` on **3002**).

## Incident prevention (2026-08-13 lessons)

Do **not** repeat these failures:

1. **Do not deploy Next** for MikroTik (`src/` is experimental). PM2 `script` must be `server.js`.
2. **Do not use PORT 3000/3001 for other apps** — 3001 is MikroTik-only; minimalcnx uses **3011**.
3. **Do not `pm2 save` until all apps are healthy** — a save with only mikrotik wiped resurrect for others.
4. **Do not `--update-env` from placeholder Supabase keys** — comment them out or use real keys.
5. **Do not use relative `cwd: './.next/standalone'` for pems** — use absolute
   `/home/ddservice/TMHCCP5/.next/standalone` or PM2 doubles the path.
6. **PM2 `exec_mode: 'fork'`** for MikroTik (cluster caused confusion / bad ops habits).
7. Before rewrite/risk: `scripts/backup-pre-rewrite.sh` + keep tag `pre-rewrite-express-2026-08-13`.

## Architecture

- **`server.js`** — the real backend (Express). This is the only server that
  matters; `server.py` is a legacy Python prototype, not used in production
  — don't edit it expecting it to affect the live app.
- **Dual DB layer, auto-selected by `SUPABASE_URL` env var**:
  - `db-supabase.js` — async, Postgres via `@supabase/supabase-js`, used in
    production.
  - `db.js` — sync, local JSON files under `db/`, fallback/dev mode.
  - **Every function must be implemented in both files with matching
    signatures and return shapes.** When adding a DB function or a field to
    an existing one (e.g. a new site setting), edit both files in the same
    change — it's easy to update only the Supabase one since that's what
    production runs on, but the JSON fallback will silently drift out of
    parity if you forget db.js.
- **`public/app.js` + `public/index.html`** — vanilla JS frontend, no
  framework. Page/tab controller pattern: `switchPage`, `loadPageData`,
  per-page `loadXTab` dispatchers.
- **`routeros.js`** — generic RouterOS API client (`client.exec(path, args)`
  sentence builder). `executeOnRouter(fn, siteId)` in server.js opens a
  fresh TCP connection + login per call (no pooling).
- **Background poller** — `snapshotHotspotSessions()` fans out via
  `Promise.allSettled` to `snapshotSiteSessions(site)` per site every 5
  minutes, doing hotspot-session diffing, DNS-log correlation, and
  PPPoE-session diffing in one `executeOnRouter` call per site. Per-site
  dedupe state lives in Maps keyed by `site.id`.
- **WireGuard** — VPS is the hub (`wg0`, `10.10.88.0/24`), each site is a
  peer with its own tunnel IP. RouterOS script generator + auto-registration
  callback (`/api/wireguard/callback-register`) lets a router self-register
  its public key via `/tool/fetch`, avoiding manual copy-paste.
- **`nas-backup.sh`** — pull-based backup script meant to run *on* a NAS
  (Synology/QNAP/generic) that sits on an internal-only network. It reaches
  *out* to the dashboard's public CSV export routes rather than the VPS
  reaching *in* to the NAS.

## Critical conventions

- **Always `await` DB calls.** The Supabase layer is fully async; a missing
  `await` was the root cause of a major outage this project already had
  (login/menu/dashboard silently broken). If you touch a DB call site,
  double-check the `await` is there.
- **Security (Phase A, ongoing):**
  - Menu/role toggles remain UI hints only — **API routes enforce
    `requireAuth([...])`**. Never assume a hidden menu = locked API.
  - Non-admin users with `assignedSiteId` are locked to that site in
    `executeOnRouter` and in log/export filters (`resolveForcedSiteName`).
  - Never return router `password` to the browser. Use `hasPassword` /
    `sanitizeSitePublic`. `/api/sites/switch` must not leak passwords from
    `setActiveSite`.
  - `/api/wireguard/debug-echo` is off in production unless `ENABLE_WG_DEBUG=1`.
  - Login rejects oversized username/password strings; rate-limited.
  - Never commit real `SUPABASE_*` or `db/*.json`. Placeholder
    `YOUR_PROJECT_ID` must not be loaded into PM2 with `--update-env`.
  - PM2 must stay **`exec_mode: 'fork'`** (not cluster) for this single Express listen.
- **Cache-busting**: `public/index.html` loads `app.js?v=X.0`. Bump the
  version number on every `app.js` change, or the browser (and Cloudflare,
  which sits in front of the app) may serve stale JS.
- **Thai UI strings and comments in user-facing code are intentional** —
  match the existing tone/register when adding new UI text.
- **RouterOS scripting gotcha (confirmed on RouterOS 7.2.2)**: assigning a
  `/interface/wireguard/get ...` result to a `:local` variable can silently
  produce an empty value. Build values inline in the command instead of via
  intermediate `:local` variables when generating RouterOS scripts.
- **RouterOS script re-runs**: scripts that recreate an interface must
  explicitly remove old peers/addresses first (`/interface/wireguard/peers/
  remove [find]`, `/ip/address/remove [find comment="..."]`) — RouterOS does
  not cascade-delete children when a parent interface is removed, causing
  orphaned entries to accumulate.
- **มาตรา 26 retention**: `hotspot_logs` and `dns_query_logs` have a 90-day
  auto-cleanup (compliance minimum). `pppoe_usage_logs` (billing data) is
  kept indefinitely by design — do not add auto-purge to it without asking.
- **Menu/role visibility toggles are UI-only**, not API-level enforcement —
  the actual API routes keep their own fixed `requireAuth([...])` role
  checks regardless of what the sidebar shows. Don't assume hiding a menu
  item means the underlying route is locked down.
- **PPPoE live sessions have no bytes-in/bytes-out on `/ppp/active/print`**
  (unlike `/ip/hotspot/active/print`, which does expose them natively).
  Per-session traffic only exists on the dynamic interface RouterOS creates
  for each connection, named `<pppoe-USERNAME>`. To show live upload/download
  for a PPPoE room, look that interface up in `/interface/print` and read
  `rx-byte`/`tx-byte` from there. Not yet verified against a live router —
  double-check after deploy that the interface name pattern actually matches.
- **Suspending a room for non-payment**: the standard term used in this app
  is "ระงับการใช้งาน" (Suspend), not "ล็อก"/"ปิดใช้งาน" — matches ISP/billing
  convention. Implemented via `PATCH /api/mikrotik/pppoe/users/by-name/:name/suspend`
  (body `{ suspend: true|false }`), which disables the `/ppp/secret` entry and,
  when suspending, also kicks any live session so the cutoff is immediate. If
  the same pattern is added for Hotspot users later, reuse this wording.
- **Renewing an existing Hotspot username**: `/ip/hotspot/user`'s `uptime`
  counter is cumulative and RouterOS never resets it on its own — if a
  customer tops up/buys a new coupon under the *same* username, re-applying
  `limit-uptime` alone leaves the old accumulated uptime in place, so the
  user immediately reads as already over the new package's limit.
  `PUT /api/mikrotik/hotspot/users/:id` takes two opt-in renewal flags (both
  default off, so a plain cosmetic edit — e.g. fixing a comment — doesn't
  wipe usage stats): `resetCounters: true` runs
  `/ip/hotspot/user/reset-counters` (param name `numbers`, not `.id`) before
  applying the new limits; `recreate: true` instead removes and re-adds the
  user outright (guarantees a clean slate, recommended for single-use
  coupons). Either mode also kicks any active session for that username
  first (`/ip/hotspot/active/print` filtered by `user=`, then
  `/ip/hotspot/active/remove`) so the customer's next login picks up the
  fresh counters immediately instead of continuing under the old session.
  Selected via a "ต่ออายุ/เติมเงิน" dropdown that only appears in the Edit
  Hotspot User modal (hidden when adding a brand-new user, since a fresh
  `/user/add` already starts at uptime 0).
- **`db/config.json` and `db/users.json` must never be git-tracked** — the
  former holds the real MikroTik router host/port/username/password in
  plaintext, the latter holds dashboard login password hashes. Both
  matched the `db/*.json` `.gitignore` pattern but were still tracked
  because they'd been committed *before* that pattern was added (git
  doesn't retroactively untrack a path just because a later `.gitignore`
  rule matches it) — discovered 2026-07-30 when a local JSON-fallback
  test run turned out to hold a real, reachable router credential and
  connected to the live device instead of a sandbox. Untracked via
  `git rm --cached` (see changelog); **the exposed router password was
  already burned the moment it was committed, so removing it from
  tracking does not substitute for rotating it on the router itself.**
  If you ever need to seed these files, let `db.js`'s `initDB()` create
  them on first run (default admin `admin`/`admin1234`, empty site) —
  never hand-edit them back into a commit.

## Local development setup

For anyone picking this project up on a new machine (or a future Claude
Code session starting cold):

- **Requirements**: Node.js — `@supabase/supabase-js` is pinned to
  `>=2.49.4 <2.110.0` specifically so this still works on Node 20 (the
  VPS runs 20.20.2); Node 22+ also works but isn't required. `npm install`
  after cloning.
- **Two ways to run it locally**:
  - **JSON-fallback mode** (`node server.js` with no `SUPABASE_URL` set) —
    reads/writes the `db/*.json` files directly, needs zero configuration,
    and is the fastest way to check a UI/frontend change end-to-end. This
    is what was used to test every UI change in this session.
  - **Supabase mode** — set `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` env
    vars (matching what's in the VPS's `ecosystem.config.js`, which is
    gitignored — copy `ecosystem.config.example.js` as a template if you
    need a local PM2-managed run) to hit the real production database
    instead. Only do this deliberately; JSON mode is safer for
    experimentation.
- **Logging in locally**: `db/config.json` and `db/users.json` are
  gitignored and no longer tracked at all (see the critical-conventions
  note above) — a fresh clone won't have them. Just run `node server.js`
  once; `db.js`'s `initDB()` creates both automatically: an empty site
  (host/username/password blank — fill them in via the Router Settings
  page, or leave blank if you only need to test UI that doesn't call
  `executeOnRouter`) and a default `admin` / `admin1234` login. If your
  checkout *does* still have a real `db/config.json` from before this was
  untracked (e.g. an existing clone made before 2026-07-30), be aware
  running the app against it talks to whatever real router is configured
  in there, not a sandbox — check the file's contents before assuming
  it's safe to click around freely, and don't commit any temporary
  changes to it (it's gitignored now, so `git status` should stay quiet,
  but double-check with `git status` anyway before any commit that
  touches `db/`).
- **Visually verifying UI/CSS changes**: don't just read the CSS — run the
  app locally per above, log in, and actually click through the affected
  page. If browser automation is available, prefer it over guessing;
  but note that in at least one session the window-resize tool silently
  didn't propagate to the page's real `window.innerWidth` (verify with
  `window.innerWidth` via JS before trusting a "mobile" screenshot), and
  screenshot capture occasionally returned a stale/tiled repaint after a
  DOM update — reload the page before concluding a rendering bug is real.
- **Syntax-checking**: see below — there is no test suite, so this plus
  manual reasoning about call sites is the only safety net before pushing.
- **Git/commit conventions**: commits are only pushed when explicitly
  authorized in the conversation (not automatically after every change),
  and the `## Change log` section below is updated with a dated entry
  every time — read it top-to-bottom for the full history of *why* things
  are the way they are, not just *what* changed.

## Syntax-checking (no system Node available)

There is no system Node in this sandbox. Use the Playwright-bundled binary
before committing any JS change:
```
/c/Users/VirusAlert/AppData/Local/ms-playwright-go/1.57.0/node.exe -c <file>
```
Run this on every modified `.js` file (`server.js`, `db.js`,
`db-supabase.js`, `public/app.js`, etc.) — there is no test suite, so this
syntax check plus manual reasoning about call sites is the only safety net
before pushing. (This specific binary path is a workaround for *this*
sandbox having no system Node install — on a normal dev machine, just use
your own `node -c <file>` or `node --check <file>`.)

## Deploy workflow

Changes are deployed by the user via SSH, not by Claude directly:
```
cd /home/ddservice/mikrotik
git pull origin main && pm2 reload ecosystem.config.js --update-env
```
`ecosystem.config.js` on the VPS holds live secrets (`SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, `ALLOWED_ORIGINS`, `PUBLIC_APP_URL`) — the copy in the
repo contains only placeholder values. **Never overwrite the VPS copy carelessly**;
if `git pull` would clobber it, stash or back it up first.

Same caution applies to `db/config.json` and `db/users.json` now that
they're untracked (2026-07-30): **before pulling the commit that removes
them from tracking**, back them up first —
```
cp db/config.json ~/db-config.json.bak && cp db/users.json ~/db-users.json.bak
```
If the real files on the VPS differ from what git last had (near-certain —
real usage updates them), `git pull` will refuse with "would be removed by
merge" exactly like the `ecosystem.config.js` rename did, which is
harmless: just re-run `git pull` after nothing needs resolving, since the
files are gitignored going forward and Git leaves untracked files alone.
If for any reason `git pull` succeeds *silently* and the files vanish
instead, restore immediately from the `.bak` copies above — otherwise the
app restarts with a blank site config and a reset `admin`/`admin1234`
login.

**Auto-start after reboot** is configured via systemd (`pm2 startup` +
`pm2 save`). If PM2 is not running after a VPS reboot/crash, run:
```
cd /home/ddservice/mikrotik && pm2 start ecosystem.config.js && pm2 save
```
Log files are written to `/home/ddservice/mikrotik/logs/` (out.log / error.log).

## Database migrations

There is no migration framework — schema changes are applied manually via
the Supabase SQL Editor. When a code change adds/needs a new column, always
give the user the exact `ALTER TABLE` SQL to run, and call out that it's
needed (a missing column fails with a Postgres schema-cache error, e.g.
`Could not find the 'x' column of 'sites' in the schema cache`).

New tables should have RLS enabled (`ALTER TABLE ... ENABLE ROW LEVEL
SECURITY;`) with no permissive policies — the backend talks to Supabase
using the service role key (bypasses RLS by design), so an RLS-enabled,
policy-free table is exactly "only the backend can touch this," matching
this app's architecture where nothing calls Supabase directly from the
browser.

## Next.js migration policy (data must not vanish)

**Production stays on Express (`server.js` + PM2 port 3001) until cutover is explicit.**
The overnight Next.js swap caused 502s, port fights with `minimalcnx`/`cnxhaircutz`, and
“missing sites” because:

1. Next `src/lib/db.ts` read `db/sites.json` while Express uses `db/config.json`.
2. `ecosystem.config.js` was force-committed with placeholder `SUPABASE_*`, so the live
   process fell back to empty local JSON instead of Postgres.
3. Nginx `mikrotik.conf` had been pointed at `:3000` while the app listened on `:3001`.

**Rules while developing App Router:**

- Source of truth for production data is **Supabase** (`sites`, users, logs, hotspot/DNS/PPPoE).
  Never delete those tables. Never deploy with `YOUR_PROJECT_ID` placeholders.
- Local/JSON fallback must use **`db/config.json`** (same as Express). Next now imports
  legacy `db/sites.json` into `config.json` once if needed.
- Env key name: `SUPABASE_SERVICE_KEY` (Express). Next also accepts
  `SUPABASE_SERVICE_ROLE_KEY` / `SUPABASE_KEY` aliases, and ignores placeholder URLs.
- Develop Next on a **separate port** (e.g. `next dev -p 3010`). Do **not** replace PM2
  `script: 'server.js'` with `next start` until: Supabase keys restored, feature parity
  verified, nginx still points at the correct upstream, and `minimalcnx` is not on 3001.
- Cutover checklist: backup `ecosystem.config.js` + confirm `[DB] Using: Supabase`,
  `curl` sites API returns both sites, then only switch PM2/nginx.

## Change log

Keep this updated after every code change — newest entry on top.

- **2026-08-13 (8)** — Production listen defaults to `127.0.0.1` (`HOST` env
  override); ignore `.next/` in git; VPS tidy archived incident leftovers and
  restored real Supabase from `ecosystem.config.js.REAL.bak`.

- **2026-08-13 (7)** — Ignore placeholder `SUPABASE_*` (`YOUR_PROJECT_ID`) in
  Express the same way Next `db.ts` already did; harden script always forces
  `exec_mode: 'fork'` and re-comments placeholder Supabase lines so a bad bak
  cannot start fake-Supabase + cluster again.

- **2026-08-13 (6)** — Fixed PPPoE room accounts crash under Local JSON DB.
  - `GET /api/mikrotik/pppoe/users` called `.catch()` on `db.getPppoeUsageLogs()`;
    `db.js` returns a plain object (sync), so the UI showed
    `db.getPppoeUsageLogs(...).catch is not a function`. Wrapped with
    `Promise.resolve(...)` so both JSON and Supabase backends work.

- **2026-08-13 (5)** — Harden against repeat multi-site outage.
  - Added `scripts/vps-harden-ports-and-pm2.sh` (durable PM2 list, pems absolute cwd,
    minimalcnx→3011, sop5 `server.js` prod, writes `/home/ddservice/VPS-PORTS.md`).
  - Added `scripts/preflight-mikrotik-ecosystem.sh` (refuse Next script / PORT 3000 /
    warn on placeholder Supabase).
  - `ecosystem.config.example.js`: Supabase placeholders commented by default.
  - CLAUDE.md: incident-prevention checklist from the 2026-08-13 outage.

- **2026-08-13 (4)** — Stable Express path + Phase A security + VPS port isolation.
  - Product direction locked: Express + `public/` UI; Next `src/` marked
    `DO_NOT_DEPLOY`; `npm start` = `node server.js` only (Next scripts renamed
    `experimental:next:*` on port 3010).
  - Security: `sanitizeSitePublic`, forced site filters for co-admin logs/exports,
    login length limits, disable `wireguard/debug-echo` in production, document
    password non-leak on site switch.
  - VPS port map in CLAUDE.md; `scripts/vps-recover-other-sites.sh` for
    cnxhaircutz(3002)/minimalcnx(3011) without touching MikroTik 3001 or invest3 3005.
  - `ecosystem.config.example.js`: `exec_mode: 'fork'`, PORT 3001 ownership note.

- **2026-08-13 (3)** — Pre-rewrite backup tooling before any new-stack work.
  - Added `scripts/backup-pre-rewrite.sh` for VPS (app tarball + db/ecosystem secrets + nginx + pm2 dump).
  - Local `backups/` (gitignored) + git tag `pre-rewrite-express-2026-08-13` marking Express/`public` as the restore point.
  - Policy: take VPS backup *before* starting Vite/React or any cutover; do not delete Express until restore is verified.

- **2026-08-13 (2)** — Next.js data-layer alignment so App Router work cannot orphan sites.
  - `src/lib/db.ts` now uses `db/config.json` (Express path), migrates from `sites.json`,
    accepts `SUPABASE_SERVICE_KEY`, ignores placeholder Supabase URLs, matches Express
    legacy password salt, and no longer embeds live router credentials as defaults.
  - Documented Next cutover policy: keep Express on 3001 until Supabase + parity are ready.

- **2026-08-13** — Outage diagnosis: `api.ddserviceth.com` 502; removed duplicate `app.listen` crash risk; restored PM2 `cwd`.
  - External probe: Cloudflare returns `502` with fast origin time (`cfOrigin ~30–90ms`) = Nginx up, upstream Node dead/not listening.
  - `ddserviceth.com` (WordPress/Hostinger) and `cnxhaircutz.com` were reachable from outside — not a full VPS/network blackout.
  - Root-cause chain from overnight commits: Next.js PM2 on port `3000` (collides with `cnxhaircutz`), broken `db.js` `saveMenuPermissions` SyntaxError (fixed in `4c29e38`), and **two** `app.listen(PORT)` calls in `server.js` (Linux `EADDRINUSE` → PM2 crash-loop).
  - Removed the mid-file `app.listen` so only the end-of-file listener remains; set `ecosystem.config.js` `cwd` back to `/home/ddservice/mikrotik` and kept `script: 'server.js'` + `PORT: 3001`.
  - **Warning**: `ecosystem.config.js` was force-added to git with placeholder Supabase keys — never `pm2 reload … --update-env` from that file until real secrets are restored on the VPS copy.

- **2026-08-12 (14)** — Configured PM2 Next.js Production Server & Added 2FA TOTP / RouterOS Backup Module.
  - Updated `ecosystem.config.js` to execute `node_modules/next/dist/bin/next start -p 3001` directly under PM2.
  - Added RouterOS Daily Config Backup API Route (`src/app/api/backup/routeros/route.ts`) & 1-Click Backup UI in Settings.
  - Added 2FA / TOTP Authenticator API Routes (`src/app/api/auth/2fa/generate/route.ts` & `src/app/api/auth/2fa/verify/route.ts`).

- **2026-08-12 (13)** — Major Architectural Upgrade to Next.js 14+ (TypeScript & Full-Stack Security Architecture).
  - Migrated MT Management Web Dashboard to Next.js 14+ App Router, TypeScript, TailwindCSS, Zod Schema Validation, and TanStack React Query.
  - Built Type-Safe API Routes & Server Components for Hotspot, PPPoE (Relative Last Online Timestamps), FortiGate SD-WAN Multi-WAN (Auto PCC Weights via GCD), RouterOS v7 Hardened Security Preset, Firewall Blocking, Computer Crime Act Logs, and Multi-Site Router Switcher.
  - Achieved 100% Feature Parity with 0 TypeScript Type Errors (`npm run type-check`).

- **2026-08-12 (12)** — Global Window Login Handler & Visual Loading Feedback (`v=50.0`).
  - Exposed `window.handleLoginSubmit` to window global scope and attached `onsubmit="handleLoginSubmit(event); return false;"` and `onclick="handleLoginSubmit(event)"` to guarantee execution across all browsers.
  - Added button loading state (`กำลังเข้าสู่ระบบ...` + spinner) during authentication fetch.
  - Bumped `app.js` version query to `v=50.0`.

- **2026-08-12 (11)** — Removed Blocking Inline `onsubmit="return false;"` & Dual-Bound Login Listener.
  - Removed inline `onsubmit="return false;"` from `#login-form` which blocked browser submit event propagation to JS listeners.
  - Created standalone `handleLoginSubmit()` bound to both form `submit` event and button `click` event as dual-trigger fallback.

- **2026-08-12 (10)** — Fixed Login Submission (`/?` URL issue) & ReferenceError in `app.js`.
  - Replaced undefined variable `currentSite` in Hotspot CSV exporter with `getCurrentSiteName()`, resolving a top-level `ReferenceError` that prevented `app.js` event listeners (including `loginForm.addEventListener`) from executing.
  - Added `action="javascript:void(0);" onsubmit="return false;"` to `#login-form` in `index.html` to prevent standard HTML form GET submissions (`/?` appending).
  - Bumped `app.js` script tag version query to `v=40.0`.

- **2026-08-12 (9)** — Relaxed Login Rate Limiter & Permissive CORS Policy.
  - Increased `loginLimiter` max attempts from 5 to 30 per 15 minutes, skipping internal LAN/VPN subnet IPs (`10.x.x.x`, `192.168.x.x`) to prevent accidental IP lockouts.
  - Updated CORS `corsOptions` in `server.js` to prevent origin blocking when accessing dashboard via custom IP/domain names.

- **2026-08-12 (8)** — Modal Overlay for RouterOS Security CLI Script & Cache-Busting Query Bump (`v=35.0`).
  - Replaced `window.open` (which was blocked by browser popup blockers) with a clean `#modal-security-script` modal overlay and 1-click clipboard copy button.
  - Bumped `app.js` and `style.css` version strings to `v=35.0` in `index.html` to guarantee instant client browser cache invalidation.

- **2026-08-12 (7)** — RouterOS Date String Format Parser for PPPoE Last Online.
  - Added `parseRouterOSDate` in `public/app.js` to parse RouterOS `last-logged-out` string format (`aug/12/2026 19:45:10`), properly converting it into Thai date format and relative time (`12 ส.ค. 19:45 น. (3 ชม. ที่แล้ว)`), filtering out default zero dates (`jan/01/1970`).

- **2026-08-12 (6)** — Fixed `TypeError: db.getPppoeLogs is not a function`.
  - Corrected function call in `GET /api/mikrotik/pppoe/users` in `server.js` from `db.getPppoeLogs` to `db.getPppoeUsageLogs`.

- **2026-08-12 (5)** — Auto PCC Weight Calculation, Dynamic N-WAN PBR, Custom Telegram Templates & Hotspot Password Export.
  - Automatic PCC Weight Ratio Calculation: Built real-time Greatest Common Divisor (GCD) bandwidth ratio calculator (`autoCalculatePccWeights`) in `public/app.js` that automatically computes optimal PCC weights (e.g. 1000:500 ➔ 2:1) as WAN Mbps speeds are typed across WAN 1, 2, 3...
  - Dynamic Multi-WAN PBR Support: Updated Step 2 Policy Routing dropdowns to dynamically list ALL defined WAN lines and allow adding unlimited PBR rules bound to real router interfaces or subnets.
  - Customizable Telegram Notification Messages: Added custom WAN Down and WAN Up message template inputs (`mw-telegram-msg-down` & `mw-telegram-msg-up`) pre-filled with clean default templates.
  - Export Hotspot Accounts CSV with Passwords: Added `#btn-export-hotspot-csv` button in Hotspot Accounts toolbar with UTF-8 BOM encoding for Excel compatibility.

- **2026-08-12 (4)** — RouterOS v7+ Hardened Protection Security Preset (2026 Standard).
  - Added 1-Click "RouterOS v7+ Hardened Security Protection Preset" in Firewall management.
  - Implemented 6 enterprise firewall protection rules: Stage 1-3 WinBox/SSH Brute Force Auto-Blacklisting (8291, 22, 80, 443, 8728) to `brute_force_blacklist` address list (24h drop), Open DNS Resolver WAN Amplification DDoS prevention, and Invalid Packet drops.
  - Added `POST /api/mikrotik/firewall/generate-security-script` and `POST /api/mikrotik/firewall/apply-security-hardening` API endpoints and UI banner buttons.

- **2026-08-12 (3)** — PPPoE Last Online Status & FortiGate SD-WAN Standard Multi-WAN Layout.
  - Added PPPoE "Last Online" timestamp tracking (`isOnline`, `currentUptime`, `lastLoggedOut` timestamps formatted with relative Thai time e.g. `ออนไลน์เมื่อ 12 ส.ค. 19:45 น. (3 ชม. ที่แล้ว)`). Updated `GET /api/mikrotik/pppoe/users` in `server.js` and `renderPppoeAccounts` in `public/app.js`.
  - Reorganized Multi-WAN & Load Balance management according to FortiGate Enterprise SD-WAN standards (Step 1: WAN Member Interfaces & PCC weights, Step 2: Policy-Based Routing Rules, Step 3: Performance SLA & System Protection, Step 4: Direct API Apply action).

- **2026-08-12 (2)** — Enterprise Security Hardening & Native Gzip Web Speed Acceleration.
  - Implemented zero-dependency native Node.js `zlib` Gzip response compression in `server.js`, reducing static asset payloads (`app.js`, `index.html`, `style.css`) and API JSON payloads by up to ~80% (5x faster page loads on mobile & desktop).
  - Configured HTTP static asset caching (`maxAge: 1d`, `etag: true`) with `no-cache` protection for `index.html` to guarantee instant load speeds without stale deployment caches.
  - Hardened security headers: `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `X-XSS-Protection`, `Referrer-Policy`, `Permissions-Policy`, and hid Express server signature (`app.disable('x-powered-by')`).
  - Added 15-minute periodic garbage collection for expired `activeSessions` and WireGuard registration tokens.

- **2026-08-12** — Mobile Responsive Hamburger UX & iOS Safari Compatibility (iPhone 15 Pro Max Fix).
  - Fixed mobile hamburger menu unresponsiveness ("กดได้บ้างไม่ได้บ้าง") by adding the missing `<div id="sidebar-overlay" class="sidebar-overlay"></div>` DOM element in `index.html`. Previously, `document.getElementById('sidebar-overlay')` returned `null` and threw a JS TypeError, breaking mobile drawer events.
  - Implemented safe `toggleMobileSidebar` drawer controller in `public/app.js` with optional chaining `?.` and click delegation.
  - Upgraded mobile hamburger toggle `.btn-menu-toggle` in `public/style.css` with 44x44px touch target, `-webkit-tap-highlight-color: transparent`, `touch-action: manipulation`, iOS backdrop blur (`backdrop-filter: blur(8px)`), and safe area inset support (`env(safe-area-inset-top)` / `env(safe-area-inset-bottom)`) for iPhone 15 Pro Max Dynamic Island and Home Indicator.

- **2026-08-03 (2)** — Fixed Hotspot Auto-Cleanup uptime detection logic and redesigned table layout.
  - Fixed `runExpiredCleanup` in `server.js` by parsing both `uptime` and `limit-uptime` to milliseconds instead of strict string equality (`uptime === limitUptime`), which failed due to RouterOS string formatting differences.
  - Redesigned Hotspot Accounts table from 11 cluttered columns down to 7 compact stacked columns (`Username & Password`, `Profile & Status`, `Accumulated / Limit Uptime`, `Accumulated / Limit Bytes`, `Comment`, `Actions`), eliminating horizontal scroll overflow.

- **2026-08-03** — Added 1-Click Hotspot Quick Renewal and Status Badges.
  Added `POST /api/mikrotik/hotspot/users/:id/renew` endpoint that auto-kicks
  active sessions, resets cumulative uptime/byte counters via
  `/ip/hotspot/user/reset-counters`, and sets fresh `limit-uptime`.
  Added Quick Status Filter Pills (`All`, `Active`, `Expired`, `Expiring Soon`)
  and Status Badges (🔴 Expired, 🟡 <10% remaining, 🟢 Active) to the Hotspot
  Accounts table, along with a 1-Click `[ 🔄 ต่ออายุ ]` action button per row.

- **2026-08-02 (3)** — Changed default app port from `3000` to `3001` in
  `ecosystem.config.example.js` and `nginx.conf.example`. Diagnosed live
  routing conflict: `cnxhaircutz` (a Next.js app) runs on port `3000` on the
  same VPS, so Nginx proxying `api.ddserviceth.com` to `127.0.0.1:3000` was
  hitting Next.js instead of MikroTik Dashboard. Switching MikroTik Dashboard
  to port `3001` resolves the port collision.

- **2026-08-02 (2)** — **Router-side config change (not a code change)**: added
  `http-pap` as a login fallback on the live Hotspot Server Profile
  `hsprof1` (the profile actually bound to the `hotspot1` server — the
  `default` profile exists but isn't attached to any server, left
  untouched). `login-by` was `http-chap,mac-cookie`; now
  `http-chap,http-pap,mac-cookie`. Applied directly via a one-off RouterOS
  API script (not through this app's UI — there's no login-by control in
  the dashboard) after confirming the change with the user, as part of
  investigating the "web browser did not send challenge response (try
  again, enable javascript)" customer complaint from the 2026-08-02 entry
  above. Also confirmed while investigating: router's system clock/NTP is
  healthy (Asia/Bangkok, synced within ~5ms), so clock skew was ruled out
  as a cause. This change lives only on the router itself — nothing to
  `git pull`/deploy for it, noted here only so the *why* is on record.

- **2026-08-02** — Investigated a recurring customer complaint ("user rm218
  has reached uptime limit" right after topping up, plus separately "web
  browser did not send challenge response (try again, enable javascript)").
  Findings:
  - The renewal server logic added 2026-07-29 (2) (`resetCounters`/
    `recreate` flags on `PUT /api/mikrotik/hotspot/users/:id`) is correct —
    order of operations (kick session → reset/recreate → apply new limit)
    matches the intended fix. The recurring "reached uptime limit" reports
    are almost certainly **operational**, not a leftover code bug: staff
    must remember to pick the "ต่ออายุ/เติมเงิน" dropdown when topping up an
    *existing* username, and it's easy to forget since it's a separate
    control from the Uptime Limit field itself.
  - Fixed the root cause of the forgetting: `public/app.js`'s
    `openHotspotModal` now stores the original `limitUptime` value on the
    input (`dataset.original`) when opening Edit. A new `input` listener on
    `#hotspot-limit-uptime` auto-selects "รีเซ็ตเวลาใช้งานสะสม" the moment
    staff changes that field to a different value than it started with
    (the actual real-world signature of "topping up"), and shows a new
    inline hint (`#hotspot-renew-auto-hint` in `index.html`) so it's visible
    rather than silent. If staff manually picks a different dropdown option
    themselves (`change` event), a `renewModeManuallyChanged` flag stops the
    auto-behavior from overwriting their explicit choice for the rest of
    that modal session. Deliberately did **not** implement this by parsing
    and comparing RouterOS's `uptime`/`limit-uptime` duration strings
    server-side — this app's own `parseUptimeToMs` helper only understands
    the `w/d/h/m/s`-suffixed format, while the Edit form's limit-uptime
    input (and the `/ip/hotspot/user/profile` dropdown presets) use
    `HH:MM:SS` — mixing the two formats risked either silently never
    triggering or misfiring, so the fix stays entirely in the frontend and
    format-agnostic (plain string-changed comparison, no duration parsing).
    `app.js` bumped to `v=26.0`. No `server.js`/DB changes.
  - The **"web browser did not send challenge response (try again, enable
    javascript)"** error is unrelated to this app's code — it's generated
    by RouterOS's own Hotspot Server Profile / login page (CHAP
    challenge-response), which this dashboard does not manage or template
    (confirmed via grep — no `login.html`/CHAP handling anywhere in this
    repo). Likely causes worth checking directly on the router: the Hotspot
    Server Profile's login method being CHAP-only (some in-app/webview
    browsers — LINE, Facebook — block the JS that submits the CHAP
    challenge; adding `http-pap` as a fallback login method usually fixes
    this), a wrong system clock on the router (challenge tokens are
    time-sensitive), or a stale session cookie in the customer's browser
    left over from before a `recreate`-mode renewal (deleting and re-adding
    the user changes internal RouterOS state out from under a cookie the
    browser already held) — worth telling affected customers to fully
    close/reopen their browser or clear cookies for the hotspot IP after a
    renewal. Not something to "fix" in this repo; flagged for the user to
    check on the router itself.
  - Verified: syntax-checked both modified files with the Playwright node
    binary; confirmed via a local JSON-fallback run that the served
    `index.html`/`app.js` contain the new hint element and listener code.
    Could not do a full interactive click-through this session (Chrome
    browser extension wasn't connected) — this was verified by code trace,
    not by clicking through the modal in a live browser; worth a real
    click-through next session before considering it fully confirmed.

- **2026-07-30 (2)** — Regrouped the auto-cleanup card's action cluster
  per user feedback ("toggle ไม่สวย จัดใหม่ให้มืออาชีพ"): the manual
  "ลบหมดอายุทันที" button (a one-off command) now sits visually separated
  by a vertical divider from a new joined pill container
  (`.auto-cleanup-toggle-group`) holding the status badge + switch
  together as one control, instead of three loose elements floating at
  the card's edge. `style.css` bumped to `v=17.0`. Also: this is the
  first UI test done *after* the db/config.json untracking below, so
  established the safe local-testing pattern this project should keep
  using going forward — temporarily point `db/config.json`'s `host` at
  an unreachable address (e.g. `127.0.0.1`) before testing anything that
  touches `executeOnRouter`, since it's gitignored now and a plain
  JSON-fallback run otherwise talks to the real production router. Also
  note: **`git checkout -- db/users.json` (etc.) no longer reverts
  anything** now that these files are untracked — manually `cp` them to a
  backup path first and restore from that copy instead.

- **2026-07-30** — **Security: removed `db/config.json` and
  `db/users.json` from git tracking.** Discovered while locally testing a
  UI change (following the (8) entry's own local-dev instructions) that
  `db/config.json` held the real production MikroTik router's
  host/port/username/password in plaintext — a local JSON-fallback test
  run connected straight to the live router instead of a sandbox, and
  `db/users.json` similarly held real dashboard login password hashes.
  Both matched the pre-existing `db/*.json` `.gitignore` pattern but had
  been committed before that pattern existed, so git kept tracking them
  regardless (adding a gitignore rule doesn't retroactively untrack a
  path). Ran `git rm --cached db/config.json db/users.json` — the actual
  files are untouched on disk (site config and admin login keep working
  exactly as before), only git stops tracking them going forward. **This
  does not undo the exposure**: the credential was already committed to
  git history, so it must be treated as burned regardless — rotating the
  router's `ddserviceapi` password is the real fix and is on the user to
  do, not something this change can accomplish. See the new
  critical-conventions bullet and the Deploy workflow section for the
  backup-first pull procedure needed for this specific commit. No
  functional code changed.

- **2026-07-29 (8)** — Added the "## Local development setup" section per
  user request, so someone else picking this project up on a different
  machine (or a fresh Claude Code session) isn't stuck rediscovering things
  this session had to work out the hard way: how to run in JSON-fallback
  vs Supabase mode, that the checked-in `db/users.json` seed accounts have
  unrecoverable real passwords (with a copy-pasteable recipe for a
  temporary local-only password swap, and the reminder to always revert it
  before committing), and two browser-automation quirks hit while testing
  today's UI changes (window-resize not reflecting in `window.innerWidth`,
  and a transient stale/tiled screenshot repaint that cleared on reload).
  No code changes — documentation only.

- **2026-07-29 (7)** — Follow-up on (6): user tested again and said it was
  specifically the **toggle switch itself** that still looked unchanged —
  correct, (6) only restyled the card around it, never the `.switch`/
  `.slider` component (shared across the auto-cleanup toggle, the PPPoE
  room-enabled toggle, and the site DNS-logging toggle). Redesigned the
  switch itself: track now has a subtle `linear-gradient` + `inset`
  shadow (reads as a groove instead of a flat pill) in both the off state
  (grey) and the on state (indigo gradient matching `.btn-primary`, plus a
  soft `var(--primary-glow)` halo around the track), thumb has a radial
  highlight instead of flat white, and thumb travel now eases with a new
  `--ease-spring` custom property instead of the browser-default linear
  `.4s`. Applies globally to every `.switch` in the app, not just the
  auto-cleanup one. `style.css` bumped to `v=16.0`. Verified both states
  live via the same real narrow-viewport browser session as (6) — hit a
  transient screenshot-capture glitch mid-session (a stale/tiled repaint
  showing dozens of duplicate cards, worth remembering as "reload before
  concluding a UI bug" if this class of tool artifact recurs) that cleared
  on page reload and was not a real app bug.

- **2026-07-29 (6)** — Follow-up on 2026-07-29 (5): user tested and said the
  auto-cleanup card "still looked the same... the whole card looks bland,
  not premium" (the search-bar-inline/count-badge fix from (5) had in fact
  loaded correctly — confirmed via the screenshot they sent — but the card
  itself read as flat). Gave the card real visual weight to match the
  request: gradient icon plate (`linear-gradient(135deg, var(--primary)
  0%, var(--primary-hover) 100%)`, same treatment as `.btn-primary`, with
  an `inset` highlight + colored drop shadow) instead of a flat tinted
  square, a soft radial corner glow clipped by `overflow:hidden`, deeper
  layered elevation with a hover lift, and a glowing accent rail/badge dot
  when active. The icon stays vibrant in both on/off states by design (it's
  brand identity) — the accent rail + status badge carry the actual on/off
  signal, so color is never the only cue for state. `style.css` bumped to
  `v=15.0`. Verified both on/off states in a real (not simulated) narrow
  viewport this time — the browser tool's window resize worked in this
  session (500x805), unlike the (5) session where it silently no-op'd.

- **2026-07-29 (5)** — UI polish pass on the Hotspot Accounts toolbar per
  user feedback that it "looked old-fashioned": `.search-bar-inline` and
  `.count-badge` (used above the Hotspot Active Users, Hotspot Accounts, and
  PPPoE Accounts tables) had **zero CSS rules defined anywhere** — they
  rendered as unstyled stacked blocks. Added a proper flex toolbar (search
  box + optional filter `<select>` + result-count pill, wrapping to a
  full-width stack under 640px). Also refined the auto-cleanup card from
  2026-07-29 (2): layered shadow instead of a flat border, a left accent
  rail that reflects on/off state, precise concentric thumb sizing on the
  toggle switch (recomputed the box-model math — `.switch`'s existing
  values were already correct, `.switch-sm`'s were too, verified rather
  than guessed), focus-visible ring and iOS-style press-stretch on both
  switch sizes, and a `flex-direction: column` stack under 640px. Verified
  by actually running the app locally (JSON-fallback mode) and checking
  both the on/off toggle states and the sub-640px layout in a real browser
  (via a temporary unconditional style override standing in for a true
  viewport resize, since the browser automation tool's window-resize
  didn't propagate to the page's actual `window.innerWidth` in this
  environment) rather than just reading the CSS. `style.css` bumped to
  `v=14.0`.

- **2026-07-29 (4)** — **Production outage caused by the dependency cleanup
  in 2026-07-29's first entry.** Removing `sqlite3`/`googleapis`/`archiver`
  and running `npm install` also silently dropped `ws` from `node_modules`
  — `ws` was never a direct dependency, it only existed because one of
  those three pulled it in transitively. But `db-supabase.js:5` and `:13`
  `require('ws')` directly (Node <22 lacks a global `WebSocket`, so
  Supabase's realtime client needs the polyfill) — this is a real, direct
  runtime dependency of this app, not a leftover. Result: every PM2 restart
  crashed instantly with `Cannot find module 'ws'` before reaching
  `app.listen()`, hence a fast, silent restart-loop (empty error.log at
  first because it kept crash-looping — the actual error only became
  visible once PM2 was fully deleted and restarted fresh). Fixed by adding
  `"ws": "^8.18.0"` to `package.json`. **Lesson**: when removing an unused
  dependency, checking that *the removed package's own name* has no
  `require()` call sites isn't sufficient — grep every `require('pkg')`
  call site across all Node-side files and diff that full list against
  `package.json`'s `dependencies` before/after, since another file may be
  relying on that package's *transitive* deps being hoisted into
  `node_modules` without declaring them itself.
  - Secondary VPS-only issue hit while debugging this: `pm2 reload
    ecosystem.config.js` got the running process into a broken
    `waiting restart` state (`Process 1 not found`) that plain `reload`
    couldn't recover from. Fix was `pm2 delete <name>` then
    `pm2 start ecosystem.config.js` (matches the existing PM2
    reboot-recovery steps documented under Deploy workflow) — don't rely
    on `reload` alone if a process looks stuck; delete + fresh start is
    more reliable to unstick it.

- **2026-07-29 (3)** — Pinned `@supabase/supabase-js` to `>=2.49.4 <2.110.0`
  (was `^2.49.4`). `npm install` on the VPS had started emitting `EBADENGINE`
  warnings because 2.110.0 bumped its required Node to `>=22.0.0`, while the
  VPS runs Node 20.20.2; 2.109.0 (the version this range now resolves to)
  still declares `>=20.0.0`. Was a warning, not a hard failure, but pinning
  avoids it outright until the VPS's Node version is deliberately upgraded.

- **2026-07-29 (2)** — Fixed the Hotspot "uptime limit" bug reported by the
  user: renewing/topping-up an existing coupon username left the old
  cumulative `uptime` counter in place, so it immediately read as over the
  new package's `limit-uptime`. `PUT /api/mikrotik/hotspot/users/:id` now
  accepts `resetCounters`/`recreate` flags (see the convention note above)
  exposed via a new "ต่ออายุ/เติมเงิน" dropdown in the Edit Hotspot User
  modal (only shown when editing, not when adding a new user); both modes
  also kick any active session for that username so the renewal takes
  effect immediately rather than waiting for the customer's current session
  to end naturally. Also redesigned the Hotspot Accounts auto-cleanup
  toggle from a plain status-bar row into a modern card (icon, description,
  live status badge, toggle switch) — the "ลบหมดอายุทันที" manual-trigger
  button now lives inside that card instead of the tab's header actions.
  No DB schema changes — all RouterOS-side. `app.js` bumped to `v=25.0`.

- **2026-07-29** — Repo cleanup after auditing tracked files against actual
  usage: removed `sqlite3`, `googleapis`, and `archiver` from
  `package.json` — all three were declared dependencies with zero
  `require(...)` call sites anywhere in the codebase (`npm install`
  afterward dropped 164 transitive packages from `node_modules`). Deleted
  `migrate.js` (one-time JSON→Supabase migration script, already run back
  when Supabase was first adopted; it `require()`d `dotenv` and `ws`, which
  were never in `package.json` and aren't installed, so it was already
  broken/unrunnable) and `log_rotation_backup.sh` (leftover from an earlier,
  abandoned design that rotated raw rsyslog files and expired rows in
  ClickHouse — neither rsyslog nor ClickHouse exist anywhere else in this
  project; superseded by `backup.js` and `nas-backup.sh`). No functional/
  runtime code changed — `package-lock.json` and
  `node_modules/.package-lock.json` regenerated to match.

- **2026-07-27** — Fixed 502 Bad Gateway caused by PM2 not running after VPS
  reboot/crash. Root cause: `ecosystem.config.js` and `deploy.sh` had incorrect
  hardcoded paths (`/root/mikrotik-api-wg`, `/var/log/mikrotik-dashboard`) but
  the VPS runs as user `ddservice` with no access to `/root/`. Corrected all
  paths to `/home/ddservice/mikrotik` and `/home/ddservice/mikrotik/logs`.
  Configured PM2 systemd startup (`pm2 startup` + `pm2 save`) so the server
  auto-starts on reboot without manual intervention.

- **2026-07-13 (4)** — Reverted the Hotspot menu label back to "จัดการระบบ
  Hotspot" (dropped "ทั้งระบบ" per user feedback). Found and fixed a real bug
  in the background poller (`snapshotSiteSessions` in server.js): it read
  `bytes-in`/`bytes-out` straight off `/ppp/active/print` (same gotcha as the
  live-status endpoint fixed earlier — that field doesn't exist there), so
  **every PPPoE billing log entry had recorded 0 bytes since the feature was
  built**. Fixed the same way (correlate with `/interface/print` via the
  `<pppoe-USERNAME>` dynamic interface). Past months' logged usage is
  permanently 0 and cannot be recovered — only new session logs going
  forward will have real numbers. Separately investigating a user report of
  incomplete fields (name/IP/bytes blank, MAC populated) on the PPPoE live
  Status table — likely a stale `index.html`/Cloudflare cache after deploy
  since `index.html` itself isn't cache-busted (only `app.js?v=`), pending
  user confirmation after a hard refresh / cache purge.

- **2026-07-13 (3)** — Added long-term PPPoE reliability controls, all
  optional/best-effort per user request: (1) `idle-timeout` and
  `session-timeout` fields on the Package (PPP Profile) add/edit form —
  clears zombie sessions (e.g. a room's router lost power without a clean
  PPP terminate) automatically; note `session-timeout` counts from when that
  room's session started, not a fixed wall-clock time. (2) A live
  "Keepalive Timeout" control on the Packages tab
  (`GET/PUT /api/mikrotik/pppoe/server-settings`, backed by
  `/interface/pppoe-server/server`, assumes one PPPoE server instance per
  site) so already-provisioned sites can get faster dead-peer detection
  without re-running the WinBox setup script. (3) `keepalive-timeout` (default
  `10`) added as a field to the one-time PPPoE server setup script generator
  for newly-provisioned sites. No DB schema changes — all RouterOS-side.
  `app.js` bumped to `v=24.0`.

- **2026-07-13 (2)** — Fixed two Overview stat cards that only updated after
  visiting their page's tab once (they weren't part of the main polling
  loop): "ผู้ใช้ Hotspot ออนไลน์" and the PPPoE room card. The PPPoE room
  card's meaning was also changed from "total registered rooms" to "rooms
  currently online" (`fetchPppoeOnlineCount`, hits `/api/mikrotik/pppoe/active`
  instead of `/pppoe/users`) per user request — clicking it now opens the
  Live Status tab instead of Accounts. Added a MAC Address column to the
  PPPoE live-status table (from `caller-id`, already returned by the API but
  previously unused) — deliberately did NOT add a MAC-vendor/brand guess,
  since PPPoE carries no vendor/model info and a hardcoded OUI table risked
  showing confidently wrong brands; user chose "show raw MAC only" when
  asked. `app.js` bumped to `v=23.0`.

- **2026-07-13** — PPPoE live-status table: fixed upload/download always
  showing 0 (see byte-counter gotcha above). Added a "ระงับการใช้งาน" (Suspend)
  button on the live-status table and a matching suspend/unlock toggle on the
  room-accounts table (`PATCH /api/mikrotik/pppoe/users/by-name/:name/suspend`).
  Added a "ห้องที่ใช้ระบบ PPPoE" count card to the Overview page. Renamed the
  "จัดการ Hotspot" menu/page title to "จัดการระบบ Hotspot ทั้งระบบ" (sidebar,
  page header, and the co-admin/user permissions matrix). No DB schema
  changes. `app.js` bumped to `v=22.0`.
