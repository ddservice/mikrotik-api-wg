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

**Backend stays Express (`server.js`) forever. Frontend is migrating to
Vue 3 + Vite, page by page.** The Next.js App Router experiment is **gone** —
`src/` was deleted 2026-08-31 (recoverable from git history at tag
`pre-rewrite-express-2026-08-13` if anyone ever needs it). Do not resurrect it.

Handoff model for future developers:
- Backend entry: `server.js` (Express) — 97 JSON REST routes, Bearer-token auth
- Frontend (legacy, still the live `/`): `public/index.html` + `public/app.js`
  (bump `?v=` on every JS change)
- Frontend (new, at `/v2/`): `frontend/` → builds to `public/v2/` (see `frontend/README.md`)
- DB: `db-supabase.js` (prod) / `db.js` (local JSON) — keep signatures in sync
- Sessions: `db/sessions.json` (gitignored, mode 0600, SHA-256 keyed) — survives `pm2 reload`
- WireGuard setup tokens: `db/wg-registration-tokens.json` (gitignored, mode 0600) — also survives a restart
- Health check: `npm run check-sites` — per-layer connectivity for every site (registration → WireGuard → ping → TCP → RouterOS API), read-only
- Process: PM2 `ecosystem.config.js` → `script: 'server.js'`, `PORT: 3001`, `exec_mode: 'fork'`
- Backup before risky work: `scripts/backup-pre-rewrite.sh`

### Why a frontend framework now, when the last attempt caused an outage

The two are not the same change, and the difference is the whole point:

| | Next.js (2026-08-12/13, caused 502s) | Vue + Vite (2026-08-28, current path) |
|---|---|---|
| What it replaced | **the server** — own process, own port | **only the JS/HTML the browser downloads** |
| `server.js` | replaced by `next start` | untouched |
| PM2 / port 3001 / nginx | all had to change | untouched |
| DB layer | rewritten as `src/lib/db.ts`, read the wrong file | untouched |
| Deploy | new runtime on VPS | `git pull` + `pm2 reload`, unchanged |
| Blast radius if wrong | whole site 502 | restore `public/v2/`, `/` never affected |

The backend audit that justified this: **the frontend is already a pure API
client.** 97 routes, all returning JSON, auth via an `Authorization: Bearer`
header, zero server-rendered HTML, and no client-side routing at all (the
whole app is one page toggling `display:none`). Nothing about the browser
layer is entangled with the server layer.

**Everything machine-facing is server-side only and cannot be affected by
frontend work at all:**
- `POST /api/wireguard/callback-register` — the *router* calls this via
  `/tool/fetch` with a single-use token, to self-register its WG public key
- `POST /api/line/webhook` — LINE's servers call this
- `GET /health` — UptimeRobot
- `routeros.js` client, `executeOnRouter`, the 5-minute session poller,
  the LINE digest scheduler, the 60s offline monitor, the nightly backup

So the answer to "is Vue safe given the API / WireGuard / VPN setup" is that
**none of them are reachable from the frontend** — they are router-to-server
and server-to-router paths that never involve a browser.

### The bug that decided it

2026-08-28: three unclosed `<div>`s in `index.html` silently nested 8 modals
inside parents with `opacity: 0`. No console error, no failed request — the
only symptom was "the button does nothing". It killed the 1-Click upgrade,
coupon renewal, Ctrl+K search and 5 other features, and cost three commits
of fixing the wrong layer (`v123`/`v124`/`v125` patched JS and CSS).

A Vue/Vite build **refuses to compile** unbalanced markup, and
`<Teleport to="body">` makes "modal ends up inside a hidden parent"
structurally impossible rather than something to remember. `scripts/validate-html.js`
now covers the legacy page for as long as it exists.

### Migration rules (non-negotiable)

1. **Build on the dev machine, commit `public/v2/`.** The VPS runs
   `npm install --omit=dev` and has no vite/vue. Deploy stays `git pull` +
   `pm2 reload` with zero new server dependencies and zero new ports.
2. **`frontend/` has its own `package.json`.** The root `package.json` — the
   one the VPS installs from — must never gain a build dependency.
3. **One page at a time.** `/` keeps serving the old UI until every page has a
   working replacement. Both share the same `localStorage` token, so an
   operator can be logged into both simultaneously during the transition.
   As of 2026-08-31 `/v2/` covers the whole site lifecycle on its own — open a site
   (including the WireGuard setup script), run it, troubleshoot it (the 5-step
   diagnostic), and close it. What is left in v1 only: Multi-WAN, the
   hardened-firewall preset, and bulk voucher generation/printing.
   **The rule for deciding what must move is the lifecycle, not usage frequency.**
   "Used once per site" was the reason the WireGuard generator and the diagnostic
   were left behind, and it was wrong: the generator is the step that *creates* the
   connection, and the diagnostic is wanted precisely when a branch is down. Missing
   either one means v2 cannot replace v1 however rarely it is used.
   **Neither UI is redundant yet**: v1 still owns Multi-WAN and the voucher tools,
   and v2 alone has the sealed-archive browser, the storage monitor and the DNS
   on/off switch. Customers and staff are still used to v1, so `/` stays the default.
4. **Never delete `public/app.js` / `public/index.html`** until all pages are
   migrated *and* clicked through by hand. There is no test suite.
5. If `frontend/src` changed, run `npm run build:frontend` **before** commit —
   otherwise the deployed `/v2/` is stale.

Known issues a framework does *not* fix (server-side):
- ~~`activeSessions` is an in-memory `Map` → every `pm2 reload` logs out all users~~
  **fixed 2026-08-30** — persisted to `db/sessions.json`, keyed by SHA-256 of the token
  (`lib/session-store.js`)
- ~~no test suite~~ **fixed 2026-08-30** — `npm test`, 99 tests over `lib/`
- ~~`wgRegistrationTokens` is in-memory → a WireGuard registration in flight dies
  on restart~~ **fixed 2026-08-30** — persisted to `db/wg-registration-tokens.json`

All three long-standing server-side issues listed here are now closed. Anything new
belongs in the change log, not here, unless it stays open across sessions.

## VPS port ownership (do not steal ports from other apps)

| Port | Bind | Owner | Notes |
|------|------|--------|--------|
| **3001** | **127.0.0.1** | **MikroTik dashboard only** | Nginx `mikrotik.conf` → `127.0.0.1:3001`; `HOST=127.0.0.1` |
| 3002 | 127.0.0.1 | `cnxhaircutz` | `next start -H 127.0.0.1 -p 3002` |
| 3005 | 127.0.0.1 | `invest3` / `apexlink-forensics` Docker | UFW DENY public 3005 |
| 3011 | 127.0.0.1 | `minimalcnx` Docker | Was wrongly on 3001 |
| 4000 | 127.0.0.1 | `pems-platform` | `HOSTNAME=127.0.0.1`; hosts pems + tmhccp5 |
| 5000 | 127.0.0.1 | `sop5` | `HOST=127.0.0.1`, `server.js` (not vite) |
| 80/443 | public | nginx only | All HTTPS sites |
| 22 | public | sshd | Key-only; `PermitRootLogin no` |

Canonical map on VPS: `/home/ddservice/VPS-PORTS.md` (rewritten by harden script).

Recover other sites without touching MikroTik: `scripts/vps-recover-other-sites.sh`.
After any multi-app incident, run once:
`bash /home/ddservice/mikrotik/scripts/vps-harden-ports-and-pm2.sh`
(writes `/home/ddservice/VPS-PORTS.md`, fixes absolute cwd for pems, keeps
minimalcnx on 3011, forces MikroTik fork/`server.js`, localhost binds, `pm2 save`).
Before starting MikroTik PM2: `bash scripts/preflight-mikrotik-ecosystem.sh`.

`cnxhaircutz.com` (apex) may be on a different host than
`cnxhaircutz.ddserviceth.com` (this VPS → `/var/www/cnxhaircutz` on **3002**).

### Production data note (post 2026-08-13 recovery)

- Live DB is **Supabase** (not Local JSON). Real keys live only in VPS
  `ecosystem.config.js` (gitignored) and backup
  `/home/ddservice/backups/ecosystem.config.js.REAL.bak`.
- As of recovery verification: **2 sites** in Postgres (`A4-Residence`,
  `TingTing`) with host+API user set; **3 dashboard_users**. Local
  `db/config.json` may still list a third name (`สาขาหลัก`) from the
  JSON-fallback period — that is **not** production source of truth.
  Add/rename sites via the Router Settings UI against Supabase.
- `pems-stale-remind` hourly cron was removed as unused (2026-08-13).
- Operator: **TingTing** API password was rotated 2026-08-13 via
  `scripts/rotate-mikrotik-api-password.js --apply` (secrets file under
  `~/backups/mikrotik-api-passwords-*.txt` — copy offline then delete).
  **A4-Residence** still needs a manual WinBox rotate of `ddserviceapi`
  (API user lacks `/user` write — error "not enough permissions"), then
  paste the new password in Router Settings UI.
  Verify PPPoE live counters: `node scripts/verify-pppoe-bytes.js`
  (confirmed 2026-08-13 on A4: `<pppoe-USERNAME>` matched with non-zero rx/tx).

## Incident prevention (2026-08-13 lessons)

Do **not** repeat these failures:

1. **Do not deploy Next** for MikroTik (`src/` is experimental). PM2 `script` must be `server.js`.
2. **Do not use PORT 3000/3001 for other apps** — 3001 is MikroTik-only; minimalcnx uses **3011**.
3. **Do not `pm2 save` until all apps are healthy** — a save with only mikrotik wiped resurrect for others.
4. **Do not `--update-env` from placeholder Supabase keys** — comment them out or use real keys.
   Express ignores `YOUR_PROJECT_ID` / `YOUR_SERVICE_ROLE_KEY` and falls back to Local JSON.
5. **Do not use relative `cwd: './.next/standalone'` for pems** — use absolute
   `/home/ddservice/TMHCCP5/.next/standalone` or PM2 doubles the path.
6. **PM2 `exec_mode: 'fork'`** for MikroTik (cluster caused confusion / bad ops habits).
7. **Bind Node/Next app ports to `127.0.0.1`** — only nginx (80/443) and sshd (22) are public.
8. **Do not recreate `pems-stale-remind`** — removed 2026-08-13.
9. Before rewrite/risk: `scripts/backup-pre-rewrite.sh` + keep tag `pre-rewrite-express-2026-08-13`.
10. **Never commit VPS `ecosystem.config.js`** — secrets only on the server + REAL.bak.

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
- **Never remove a WireGuard peer just to re-add it.** `wg set wg0 peer <key>
  allowed-ips <ip>/32` updates an existing peer in place; removing it first discards
  its endpoint and handshake, and since the site routers are behind NAT and initiate
  the connection, the tunnel stays down until the router's next keepalive (minutes).
  `cleanupVpsPeerByIp(ip, keepPubKey)` therefore skips a peer whose key already
  matches. This ran on every server start and silently cut A4-Residence on each
  deploy — see 2026-08-30 (6).
- **RouterOS script re-runs**: scripts that recreate an interface must
  explicitly remove old peers/addresses first (`/interface/wireguard/peers/
  remove [find]`, `/ip/address/remove [find comment="..."]`) — RouterOS does
  not cascade-delete children when a parent interface is removed, causing
  orphaned entries to accumulate.
- **มาตรา 26 retention**: `hotspot_logs` (Postgres) and the DNS day files
  (`dns-logs/` + `archives/`) have a 90-day auto-cleanup (compliance minimum).
  **DNS visit logs no longer live in Postgres** — since 2026-08-31 they are written to
  `dns-logs/YYYY-MM-DD.jsonl` and sealed nightly (`lib/dns-log-store.js`); the same data
  costs 85 MB/day as rows but 5.8 MB/day as gzipped files. Legacy rows still in
  `dns_query_logs` are read alongside the files by `queryDnsLogs()` until they age out. `pppoe_usage_logs` (billing data) is
  kept indefinitely by design — do not add auto-purge to it without asking.
- **Menu/role visibility toggles are UI-only**, not API-level enforcement —
  the actual API routes keep their own fixed `requireAuth([...])` role
  checks regardless of what the sidebar shows. Don't assume hiding a menu
  item means the underlying route is locked down.
- **PPPoE live sessions have no bytes-in/bytes-out on `/ppp/active/print`**
  (unlike `/ip/hotspot/active/print`, which does expose them natively).
  Per-session traffic only exists on the dynamic interface RouterOS creates
  for each connection. Resolve via `lib/pppoe-iface.js` (`<pppoe-USERNAME>`,
  `pppoe-USERNAME`, then fuzzy). Probe with `npm run verify-pppoe-bytes`.
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
- **Archived / Expired & Deleted Hotspot Users**:
  When a Hotspot user is deleted manually or cleaned up automatically by `runExpiredCleanup()`,
  its details (username, profile, limit-uptime, comment, site name, reason) are archived
  to DB (`getArchivedHotspotUsers`, `archiveDeletedHotspotUser`). Admin can view the archive,
  delete individual archive logs, clear all archive, or click "Restore" (`/api/mikrotik/hotspot/archived-users/:id/restore`)
  to re-create the user back into RouterOS with a single click.
