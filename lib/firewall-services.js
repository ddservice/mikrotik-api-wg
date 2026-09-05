/**
 * lib/firewall-services.js — รายการบริการที่บล็อกได้ + วิธีวางกฎให้มันทำงานจริง
 *
 * แยกออกจาก server.js สองเหตุผล
 *
 *   1. รายการเดิมอยู่ใน server.js จึงเทสต์ไม่ได้เลย (require server.js = เปิดพอร์ต)
 *      และหน้าเว็บ v2 ก็มีรายการของตัวเองซ้ำอีกชุด สะกดคีย์ไม่ตรงกันเมื่อไหร่
 *      server ตอบ "Invalid service" กลับมา โดยที่ไม่มีอะไรจับได้ตอน build
 *
 *   2. ลำดับกฎ — ของเดิมใช้ /ip/firewall/filter/add เฉย ๆ ซึ่งต่อท้ายสุดของ chain
 *      forward เราท์เตอร์หลายตัวมีกฎ accept กว้าง ๆ อยู่ก่อนหน้า กฎ drop ที่ต่อท้าย
 *      จึงไม่มีวันถูกเรียก = กดบล็อกแล้วขึ้นว่าบล็อกแล้ว แต่เข้าเว็บได้ตามปกติ
 *      เป็นความล้มเหลวแบบเงียบชุดเดียวกับที่ Hardened Preset เจอเมื่อ 2026-09-05
 *
 * เรื่องที่ต้องเข้าใจก่อนแก้รายการโดเมน
 * ------------------------------------
 * RouterOS ยอมให้ใส่ "ชื่อโดเมน" ลงใน address-list ได้ แล้วมันจะ resolve เป็น IP
 * ให้เองและตามอัปเดตตาม TTL การบล็อกจึงเป็นระดับ IP ปลายทาง ไม่ใช่ระดับ DNS
 * ผลที่ตามมาซึ่งสำคัญมากในปี 2026:
 *
 *   - ลูกค้าเปิด DNS-over-HTTPS (Chrome / Android Private DNS) ก็ยัง "บล็อกอยู่"
 *     เพราะเราบล็อกที่ IP ปลายทาง ไม่ได้พึ่ง DNS ของลูกค้า
 *   - แต่ VPN ทะลุได้ทั้งหมด เพราะปลายทางกลายเป็น IP ของ VPN
 *     จึงต้องมีหมวด vpn ไว้ ไม่งั้นหมวดอื่นทั้งหมดไร้ความหมายเมื่อลูกค้าลงแอป VPN
 *   - บริการที่ใช้ CDN ร่วมกับคนอื่น (Cloudflare, Akamai) บล็อกด้วยวิธีนี้จะพลอย
 *     ทำให้เว็บอื่นที่อยู่ IP เดียวกันเข้าไม่ได้ จึงเลี่ยงโดเมนพวกนั้นในรายการ
 */

'use strict';

/**
 * หมวดสำหรับจัดกลุ่มบนหน้าเว็บ — 11 บริการเรียงยาวเป็นพืดอ่านยาก
 */
const GROUPS = [
    { key: 'social', title: 'โซเชียล & แชท' },
    { key: 'video', title: 'วิดีโอ & สตรีมมิ่ง' },
    { key: 'game', title: 'เกม' },
    { key: 'shop', title: 'ช้อปปิ้ง & ไลฟ์ขายของ' },
    { key: 'risk', title: 'ความเสี่ยง & กฎหมาย' },
    { key: 'net', title: 'เครือข่าย & การหลบเลี่ยง' }
];

/**
 * คีย์ของแต่ละบริการคือสัญญาระหว่างหน้าเว็บกับ server — เปลี่ยนคีย์ = ของเดิมพัง
 * เพิ่มได้ ห้ามเปลี่ยนชื่อคีย์เดิม เพราะกฎที่ติดตั้งบนเราท์เตอร์อ้างจาก comment/listName
 */
