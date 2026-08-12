export interface Site {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  password?: string;
  wireguardIp?: string;
  is_active?: boolean;
}

export interface SitesData {
  activeSiteId: string;
  sites: Site[];
}

export interface DashboardUser {
  id: string;
  username: string;
  name: string;
  role: 'admin' | 'co-admin' | 'user';
  assignedSiteId?: string;
  passwordHash?: string;
  salt?: string;
}

export interface HotspotUser {
  id?: string;
  name: string;
  password?: string;
  profile: string;
  uptime?: string;
  'limit-uptime'?: string;
  bytesTotal?: number;
  'limit-bytes-total'?: number;
  comment?: string;
  disabled?: boolean;
}

export interface PppoeUser {
  id: string;
  name: string;
  password?: string;
  profile: string;
  disabled: boolean;
  comment?: string;
  isOnline: boolean;
  currentUptime: string | null;
  lastLoggedOut: string | null;
}

export interface WanLine {
  id: string;
  name: string;
  interface: string;
  type: 'pppoe' | 'dhcp' | 'static';
  gateway?: string;
  speed: number;
  weight: number;
  dnsCheck: string;
}

export interface PbrRule {
  id: string;
  srcInterface: string;
  targetWanNum: number;
  note?: string;
}

export interface MultiWanConfig {
  wans: WanLine[];
  pbrRules: PbrRule[];
  telegramToken?: string;
  telegramChatId?: string;
  telegramMsgDown?: string;
  telegramMsgUp?: string;
  mssClamping?: boolean;
  fasttrackBypass?: boolean;
  dnsHijack?: boolean;
  hairpinNat?: boolean;
}

export interface ActivityLog {
  id?: string;
  username: string;
  action: string;
  details: string;
  timestamp: string;
  site_name?: string;
}