- **LINE Official Account (LINE Messaging API v2) Multi-Site Integration**:
  Full replacement for deprecated LINE Notify. Configured per-site (`getLineDigestConfig(siteId)` & `saveLineDigestConfig(config, siteId)`).
  Supports Push Message (`sendLinePushMessage`), Reply Message (`sendLineMessagingApiReply`), and Flex Messages.
  Includes strict per-site isolation (`line_digest_config_<siteId>`) to prevent cross-site notification leaks (unconfigured secondary sites strictly default to disabled without falling back to another site's token/targetId).
  Includes a dedicated `#select-line-digest-site` dropdown in the settings UI and a public Webhook (`POST /api/line/webhook`) for LINE OA Rich Menu auto-reply:
  - `id` / `groupid` / `/id`: Auto-replies with the exact `groupId` / `userId` for easy setup.
  - `เช็ควันหมดอายุ`, `ต่ออายุเน็ต`, `ดูรหัสผ่าน`, `ผูกบัญชี <username>`, `คู่มือใช้งาน`, `ติดต่อแอดมิน`.
  Includes a multi-site background scheduler that scans each site's router independently and sends a daily expiry summary Flex Card into that site's LINE OA / Group Target ID at its scheduled time.
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

Since 2026-08-30 there is a test suite. Run everything with one command before committing:
```
npm run check              # = npm test + validate-html + check-db-parity
```
Individually:
```
npm test                   # 82 unit tests over lib/time.js, lib/dns-log.js,
                           # lib/storage-monitor.js, lib/pppoe-iface.js
npm run validate-html      # public/index.html: unclosed tags, dup ids, nested forms/modals
npm run check-db-parity    # db.js vs db-supabase.js exports + arg counts + .catch() on sync
                           # db calls (scans server.js, lib/ and scripts/)
```
**Pure logic belongs in `lib/`, not in `server.js`** — anything inside `server.js` cannot be
unit-tested, because requiring it starts a listener. Date/time handling in particular must go
through `lib/time.js`; duplicating it across files is what caused the 2026-08-30 wrong-day
bug, where the fix landed in one copy and the nightly seal kept using the other.
`validate-html` exists because three unclosed `<div>`s silently nested 8 modals
inside hidden parents and killed the 1-Click upgrade, coupon renewal, Ctrl+K
search and 5 other features — with no console error and no visible symptom
other than "the button does nothing". A syntax check on the JS would never
have caught it.

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

- **2026-08-31 (9)** — Closed the last coherence gap in Multi-WAN, and **corrected a fix that
  the previous entry claimed was made but was not**.
  - **The FastTrack fix in 2026-08-31 (6) never landed.** The patch script used a
    `replace()` with no assertion, the pattern did not match, and it silently changed nothing —
    while the commit message and the change-log entry both said it was fixed. The broken rule
    (`add chain=prerouting action=accept connection-state=new`, first in the chain, which ends
    mangle processing and therefore kills every PCC rule after it) was still being generated.
    Now genuinely replaced with `/ip firewall filter disable [find action=fasttrack-connection]`,
    verified by reading the **generated script**: 0 occurrences of the old accept rule, 21 PCC
    rules present, and the script correctly returns to `/ip firewall mangle` afterwards.
    **A patch script that cannot fail is not a patch script** — every replacement in this repo's
    tooling now asserts, and this class of silent no-op is exactly why.
  - **The system no longer recommends something it cannot do.** `recommend()` could return "PCC
    across these two lines" while `/v2/` offered only failover, so the advice dead-ended.
    `/v2/` now has a PCC section that computes the weights from the measured bandwidth and
    produces the full script for the operator to paste. **Deliberately no Apply button**: PCC
    must overwrite mangle and give up FastTrack, and that trade belongs to a person, not a
    button — unlike failover, which never touches the traffic path.
  - `lib/pcc-weights.js` (new) — `gcd` and `pccWeights` moved out of `public/app.js`, where they
    were untestable and unreachable from v2.
    - **Bug found by running it, not by reading it**: 500/500/50 produced weights of **9:10:1** —
      two identical lines given different shares — because the old reduction trimmed the largest
      value one at a time. It now divides every line by the same number, which preserves equality
      by construction. Same input now yields 10:10:1.
    - The cap on total weight exists because PCC emits one mangle rule per unit of ratio: 997:31
      would be 1,028 rules evaluated on every packet. It reduces to 31:1 (ratio 32.2 → 31.0).
  - **The failover monitor now survives a restart.** Its per-site state was in memory, so a
    `pm2 reload` landing during a failover meant the next tick treated the backup line as the
    baseline and never alerted — losing exactly the event the monitor exists to catch. Persisted
    to `db/multiwan-state.json` (gitignored, mode 0600, temp-file + rename), written only when a
    site's active line actually changes rather than every 5-minute tick.
  - 13 new tests (**241 total**). Verified end to end against the 3-WAN fixture through real
    HTTP: missing bandwidth returns `needSpeeds` instead of guessing, weights come out 10:10:1,
    and the generated script contains the corrected FastTrack handling.

- **2026-08-31 (8)** — Deployed and verified; then a review of the new code found three things
  worth fixing before anyone runs it on a live branch.
  - **Deploy confirmed from outside**: the bundle hash served by the VPS matches the local build
    exactly, `/health` reports `db: supabase` (not the JSON fallback), `/` and `/v2/` both 200,
    and all four new Multi-WAN routes answer **401** rather than 404 — which is what proves the
    new `server.js` is the one running.
  - **The auto-rollback script could strand itself.** A RouterOS script stops at the first command
    that errors, and the self-removal was the *last* line — so any failure partway through (a
    permission, a missing id) left the scheduler on the router firing every 180 s forever, with
    the rollback never completed. Every command is now wrapped in `:do {...} on-error={}`, so the
    script always reaches its own removal. This matters precisely because the scheduler exists for
    the case where we have already lost contact and cannot clean up by hand.
  - **The netwatch conntrack flush was too trigger-happy.** RouterOS netwatch calls a host down
    after a single missed probe, and the down-script flushed *every* connection on the router — so
    one lost packet would have dropped every customer in the branch at once, for nothing. It now
    checks that the primary's own default route has actually been deactivated (i.e.
    `check-gateway` confirmed the line is dead) before flushing, and probes at 10 s/3 s instead of
    5 s/2 s.
  - **`POST /api/multiwan/apply` allowed `co-admin`; `/failover/apply` allows only `admin`.** The
    older endpoint is the more dangerous of the two — it writes routing tables, NAT and connection
    tracking with no backup, no armed rollback and no post-check — yet carried the weaker
    requirement. Now `admin` only. No site uses Multi-WAN, so nothing in production changes.
  - Re-verified the whole cycle against the 3-WAN fixture after these changes: apply 14 steps,
    remove returns `routes 6, nat 2, netwatch 1, scheduler 2`, and the router ends at
    `distance 1/1/1` with `activeWan: null`. **228 tests.**
  - Confirmed while reviewing, rather than assumed: `routeros.js` pushes a `!done` sentence's
    attributes into the result array, so `/ip/route/add` really does return `ret` and the precise
    per-item undo works against a real router — not only against the fixture.

- **2026-08-31 (7)** — Multi-WAN refuses to start when the API user cannot run `/ping`, and a
  correction about Cloudflare.
  - **Connecting two facts already in this file**: the failover verify step pings from the
    router, `/ping` requires the RouterOS `test` policy, and **three of the four sites do not
    have it** (found 2026-08-31 while diagnosing the 1-Click upgrade). So applying failover on
    those sites would have run all 14 steps, failed verification, and rolled everything back —
    safe, but it disturbs a branch's internet for no reason and looks like a failure of the
    feature rather than a missing permission.
  - `applyFailover()` now pings `127.0.0.1` once **before the backup and before arming**, and
    aborts with `preflight: true` if that comes back as a permission error. Verified against a
    fixture with the policy withheld: `applied: 0` and **zero** write commands reached the
    router — no backup, no scheduler, no route, no NAT, no netwatch, no `set`. The message names
    the missing policy and where to add it, and states that nothing was touched.
  - A ping that fails for any *other* reason (a genuinely dead line) is deliberately not treated
    as a permission problem — that is the verify step's decision to make, not the pre-flight's.
  - **Correction to the deploy advice given in the previous two entries**: purging the Cloudflare
    cache is **not needed** for this app, and telling the operator to do it was wrong. Measured
    on the live site: both `/` and `/v2/` return `Cache-Control: no-cache, no-store,
    must-revalidate` with `cf-cache-status: DYNAMIC`, because `server.js` sets those headers on
    HTML explicitly. Cloudflare never caches the entry document, so a deploy is visible on the
    next request. Assets are cached for 4 h but are safe by construction — `/v2/` filenames are
    content-hashed, and v1 uses `app.js?v=`, which is part of the cache key. A hard refresh is
    still worth doing to clear the *browser's* copy; the CDN needs nothing.

- **2026-08-31 (6)** — Multi-WAN: N-line support, a topology recommender, three fixes to the
  advice already shipped, and the alerting that makes failover observable. The `/v2/` page now
  uses English network vocabulary throughout, at the operator's request.
  - **English terms on that one page only.** Thai renderings of route / distance / gateway /
    mangle read worse than the originals to anyone who works in WinBox, so the page is Thai
    prose with English technical nouns. Everything else in the app is unchanged.
  - **3+ WAN lines are handled properly, not merely tolerated.** `recommend()` now ranks by
    bandwidth and groups lines that are within 4× of each other. With 500/500/50 it recommends
    **PCC across the two fast lines and backup-only for the third** rather than dragging the slow
    line into the load-balance group; with 500/100/50 it recommends plain failover across all
    three. Distances come out 1/2/3 and each line gets its own check host.
  - **`POST /api/multiwan/apply` was reporting `สำเร็จ!` for a `Bypass FastTrack` toggle that
    actively broke PCC.** The rule it emitted was `add chain=prerouting action=accept
    connection-state=new` — placed first, and `accept` in mangle ends the chain, so every PCC
    marking rule after it never ran. Turning the option on silently disabled the load balancer it
    was supposed to help. It now disables the `fasttrack-connection` filter rule, which is the
    thing that actually conflicts, and the generated script says plainly that this costs
    throughput on hEX / hAP.
  - **Two real defects found by running the full cycle, not by reading it:**
    - `disarm()` matched every scheduler carrying the tag, so committing a successful install
      **deleted the DHCP-gateway sync schedulers it had just created** — the protection lasted
      until the moment installation finished. Disarm now matches the rollback scheduler by name;
      `removeAllSchedulers()` is the one that clears everything, used only by the explicit remove.
    - The apply route referenced an undefined `siteId` when building the alert, returning
      `siteId is not defined`. Fixed by extracting `resolveSiteIdFromReq()` and having
      `executeOnRouter` use the same helper, so the alert can never name a different site than
      the one that was actually configured.
  - **Closing the gap I flagged in the previous entry**: a DHCP line's host-check route was
    pinned to the gateway read at install time, so a lease renewal with a new gateway killed the
    backup line silently — discoverable only when the primary failed. Each DHCP line now gets a
    1-minute scheduler that reads the current gateway from `/ip/dhcp-client` and corrects the
    route. PPPoE needs none: it points at the interface.
  - **`netwatch` on the primary's check host flushes connection tracking on down.** Failover
    changes the source address, so established connections are dead but sit in conntrack until
    they time out (TCP established defaults to an hour). Without this the switch works and users
    still see a hang for minutes. `netwatch` polls at 5s, far faster than `check-gateway`.
  - **Telegram now reports what was installed and every line's WAN IP** — type, address, gateway,
    distance, role and check host per line. The WAN address is the first thing needed when
    calling the ISP or opening a port, and the hardest thing to recover remotely if it was never
    written down. A separate 5-minute watcher reports when a site starts running on a backup line
    and when it returns to primary: a silent failover means a branch can sit on the slow line for
    weeks before anyone notices.
  - `activeFailoverWan()` reads which line is actually carrying traffic from the tagged default
    routes (lowest distance still `active`), and the page shows it as a banner before anything
    else. `analyzeState` also returns each line's IP, resolved from `local-address` for PPPoE,
    the DHCP client's own lease, then `/ip/address` as a fallback.
  - `fake-routeros.js` gained a `3wan` scenario plus `/tool/netwatch` and `/ip/address`.
    Verified end to end against it: analyze finds 3 lines with correct IPs, the plan comes out at
    **14 steps**, apply succeeds with all three ping checks passing, exactly one scheduler is
    removed on commit (the rollback) while both sync schedulers survive, and remove returns the
    router to `distance 1/1/1` with nothing left behind. 27 new tests (**221 total**).

- **2026-08-31 (5)** — After a successful 1-Click upgrade, closing the modal left the version
  card showing the old version until the operator reloaded the page by hand.
  - **The upgrade itself worked** (reported live: the router came up on 7.23.1). Only the
    display was stale, which is its own kind of bad: the one screen that answers "did it
    work?" said it had not.
  - **Two causes, both needed fixing.** `done` was emitted the instant the upgrade sequence
    finished — the moment the router has just finished rebooting — and that was the *only*
    refresh. The ปิด button emitted `close` and nothing else, so the natural "read it again
    now that it's over" moment did nothing at all.
    - `FullUpgradeModal` now closes through `requestClose()`, which emits `done` first when the
      run finished. Closing is a good time to re-read precisely because it happens well after
      the reboot, unlike the completion instant.
  - **Launching the upgrade from Settings refreshed nothing anywhere.** `RouterOpsPanel` has its
    own `FullUpgradeModal` instance and listened only to `@close`, so its `updateInfo` kept
    reporting "there is a new version" after that version had been installed. It now re-runs the
    update check on `done`.
  - Verified that the staleness was only in the UI: with a fixture router reporting 7.22.1, the
    status endpoint returns 7.22.1; after the router comes back reporting 7.23.1, the very same
    request returns **7.23.1**. So a re-read was always going to be correct — nothing was asking
    for one. Confirmed both `onDone` handlers and the `finished && emit("done")` guard are
    present in the emitted bundle, since these are `.vue` files with no unit-test path.
  - `scripts/fake-routeros.js` gained `/system/routerboard/print` and `/system/health/print`
    (without them `/api/mikrotik/status` failed outright against the fixture) and a
    `--version=` flag, which is what made "before upgrade / after upgrade" reproducible at all.

- **2026-08-31 (4)** — Multi-WAN failover, built the way the previous entry said it had to be
  built: read the router first, back up, stay reversible, then act. `/v2/` now has the page;
  v1 is untouched.
  - **Nothing is typed in that the router can tell us.** `lib/multiwan-analyze.js` reads
    `/interface/pppoe-client`, `/ip/dhcp-client`, `/ip/route`, `/ip/firewall/{mangle,nat}` and
    derives the WAN lines from what is actually configured. The old form asked an operator to
    type interface names and gateways, which is exactly how a typo becomes a dead route that
    RouterOS accepts without complaint.
    - PPPoE gateways are pinned to the **interface name**, DHCP gateways to the **IP the lease
      actually handed out**. Getting this backwards is a slow failure: a PPPoE peer address
      changes on every reconnect, so a remembered IP works until the line flaps.
  - **The recommendation is rule-based code, not a model call.** It has to give the same answer
    every time for the same input (so an outage can be traced back), has to work when the
    site's own internet is down — which is precisely when it is needed — and has to be
    testable. The inputs are all measurable facts, not matters of interpretation.
    - PCC is rejected, with the number quoted, when the lines differ by more than **4×**: PCC
      puts half the connections on the slow line permanently, so "we added load balancing and
      the internet got worse" is a true report, not a complaint about nothing.
    - It is also rejected when speeds are unknown, when a line is down, or when conflicting
      `mangle` already exists. **For A4 as described (PPPoE main + DHCP backup) the answer is
      failover**, and the page says why it is not PCC rather than silently not offering it.
  - **Three independent ways back**, because the connection we are giving orders through runs
    over the very lines being changed:
    1. Existing default routes are **demoted, never deleted** (`default-route-distance` → 10+).
       If the new recursive routes fail their ping check, RouterOS falls back to them on its
       own and the site stays up.
    2. Everything added carries a `DDS-FAILOVER` comment, so it can be removed exactly and
       nothing else is touched.
    3. **A `/system/scheduler` rollback is armed on the router before the first write.** This
       is the only layer that still works once we have lost contact, which is the case it
       exists for. Ordering matters: arm first, then change. Reversed, a disconnect mid-change
       leaves nothing to recover with.
  - **"The command succeeded" is not "the internet works."** After applying, the router pings
    each line's own check host from itself; only if the primary answers is the scheduler
    disarmed and the change kept. Otherwise everything is undone in reverse order. Pinging
    from the VPS would prove nothing — that path goes through the tunnel, not the site's
    internet.
  - **Bug found by running the real cycle, not by reading the code**: removing the config
    restored `default-route-distance` from the value read *at removal time* — which is the
    demoted value we had written. It restored 10 over 10 and reported success. The original is
    now embedded in the route comment (`orig=1`) and read back from there, so the truth lives
    on the router and survives our own database being gone.
    - A second, smaller one on the way: the comment parser was written as `new RegExp('\s+…')`,
      and the escaping collapsed so it silently matched nothing. Replaced with word splitting —
      readable, and it cannot fail this way.
  - `scripts/fake-routeros.js` (new) speaks the real RouterOS API binary protocol and holds
    mutable state, so the write paths are exercised end to end without risking a live site.
    `--scenario=a4-broken` makes ping fail, which is how the rollback path was proven.
  - Verified against it through real HTTP, on the actual endpoints: all four routes 401 without
    a token; analyze returns both lines with correct kinds and gateways; the 10× case rejects
    PCC quoting "10.0 เท่า" while 500/300 accepts it; apply moves the router from `1/1, 0 routes`
    to `10/11, 2 routes, NAT added`; remove returns it to `1/1, 0 routes`; and on the broken
    scenario apply reports failure, rolls back, and leaves the router **byte-for-byte as it
    started**. 42 new unit tests (**194 total**).
  - **Not run against A4 itself.** This machine has no route to the VPS, and the first run of
    something that edits live routing should be watched by someone who can reach the router
    another way. `npm run check-sites` remains the read-only way to look first.
  - `NOT_MIGRATED_YET` is now empty: every page has a v2 equivalent. v1 stays the default.