const SERVICES = {
    // ---------------- โซเชียล & แชท ----------------
    facebook: {
        group: 'social', label: 'Facebook & Instagram', icon: 'fa-brands fa-facebook', color: '#1877f2',
        comment: 'Block Facebook & IG (Dashboard)', listName: 'blocked_facebook',
        domains: ['facebook.com', 'fbcdn.net', 'instagram.com', 'cdninstagram.com',
                  'threads.net', 'facebook.net', 'fbsbx.com', 'messenger.com']
    },
    tiktok: {
        group: 'social', label: 'TikTok', icon: 'fa-brands fa-tiktok', color: '#0f172a',
        comment: 'Block TikTok (Dashboard)', listName: 'blocked_tiktok',
        domains: ['tiktok.com', 'tiktokcdn.com', 'tiktokv.com', 'byteoversea.com',
                  'ibytedtos.com', 'musical.ly']
    },
    line: {
        group: 'social', label: 'LINE', icon: 'fa-brands fa-line', color: '#06c755',
        comment: 'Block LINE (Dashboard)', listName: 'blocked_line',
        domains: ['line.me', 'line-apps.com', 'line-cdn.net', 'line-scdn.net', 'naver.jp']
    },
    social_extra: {
        group: 'social', label: 'X / Discord / Snapchat / Reddit', icon: 'fa-brands fa-x-twitter', color: '#334155',
        comment: 'Block Other Social (Dashboard)', listName: 'blocked_social_extra',
        // เพิ่มปี 2026 — สามตัวนี้เป็นช่องทางแชทหลักของวัยรุ่นแทน Facebook ไปแล้ว
        domains: ['twitter.com', 'x.com', 'twimg.com', 'discord.com', 'discordapp.com',
                  'discord.gg', 'snapchat.com', 'sc-cdn.net', 'reddit.com', 'redd.it']
    },

    // ---------------- วิดีโอ & สตรีมมิ่ง ----------------
    youtube: {
        group: 'video', label: 'YouTube', icon: 'fa-brands fa-youtube', color: '#ef4444',
        comment: 'Block YouTube (Dashboard)', listName: 'blocked_youtube',
        domains: ['youtube.com', 'youtu.be', 'googlevideo.com', 'ytimg.com', 'yt3.ggpht.com']
    },
    netflix: {
        group: 'video', label: 'Netflix & OTT', icon: 'fa-solid fa-film', color: '#e50914',
        comment: 'Block Netflix & Streaming (Dashboard)', listName: 'blocked_netflix',
        // 2026: HBO Max กลับมาใช้ชื่อ Max, Prime Video แยกโดเมนของตัวเอง
        domains: ['netflix.com', 'nflxext.com', 'nflxvideo.net', 'nflximg.net',
                  'disneyplus.com', 'bamgrid.com', 'max.com', 'hbomax.com',
                  'primevideo.com', 'viu.com', 'wetv.vip', 'iq.com', 'iqiyi.com',
                  'trueid.net', 'monomax.me']
    },
    livestream: {
        group: 'video', label: 'Twitch / Kick / Bigo', icon: 'fa-brands fa-twitch', color: '#9146ff',
        comment: 'Block Live Streaming (Dashboard)', listName: 'blocked_livestream',
        // เพิ่มปี 2026 — กินแบนด์วิดท์ต่อคนสูงกว่า VOD เพราะไม่มี cache ช่วย
        domains: ['twitch.tv', 'ttvnw.net', 'jtvnw.net', 'kick.com', 'bigo.tv',
                  'bigolive.tv', 'nimo.tv']
    },

    // ---------------- เกม ----------------
    games: {
        group: 'game', label: 'เกมมือถือ', icon: 'fa-solid fa-gamepad', color: '#8b5cf6',
        comment: 'Block Mobile Games (Dashboard)', listName: 'blocked_games',
        // 2026: เพิ่ม Mobile Legends, CoD Mobile, Valorant Mobile, Wuthering Waves,
        // Arena Breakout, Honor of Kings — ที่มาแทนรุ่นเก่าในรายการเดิม
        domains: ['roblox.com', 'rbxcdn.com', 'garena.com', 'garenanow.com',
                  'freefiremobile.com', 'pubgmobile.com', 'proxima-beta.com',
                  'hoyoverse.com', 'mihoyo.com', 'genshinimpact.com',
                  'supercell.com', 'clashofclans.com',
                  'mobilelegends.com', 'moonton.com',
                  'activision.com', 'callofduty.com',
                  'riotgames.com', 'valorant.com',
                  'kurogame.com', 'kurogames.com',
                  'levelinfinite.com', 'intlgame.com']
    },
    steam: {
        group: 'game', label: 'เกม PC & Console', icon: 'fa-brands fa-steam', color: '#1b2838',
        comment: 'Block Steam & PC Gaming (Dashboard)', listName: 'blocked_steam',
        // 2026: เพิ่ม PSN / Xbox / Nintendo — คอนโซลโหลดแพตช์ทีละหลายสิบ GB
        domains: ['steampowered.com', 'steamcommunity.com', 'steamgames.com',
                  'steamstatic.com', 'steamcontent.com',
                  'epicgames.com', 'unrealengine.com', 'battle.net', 'blizzard.com',
                  'playstation.net', 'playstation.com', 'xboxlive.com',
                  'xbox.com', 'nintendo.net', 'nintendo.com']
    },

    // ---------------- ช้อปปิ้ง & ไลฟ์ขายของ ----------------
    shopping: {
        group: 'shop', label: 'Shopee / Lazada / TikTok Shop', icon: 'fa-solid fa-bag-shopping', color: '#f97316',
        comment: 'Block Shopping (Dashboard)', listName: 'blocked_shopping',
        // เพิ่มปี 2026 — ที่ทำงานบางแห่งขอบล็อกช่วงเวลางาน ไม่ใช่บล็อกถาวร
        // ใช้คู่กับตารางเวลาจะเหมาะกว่าเปิดค้างไว้
        domains: ['shopee.co.th', 'shopee.com', 'susercontent.com',
                  'lazada.co.th', 'lazada.com', 'slatic.net',
                  'shopeemobile.com', 'temu.com', 'aliexpress.com']
    },

    // ---------------- ความเสี่ยง & กฎหมาย ----------------
    adult: {
        group: 'risk', label: 'เว็บผู้ใหญ่', icon: 'fa-solid fa-ban', color: '#be123c',
        comment: 'Block Adult Content (Dashboard)', listName: 'blocked_adult',
        domains: ['pornhub.com', 'xvideos.com', 'xnxx.com', 'stripchat.com',
                  'xhamster.com', 'onlyfans.com', 'chaturbate.com', 'redtube.com']
    },
    gambling: {
        group: 'risk', label: 'พนันออนไลน์', icon: 'fa-solid fa-dice', color: '#dc2626',
        comment: 'Block Gambling (Dashboard)', listName: 'blocked_gambling',
        // เพิ่มปี 2026 — ผู้ให้บริการอินเทอร์เน็ตในไทยมักถูกขอให้ปิดกั้นหมวดนี้
        // หมายเหตุ: เว็บพนันเปลี่ยนโดเมนถี่มาก รายการนี้กันได้เฉพาะตัวใหญ่ ๆ
        // ที่อยู่มานาน ไม่ใช่การกันได้ครบ และไม่ควรเข้าใจว่าครบ
        domains: ['bet365.com', '1xbet.com', 'dafabet.com', 'sbobet.com',
                  'fun88.com', 'w88.com', 'stake.com', 'betflik.com']
    },
    crypto: {
        group: 'risk', label: 'ขุดเหรียญ (Crypto)', icon: 'fa-brands fa-bitcoin', color: '#f59e0b',
        comment: 'Block Crypto Miners & Malware (Dashboard)', listName: 'blocked_crypto',
        // 2026: pool ที่ยังใช้จริง มีค่ากว่า coinhive ซึ่งปิดไปตั้งแต่ 2019
        domains: ['coinhive.com', 'coin-hive.com', 'crypto-loot.com', 'jsecoin.com',
                  'minr.pw', 'coin-have.com', 'nicehash.com', 'minergate.com',
                  'nanopool.org', 'f2pool.com', 'ethermine.org', '2miners.com']
    },

    // ---------------- เครือข่าย & การหลบเลี่ยง ----------------
    vpn: {
        group: 'net', label: 'VPN & Proxy หลบเลี่ยง', icon: 'fa-solid fa-user-secret', color: '#0ea5e9',
        comment: 'Block VPN & Proxy (Dashboard)', listName: 'blocked_vpn',
        // เพิ่มปี 2026 และเป็นตัวที่สำคัญที่สุดในรอบนี้
        // ถ้าลูกค้าลง VPN ได้ หมวดอื่นทั้งหมดข้างบนไร้ผลทันที เพราะปลายทาง
        // กลายเป็น IP ของ VPN ไม่ใช่ IP ของเว็บที่เราบล็อก
        // ข้อจำกัดที่ต้องรู้: นี่กันเฉพาะการ "โหลดแอป/ต่อเซิร์ฟเวอร์หลัก" ของราย
        // ที่ดังเท่านั้น กัน VPN ทุกตัวบนโลกด้วยรายการโดเมนไม่ได้จริง
        domains: ['nordvpn.com', 'expressvpn.com', 'surfshark.com', 'protonvpn.com',
                  'cyberghostvpn.com', 'windscribe.com', 'psiphon.ca', 'psiphon3.com',
                  'hide.me', 'ipvanish.com', 'tunnelbear.com', 'hola.org',
                  'torproject.org', 'opengw.net', 'vpngate.net']
    },
    torrent: {
        group: 'net', label: 'BitTorrent & P2P', icon: 'fa-solid fa-download', color: '#0891b2',
        comment: 'Block BitTorrent & P2P (Dashboard)', listName: 'blocked_torrent',
        domains: ['bittorrent.com', 'utorrent.com', 'qbittorrent.org',
                  'thepiratebay.org', '1337x.to', 'rarbg.to', 'yts.mx',
                  'nyaa.si', 'torrentgalaxy.to']
    },
    ads: {
        group: 'net', label: 'โฆษณา & ตัวติดตาม', icon: 'fa-solid fa-rectangle-ad', color: '#64748b',
        comment: 'Block Ads & Trackers (Dashboard)', listName: 'blocked_ads',
        domains: ['doubleclick.net', 'adservice.google.com', 'googlesyndication.com',
                  'adnxs.com', 'admob.com', 'criteo.com', 'taboola.com', 'outbrain.com',
                  'appsflyer.com', 'adjust.com', 'branch.io', 'scorecardresearch.com']
    }
};

