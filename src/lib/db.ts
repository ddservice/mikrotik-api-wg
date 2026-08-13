import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { Site, SitesData, DashboardUser, ActivityLog } from './types';

// Must match Express db.js — wrong salt breaks legacy password verification.
const LEGACY_SALT = 'mikrotik_gatekeeper_salt_secure_2026';

// Same path as Express db.js (NOT sites.json — that mismatch made sites look "gone").
const DB_DIR = path.join(process.cwd(), 'db');
const CONFIG_FILE = path.join(DB_DIR, 'config.json');
const LEGACY_SITES_FILE = path.join(DB_DIR, 'sites.json');
const USERS_FILE = path.join(DB_DIR, 'users.json');
const LOGS_FILE = path.join(DB_DIR, 'logs.json');

// Align with Express ecosystem: SUPABASE_SERVICE_KEY (also accept aliases).
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey =
  process.env.SUPABASE_SERVICE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_KEY;

export const isSupabase = !!(supabaseUrl && supabaseKey && !String(supabaseUrl).includes('YOUR_PROJECT_ID'));
export const supabase = isSupabase ? createClient(supabaseUrl!, supabaseKey!) : null;

function generateSalt(): string {
  return crypto.randomBytes(16).toString('hex');
}

function hashPasswordPBKDF2(password: string, salt: string): string {
  return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

function hashPasswordLegacy(password: string): string {
  return crypto.createHash('sha256').update(password + LEGACY_SALT).digest('hex');
}

const emptySitesData = (): SitesData => ({
  activeSiteId: '',
  sites: [],
});

/** Prefer config.json; one-time import from sites.json if that was written by the broken Next path. */
function readLocalSitesFile(): SitesData {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8') || '{}');
      if (parsed.host !== undefined && !parsed.sites) {
        const migrated: SitesData = {
          activeSiteId: 'site_1',
          sites: [
            {
              id: 'site_1',
              name: 'สาขาหลัก (Main Site)',
              host: parsed.host || '',
              port: parsed.port || 8728,
              username: parsed.username || '',
              password: parsed.password || '',
            },
          ],
        };
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(migrated, null, 4), 'utf8');
        return migrated;
      }
      if (Array.isArray(parsed.sites) && parsed.sites.length > 0) {
        return parsed as SitesData;
      }
    } catch {
      /* fall through */
    }
  }

  if (fs.existsSync(LEGACY_SITES_FILE)) {
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_SITES_FILE, 'utf8') || '{}') as SitesData;
      if (Array.isArray(legacy.sites) && legacy.sites.length > 0) {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(legacy, null, 4), 'utf8');
        return legacy;
      }
    } catch {
      /* fall through */
    }
  }

  return emptySitesData();
}

function ensureLocalFiles() {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

  if (!fs.existsSync(CONFIG_FILE)) {
    const data = readLocalSitesFile();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 4), 'utf8');
  }

  if (!fs.existsSync(USERS_FILE)) {
    const salt = generateSalt();
    const defaultUsers: DashboardUser[] = [
      {
        id: '1',
        username: 'admin',
        salt,
        passwordHash: hashPasswordPBKDF2('admin1234', salt),
        role: 'admin',
        name: 'System Administrator',
      },
    ];
    fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 4), 'utf8');
  }
}

export function saveSitesData(sitesData: SitesData): SitesData {
  ensureLocalFiles();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(sitesData, null, 4), 'utf8');
  return sitesData;
}