- **2026-08-31 (2)** — Deleted the dead Next.js `src/`; made the Multi-WAN Apply button stop lying.
  - **`src/` removed** (38 tracked files). It was the abandoned 2026-08-12/13 App Router
    experiment, marked `DO_NOT_DEPLOY.md` and documented as permanently dead. The only
    remaining reference anywhere in the codebase was a **comment** in `server.js` pointing
    at `src/lib/db.ts` for the placeholder-Supabase rule; that comment now states the rule
    itself instead of pointing at a file that no longer exists. Git history keeps the code,
    so nothing is lost — what is gained is that a reader no longer has to work out which of
    two full-stack implementations is the real one. `package.json` stopped installing
    Next/React back on 2026-07-29, so this removes no dependency and changes no runtime path.
    Verified after deletion: `node -c server.js`, 152 tests, DB parity, and a clean
    `npm run build:frontend`.
  - **`POST /api/multiwan/apply` reported `สำเร็จ!` for work it did not do.** It applies four
    things (routing tables, host-check routes, NAT, connection tracking) but **not PCC
    (the load balancing itself) and not the failover routes** — the two sections that are the
    entire point of Multi-WAN. An operator following the UI would believe traffic was being
    balanced across both lines when nothing was balancing anything.
    - It now returns `partial: true`, a message naming only what was actually applied, and a
      `pending` list naming what was not, with the reason: PCC and failover **overwrite
      existing mangle/route rules**, and getting them wrong takes the whole site off the
      internet with no way to fix it remotely. Those stay in the generated script, which a
      human reads before pasting.
    - **Added a pre-flight check.** Every WAN's interface name is verified against
      `/interface/print` *before* the first write. RouterOS accepts rules referencing a
      non-existent interface without complaint, so a typo previously produced a dead route
      and a success message — the hardest possible thing to diagnose during an outage. On
      mismatch it returns `400` with `preflight: true`, lists the interfaces that do exist,
      and **has not touched the router at all**.
    - Errors now go through `rosErrors.explain()` with a new `multiwan` policy hint
      (`write`, `policy`), matching what was done for upgrade/ping/backup on 2026-08-31.
  - **`test/run.js` used a hardcoded file list, so new test files were silently skipped.**
    `routeros-errors-multiwan.test.js` was added and the suite still reported the same 152
    passing — everything green, the new tests never run. Now it scans `test/` for
    `*.test.js` and prints the file count, and exits non-zero if it finds none. This is the
    same failure shape as the DNS logging that was off for 50 days and the archive table that
    never existed: something that appears to work because nothing verifies that it does.
    **154 tests** now (9 files).
  - Not changed: no site currently uses Multi-WAN (all four are single-WAN, zero PCC rules,
    config still at placeholder defaults), so none of this alters live behaviour. And v2 still
    has no Multi-WAN page on purpose — see the migration note below.

- **2026-08-31 (3)** — `/v2/` can now onboard a new site and troubleshoot a broken one on
  its own. Diagnostic logic that existed in three places is now one module.
  - **Correcting my own earlier reasoning.** I had classified both the 5-step diagnostic and
    the WireGuard script generator as "install-day tools, used once per site" and left them
    in v1. That was right for one of them and wrong for the other:
    - The diagnostic is a **troubleshooting** tool. It is wanted at 2 a.m. when a branch is
      down — which is the worst possible moment to send someone to a different UI.
    - The generator is genuinely once-per-site, but it is the step that *creates the
      connection*. Without it v2 could add a site row but never reach the router, and
      **3 of the 4 live sites connect over WireGuard**.
  - A better rule than "how often is it used": **v2 must cover the whole site lifecycle on
    its own — open a site → run it → fix it → close it.** Miss one stage and v2 cannot
    replace v1 no matter how rarely that stage happens. Two of the four were missing.
  - `lib/site-diagnostics.js` (new) — `parseWgDump`, `describeWgPeer`, `tcpProbe`,
    `resolveHost`, `usesWireguard`, `diagnose()`. This logic previously existed in three
    separate hand-written copies (the endpoint, `scripts/check-sites.js`, and part of
    `diagnose-vps-status.js`) which had already drifted apart — the staleness threshold for a
    WireGuard handshake differed between them. The web UI and the CLI now answer identically.
    `check-sites.js` lost its own `tcpProbe` and dump parser.
  - **"Cannot read wg" is now clearly separated from "no peer exists."** Different problems,
    different fixes; reporting them as the same thing caused a false alarm earlier in this
    session.
  - `SiteDiagnosticsModal.vue` shows the layers in order so you can see how far it got before
    it stopped, and renders layers that were **never reached** distinctly from pass and fail.
    It starts the check on open — whoever opens it already knows something is wrong.
  - `WireguardSetupModal.vue` generates the script, suggests the next free `10.10.88.x`,
    states plainly that the script tears down and recreates the interface (so a router
    reached *through* that tunnel will drop briefly), and offers a button to check whether
    the router has called back yet. Deliberately does **not** push config to the router: the
    operator sees the script before it runs, and is at the console when it does.
  - **Found by running it against the real routers**: `Auioun@WiFi` connects directly over
    DDNS but still carries a leftover `wireguardIp` of `10.10.88.1` — which is the VPS's own
    tunnel address, never a peer. The old rule treated any stored `wireguardIp` as "uses
    WireGuard", so that site was checked for a tunnel it does not use and reported `fail` on
    layer 3 while the overall verdict said "all layers passed". A tool that contradicts
    itself stops being believed. `usesWireguard()` now decides from the host actually used to
    reach the router, and an explicit `connectionType: 'direct'` always wins.
  - 22 new tests (142 total) covering every early-stop layer, the `WG_STALE_SECONDS`
    boundary, the unreadable-`wg` case, and the leftover-`wireguardIp` case above.
  - `/api/mikrotik/diagnose-site` still returns exactly `{ success, site, steps }` with
    `step/status/detail`, so v1 is unchanged. Verified no password appears in the response.
  - Verified on the real VPS after deploy: all four sites pass every layer, and
    `Auioun@WiFi` now correctly runs **4** layers instead of 5.

- **2026-08-31 (2)** — Two problems in the new DNS file store, both found by measuring on the
  real machine rather than trusting that it worked.
  - **Memory would have restarted the process.** Loading a whole day into an array used
    ~295 MB of heap for a 342,109-row day, while PM2 is configured with
    `max_memory_restart: '500M'` and the process idles at 93 MB. Two concurrent queries would
    have crossed the limit and PM2 would have killed the process mid-request. Added
    `scanDay()`, which streams line by line (handling both the open `.jsonl` and the sealed
    `.gz`), and `query()` now keeps only the `skip + limit` newest rows per day. Measured on
    the real production archive: **295 MB → 12 MB**.
  - **Deep pages took 11 seconds.** `query()` called `top.sort()` for every row that passed
    the filter — O(want·log want) callback comparisons per row, which at want=2000 (page 20)
    meant billions of comparisons. Replaced with a binary-search insert and a pop:
    **11,380 ms → 203 ms**, a 56× improvement. On the real 342k-row sealed day, page 1, a
    domain search and page 20 all land between 1.2 and 1.7 s, which is fine for a lookup
    that happens when someone asks for records.
  - Sealing no longer parses anything either: the open file is already JSONL, which is exactly
    what the archive needs, so it is gzipped byte-for-byte. 300,000 rows → 3.7 MB in 608 ms
    with **no measurable heap growth**, instead of building 342k objects and re-serialising
    them at 02:00.
  - The test runner now supports `async` tests, since streaming reads make `query()` async.
  - Correctness re-checked at 300,000 rows after the rewrite: exact total, correct
    newest-first ordering, no overlap between pages 1/20/50, and both the domain search
    (60,000) and site filter (75,000) returning exactly the expected counts.
  - Worth noting for anyone reading the numbers: an early run appeared to "lose" 97,309 rows.
    It had not — the generated timestamps crossed 17:00 UTC, so those rows correctly landed in
    the **next Bangkok day's** file. The store was right and the test's expectation was wrong.

- **2026-08-31** — DNS visit logs moved out of Postgres into daily files. The Supabase quota
  problem is now structurally gone rather than deferred.
  - **The measurement that decided it**: the same 342,109 rows cost **~85 MB/day** as Postgres
    rows but **5.8 MB/day** as gzipped JSONL — 15× smaller. Ninety days for all four sites is
    **~0.5 GB**, which fits in the VPS disk (93 GB free) and R2's free 10 GB tier with room to
    spare. The problem was never the volume of data, it was storing write-once,
    read-by-date-range data in a table that has to index every row.
  - Concretely, on the free 500 MB tier: keeping DNS in Postgres allowed **5 days** before
    hitting the quota. Keeping it in files, Postgres stays at a flat **16 MB** no matter how
    much traffic grows.
  - `lib/dns-log-store.js` (new) — `dns-logs/YYYY-MM-DD.jsonl` appended while the day is open,
    sealed to `archives/YYYY-MM-DD-dns.jsonl.gz` at 02:00 by the existing archive job, with a
    small `index.json` holding per-day counts so "how many rows" needs no file read.
    - Days are cut on **Bangkok** time, and each row goes to the file for the day its own
      `queryTime` falls in — so a batch spanning midnight splits correctly instead of landing
      wherever the poller happened to be.
    - A corrupt line is skipped, not fatal: one bad line must not cost the rest of the day.
  - **Bug the tests caught before it shipped**: `query()` reversed the file's append order and
    called that "newest first". Append order is *not* time order — the router's buffer gets
    re-read, so a late-arriving row is appended after newer ones. Now each day is sorted by
    `queryTime` and days are walked newest-first, which keeps the global order right while
    still only holding one day in memory.
  - **Nothing is lost in the switch.** The 657,938 rows already in Postgres stay where they
    are and age out under the normal 90-day purge. `queryDnsLogs()` in `server.js` splits by
    date with no overlap — days that have a file are read from the file, days that do not are
    read from the database — so there is no double counting and no window where old data
    disappears from search.
  - Retention now covers both: `purgeOldDnsQueryLogs()` for the legacy rows and
    `dnsStore.purgeOld(90)` for the files, keyed on the date in the filename.
  - Verified end to end against a running server with 1,000 seeded rows across two days:
    date filtering (1000 / 500 / 0 out of range), search by domain (334), by username (144),
    by site (500), pagination with no overlap between pages, results genuinely ordered newest
    first, CSV export returning every row, sealing straight from the file (500 rows → 6,962
    bytes, live file removed, still readable through the sealed archive), and the retention
    cutoff keeping days that are still inside the window. 21 new unit tests (120 total).
  - **Why not a NAS at each site, which was the original question**: a NAS is not needed for
    capacity — the busiest site produces ~270 MB per 90 days, and R2's free tier alone is
    10 GB. What a NAS is genuinely good for is a third copy that lives on the operator's own
    premises. The sealed-archive design already makes that safe: the file can sit on a NAS the
    customer controls while its SHA-256 stays in the central database, so the copy is
    verifiable by anyone without having to trust whoever holds it. `nas-backup.sh` already
    uses the right shape for this — the NAS reaches out, the VPS never depends on it.

- **2026-08-30 (7)** — `/v2/` now covers every daily-use feature the old UI has. Nothing in
  `public/` or `server.js` was touched: v1 is still byte-identical and stays the primary UI.
  - **How the gap was measured**: extracted every `/api/...` string from `public/app.js` and
    from `frontend/src/**`, then diffed. The old UI called **74** endpoints, v2 called **39**.
    Recalling from memory would have missed most of this — several features looked present
    because a page with the right name existed while the actions inside it did not.
  - Added, all as new components so nothing existing had to be restructured:
    - **`RouterOpsPanel.vue`** — a fifth Settings tab. Reboot, config backup, flush DNS, ping
      test, link-quality test, RouterOS update check, and 1-Click upgrade (reusing
      `FullUpgradeModal`). Split into "ตรวจสอบ (ไม่กระทบผู้ใช้)" and "คำสั่งที่กระทบผู้ใช้งาน",
      because a reboot drops every customer in the branch for 1–3 minutes and that must not sit
      one click away from a read-only ping test.
    - **`HotspotArchivePanel.vue`** — a third Hotspot tab: deleted/expired coupons with
      one-click restore back into the router, plus the auto-cleanup switch and the manual
      "delete expired now" button. The switch lives here on purpose: it is what puts rows in
      this table, so whoever is asking "why did that coupon disappear" sees both together.
    - **`ProfileModal.vue`** — create/edit/delete for Hotspot profiles and PPPoE packages,
      shared by both since the fields largely overlap. v2 could previously only *list* them,
      so launching a new package meant going back to v1. **This one was missed in my own gap
      analysis** — the endpoint diff folded it into a group of false positives, and it only
      surfaced when I checked which HTTP methods v2 actually used against those paths.
      Worth remembering: "the URL appears somewhere in the code" is not the same as "the
      feature works".
    - **`GlobalSearch.vue`** — Ctrl+K / Cmd+K across every site at once, with keyboard
      navigation and 350 ms debounce (each search opens connections to every branch router,
      so firing per keystroke is not an option). Selecting a result switches the active site
      and jumps to the right page.
    - PPPoE **keepalive-timeout** editing, and LINE **send-now** for both the expiry digest
      and the multi-site health report. Both send real messages to real customers, so they
      confirm first and say plainly that this is not a test message.
  - Result: **74 → 54 endpoints covered**. The 20 still only in v1 are the deliberate
    install-day tools (Multi-WAN, WireGuard script generation, the 5-step diagnostic, the
    hardened-firewall preset, bulk voucher generation and printing) plus `/api/sites/switch`,
    which v2 replaces with the `X-Site-Id` header by design.
  - Verified against a locally-run server: both `/` and `/v2/` serve, every new route answers
    (200 where it is database-backed, 500 where it needs a real router — never 404), every one
    rejects an unauthenticated POST with 401, the v1 endpoints still behave exactly as before,
    and the server boots with no `ReferenceError`. Router hosts were pointed at `127.0.0.1`
    for the run and restored afterwards.
  - **The two UIs have diverged in both directions** and neither can be dropped yet: v1 still
    owns the install-day generators, while v2 alone has the sealed-archive browser, the
    storage monitor and the DNS on/off switch. Worth closing that gap before anyone assumes
    one of them is redundant.

- **2026-08-30 (6)** — **Every deploy had been cutting A4-Residence's WireGuard tunnel.**
  Found by the connectivity checker added an hour earlier, on its first real run after a
  deploy.
  - **Symptom**: right after a `pm2 reload`, `check-sites` reported A4 as `EHOSTUNREACH`
    with 100% ping loss, and its `wg0` peer had **no endpoint, no handshake, no transfer**
    at all. The other two tunnel sites were untouched.
  - **Cause**: `registerVpsPeer()` always called `cleanupVpsPeerByIp()` first, which removes
    whatever peer holds that tunnel IP — including the live, working one — and then re-added
    it. Removing a peer discards its endpoint and handshake state. The routers sit behind
    NAT and are the side that initiates, so the VPS cannot reach back until the router sends
    its next keepalive, which took **two to three minutes**.
  - `syncAllWireguardPeersOnStartup()` runs this on **every** server start, but only for
    sites that have a `wireguardPublicKey` stored — and **A4-Residence is the only one**.
    That explains precisely why A4, and only A4, produced repeated "Offline → back online
    after 1 min" alerts (28 Aug ×2, 30 Aug) while its router uptime ran unbroken for eight
    weeks. Every one of those alerts was one of our own deploys. The monitor was right; we
    were the outage.
  - **Fix**: `wg set wg0 peer <key> allowed-ips <ip>/32` on an existing peer updates it in
    place and does not touch the endpoint, so there was never a need to remove it first.
    `cleanupVpsPeerByIp(ip, keepPubKey)` now skips the peer whose key already matches.
    `/api/wireguard/remove-peer`, which is meant to delete, still calls it without a keep key.
  - **Verified on production**: captured A4's peer before and after a `pm2 reload` — same
    endpoint, handshake counter continuing (26 s → 36 s rather than resetting), transfer
    counters increasing rather than starting from zero, and ping 0% immediately after.
    Before the fix the same reload left the peer with no endpoint at all.
  - Also fixed a false alarm in `check-sites.js` itself: it pinged 5 times and flagged any
    loss above 0%, so a single dropped packet read as "20% loss — มีปัญหา" while the API was
    answering fine in 410 ms. Now 20 packets, and it only reports a problem above 30%. This
    is the second false-alarm class removed from this script in an hour; a checker that
    cries wolf gets ignored, and then the real outage goes unread.
  - Final state: **all 4 sites healthy at every layer** — 0% loss over 20 packets,
    10.5–13.4 ms through the tunnels, API logins 207–538 ms.

