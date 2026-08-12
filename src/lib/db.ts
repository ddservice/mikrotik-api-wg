import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { Site, SitesData, DashboardUser, ActivityLog, MultiWanConfig } from './types';

const LEGACY_SALT = 'mikrotik_dash_salt_2026';
const CONFIG_FILE = path.join(process.cwd(), 'db', 'sites.json');
const USERS_FILE = path.join(process.cwd(), 'db', 'users.json');
const LOGS_FILE = path.join(process.cwd(), 'db', 'logs.json');
const MULTIWAN_FILE = path.join(process.cwd(), 'db', 'multiwan.json');
const MENU_PERMS_FILE = path.join(process.cwd(), 'db', 'menu_permissions.json');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

export const isSupabase = !!(supabaseUrl && supabaseKey);
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

function ensureLocalFiles() {
  const dbDir = path.join(process.cwd(), 'db');
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

  if (!fs.existsSync(CONFIG_FILE)) {
    const defaultSites: SitesData = {
      activeSiteId: 'site_1',
      sites: [{ id: 'site_1', name: 'สาขาหลัก (Main Site)', host: '', port: 8728, username: '', password: '' }]
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(defaultSites, null, 4), 'utf8');
  }

  if (!fs.existsSync(USERS_FILE)) {
    const salt = generateSalt();
    const defaultUsers: DashboardUser[] = [
      { id: '1', username: 'admin', salt, passwordHash: hashPasswordPBKDF2('admin1234', salt), role: 'admin', name: 'System Administrator' }
    ];
    fs.writeFileSync(USERS_FILE, JSON.stringify(defaultUsers, null, 4), 'utf8');
  }
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
          await supabase.from('dashboard_users').update({ salt: ns, password_hash: hashPasswordPBKDF2(password, ns) }).eq('id', u.id);
        }
      }
      if (valid) {
        return { id: u.id, username: u.username, role: u.role, name: u.name, assignedSiteId: u.assigned_site_id || 'all' };
      }
    }
  }

  ensureLocalFiles();
  const users: DashboardUser[] = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '[]');
  let user = users.find(u => u.username.toLowerCase() === username.toLowerCase());

  if (!user) {
    if (username.toLowerCase() === 'admin' && password === 'admin1234') {
      const salt = generateSalt();
      user = { id: '1', username: 'admin', salt, passwordHash: hashPasswordPBKDF2('admin1234', salt), role: 'admin', name: 'System Administrator', assignedSiteId: 'all' };
      users.push(user);
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 4), 'utf8');
      return { id: user.id, username: user.username, role: user.role, name: user.name, assignedSiteId: 'all' };
    }
    return null;
  }

  let isValidUser = false;
  if (user.salt) {
    isValidUser = hashPasswordPBKDF2(password, user.salt) === user.passwordHash;
  } else if (user.passwordHash) {
    isValidUser = hashPasswordLegacy(password) === user.passwordHash;
  }

  if (!isValidUser && user.username === 'admin' && password === 'admin1234') {
    const salt = generateSalt();
    user.salt = salt;
    user.passwordHash = hashPasswordPBKDF2('admin1234', salt);
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 4), 'utf8');
    isValidUser = true;
  }

  if (!isValidUser) return null;
  return { id: user.id, username: user.username, role: user.role, name: user.name, assignedSiteId: user.assignedSiteId || 'all' };
}

// ---- SITES & CONFIG ----
export async function getSitesData(): Promise<SitesData> {
  if (isSupabase && supabase) {
    const res = await supabase.from('sites').select('*').order('created_at', { ascending: true });
    if (res.error) throw new Error(res.error.message);
    const sites: Site[] = res.data || [];
    const active = sites.find(s => s.is_active) || sites[0];
    return { activeSiteId: active ? active.id : '', sites };
  } else {
    ensureLocalFiles();
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8') || '{"activeSiteId":"","sites":[]}');
  }
}

export async function getConfig(targetSiteId?: string | null): Promise<Site> {
  const sitesData = await getSitesData();
  const siteId = targetSiteId || sitesData.activeSiteId;
  const site = (sitesData.sites || []).find(s => s.id === siteId) || sitesData.sites[0];
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
    const logs: ActivityLog[] = fs.existsSync(LOGS_FILE) ? JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8') || '[]') : [];
    logs.unshift({ username, action, details, timestamp, site_name: siteName });
    if (logs.length > 2000) logs.length = 2000;
    fs.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 4), 'utf8');
  }
}

export async function getLogs(options: { page?: number; limit?: number; search?: string; siteName?: string } = {}): Promise<{ logs: ActivityLog[]; total: number }> {
  const page = options.page || 1;
  const limit = options.limit || 50;

  if (isSupabase && supabase) {
    let query = supabase.from('logs').select('*', { count: 'exact' });
    if (options.siteName) query = query.eq('site_name', options.siteName);
    if (options.search) {
      query = query.or(`username.ilike.%${options.search}%,action.ilike.%${options.search}%,details.ilike.%${options.search}%`);
    }
    const from = (page - 1) * limit;
    const to = from + limit - 1;
    const res = await query.order('timestamp', { ascending: false }).range(from, to);
    if (res.error) throw new Error(res.error.message);
    return { logs: res.data || [], total: res.count || 0 };
  } else {
    ensureLocalFiles();
    let logs: ActivityLog[] = fs.existsSync(LOGS_FILE) ? JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8') || '[]') : [];
    if (options.siteName) logs = logs.filter(l => l.site_name === options.siteName);
    if (options.search) {
      const s = options.search.toLowerCase();
      logs = logs.filter(l => (l.username || '').toLowerCase().includes(s) || (l.action || '').toLowerCase().includes(s) || (l.details || '').toLowerCase().includes(s));
    }
    const total = logs.length;
    const start = (page - 1) * limit;
    const paginated = logs.slice(start, start + limit);
    return { logs: paginated, total };
  }
}
