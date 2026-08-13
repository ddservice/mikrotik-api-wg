# DO NOT DEPLOY THIS FOLDER TO PRODUCTION

`src/` is an **experimental Next.js App Router prototype** from 2026-08-12/13.

Production is **Express** (`server.js`) + vanilla UI (`public/`).

Deploying `next start` on this VPS previously caused:
- 502 on `api.ddserviceth.com`
- Port collisions with other apps (`minimalcnx` on 3001, etc.)
- Apparent "missing sites" (wrong JSON path / missing Supabase env)

Rules:
- `npm start` must remain `node server.js`
- Never point PM2 `script` at `next`
- Never bind MikroTik to ports owned by other VPS apps (see CLAUDE.md port map)
- Production `package.json` no longer installs Next/React — do not re-add those
  deps unless you are intentionally resurrecting this experiment on a **separate**
  port (never 3001).