- **2026-08-30 (5)** — Legacy site names normalised in the logs, WireGuard registration
  tokens persisted, and a per-layer connectivity checker.
  - **1,120 log rows still carried old site names**, so filtering or exporting by the
    current name silently missed them. For a มาตรา 26 export that is worse than having no
    file: it looks complete and is not. Renamed with `scripts/normalize-site-names.js`
    (`npm run normalize-site-names`, dry-run by default):
    | old name | rows | now |
    |---|---|---|
    | `CCR2004` | 691 (656 hotspot + 33 pppoe + 2 archived) | `A4-Residence` |
    | `สาขาหลัก (Main Site)` | 284 hotspot | `Auioun@WiFi` |
    | `TingTing@WiFi` | 145 hotspot | `TingTing` |
    - The mapping was **read off the data, not assumed**: usernames and IP ranges overlap
      across the old and new names (`a028`/`a014` appear under both `สาขาหลัก (Main Site)`
      and `Auioun@WiFi`; `tt201`/`tt205` under both `TingTing@WiFi` and `TingTing`;
      `rm319` under both `CCR2004` and `A4-Residence`).
    - **It renames, it never deletes.** The script counts every table before and after and
      **fails if any total changed** — proving no row was lost rather than trusting that
      `UPDATE` does not delete. All four totals matched.
    - Rows were dumped to `~/backups/site-name-rename-2026-08-30.json` (id + previous name)
      before applying, so it is reversible.
    - **The sealed archives keep the original names** — verified that the 2026-08-25 file
      still contains `CCR2004=12` inside. So the immutable evidence records what was stored
      at the time, and this change only affects the live tables used for search and export.
      That is what made it safe to do at all.
    - `dns_query_logs` needed no changes (657,938 rows, all current names).
  - **Duplicate DNS rows: much smaller than first reported.** The earlier "15.3%" came from
    sampling only pre-fix batches. Measured across the whole of 2026-08-29: 1,987 duplicate
    rows out of 342,109 (**0.6%**, ~0.5 MB). Deliberately left alone — reclaiming 0.5 MB is
    not worth editing a compliance record.
  - **`wgRegistrationTokens` now persisted** to `db/wg-registration-tokens.json` (gitignored,
    mode 0600, temp-file + rename), same pattern as sessions. Written immediately on
    creation (the router can call back within seconds) and immediately on use, so a
    single-use token stays used across a restart. Expired entries are dropped on load, and
    a corrupt file only means generating the script again — it can never stop the server.
    - Previously a restart between generating the setup script and the router's callback
      lost the token, and the router got a 401. The window is 30 minutes and the fix was to
      press the button again — but it lands exactly when someone is standing at a new site,
      which is the most expensive moment to lose time.
    - Verified the load/expiry/corruption logic standalone. **Not** exercised end to end
      through a real router callback: that path calls `sudo wg set wg0 peer …` and would add
      a real peer to production WireGuard. The restore itself was confirmed on the VPS by
      planting a short-lived token file, reloading, and checking the `[WG] กู้คืน` line.
  - **`scripts/check-sites.js`** (`npm run check-sites`) — checks every site layer by layer:
    registration → WireGuard peer and handshake age → ping loss/latency → TCP port →
    RouterOS API login → reading real data. When a site is down the first question is always
    *which layer*, because site internet, the tunnel, a blocked port and wrong API
    credentials are four different problems with four different owners. Read-only.
    - Its first version reported "no WireGuard peer" for all three VPN sites — a false alarm,
      because `wg show` needs root and returned nothing. It now distinguishes "cannot read"
      from "not present"; a monitoring tool that cries wolf is worse than none.
    - Current result: **all 4 sites healthy at every layer** — 0% ping loss, 10–14 ms over
      the tunnel, API logins 207–441 ms, and live counts (18/17/29/15 Hotspot users, 4 PPPoE
      rooms on A4).

- **2026-08-30 (4)** — Sessions now survive a restart, so deploying no longer logs everyone
  out. Last of the long-standing "known issues" in this file's Product direction section.
  - **The problem**: `activeSessions` was a plain in-memory `Map`, so every `pm2 reload`
    signed out every operator at once. It has been listed as a known issue since the Vue
    migration started, and it is the reason deploying during working hours was avoided.
  - **Why persisting the Map rather than switching to signed/stateless tokens**: the
    existing behaviour has parts that are easy to lose and hard to notice missing — sliding
    expiry on each request, logout invalidating a token immediately, and editing or deleting
    a user kicking that user's sessions. A stateless token cannot do the last two without a
    new database column and a per-request lookup. Writing the same `Map` to disk keeps every
    one of those semantics byte-for-byte and changes only what happens across a restart.
    When touching authentication, the smallest change that solves the problem is the right
    one.
  - **Keyed by SHA-256 of the token, never the token itself.** The file sits next to
    `db/config.json`, which already holds router passwords, but a leaked session file must
    not be usable to log in. Verified in the test that the raw token does not appear
    anywhere in the written file.
  - `lib/session-store.js` (new) — `hashToken`, `serialize`, `deserialize`, `prune`, all
    pure and unit-tested. Writes go through a temp file plus `rename` so a crash mid-write
    cannot leave a half-written file, and the file is created mode `0600`.
  - Saves are debounced to 30 s because sliding expiry updates the session on **every**
    request, and writing per request would mean a disk write per API call. Logout and
    user edit/delete call the immediate save instead — those must not be lost. `SIGINT`
    and `SIGTERM` also flush, which is what `pm2 reload` sends.
  - **Deserialize never throws.** A corrupt file means everyone logs in again, which is an
    inconvenience; a server that will not start because of a corrupt cache file is an
    outage. Tested against empty, truncated, wrong-shaped and non-JSON input.
  - `db/sessions.json` is covered by the existing `db/**` ignore rule — checked with
    `git check-ignore` rather than assumed, given this repo's history of secret files that
    matched a gitignore pattern but were still tracked.
  - 17 new tests (99 total). Verified end to end against a locally-run server, with the
    process **force-killed** rather than signalled — so the restore is proven not to depend
    on the shutdown handler running at all: token still valid after restart, forged token
    and missing header both 401, logout effective immediately *and* after a restart, and a
    deliberately corrupted file still allows a clean start and login.

- **2026-08-30 (3)** — First test suite (`npm test`), and time handling consolidated into
  one module.
  - **Why now**: this project has never had tests, and every bug found in the last three
    days was in a pure function that a test would have caught in seconds — the date-range
    filter dropping its end day, `query_time` storing insertion time, the DNS dedupe key,
    `bangkokToday()` returning the previous day. All of them were instead found by reading
    production data, days or weeks after the damage started.
  - `lib/time.js` (new) — `bangkokNow`, `bangkokToday`, `shiftDate`, `parseHHMMToMinutes`,
    `parseUptimeToMs`, `parseRouterOsLogTime`. These existed in `server.js` and
    `lib/log-archive.js` as separate, subtly different implementations, which is exactly
    how the seal ended up closing the wrong day while everything else looked fine: the fix
    went into one copy. Both files now import from here, so there is one definition to get
    right. `lib/dns-log.js` (new) holds `parseDnsLogMessage` for the same reason — it could
    not be tested while it lived inside a file that starts a listener on require.
  - `test/` with a ~40-line zero-dependency runner on `node:assert`. Deliberately no
    jest/vitest: the root `package.json` is what the VPS installs from, and the standing
    rule is that it never gains a build dependency. **82 tests**, all derived from bugs that
    actually happened rather than invented cases — 02:00 and 06:59 Bangkok (the window
    where the old date logic broke), the December-to-January rollover, `done query:` lines
    that must not be counted as new queries, a 4 TB disk at 95% that must *not* alert, and
    PPPoE interface names in every form the routers have produced.
  - `npm test` and `npm run check` (test + validate-html + check-db-parity) added.
  - **Verified the suite fails when it should**: re-introducing the original
    `bangkokToday()` breaks 2 tests, and breaking the DNS parser breaks 3. A suite that
    only ever passes proves nothing.
  - After the extraction, confirmed the server still starts clean and 8 endpoints
    (`/api/sites`, `/api/mikrotik/storage`, `/dns-logging`, `/api/logs`,
    `/telegram-alert/config`, `/log-archives`, `/line-digest/status`,
    `/settings/menu-permissions`) all return 200 with no `ReferenceError` in the log.
  - Sealed the archive the date bug had skipped: **2026-08-29 — 342,109 DNS records and
    2,213 Hotspot records**, on both VPS and R2 (59 files total). It is also the only full
    day of DNS data there will be for a while.
  - Confirmed DNS collection is genuinely stopped: **0 new rows in 8 minutes**, against
    ~264/minute before.

- **2026-08-30 (2)** — DNS collection switched off on the operator's instruction, and a
  full production audit that found the nightly seal had been closing the wrong day.
  - **DNS logging turned off on all 4 sites** (`admin`, recorded in the activity log with
    the reason). Real numbers at the time: 710,234 rows, ~171 MB of a 500 MB quota, growing
    **~91 MB/day — 3 days from full**. The earlier 9-day estimate was taken from a 5 a.m.
    sample; the daytime rate is 382,061 rows/day, close to double it, exactly the direction
    the caveat warned about. Existing rows age out under the normal 90-day purge, so with
    collection stopped there is no cliff to manage.
  - **Nightly seal was closing the wrong day.** The audit expected an archive for 29 Aug and
    found none; the logs showed the 02:00 job on 30 Aug ran fine and sealed **28 Aug**.
    - `bangkokToday()` did `new Date(now.toLocaleString('en-US', {timeZone:'Asia/Bangkok'}))`
      then `.toISOString().slice(0,10)`. The first step renders Bangkok wall-clock, the
      second re-parses it in the *server's* zone, and `toISOString()` converts back to UTC —
      a net −7 h. The result is the **UTC** date, which is the day before whenever Bangkok
      time is earlier than 07:00. The nightly job runs at 02:00.
    - So "yesterday" resolved to two days back, and the guard `dateStr >= bangkokToday()`
      simultaneously rejected sealing the day that was actually due. The seal was therefore
      permanently one day behind and could not catch up on its own.
    - Same pattern in three more places: `bangkokNow()` in `server.js` (LINE digest) and the
      `todayDateStr` in both the 02:00 backup and 08:00 storage timers. Those happen to run
      at hours where UTC and Bangkok share a date, so only the log line's date was wrong —
      but a schedule moved before 07:00 would have broken them too.
    - Replaced with `Intl.DateTimeFormat(...).formatToParts()` in `bangkokNow()` and
      `toLocaleDateString('en-CA', {timeZone})` in `bangkokToday()`; both are correct
      regardless of the server's own timezone. Verified under `TZ=UTC` across 02:00, 06:59,
      08:00, midnight, and the New Year boundary.
  - **The nightly seal now fills gaps instead of doing exactly one day.** `runNightly()`
    walks back 7 days and seals anything missing; days already done are skipped by the
    existing check, so a normal night costs nothing extra. A night that is missed — power
    loss, a failed run, or a date bug like this one — no longer leaves a permanent hole in
    a มาตรา 26 record, which is not something that can be filled in after the fact.
    Failures are now logged to the activity log too, rather than only to stdout.
  - Audit results otherwise clean: all 4 routers reachable (A4 up 8 weeks), both retention
    purges running (DNS oldest 52/90 days, Hotspot 68/90), 57 sealed files all present on
    R2 with a spot-checked hash passing on both copies, nightly backup current, Telegram
    ops alerts armed, no secrets tracked in git.
  - Still open and deliberately untouched: LINE is configured for A4-Residence only (the
    other three have no token of their own); `activeSessions` and `wgRegistrationTokens`
    remain in-memory so every deploy logs users out; there is still no test suite.

- **2026-08-30** — On/off switch for DNS visit logging, growth forecasting, and a parity
  checker that was only looking at one file.
  - **Why**: the previous entry established that DNS logging alone will exceed the 500 MB
    Supabase free tier in about a week, and that no amount of dedupe tuning fixes it
    (collapsing to one row per ip+domain per *hour* still projects 2.5 GB at 90 days —
    the volume comes from distinct ip+domain pairs, not from repeat queries). Rather than
    pick between paying for a bigger plan and changing what a legal record contains, the
    operator asked for a switch so collection can be paused until storage is sorted.
  - `GET/POST /api/mikrotik/dns-logging` (admin). POST takes `{ enabled }` for every site
    or `{ enabled, siteId }` for one. The per-site `dnsLoggingEnabled` field already
    existed but was a checkbox buried in the site-edit modal, with no way to change every
    site at once — which is the shape the problem actually has, since running out of space
    is a whole-system condition, not a per-site one.
  - **Turning it off is recorded in the activity log every time**, including who did it and
    which sites changed. Stopping a มาตรา 26 record must be answerable later; it must not
    just quietly stop. Sites already at the requested value are skipped, and that is logged
    too rather than reported as a change that did not happen.
  - Disabling stops only the app side — the poller stops reading `/log/print`, which is the
    part that grows the database. The router keeps writing to its own fixed-size memory
    buffer, which costs nothing because it wraps, and means re-enabling is instant with no
    router reconfiguration.
  - UI: the switch lives in the Storage tab next to the numbers that justify pressing it,
    not in a settings page somewhere else. Master switch plus per-site switches, each
    showing current state. Turning **off** asks for confirmation and states plainly that
    the gap is permanent; turning on does not ask. The storage report raises a warning
    every day while any site is off, so "pause for now" cannot quietly become "off for
    months" — the exact failure mode of the 50-day outage found on 2026-08-29.
  - **Forecast, not just current usage.** `rowsLast24h` and `projectedBytes` added to
    `getStorageStats()` in both DB layers, so the report can say "growing ~11 MB/day, full
    in ~42 days" instead of only "9% used". A table at 9% that fills in a week is the case
    that matters, and a percentage alone hides it. Warns at 30 days out, critical at 7.
  - **Bug found in the new code by its own test**: `db.getSites().then(...)` inside
    `buildReport` — `getSites` is async on the Supabase layer but **sync** on the JSON
    layer, so the whole storage report threw in JSON mode. This is precisely the failure
    `scripts/check-db-parity.js` was written for after 2026-08-13 (6), and it missed it
    because it only scanned `server.js` while the call now lives in `lib/`.
  - `check-db-parity.js` now scans `lib/` and `scripts/` as well, and matches across line
    breaks. The first attempt at that reported **12 findings, all false** — a non-greedy
    `\(([\s\S]*?)\)` skips past the real closing paren and latches onto a `.catch(` further
    down the file, so any `db.addLog(...)` followed by unrelated promise code looked like a
    bug. Replaced with real paren matching (string-aware, so parens inside Thai text don't
    throw off the count) and restricted to functions that are genuinely sync in `db.js` —
    `getStorageStats` is async in both layers, so chaining `.catch()` on it is fine.
    Result: 12 false positives → 1 real finding, and it still catches the injected bug.
  - That one real finding: `scripts/fix-and-sync-sites.js` chained `.catch()` on
    `db.updateSite()`. It sits under `if (useSupabase)` so it has never actually thrown,
    but it was waiting for the day someone runs that path in JSON mode.
  - Verified against a locally-run server in JSON mode (router hosts neutralised first,
    restored after): toggle all off → 0/2, pressing off again changes nothing, re-enabling
    one site → 1/2, the report shows the right count and raises the "1 site off" warning,
    all-off raises the "every site off" warning, `401` without a token, non-boolean and
    unknown `siteId` both rejected with clear messages, and every action appears in the
    activity log attributed to the user. Left the system at 2/2 enabled.
  - Could not click through the new UI in a real browser this session — the Chrome
    extension was not connected. Verified instead that the Vue build succeeds (it refuses
    unbalanced markup, which is why this project moved to Vue), that every new string,
    endpoint and CSS class is present in the emitted bundle, and that `index.html`
    references the current hashed filenames with no stale assets left behind.