/** คีย์ทั้งหมด เรียงตามลำดับหมวดเพื่อให้หน้าเว็บกับ server เห็นลำดับเดียวกัน */
function listServices() {
    const order = GROUPS.map((g) => g.key);
    return Object.entries(SERVICES)
        .map(([key, s]) => ({ key, group: s.group, label: s.label, icon: s.icon, color: s.color,
                              domainCount: s.domains.length }))
        .sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
}

/**
 * ตำแหน่งที่ควรวางกฎ drop ใหม่ใน chain forward
 *
 * ต้องอยู่ "เหนือ" กฎ accept ตัวแรกของ chain นั้น ไม่งั้นกฎเราไม่มีวันถูกเรียก
 * และเราท์เตอร์จะรายงานว่าบล็อกแล้วทั้งที่ยังเข้าเว็บได้ตามปกติ
 *
 * fasttrack ก็ใช่เหตุผลเดียวกัน — แพ็กเก็ตที่ fasttrack แล้วข้าม filter ทั้ง chain
 * กฎที่อยู่ใต้ fasttrack จึงเห็นเฉพาะแพ็กเก็ตแรกของแต่ละ connection เท่านั้น
 *
 * @returns {string|null} ค่า place-before (.id ของกฎที่ต้องแทรกไว้ข้างหน้า)
 *                        หรือ null เมื่อ chain ว่างหรือไม่มีอะไรมาขวาง = ต่อท้ายได้
 */
function placeBeforeFor(filterRules, chain = 'forward') {
    const inChain = (filterRules || []).filter((r) => String(r.chain || '') === chain);
    if (!inChain.length) return null;         // chain ว่าง — place-before=0 จะ error
    const blocker = inChain.find((r) => {
        const a = String(r.action || '');
        return a === 'accept' || a === 'fasttrack-connection';
    });
    return blocker ? String(blocker['.id']) : null;
}

module.exports = { SERVICES, GROUPS, listServices, placeBeforeFor };
