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

## Syntax-checking (no system Node available)

There is no system Node in this sandbox. Use the Playwright-bundled binary
before committing any JS change:
```
/c/Users/VirusAlert/AppData/Local/ms-playwright-go/1.57.0/node.exe -c <file>
```
Run this on every modified `.js` file (`server.js`, `db.js`,
`db-supabase.js`, `public/app.js`, etc.) — there is no test suite, so this
syntax check plus manual reasoning about call sites is the only safety net
before pushing.

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

## Change log

Keep this updated after every code change — newest entry on top.

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