- **2026-08-29 (3)** — DNS logs were being stored roughly twice, with the wrong timestamps.
  Found by the Storage Monitor added in (2), within an hour of it going live.
  - **How it surfaced**: the new per-table stats showed `dns_query_logs` growing at
    ~411 rows/minute (~590k/day). At 261 bytes/row measured, 90 days of that is ~14 GB
    against a 500 MB Supabase free tier. The rate looked far too high for 5 a.m., which
    is what prompted looking at the rows themselves rather than trusting the number.
  - **Cause 1 — the dedupe key used the wrong clock.** The fingerprint was
    `ip|domain|Math.floor(Date.now()/60000)`, i.e. the minute the poller happened to
    process the line. Measured on Suksawad-CMU: the router's 3000-line dns buffer spans
    only **~10.5 minutes** at that site's rate (`04:51:51` → `05:02:16`), while the
    poller reads it every **5 minutes** — so each line is read 2–3 times, and each
    re-read produced a *different* fingerprint and was inserted again. Now keyed on the
    log line's own timestamp, which is stable across re-reads. 15.3% of sampled rows
    were exact duplicates (same ip, domain and timestamp, up to ×13).
  - **Cause 2 — a detached dedupe Set.** `recentDnsFingerprintsBySite.get(site.id) || new Set()`
    created a throwaway Set whenever a site had no entry yet; it was read by the loop but
    never written to, because `rememberDnsFingerprint` creates and stores its own. So the
    first batch after **every restart** bypassed dedupe entirely. Both call sites now go
    through `getDnsFingerprintSet(siteId)`.
  - **`query_time` was the insertion time, not the query time.** Every row in a batch got
    `new Date()`, so they shared one timestamp to the millisecond and could be up to 5
    minutes late. For a มาตรา 26 record that is the field that has to be right. Added
    `parseRouterOsLogTime()` handling the format the routers actually send
    (`"2026-08-29 04:51:51"`, confirmed live on ROS 7.24.1) plus the older `aug/29`,
    `aug/29/2026` and bare `04:51:51` forms, converting router-local (Asia/Bangkok,
    UTC+7, no DST — override with `ROUTER_TZ_OFFSET_MIN`) to UTC. It **rejects**
    anything more than 2 hours ahead or 7 days behind and falls back to server time,
    so a router with a wrong clock cannot write confidently-wrong legal timestamps.
    10 parser cases verified, including the December→January year rollover.
  - `MAX_DNS_FINGERPRINTS` 2,000 → 20,000. Now that fingerprints are stable, the set has
    to outlive the router's buffer window; ~1,500 distinct query lines per 10-minute
    window at the busiest site left no margin at 2,000.
  - **Not changed**: the duplicate rows already in the table. They are real observations
    that were recorded twice, not fabricated data, and de-duplicating historical ม.26
    records is a decision for the operator, not a cleanup to do silently.

- **2026-08-29 (2)** — Storage Monitor: watch all three storage backends, and verify
  the ม.26 retention purge is actually still running. Found a dead `module.exports`
  in `db.js` on the way.
  - **Why**: the app writes continuously to three places — VPS disk (PM2 logs, backups,
    sealed archives), Cloudflare R2, and Postgres on Supabase (free tier = 500 MB) —
    and nothing watched any of them. When one fills up the symptom is just "the system
    broke", with no advance warning. Same shape of failure as the DNS outage above:
    something that *should* work, with nothing checking that it does.
  - `lib/storage-monitor.js` (new) — `getDiskUsage()` via `fs.statfs` (no shelling out
    to `df`; percentage computed as `used / (used + available)` to match what `df -h`
    prints, since ext4 reserves ~5% for root that a normal user cannot write to),
    `getDirUsage()`, `getR2Usage()`, `buildReport(db)`, `formatAlert(report)`.
  - **Percent alone is the wrong alarm.** Caught in local testing: a 4 TB dev disk at
    95% still has 200 GB free and fired `critical`, while a 20 GB disk at 90% has 2 GB
    free and is genuinely urgent. What actually breaks the system is bytes-free, not the
    percentage. `diskLevel()` therefore pairs the two: absolute free below the floor
    alerts on its own, and a high percentage only alerts when free space is also under
    `STORAGE_HEADROOM_BYTES` (20 GB). Verified against 7 scenarios covering both disk sizes.
  - **Retention verification** is the part worth keeping even when disks are roomy:
    `getStorageStats()` reports each table's oldest row age against its retention window,
    so a broken `purgeOldDnsQueryLogs`/`purgeOldHotspotLogs` now surfaces as a warning
    instead of going unnoticed for months. Holding logs past 90 days is its own ม.26
    problem, not just a disk problem.
  - `getStorageStats()` added to **both** DB layers (49 → 50 exports each). Supabase
    counts via `head: true` and estimates size by sampling 200 rows for a measured
    average — labelled an estimate everywhere it is shown, because it excludes indexes
    and TOAST and is not Postgres's real on-disk size. The JSON layer reads real file
    sizes, so there it is exact (`exactSize: true`).
  - Per-site row counts reconcile against the table total, and any shortfall is surfaced
    as **"อื่น ๆ / ชื่อเดิม"** rather than silently dropped — this is what makes rows
    still carrying the pre-rename `CCR2004` site name visible instead of invisible.
  - `lib/r2.js`: added `listObjects(prefix)` with proper `continuation-token` paging
    (same 1000-item cap that truncated the archives), replacing a would-be duplicate of
    the lister already inside `scripts/cleanup-old-backups.js`.
  - **`db.js` had two `module.exports` blocks.** The second (end of file) silently
    overwrote the first, so the first had been dead code for a long time. Discovered
    because `getStorageStats` was added to the dead block and came back `undefined` at
    runtime — while `scripts/check-db-parity.js` reported "ผ่าน", since its non-greedy
    regex matched the dead block too. Removed the dead block (verified first that the
    live one was an exact superset), and `check-db-parity.js` now **fails** when a file
    has more than one `module.exports` — confirmed it rejects the pre-fix `db.js` and
    accepts the fixed one.
  - Telegram gains a third, independently switchable alert kind: `alertStorage`
    (`sendOpsAlert(text, 'storage')`), added to both DB layers and to
    `sanitizeTelegramConfig`. Bot token still never leaves the server.
  - `GET /api/mikrotik/storage` and `POST /api/mikrotik/storage/check-now` (both admin
    only). `check-now` takes `{ force: true }` to send even when nothing is wrong —
    otherwise a healthy system sends nothing and there is no way to tell whether the
    alert path works at all.
  - Daily check at **08:00** Bangkok, not alongside the 02:00 backup: these messages
    need someone awake to act on them, and 08:00 is after the nightly jobs finish, so
    the numbers reflect the state *after* the old files were cleaned up. It repeats
    daily while unresolved — deliberately, since disk pressure does not fix itself.
  - v2 UI: new "พื้นที่เก็บข้อมูล" tab in Settings (disk meter, watched folders, R2
    breakdown, per-table rows/size/oldest/newest/retention status, per-site split).
    Loads only on first open of the tab, since scanning folders and counting rows is not
    free. Added the missing `.v2-callout.ok` variant and switched the new styles from
    hardcoded hex to the theme's own colour tokens.
  - Verified end-to-end against a locally-run server in JSON mode (real router hosts
    neutralised to `127.0.0.1` first, restored after): report renders, per-site split
    correct, `check-now` returns `sent: false` gracefully when Telegram is unconfigured
    instead of erroring, `alertStorage` round-trips, no `botToken` in the response, and
    `401` without a token.

- **2026-08-29** — **มาตรา 26 DNS logging had been dead for 50 days.** Found while backfilling the
  sealed archives; two further bugs found on the way.
  - Every day queried returned **zero DNS rows**. All 109,514 rows in `dns_query_logs` come from
    **8-9 July only** — a two-day window. Nothing recorded since `2026-07-09T13:44:36`.
  - **Two independent causes, both required.** Router side: `A4-Residence` had the rule
    `topics=dns,!packet action=dnsmem` with a dedicated 3000-line buffer already configured — but the
    rule was **disabled**. The other three sites had no dns logging rule at all, so their routers
    never emitted a `dns` log line for the poller to read. Application side:
    `dns_logging_enabled` was `false` for `A4-Residence` and `TingTing`, and the poller skips
    `/log/print` entirely when that flag is off. The one site whose router was configured was the
    one the app was skipping.
  - Added `scripts/enable-dns-logging.js` (`npm run enable-dns-logging`, dry-run by default) fixing
    both layers per site: creates the dedicated `dnsmem` memory action (separate buffer so DNS
    volume cannot evict hotspot/system entries from the default 1000-line log), creates or
    re-enables the `topics=dns,!packet` rule, and sets the DB flag. `!packet` keeps this at query
    level — domain names, not content, which is what มาตรา 26 asks for.
  - **Applied to all four sites.** Verified 45 s later that every router was emitting dns lines
    (A4 238, TingTing 24, Suksawad-CMU 543, Auioun@WiFi 24 in buffer).
  - **The 10 July – 28 August gap is permanent and unrecoverable.** Worth knowing before anyone
    relies on that period.
  - **Bug found: sealed archives were silently truncated at 1000 rows.** PostgREST caps a response
    at 1000 rows regardless of the range requested; `fetchDay` asked for 5000 per page then trusted
    the `pages` count computed from that requested limit, so a 1200-row day reported `pages: 1` and
    the loop stopped after one round. Caught because two consecutive days both produced *exactly*
    1000 hotspot records — not a number real traffic produces. After the fix 2026-08-27 went from
    1000 to **2773**. Page size now matches the server cap, the loop stops on a short batch or when
    the collected count reaches the reported total, rows are de-duplicated by id across pages, and a
    count mismatch logs a warning. **For a compliance artifact an incomplete file is worse than no
    file** — it looks authoritative while missing evidence.
  - **Bug found: date-range filters dropped the entire end day.** `new Date('2026-08-27')` is
    `2026-08-27T00:00:00Z`; used with `lte` that excluded everything after midnight, so filtering
    from the 27th to the 27th always returned nothing and any range silently lost its final day.
    This affected the **Logs page filters and CSV exports**, not just the archive job. Also logs are
    stored UTC while operators think in Bangkok dates, which matters here because a sealed daily
    archive must match the real calendar day. `rangeStart`/`rangeEnd` now map a bare `YYYY-MM-DD` to
    the correct UTC span for a Bangkok day (17:00Z the previous day → 16:59:59.999Z) and pass full
    timestamps through unchanged.
  - **Lesson**: a suspiciously round number in real data (exactly 1000 twice) is worth chasing.
    And a feature that *stores* compliance data is worth verifying end-to-end against production
    counts, not just its own unit behaviour — the archive feature worked perfectly while archiving
    nothing, because the thing it archives had been switched off upstream for seven weeks.

- **2026-08-28 (14)** — v2 migration finished for every daily-use page, then **มาตรา 26 sealed log archives**.
  - `/v2/` now covers Overview, Hotspot (full CRUD + renewal), PPPoE, Logs, Settings, Firewall and
    Dashboard Users. Deliberately **not** migrated, with the sidebar linking back to `/`: Multi-WAN,
    the WireGuard setup-script generator, the 5-step diagnostic, the Hardened Security preset,
    bulk voucher generation and voucher printing — all one-time install-day script generators, not
    daily work. `/` remains the primary UI and is untouched.
  - Shared pieces added along the way: `BaseModal.vue` (always `<Teleport to="body">`), a toast
    system replacing `alert()` (which blocks the event loop and stacks badly when acting on several
    rows — `window.confirm` stays for destructive actions, where blocking is correct), and a
    form/button stylesheet independent of the legacy `style.css`.
  - **Sealed log archives (the point of phase 2).** The system retained what มาตรา 26 requires but
    could not *prove* the logs were unaltered — an on-demand CSV is not evidence. Now at 02:00,
    only after the backup exits 0, the previous day is sealed to gzipped JSONL, hashed SHA-256,
    recorded in `log_archives` and pushed to R2.
    - Only **closed** days are archived; today's hash would change continuously and mean nothing.
    - The hash covers the `.gz` itself, so a recipient runs `sha256sum <file>` with no unpacking.
    - JSONL not one blob: readable line by line, and partial corruption still leaves the rest.
    - Pages are fetched until exhausted so a 100k-row day never has to fit one response.
    - **Verify re-reads the real bytes from VPS and R2 and recomputes** — it never trusts the stored
      value, which would make the check pointless.
    - R2 upload is best-effort; the UI shows which of the two locations actually holds a copy.
  - Added `lib/r2.js` (dependency-free R2 client). `backup.js` keeps its own uploader on purpose —
    it runs nightly in production and is not worth disturbing just to deduplicate.
  - Retention now covers `archives/` at the same 90 days, keyed on the **date in the filename**
    rather than mtime, which a copy or machine move would change.
  - Verified end to end on a fixture: 12,000 rows collected across pages, `sha256sum` matching the
    stored value, gunzip returning all 12,000 lines, verify passing untouched, **verify failing after
    one byte is flipped**, reruns skipping done days, no empty file for a day with no logs, and the
    current day rejected. UI test covers pass and fail states, storage badges, download, and confirms
    no token in any URL.
  - **Requires `sql/2026-08-28_log_archives.sql`** to be run in the Supabase SQL Editor before the
    feature can store anything.
  - Two `.gitignore` additions: `archives/` (real per-machine log data, belongs on the VPS and R2).

- **2026-08-28 (13)** — `archived_hotspot_users` table created; archive feature actually works now.
  - Operator ran `sql/2026-08-28_archived_hotspot_users.sql` in the Supabase SQL Editor — 12 columns
    confirmed. Added `sql/` as the home for hand-run migrations (this project has no migration
    framework; until now the statements lived only in conversation or a script comment, with no
    record of what had been applied). Convention documented in `sql/README.md`: date-prefixed
    filename, must be safely re-runnable (`IF NOT EXISTS`), RLS on with no policies, and column
    names matching exactly what `db-supabase.js` builds — a mismatch fails silently because the
    insert is wrapped in `try/catch`.
  - Migrated the 3 pending rows from `db/archived_hotspot_users.json`. Verified through the app's own
    `db.getArchivedHotspotUsers()` rather than a raw query: `total = 3`, so the Hotspot archive page
    and its Restore button have real data for the first time. **The feature had been silently doing
    nothing in production since 2026-08-26** — every auto-cleaned coupon was deleted without being
    archived, and none of those are recoverable.
  - Also confirmed the migration is genuinely idempotent on a second `--apply`: hotspot/pppoe rows
    re-upserted by `id` with no duplicates, and `activity_logs` reported "ซ้ำกับที่มีอยู่ 24, ต้องย้าย 0".
  - **Open item, not changed:** two archive rows carry `site_name: "CCR2004"`, the old name for
    A4-Residence (see 2026-08-26 (9)). They pre-date the rename so the migration's name-normalisation
    had nothing to map them from. Filtering the archive by A4-Residence will not show them. It is a
    one-statement `UPDATE` to fix, but it rewrites historical records, so it needs the operator's
    call rather than a silent correction.

