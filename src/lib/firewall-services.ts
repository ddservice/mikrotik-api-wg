export interface FirewallServiceDef {
  key: string;
  name: string;
  description: string;
  comment: string;
  listName: string;
  domains: string[];
}

export const FIREWALL_SERVICES: Record<string, FirewallServiceDef> = {
  youtube: {
    key: 'youtube',
    name: 'YouTube & Video Streaming',
    description: 'บล็อกการดูวิดีโอ YouTube (youtube.com, youtu.be, googlevideo.com)',
    comment: 'Block YouTube (Dashboard)',
    listName: 'blocked_youtube',
    domains: ['youtube.com', 'youtu.be', 'googlevideo.com', 'ytimg.com']
  },
  line: {
    key: 'line',
    name: 'LINE Application',
    description: 'บล็อกการใช้งานแชต/โทร LINE (line.me, line-apps.com)',
    comment: 'Block LINE (Dashboard)',
    listName: 'blocked_line',
    domains: ['line.me', 'line-apps.com', 'line-cdn.net']
  },
  games: {
    key: 'games',
    name: 'Mobile & Online Games',
    description: 'บล็อกเกมมือถือ (Roblox, Free Fire, PUBG, RoV, Supercell)',
    comment: 'Block Mobile Games (Dashboard)',
    listName: 'blocked_games',
    domains: ['roblox.com', 'rbxcdn.com', 'garena.com', 'freefiremobile.com', 'pubgmobile.com', 'proxima-beta.com', 'hoyoverse.com', 'genshinimpact.com', 'supercell.com', 'clashofclans.com']
  },
  ads: {
    key: 'ads',
    name: 'Ads & Tracking Networks',
    description: 'บล็อกโฆษณาและเว็บติดตามผู้ใช้ (AdMob, DoubleClick, Taboola)',
    comment: 'Block Ads & Trackers (Dashboard)',
    listName: 'blocked_ads',
    domains: ['doubleclick.net', 'adservice.google.com', 'googlesyndication.com', 'adnxs.com', 'admob.com', 'criteo.com', 'taboola.com', 'outbrain.com', 'appsflyer.com']
  },
  tiktok: {
    key: 'tiktok',
    name: 'TikTok',
    description: 'บล็อกแอปคลิปสั้น TikTok (tiktok.com, tiktokcdn.com)',
    comment: 'Block TikTok (Dashboard)',
    listName: 'blocked_tiktok',
    domains: ['tiktok.com', 'tiktokcdn.com', 'byteoversea.com', 'musical.ly']
  },
  facebook: {
    key: 'facebook',
    name: 'Facebook & Instagram',
    description: 'บล็อกโซเชียลมีเดีย Meta (facebook.com, instagram.com)',
    comment: 'Block Facebook & IG (Dashboard)',
    listName: 'blocked_facebook',
    domains: ['facebook.com', 'fbcdn.net', 'instagram.com', 'cdninstagram.com']
  },
  adult: {
    key: 'adult',
    name: 'Adult & Gambling Content',
    description: 'บล็อกเว็บไซต์ผู้ใหญ่และเว็บพนัน',
    comment: 'Block Adult Content (Dashboard)',
    listName: 'blocked_adult',
    domains: ['pornhub.com', 'xvideos.com', 'xnxx.com', 'stripchat.com', 'xhamster.com']
  },
  netflix: {
    key: 'netflix',
    name: 'Netflix & Streaming Services',
    description: 'บล็อกหนังออนไลน์ (Netflix, Disney+, Viu, WeTV)',
    comment: 'Block Netflix & Streaming (Dashboard)',
    listName: 'blocked_netflix',
    domains: ['netflix.com', 'nflxext.com', 'nflxvideo.net', 'disneyplus.com', 'bamgrid.com', 'viu.com', 'wetv.vip']
  },
  torrent: {
    key: 'torrent',
    name: 'BitTorrent & P2P File Sharing',
    description: 'บล็อกการดาวน์โหลดไฟล์ Torrent ดึงแบนด์วิดท์',
    comment: 'Block BitTorrent & P2P (Dashboard)',
    listName: 'blocked_torrent',
    domains: ['torrent.com', 'bittorrent.com', 'thepiratebay.org', '1337x.to', 'rarbg.to', 'yts.mx']
  },
  steam: {
    key: 'steam',
    name: 'Steam & PC Gaming',
    description: 'บล็อกร้านค้าและเกม PC (Steam, Epic Games)',
    comment: 'Block Steam & PC Gaming (Dashboard)',
    listName: 'blocked_steam',
    domains: ['steampowered.com', 'steamcommunity.com', 'steamgames.com', 'epicgames.com', 'unrealengine.com']
  },
  crypto: {
    key: 'crypto',
    name: 'Crypto Miners & Malware',
    description: 'บล็อกสคริปต์ขุดเหรียญและมัลแวร์แฝงเว็บ',
    comment: 'Block Crypto Miners & Malware (Dashboard)',
    listName: 'blocked_crypto',
    domains: ['coinhive.com', 'coin-hive.com', 'crypto-loot.com', 'jsecoin.com', 'minr.pw', 'coin-have.com']
  }
};