// ---- AUTH & USERS ----
export async function authenticateUser(username: string, password: string): Promise<DashboardUser | null> {
  if (isSupabase && supabase) {
    const res = await supabase.from('dashboard_users').select('*').ilike('username', username).single();
    if (!res.error && res.data) {
      const u = res.data;
      let valid = false;
      if (u.salt) {
        valid = hashPasswordPBKDF2(password, u.salt) === u.password_hash;
      } else {
        valid = hashPasswordLegacy(password) === u.password_hash;
        if (valid) {
          const ns = generateSalt();
          await supabase
            .from('dashboard_users')
            .update({ salt: ns, password_hash: hashPasswordPBKDF2(password, ns) })
            .eq('id', u.id);
        }
      }
      if (valid) {
        return {
          id: u.id,
          username: u.username,
          role: u.role,
          name: u.name,
          assignedSiteId: u.assigned_site_id || 'all',
        };
      }
    }
  }

  ensureLocalFiles();
  const users: DashboardUser[] = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '[]');
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return null;

  let isValidUser = false;
  if (user.salt) {
    isValidUser = hashPasswordPBKDF2(password, user.salt) === user.passwordHash;
  } else if (user.passwordHash) {
    isValidUser = hashPasswordLegacy(password) === user.passwordHash;
  }

  if (!isValidUser) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    name: user.name,
    assignedSiteId: user.assignedSiteId || 'all',
  };
}

// ---- SITES & CONFIG ----
export async function getSitesData(): Promise<SitesData> {
  if (isSupabase && supabase) {
    const res = await supabase.from('sites').select('*').order('created_at', { ascending: true });
    if (res.error) throw new Error(res.error.message);
    const sites: Site[] = (res.data || []) as Site[];
    const active = sites.find((s) => s.is_active) || sites[0];
    return { activeSiteId: active ? active.id : '', sites };
  }

  ensureLocalFiles();
  return readLocalSitesFile();
}

export async function getConfig(targetSiteId?: string | null): Promise<Site> {
  const sitesData = await getSitesData();
  const siteId = targetSiteId || sitesData.activeSiteId;
  const site = (sitesData.sites || []).find((s) => s.id === siteId) || sitesData.sites[0];
  if (!site) {
    return { id: 'default', name: 'Default Site', host: '', port: 8728, username: '', password: '' };
  }
  return site;
}

// ---- LOGS ----
export async function addLog(username: string, action: string, details: string, siteName?: string): Promise<void> {
  const timestamp = new Date().toISOString();
  if (isSupabase && supabase) {
    await supabase.from('logs').insert([{ username, action, details, timestamp, site_name: siteName || '' }]);
  } else {
    ensureLocalFiles();
    const logs: ActivityLog[] = fs.existsSync(LOGS_FILE)
      ? JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8') || '[]')
      : [];
    logs.unshift({ username, action, details, timestamp, site_name: siteName });
    if (logs.length > 2000) logs.length = 2000;
    fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 4), 'utf8');
  }
}

export async function getLogs(
  options: { page?: number; limit?: number; search?: string; siteName?: string } = {}
): Promise<{ logs: ActivityLog[]; total: number }> {
  const page = options.page || 1;
  const limit = options.limit || 50;

  if (isSupabase && supabase) {
    let query = supabase.from('logs').select('*', { count: 'exact' });
    if (options.siteName) query = query.eq('site_name', options.siteName);
    if (options.search) {
      query = query.or(
        `username.ilike.%${options.search}%,action.ilike.%${options.search}%,details.ilike.%${options.search}%`
      );
    }
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    const res = await query.order('timestamp', { ascending: false }).range(from, to);
    if (res.error) throw new Error(res.error.message);
    return { logs: (res.data || []) as ActivityLog[], total: res.count || 0 };
  }

  ensureLocalFiles();
  let logs: ActivityLog[] = fs.existsSync(LOGS_FILE)
    ? JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8') || '[]')
    : [];
  if (options.siteName) logs = logs.filter((l) => l.site_name === options.siteName);
  if (options.search) {
    const s = options.search.toLowerCase();
    logs = logs.filter(
      (l) =>
        (l.username || '').toLowerCase().includes(s) ||
        (l.action || '').toLowerCase().includes(s) ||
        (l.details || '').toLowerCase().includes(s)
    );
  }
  const total = logs.length;
  const start = (page - 1) * limit;
  return { logs: logs.slice(start, start + limit), total };
}