- **2026-08-28 (12)** — `/v2/` PPPoE page (read + suspend), and the shell it needed.
  - Shell built first because every remaining page depends on it: `AppSidebar.vue`, a tiny
    hash-based router (`src/router.js`), and `src/menu.js` mirroring `ALL_CONFIGURABLE_MENUS` +
    `DEFAULT_MENU_PERMISSIONS_FALLBACK` from `public/app.js` so both UIs show identical menus.
    Hash routing rather than history mode **on purpose** — history mode needs an nginx rewrite, and
    the whole premise of this migration is that the server config is not touched. Side benefit the
    old UI never had: `#/pppoe` survives a reload and can be bookmarked.
  - `NOT_MIGRATED_YET` drives the sidebar: unmigrated pages render with a ↗ icon and navigate to `/`
    instead of showing an empty screen, so an operator is never stranded. A key is removed from that
    set as each page lands. `resolvedRoute` also refuses routes the role cannot open — still only a
    UI hint, the API keeps its own `requireAuth`.
  - **PPPoE page**: online status (with disconnect), all rooms with suspend/unsuspend, and packages.
    Uses **"ระงับการใช้งาน"**, the billing term this project standardised on — not "ล็อก"/"ปิดใช้งาน".
    Ported `parseRouterOSDate` + a `formatLastSeen` helper: RouterOS returns `last-logged-out` as
    `aug/12/2026 19:45:10`, which `new Date()` cannot parse, and `jan/01/1970` means never online.
  - Both pages carry an inline note pointing at `/` for the actions not migrated yet (add/edit,
    renew, vouchers, package CRUD), so the split is visible rather than surprising.
  - Verified in Chrome against fixtures, zero page errors: `#/pppoe` routes and survives reload,
    summary chips read 2 online / 1 offline / 1 suspended / 4 total, all four statuses render, the
    suspended filter narrows to 1 row, `formatLastSeen` produces `28 ส.ค. 14:28 น. (5 ชม. ที่แล้ว)`
    for an offline room and `ไม่เคยออนไลน์` for `jan/01/1970`, and the unsuspend button issues
    exactly `PATCH …/rm999/suspend {"suspend":false}` — intercepted in the test, never sent to a real
    router.

- **2026-08-28 (11)** — VPS housekeeping: 90-day retention everywhere, a dead cron, and a third tracked-secret file.
  - **`ecosystem.config.js` was still git-tracked on the VPS** — `git check-ignore` said NOT ignored
    and `git status` listed it as modified, i.e. the copy holding the real `SUPABASE_SERVICE_KEY`,
    `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. `.gitignore` has listed it since 2026-08-13 but the
    file was force-added before that rule, and git never retroactively untracks. One `git add -A` on
    the server would have committed live credentials. This is the **third** instance of the identical
    pattern (`db/config.json` + `db/users.json` 2026-07-30, `db/settings.json` earlier today) — and
    the most sensitive. `git rm --cached` applied; only placeholders were ever committed so **no
    rotation is needed**. On the VPS the real file was copied aside, the deletion pulled, then
    restored — verified afterwards: untracked, ignored, real URL, `PORT: 3001` intact.
  - **A cron had been failing silently every night for a month.** `0 1 * * *
    /home/ddservice/mikrotik/log_rotation_backup.sh` still ran daily, but that script was deleted
    from the repo on 2026-07-29; with `>/dev/null 2>&1` nobody ever saw the error. Removed (crontab
    backed up to `~/backups/` first). Nothing was lost: `pm2-logrotate` v3.0.0 does the actual
    rotation (`retain 10`, daily), and the nightly DB backup runs from inside `server.js` at 02:00.
  - **Nothing was ever deleted anywhere.** `logs/` held rotated PM2 files back to 30 July, `backups/`
    held incident folders from 13 August, and R2 gained a new `YYYY-MM-DD/` folder every night with
    no expiry. Added `scripts/cleanup-old-backups.js` (`npm run cleanup-old-backups`) covering all
    three, wired into the 02:00 backup **only on exit code 0** — a failed backup deletes nothing.
    - `logs/`: only PM2-rotated names matching `(out|error)__YYYY-MM-DD*.log`. The live `out.log` /
      `error.log` are deliberately excluded — deleting those leaves PM2 writing to an unlinked inode.
    - R2: groups by the `YYYY-MM-DD` segment **in the object key**, not `LastModified`, which shifts
      on re-upload. Reuses the zero-dependency SigV4 signer from `backup.js`, adding ListObjectsV2
      with continuation-token paging and batched DeleteObjects.
    - Always keeps the **3 most recent sets regardless of age**, so a system that stopped backing up
      months ago cannot have its last copies deleted.
    - Dry-run verified against live R2: found 9 objects, deleted nothing (backups only began 26 Aug).
  - Moved leftover scratch scripts `_check-sites.js` / `_u.js` out of the project root into
    `~/backups/`. Both read their keys from `ecosystem.config.js` rather than embedding them, so
    nothing was exposed — but they sat untracked and unignored in the repo root.
  - Disk after: 22G of 116G used (19%); `~/mikrotik` is 113M of which 14M is `node_modules`.
  - **Correction to the previous entry**: the v2 sidebar + hash router + Hotspot page were reported
    as "not deployed yet" — they were. They rode along in commit `c45aeb3` and have been live at
    `/v2/` since. Tested afterwards against a fixture: 8 menu items for admin, 9 Overview cards,
    `#/hotspot` routing, 2 active sessions, all four account states computed correctly
    (ใช้งานได้ / หมดอายุ / ใกล้หมด / ปิดใช้งาน), the status filter narrowing to 1 row, the route
    surviving a reload, and zero page errors. Verify before claiming deployment state.

- **2026-08-28 (10)** — Router health alerts moved to **Telegram**, separated from LINE by audience.
  - Operator's call after the Suksawad-CMU alert landed in A4's customer group: **LINE OA is the
    customer channel** (expiry digests for tenants) and **Telegram is the ops channel** (a router is
    down, API auth failed). They now share no configuration and no code path. The connectivity
    monitor no longer touches LINE at all.
  - New `telegram_alert_config` in `app_settings` (single config for the whole system, not per-site —
    the ops team watches every branch and each message names its site). Fields: `enabled`,
    `botToken`, `chatId`, `alertOffline`, `alertOnline`. Implemented in **both** `db.js` and
    `db-supabase.js` (46/46 exports still in parity). On first read it seeds `botToken`/`chatId` from
    the existing Multi-WAN Telegram fields — those already hold the same bot for the RouterOS
    netwatch script — but leaves `enabled: false` so nothing sends until it is switched on
    deliberately.
  - `sendTelegramMessage()` in `server.js` uses plain `https` (no new dependency) and **destroys the
    request on `timeout`** — Node's `timeout` option only arms a socket idle timer, it does not abort
    the request. `sendOpsAlert(text, kind)` wraps it and stays silent when unconfigured so the
    monitor never throws.
  - **Found and fixed the same `timeout` bug in `getOfficialMikrotikLatestVersions()`.** It used
    `https.get(url, { timeout: 3500 })` with no `'timeout'` handler, so if `upgrade.mikrotik.com` was
    slow or blocked the promise never settled and **`GET /api/mikrotik/status` hung for the whole
    request** — a real contributor to the "ช้ามาก" reports. Also moved `lastFetched` into a `finally`
    so a failed fetch still starts the 1-hour cooldown instead of retrying on every single request.
  - API (all `requireAuth(['admin'])`): `GET/POST /api/mikrotik/telegram-alert/config`,
    `POST .../test`, and `POST .../discover-chats` which reads `getUpdates` and lists the chats the
    bot can see, so the operator never has to hunt for a numeric group id by hand.
    **`botToken` is never returned to the browser** — the GET exposes only `hasBotToken` and an
    8-character preview, matching the `sanitizeSitePublic` rule for router passwords. Posting an
    empty `botToken` keeps the stored one, so saving the form without retyping the secret cannot
    erase it.
  - UI: its own tab in the admin-only Settings page — **3. แจ้งเตือนทีมแอดมิน (Telegram)** — rather
    than sharing the LINE tab, so the separation is visible in the interface too. Router Operations
    moved to tab 4. `app.js` bumped to `v=127.0`.
  - Verified locally against the real Telegram API: config round-trips, the token never comes back,
    an empty token preserves the stored value, and a deliberately fake token fails with Telegram's
    own `Unauthorized` — proving the request actually reaches `api.telegram.org`.

- **2026-08-28 (9)** — Offline alert for **Suksawad-CMU landed in A4-Residence's LINE group**; and A4's LINE finally works.
  - Reported live: `🚨 [แจ้งเตือนด่วน: เราท์เตอร์ Offline] สาขา: Suksawad-CMU … invalid user name or
    password (6)` arrived in **A4's** group. Two independent bugs plus one regression.
  - **Bug 1 — the offline/online monitor never checked `enabled`.** It gated only on
    `channelAccessToken && targetId`, so a site with notifications switched off still pushed alerts.
    Now requires `lineConfig.enabled` too, matching the daily digest.
  - **Bug 2 — `getLineDigestConfig` let every unconfigured site borrow another site's credentials.**
    Both DB layers merged `data.targetId || globalTarget` and fell back to the legacy
    `line_digest_config` record when a site had no key of its own. Actual state in production:
    | record | enabled | token | target |
    |---|---|---|---|
    | global legacy | true | present | present |
    | A4-Residence (own) | true | present | present |
    | TingTing (own) | false | **empty** | **empty** |
    | Suksawad-CMU | *no record* | — | — |
    | Auioun@WiFi | *no record* | — | — |
    So three sites were silently inheriting A4's token and group. Now strict in **both** `db.js` and
    `db-supabase.js`: a site with its own record uses only its own values, and a site without one in
    a multi-site install gets `enabled: false` with empty token/target. The legacy global record is
    still read when `siteId` is `'default'` or there is at most one site, so single-site installs
    keep working. This is the discrepancy flagged in the 2026-08-28 (7) entry — checking the raw
    records first is what made it safe to close: A4's own record is fully populated, so tightening
    the fallback cannot silence it.
  - **Regression from the Supabase switch — `Suksawad-CMU` had a stale router password.** The
    migration matched it to the JSON `SuksawatWiFi` entry by `wireguard_ip` and deliberately did not
    overwrite existing site rows, but Supabase's copy of the password was old. Probed both against
    the live router before touching anything: Supabase's failed with `invalid user name or password
    (6)`, the JSON one returned `identity=SuksawatWiFi ver=7.24.1`. Copied the working credential
    into Supabase. **Lesson: "don't modify existing rows" is right for logs and wrong for
    credentials** — when the same router exists in both stores, verify which secret actually
    authenticates instead of assuming the destination is current.
  - LINE for A4 is now genuinely armed: its own record has `enabled: true`, a real token and group,
    schedule 09:00, and `lastSentDate` 2026-08-23 — so the next digest is tomorrow 09:00.

- **2026-08-28 (8)** — **Production had silently fallen back to Local JSON. Recovered to Supabase after migrating the stranded data.**
  - `ecosystem.config.js` on the VPS had `SUPABASE_URL: 'https://YOUR_PROJECT_ID.supabase.co'` — the
    placeholder. Express correctly ignored it (2026-08-13 (7) behaviour) and ran on **Local JSON**,
    logging `[DB] Using: Local JSON files` on every restart. `/health` reported `"db":"local-json"`.
    This is incident-prevention rule #4 recurring.
  - Divergence at the time of discovery — Supabase vs the JSON store the app was actually using:
    | table | Supabase | Local JSON |
    |---|---|---|
    | sites | 3 | 4 |
    | hotspot_logs | 40,532 | 5,487 |
    | **dns_query_logs** | 109,514 | **0** |
    | pppoe_usage_logs | 323 | 74 |
    | activity_logs | 583 | 24 |
    **No DNS query logging happened at all while in JSON mode** — a มาตรา 26 retention gap for that
    window, and it cannot be reconstructed.
  - **Two reasons A4-Residence stopped notifying**, both needed fixing:
    1. The app was reading `db/settings.json`, not the Supabase `line_digest_config_*` records where
       A4's real token and group live.
    2. Even in Supabase, **`enabled` was `false` for every site**, and A4's `lastSentDate` was
       `2026-08-23` — the date the "restrict LINE to A4 only" cleanup (2026-08-23 entry) forced
       `enabled: false`. The 2026-08-26 change removed that restriction but never turned the flag
       back on.
  - The site records did **not** line up by name, so migration matched by `id`, then `wireguard_ip`,
    then `host`: `TingTing@WiFi`↔`TingTing` (10.10.88.2) and `SuksawatWiFi`↔`Suksawad-CMU`
    (10.10.88.4) are the same routers under different names; `A4-Residence` matched by id; and
    **`Auioun@WiFi` (the main site) did not exist in Supabase at all**.
  - Added `scripts/migrate-json-to-supabase.js` (`npm run migrate-json-to-supabase`) — dry-run by
    default, `--apply` to write, `upsert` on `id` so reruns cannot duplicate, never deletes, never
    touches `dashboard_users` or `app_settings`. Log `site_name` values are normalised to the
    Supabase names so existing filters keep matching.
  - **Applied on the VPS**: added the missing `Auioun@WiFi` site (with credentials), moved 5,499
    hotspot logs, 74 PPPoE usage logs and 24 activity logs. Result: sites 3→4, hotspot_logs
    40,532→46,031, pppoe_usage_logs 323→397, activity_logs 583→607.
  - **`archived_hotspot_users` does not exist in Postgres.** The archive feature shipped
    (2026-08-26) but its `CREATE TABLE` was never run — the code silently swallowed the error, so
    nothing has ever been archived in production. The migration prints the exact SQL and skips the
    table; 3 rows are still pending in `db/archived_hotspot_users.json` until the table is created
    and the script is rerun. SQL lives in `ARCHIVE_TABLE_SQL` in that script (RLS on, no policies,
    per the Database-migrations convention).
  - Restored the real Supabase credentials into the VPS `ecosystem.config.js` by patching **only the
    two `SUPABASE_*` lines**. `ecosystem.config.js.REAL.bak` must **not** be copied wholesale — it
    carries `PORT: 3000` and no `exec_mode`, which would collide with nginx (which proxies 3001) and
    drop the fork-mode requirement. Verified after patching: `script: server.js`, `exec_mode: fork`,
    `cwd` absolute, `PORT: 3001`, preflight OK. Then `pm2 reload` →
    `[DB] Using: Supabase (PostgreSQL)`, `/health` → `"db":"supabase"`, `/` and `/v2/` both 200,
    4 sites and 3 dashboard users visible.
  - Enabled the LINE digest for **A4-Residence only**. The other three sites all read the same
    token/targetId through the legacy global-record fallback, so enabling them would fire duplicate
    digests into the same LINE group — they need their own config first. Enabling A4 sent nothing
    immediately: it is 14:34, the schedule is 09:00, and 334 minutes is outside the 180-minute
    catch-up window, so the first delivery is tomorrow 09:00.
  - Also fixed `.gitignore`: `db/backups-pre-restore/` on the VPS holds `config.json` (real router
    credentials), `users.json` (password hashes) and `sites.json`, and **none of it was ignored** —
    `db/*.json` does not match subdirectories. Now `db/**`. The 2026-07-30 fix covered only the two
    top-level files. And recorded `deploy.sh` as mode 100755 so the VPS copy stops showing as
    modified and blocking `git pull` (it already blocked one pull this session).

- **2026-08-28 (7)** — Site switching was querying the **wrong router**; LINE daily digest could silently skip a day.
  - **17 route handlers called `executeOnRouter(async (client) => …)` without passing `req`.** With no
    `req`, `targetSiteId` resolves to `null`, so `db.getConfig(null)` returns the *globally active*
    site and the `X-Site-Id` header is ignored entirely. Picking a site in the dropdown therefore
    showed **another site's data** for: all PPPoE routes (active, users PUT/DELETE, suspend, kick,
    profiles CRUD, server-settings), all Firewall routes (status, custom-rules CRUD, toggle), and
    hotspot voucher generate. It also bypassed the non-admin `assignedSiteId` site lock on those
    routes. Fixed by passing `req` at all 17 call sites. Left alone: the two Global Search calls and
    the LINE webhook, which correctly use the `executeOnRouter(fn, siteId)` form.
    Proven with two fake routers on different ports: asking for site_2's PPPoE profiles connected to
    **site_1's** router before the fix, and to site_2's after.
  - **Connection pool had no in-flight dedupe.** The Overview fires `/status`, `/hotspot/active` and
    `/pppoe/active` together; all three saw an empty pool and each opened its own TCP connection +
    login, and two of the three sockets were orphaned because the pool map only keeps the last.
    `getPooledRouterClient` now shares one in-flight connect promise. Note the check must happen
    **before the first `await`** — keying off `poolKey` (computed after `await db.getConfig`) still
    raced; it is now keyed off `siteId`, which is available synchronously. Measured: 3 parallel
    requests went from 2 connections to 1, and a warm second round opens 0.
  - `executeOnRouter` no longer retries when the connection it used was freshly opened. The retry
    exists for a stale pooled socket; retrying a fresh connect just doubled the wait (10s connect
    timeout × 2) for an offline site.
  - **Frontend: switching site did not reload anything.** `@change` only wrote the ref and
    localStorage, so the Overview kept showing the previous site's numbers until the next 10-second
    poll, with no indication anything was happening — this is the "อัพเดทข้อมูลช้ามาก" report. Now a
    `watch` on `activeSiteId` reloads immediately, restarts the poll timer, dims the grid and shows
    "กำลังดึงข้อมูลสาขา...". Added a request-generation guard so a slow reply from the previous site
    cannot overwrite the newly selected one, and the three requests now run in parallel instead of
    status-then-counts.
  - **LINE daily digest: `currentHHMM === config.digestTime` is a single-minute window.** A
    `setInterval(60000)` that drifts, is delayed by event-loop pressure, or restarts across the
    target minute misses it and the digest never fires that day. Worse, the whole per-site loop was
    inside one `try`, so a site whose router was offline at that moment aborted the loop and every
    remaining site was skipped too. Now: each site has its own `try/catch`, and the trigger is
    `now >= digestTime` with a 180-minute catch-up window (`LINE_DIGEST_CATCHUP_MINUTES`) so a
    missed tick still delivers, while a machine that was down all day does not fire at midnight.
    Failures are logged to the activity log and `lastSentDate` is left unset so the next tick retries.
  - Added **`GET /api/mikrotik/line-digest/status`** (admin) — reports Bangkok time/date and, per
    site, `enabled` / `hasChannelAccessToken` / `hasTargetId` / masked target / `digestTime` /
    `lastSentDate` / `sentToday` / `dueNow` and a plain-language reason. Never returns the token.
    This is the first thing to check when a site reports "ไม่มีการแจ้งเตือน".
  - **Untracked `db/settings.json`** (`git rm --cached`). It matched the `db/*.json` gitignore rule
    but was still tracked, exactly like `config.json` / `users.json` on 2026-07-30 — that fix missed
    this third file. In JSON-fallback mode this file holds LINE Channel Access Tokens. Checked the
    committed content first: it only ever contained `autoCleanupExpired` / `cleanupIntervalMinutes`,
    **no secret has been committed**, so no rotation is needed. Same pull caution as 2026-07-30 —
    back it up on the VPS before pulling this commit.
  - **Known discrepancy, deliberately not changed:** CLAUDE.md's LINE section claims unconfigured
    secondary sites "strictly default to disabled without falling back to another site's
    token/targetId". In the current code **both** `db.js` and `db-supabase.js` still fall back to the
    legacy global `line_digest_config` record when a site has no key of its own. Tightening this
    would silence any site that is currently working *because* of that fallback, so it needs the
    operator to confirm each site has its own config first — `/line-digest/status` now makes that
    visible. Also worth noting `check-db-parity.js` cannot catch this class of drift: both files have
    identical signatures and identical (wrong) behaviour.

- **2026-08-28 (6)** — `/v2/`: firmware-only upgrade path + typography/card redesign.
  - **The pilot had no way to upgrade firmware alone.** The 1-Click button only appeared when
    RouterOS itself had an update. On Auioun@WiFi (`RBD52G-5HacD2HnD`) RouterOS was already at
    `6.49.20 (long-term)` while the RouterBOARD firmware was still `6.49.7` — so the operator could
    see the pending firmware upgrade but had no button to run it. Added a separate action on the
    Firmware card, and `FullUpgradeModal` now takes `mode`: `'full'` (4 steps, unchanged) or
    `'firmware'` (2 steps — `full-upgrade-stage2`, which is `/system/routerboard/upgrade` plus an
    automatic reboot, then poll until the board is back). Header, description, confirm text and
    button label all switch with the mode.
  - **`/v2/index.html` never loaded any webfont.** `style.css` asks for `'Inter', 'Prompt'` and the
    legacy `index.html` pulls both from Google Fonts, but the pilot's own entry HTML did not — so
    every glyph fell back to the Windows default (Tahoma/Leelawadee), which is what "ตัวอักษรโบราณ"
    was. Now loads **Inter** (Latin/numerals) + **IBM Plex Sans Thai** (Thai); the browser picks per
    script. Added `src/styles/base.css` with design tokens, antialiasing, and a `.v2-num` class using
    `tabular-nums` so the numbers stop shifting sideways on every 10-second refresh.
  - Rewrote `StatCard.vue` with its own CSS instead of borrowing legacy `.stat-card`. The old card
    assumed short values, so `RBD52G-5HacD2HnD` and `อุณหภูมิ & Voltage` wrapped across three lines
    and left the grid ragged. Now: label on one line with ellipsis, value on its own line, footer
    slot for pills/actions, `240px` minimum column, hover lift, and `<button>` semantics (real focus
    ring) when the card is clickable.
  - Verified in Chrome with a fixture matching the reported state (`hasUpdate: false`,
    `currentFirmware 6.49.7`, `upgradeFirmware 6.49.20`): fonts report as loaded, the Firmware card
    shows the upgrade button, the modal opens in 2-step firmware mode as a direct child of `<body>`,
    and the 4-step full mode still works when RouterOS does have an update. Zero page errors.

- **2026-08-28 (5)** — `/v2/` gets its own login page; no longer depends on the legacy UI.
  - The pilot previously showed a "กรุณาเข้าสู่ระบบที่หน้าหลักก่อน" gate when `localStorage` had no
    token, which made it unusable in a fresh browser profile. Added `LoginPage.vue` posting to the
    same `POST /api/auth/login` and storing the same `localStorage` keys (`token` / `user`), so the
    two UIs still share a session. Added a logout button in the topbar (`POST /api/auth/logout`,
    then clears client state even if the server call fails because the token already expired).
  - Also checked the reported "หน้าเบี้ยว" layout: loaded the **live** `/v2/` in Chrome and measured
    it — the card sits at x=210.5 in an 881px viewport and y=259.75 in a 734px one, i.e. exactly
    centred, and the deployed CSS is byte-identical to the local build. No layout bug; it was a
    paint artifact while the page was still loading. Kept as a note because "screenshot looks wrong,
    measure before changing code" already saved time once this session.
  - Verified end to end in real Chrome, no page errors: login form shows on a cold profile, wrong
    password surfaces `Invalid username or password`, correct password lands on the dashboard with
    9/9 cards, the session survives a reload, and logout returns to the form and clears the token.

- **2026-08-28 (4)** — **Root cause of "Connection timeout to MikroTik Router" on 1-Click upgrade: `routeros.js` used an idle timeout as if it were a connect timeout.**
  - `connect()` called `socket.setTimeout(10000)` and left it set for the whole life of the socket.
    Node's `socket.setTimeout(ms)` is an **idle** timeout — it fires whenever the socket is quiet
    for `ms`, *including while waiting for a slow command to finish*. `handleSocketError()` then
    rejected every queued command. So **any RouterOS command taking more than 10 seconds failed,
    while the router was working perfectly.** Affected: `/system/backup/save` (writes a file on the
    board), `/system/package/update/install` (downloads from MikroTik's servers — 30s to several
    minutes), `/system/routerboard/upgrade`, and `/ping count=N` (takes ≥N seconds by definition).
  - Second, separate defect on the same path: `/system/reboot`, `/system/package/update/install`
    and `/system/routerboard/upgrade` make the board drop the connection and **never send `!done`**.
    The old client reported that as `Socket connection closed` — a failure — even though the command
    had been delivered and the router was doing exactly what was asked.
  - Fix in `routeros.js`:
    - `socket.setTimeout(connectTimeoutMs)` now applies only until the `connect` event; on connect it
      switches to `socket.setTimeout(0)` and per-command timers take over.
    - `exec(command, args, options)` gained `timeoutMs` (default 30s) and `expectDisconnect`.
      With `expectDisconnect`, a socket close or timeout **after the command was written** resolves
      instead of rejecting.
    - Added `finishItem()` so a queued command can never be settled twice.
  - Call-site timeouts in `server.js`: check-for-updates 60s, backup/save 120s, routerboard/upgrade
    120s, ping `(count + 15)s`, quality-test ping 30s; `package/update/install` 300s +
    `expectDisconnect`; `/system/reboot` 15s + `expectDisconnect`.
  - Verified against a fake RouterOS API server (fixture, not the live router). Old client vs new,
    same three cases:
    | case | before | after |
    |---|---|---|
    | command that takes 15s | ✗ `Connection timeout to MikroTik Router` (the exact error reported) | ✓ succeeds at 15.0s |
    | install then board drops the link | ✗ `Socket connection closed` | ✓ resolves as success |
    | command that genuinely hangs | ✓ times out at 10s | ✓ times out at the configured 3s |
  - **Lesson**: `socket.setTimeout()` in Node is not a connect timeout. Setting it once at connect
    time silently caps how long *every future command* may take.

- **2026-08-28 (3)** — Frontend migration starts: Vue 3 + Vite pilot at `/v2/`, backend untouched.
  - Audited the backend before deciding: **97 REST routes, all JSON, Bearer-token auth, zero
    server-rendered HTML, no client-side routing.** The frontend is already a pure API client, so
    it can be replaced in complete isolation. All machine-facing paths
    (`/api/wireguard/callback-register` called by the router via `/tool/fetch`, `/api/line/webhook`
    called by LINE, `/health` for UptimeRobot, `routeros.js`, `executeOnRouter`, the 5-min poller,
    LINE digest scheduler, 60s offline monitor, nightly backup) are server-side only and cannot be
    touched by frontend work. See the expanded "Product direction" section for the full rationale
    and the Next-vs-Vite blast-radius table.
  - Added `frontend/` — Vue 3 + Vite 6, **its own `package.json`** so the root one (which the VPS
    installs from with `--omit=dev`) never gains a build dependency. Builds to `public/v2/`, which
    Express already serves as static. **No change to `server.js`, PM2, nginx, ports, or the deploy
    command.** `public/v2/` is committed on purpose — the VPS has no build toolchain.
  - Pilot scope: the Overview page, at full parity (all 9 stat cards, same `style.css`, same Thai
    strings, `formatUptime` ported verbatim) plus the 1-Click upgrade modal. Uses the same
    `localStorage` token as the old UI, so both can be open at once during the transition.
  - Verified in real Chrome: 9/9 cards render, uptime formats to `14 สัปดาห์ 1 วัน` identically,
    the modal's `<Teleport to="body">` puts it as a **direct child of `<body>`** at `top: 0` —
    the 28 ส.ค. nesting bug is now structurally impossible, not just guarded against.
    Bundle: 85 kB raw / 33 kB gzip.
  - Vite emits content-hashed filenames, so **`?v=` bumping and Cloudflare cache-purging stop being
    a manual step** for anything under `/v2/`.
  - Isolated the build from the repo-root `postcss.config.js` / `tailwind.config.js` left over from
    the dead Next experiment (`css: { postcss: {} }`) — Vite was walking up and picking them up.
  - `npm run build:frontend` / `npm run dev:frontend` added at the root. Migration order and the
    non-negotiable rules are in `frontend/README.md` and the Product direction section.

- **2026-08-28 (2)** — Follow-ups on the modal fix: de-duplicate Router Operations, add two guard scripts, fix Global Search.
  - **Router Operations panel removed from Overview.** It was duplicated verbatim: `#panel-router-operations` on Overview *and* `#tab-settings-ops` on the Settings page ("จัดการระบบเราท์เตอร์ & แจ้งเตือน" → tab 3). Kept the Settings copy only — reboot/backup/upgrade are maintenance actions, they belong on the router-management page, not on a monitoring dashboard. Every handler already used class selectors (`.btn-system-reboot, #btn-system-reboot, #btn-system-reboot-settings`) so nothing needed rewiring. Dropped the now-dead `panel-router-operations` role gate in `app.js`; the Settings page is already admin-only via `#nav-settings` + `requireAuth(['admin'])`. The RouterOS Version stat card keeps its small "1-Click อัปเกรด" shortcut — that one is contextual, not a duplicate panel.
  - **`scripts/validate-html.js`** (`npm run validate-html`) — static structure check on `public/index.html`: unclosed/stray tags, duplicate `id`s, `<form>` inside `<form>`, and `.modal-wrapper` nested inside another `.modal-wrapper`. Regression-tested against the pre-fix file: it reports all 18 defects including every one fixed in the entry below. Run it before any commit that touches `index.html`.
  - **`scripts/check-db-parity.js`** (`npm run check-db-parity`) — enforces the "both DB files must match" convention: exports present in only one file, mismatched parameter counts, and `.then()/.catch()/.finally()` called directly on a `db.*()` result in `server.js` (the 2026-08-13 (6) bug — Supabase returns a real Promise so it passes, Local JSON returns a plain object and throws `.catch is not a function`). Current state: **44/44 exports match, no arg-count drift** — the two layers have not drifted.
  - **Global Search (Ctrl+K) only ever returned sites.** `check-db-parity.js` immediately caught it: `GET /api/search/global` called `db.getHotspotUsers(s.id)` and `db.getPppoeUsers(s.id)`, which **exist in neither DB file** — Hotspot/PPPoE accounts live on the router, not in the DB. The `TypeError` was swallowed by a bare `catch (_) {}`, so the search silently skipped both categories. Rewired to `executeOnRouter(fn, s.id)` hitting `/ip/hotspot/user/print` and `/ppp/secret/print`. (Nobody could have noticed — the Ctrl+K modal itself was one of the 8 broken by the markup bug below.)
  - Verified in real Chrome after all changes: Overview no longer has the panel, 1-Click modal opens at `top: 0`, Ctrl+K opens, Settings tab 3 renders the ops centre, zero page errors.

- **2026-08-28** — **Root cause of "1-Click อัปเกรด กดแล้วไม่มีอะไรเกิดขึ้น": three unclosed `<div>`s in `public/index.html` that silently nested 8 modals inside other elements.** Not a JS/CSS bug — the previous three attempts (v123/v124/v125) patched `openFullUpgradeModal()` and `.modal-wrapper` CSS, but the modal was opening correctly all along; it was invisible because the browser had re-parented it inside a hidden ancestor.
  - Verified with a real Chrome run (Playwright, local JSON-fallback server on port 3099, router host temporarily pointed at `127.0.0.1` per the 2026-07-30 safe-testing note): `document.getElementById('modal-full-upgrade').parentElement` was `#modal-security-script`, whose chain went `… < div.modal-footer < form#form-profile-item < div.modal-body < div.modal-card < div#modal-profile`. An ancestor with `opacity: 0 !important` makes every descendant invisible no matter what the child's own `opacity`/`visibility`/`z-index` say, and the ancestor's `backdrop-filter` also became the containing block for the child's `position: fixed` (measured `top: 168px` instead of `0`).
  - Three separate defects, each from a different commit:
    1. `#modal-profile` (`4fa11f0`, 2026-07-29) — `.modal-footer` / `form#form-profile-item` / `.modal-body` / `.modal-card` / `.modal-wrapper` all left unclosed after the "บันทึกโปรไฟล์" submit button.
    2. `#modal-security-script` (`fbf22d1`, 2026-08-12) — `.modal-wrapper` left unclosed after `.modal-card`.
    3. `#auto-cleanup-card` (`4fa11f0`, 2026-07-29) — left unclosed, so `#hotspot-sensitive-warning` and the whole Hotspot accounts table were rendered *inside* the auto-cleanup card.
  - **Features that were dead in production because of this, not just the upgrade button**: ต่ออายุคูปอง 1-Click (`#modal-hotspot-renew`, broken since `90d487e` 2026-08-03 — nested forms are illegal, so the browser dropped `form#form-hotspot-renew` entirely; this is the real reason the recurring "reached uptime limit after top-up" complaints from the 2026-08-02 entry never went away), สคริปต์ Hardened Security, ตรวจสอบ/ติดตั้ง RouterOS Update, Ping Test, Site Diagnostics, Global Search (Ctrl+K), และ Network Quality/Jitter Test.
  - Also removed a duplicate `<div id="sidebar-overlay">` (the stray copy at the end of the modal block; the real one lives inside `#dashboard-container` at line 63).
  - `index.html` now passes a full tag-balance scan, all 18 `.modal-wrapper`s are direct children of `<body>`, no duplicate IDs, all 8 `.page-section`s sit directly under `.content-body`. Confirmed visually: the 1-Click upgrade modal opens centered at `top: 0`.
  - Bumped `?v=` to `126.0`. **`index.html` itself is not cache-busted** — after deploy, hard-refresh and/or purge Cloudflare for `/` or the fix won't be visible.
  - **Lesson**: when a UI element "does nothing" and the JS/CSS both look right, check the *parsed DOM parent chain* (`el.parentElement` walk) before touching the code again. Three commits were spent fixing symptoms in `app.js`/`style.css` for a markup bug.

- **2026-08-26 (12)** — 4 Enterprise Enhancements: Auto-Backup Guard, Multi-Site Daily Health LINE Push, Live Jitter/Quality Test, and Global Search (Ctrl+K).
  - 1. **Auto-Backup Safety Net**: Auto-saves snapshot `.backup` on router before executing RouterOS upgrades.
  - 2. **Daily Multi-Site Health Report to LINE OA**: Added multi-site health digest generator (`generateMultiSiteHealthDigest`) and Flex Message card with `POST /api/mikrotik/line-health/run-now` and one-click manual send.
  - 3. **Live Network Quality & Ping Jitter Test**: Added `POST /api/mikrotik/system/quality-test` calculating average ping latency, jitter, packet loss percentage, and quality grade (`A+` to `D`) with UI modal (`#modal-quality-test`).
  - 4. **Global Quick Search (`Ctrl + K`)**: Spotlight-style real-time search across all 4 sites for Sites, Hotspot user accounts, PPPoE room secrets, and IPs (`public/index.html` + `public/app.js` `v=113.0` and `server.js`).

- **2026-08-26 (11)** — 1-Click Automated Full System Upgrade (ROS + Firmware 2-Stage Workflow).
  - Built seamless automated multi-stage upgrade engine:
    1. Stage 1: Download & install RouterOS package (`/system/package/update/install`).
    2. Polling Stage 1: Auto-reconnect & verify router boots into new RouterOS version.
    3. Stage 2: Upgrade RouterBOARD Firmware (`/system/routerboard/upgrade`) and trigger automated reboot.
    4. Polling Stage 2: Verify router boots with updated Firmware and confirm 100% operational readiness.
  - Added dedicated 1-Click button (`#btn-full-system-upgrade`) and real-time step-by-step progress tracking modal (`public/index.html` + `public/app.js` `v=112.0` and `server.js`).

- **2026-08-26 (10)** — Humanized Uptime Formatting & Official MikroTik ROS Latest Version Integration.
  - Formatted Overview Uptime into compact, human-readable Thai intervals (e.g. `14 สัปดาห์ 1 วัน`, `2 วัน 18 ชม.`) with full exact uptime tooltip, eliminating frame overflow and wrapped text.
  - Integrated official MikroTik RouterOS latest version checker (`upgrade.mikrotik.com/routeros/LATEST.7` and `LATEST.6`) in `/api/mikrotik/status` and `/api/mikrotik/system/update-check`.
  - Added live "มีเวอร์ชันใหม่: vX.X" / "เวอร์ชันล่าสุดแล้ว" badge and 1-Click "อัปเดต" quick action directly on the RouterOS Version card (`public/index.html` + `public/app.js` `v=111.0`).

- **2026-08-26 (9)** — Complete Multi-Site Connection Restoration & 4 Sites Online.
  - Successfully connected and verified all 4 production sites:
    1. `Auioun@WiFi` (Main Site): `b4a00a4696aa.sn.mynetname.net:8927` (hAP ac^2, ROS 6.49.7).
    2. `TingTing@WiFi`: `10.10.88.2:8728` (hEX, WireGuard VPN).
    3. `A4-Residence` (`CCR2004`): `10.10.88.3:8728` (CCR2004-16G-2S+, WireGuard VPN).
    4. `SuksawatWiFi` (Suksawad-cmu): `10.10.88.4:8728` (hEX, ROS 7.24.1, WireGuard VPN).
  - Built diagnostic and repair scripts `scripts/diagnose-vps-status.js`, `scripts/fix-and-sync-sites.js`, and `scripts/test-suksawad.js`.

- **2026-08-26 (8)** — Automatic Startup WireGuard Peer Sync & Robust Config Fallback.
  - Implemented automatic WireGuard peer registration on startup (`syncAllWireguardPeersOnStartup`) in `server.js` to ensure all database-registered peers are immediately provisioned in Linux Kernel `wg0`.
  - Reinforced `getConfig` in both `db-supabase.js` and `db.js` with fallback host/port/username resolution, ensuring secondary sites (`10.10.88.x` WireGuard) never encounter empty connection objects.

- **2026-08-26 (7)** — 5-Step Deep Site Diagnostic Engine & Root Cause Inspector.
  - Implemented `/api/mikrotik/diagnose-site` in `server.js` executing 5 distinct root-cause tests:
    1. Site configuration lookup & completeness check.
    2. DNS Hostname resolution to IP.
    3. WireGuard VPN peer handshake & keepalive verification (`wg show wg0 dump`).
    4. Raw TCP Port socket connectivity (detecting closed ports, firewall blocks, or timeouts).
    5. RouterOS API authentication & system identity retrieval (`/system/resource/print`, `/system/identity/print`).
  - Added interactive Site Diagnostics Modal in `public/index.html` and `public/app.js` (`v=110.0`) with color-coded breakdown and actionable troubleshooting steps.

- **2026-08-26 (6)** — Multi-Site Live Connection Status & UI Clarity in Site Management.
  - Replaced misleading "ปิดใช้งาน" label in `#table-sites` with clear "สแตนด์บาย (Standby)" vs "เลือกใช้งานอยู่ (Active)".
  - Added automatic real-time live connectivity testing and status badges (`ออนไลน์ (Online)` / `ออฟไลน์ (Offline)`) for every site in the Multi-Site Management table (`public/index.html` + `public/app.js` `v=109.0`).
  - Allowed all authenticated roles to query `/api/mikrotik/test-connection?siteId=...` so every staff can check router health.

- **2026-08-26 (5)** — Instant Router Offline/Online LINE Alert, In-Memory Caching & 1-Click R2 Restore Script.
  - Implemented 60-second real-time Router Connectivity Monitor in `server.js` with automated LINE OA Push Alerts (`🚨 [แจ้งเตือนด่วน: เราท์เตอร์ Offline]` and `✅ [ระบบกลับมาออนไลน์]`).
  - Added Server-side In-Memory Caching (20s TTL) with instant invalidation for `sites` and `config` in `db-supabase.js`, cutting database roundtrip latency and Supabase connection overhead.
  - Added 1-Click Disaster Recovery script [`scripts/restore-from-r2.sh`](file:///z:/independentz/Web/Mikrotik/scripts/restore-from-r2.sh) for Cloudflare R2 backup restoration.

- **2026-08-26 (4)** — Multi-Site Connection Resilience & Super Admin Access Restriction for Router Operations.
  - Restricted Router Operations & Maintenance Panel (`#panel-router-operations`) and all 6 backend endpoints exclusively to Super Admin (`role === 'admin'`). Co-Admin and User roles cannot view or execute system maintenance actions.
  - Enhanced multi-site routing in `executeOnRouter` across `server.js` to automatically extract site ID from query, body, `X-Site-Id` header, and site locks.
  - Added automatic `X-Site-Id` header injection to `apiFetch` in `public/app.js` (`v=108.0`) to guarantee UI actions target the exact active site without cross-site interference.
  - Improved `getConfig(siteId)` in `db-supabase.js` and `db.js` to match both site `id` and `name` with case-insensitivity and trim, resolving multi-site disconnects when site names or varied casings are passed.

- **2026-08-26 (3)** — Overview RouterOS Version, Firmware Display & Router Operations Panel.
  - Added real-time display cards for RouterOS Version, RouterBOARD Firmware (Current vs Upgrade), and System Health (Temperature / Voltage).
  - Built comprehensive Router Operations & Maintenance Panel with 6 quick actions:
    1. Check & Install RouterOS Update (`/system/package/update/check-for-updates` & `/install`).
    2. Upgrade RouterBOARD Firmware (`/system/routerboard/upgrade`).
    3. Reboot Router with safety confirmations (`/system/reboot`).
    4. Flush Router DNS Cache (`/ip/dns/cache/flush`).
    5. Live Ping & Latency Test (`/ping address=8.8.8.8 count=4`).
    6. Quick Router Config Backup (.backup) (`/system/backup/save`).
  - Added interactive modals for RouterOS update checking and live ping diagnostics (`public/index.html` + `public/app.js` `v=107.0`).

- **2026-08-26 (2)** — Native Cloudflare R2 Off-site Disaster Recovery Backup Integration.
  - Implemented direct zero-dependency S3 SigV4 uploader in `backup.js` for Cloudflare R2.
  - Configured automated daily backup destination to bucket `ddservicedb` under site folder `Mikrotikapi-db` (`ddservicedb/Mikrotikapi-db/YYYY-MM-DD/`).
  - Added setup script `scripts/setup-r2-backup.sh` and updated `ecosystem.config.js` environment variables.

- **2026-08-26** — Multi-Site Isolated LINE OA Expiry Notifications (Strict Per-Branch Routing).
  - Unlocked independent LINE OA expiry notifications for all branches (A4, TingTing, and additional branches) with strict per-site isolation.
  - Removed restrictive `isA4Site` filter and removed `cleanupNonA4LineConfigs()` in `server.js`, `db.js`, `db-supabase.js`, and `public/app.js` (`v=106.0`).
  - Guaranteed zero cross-site mixing: Each branch strictly scans its own router and sends its daily Flex Card summary exclusively to its own configured LINE OA Channel Access Token and Target/Group ID.

- **2026-08-23** — Permanent Restriction of LINE OA Expiry Notifications to A4 Site Only & System Hardening.
  - Enforced strict `isA4Site` check in backend timer (`setInterval`), preventing any non-A4 sites (e.g. TingTing) from sending daily expiry digest messages to LINE.
  - Added startup database cleanup in `server.js` and strict guards in `db-supabase.js` and `db.js` (`getLineDigestConfig` & `saveLineDigestConfig`) to permanently force `enabled: false` and strip tokens for any non-A4 sites.
  - Updated frontend settings UI (`public/app.js` `v=105.0`) to lock LINE notification controls when non-A4 sites are selected, with clear status indicators.
  - Added interactive Quick Reply action buttons (`LINE_QUICK_REPLY_MENU`) to all LINE Webhook replies for one-tap actions.
  - Enhanced background auto-cleanup for expired Hotspot users to iterate safely across active sites.
  - Added scheduled nightly database backup timer in `server.js` running `backup.js` at 02:00 AM Bangkok time.

- **2026-08-20** — Multi-Site LINE OA Group ID Isolation & Site-Specific Notification Management.
  - Fixed cross-site fallback leak in `db-supabase.js` and `db.js` where sites without individual configurations inherited the global/default LINE target Group ID.
  - Updated `server.js` `generateDailyExpiryDigest(siteId)` and LINE config/test/run-now endpoints to explicitly accept and isolate `siteId`.
  - Added dedicated Site Selector dropdown directly inside the LINE OA settings card in `public/index.html` + `public/app.js` (`v=104.0`) so admin can select and configure Token, Target ID (Group ID), on/off toggle, and daily report time individually per branch (A4-Residence vs TingTing).

- **2026-08-13 (10)** — Close remaining Express-stability follow-ups (no framework rewrite).
  - Slimmed `package.json` to production Express deps only (dropped Next/React/TanStack/
    otplib/qrcode/promptpay/zod/typescript tooling). `src/` stays archived under
    `DO_NOT_DEPLOY.md` but is no longer installable as part of `npm start`.
  - Added `lib/pppoe-iface.js` + used it for live PPPoE + poller billing counters
    (fallback interface name forms). Live verify on A4: 4 sessions matched
    `<pppoe-USERNAME>` with non-zero rx/tx; TingTing had 0 sessions (no PPPoE clients).
  - Added `scripts/rotate-mikrotik-api-password.js` / `verify-pppoe-bytes.js`.
    Applied rotate on VPS: **TingTing OK**; **A4-Residence** blocked by RouterOS
    permissions on `/user` — manual WinBox rotate still required for that site.
  - Product path unchanged: Express + `public/` for speed and stability.
  - VPS: `npm install --omit=dev` dropped 152 unused packages; `/health` supabase OK.

- **2026-08-13 (9)** — Finish post-outage hardening + verification.
  - All sibling app ports bound to **127.0.0.1** (cnx 3002, pems 4000, sop5 5000;
    invest3/minimalcnx already localhost; MikroTik `HOST=127.0.0.1`).
  - Restored real Supabase from `ecosystem.config.js.REAL.bak`; `/health` → `db:supabase`.
  - Verified production sites: **A4-Residence**, **TingTing** (ready); 3 dashboard users;
    logs present (hotspot/DNS/PPPoE). Local JSON may still show an extra
    `สาขาหลัก` — not production source of truth.
  - Removed unused `pems-stale-remind` PM2 cron + source; harden no longer resurrects it.
  - UFW active (22/80/443; DENY public 3005); SSH key-only / no root login; fail2ban on.
  - nginx: `pems.conf` no longer shares `TMHCCp5` server_name with `tmhccp5.conf`.
  - Archived incident bak clutter under `/home/ddservice/backups/`; dropped `.next` from git.
  - E2E probes (2026-08-13): api/sop5/sneakercare 200; cnx/pems/tmhccp5/minimal/invest3 307.
  - Remaining operator action for **A4-Residence** only: API user lacks `/user`
    write — rotate `ddserviceapi` password in WinBox as full admin, then paste into
    Router Settings (TingTing was rotated successfully via script). Optional invest3
    Maps key is unrelated to this app.

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
