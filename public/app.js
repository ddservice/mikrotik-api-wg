// ==========================================================================
// STATE MANAGEMENT & CONSTANTS
// ==========================================================================
let API_TOKEN = localStorage.getItem('token');
let CURRENT_USER = JSON.parse(localStorage.getItem('user'));
let currentActivePage = 'page-overview';
let activeHotspotTab = 'tab-hotspot-active';
let currentSitesData = { activeSiteId: '', sites: [] };
let currentSinglePrintUser = null;

// Name of the currently active site — hotspot/DNS/PPPoE log tables are
// tagged with this string per-row, so log views filter by it to avoid
// showing every site's data mixed together.
function getCurrentSiteName() {
    const site = currentSitesData.sites ? currentSitesData.sites.find(s => s.id === currentSitesData.activeSiteId) : null;
    return site ? site.name : '';
}

// Polling intervals
let statsInterval = null;
let trafficInterval = null;
let hotspotOnlineInterval = null;
let pppoeOnlineInterval = null;

// Traffic history for selected interface
let lastTrafficData = { rx: 0, tx: 0, time: 0 };
let downloadHistory = Array(30).fill(0);
let uploadHistory = Array(30).fill(0);
let selectedInterfaceName = '';

// DOM Elements
const loginContainer = document.getElementById('login-container');
const dashboardContainer = document.getElementById('dashboard-container');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');

const userDisplayName = document.getElementById('user-display-name');
const userDisplayRole = document.getElementById('user-display-role');
const routerConnStatus = document.getElementById('router-conn-status');
const updateTimer = document.getElementById('update-timer');

// ==========================================================================
// UTILITY FUNCTIONS
// ==========================================================================
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatSpeed(bitsPerSecond) {
    if (bitsPerSecond === 0) return '0 bps';
    const k = 1000; // Speed is typically in decimal
    const sizes = ['bps', 'Kbps', 'Mbps', 'Gbps'];
    const i = Math.floor(Math.log(bitsPerSecond) / Math.log(k));
    return parseFloat((bitsPerSecond / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatTime(uptimeStr) {
    if (!uptimeStr || uptimeStr === '-' || uptimeStr === 'N/A') return '-';
    
    // Format RouterOS raw uptime (e.g. 14w1d18h27m4s, 2d05:30:10, 4h20m) into clean readable Thai
    const str = String(uptimeStr).trim();
    const weeksMatch = str.match(/(\d+)w/i);
    const daysMatch = str.match(/(\d+)d/i);
    const hoursMatch = str.match(/(\d+)h/i);
    const minsMatch = str.match(/(\d+)m/i);
    const secsMatch = str.match(/(\d+)s/i);

    const weeks = weeksMatch ? parseInt(weeksMatch[1]) : 0;
    const days = daysMatch ? parseInt(daysMatch[1]) : 0;
    const hours = hoursMatch ? parseInt(hoursMatch[1]) : 0;
    const mins = minsMatch ? parseInt(minsMatch[1]) : 0;
    const secs = secsMatch ? parseInt(secsMatch[1]) : 0;

    const parts = [];
    if (weeks > 0) parts.push(`${weeks} สัปดาห์`);
    if (days > 0) parts.push(`${days} วัน`);
    if (hours > 0 && parts.length < 2) parts.push(`${hours} ชม.`);
    if (mins > 0 && parts.length < 2) parts.push(`${mins} นาที`);
    if (parts.length === 0 && secs > 0) parts.push(`${secs} วินาที`);

    if (parts.length > 0) {
        return parts.join(' ');
    }

    // HH:MM:SS format
    if (str.includes(':')) {
        const timeParts = str.split(':');
        if (timeParts.length === 3) {
            const h = parseInt(timeParts[0]) || 0;
            const m = parseInt(timeParts[1]) || 0;
            if (h > 0) return `${h} ชม. ${m} นาที`;
            return `${m} นาที`;
        }
    }

    return str;
}

async function apiFetch(endpoint, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };
    
    if (API_TOKEN) {
        headers['Authorization'] = `Bearer ${API_TOKEN}`;
    }

    const activeSiteVal = document.getElementById('select-active-site')?.value;
    if (activeSiteVal && !headers['X-Site-Id'] && !headers['x-site-id']) {
        headers['X-Site-Id'] = activeSiteVal;
    }
    
    let response;
    try {
        response = await fetch(endpoint, { ...options, headers });
    } catch (netErr) {
        throw new Error('ไม่สามารถเชื่อมต่อ Server ได้ กรุณาตรวจสอบว่า Node.js (node server.js) กำลังทำงานอยู่');
    }
    
    if (response.status === 401) {
        logout();
        throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    }

    const text = await response.text().catch(() => '');
    let data = {};
    if (text) {
        try {
            data = JSON.parse(text);
        } catch (_) {
            data = { error: text };
        }
    }

    if (response.status === 429) {
        const err429 = new Error(data.error || 'พยายามเข้าระบบมากเกินไป');
        err429.status = 429;
        throw err429;
    }

    if (!response.ok) {
        const err = new Error(data.error || `เกิดข้อผิดพลาด (${response.status})`);
        err.status = response.status;
        throw err;
    }
    
    return data;
}


// ==========================================
// SESSION CONTROLLER
// ==========================================
function initApp() {
    if (API_TOKEN && CURRENT_USER) {
        showDashboard();
    } else {
        showLogin();
    }
}

function showLogin() {
    loginContainer.style.display = 'flex';
    dashboardContainer.style.display = 'none';
    
    // Clear user credentials to prevent autofill retention
    document.getElementById('login-username').value = '';
    document.getElementById('login-password').value = '';
    document.getElementById('login-error').style.display = 'none';
    
    stopPolling();
}

function showDashboard() {
    loginContainer.style.display = 'none';
    dashboardContainer.style.display = 'flex';
    
    // Set user info
    userDisplayName.textContent = CURRENT_USER.name || CURRENT_USER.username;
    userDisplayRole.textContent = CURRENT_USER.role;
    userDisplayRole.className = `badge badge-${CURRENT_USER.role}`;
    
    // Configure Menu based on role
    configureMenuRoles(CURRENT_USER.role);
    
    // Fetch Sites dropdown
    fetchSites();

    // Load initial page
    switchPage(currentActivePage);
    
    // Start Polling
    startPolling();
}

async function fetchSites() {
    try {
        const data = await apiFetch('/api/sites');
        currentSitesData = data;
        const select = document.getElementById('select-active-site');
        if (!select) return;
        
        select.innerHTML = '';
        data.sites.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.textContent = `${s.name} (${s.host})`;
            if (s.id === data.activeSiteId) {
                opt.selected = true;
            }
            select.appendChild(opt);
        });
        
        // Also update site title default in voucher generator if empty
        const activeSiteObj = data.sites.find(s => s.id === data.activeSiteId);
        const genSiteTitleInput = document.getElementById('gen-site-title');
        if (genSiteTitleInput && activeSiteObj && !genSiteTitleInput.value) {
            genSiteTitleInput.value = activeSiteObj.name;
        }

        // Also populate LINE digest site selector (sync with current active site)
        const lineSiteSelect = document.getElementById('select-line-digest-site');
        if (lineSiteSelect && data.sites) {
            lineSiteSelect.innerHTML = '';
            data.sites.forEach(s => {
                const opt = document.createElement('option');
                opt.value = s.id;
                opt.textContent = `${s.name}`;
                if (s.id === data.activeSiteId) {
                    opt.selected = true;
                }
                lineSiteSelect.appendChild(opt);
            });
            lineSiteSelect.value = data.activeSiteId;
        }
    } catch (err) {
        console.error('Failed to fetch sites:', err);
    }
}

const selectActiveSiteEl = document.getElementById('select-active-site');
if (selectActiveSiteEl) {
    selectActiveSiteEl.addEventListener('change', (e) => {
        const siteId = e.target.value;
        if (!siteId) return;

        // Instant local state update (0ms UI lag)
        if (currentSitesData) {
            currentSitesData.activeSiteId = siteId;
        }

        // Show immediate loading indicator in tables
        const hotspotTbody = document.querySelector('#table-hotspot-users tbody');
        if (hotspotTbody && currentActivePage === 'page-hotspot') {
            hotspotTbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin"></i> กำลังโหลดข้อมูล...</td></tr>';
        }
        const activeTbody = document.querySelector('#table-active-users tbody');
        if (activeTbody && currentActivePage === 'page-hotspot') {
            activeTbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin"></i> กำลังโหลดเซสชันออนไลน์...</td></tr>';
        }

        // 1. Asynchronously persist active site in DB (non-blocking)
        apiFetch(`/api/sites/switch/${siteId}`, { method: 'POST' }).catch(err => {
            console.error('Failed to persist active site switch:', err);
        });

        // 2. Immediately trigger page reload & polling
        loadPageData(currentActivePage);
        fetchLineDigestConfig(siteId);
        startPolling();
    });
}

function logout() {
    if (API_TOKEN) {
        fetch('/api/auth/logout', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${API_TOKEN}` }
        }).catch(() => {});
    }
    
    API_TOKEN = null;
    CURRENT_USER = null;
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    showLogin();
}

// Master registry of all configurable sidebar navigation menus
const ALL_CONFIGURABLE_MENUS = [
    { key: 'hotspot', navId: 'nav-hotspot', title: 'จัดการระบบ Hotspot', icon: 'fa-ticket' },
    { key: 'pppoe', navId: 'nav-pppoe', title: 'จัดการระบบ PPPoE', icon: 'fa-door-open' },
    { key: 'multiwan', navId: 'nav-multiwan', title: 'จัดการ Multi-WAN & Failover', icon: 'fa-network-wired' },
    { key: 'firewall', navId: 'nav-firewall', title: 'จัดการบล็อกเว็บ (Firewall)', icon: 'fa-fire-burner' },
    { key: 'logs', navId: 'nav-logs', title: 'ประวัติการใช้งาน (Log)', icon: 'fa-clock-rotate-left' }
];

const DEFAULT_MENU_PERMISSIONS_FALLBACK = {
    'co-admin': ['hotspot', 'pppoe', 'multiwan', 'firewall', 'logs'],
    'user': ['hotspot', 'firewall']
};

function configureMenuRoles(role) {
    // Hide all configurable menu items + admin-only items
    ALL_CONFIGURABLE_MENUS.forEach(m => {
        const el = document.getElementById(m.navId);
        if (el) el.style.display = 'none';
    });
    if (document.getElementById('nav-admins')) document.getElementById('nav-admins').style.display = 'none';
    if (document.getElementById('nav-settings')) document.getElementById('nav-settings').style.display = 'none';

    // Router Operations & Maintenance now lives only on the Settings page (#tab-settings-ops),
    // which is already admin-only via #nav-settings + requireAuth(['admin']) on the backend routes.
    // (It used to be duplicated as #panel-router-operations on Overview — removed 2026-08-28.)

    if (role === 'admin') {
        // admin always sees everything
        ALL_CONFIGURABLE_MENUS.forEach(m => {
            const el = document.getElementById(m.navId);
            if (el) el.style.display = 'flex';
        });
        if (document.getElementById('nav-admins')) document.getElementById('nav-admins').style.display = 'flex';
        if (document.getElementById('nav-settings')) document.getElementById('nav-settings').style.display = 'flex';
        return;
    }

    if (role === 'co-admin' || role === 'user') {
        applyMenuPermissionsForRole(role);
    }
}

async function applyMenuPermissionsForRole(role) {
    let allowed;
    try {
        const perms = await apiFetch('/api/settings/menu-permissions');
        allowed = perms[role] || [];
    } catch (err) {
        console.error('Failed to load menu permissions, using defaults:', err);
        allowed = DEFAULT_MENU_PERMISSIONS_FALLBACK[role] || [];
    }
    ALL_CONFIGURABLE_MENUS.forEach(m => {
        if (allowed.includes(m.key)) {
            const el = document.getElementById(m.navId);
            if (el) el.style.display = 'flex';
        }
    });
}

// ==========================================
// POLLING ENGINE
// ==========================================
function startPolling() {
    stopPolling();

    // Poll System resource status every 5 seconds
    fetchSystemStatus();
    statsInterval = setInterval(fetchSystemStatus, 5000);

    // Poll Interface & cumulative Traffic data every 2 seconds
    fetchTrafficStats();
    trafficInterval = setInterval(fetchTrafficStats, 2000);

    // Overview stat cards (ผู้ใช้ Hotspot ออนไลน์ / ห้อง PPPoE ออนไลน์) ต้องอัปเดตเอง
    // อิสระจากแท็บที่เปิดอยู่ ไม่งั้นจะค้างที่ 0 จนกว่าจะไปเปิดแท็บนั้นๆ ก่อน
    fetchActiveHotspotUsers();
    hotspotOnlineInterval = setInterval(fetchActiveHotspotUsers, 30000);

    fetchPppoeOnlineCount();
    pppoeOnlineInterval = setInterval(fetchPppoeOnlineCount, 30000);
}

function stopPolling() {
    if (statsInterval) clearInterval(statsInterval);
    if (trafficInterval) clearInterval(trafficInterval);
    if (hotspotOnlineInterval) clearInterval(hotspotOnlineInterval);
    if (pppoeOnlineInterval) clearInterval(pppoeOnlineInterval);
    statsInterval = null;
    trafficInterval = null;
    hotspotOnlineInterval = null;
    pppoeOnlineInterval = null;
}

// ==========================================
// PAGE CONTROLLER
// ==========================================
function switchPage(targetPageId) {
    // Role protection guards
    const role = CURRENT_USER ? CURRENT_USER.role : 'user';
    if (role !== 'admin') {
        if (['page-admins', 'page-settings'].includes(targetPageId)) {
            targetPageId = 'page-overview';
        }
    }
    if (role === 'user') {
        if (targetPageId === 'page-logs' || targetPageId === 'page-pppoe') {
            targetPageId = 'page-overview';
        }
    }
    
    currentActivePage = targetPageId;
    
    // Toggle active section
    document.querySelectorAll('.page-section').forEach(sec => {
        sec.style.display = 'none';
    });
    
    const activeSection = document.getElementById(targetPageId);
    if (activeSection) {
        activeSection.style.display = 'block';
    }
    
    // Toggle active menu item
    document.querySelectorAll('.menu-item').forEach(item => {
        item.classList.remove('active');
        if (item.getAttribute('data-target') === targetPageId) {
            item.classList.add('active');
        }
    });
    
    // Update Header Title
    const titleMap = {
        'page-overview': { title: 'ข้อมูลทั่วไป (Overview)', desc: 'ภาพรวมสถานะเราท์เตอร์และทราฟฟิกอินเตอร์เฟส' },
        'page-hotspot': { title: 'จัดการระบบ Hotspot', desc: 'ควบคุมระบบคูปองอินเตอร์เน็ตและผู้ใช้งานทั้งหมด' },
        'page-pppoe': { title: 'จัดการระบบ PPPoE', desc: 'จัดการบัญชี router ตามห้อง แพ็กเกจความเร็ว และการใช้งานสำหรับเก็บเงิน' },
        'page-multiwan': { title: 'จัดการระบบ Multi-WAN & Load Balance', desc: 'กำหนดสาย WAN ไม่จำกัด (N-WAN), PCC Load Balancing, PBR และ Telegram Netwatch ประจำไซต์งาน' },
        'page-firewall': { title: 'จัดการบล็อกเว็บ (Firewall)', desc: 'เปิด/ปิดบล็อกบริการเครือข่ายสังคมออนไลน์ด้วยคลิกเดียว' },
        'page-admins': { title: 'ผู้ใช้งานระบบ Dashboard', desc: 'จัดการผู้ใช้งานและสิทธิ์การเข้าถึงแดชบอร์ด' },
        'page-settings': { title: 'จัดการระบบเราท์เตอร์ & แจ้งเตือน', desc: 'ศูนย์จัดการไซต์งาน การแจ้งเตือน LINE Official Account และการดูแลรักษาเราท์เตอร์' },
        'page-logs': { title: 'ประวัติการใช้งาน (Log)', desc: 'บันทึกกิจกรรมระบบและข้อมูลจราจรคอมพิวเตอร์ตามพรบ คอมพิวเตอร์ มาตรา 26' }
    };
    
    const info = titleMap[targetPageId] || { title: 'แดชบอร์ด', desc: '' };
    document.getElementById('page-title').textContent = info.title;
    document.getElementById('page-description').textContent = info.desc;
    
    // Fetch page data immediately on switch
    loadPageData(targetPageId);
}

let activeSettingsTab = 'tab-settings-sites';

function loadSettingsTab(tabId) {
    activeSettingsTab = tabId;
    document.querySelectorAll('#settings-tab-nav .tab-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('data-tab') === tabId) {
            btn.classList.add('active');
        }
    });

    document.querySelectorAll('#page-settings .tab-pane').forEach(pane => {
        pane.style.display = 'none';
        pane.classList.remove('active');
    });

    const targetEl = document.getElementById(tabId);
    if (targetEl) {
        targetEl.style.display = 'block';
        targetEl.classList.add('active');
    }

    if (tabId === 'tab-settings-sites') {
        fetchSitesManagement();
    } else if (tabId === 'tab-settings-line') {
        fetchLineDigestConfig();
    } else if (tabId === 'tab-settings-telegram') {
        loadTelegramAlertConfig();
    }
}

function loadPageData(pageId) {
    if (pageId === 'page-overview') {
        // Polling will handle it
    } else if (pageId === 'page-hotspot') {
        loadHotspotTab(activeHotspotTab);
    } else if (pageId === 'page-pppoe') {
        loadPppoeTab(activePppoeTab);
    } else if (pageId === 'page-multiwan') {
        renderMultiWanPage();
    } else if (pageId === 'page-firewall') {
        fetchFirewallStatus();
    } else if (pageId === 'page-admins') {
        fetchDashboardUsers();
        fetchMenuPermissions();
    } else if (pageId === 'page-settings') {
        loadSettingsTab(activeSettingsTab);
    } else if (pageId === 'page-logs') {
        loadLogTab(activeLogTab);
    }
}

// ==========================================
// LOG SYSTEM CONTROLLERS
// ==========================================
let activeLogTab = 'tab-log-activity';
let activityLogPage = 1;
let trafficLogPage = 1;
let dnsLogPage = 1;

function loadLogTab(tabId) {
    activeLogTab = tabId;

    // Switch tab UI
    document.querySelectorAll('#page-logs .tab-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('data-tab') === tabId) btn.classList.add('active');
    });
    document.querySelectorAll('#page-logs .tab-content').forEach(c => c.classList.remove('active'));
    const tabEl = document.getElementById(tabId);
    if (tabEl) tabEl.classList.add('active');

    if (tabId === 'tab-log-activity') {
        activityLogPage = 1;
        fetchActivityLogs();
    } else if (tabId === 'tab-log-traffic') {
        trafficLogPage = 1;
        fetchHotspotTrafficLogs();
    } else if (tabId === 'tab-log-dns') {
        dnsLogPage = 1;
        fetchDnsQueryLogs();
    }
}

// Bind Log tab buttons
document.querySelectorAll('#page-logs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => loadLogTab(btn.getAttribute('data-tab')));
});

// ---- ACTIVITY LOG ----
async function fetchActivityLogs(page = activityLogPage) {
    activityLogPage = page;
    const search = (document.getElementById('activity-search')?.value || '').trim();
    const from = document.getElementById('activity-from')?.value || '';
    const to = document.getElementById('activity-to')?.value || '';

    const tbody = document.getElementById('tbody-activity-log');
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin"></i> กำลังโหลด...</td></tr>';

    try {
        const params = new URLSearchParams({ page, limit: 50 });
        if (search) params.set('search', search);
        if (from) params.set('from', from);
        if (to) params.set('to', to + 'T23:59:59');

        const result = await apiFetch(`/api/logs?${params}`);

        if (!tbody) return;
        tbody.innerHTML = '';

        if (!result.logs || result.logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">ไม่พบรายการ</td></tr>';
        } else {
            result.logs.forEach(log => {
                const tr = document.createElement('tr');
                const dt = log.timestamp ? new Date(log.timestamp).toLocaleString('th-TH') : '-';
                tr.innerHTML = `
                    <td style="font-size:0.8rem;color:var(--text-muted);">${dt}</td>
                    <td><strong>${log.username || '-'}</strong></td>
                    <td><span class="log-action-badge">${log.action || '-'}</span></td>
                    <td style="font-size:0.85rem;">${log.details || '-'}</td>
                `;
                tbody.appendChild(tr);
            });
        }

        // Update export link with current filters
        const exportLink = document.getElementById('btn-export-activity-log');
        if (exportLink) {
            const exportParams = new URLSearchParams();
            if (search) exportParams.set('search', search);
            if (from) exportParams.set('from', from);
            if (to) exportParams.set('to', to + 'T23:59:59');
            exportLink.href = `/api/logs/export-csv?${exportParams}`;
        }

        // Render pagination
        renderPagination('pagination-activity', result, (p) => fetchActivityLogs(p));

    } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="text-center text-danger">ผิดพลาด: ${err.message}</td></tr>`;
    }
}

// Filter / Clear buttons for Activity Log
document.getElementById('btn-filter-activity')?.addEventListener('click', () => { activityLogPage = 1; fetchActivityLogs(1); });
document.getElementById('btn-clear-activity')?.addEventListener('click', () => {
    document.getElementById('activity-search').value = '';
    document.getElementById('activity-from').value = '';
    document.getElementById('activity-to').value = '';
    fetchActivityLogs(1);
});
document.getElementById('activity-search')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { activityLogPage = 1; fetchActivityLogs(1); } });

// ---- TRAFFIC LOG (พรบ) ----
async function fetchHotspotTrafficLogs(page = trafficLogPage) {
    trafficLogPage = page;
    const search = (document.getElementById('traffic-search')?.value || '').trim();
    const from = document.getElementById('traffic-from')?.value || '';
    const to = document.getElementById('traffic-to')?.value || '';

    const tbody = document.getElementById('tbody-traffic-log');
    if (tbody) tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin"></i> กำลังโหลด...</td></tr>';

    try {
        const params = new URLSearchParams({ page, limit: 50 });
        if (search) params.set('search', search);
        if (from) params.set('from', from);
        if (to) params.set('to', to + 'T23:59:59');
        const siteName = getCurrentSiteName();
        if (siteName) params.set('site', siteName);

        const result = await apiFetch(`/api/hotspot-logs?${params}`);

        if (!tbody) return;
        tbody.innerHTML = '';

        if (!result.logs || result.logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted">ยังไม่มีข้อมูล — ระบบจะเริ่มบันทึกอัตโนมัติทุก 5 นาที เมื่อมีผู้ใช้ Hotspot</td></tr>';
        } else {
            result.logs.forEach(log => {
                const tr = document.createElement('tr');
                const loginDt = log.loginTime ? new Date(log.loginTime).toLocaleString('th-TH') : '-';
                const logoutDt = log.logoutTime ? new Date(log.logoutTime).toLocaleString('th-TH') : '<span style="color:var(--text-muted);">กำลังใช้งาน</span>';
                const statusBadge = log.status === 'connected'
                    ? '<span class="status-badge-connected"><i class="fa-solid fa-circle" style="font-size:0.5rem;"></i> ออนไลน์</span>'
                    : '<span class="status-badge-disconnected"><i class="fa-solid fa-circle" style="font-size:0.5rem;"></i> ออกแล้ว</span>';

                tr.innerHTML = `
                    <td style="font-size:0.79rem;">${loginDt}</td>
                    <td style="font-size:0.79rem;">${logoutDt}</td>
                    <td><strong>${log.username || '-'}</strong></td>
                    <td><code style="font-size:0.8rem;">${log.ipAddress || '-'}</code></td>
                    <td><code style="font-size:0.75rem;color:var(--text-muted);">${log.macAddress || '-'}</code></td>
                    <td><span class="badge badge-profile" style="font-size:0.72rem;">${log.loginBy || '-'}</span></td>
                    <td style="font-size:0.8rem;">${log.uptime || '-'}</td>
                    <td style="font-size:0.8rem;">${formatBytes(log.bytesOut || 0)}</td>
                    <td style="font-size:0.8rem;">${formatBytes(log.bytesIn || 0)}</td>
                    <td>${statusBadge}</td>
                `;
                tbody.appendChild(tr);
            });
        }

        // Update export link with current filters
        const exportLink = document.getElementById('btn-export-hotspot-log');
        if (exportLink) {
            const exportParams = new URLSearchParams();
            if (search) exportParams.set('search', search);
            if (from) exportParams.set('from', from);
            if (to) exportParams.set('to', to + 'T23:59:59');
            if (siteName) exportParams.set('site', siteName);
            exportLink.href = `/api/hotspot-logs/export-csv?${exportParams}`;
        }

        // Render pagination
        renderPagination('pagination-traffic', result, (p) => fetchHotspotTrafficLogs(p));

    } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="10" class="text-center text-danger">ผิดพลาด: ${err.message}</td></tr>`;
    }
}

// Filter / Clear buttons for Traffic Log
document.getElementById('btn-filter-traffic')?.addEventListener('click', () => { trafficLogPage = 1; fetchHotspotTrafficLogs(1); });
document.getElementById('btn-clear-traffic')?.addEventListener('click', () => {
    document.getElementById('traffic-search').value = '';
    document.getElementById('traffic-from').value = '';
    document.getElementById('traffic-to').value = '';
    fetchHotspotTrafficLogs(1);
});
document.getElementById('traffic-search')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { trafficLogPage = 1; fetchHotspotTrafficLogs(1); } });

// ---- DNS VISIT HISTORY (พรบ, domain-level) ----
async function fetchDnsQueryLogs(page = dnsLogPage) {
    dnsLogPage = page;
    const search = (document.getElementById('dns-search')?.value || '').trim();
    const from = document.getElementById('dns-from')?.value || '';
    const to = document.getElementById('dns-to')?.value || '';

    const tbody = document.getElementById('tbody-dns-log');
    if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin"></i> กำลังโหลด...</td></tr>';

    try {
        const params = new URLSearchParams({ page, limit: 50 });
        if (search) params.set('search', search);
        if (from) params.set('from', from);
        if (to) params.set('to', to + 'T23:59:59');
        const siteName = getCurrentSiteName();
        if (siteName) params.set('site', siteName);

        const result = await apiFetch(`/api/dns-logs?${params}`);

        if (!tbody) return;
        tbody.innerHTML = '';

        if (!result.logs || result.logs.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">ยังไม่มีข้อมูล — ต้องเปิด DNS logging บนราวเตอร์ก่อน ระบบจะเริ่มบันทึกอัตโนมัติทุก 5 นาที</td></tr>';
        } else {
            result.logs.forEach(log => {
                const tr = document.createElement('tr');
                const dt = log.queryTime ? new Date(log.queryTime).toLocaleString('th-TH') : '-';
                tr.innerHTML = `
                    <td style="font-size:0.79rem;">${dt}</td>
                    <td><strong>${log.username || '-'}</strong></td>
                    <td><code style="font-size:0.8rem;">${log.ipAddress || '-'}</code></td>
                    <td><code style="font-size:0.75rem;color:var(--text-muted);">${log.macAddress || '-'}</code></td>
                    <td><code style="font-size:0.8rem;">${log.domain || '-'}</code></td>
                    <td style="font-size:0.8rem;">${log.siteName || '-'}</td>
                `;
                tbody.appendChild(tr);
            });
        }

        // Update export link with current filters
        const exportLink = document.getElementById('btn-export-dns-log');
        if (exportLink) {
            const exportParams = new URLSearchParams();
            if (search) exportParams.set('search', search);
            if (from) exportParams.set('from', from);
            if (to) exportParams.set('to', to + 'T23:59:59');
            if (siteName) exportParams.set('site', siteName);
            exportLink.href = `/api/dns-logs/export-csv?${exportParams}`;
        }

        // Render pagination
        renderPagination('pagination-dns', result, (p) => fetchDnsQueryLogs(p));

    } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="text-center text-danger">ผิดพลาด: ${err.message}</td></tr>`;
    }
}

// Filter / Clear buttons for DNS Visit History
document.getElementById('btn-filter-dns')?.addEventListener('click', () => { dnsLogPage = 1; fetchDnsQueryLogs(1); });
document.getElementById('btn-clear-dns')?.addEventListener('click', () => {
    document.getElementById('dns-search').value = '';
    document.getElementById('dns-from').value = '';
    document.getElementById('dns-to').value = '';
    fetchDnsQueryLogs(1);
});
document.getElementById('dns-search')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { dnsLogPage = 1; fetchDnsQueryLogs(1); } });

// ---- SHARED: Pagination Renderer ----
function renderPagination(containerId, result, onPageChange) {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    if (!result || result.pages <= 1) return;

    const { page, pages, total, limit } = result;

    const addBtn = (label, pageNum, isActive = false, disabled = false) => {
        const btn = document.createElement('button');
        btn.innerHTML = label;
        if (isActive) btn.classList.add('active-page');
        btn.disabled = disabled;
        btn.addEventListener('click', () => onPageChange(pageNum));
        container.appendChild(btn);
    };

    addBtn('<i class="fa-solid fa-chevron-left"></i>', page - 1, false, page <= 1);

    // Show page numbers with ellipsis
    const delta = 2;
    let range = [];
    for (let i = Math.max(1, page - delta); i <= Math.min(pages, page + delta); i++) {
        range.push(i);
    }
    if (range[0] > 1) {
        addBtn('1', 1);
        if (range[0] > 2) {
            const dots = document.createElement('span');
            dots.textContent = '...';
            dots.style.cssText = 'padding: 0 4px; color: var(--text-muted); font-size:0.85rem;';
            container.appendChild(dots);
        }
    }
    range.forEach(p => addBtn(p, p, p === page));
    if (range[range.length - 1] < pages) {
        if (range[range.length - 1] < pages - 1) {
            const dots = document.createElement('span');
            dots.textContent = '...';
            dots.style.cssText = 'padding: 0 4px; color: var(--text-muted); font-size:0.85rem;';
            container.appendChild(dots);
        }
        addBtn(pages, pages);
    }

    addBtn('<i class="fa-solid fa-chevron-right"></i>', page + 1, false, page >= pages);

    const info = document.createElement('span');
    info.className = 'page-info';
    const start = (page - 1) * limit + 1;
    const end = Math.min(page * limit, total);
    info.textContent = `แสดง ${start}–${end} จาก ${total} รายการ`;
    container.appendChild(info);
}


async function fetchSystemStatus() {
    try {
        const status = await apiFetch('/api/mikrotik/status');
        
        // Update Red/Green status dot
        routerConnStatus.innerHTML = '<span class="status-dot status-online"></span> Connected';
        
        // Update cards
        document.getElementById('stat-cpu').textContent = status.cpuLoad;
        
        const freeMB = Math.round(status.freeMemory / (1024 * 1024));
        const totalMB = Math.round(status.totalMemory / (1024 * 1024));
        document.getElementById('stat-ram').textContent = `${freeMB} / ${totalMB} MB`;
        
        const uptimeEl = document.getElementById('stat-uptime');
        if (uptimeEl) {
            uptimeEl.textContent = formatTime(status.uptime);
            uptimeEl.title = `Uptime เต็ม: ${status.uptime || '-'}`;
        }
        document.getElementById('stat-model').textContent = status.model;

        // RouterOS Version & Update Status
        const rosEl = document.getElementById('stat-ros-version');
        const rosBadge = document.getElementById('stat-ros-latest-badge');

        if (rosEl) rosEl.textContent = status.version || '-';
        if (rosBadge) {
            rosBadge.style.display = 'block';
            if (status.hasUpdate && status.latestVersion && status.latestVersion !== status.currentVersion) {
                rosBadge.innerHTML = `
                    <div style="display:flex; align-items:center; justify-content:space-between; gap:6px; flex-wrap:wrap; margin-top:6px;">
                        <span style="color:#d97706; font-weight:700; font-size:0.75rem;"><i class="fa-solid fa-circle-arrow-up"></i> มีเวอร์ชัน v${status.latestVersion}</span>
                        <button type="button" class="btn btn-sm btn-primary btn-quick-ros-upgrade" data-action="open-full-upgrade" onclick="event.stopPropagation(); openFullUpgradeModal();" style="padding:4px 10px; font-size:0.72rem; white-space:nowrap; height:auto; border-radius:10px; font-weight:700; background:linear-gradient(135deg, #2563eb, #1d4ed8); border:none; box-shadow:0 2px 6px rgba(37,99,235,0.3); color:#fff; cursor:pointer;" title="คลิกเพื่ออัปเกรด RouterOS + Firmware แบบ 1-Click">
                            <i class="fa-solid fa-wand-magic-sparkles"></i> 1-Click อัปเกรด
                        </button>
                    </div>
                `;
            } else {
                rosBadge.innerHTML = `<span style="color:#15803d; font-weight:600; font-size:0.75rem;"><i class="fa-solid fa-circle-check"></i> เวอร์ชันล่าสุดแล้ว</span>`;
            }
        }

        // RouterBOARD Firmware
        const fwEl = document.getElementById('stat-firmware');
        if (fwEl) {
            if (status.upgradeFirmware && status.upgradeFirmware !== 'N/A' && status.upgradeFirmware !== status.currentFirmware) {
                fwEl.innerHTML = `${status.currentFirmware} <span style="color:#d97706; font-size:0.75rem; font-weight:700;">(อัปเกรด: ${status.upgradeFirmware})</span>`;
            } else {
                fwEl.textContent = status.currentFirmware || status.version || '-';
            }
        }

        // Device Health & Temperature Card
        const tempEl = document.getElementById('stat-temperature');
        const tempStatus = document.getElementById('stat-temp-status');
        if (tempEl) {
            if (status.temperature || status.voltage) {
                const tText = `${status.temperature || ''} ${status.voltage ? '(' + status.voltage + ')' : ''}`.trim();
                tempEl.textContent = tText || 'ปกติ';
                if (tempStatus && status.temperature) {
                    const tempNum = parseFloat(status.temperature);
                    if (tempNum >= 75) {
                        tempStatus.textContent = 'ร้อนสูง ⚠️';
                        tempStatus.style.background = '#fee2e2';
                        tempStatus.style.color = '#dc2626';
                    } else if (tempNum >= 60) {
                        tempStatus.textContent = 'อุ่น';
                        tempStatus.style.background = '#fef3c7';
                        tempStatus.style.color = '#d97706';
                    } else {
                        tempStatus.textContent = 'ปกติ';
                        tempStatus.style.background = '#dcfce7';
                        tempStatus.style.color = '#15803d';
                    }
                }
            } else {
                tempEl.textContent = 'ปกติ (ไม่มี sensor)';
                if (tempStatus) {
                    tempStatus.textContent = 'ปกติ';
                    tempStatus.style.background = '#dcfce7';
                    tempStatus.style.color = '#15803d';
                }
            }
        }
        
        updateTimer.innerHTML = `<i class="fa-solid fa-rotate"></i> อัปเดตล่าสุด: ${new Date().toLocaleTimeString()}`;
    } catch (err) {
        console.error(err);
        routerConnStatus.innerHTML = '<span class="status-dot status-offline"></span> Disconnected';
        // Clear card values
        document.getElementById('stat-cpu').textContent = '-';
        document.getElementById('stat-ram').textContent = '-';
        document.getElementById('stat-uptime').textContent = '-';
        document.getElementById('stat-model').textContent = 'Cannot Connect';
        if (document.getElementById('stat-temperature')) document.getElementById('stat-temperature').textContent = '-';
        const rosEl = document.getElementById('stat-ros-version');
        if (rosEl) rosEl.textContent = '-';
        const rosBadge = document.getElementById('stat-ros-latest-badge');
        if (rosBadge) rosBadge.style.display = 'none';
        const btnQuickUpdate = document.getElementById('btn-quick-ros-update');
        if (btnQuickUpdate) btnQuickUpdate.style.display = 'none';
        const fwEl = document.getElementById('stat-firmware');
        if (fwEl) fwEl.textContent = '-';
    }
}

// Overview: จำนวนห้อง PPPoE ที่ออนไลน์/active อยู่ ณ ขณะนี้ (ไม่ใช่จำนวนบัญชีทั้งหมด)
// endpoint จำกัดสิทธิ์ admin/co-admin เท่านั้น
async function fetchPppoeOnlineCount() {
    const statEl = document.getElementById('stat-pppoe-rooms');
    if (!statEl) return;
    if (!CURRENT_USER || CURRENT_USER.role === 'user') {
        statEl.textContent = '-';
        return;
    }
    try {
        const active = await apiFetch('/api/mikrotik/pppoe/active');
        statEl.textContent = `${active.length} ห้อง`;
    } catch (err) {
        statEl.textContent = '-';
    }
}

document.getElementById('stat-card-pppoe-rooms')?.addEventListener('click', () => {
    switchPage('page-pppoe');
    setTimeout(() => loadPppoeTab('tab-pppoe-active'), 100);
});

async function fetchTrafficStats() {
    try {
        const interfaces = await apiFetch('/api/mikrotik/interfaces');
        
        // Populate dropdown if empty
        const select = document.getElementById('traffic-interface-select');
        const prevValue = select.value;
        
        // Filter run interfaces and rebuild list if selection counts mismatch
        if (select.options.length <= 1) {
            select.innerHTML = '<option value="">-- เลือกอินเตอร์เฟส --</option>';
            interfaces.forEach(item => {
                if (!item.disabled) {
                    const opt = document.createElement('option');
                    opt.value = item.name;
                    opt.textContent = `${item.name} (${item.type})`;
                    select.appendChild(opt);
                }
            });
            // Try to auto-select first active ethernet/WAN interface
            const defaultEth = interfaces.find(i => i.name.startsWith('ether') && !i.disabled);
            if (defaultEth) {
                select.value = defaultEth.name;
            } else if (interfaces.length > 0) {
                select.value = interfaces[0].name;
            }
        } else if (prevValue) {
            select.value = prevValue;
        }
        
        selectedInterfaceName = select.value;
        
        // Render interfaces table
        const tbody = document.querySelector('#table-interfaces tbody');
        tbody.innerHTML = '';
        
        interfaces.forEach(item => {
            const statusClass = item.disabled ? 'text-danger' : (item.running ? 'text-success' : 'text-warning');
            const statusText = item.disabled ? 'Disabled' : (item.running ? 'Connected' : 'No Link');
            
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${item.name}</strong> ${item.comment ? `<div class="help-text">${item.comment}</div>` : ''}</td>
                <td>${item.type}</td>
                <td class="${statusClass}"><strong>${statusText}</strong></td>
                <td>${formatBytes(item.rxByte)}</td>
                <td>${formatBytes(item.txByte)}</td>
            `;
            tbody.appendChild(tr);
        });
        
        // Calculate speeds for selected interface
        if (selectedInterfaceName) {
            const selectedInt = interfaces.find(i => i.name === selectedInterfaceName);
            if (selectedInt) {
                const now = Date.now();
                if (lastTrafficData.time > 0) {
                    const timeDiff = (now - lastTrafficData.time) / 1000;
                    
                    // Simple rate calculation
                    let rxDiff = selectedInt.rxByte - lastTrafficData.rx;
                    let txDiff = selectedInt.txByte - lastTrafficData.tx;
                    
                    // Handle counters rollover or reset
                    if (rxDiff < 0) rxDiff = 0;
                    if (txDiff < 0) txDiff = 0;
                    
                    // Calculate bits per second
                    const rxSpeed = Math.round((rxDiff * 8) / timeDiff);
                    const txSpeed = Math.round((txDiff * 8) / timeDiff);
                    
                    // Update chart histories
                    downloadHistory.push(rxSpeed);
                    downloadHistory.shift();
                    
                    uploadHistory.push(txSpeed);
                    uploadHistory.shift();
                    
                    // Redraw canvas graph
                    drawTrafficChart();
                }
                
                // Store last values
                lastTrafficData = {
                    rx: selectedInt.rxByte,
                    tx: selectedInt.txByte,
                    time: now
                };
            }
        }
    } catch (err) {
        console.error('Failed to query interfaces:', err);
    }
}

// Custom HTML Canvas Graphing Loop
function drawTrafficChart() {
    const canvas = document.getElementById('trafficChart');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    ctx.clearRect(0, 0, width, height);
    
    // Calculate max speed in history to dynamically adjust Y-axis scale (minimum 1 Mbps)
    const maxSpeed = Math.max(...downloadHistory, ...uploadHistory, 1024 * 1024);
    
    // Draw Grid Lines (horizontal)
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.06)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
        const y = (height / 4) * i;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
        
        // Label
        ctx.fillStyle = '#64748b';
        ctx.font = '10px Inter';
        const gridVal = maxSpeed - (maxSpeed / 4) * i;
        ctx.fillText(formatSpeed(gridVal), 10, y - 4);
    }
    
    // Helper to map index & value to X/Y canvas coordinate
    const getX = (index) => (width / (downloadHistory.length - 1)) * index;
    const getY = (val) => height - (val / maxSpeed) * (height - 30) - 15;
    
    // 1. Draw Download curve (Emerald)
    ctx.beginPath();
    ctx.moveTo(getX(0), getY(downloadHistory[0]));
    for (let i = 1; i < downloadHistory.length; i++) {
        ctx.lineTo(getX(i), getY(downloadHistory[i]));
    }
    ctx.strokeStyle = '#10b981'; // Emerald
    ctx.lineWidth = 3;
    ctx.stroke();
    
    // Fill Area under curve (Download)
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    const dlGradient = ctx.createLinearGradient(0, 0, 0, height);
    dlGradient.addColorStop(0, 'rgba(16, 185, 129, 0.12)');
    dlGradient.addColorStop(1, 'rgba(16, 185, 129, 0)');
    ctx.fillStyle = dlGradient;
    ctx.fill();
    
    // 2. Draw Upload curve (Indigo)
    ctx.beginPath();
    ctx.moveTo(getX(0), getY(uploadHistory[0]));
    for (let i = 1; i < uploadHistory.length; i++) {
        ctx.lineTo(getX(i), getY(uploadHistory[i]));
    }
    ctx.strokeStyle = '#6366f1'; // Indigo
    ctx.lineWidth = 3;
    ctx.stroke();
    
    // Fill Area under curve (Upload)
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    const ulGradient = ctx.createLinearGradient(0, 0, 0, height);
    ulGradient.addColorStop(0, 'rgba(99, 102, 241, 0.12)');
    ulGradient.addColorStop(1, 'rgba(99, 102, 241, 0)');
    ctx.fillStyle = ulGradient;
    ctx.fill();
    
    // Draw Current values text on top right
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 12px Inter';
    ctx.textAlign = 'right';
    
    const curDL = downloadHistory[downloadHistory.length - 1];
    const curUL = uploadHistory[uploadHistory.length - 1];
    ctx.fillText(`ดาวน์โหลด (In): ${formatSpeed(curDL)}`, width - 20, 25);
    ctx.fillStyle = '#6366f1';
    ctx.fillText(`อัปโหลด (Out): ${formatSpeed(curUL)}`, width - 20, 42);
}

// Reset history when switching interface
document.getElementById('traffic-interface-select').addEventListener('change', () => {
    downloadHistory.fill(0);
    uploadHistory.fill(0);
    lastTrafficData = { rx: 0, tx: 0, time: 0 };
    drawTrafficChart();
});

// ==========================================
// HOTSPOT MANAGEMENT CONTROLLERS
// ==========================================
function loadHotspotTab(tabId) {
    activeHotspotTab = tabId;
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('data-tab') === tabId) {
            btn.classList.add('active');
        }
    });
    
    document.querySelectorAll('.tab-content').forEach(c => {
        c.classList.remove('active');
    });
    document.getElementById(tabId).classList.add('active');
    
    // Update tab badges in the background
    updateHotspotTabBadges();
    
    // P3: หยุด auto-refresh ก่อนเสมอ แล้วเริ่มใหม่ถ้าอยู่หน้า active
    stopActiveUsersAutoRefresh();

    // Fetch tab-specific data
    if (tabId === 'tab-hotspot-active') {
        fetchActiveHotspotUsers();
        startActiveUsersAutoRefresh();
    } else if (tabId === 'tab-hotspot-accounts') {
        fetchHotspotAccounts();
        fetchAutoCleanupConfig();
    } else if (tabId === 'tab-hotspot-profiles') {
        fetchHotspotProfiles();
    } else if (tabId === 'tab-hotspot-vouchers') {
        fetchProfilesToDropdown();
    } else if (tabId === 'tab-hotspot-archive') {
        fetchArchivedHotspotUsers();
    } else if (tabId === 'tab-hotspot-stats') {
        fetchHotspotStats();
    }
}

// Tab: Active Hotspot Sessions
let _allActiveUsers = []; // cache สำหรับ client-side search
let _activeRefreshTimer = null;
let _activeRefreshCountdown = null;

async function fetchActiveHotspotUsers() {
    try {
        const active = await apiFetch('/api/mikrotik/hotspot/active');
        _allActiveUsers = active;
        renderActiveUsers(_allActiveUsers);

        // อัปเดต overview stat card
        const statEl = document.getElementById('stat-hotspot-online');
        if (statEl) {
            statEl.innerHTML = `<span class="online-count" style="font-size:1.6rem;font-weight:700;color:var(--success);">${active.length}</span> <span class="online-label">คน</span>`;
        }

        // อัปเดต badge
        const badge = document.getElementById('badge-hotspot-active');
        if (badge) badge.textContent = `(${active.length})`;

    } catch (err) {
        const tbody = document.querySelector('#table-active-users tbody');
        if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger">ผิดพลาด: ${err.message}</td></tr>`;
    }
}

function renderActiveUsers(list) {
    const searchVal = (document.getElementById('search-active-users')?.value || '').toLowerCase().trim();
    const filtered = searchVal
        ? list.filter(item =>
            (item.user || '').toLowerCase().includes(searchVal) ||
            (item.address || '').includes(searchVal) ||
            (item.macAddress || '').toLowerCase().includes(searchVal)
          )
        : list;

    const tbody = document.querySelector('#table-active-users tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    // อัปเดต count badge
    const countEl = document.getElementById('active-users-count');
    if (countEl) {
        countEl.textContent = searchVal
            ? `พบ ${filtered.length} จาก ${list.length} คน`
            : `ออนไลน์อยู่ ${list.length} คน`;
    }

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="text-center text-muted">${searchVal ? 'ไม่พบผู้ใช้ที่ค้นหา' : 'ไม่มีผู้ใช้งานเชื่อมต่ออยู่ในขณะนี้'}</td></tr>`;
        return;
    }

    filtered.forEach(item => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${item.user}</strong></td>
            <td>${item.address}</td>
            <td><code style="color:var(--text-muted);">${item.macAddress}</code></td>
            <td><span class="badge badge-profile">${item.loginBy}</span></td>
            <td>${item.uptime}</td>
            <td>${formatBytes(item.bytesOut)}</td>
            <td>${formatBytes(item.bytesIn)}</td>
            <td class="text-center">
                <button class="btn btn-danger btn-sm btn-kick" data-id="${item.id}" data-user="${item.user}">
                    <i class="fa-solid fa-arrow-right-from-bracket"></i> เตะออก
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    // Bind kick events
    document.querySelectorAll('.btn-kick').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const user = btn.getAttribute('data-user');
            if (confirm(`คุณต้องการเตะผู้ใช้งาน "${user}" ออกจากการเชื่อมต่อใช่หรือไม่?`)) {
                try {
                    btn.disabled = true;
                    await apiFetch(`/api/mikrotik/hotspot/active/${id}`, { method: 'DELETE' });
                    fetchActiveHotspotUsers();
                } catch (err) {
                    alert(err.message);
                    btn.disabled = false;
                }
            }
        });
    });
}

// P3: Search filter for Active Users
document.getElementById('search-active-users')?.addEventListener('input', () => {
    renderActiveUsers(_allActiveUsers);
});

// P3: Auto-refresh Active Users ทุก 30 วินาที
const ACTIVE_REFRESH_INTERVAL = 30;

function startActiveUsersAutoRefresh() {
    stopActiveUsersAutoRefresh();
    let remaining = ACTIVE_REFRESH_INTERVAL;

    const updateCountdown = () => {
        const el = document.getElementById('active-refresh-countdown');
        if (el) el.textContent = `รีเฟรชใน ${remaining}s`;
        remaining--;
        if (remaining < 0) {
            remaining = ACTIVE_REFRESH_INTERVAL;
            fetchActiveHotspotUsers();
        }
    };

    updateCountdown();
    _activeRefreshCountdown = setInterval(updateCountdown, 1000);
}

function stopActiveUsersAutoRefresh() {
    if (_activeRefreshCountdown) { clearInterval(_activeRefreshCountdown); _activeRefreshCountdown = null; }
    if (_activeRefreshTimer) { clearInterval(_activeRefreshTimer); _activeRefreshTimer = null; }
}

// Manual refresh button
document.getElementById('btn-refresh-active')?.addEventListener('click', () => {
    fetchActiveHotspotUsers();
    startActiveUsersAutoRefresh(); // reset countdown
});

// Click on Overview card → ไปหน้า Hotspot Active
document.getElementById('stat-card-online')?.addEventListener('click', () => {
    switchPage('page-hotspot');
    setTimeout(() => loadHotspotTab('tab-hotspot-active'), 100);
});

// Tab: Registered Hotspot Accounts
let _allHotspotAccounts = []; // P3: cache

async function fetchHotspotAccounts() {
    const activeSiteId = document.getElementById('select-active-site')?.value;
    const activeSiteObj = (currentSitesData?.sites || []).find(s => s.id === activeSiteId);
    const siteTag = document.getElementById('hotspot-active-site-tag');
    if (siteTag) {
        siteTag.textContent = activeSiteObj ? activeSiteObj.name : 'เราท์เตอร์';
    }

    try {
        const users = await apiFetch('/api/mikrotik/hotspot/users');
        _allHotspotAccounts = users;

        // เติม Profile filter dropdown
        const profileFilter = document.getElementById('filter-hotspot-profile');
        if (profileFilter) {
            const profiles = [...new Set(users.map(u => u.profile).filter(Boolean))];
            profileFilter.innerHTML = '<option value="">-- ทุกโปรไฟล์ --</option>';
            profiles.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p; opt.textContent = p;
                profileFilter.appendChild(opt);
            });
        }

        renderHotspotAccounts(_allHotspotAccounts);
    } catch (err) {
        document.querySelector('#table-hotspot-users tbody').innerHTML = `<tr><td colspan="10" class="text-center text-danger">ผิดพลาด: ${err.message}</td></tr>`;
    }
}

let _activeHotspotStatusFilter = 'all';

function parseUptimeToMs(uptime) {
    if (!uptime || uptime === 'Unlimited' || uptime === '00:00:00') return 0;
    let ms = 0;
    const wMatch = uptime.match(/(\d+)w/); if (wMatch) ms += parseInt(wMatch[1]) * 7 * 24 * 3600000;
    const dMatch = uptime.match(/(\d+)d/); if (dMatch) ms += parseInt(dMatch[1]) * 24 * 3600000;
    const hMatch = uptime.match(/(\d+)h/); if (hMatch) ms += parseInt(hMatch[1]) * 3600000;
    const mMatch = uptime.match(/(\d+)m/); if (mMatch) ms += parseInt(mMatch[1]) * 60000;
    const sMatch = uptime.match(/(\d+)s/); if (sMatch) ms += parseInt(sMatch[1]) * 1000;
    if (ms === 0 && uptime.includes(':')) {
        const parts = uptime.split(':').map(Number);
        if (parts.length === 3 && !parts.some(isNaN)) {
            ms = (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
        }
    }
    return ms;
}

function getHotspotUserStatus(item) {
    const uptimeMs = parseUptimeToMs(item.uptime);
    const limitMs = parseUptimeToMs(item.limitUptime);
    const hasLimit = limitMs > 0;
    const isExpired = hasLimit && (uptimeMs >= limitMs || (item.comment || '').includes('expired'));
    const isWarning = hasLimit && !isExpired && (uptimeMs >= limitMs * 0.9);

    if (isExpired) return 'expired';
    if (isWarning) return 'warning';
    return 'active';
}

function renderHotspotAccounts(users) {
    const searchVal = (document.getElementById('search-hotspot-accounts')?.value || '').toLowerCase().trim();
    const profileVal = document.getElementById('filter-hotspot-profile')?.value || '';

    let filtered = users;
    if (searchVal) {
        filtered = filtered.filter(u =>
            (u.name || '').toLowerCase().includes(searchVal) ||
            (u.comment || '').toLowerCase().includes(searchVal)
        );
    }
    if (profileVal) {
        filtered = filtered.filter(u => u.profile === profileVal);
    }
    if (_activeHotspotStatusFilter !== 'all') {
        filtered = filtered.filter(u => getHotspotUserStatus(u) === _activeHotspotStatusFilter);
    }

    const tbody = document.querySelector('#table-hotspot-users tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    // count badge
    const countEl = document.getElementById('accounts-count');
    if (countEl) {
        countEl.textContent = (searchVal || profileVal || _activeHotspotStatusFilter !== 'all')
            ? `พบ ${filtered.length} จาก ${users.length} บัญชี`
            : `${users.length} บัญชีทั้งหมด`;
    }

    const chkSelectAll = document.getElementById('chk-select-all-users');
    if (chkSelectAll) chkSelectAll.checked = false;

    const warningContainer = document.getElementById('hotspot-sensitive-warning');
    if (warningContainer) warningContainer.style.display = 'none';

    let hasMaskedPassword = false;
    users.forEach(item => {
        if (item.password && (item.password.includes('*') || /^\*+$/.test(item.password))) {
            hasMaskedPassword = true;
        }
    });
    if (hasMaskedPassword && warningContainer) warningContainer.style.display = 'flex';

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">${(searchVal || profileVal || _activeHotspotStatusFilter !== 'all') ? 'ไม่พบบัญชีที่ค้นหา' : 'ไม่พบข้อมูลบัญชี Hotspot'}</td></tr>`;
        return;
    }

    filtered.forEach(item => {
        const timeUsed = item.uptime || '0s';
        const bytesUsed = formatBytes(item.bytesOut + item.bytesIn);
        const limitTimeText = (item.limitUptime && item.limitUptime !== '00:00:00') ? item.limitUptime : 'ไม่จำกัด';
        const limitBytesText = (item.limitBytesTotal && item.limitBytesTotal > 0) ? formatBytes(item.limitBytesTotal) : 'ไม่จำกัด';
        
        const statusType = getHotspotUserStatus(item);
        let statusBadgeHTML = '';
        if (statusType === 'expired') {
            statusBadgeHTML = `<span class="badge" style="background:#fee2e2; color:#dc2626; border:1px solid #fca5a5; padding:2px 6px; border-radius:10px; font-size:0.72rem; font-weight:600;"><i class="fa-solid fa-clock-rotate-left"></i> หมดอายุแล้ว</span>`;
        } else if (statusType === 'warning') {
            statusBadgeHTML = `<span class="badge" style="background:#fef3c7; color:#d97706; border:1px solid #fde68a; padding:2px 6px; border-radius:10px; font-size:0.72rem; font-weight:600;"><i class="fa-solid fa-triangle-exclamation"></i> เหลือ <10%</span>`;
        } else {
            statusBadgeHTML = `<span class="badge" style="background:#dcfce7; color:#16a34a; border:1px solid #86efac; padding:2px 6px; border-radius:10px; font-size:0.72rem; font-weight:600;"><i class="fa-solid fa-circle-check"></i> ปกติ</span>`;
        }

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="text-align:center; vertical-align:middle;"><input type="checkbox" class="chk-user-select" data-item='${JSON.stringify(item).replace(/'/g, "&apos;")}' ></td>
            <td style="vertical-align:middle;">
                <div style="font-weight:700; color:var(--text-main); font-size:0.9rem;">${item.name}</div>
                <div style="font-size:0.78rem; color:var(--text-muted); font-family:monospace; margin-top:2px;">PW: ${item.password || '(ไม่มี)'}</div>
            </td>
            <td style="vertical-align:middle;">
                <div style="margin-bottom:3px;"><span class="badge badge-profile">${item.profile}</span></div>
                <div>${statusBadgeHTML}</div>
            </td>
            <td style="vertical-align:middle;">
                <div style="font-size:0.82rem; font-weight:600; color:var(--text-main);">สะสม: ${timeUsed}</div>
                <div style="font-size:0.75rem; color:var(--text-muted);">โควตา: ${limitTimeText}</div>
            </td>
            <td style="vertical-align:middle;">
                <div style="font-size:0.82rem; font-weight:600; color:var(--text-main);">ใช้ไป: ${bytesUsed}</div>
                <div style="font-size:0.75rem; color:var(--text-muted);">โควตา: ${limitBytesText}</div>
            </td>
            <td style="vertical-align:middle;"><span style="font-size:0.78rem;color:var(--text-muted);">${item.comment || '-'}</span></td>
            <td class="text-center" style="vertical-align:middle;">
                <div style="display:flex; gap:4px; justify-content:center;">
                    <button class="btn btn-warning btn-sm btn-quick-renew" data-item='${JSON.stringify(item).replace(/'/g, "&apos;")}' title="ต่ออายุ (1-Click)" style="padding:5px 8px; font-size:0.8rem;">
                        <i class="fa-solid fa-rotate"></i>
                    </button>
                    <button class="btn btn-primary btn-sm btn-print-single-user" data-item='${JSON.stringify(item).replace(/'/g, "&apos;")}' title="พิมพ์คูปอง" style="padding:5px 8px; font-size:0.8rem;">
                        <i class="fa-solid fa-print"></i>
                    </button>
                    <button class="btn btn-secondary btn-sm btn-edit-hotspot" data-item='${JSON.stringify(item).replace(/'/g, "&apos;")}' title="แก้ไข" style="padding:5px 8px; font-size:0.8rem;">
                        <i class="fa-solid fa-pen-to-square"></i>
                    </button>
                    <button class="btn btn-danger btn-sm btn-del-hotspot" data-id="${item.id}" data-user="${item.name}" title="ลบ" style="padding:5px 8px; font-size:0.8rem;">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });

    if (chkSelectAll) {
        chkSelectAll.addEventListener('change', (e) => {
            document.querySelectorAll('.chk-user-select').forEach(chk => { chk.checked = e.target.checked; });
        });
    }
    document.querySelectorAll('.btn-quick-renew').forEach(btn => {
        btn.addEventListener('click', () => { openQuickRenewModal(JSON.parse(btn.getAttribute('data-item'))); });
    });
    document.querySelectorAll('.btn-print-single-user').forEach(btn => {
        btn.addEventListener('click', () => { openSinglePrintModal(JSON.parse(btn.getAttribute('data-item'))); });
    });
    document.querySelectorAll('.btn-edit-hotspot').forEach(btn => {
        btn.addEventListener('click', () => { openHotspotModal(JSON.parse(btn.getAttribute('data-item'))); });
    });
    document.querySelectorAll('.btn-del-hotspot').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const username = btn.getAttribute('data-user');
            if (confirm(`คุณยืนยันต้องการลบบัญชีผู้ใช้ "${username}" ใช่หรือไม่?`)) {
                try {
                    await apiFetch(`/api/mikrotik/hotspot/users/${id}`, { method: 'DELETE' });
                    fetchHotspotAccounts();
                } catch (err) { alert(err.message); }
            }
        });
    });
}

// Quick Renew Modal Logic
function openQuickRenewModal(user) {
    const modal = document.getElementById('modal-hotspot-renew');
    if (!modal) return;

    document.getElementById('renew-user-id').value = user.id;
    document.getElementById('renew-user-name').value = user.name;
    document.getElementById('renew-user-profile').value = user.profile;

    document.getElementById('renew-display-name').textContent = user.name;
    document.getElementById('renew-display-profile').textContent = user.profile;
    document.getElementById('renew-display-uptime').textContent = user.uptime || '0s';

    let defaultUptime = '30d';
    if (user.limitUptime && user.limitUptime !== '00:00:00' && user.limitUptime !== 'Unlimited') {
        defaultUptime = user.limitUptime;
    }

    const inputCustom = document.getElementById('renew-custom-uptime');
    if (inputCustom) inputCustom.value = defaultUptime;

    document.querySelectorAll('.btn-renew-preset').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-uptime') === defaultUptime);
    });

    const errorEl = document.getElementById('hotspot-renew-error');
    if (errorEl) errorEl.style.display = 'none';

    modal.classList.add('active');
}

function closeQuickRenewModal() {
    const modal = document.getElementById('modal-hotspot-renew');
    if (modal) modal.classList.remove('active');
}

document.querySelectorAll('.btn-renew-preset').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        document.querySelectorAll('.btn-renew-preset').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const val = btn.getAttribute('data-uptime');
        const inputCustom = document.getElementById('renew-custom-uptime');
        if (inputCustom) inputCustom.value = val;
    });
});

const formRenew = document.getElementById('form-hotspot-renew');
if (formRenew) {
    formRenew.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('renew-user-id').value;
        const name = document.getElementById('renew-user-name').value;
        const limitUptime = document.getElementById('renew-custom-uptime').value;
        const errorEl = document.getElementById('hotspot-renew-error');

        const uptimeLabel = limitUptime === '00:00:00' ? 'ไม่จำกัดเวลา' : limitUptime;
        const confirmMsg = `⚡ ยืนยันการต่ออายุคูปอง Hotspot\n\nชื่อผู้ใช้: ${name}\nระยะเวลาใหม่: ${uptimeLabel}\n\nคำเตือน: ระบบจะทำการล้างเวลาใช้งานสะสมเดิมเป็น 0s และตัดการเชื่อมต่อเดิมให้อัตโนมัติ\n\nคุณยืนยันต้องการดำเนินการต่อใช่หรือไม่?`;
        
        if (!confirm(confirmMsg)) return;

        try {
            await apiFetch(`/api/mikrotik/hotspot/users/${id}/renew`, {
                method: 'POST',
                body: JSON.stringify({
                    name,
                    limitUptime: limitUptime || '00:00:00'
                })
            });
            closeQuickRenewModal();
            fetchHotspotAccounts();
        } catch (err) {
            if (errorEl) {
                errorEl.textContent = err.message;
                errorEl.style.display = 'block';
            }
        }
    });
}

// Force Expire / Revert button for accidental renewals
const btnForceExpireUser = document.getElementById('btn-force-expire-user');
if (btnForceExpireUser) {
    btnForceExpireUser.addEventListener('click', async () => {
        const id = document.getElementById('renew-user-id').value;
        const name = document.getElementById('renew-user-name').value;
        if (!id || !name) return;

        if (confirm(`คุณต้องการบังคับย้อนกลับให้บัญชี "${name}" เป็นสถานะ "หมดอายุแล้ว" ทันทีใช่หรือไม่?\n\n(ใช้สำหรับกรณีกดต่ออายุผิดคน)`)) {
            try {
                await apiFetch(`/api/mikrotik/hotspot/users/${id}/renew`, {
                    method: 'POST',
                    body: JSON.stringify({
                        name,
                        limitUptime: '00:00:01'
                    })
                });
                closeQuickRenewModal();
                fetchHotspotAccounts();
            } catch (err) {
                alert('เกิดข้อผิดพลาด: ' + err.message);
            }
        }
    });
}

// Status Filter Pills Listener
document.querySelectorAll('.status-filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
        document.querySelectorAll('.status-filter-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        _activeHotspotStatusFilter = pill.getAttribute('data-filter') || 'all';
        renderHotspotAccounts(_allHotspotAccounts);
    });
});

// P3: Search/filter listeners for Hotspot Accounts
document.getElementById('search-hotspot-accounts')?.addEventListener('input', () => renderHotspotAccounts(_allHotspotAccounts));
document.getElementById('filter-hotspot-profile')?.addEventListener('change', () => renderHotspotAccounts(_allHotspotAccounts));

// Batch Reprint Selected Vouchers
const btnPrintSelected = document.getElementById('btn-print-selected-vouchers');
if (btnPrintSelected) {
    btnPrintSelected.addEventListener('click', () => {
        const selectedCheckboxes = document.querySelectorAll('.chk-user-select:checked');
        if (selectedCheckboxes.length === 0) {
            alert('กรุณาเลือกบัญชีคูปองที่ต้องการพิมพ์อย่างน้อย 1 รายการ');
            return;
        }
        const selectedUsers = Array.from(selectedCheckboxes).map(chk => JSON.parse(chk.getAttribute('data-item')));
        
        const activeSiteObj = currentSitesData.sites ? currentSitesData.sites.find(s => s.id === currentSitesData.activeSiteId) : null;
        const siteTitle = activeSiteObj ? activeSiteObj.name : 'HOTSPOT WI-FI';

        voucherResultGrid.innerHTML = '';
        selectedUsers.forEach(u => {
            const limitTimeText = u.limitUptime === '00:00:00' ? '' : u.limitUptime;
            const limitBytesText = u.limitBytesTotal === 0 ? '' : formatBytes(u.limitBytesTotal);
            const limitText = [limitTimeText, limitBytesText].filter(Boolean).join(' / ') || 'ไม่จำกัด';

            const cardHTML = `
                <div class="voucher-card">
                    <div class="voucher-header">
                        <div class="site-brand"><i class="fa-solid fa-wifi"></i> ${siteTitle}</div>
                    </div>
                    <div class="voucher-body">
                        <div class="voucher-field">
                            <div class="voucher-label">Username</div>
                            <div class="voucher-value">${u.name}</div>
                        </div>
                        <div class="voucher-field">
                            <div class="voucher-label">Password</div>
                            <div class="voucher-value pwd">${u.password || '(ไม่มี)'}</div>
                        </div>
                    </div>
                    <div class="voucher-footer">
                        <div class="pkg-name">โปรไฟล์ ${u.profile} (${limitText})</div>
                    </div>
                </div>
            `;
            voucherResultGrid.insertAdjacentHTML('beforeend', cardHTML);
        });

        voucherPrintArea.style.display = 'block';
        loadHotspotTab('tab-hotspot-vouchers');
        setTimeout(() => { window.print(); }, 300);
    });
}

// Expired Cleanup Handlers
function setAutoCleanupUI(enabled) {
    const toggle = document.getElementById('toggle-auto-cleanup');
    const card = document.getElementById('auto-cleanup-card');
    const badge = document.getElementById('auto-cleanup-status-badge');
    if (toggle) toggle.checked = enabled;
    if (card) card.classList.toggle('is-on', enabled);
    if (badge) {
        badge.textContent = enabled ? 'เปิดใช้งาน' : 'ปิดใช้งาน';
        badge.classList.toggle('on', enabled);
        badge.classList.toggle('off', !enabled);
    }
}

async function fetchAutoCleanupConfig() {
    try {
        const config = await apiFetch('/api/mikrotik/hotspot/cleanup-config');
        setAutoCleanupUI(!!config.autoCleanupExpired);
    } catch (e) {}
    fetchLineDigestConfig();
}

const toggleAutoCleanup = document.getElementById('toggle-auto-cleanup');
if (toggleAutoCleanup) {
    toggleAutoCleanup.addEventListener('change', async (e) => {
        setAutoCleanupUI(e.target.checked);
        try {
            await apiFetch('/api/mikrotik/hotspot/cleanup-config', {
                method: 'POST',
                body: JSON.stringify({ autoCleanupExpired: e.target.checked })
            });
        } catch (err) {
            alert(err.message);
            setAutoCleanupUI(!e.target.checked);
        }
    });
}

const btnCleanExpiredNow = document.getElementById('btn-clean-expired-now');
if (btnCleanExpiredNow) {
    btnCleanExpiredNow.addEventListener('click', async () => {
        if (confirm('คุณต้องการตรวจสอบและลบบัญชีคูปองที่หมดอายุแล้วทันทีใช่หรือไม่?')) {
            btnCleanExpiredNow.disabled = true;
            btnCleanExpiredNow.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังลบ...';
            try {
                const res = await apiFetch('/api/mikrotik/hotspot/cleanup-expired', { method: 'POST' });
                alert(`ลบบัญชีคูปองที่หมดอายุแล้วเรียบร้อย จำนวน ${res.deletedCount} รายชื่อ`);
                fetchHotspotAccounts();
            } catch (err) {
                alert('เกิดข้อผิดพลาด: ' + err.message);
            } finally {
                btnCleanExpiredNow.disabled = false;
                btnCleanExpiredNow.innerHTML = '<i class="fa-solid fa-broom"></i> ลบคูปองหมดอายุทันที';
            }
        }
    });
}

// ==========================================
// LINE Official Account / Messaging API (Option 1 - Multi-Site Aware)
// ==========================================
async function fetchLineDigestConfig(targetSiteId) {
    try {
        const lineSiteSelect = document.getElementById('select-line-digest-site');
        const siteId = targetSiteId || (lineSiteSelect ? lineSiteSelect.value : '') || document.getElementById('select-active-site')?.value || '';
        if (lineSiteSelect && siteId && lineSiteSelect.value !== siteId) {
            lineSiteSelect.value = siteId;
        }
        const config = await apiFetch(`/api/mikrotik/line-digest/config?siteId=${siteId}`);
        setLineDigestUI(config);
    } catch (e) {
        console.error('Failed to fetch LINE OA config:', e);
    }
}

const selectLineDigestSiteEl = document.getElementById('select-line-digest-site');
if (selectLineDigestSiteEl) {
    selectLineDigestSiteEl.addEventListener('change', (e) => {
        fetchLineDigestConfig(e.target.value);
    });
}

function setLineDigestUI(config) {
    const toggle = document.getElementById('toggle-line-digest');
    const badge = document.getElementById('line-digest-status-badge');
    const siteBadge = document.getElementById('line-digest-site-name');
    const tokenInput = document.getElementById('line-channel-access-token');
    const targetInput = document.getElementById('line-target-id');
    const timeInput = document.getElementById('line-digest-time');
    const lineSiteSelect = document.getElementById('select-line-digest-site');
    const saveBtn = document.getElementById('btn-save-line-digest');
    const testBtn = document.getElementById('btn-test-line-notify');
    const runNowBtn = document.getElementById('btn-run-line-digest-now');

    const targetSiteId = config.siteId || (lineSiteSelect ? lineSiteSelect.value : '') || (currentSitesData ? currentSitesData.activeSiteId : '');
    const siteObj = (currentSitesData?.sites || []).find(s => s.id === targetSiteId);
    const siteName = siteObj ? siteObj.name : targetSiteId;

    if (siteBadge) {
        siteBadge.textContent = siteName;
    }

    if (lineSiteSelect && config.siteId) {
        lineSiteSelect.value = config.siteId;
    }

    if (toggle) {
        toggle.checked = !!config.enabled;
        toggle.disabled = false;
    }
    if (tokenInput) {
        tokenInput.value = config.channelAccessToken || '';
        tokenInput.disabled = false;
    }
    if (targetInput) {
        targetInput.value = config.targetId || '';
        targetInput.disabled = false;
    }
    if (timeInput) {
        if (config.digestTime) timeInput.value = config.digestTime;
        timeInput.disabled = false;
    }
    if (saveBtn) saveBtn.disabled = false;
    if (testBtn) testBtn.disabled = false;
    if (runNowBtn) runNowBtn.disabled = false;

    if (badge) {
        if (config.enabled) {
            badge.textContent = `เปิดใช้งาน (${config.digestTime || '09:00'} น.)`;
            badge.className = 'auto-cleanup-status-badge on';
            badge.style.background = '#dcfce7';
            badge.style.color = '#15803d';
        } else {
            badge.textContent = 'ปิดใช้งาน';
            badge.className = 'auto-cleanup-status-badge off';
            badge.style.background = '#f1f5f9';
            badge.style.color = '#64748b';
        }
    }
}

document.getElementById('btn-save-line-digest')?.addEventListener('click', async () => {
    const lineSiteSelect = document.getElementById('select-line-digest-site');
    const siteId = (lineSiteSelect ? lineSiteSelect.value : '') || document.getElementById('select-active-site')?.value || '';
    const siteObj = (currentSitesData?.sites || []).find(s => s.id === siteId);
    const siteName = siteObj ? siteObj.name : siteId;

    const enabled = document.getElementById('toggle-line-digest')?.checked || false;
    const token = document.getElementById('line-channel-access-token')?.value || '';
    const targetId = document.getElementById('line-target-id')?.value || '';
    const digestTime = document.getElementById('line-digest-time')?.value || '09:00';

    try {
        const updated = await apiFetch(`/api/mikrotik/line-digest/config?siteId=${siteId}`, {
            method: 'POST',
            body: JSON.stringify({
                siteId,
                enabled,
                channelAccessToken: token,
                targetId,
                digestTime
            })
        });
        setLineDigestUI(updated);
        alert(`บันทึกการตั้งค่า LINE Official Account ของสาขา "${siteName}" เรียบร้อยแล้ว!`);
    } catch (err) {
        alert('เกิดข้อผิดพลาด: ' + err.message);
    }
});

document.getElementById('toggle-line-digest')?.addEventListener('change', (e) => {
    const enabled = e.target.checked;
    const badge = document.getElementById('line-digest-status-badge');
    if (badge) {
        if (enabled) {
            badge.textContent = 'เปิดใช้งาน (ยังไม่ได้บันทึก)';
            badge.className = 'auto-cleanup-status-badge on';
        } else {
            badge.textContent = 'ปิดใช้งาน';
            badge.className = 'auto-cleanup-status-badge off';
        }
    }
});

document.getElementById('btn-test-line-notify')?.addEventListener('click', async () => {
    const lineSiteSelect = document.getElementById('select-line-digest-site');
    const siteId = (lineSiteSelect ? lineSiteSelect.value : '') || document.getElementById('select-active-site')?.value || '';

    const token = document.getElementById('line-channel-access-token')?.value || '';
    const targetId = document.getElementById('line-target-id')?.value || '';
    if (!token || !targetId) {
        alert('กรุณากรอก Channel Access Token และ Target ID ก่อนทดสอบ');
        return;
    }
    const btn = document.getElementById('btn-test-line-notify');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังส่ง...';
    try {
        await apiFetch(`/api/mikrotik/line-digest/test?siteId=${siteId}`, {
            method: 'POST',
            body: JSON.stringify({ siteId, token, targetId })
        });
        alert('ส่ง Push Message ทดสอบจาก LINE Official Account สำเร็จ! กรุณาเช็คใน LINE');
    } catch (err) {
        alert('ส่งข้อความทดสอบล้มเหลว: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-paper-plane"></i> ทดสอบส่ง Push';
    }
});

document.getElementById('btn-run-line-digest-now')?.addEventListener('click', async () => {
    const lineSiteSelect = document.getElementById('select-line-digest-site');
    const siteId = (lineSiteSelect ? lineSiteSelect.value : '') || document.getElementById('select-active-site')?.value || '';

    const token = document.getElementById('line-channel-access-token')?.value || '';
    const targetId = document.getElementById('line-target-id')?.value || '';
    if (!token || !targetId) {
        alert('กรุณากรอก Channel Access Token และ Target ID ก่อนใช้งาน');
        return;
    }
    if (!confirm('ต้องการส่งรายงาน Flex Card สรุปคูปอง/ผู้ใช้ใกล้หมดอายุเข้า LINE ทันทีใช่หรือไม่?')) return;

    const btn = document.getElementById('btn-run-line-digest-now');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังส่ง...';
    try {
        const res = await apiFetch(`/api/mikrotik/line-digest/run-now?siteId=${siteId}`, {
            method: 'POST',
            body: JSON.stringify({ siteId, token, targetId })
        });
        alert(`ส่งรายงาน Flex Card เข้า LINE สำเร็จ!\n(พบใกล้หมดอายุ: 1 วัน=${res.counts.d1}, 3 วัน=${res.counts.d3}, 7 วัน=${res.counts.d7})`);
    } catch (err) {
        alert('เกิดข้อผิดพลาด: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-bullhorn"></i> ส่งแจ้งหมดอายุสาขานี้';
    }
});

document.getElementById('btn-send-multi-health-line')?.addEventListener('click', async () => {
    const token = document.getElementById('line-channel-token')?.value || '';
    const targetId = document.getElementById('line-target-id')?.value || '';
    if (!token || !targetId) {
        alert('กรุณากรอก Channel Access Token และ Target ID ก่อนใช้งาน');
        return;
    }
    if (!confirm('ต้องการส่งรายงานสรุปสถานะสุขภาพทั้ง 4 สาขา (Daily Health) เข้า LINE ทันทีใช่หรือไม่?')) return;

    const btn = document.getElementById('btn-send-multi-health-line');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังตรวจ & ส่ง...';
    try {
        const res = await apiFetch('/api/mikrotik/line-health/run-now', {
            method: 'POST',
            body: JSON.stringify({ token, targetId })
        });
        const onlineCount = (res.sites || []).filter(s => s.online).length;
        alert(`🎉 ส่งรายงานสรุปสุขภาพเราท์เตอร์เข้า LINE เรียบร้อยแล้ว!\n(สถานะ: ${onlineCount}/${(res.sites || []).length} สาขาออนไลน์)`);
    } catch (err) {
        alert('เกิดข้อผิดพลาด: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-chart-pie"></i> ส่งสรุปสุขภาพ 4 สาขา';
    }
});



// ==========================================
// Tab: Archived / Expired & Deleted Hotspot Users
// ==========================================
let _allArchivedUsers = [];

async function fetchArchivedHotspotUsers() {
    const tbody = document.querySelector('#table-hotspot-archive tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin"></i> กำลังดึงประวัติ...</td></tr>';
    
    try {
        const res = await apiFetch('/api/mikrotik/hotspot/archived-users');
        _allArchivedUsers = res.users || [];
        
        const badgeArchive = document.getElementById('badge-hotspot-archive');
        if (badgeArchive) badgeArchive.textContent = res.total || 0;
        
        renderArchivedHotspotUsers(_allArchivedUsers);
    } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">เกิดข้อผิดพลาด: ${err.message}</td></tr>`;
    }
}

function renderArchivedHotspotUsers(users) {
    const tbody = document.querySelector('#table-hotspot-archive tbody');
    if (!tbody) return;
    
    const searchVal = (document.getElementById('search-hotspot-archive')?.value || '').toLowerCase().trim();
    let filtered = users;
    if (searchVal) {
        filtered = filtered.filter(u =>
            (u.username || '').toLowerCase().includes(searchVal) ||
            (u.comment || '').toLowerCase().includes(searchVal) ||
            (u.profile || '').toLowerCase().includes(searchVal)
        );
    }

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">ไม่พบรายการประวัติคูปองหมดอายุ/ถูกลบ</td></tr>';
        return;
    }

    tbody.innerHTML = '';
    filtered.forEach(item => {
        const tr = document.createElement('tr');
        
        const expiredDate = item.deletedAt ? new Date(item.deletedAt).toLocaleString('th-TH') : '-';
        
        let reasonBadge = '';
        if (item.reason === 'manual_delete') {
            reasonBadge = '<span class="badge" style="background:#fee2e2; color:#dc2626; border:1px solid #fca5a5; padding:2px 6px; border-radius:10px; font-size:0.72rem; font-weight:600;"><i class="fa-solid fa-user-xmark"></i> ลบโดยแอดมิน</span>';
        } else if (item.reason === 'auto_cleanup') {
            reasonBadge = '<span class="badge" style="background:#fef3c7; color:#d97706; border:1px solid #fde68a; padding:2px 6px; border-radius:10px; font-size:0.72rem; font-weight:600;"><i class="fa-solid fa-broom"></i> ล้างอัตโนมัติ</span>';
        } else {
            reasonBadge = '<span class="badge" style="background:#f3f4f6; color:#4b5563; border:1px solid #d1d5db; padding:2px 6px; border-radius:10px; font-size:0.72rem; font-weight:600;"><i class="fa-solid fa-clock-rotate-left"></i> หมดอายุแล้ว</span>';
        }

        tr.innerHTML = `
            <td style="vertical-align:middle;">
                <div style="font-weight:700; color:var(--text-main); font-size:0.9rem;">${item.username}</div>
                <div style="font-size:0.78rem; color:var(--text-muted); font-family:monospace; margin-top:2px;">PW: ${item.password || '(ไม่มี)'}</div>
            </td>
            <td style="vertical-align:middle;"><span class="badge badge-info">${item.profile || 'default'}</span></td>
            <td style="vertical-align:middle;">${item.siteName || 'Default'}</td>
            <td style="vertical-align:middle;">${reasonBadge}</td>
            <td style="vertical-align:middle; font-size:0.85rem; color:var(--text-secondary);">${expiredDate}</td>
            <td style="vertical-align:middle; font-size:0.85rem;">${item.deletedBy || 'System'}</td>
            <td style="text-align:right; vertical-align:middle;">
                <div style="display:flex; gap:6px; justify-content:flex-end;">
                    <button class="btn btn-primary btn-sm btn-restore-archived-user" data-item='${JSON.stringify(item).replace(/'/g, "&apos;")}' title="คืนค่าสร้างบัญชีกลับเข้า MikroTik">
                        <i class="fa-solid fa-rotate-left"></i> คืนค่า (Restore)
                    </button>
                    <button class="btn btn-danger btn-sm btn-delete-archived-user" data-id="${item.id}" title="ลบออกจากประวัติ">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

document.getElementById('search-hotspot-archive')?.addEventListener('input', () => {
    renderArchivedHotspotUsers(_allArchivedUsers);
});

document.getElementById('btn-refresh-hotspot-archive')?.addEventListener('click', () => {
    fetchArchivedHotspotUsers();
});

document.getElementById('btn-clear-hotspot-archive')?.addEventListener('click', async () => {
    if (!confirm('คุณแน่ใจหรือไม่ว่าต้องการล้างประวัติคูปองหมดอายุทั้งหมด?')) return;
    try {
        const res = await apiFetch('/api/mikrotik/hotspot/archived-users', { method: 'DELETE' });
        if (res.success) {
            alert(`ล้างประวัติสำเร็จจำนวน ${res.count} รายการ`);
            fetchArchivedHotspotUsers();
        }
    } catch (err) {
        alert(`เกิดข้อผิดพลาด: ${err.message}`);
    }
});

document.querySelector('#table-hotspot-archive tbody')?.addEventListener('click', async (e) => {
    const restoreBtn = e.target.closest('.btn-restore-archived-user');
    if (restoreBtn) {
        const item = JSON.parse(restoreBtn.getAttribute('data-item'));
        openRestoreUserModal(item);
        return;
    }

    const deleteBtn = e.target.closest('.btn-delete-archived-user');
    if (deleteBtn) {
        const id = deleteBtn.getAttribute('data-id');
        if (!confirm('ยืนยันลบรายการประวัตินี้?')) return;
        try {
            const res = await apiFetch(`/api/mikrotik/hotspot/archived-users/${id}`, { method: 'DELETE' });
            if (res.success) {
                fetchArchivedHotspotUsers();
            }
        } catch (err) {
            alert(`เกิดข้อผิดพลาด: ${err.message}`);
        }
    }
});

async function openRestoreUserModal(item) {
    const modal = document.getElementById('modal-hotspot-restore');
    if (!modal) return;
    
    document.getElementById('restore-archive-id').value = item.id;
    document.getElementById('restore-username').value = item.username;
    document.getElementById('restore-password').value = item.password || '';
    document.getElementById('restore-limit-uptime').value = item.limitUptime || '';
    document.getElementById('restore-comment').value = item.comment ? `${item.comment} (Restored)` : 'Restored Coupon';
    
    const profileSelect = document.getElementById('restore-profile');
    if (profileSelect) {
        profileSelect.innerHTML = '<option value="">กำลังโหลดโปรไฟล์...</option>';
        try {
            const profiles = await apiFetch('/api/mikrotik/hotspot/profiles');
            profileSelect.innerHTML = profiles.map(p => `<option value="${p.name}" ${p.name === item.profile ? 'selected' : ''}>${p.name}</option>`).join('');
        } catch (err) {
            profileSelect.innerHTML = '<option value="default">default</option>';
        }
    }
    
    document.getElementById('restore-error').style.display = 'none';
    modal.classList.add('show');
}

document.getElementById('modal-hotspot-restore-close')?.addEventListener('click', () => {
    document.getElementById('modal-hotspot-restore')?.classList.remove('show');
});

document.getElementById('form-hotspot-restore')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('restore-archive-id').value;
    const username = document.getElementById('restore-username').value;
    const password = document.getElementById('restore-password').value;
    const profile = document.getElementById('restore-profile').value;
    const limitUptime = document.getElementById('restore-limit-uptime').value;
    const comment = document.getElementById('restore-comment').value;

    const errEl = document.getElementById('restore-error');
    errEl.style.display = 'none';

    try {
        const res = await apiFetch(`/api/mikrotik/hotspot/archived-users/${id}/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                password,
                profile,
                limitUptime,
                comment
            })
        });

        if (res.success) {
            alert(`สร้างบัญชี ${username} กลับเข้า MikroTik สำเร็จ!`);
            document.getElementById('modal-hotspot-restore').classList.remove('show');
            fetchArchivedHotspotUsers();
            if (typeof activeHotspotTab !== 'undefined' && activeHotspotTab === 'tab-hotspot-accounts') {
                fetchHotspotAccounts();
            }
        }
    } catch (err) {
        errEl.textContent = `เกิดข้อผิดพลาด: ${err.message}`;
        errEl.style.display = 'block';
    }
});

// Tab: Hotspot User Profiles Management
async function fetchHotspotProfiles() {
    try {
        const profiles = await apiFetch('/api/mikrotik/hotspot/profiles');
        const tbody = document.querySelector('#table-hotspot-profiles tbody');
        tbody.innerHTML = '';
        if (profiles.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">ไม่พบโปรไฟล์ในระบบ</td></tr>';
            return;
        }
        profiles.forEach(p => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${p.name}</strong></td>
                <td><span class="badge badge-profile">${p.rateLimit}</span></td>
                <td>${p.sharedUsers} เครื่อง</td>
                <td>${p.sessionTimeout === '00:00:00' ? 'ไม่จำกัด' : p.sessionTimeout}</td>
                <td class="text-center">
                    <div style="display:flex; gap:6px; justify-content:center;">
                        <button class="btn btn-secondary btn-sm btn-edit-profile" data-item='${JSON.stringify(p).replace(/'/g, "&apos;")}'><i class="fa-solid fa-pen-to-square"></i> แก้ไข</button>
                        <button class="btn btn-danger btn-sm btn-del-profile" data-id="${p.id}" data-name="${p.name}"><i class="fa-solid fa-trash-can"></i> ลบ</button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });

        document.querySelectorAll('.btn-edit-profile').forEach(b => {
            b.addEventListener('click', () => { openProfileModal(JSON.parse(b.getAttribute('data-item'))); });
        });
        document.querySelectorAll('.btn-del-profile').forEach(b => {
            b.addEventListener('click', async () => {
                const id = b.getAttribute('data-id');
                const name = b.getAttribute('data-name');
                if (confirm(`คุณต้องการลบโปรไฟล์ "${name}" ใช่หรือไม่?`)) {
                    try {
                        await apiFetch(`/api/mikrotik/hotspot/profiles/${id}`, { method: 'DELETE' });
                        fetchHotspotProfiles();
                    } catch (err) { alert(err.message); }
                }
            });
        });
    } catch (err) {
        document.querySelector('#table-hotspot-profiles tbody').innerHTML = `<tr><td colspan="5" class="text-center text-danger">ผิดพลาด: ${err.message}</td></tr>`;
    }
}

// Profile Modal Actions
const modalProfile = document.getElementById('modal-profile');
const formProfileItem = document.getElementById('form-profile-item');
const profileError = document.getElementById('profile-error');

function openProfileModal(item = null) {
    if (item) {
        document.getElementById('profile-modal-title').textContent = 'แก้ไขโปรไฟล์ Hotspot';
        document.getElementById('profile-id').value = item.id;
        document.getElementById('profile-name').value = item.name;
        document.getElementById('profile-rate-limit').value = item.rateLimit === 'Unlimited' ? '' : item.rateLimit;
        document.getElementById('profile-shared-users').value = item.sharedUsers || '1';
        document.getElementById('profile-session-timeout').value = item.sessionTimeout === '00:00:00' ? '' : item.sessionTimeout;
    } else {
        document.getElementById('profile-modal-title').textContent = 'เพิ่มโปรไฟล์ Hotspot ใหม่';
        document.getElementById('profile-id').value = '';
        document.getElementById('profile-name').value = '';
        document.getElementById('profile-rate-limit').value = '';
        document.getElementById('profile-shared-users').value = '1';
        document.getElementById('profile-session-timeout').value = '';
    }
    document.getElementById('profile-rate-preset').value = '';
    document.getElementById('profile-session-timeout-preset').value = '';
    if (profileError) profileError.style.display = 'none';
    if (modalProfile) modalProfile.classList.add('active');
}

function closeProfileModal() {
    if (modalProfile) modalProfile.classList.remove('active');
}

const btnAddProfileEl = document.getElementById('btn-add-profile');
if (btnAddProfileEl) {
    btnAddProfileEl.addEventListener('click', () => openProfileModal());
}

document.querySelectorAll('#modal-profile .modal-cancel, #modal-profile .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', closeProfileModal);
});

const profileRatePreset = document.getElementById('profile-rate-preset');
if (profileRatePreset) {
    profileRatePreset.addEventListener('change', (e) => {
        if (e.target.value) document.getElementById('profile-rate-limit').value = e.target.value;
    });
}

const profileSessionPreset = document.getElementById('profile-session-timeout-preset');
if (profileSessionPreset) {
    profileSessionPreset.addEventListener('change', (e) => {
        if (e.target.value) document.getElementById('profile-session-timeout').value = e.target.value;
    });
}

if (formProfileItem) {
    formProfileItem.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('profile-id').value;
        const name = document.getElementById('profile-name').value;
        const rateLimit = document.getElementById('profile-rate-limit').value;
        const sharedUsers = document.getElementById('profile-shared-users').value;
        const sessionTimeout = document.getElementById('profile-session-timeout').value;

        const body = { name, rateLimit, sharedUsers, sessionTimeout };
        const url = id ? `/api/mikrotik/hotspot/profiles/${id}` : '/api/mikrotik/hotspot/profiles';
        const method = id ? 'PUT' : 'POST';

        try {
            await apiFetch(url, { method, body: JSON.stringify(body) });
            closeProfileModal();
            fetchHotspotProfiles();
        } catch (err) {
            if (profileError) {
                profileError.textContent = err.message;
                profileError.style.display = 'block';
            }
        }
    });
}

// Fetch Hotspot user profiles list to drop-down elements
let hotspotProfilesCached = [];
async function fetchProfilesToDropdown() {
    try {
        const profiles = await apiFetch('/api/mikrotik/hotspot/profiles');
        hotspotProfilesCached = profiles;
        
        // Update select options in Add Form and Generator Form
        const addSelect = document.getElementById('hotspot-profile');
        const genSelect = document.getElementById('gen-profile');
        
        const optionsHTML = profiles.map(p => `<option value="${p.name}">${p.name} (${p.rateLimit})</option>`).join('');
        if (addSelect) addSelect.innerHTML = optionsHTML;
        if (genSelect) genSelect.innerHTML = optionsHTML;
    } catch (err) {
        console.error('Failed to fetch user profiles:', err);
    }
}


// ==========================================
// PPPoE ROOM ACCOUNT MANAGEMENT
// ==========================================
let activePppoeTab = 'tab-pppoe-active';

function loadPppoeTab(tabId) {
    activePppoeTab = tabId;
    document.querySelectorAll('#page-pppoe .tab-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.getAttribute('data-tab') === tabId) btn.classList.add('active');
    });
    document.querySelectorAll('#page-pppoe .tab-content').forEach(c => c.classList.remove('active'));
    const tabEl = document.getElementById(tabId);
    if (tabEl) tabEl.classList.add('active');

    stopPppoeActiveAutoRefresh();

    if (tabId === 'tab-pppoe-active') {
        fetchPppoeActive();
        startPppoeActiveAutoRefresh();
    } else if (tabId === 'tab-pppoe-accounts') {
        fetchPppoeAccounts();
        fetchPppoeProfilesToDropdown();
    } else if (tabId === 'tab-pppoe-profiles') {
        fetchPppoeProfiles();
        fetchPppoeServerKeepalive();
    } else if (tabId === 'tab-pppoe-billing') {
        fetchPppoeBilling();
    }
}

document.querySelectorAll('#page-pppoe .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => loadPppoeTab(btn.getAttribute('data-tab')));
});

// ---- TAB: Live Status ----
let _pppoeActiveRefreshCountdown = null;
const PPPOE_REFRESH_INTERVAL = 30;

async function fetchPppoeActive() {
    try {
        const active = await apiFetch('/api/mikrotik/pppoe/active');
        const tbody = document.querySelector('#table-pppoe-active tbody');
        if (!tbody) return;
        tbody.innerHTML = '';

        const badge = document.getElementById('badge-pppoe-active');
        if (badge) badge.textContent = `(${active.length})`;

        const overviewStat = document.getElementById('stat-pppoe-rooms');
        if (overviewStat) overviewStat.textContent = `${active.length} ห้อง`;

        if (active.length === 0) {
            tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">ไม่มีห้องออนไลน์ในขณะนี้</td></tr>';
            return;
        }

        active.forEach(item => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${item.name}</strong></td>
                <td><code>${item.address || '-'}</code></td>
                <td><code>${item.callerId || '-'}</code></td>
                <td>${item.uptime}</td>
                <td>${formatBytes(item.bytesOut)}</td>
                <td>${formatBytes(item.bytesIn)}</td>
                <td class="text-center">
                    <div style="display:flex; gap:6px; justify-content:center;">
                        <button class="btn btn-warning btn-sm btn-suspend-pppoe" data-user="${item.name}" title="ระงับการใช้งาน (เช่น กรณีค้างชำระ)">
                            <i class="fa-solid fa-lock"></i> ระงับการใช้งาน
                        </button>
                        <button class="btn btn-danger btn-sm btn-kick-pppoe" data-id="${item.id}" data-user="${item.name}" title="ตัดการเชื่อมต่อชั่วคราว (เชื่อมต่อใหม่ได้ทันที)">
                            <i class="fa-solid fa-plug-circle-xmark"></i> ตัดการเชื่อมต่อ
                        </button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });

        document.querySelectorAll('.btn-kick-pppoe').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-id');
                const user = btn.getAttribute('data-user');
                if (!confirm(`ตัดการเชื่อมต่อห้อง "${user}" ใช่หรือไม่?`)) return;
                try {
                    btn.disabled = true;
                    await apiFetch(`/api/mikrotik/pppoe/active/${id}`, { method: 'DELETE' });
                    fetchPppoeActive();
                } catch (err) {
                    alert(err.message);
                    btn.disabled = false;
                }
            });
        });

        document.querySelectorAll('.btn-suspend-pppoe').forEach(btn => {
            btn.addEventListener('click', async () => {
                const user = btn.getAttribute('data-user');
                if (!confirm(`ระงับการใช้งานห้อง "${user}" ใช่หรือไม่? (จะตัดการเชื่อมต่อทันทีและห้องนี้จะเชื่อมต่อใหม่ไม่ได้จนกว่าจะปลดล็อก)`)) return;
                try {
                    btn.disabled = true;
                    await apiFetch(`/api/mikrotik/pppoe/users/by-name/${encodeURIComponent(user)}/suspend`, {
                        method: 'PATCH',
                        body: JSON.stringify({ suspend: true })
                    });
                    fetchPppoeActive();
                } catch (err) {
                    alert(err.message);
                    btn.disabled = false;
                }
            });
        });
    } catch (err) {
        const tbody = document.querySelector('#table-pppoe-active tbody');
        if (tbody) tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">ผิดพลาด: ${err.message}</td></tr>`;
    }
}

function startPppoeActiveAutoRefresh() {
    stopPppoeActiveAutoRefresh();
    let remaining = PPPOE_REFRESH_INTERVAL;
    const updateCountdown = () => {
        const el = document.getElementById('pppoe-refresh-countdown');
        if (el) el.textContent = `รีเฟรชใน ${remaining}s`;
        remaining--;
        if (remaining < 0) {
            remaining = PPPOE_REFRESH_INTERVAL;
            fetchPppoeActive();
        }
    };
    updateCountdown();
    _pppoeActiveRefreshCountdown = setInterval(updateCountdown, 1000);
}

function stopPppoeActiveAutoRefresh() {
    if (_pppoeActiveRefreshCountdown) { clearInterval(_pppoeActiveRefreshCountdown); _pppoeActiveRefreshCountdown = null; }
}

document.getElementById('btn-refresh-pppoe-active')?.addEventListener('click', () => {
    fetchPppoeActive();
    startPppoeActiveAutoRefresh();
});

// ---- TAB: Room Accounts ----
let _allPppoeAccounts = [];

async function fetchPppoeAccounts() {
    try {
        const users = await apiFetch('/api/mikrotik/pppoe/users');
        _allPppoeAccounts = users;
        const badge = document.getElementById('badge-pppoe-accounts');
        if (badge) badge.textContent = `(${users.length})`;
        renderPppoeAccounts(users);
    } catch (err) {
        document.querySelector('#table-pppoe-users tbody').innerHTML = `<tr><td colspan="6" class="text-center text-danger">ผิดพลาด: ${err.message}</td></tr>`;
    }
}

function parseRouterOSDate(str) {
    if (!str || typeof str !== 'string') return null;

    // Check standard ISO / Date format
    let d = new Date(str);
    if (!isNaN(d.getTime())) {
        if (d.getFullYear() <= 1970) return null;
        return d;
    }

    // Parse RouterOS format: "aug/12/2026 19:45:10" or "aug/12/2026"
    const months = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const parts = str.trim().split(/[\s/:]+/);
    if (parts.length >= 3) {
        const monthStr = parts[0].toLowerCase();
        if (months.hasOwnProperty(monthStr)) {
            const month = months[monthStr];
            const day = parseInt(parts[1], 10);
            const year = parseInt(parts[2], 10);
            const hours = parseInt(parts[3] || 0, 10);
            const minutes = parseInt(parts[4] || 0, 10);
            const seconds = parseInt(parts[5] || 0, 10);

            if (year <= 1970) return null;

            d = new Date(year, month, day, hours, minutes, seconds);
            if (!isNaN(d.getTime())) return d;
        }
    }
    return null;
}

function formatLastOnlineTime(isOnline, currentUptime, lastLoggedOut, disabled) {
    if (disabled) {
        return `<span class="status-badge-disconnected" style="font-size:0.75rem;"><i class="fa-solid fa-circle" style="font-size:0.45rem;"></i> ถูกระงับการใช้งาน</span>`;
    }
    if (isOnline) {
        return `<span class="status-badge-connected" style="font-size:0.78rem; font-weight:600;"><i class="fa-solid fa-circle text-success" style="font-size:0.5rem;"></i> ออนไลน์ขณะนี้ (${currentUptime || 'Active'})</span>`;
    }

    const d = parseRouterOSDate(lastLoggedOut);
    if (!d) {
        return `<span style="font-size:0.78rem; color:var(--text-muted);"><i class="fa-solid fa-clock-rotate-left"></i> ไม่เคยออนไลน์</span>`;
    }

    const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
    let relativeStr = '';
    if (diffSec < 60) relativeStr = 'เมื่อสักครู่';
    else if (diffSec < 3600) relativeStr = `${Math.floor(diffSec / 60)} นาทีที่แล้ว`;
    else if (diffSec < 86400) relativeStr = `${Math.floor(diffSec / 3600)} ชั่วโมงที่แล้ว`;
    else relativeStr = `${Math.floor(diffSec / 86400)} วันที่แล้ว`;

    const formattedDate = d.toLocaleString('th-TH', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
    });

    return `<div style="font-size:0.78rem; line-height:1.25;">
        <span style="font-weight:600; color:var(--text-main);"><i class="fa-solid fa-clock-rotate-left text-muted"></i> ${formattedDate} น.</span>
        <span style="font-size:0.72rem; color:var(--text-muted); display:block;">(${relativeStr})</span>
    </div>`;
}

function renderPppoeAccounts(users) {
    const searchVal = (document.getElementById('search-pppoe-accounts')?.value || '').toLowerCase().trim();
    const filtered = searchVal
        ? users.filter(u =>
            (u.name || '').toLowerCase().includes(searchVal) ||
            (u.profile || '').toLowerCase().includes(searchVal) ||
            (u.comment || '').toLowerCase().includes(searchVal)
          )
        : users;

    const tbody = document.querySelector('#table-pppoe-users tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const countEl = document.getElementById('pppoe-accounts-count');
    if (countEl) {
        countEl.textContent = searchVal
            ? `พบ ${filtered.length} จาก ${users.length} ห้อง`
            : `${users.length} ห้องทั้งหมด`;
    }

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">${searchVal ? 'ไม่พบห้องที่ค้นหา' : 'ยังไม่มีบัญชีห้อง'}</td></tr>`;
        return;
    }

    filtered.forEach(item => {
        const lastOnlineHtml = formatLastOnlineTime(item.isOnline, item.currentUptime, item.lastLoggedOut, item.disabled);
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><strong>${item.name}</strong></td>
            <td><code>${item.password || '(ไม่แสดง)'}</code></td>
            <td><span class="badge badge-profile">${item.profile}</span></td>
            <td>${lastOnlineHtml}</td>
            <td><span style="font-size:0.8rem;color:var(--text-muted);">${item.comment || '-'}</span></td>
            <td class="text-center">
                <div style="display:flex; gap:6px; justify-content:center;">
                    <button class="btn ${item.disabled ? 'btn-success' : 'btn-warning'} btn-sm btn-suspend-pppoe-user" data-user="${item.name}" data-suspend="${!item.disabled}" title="${item.disabled ? 'ปลดล็อก (เปิดใช้งาน)' : 'ระงับการใช้งาน (เช่น กรณีค้างชำระ)'}">
                        <i class="fa-solid ${item.disabled ? 'fa-lock-open' : 'fa-lock'}"></i>
                    </button>
                    <button class="btn btn-secondary btn-sm btn-edit-pppoe-user" data-item='${JSON.stringify(item).replace(/'/g, "&apos;")}' title="แก้ไข">
                        <i class="fa-solid fa-pen-to-square"></i>
                    </button>
                    <button class="btn btn-danger btn-sm btn-del-pppoe-user" data-id="${item.id}" data-user="${item.name}" title="ลบ">
                        <i class="fa-solid fa-trash-can"></i>
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });

    document.querySelectorAll('.btn-suspend-pppoe-user').forEach(btn => {
        btn.addEventListener('click', async () => {
            const user = btn.getAttribute('data-user');
            const suspend = btn.getAttribute('data-suspend') === 'true';
            const confirmMsg = suspend
                ? `ระงับการใช้งานห้อง "${user}" ใช่หรือไม่? (จะเชื่อมต่อใหม่ไม่ได้จนกว่าจะปลดล็อก)`
                : `ปลดล็อกห้อง "${user}" ใช่หรือไม่?`;
            if (!confirm(confirmMsg)) return;
            try {
                btn.disabled = true;
                await apiFetch(`/api/mikrotik/pppoe/users/by-name/${encodeURIComponent(user)}/suspend`, {
                    method: 'PATCH',
                    body: JSON.stringify({ suspend })
                });
                fetchPppoeAccounts();
            } catch (err) {
                alert(err.message);
                btn.disabled = false;
            }
        });
    });
    document.querySelectorAll('.btn-edit-pppoe-user').forEach(btn => {
        btn.addEventListener('click', () => openPppoeUserModal(JSON.parse(btn.getAttribute('data-item'))));
    });
    document.querySelectorAll('.btn-del-pppoe-user').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            const user = btn.getAttribute('data-user');
            if (!confirm(`ต้องการลบบัญชีห้อง "${user}" ใช่หรือไม่?`)) return;
            try {
                await apiFetch(`/api/mikrotik/pppoe/users/${id}`, { method: 'DELETE' });
                fetchPppoeAccounts();
            } catch (err) { alert(err.message); }
        });
    });
}

document.getElementById('search-pppoe-accounts')?.addEventListener('input', () => renderPppoeAccounts(_allPppoeAccounts));

let pppoeProfilesCached = [];
async function fetchPppoeProfilesToDropdown() {
    try {
        const profiles = await apiFetch('/api/mikrotik/pppoe/profiles');
        pppoeProfilesCached = profiles;
        const select = document.getElementById('pppoe-user-profile');
        if (select) {
            select.innerHTML = profiles.map(p => `<option value="${p.name}">${p.name} (${p.rateLimit})</option>`).join('') || '<option value="default">default</option>';
        }
    } catch (err) {
        console.error('Failed to fetch PPPoE packages:', err);
    }
}

const modalPppoeUser = document.getElementById('modal-pppoe-user');
const formPppoeUser = document.getElementById('form-pppoe-user');
const pppoeUserError = document.getElementById('pppoe-user-error');

function openPppoeUserModal(item = null) {
    fetchPppoeProfilesToDropdown();
    if (item) {
        document.getElementById('pppoe-user-modal-title').textContent = 'แก้ไขบัญชีห้อง';
        document.getElementById('pppoe-user-id').value = item.id;
        document.getElementById('pppoe-user-name').value = item.name;
        document.getElementById('pppoe-user-name').readOnly = true;
        document.getElementById('pppoe-user-password').value = item.password || '';
        document.getElementById('pppoe-user-profile').value = item.profile;
        document.getElementById('pppoe-user-comment').value = item.comment || '';
        document.getElementById('pppoe-user-enabled').checked = !item.disabled;
    } else {
        document.getElementById('pppoe-user-modal-title').textContent = 'เพิ่มบัญชีห้องใหม่';
        document.getElementById('pppoe-user-id').value = '';
        document.getElementById('pppoe-user-name').value = '';
        document.getElementById('pppoe-user-name').readOnly = false;
        document.getElementById('pppoe-user-password').value = '';
        document.getElementById('pppoe-user-comment').value = '';
        document.getElementById('pppoe-user-enabled').checked = true;
    }
    if (pppoeUserError) pppoeUserError.style.display = 'none';
    if (modalPppoeUser) modalPppoeUser.classList.add('active');
}

function closePppoeUserModal() {
    if (modalPppoeUser) modalPppoeUser.classList.remove('active');
}

document.getElementById('btn-add-pppoe-user')?.addEventListener('click', () => openPppoeUserModal());
document.querySelectorAll('#modal-pppoe-user .modal-cancel, #modal-pppoe-user .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', closePppoeUserModal);
});

if (formPppoeUser) {
    formPppoeUser.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('pppoe-user-id').value;
        const name = document.getElementById('pppoe-user-name').value;
        const password = document.getElementById('pppoe-user-password').value;
        const profile = document.getElementById('pppoe-user-profile').value;
        const comment = document.getElementById('pppoe-user-comment').value;
        const disabled = !document.getElementById('pppoe-user-enabled').checked;

        const body = { name, password, profile, comment, disabled };
        const url = id ? `/api/mikrotik/pppoe/users/${id}` : '/api/mikrotik/pppoe/users';
        const method = id ? 'PUT' : 'POST';

        try {
            await apiFetch(url, { method, body: JSON.stringify(body) });
            closePppoeUserModal();
            fetchPppoeAccounts();
        } catch (err) {
            if (pppoeUserError) {
                pppoeUserError.textContent = err.message;
                pppoeUserError.style.display = 'block';
            }
        }
    });
}

// ---- TAB: Packages (PPP Profiles) ----
async function fetchPppoeProfiles() {
    try {
        const profiles = await apiFetch('/api/mikrotik/pppoe/profiles');
        const badge = document.getElementById('badge-pppoe-profiles');
        if (badge) badge.textContent = `(${profiles.length})`;
        const tbody = document.querySelector('#table-pppoe-profiles tbody');
        tbody.innerHTML = '';
        if (profiles.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">ยังไม่มีแพ็กเกจ — เพิ่มอย่างน้อย 1 แพ็กเกจก่อนสร้างบัญชีห้อง</td></tr>';
            return;
        }
        profiles.forEach(p => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${p.name}</strong></td>
                <td><span class="badge badge-profile">${p.rateLimit}</span></td>
                <td><code>${p.localAddress || '-'}</code></td>
                <td><code>${p.remoteAddress || '-'}</code></td>
                <td><span style="font-size:0.8rem;color:var(--text-muted);">${p.idleTimeout || '-'} / ${p.sessionTimeout || '-'}</span></td>
                <td class="text-center">
                    <div style="display:flex; gap:6px; justify-content:center;">
                        <button class="btn btn-secondary btn-sm btn-edit-pppoe-profile" data-item='${JSON.stringify(p).replace(/'/g, "&apos;")}'><i class="fa-solid fa-pen-to-square"></i> แก้ไข</button>
                        <button class="btn btn-danger btn-sm btn-del-pppoe-profile" data-id="${p.id}" data-name="${p.name}"><i class="fa-solid fa-trash-can"></i> ลบ</button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });

        document.querySelectorAll('.btn-edit-pppoe-profile').forEach(b => {
            b.addEventListener('click', () => openPppoeProfileModal(JSON.parse(b.getAttribute('data-item'))));
        });
        document.querySelectorAll('.btn-del-pppoe-profile').forEach(b => {
            b.addEventListener('click', async () => {
                const id = b.getAttribute('data-id');
                const name = b.getAttribute('data-name');
                if (!confirm(`ต้องการลบแพ็กเกจ "${name}" ใช่หรือไม่?`)) return;
                try {
                    await apiFetch(`/api/mikrotik/pppoe/profiles/${id}`, { method: 'DELETE' });
                    fetchPppoeProfiles();
                } catch (err) { alert(err.message); }
            });
        });
    } catch (err) {
        document.querySelector('#table-pppoe-profiles tbody').innerHTML = `<tr><td colspan="6" class="text-center text-danger">ผิดพลาด: ${err.message}</td></tr>`;
    }
}

const modalPppoeProfile = document.getElementById('modal-pppoe-profile');
const formPppoeProfile = document.getElementById('form-pppoe-profile');
const pppoeProfileError = document.getElementById('pppoe-profile-error');

function openPppoeProfileModal(item = null) {
    if (item) {
        document.getElementById('pppoe-profile-modal-title').textContent = 'แก้ไขแพ็กเกจ';
        document.getElementById('pppoe-profile-id').value = item.id;
        document.getElementById('pppoe-profile-name').value = item.name;
        document.getElementById('pppoe-profile-rate-limit').value = item.rateLimit === 'Unlimited' ? '' : item.rateLimit;
        document.getElementById('pppoe-profile-local-address').value = item.localAddress || '';
        document.getElementById('pppoe-profile-remote-address').value = item.remoteAddress || '';
        document.getElementById('pppoe-profile-idle-timeout').value = item.idleTimeout || '';
        document.getElementById('pppoe-profile-session-timeout').value = item.sessionTimeout || '';
    } else {
        document.getElementById('pppoe-profile-modal-title').textContent = 'เพิ่มแพ็กเกจใหม่';
        document.getElementById('pppoe-profile-id').value = '';
        document.getElementById('pppoe-profile-name').value = '';
        document.getElementById('pppoe-profile-rate-limit').value = '';
        document.getElementById('pppoe-profile-local-address').value = '';
        document.getElementById('pppoe-profile-remote-address').value = '';
        document.getElementById('pppoe-profile-idle-timeout').value = '';
        document.getElementById('pppoe-profile-session-timeout').value = '';
    }
    document.getElementById('pppoe-profile-rate-preset').value = '';
    if (pppoeProfileError) pppoeProfileError.style.display = 'none';
    if (modalPppoeProfile) modalPppoeProfile.classList.add('active');
}

function closePppoeProfileModal() {
    if (modalPppoeProfile) modalPppoeProfile.classList.remove('active');
}

document.getElementById('btn-add-pppoe-profile')?.addEventListener('click', () => openPppoeProfileModal());
document.querySelectorAll('#modal-pppoe-profile .modal-cancel, #modal-pppoe-profile .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', closePppoeProfileModal);
});

document.getElementById('pppoe-profile-rate-preset')?.addEventListener('change', (e) => {
    if (e.target.value) document.getElementById('pppoe-profile-rate-limit').value = e.target.value;
});

if (formPppoeProfile) {
    formPppoeProfile.addEventListener('submit', async (e) => {
        e.preventDefault();
        const id = document.getElementById('pppoe-profile-id').value;
        const name = document.getElementById('pppoe-profile-name').value;
        const rateLimit = document.getElementById('pppoe-profile-rate-limit').value;
        const localAddress = document.getElementById('pppoe-profile-local-address').value;
        const remoteAddress = document.getElementById('pppoe-profile-remote-address').value;
        const idleTimeout = document.getElementById('pppoe-profile-idle-timeout').value.trim();
        const sessionTimeout = document.getElementById('pppoe-profile-session-timeout').value.trim();

        const body = { name, rateLimit, localAddress, remoteAddress, idleTimeout, sessionTimeout };
        const url = id ? `/api/mikrotik/pppoe/profiles/${id}` : '/api/mikrotik/pppoe/profiles';
        const method = id ? 'PUT' : 'POST';

        try {
            await apiFetch(url, { method, body: JSON.stringify(body) });
            closePppoeProfileModal();
            fetchPppoeProfiles();
        } catch (err) {
            if (pppoeProfileError) {
                pppoeProfileError.textContent = err.message;
                pppoeProfileError.style.display = 'block';
            }
        }
    });
}

// ---- Keepalive Timeout (PPPoE Server, per-site) ----
async function fetchPppoeServerKeepalive() {
    const input = document.getElementById('pppoe-server-keepalive');
    if (!input) return;
    try {
        const settings = await apiFetch('/api/mikrotik/pppoe/server-settings');
        input.value = settings.keepaliveTimeout || '';
        input.placeholder = settings.keepaliveTimeout ? '' : 'ยังไม่พบ PPPoE Server บนไซต์นี้ (ตั้งค่าผ่านสคริปต์ก่อน)';
    } catch (err) {
        input.value = '';
        input.placeholder = 'โหลดค่าไม่สำเร็จ: ' + err.message;
    }
}

document.getElementById('btn-save-pppoe-keepalive')?.addEventListener('click', async () => {
    const input = document.getElementById('pppoe-server-keepalive');
    const errorEl = document.getElementById('pppoe-keepalive-error');
    const keepaliveTimeout = input.value.trim();
    if (!keepaliveTimeout) {
        errorEl.textContent = 'กรุณาระบุค่า Keepalive Timeout';
        errorEl.style.display = 'block';
        return;
    }
    try {
        errorEl.style.display = 'none';
        await apiFetch('/api/mikrotik/pppoe/server-settings', {
            method: 'PUT',
            body: JSON.stringify({ keepaliveTimeout })
        });
        alert('บันทึกค่า Keepalive Timeout เรียบร้อยแล้ว');
    } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
    }
});

// ---- TAB: Usage / Billing ----
async function fetchPppoeBilling(month) {
    const monthInput = document.getElementById('pppoe-billing-month');
    if (!month) {
        month = monthInput && monthInput.value ? monthInput.value : new Date().toISOString().slice(0, 7);
    }
    if (monthInput && !monthInput.value) monthInput.value = month;

    const tbody = document.querySelector('#table-pppoe-billing tbody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin"></i> กำลังโหลด...</td></tr>';

    try {
        const siteParams = new URLSearchParams({ month });
        const siteName = getCurrentSiteName();
        if (siteName) siteParams.set('site', siteName);
        const result = await apiFetch(`/api/pppoe-usage?${siteParams}`);
        if (!tbody) return;

        const exportLink = document.getElementById('btn-export-pppoe-log');
        if (exportLink) {
            const exportParams = new URLSearchParams();
            if (siteName) exportParams.set('site', siteName);
            exportLink.href = `/api/pppoe-usage/export-csv?${exportParams}`;
        }
        tbody.innerHTML = '';
        const rooms = (result.rooms || []).sort((a, b) => (b.bytesIn + b.bytesOut) - (a.bytesIn + a.bytesOut));
        if (rooms.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">ไม่มีข้อมูลการใช้งานในเดือนนี้</td></tr>';
            return;
        }
        rooms.forEach(r => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${r.username}</strong></td>
                <td>${formatBytes(r.bytesIn)}</td>
                <td>${formatBytes(r.bytesOut)}</td>
                <td><strong>${formatBytes(r.bytesIn + r.bytesOut)}</strong></td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="text-center text-danger">ผิดพลาด: ${err.message}</td></tr>`;
    }
}

document.getElementById('pppoe-billing-month')?.addEventListener('change', (e) => fetchPppoeBilling(e.target.value));

// ---- PPPoE Server Setup Script Modal ----
const modalPppoeScript = document.getElementById('modal-pppoe-script');

document.getElementById('btn-pppoe-setup-script')?.addEventListener('click', () => {
    document.getElementById('pppoe-script-result-box').style.display = 'none';
    document.getElementById('pppoe-script-error').style.display = 'none';
    if (modalPppoeScript) modalPppoeScript.classList.add('active');
});

document.querySelectorAll('#modal-pppoe-script .modal-cancel, #modal-pppoe-script .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', () => { if (modalPppoeScript) modalPppoeScript.classList.remove('active'); });
});

document.getElementById('btn-generate-pppoe-script')?.addEventListener('click', async () => {
    const interfaceName = document.getElementById('pppoe-script-interface').value.trim();
    const vlanId = document.getElementById('pppoe-script-vlan').value.trim();
    const poolStart = document.getElementById('pppoe-script-pool-start').value.trim();
    const poolEnd = document.getElementById('pppoe-script-pool-end').value.trim();
    const serverAddress = document.getElementById('pppoe-script-server-address').value.trim();
    const keepaliveTimeout = document.getElementById('pppoe-script-keepalive').value.trim();
    const errorEl = document.getElementById('pppoe-script-error');

    if (!interfaceName || !poolStart || !poolEnd || !serverAddress) {
        errorEl.textContent = 'กรุณากรอกข้อมูลที่จำเป็น (Interface, IP Pool, Server Address) ให้ครบ';
        errorEl.style.display = 'block';
        return;
    }

    try {
        errorEl.style.display = 'none';
        const res = await apiFetch('/api/mikrotik/pppoe/generate-script', {
            method: 'POST',
            body: JSON.stringify({ interfaceName, vlanId: vlanId || undefined, poolStart, poolEnd, serverAddress, keepaliveTimeout: keepaliveTimeout || undefined })
        });
        document.getElementById('pppoe-script-textarea').value = res.script;
        document.getElementById('pppoe-script-result-box').style.display = 'block';
    } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
    }
});

document.getElementById('btn-copy-pppoe-script')?.addEventListener('click', () => {
    const textarea = document.getElementById('pppoe-script-textarea');
    textarea.select();
    document.execCommand('copy');
    alert('คัดลอกสคริปต์เรียบร้อยแล้ว! นำไปวางใน WinBox Terminal ได้เลย');
});


// Add/Edit Hotspot Account Modal Actions
const modalHotspot = document.getElementById('modal-hotspot');
const formHotspotUser = document.getElementById('form-hotspot-user');
const hotspotError = document.getElementById('hotspot-error');
let renewModeManuallyChanged = false;

// รู้ทันพนักงาน: ถ้าแก้ไข Uptime Limit ของ Username เดิม (=กำลังต่ออายุ/เติมเงิน)
// แต่ลืมเลือก dropdown "ต่ออายุ" ด้านล่าง ระบบจะเลือก "รีเซ็ตเวลาใช้งานสะสม" ให้อัตโนมัติ
// ป้องกันปัญหาลูกค้าเจอ "reached uptime limit" ทันทีหลังเติมเงิน เพราะเวลาที่สะสมไว้เดิม
// ไม่ได้ถูกล้างค่า (ยังเลือกตัวเลือกอื่นเองได้ตามปกติ ถ้าเลือกเอง ระบบจะไม่เขียนทับอีก)
document.getElementById('hotspot-limit-uptime').addEventListener('input', (e) => {
    const id = document.getElementById('hotspot-user-id').value;
    if (!id || renewModeManuallyChanged) return;
    const renewMode = document.getElementById('hotspot-renew-mode');
    const hint = document.getElementById('hotspot-renew-auto-hint');
    const changed = e.target.value !== (e.target.dataset.original || '');
    renewMode.value = changed ? 'reset' : '';
    hint.style.display = changed ? 'block' : 'none';
});

document.getElementById('hotspot-renew-mode').addEventListener('change', () => {
    renewModeManuallyChanged = true;
    document.getElementById('hotspot-renew-auto-hint').style.display = 'none';
});

function openHotspotModal(item = null) {
    fetchProfilesToDropdown();
    const renewWrapper = document.getElementById('hotspot-renew-wrapper');
    const renewMode = document.getElementById('hotspot-renew-mode');

    if (item) {
        document.getElementById('hotspot-modal-title').textContent = 'แก้ไขบัญชีผู้ใช้ Hotspot';
        document.getElementById('hotspot-user-id').value = item.id;
        document.getElementById('hotspot-name').value = item.name;
        document.getElementById('hotspot-name').readOnly = true; // RouterOS does not allow renaming easily
        document.getElementById('hotspot-password').value = item.password || '';
        document.getElementById('hotspot-profile').value = item.profile;
        const originalLimitUptime = item.limitUptime === '00:00:00' ? '' : item.limitUptime;
        document.getElementById('hotspot-limit-uptime').value = originalLimitUptime;
        document.getElementById('hotspot-limit-uptime').dataset.original = originalLimitUptime;
        document.getElementById('hotspot-limit-bytes').value = item.limitBytesTotal === 0 ? '' : item.limitBytesTotal;
        document.getElementById('hotspot-comment').value = item.comment || '';
        renewMode.value = '';
        renewModeManuallyChanged = false;
        document.getElementById('hotspot-renew-auto-hint').style.display = 'none';
        renewWrapper.style.display = 'block';
    } else {
        document.getElementById('hotspot-modal-title').textContent = 'เพิ่มผู้ใช้ Hotspot ใหม่';
        document.getElementById('hotspot-user-id').value = '';
        document.getElementById('hotspot-name').value = '';
        document.getElementById('hotspot-name').readOnly = false;
        document.getElementById('hotspot-password').value = '';
        document.getElementById('hotspot-profile').value = 'default';
        document.getElementById('hotspot-limit-uptime').value = '';
        document.getElementById('hotspot-limit-uptime').dataset.original = '';
        document.getElementById('hotspot-limit-bytes').value = '';
        document.getElementById('hotspot-comment').value = '';
        renewMode.value = '';
        renewModeManuallyChanged = false;
        renewWrapper.style.display = 'none';
    }

    hotspotError.style.display = 'none';
    modalHotspot.classList.add('active');
}

function closeHotspotModal() {
    modalHotspot.classList.remove('active');
}

// Modal cancel/close clicks
document.querySelectorAll('#modal-hotspot .modal-cancel, #modal-hotspot .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', closeHotspotModal);
});

document.getElementById('btn-add-hotspot-user').addEventListener('click', () => openHotspotModal());

formHotspotUser.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('hotspot-user-id').value;
    const name = document.getElementById('hotspot-name').value;
    const password = document.getElementById('hotspot-password').value;
    const profile = document.getElementById('hotspot-profile').value;
    const limitUptime = document.getElementById('hotspot-limit-uptime').value;
    const limitBytesTotal = document.getElementById('hotspot-limit-bytes').value;
    const comment = document.getElementById('hotspot-comment').value;
    const renewMode = id ? document.getElementById('hotspot-renew-mode').value : '';

    const body = {
        name,
        password,
        profile,
        limitUptime: limitUptime || undefined,
        limitBytesTotal: limitBytesTotal ? parseInt(limitBytesTotal) : undefined,
        comment,
        resetCounters: renewMode === 'reset',
        recreate: renewMode === 'recreate'
    };

    const url = id ? `/api/mikrotik/hotspot/users/${id}` : '/api/mikrotik/hotspot/users';
    const method = id ? 'PUT' : 'POST';

    try {
        await apiFetch(url, {
            method,
            body: JSON.stringify(body)
        });
        closeHotspotModal();
        fetchHotspotAccounts();
    } catch (err) {
        hotspotError.textContent = err.message;
        hotspotError.style.display = 'block';
    }
});

// RouterOS v7 Hardened Security Preset Actions
document.getElementById('btn-apply-security-hardening')?.addEventListener('click', async () => {
    if (!confirm('ยืนยันบังคับใช้เกราะป้องกันความปลอดภัย RouterOS v7+ บนเราท์เตอร์ใช่หรือไม่?\n\nระบบจะเพิ่มกฎบล็อก Brute-force WinBox/SSH (8291, 22), บล็อก DNS Amplification Attack และบล็อก Invalid Packets')) return;
    const btn = document.getElementById('btn-apply-security-hardening');
    try {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังส่งคำสั่งไปยังราวเตอร์...';
        const res = await apiFetch('/api/mikrotik/firewall/apply-security-hardening', { method: 'POST' });
        alert(res.message || 'เปิดใช้งานเกราะป้องกันความปลอดภัยสำเร็จ');
    } catch (err) {
        alert('เกิดข้อผิดพลาด: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-bolt"></i> เปิดใช้งานเกราะป้องกันทันที';
    }
});

document.getElementById('btn-show-security-script')?.addEventListener('click', async () => {
    const modal = document.getElementById('modal-security-script');
    const textarea = document.getElementById('security-script-textarea');
    try {
        const res = await apiFetch('/api/mikrotik/firewall/generate-security-script', { method: 'POST' });
        if (res.script && textarea) {
            textarea.value = res.script;
            if (modal) modal.classList.add('active');
        }
    } catch (err) {
        alert('เกิดข้อผิดพลาดในการสร้างสคริปต์: ' + err.message);
    }
});

document.getElementById('btn-copy-security-script')?.addEventListener('click', () => {
    const textarea = document.getElementById('security-script-textarea');
    if (textarea && textarea.value) {
        navigator.clipboard.writeText(textarea.value).then(() => {
            alert('คัดลอกสคริปต์ RouterOS Security เรียบร้อยแล้ว! นำไปวางใน WinBox -> Terminal ได้ทันที');
        }).catch(() => {
            textarea.select();
            document.execCommand('copy');
            alert('คัดลอกสคริปต์เรียบร้อยแล้ว!');
        });
    }
});

document.querySelectorAll('#modal-security-script .modal-cancel, #modal-security-script .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.getElementById('modal-security-script')?.classList.remove('active');
    });
});

// ==========================================
// Router Operations & System Maintenance Handlers
// ==========================================

// 1. Check & Install RouterOS Update
async function triggerCheckRosUpdateModal() {
    const modal = document.getElementById('modal-ros-update');
    const loading = document.getElementById('ros-update-loading');
    const content = document.getElementById('ros-update-content');
    const installBtn = document.getElementById('btn-confirm-ros-install');

    if (modal) modal.classList.add('active');
    if (loading) loading.style.display = 'block';
    if (content) content.style.display = 'none';
    if (installBtn) installBtn.style.display = 'none';

    try {
        const update = await apiFetch('/api/mikrotik/system/update-check');
        document.getElementById('ros-update-channel').textContent = update.channel || 'stable';
        document.getElementById('ros-update-installed').textContent = update.installedVersion || '-';
        document.getElementById('ros-update-latest').textContent = update.latestVersion || '-';
        document.getElementById('ros-update-status').textContent = update.status || '-';

        const isNewAvailable = update.latestVersion && update.installedVersion && update.latestVersion !== update.installedVersion && update.latestVersion !== 'N/A';
        if (installBtn && isNewAvailable) {
            installBtn.style.display = 'inline-flex';
        }

        if (loading) loading.style.display = 'none';
        if (content) content.style.display = 'block';
    } catch (err) {
        if (loading) loading.style.display = 'none';
        alert('เกิดข้อผิดพลาดในการตรวจสอบอัปเดต: ' + err.message);
        if (modal) modal.classList.remove('active');
    }
}

document.getElementById('btn-check-ros-update')?.addEventListener('click', triggerCheckRosUpdateModal);
document.getElementById('btn-quick-ros-update')?.addEventListener('click', (e) => {
    e.stopPropagation();
    openFullUpgradeModal();
});
document.getElementById('stat-card-ros-version')?.addEventListener('click', () => {
    if (CURRENT_USER && (CURRENT_USER.role === 'admin' || CURRENT_USER.role === 'co-admin')) {
        openFullUpgradeModal();
    }
});

document.getElementById('btn-confirm-ros-install')?.addEventListener('click', async () => {
    if (!confirm('⚠️ คุณแน่ใจหรือไม่ว่าต้องการดาวน์โหลดและติดตั้ง RouterOS เวอร์ชันใหม่ทันที?\n\nเราท์เตอร์จะทำการ Reboot อัตโนมัติและอาจตัดการเชื่อมต่อชั่วคราวประมาณ 1-2 นาที')) return;

    const btn = document.getElementById('btn-confirm-ros-install');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังสั่งติดตั้ง...';

    try {
        const res = await apiFetch('/api/mikrotik/system/update-install', { method: 'POST' });
        alert(res.message || 'สั่งติดตั้ง RouterOS เรียบร้อยแล้ว ระบบกำลังเริ่มต้นใหม่');
        document.getElementById('modal-ros-update')?.classList.remove('active');
    } catch (err) {
        alert('เกิดข้อผิดพลาดในการสั่งติดตั้ง: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-download"></i> ดาวน์โหลดและติดตั้งทันที';
    }
});

// ==========================================
// 1-Click Automated Full Upgrade Workflow (ROS + Firmware)
// ==========================================
function setUgStepStatus(stepNum, status, descText) {
    const stepEl = document.getElementById(`ug-step-${stepNum}`);
    if (!stepEl) return;
    const iconEl = stepEl.querySelector('.ug-step-icon');
    const descEl = stepEl.querySelector('.ug-step-desc');

    if (descEl && descText) descEl.textContent = descText;

    if (status === 'active') {
        stepEl.style.background = '#eff6ff';
        stepEl.style.borderColor = '#93c5fd';
        if (iconEl) {
            iconEl.style.background = '#2563eb';
            iconEl.style.color = '#fff';
            iconEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        }
    } else if (status === 'done') {
        stepEl.style.background = '#f0fdf4';
        stepEl.style.borderColor = '#86efac';
        if (iconEl) {
            iconEl.style.background = '#16a34a';
            iconEl.style.color = '#fff';
            iconEl.innerHTML = '<i class="fa-solid fa-check"></i>';
        }
    } else if (status === 'error') {
        stepEl.style.background = '#fef2f2';
        stepEl.style.borderColor = '#fca5a5';
        if (iconEl) {
            iconEl.style.background = '#dc2626';
            iconEl.style.color = '#fff';
            iconEl.innerHTML = '<i class="fa-solid fa-xmark"></i>';
        }
    } else {
        stepEl.style.background = '#f8fafc';
        stepEl.style.borderColor = '#e2e8f0';
        if (iconEl) {
            iconEl.style.background = '#e2e8f0';
            iconEl.style.color = '#64748b';
            iconEl.innerHTML = `${stepNum}`;
        }
    }
}

async function pollUntilRouterOnline(maxWaitSec = 120, progressCallback) {
    const startTime = Date.now();
    let elapsed = 0;
    
    // Initial sleep 15s to allow router to begin shutting down
    await new Promise(r => setTimeout(r, 15000));

    while (elapsed < maxWaitSec) {
        elapsed = Math.round((Date.now() - startTime) / 1000);
        if (progressCallback) progressCallback(elapsed);
        try {
            const status = await apiFetch('/api/mikrotik/status');
            if (status && status.version && status.version !== 'N/A') {
                return status;
            }
        } catch (_) {}
        await new Promise(r => setTimeout(r, 4000));
    }
    throw new Error('หมดเวลาการรอคอย เราท์เตอร์ยังไม่ตอบกลับ API (กรุณาตรวจเช็คที่หน้างาน)');
}

function openFullUpgradeModal() {
    const modal = document.getElementById('modal-full-upgrade');
    if (!modal) {
        alert('ไม่พบหน้าต่างอัปเกรดระบบ กรุณารีเฟรชหน้าเว็บ');
        return;
    }

    [1, 2, 3, 4].forEach(i => setUgStepStatus(i, 'waiting', ['รอเริ่มคำสั่ง...', 'รอการเริ่มต้นใหม่...', 'รอการตรวจสอบ Firmware...', 'รอเสร็จสิ้น...'][i-1]));
    const startBtn = document.getElementById('btn-start-full-upgrade');
    if (startBtn) {
        startBtn.disabled = false;
        startBtn.style.display = 'inline-flex';
        startBtn.innerHTML = '<i class="fa-solid fa-play"></i> เริ่มอัปเกรดเต็มรูปแบบทันที';
    }
    const cancelBtn = document.getElementById('btn-cancel-full-upgrade');
    if (cancelBtn) cancelBtn.disabled = false;

    modal.classList.add('active');
    modal.style.setProperty('display', 'flex', 'important');
    modal.style.setProperty('opacity', '1', 'important');
    modal.style.setProperty('pointer-events', 'auto', 'important');
    modal.style.setProperty('z-index', '99999', 'important');
}
window.openFullUpgradeModal = openFullUpgradeModal;

function closeFullUpgradeModal() {
    const modal = document.getElementById('modal-full-upgrade');
    if (modal) {
        modal.classList.remove('active');
        modal.style.setProperty('display', 'none', 'important');
        modal.style.setProperty('opacity', '0', 'important');
        modal.style.setProperty('pointer-events', 'none', 'important');
    }
}
window.closeFullUpgradeModal = closeFullUpgradeModal;

document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action="open-full-upgrade"], .btn-quick-ros-update, #btn-full-system-upgrade, #btn-full-system-upgrade-settings');
    if (target) {
        e.preventDefault();
        e.stopPropagation();
        openFullUpgradeModal();
    }
});

document.getElementById('btn-start-full-upgrade')?.addEventListener('click', async () => {
    const startBtn = document.getElementById('btn-start-full-upgrade');
    const cancelBtn = document.getElementById('btn-cancel-full-upgrade');
    if (startBtn) startBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;

    try {
        // Stage 1: Trigger RouterOS Package Download & Install
        setUgStepStatus(1, 'active', 'กำลังส่งคำสั่งดาวน์โหลดและติดตั้ง RouterOS Packages...');
        await apiFetch('/api/mikrotik/system/update-install', { method: 'POST' });
        setUgStepStatus(1, 'done', 'ติดตั้ง RouterOS สำเร็จแล้ว เราท์เตอร์กำลัง Reboot');

        // Stage 2: Wait for Router to Reboot into new ROS
        setUgStepStatus(2, 'active', 'เราท์เตอร์กำลังเริ่มต้นใหม่ (Rebooting)... กรุณารอสักครู่');
        const rosStatus = await pollUntilRouterOnline(120, (sec) => {
            setUgStepStatus(2, 'active', `กำลังรอเราท์เตอร์รีบูตเข้า RouterOS ใหม่... (${sec} วินาที)`);
        });
        setUgStepStatus(2, 'done', `ออนไลน์แล้ว! RouterOS เวอร์ชันใหม่: v${rosStatus.version}`);

        // Stage 3: Upgrade RouterBOARD Firmware
        setUgStepStatus(3, 'active', 'กำลังสั่งอัปเกรด RouterBOARD Firmware...');
        await new Promise(r => setTimeout(r, 2000));
        await apiFetch('/api/mikrotik/system/full-upgrade-stage2', { method: 'POST' });
        setUgStepStatus(3, 'done', 'สั่งอัปเกรด Firmware สำเร็จแล้ว เราท์เตอร์กำลัง Reboot ครั้งสุดท้าย');

        // Stage 4: Wait for Final Reboot
        setUgStepStatus(4, 'active', 'กำลังรอการรีบูตรอบสุดท้ายเพื่อให้ Firmware ใหม่มีผล...');
        const finalStatus = await pollUntilRouterOnline(90, (sec) => {
            setUgStepStatus(4, 'active', `กำลังรอรีบูตครั้งสุดท้าย... (${sec} วินาที)`);
        });
        setUgStepStatus(4, 'done', `🎉 เสร็จสมบูรณ์ 100%! Firmware: ${finalStatus.currentFirmware || finalStatus.version}`);

        fetchSystemStatus();
        alert('🎉 อัปเกรดระบบเต็มรูปแบบสำเร็จสมบูรณ์ทั้ง RouterOS และ Firmware เรียบร้อยแล้วครับ!');
    } catch (err) {
        alert('เกิดข้อผิดพลาดระหว่างการอัปเกรด: ' + err.message);
    } finally {
        if (cancelBtn) cancelBtn.disabled = false;
        if (startBtn) startBtn.style.display = 'none';
    }
});

document.querySelectorAll('#modal-full-upgrade .modal-cancel, #modal-full-upgrade .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', closeFullUpgradeModal);
});

// 2. Upgrade RouterBOARD Firmware
document.getElementById('btn-upgrade-firmware')?.addEventListener('click', async () => {
    if (!confirm('คุณต้องการสั่งอัปเกรด RouterBOARD Firmware ของบอร์ดหรือไม่?\n\n(หลังจากสั่งอัปเกรดสำเร็จ จะต้องทำการรีบูตเราท์เตอร์ 1 ครั้ง เพื่อให้ Firmware ตัวใหม่เริ่มทำงาน)')) return;

    const btn = document.getElementById('btn-upgrade-firmware');
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังอัปเกรด...';

    try {
        const res = await apiFetch('/api/mikrotik/system/firmware-upgrade', { method: 'POST' });
        if (confirm(`${res.message}\n\nคุณต้องการสั่งรีบูตเราท์เตอร์ตอนนี้เลยหรือไม่?`)) {
            await apiFetch('/api/mikrotik/system/reboot', { method: 'POST' });
            alert('สั่งรีบูตเราท์เตอร์เรียบร้อยแล้ว กรุณารอสักครู่ (30-60 วินาที)');
        }
        fetchSystemStatus();
    } catch (err) {
        alert('เกิดข้อผิดพลาด: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-bolt text-warning"></i> <span>อัปเกรด Firmware บอร์ด</span>';
    }
});

// 3. Reboot Router (Bound to both Overview and Settings panels)
document.querySelectorAll('.btn-system-reboot, #btn-system-reboot, #btn-system-reboot-settings').forEach(btnEl => {
    btnEl.addEventListener('click', async (e) => {
        e.preventDefault();
        const siteName = getCurrentSiteName() || 'เราท์เตอร์ปัจจุบัน';
        if (!confirm(`⚠️ คำเตือน: คุณต้องการรีบูตเราท์เตอร์ "${siteName}" ทันทีใช่หรือไม่?\n\nการเชื่อมต่ออินเทอร์เน็ตและบริการทั้งหมดในสาขานี้จะหยุดชั่วคราวประมาณ 30-60 วินาที`)) return;

        const allRebootBtns = document.querySelectorAll('.btn-system-reboot, #btn-system-reboot, #btn-system-reboot-settings');
        allRebootBtns.forEach(b => {
            b.disabled = true;
            b.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังสั่งรีบูต...';
        });

        try {
            const res = await apiFetch('/api/mikrotik/system/reboot', { method: 'POST' });
            alert(res.message || `สั่งรีบูตเราท์เตอร์ "${siteName}" เรียบร้อยแล้ว`);
        } catch (err) {
            alert('สั่งรีบูต: ' + (err.message || 'ส่งคำสั่งเรียบร้อยแล้ว'));
        } finally {
            allRebootBtns.forEach(b => {
                b.disabled = false;
                b.innerHTML = '<i class="fa-solid fa-power-off text-danger"></i> <span>🔄 รีบูตเราท์เตอร์ (Reboot)</span>';
            });
        }
    });
});

// 4. Flush DNS Cache (Bound to both Overview and Settings panels)
document.querySelectorAll('.btn-flush-dns, #btn-flush-dns, #btn-flush-dns-settings').forEach(btnEl => {
    btnEl.addEventListener('click', async (e) => {
        e.preventDefault();
        const allFlushBtns = document.querySelectorAll('.btn-flush-dns, #btn-flush-dns, #btn-flush-dns-settings');
        allFlushBtns.forEach(b => {
            b.disabled = true;
            b.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังล้าง...';
        });

        try {
            const res = await apiFetch('/api/mikrotik/system/flush-dns', { method: 'POST' });
            alert(res.message || 'ล้าง DNS Cache บนเราท์เตอร์เรียบร้อยแล้ว');
        } catch (err) {
            alert('เกิดข้อผิดพลาด: ' + err.message);
        } finally {
            allFlushBtns.forEach(b => {
                b.disabled = false;
                b.innerHTML = '<i class="fa-solid fa-broom text-secondary"></i> <span>🧹 ล้าง DNS Cache</span>';
            });
        }
    });
});

// 5. Ping Test
document.getElementById('btn-ping-test')?.addEventListener('click', () => {
    const modal = document.getElementById('modal-ping-test');
    if (modal) modal.classList.add('active');
});

document.getElementById('btn-run-ping-now')?.addEventListener('click', async () => {
    const hostInput = document.getElementById('ping-host-input');
    const host = (hostInput ? hostInput.value : '8.8.8.8').trim() || '8.8.8.8';
    const box = document.getElementById('ping-results-box');
    const btn = document.getElementById('btn-run-ping-now');

    if (box) box.textContent = `กำลังส่งคำสั่ง Ping ไปยัง ${host} จากเราท์เตอร์ MikroTik (โปรดรอสักครู่)...`;
    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลัง Ping...';

    try {
        const res = await apiFetch('/api/mikrotik/system/ping-test', {
            method: 'POST',
            body: JSON.stringify({ host, count: 4 })
        });

        if (box) {
            let output = `--- PING ${res.host} STATS ---\n`;
            if (res.results && res.results.length > 0) {
                res.results.forEach((p, idx) => {
                    output += `Seq ${idx + 1}: Host=${p.host || res.host}, Size=${p.size || '56'}b, TTL=${p.ttl || 'N/A'}, Time=${p.time || 'N/A'}, Status=${p.status || 'OK'}\n`;
                });
                const packetLoss = res.results.filter(p => p.status === 'timeout').length;
                output += `\nสรุปผล: ส่ง ${res.results.length} แพ็กเก็ต, สูญหาย ${packetLoss} (${Math.round((packetLoss / res.results.length) * 100)}% loss)`;
            } else {
                output += 'ไม่ได้รับข้อมูลตอบกลับจากเราท์เตอร์';
            }
            box.textContent = output;
        }
    } catch (err) {
        if (box) box.textContent = `เกิดข้อผิดพลาดในการ Ping: ${err.message}`;
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-play"></i> เริ่มทดสอบ';
    }
});

// 6. Quick Backup (.backup) (Bound to both Overview and Settings panels)
document.querySelectorAll('.btn-system-backup, #btn-system-backup, #btn-system-backup-settings').forEach(btnEl => {
    btnEl.addEventListener('click', async (e) => {
        e.preventDefault();
        const today = new Date().toISOString().slice(0, 10);
        const backupName = prompt('ระบุชื่อไฟล์สำรองคอนฟิก (ไม่ต้องใส่นามสกุล .backup):', `backup-${today}`);
        if (!backupName) return;

        const allBackupBtns = document.querySelectorAll('.btn-system-backup, #btn-system-backup, #btn-system-backup-settings');
        allBackupBtns.forEach(b => {
            b.disabled = true;
            b.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังสำรอง...';
        });

        try {
            const res = await apiFetch('/api/mikrotik/system/backup', {
                method: 'POST',
                body: JSON.stringify({ name: backupName })
            });
            alert(res.message || 'สำรองคอนฟิกเราท์เตอร์เรียบร้อยแล้ว');
        } catch (err) {
            alert('เกิดข้อผิดพลาด: ' + err.message);
        } finally {
            allBackupBtns.forEach(b => {
                b.disabled = false;
                b.innerHTML = '<i class="fa-solid fa-floppy-disk text-success"></i> <span>💾 สำรองคอนฟิก (.backup)</span>';
            });
        }
    });
});

// ==========================================
// 6. Network Quality & Ping Jitter Test Handlers
// ==========================================
document.querySelectorAll('.btn-quality-test, #btn-quality-test, #btn-quality-test-settings').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        const modal = document.getElementById('modal-quality-test');
        if (modal) {
            modal.style.display = 'flex';
            modal.classList.add('active');
        }
    });
});

document.getElementById('btn-run-quality-test')?.addEventListener('click', async () => {
    const targetSelect = document.getElementById('select-quality-target');
    const target = targetSelect ? targetSelect.value : '1.1.1.1';
    const btn = document.getElementById('btn-run-quality-test');
    const resultBox = document.getElementById('quality-test-result');

    btn.disabled = true;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังทดสอบแพ็กเก็ต (6 รอบ)...';
    if (resultBox) resultBox.style.display = 'none';

    try {
        const res = await apiFetch('/api/mikrotik/system/quality-test', {
            method: 'POST',
            body: JSON.stringify({ target })
        });

        document.getElementById('quality-score-badge').textContent = `${res.qualityScore} (${res.quality})`;
        document.getElementById('quality-target-desc').textContent = `เป้าหมาย: ${res.target} (${res.count} แพ็กเก็ต)`;
        document.getElementById('quality-avg-ping').textContent = `${res.avgMs} ms`;
        document.getElementById('quality-jitter').textContent = `±${res.jitterMs} ms`;
        document.getElementById('quality-packet-loss').textContent = `${res.packetLoss}`;
        document.getElementById('quality-min-max').textContent = `${res.minMs} / ${res.maxMs} ms`;

        const scoreBox = document.getElementById('quality-score-box');
        if (scoreBox) {
            if (res.qualityScore.startsWith('A')) {
                scoreBox.style.background = '#f0fdf4';
                scoreBox.style.borderColor = '#86efac';
                document.getElementById('quality-score-badge').style.color = '#15803d';
            } else if (res.qualityScore === 'B') {
                scoreBox.style.background = '#fffbeb';
                scoreBox.style.borderColor = '#fde68a';
                document.getElementById('quality-score-badge').style.color = '#b45309';
            } else {
                scoreBox.style.background = '#fef2f2';
                scoreBox.style.borderColor = '#fecaca';
                document.getElementById('quality-score-badge').style.color = '#dc2626';
            }
        }

        if (resultBox) resultBox.style.display = 'block';
    } catch (err) {
        alert('เกิดข้อผิดพลาดในการทดสอบคุณภาพ: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-play"></i> เริ่มทดสอบคุณภาพทันที';
    }
});

document.querySelectorAll('#modal-quality-test .modal-cancel, #modal-quality-test .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.getElementById('modal-quality-test')?.classList.remove('active');
    });
});

// ==========================================
// 7. Global Quick Search (Ctrl + K)
// ==========================================
function openGlobalSearch() {
    const modal = document.getElementById('modal-global-search');
    const input = document.getElementById('input-global-search');
    if (modal) {
        modal.classList.add('active');
        if (input) {
            input.value = '';
            setTimeout(() => input.focus(), 80);
            renderGlobalSearchResults([]);
        }
    }
}

function closeGlobalSearch() {
    document.getElementById('modal-global-search')?.classList.remove('active');
}

document.getElementById('btn-open-global-search')?.addEventListener('click', openGlobalSearch);
document.querySelectorAll('#modal-global-search .modal-cancel, #modal-global-search .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', closeGlobalSearch);
});

// Keyboard shortcut (Ctrl+K or Cmd+K)
window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        const modal = document.getElementById('modal-global-search');
        if (modal?.classList.contains('active')) {
            closeGlobalSearch();
        } else {
            openGlobalSearch();
        }
    }
    if (e.key === 'Escape') {
        closeGlobalSearch();
    }
});

let _searchDebounceTimer = null;
document.getElementById('input-global-search')?.addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(_searchDebounceTimer);

    if (q.length < 2) {
        renderGlobalSearchResults([], 'พิมพ์คำค้นหาอย่างน้อย 2 ตัวอักษรเพื่อค้นหาครอบคลุมทุกสาขา');
        return;
    }

    _searchDebounceTimer = setTimeout(async () => {
        const container = document.getElementById('global-search-results');
        if (container) container.innerHTML = '<div style="text-align:center; padding:20px; color:#64748b;"><i class="fa-solid fa-spinner fa-spin"></i> กำลังค้นหาข้ามทั้ง 4 สาขา...</div>';
        
        try {
            const data = await apiFetch(`/api/search/global?q=${encodeURIComponent(q)}`);
            renderGlobalSearchResults(data.results || [], 'ไม่พบข้อมูลที่ตรงกับคำค้นหา');
        } catch (err) {
            renderGlobalSearchResults([], 'เกิดข้อผิดพลาดในการค้นหา: ' + err.message);
        }
    }, 300);
});

function renderGlobalSearchResults(results, emptyText = 'ไม่พบข้อมูลที่ตรงกับคำค้นหา') {
    const container = document.getElementById('global-search-results');
    if (!container) return;

    if (results.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:30px 10px; color:#94a3b8; font-size:0.9rem;">
                <i class="fa-solid fa-keyboard" style="font-size:1.6rem; margin-bottom:8px; display:block;"></i>
                ${emptyText}
            </div>
        `;
        return;
    }

    container.innerHTML = '';
    results.forEach(item => {
        const itemEl = document.createElement('div');
        itemEl.style.cssText = 'background:#fff; border:1px solid #e2e8f0; border-radius:8px; padding:10px 14px; display:flex; align-items:center; gap:12px; cursor:pointer; transition:all 0.15s ease;';
        itemEl.onmouseenter = () => { itemEl.style.borderColor = '#93c5fd'; itemEl.style.background = '#f0f9ff'; };
        itemEl.onmouseleave = () => { itemEl.style.borderColor = '#e2e8f0'; itemEl.style.background = '#fff'; };

        itemEl.innerHTML = `
            <div style="width:34px; height:34px; border-radius:8px; background:#eff6ff; color:#2563eb; display:flex; align-items:center; justify-content:center; font-size:1rem;">
                <i class="${item.icon}"></i>
            </div>
            <div style="flex:1; min-width:0;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-weight:700; color:#1e293b; font-size:0.9rem;">${item.title}</span>
                    <span style="font-size:0.7rem; color:#64748b; background:#f1f5f9; padding:2px 6px; border-radius:4px;">${item.category}</span>
                </div>
                <div style="font-size:0.78rem; color:#64748b; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${item.subtitle}</div>
            </div>
            <div style="color:#94a3b8; font-size:0.8rem;"><i class="fa-solid fa-arrow-right"></i></div>
        `;

        itemEl.onclick = async () => {
            closeGlobalSearch();
            if (item.siteId) {
                const siteSelect = document.getElementById('select-active-site');
                if (siteSelect && siteSelect.value !== item.siteId) {
                    siteSelect.value = item.siteId;
                    siteSelect.dispatchEvent(new Event('change'));
                }
            }
            if (item.targetPage) {
                const navLink = document.querySelector(`.menu-item[data-target="${item.targetPage}"]`);
                if (navLink) navLink.click();
            }
        };

        container.appendChild(itemEl);
    });
}

// Modal close listeners for new modals
document.querySelectorAll('#modal-ros-update .modal-cancel, #modal-ros-update .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.getElementById('modal-ros-update')?.classList.remove('active');
    });
});

document.querySelectorAll('#modal-ping-test .modal-cancel, #modal-ping-test .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.getElementById('modal-ping-test')?.classList.remove('active');
    });
});

// Voucher Generator Submit Actions
const formGenerator = document.getElementById('form-generator');
const voucherPrintArea = document.getElementById('voucher-print-area');
const voucherResultGrid = document.getElementById('voucher-result-grid');

formGenerator.addEventListener('submit', async (e) => {
    e.preventDefault();
    const prefix = document.getElementById('gen-prefix').value;
    const qty = document.getElementById('gen-qty').value;
    const profile = document.getElementById('gen-profile').value;
    const limitUptime = document.getElementById('gen-limit-uptime').value;
    const limitBytesTotal = document.getElementById('gen-limit-bytes').value;
    
    const siteTitle = document.getElementById('gen-site-title').value || 'HOTSPOT WI-FI';
    const packageName = document.getElementById('gen-package-name').value || `แพ็กเกจ ${profile}`;
    const price = document.getElementById('gen-price').value || '';
    const contact = document.getElementById('gen-contact').value || '';

    const submitBtn = formGenerator.querySelector('button[type="submit"]');
    
    try {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังสร้างคูปอง...';
        
        const res = await apiFetch('/api/mikrotik/hotspot/generate', {
            method: 'POST',
            body: JSON.stringify({
                prefix, qty, profile, limitUptime, limitBytesTotal: limitBytesTotal ? parseInt(limitBytesTotal) : undefined,
                siteTitle, packageName, price, contact
            })
        });
        
        // Render print list
        voucherResultGrid.innerHTML = '';
        
        const limitUptimeLabel = limitUptime ? document.getElementById('gen-limit-uptime').options[document.getElementById('gen-limit-uptime').selectedIndex].text : '';
        const limitBytesLabel = limitBytesTotal ? document.getElementById('gen-limit-bytes').options[document.getElementById('gen-limit-bytes').selectedIndex].text : '';
        const limitText = [limitUptimeLabel, limitBytesLabel].filter(Boolean).join(' / ') || 'ไม่จำกัด';

        res.users.forEach(user => {
            const card = document.createElement('div');
            card.className = 'voucher-card';
            card.innerHTML = `
                <div class="voucher-scissors"><i class="fa-solid fa-scissors"></i></div>
                <div class="voucher-header">
                    <div class="site-brand"><i class="fa-solid fa-wifi"></i> ${user.siteTitle || siteTitle}</div>
                    ${(user.price || price) ? `<div class="price-badge">${user.price || price}</div>` : '<div class="price-badge free">VIP PASS</div>'}
                </div>
                <div class="voucher-pkg-bar">
                    <span class="pkg-name"><i class="fa-solid fa-cube"></i> ${user.packageName || packageName}</span>
                    <span class="pkg-limit">${limitText}</span>
                </div>
                <div class="voucher-body">
                    <div class="voucher-credentials">
                        <div class="voucher-field">
                            <div class="voucher-label">USERNAME</div>
                            <div class="voucher-value">${user.username}</div>
                        </div>
                        <div class="voucher-divider-v"></div>
                        <div class="voucher-field">
                            <div class="voucher-label">PASSWORD</div>
                            <div class="voucher-value pwd">${user.password}</div>
                        </div>
                    </div>
                </div>
                <div class="voucher-footer">
                    <div class="instruction"><span>1. Connect Wi-Fi</span> <span>2. Enter Login Code</span></div>
                    ${(user.contact || contact) ? `<div class="contact-info"><i class="fa-solid fa-headset"></i> ${user.contact || contact}</div>` : ''}
                </div>
            `;
            voucherResultGrid.appendChild(card);
        });
        
        voucherPrintArea.style.display = 'block';
        
        // Scroll down to view vouchers
        voucherPrintArea.scrollIntoView({ behavior: 'smooth' });
    } catch (err) {
        alert(err.message);
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i> สร้างคูปองและเตรียมพิมพ์';
    }
});

// Print vouchers trigger
document.getElementById('btn-print-vouchers').addEventListener('click', () => {
    window.print();
});

// ==========================================
// FIREWALL CONTROLLERS & SCHEDULE MANAGEMENT
// ==========================================

const FW_SERVICES = ['youtube', 'line', 'games', 'ads', 'tiktok', 'facebook', 'adult', 'netflix', 'torrent', 'steam', 'crypto'];

async function fetchFirewallStatus() {
    FW_SERVICES.forEach(svc => {
        const toggle = document.getElementById(`toggle-${svc}`);
        const status = document.getElementById(`status-${svc}`);
        if (toggle) toggle.disabled = true;
        if (status) status.textContent = 'กำลังโหลด...';
    });
    
    try {
        const statusMap = await apiFetch('/api/mikrotik/firewall/status');
        
        FW_SERVICES.forEach(svc => {
            const info = statusMap[svc] || { blocked: false, scheduleEnabled: false, timeStart: '', timeEnd: '', days: [] };
            const toggle = document.getElementById(`toggle-${svc}`);
            const status = document.getElementById(`status-${svc}`);
            const schedEnable = document.querySelector(`.fw-sched-enable[data-service="${svc}"]`);
            const schedControls = document.getElementById(`sched-controls-${svc}`);
            const schedStart = document.querySelector(`.fw-sched-start[data-service="${svc}"]`);
            const schedEnd = document.querySelector(`.fw-sched-end[data-service="${svc}"]`);
            const dayPills = document.querySelectorAll(`.day-pills[data-service="${svc}"] input[type="checkbox"]`);
            
            if (toggle) {
                toggle.checked = info.blocked;
                toggle.disabled = false;
            }
            
            if (status) {
                let statusText = info.blocked ? 'BLOCKED' : 'UNBLOCKED';
                if (info.blocked && info.scheduleEnabled && info.timeStart && info.timeEnd) {
                    statusText += ` (${info.timeStart}-${info.timeEnd})`;
                }
                status.textContent = statusText;
                status.className = 'status-label ' + (info.blocked ? 'blocked' : 'unblocked');
            }

            if (schedEnable) {
                schedEnable.checked = info.scheduleEnabled;
            }
            if (schedControls) {
                schedControls.style.display = info.scheduleEnabled ? 'block' : 'none';
            }
            if (schedStart && info.timeStart) {
                schedStart.value = info.timeStart;
            }
            if (schedEnd && info.timeEnd) {
                schedEnd.value = info.timeEnd;
            }
            if (dayPills && info.days) {
                dayPills.forEach(chk => {
                    chk.checked = info.days.includes(chk.value);
                });
            }
        });
        fetchCustomFirewallRules();
    } catch (err) {
        FW_SERVICES.forEach(svc => {
            const status = document.getElementById(`status-${svc}`);
            if (status) {
                status.textContent = 'ผิดพลาด';
                status.className = 'status-label unblocked';
            }
        });
        console.error('Failed to fetch firewall status:', err);
    }
}

async function fetchCustomFirewallRules() {
    const tbody = document.querySelector('#table-custom-rules tbody');
    if (!tbody) return;
    try {
        const rules = await apiFetch('/api/mikrotik/firewall/custom-rules');
        tbody.innerHTML = '';
        if (rules.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">ยังไม่มีกฎบล็อกกำหนดเอง สามารถระบุชื่อโดเมนด้านบนเพื่อสั่งบล็อกลงเราท์เตอร์ได้ทันที</td></tr>';
            return;
        }
        rules.forEach(rule => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong class="text-danger"><i class="fa-solid fa-ban"></i> ${rule.address}</strong></td>
                <td>${rule.comment || '-'}</td>
                <td><span class="badge badge-danger">DROP (Blocked)</span></td>
                <td class="text-center">
                    <button type="button" class="btn btn-sm btn-outline-danger btn-delete-custom-rule" data-id="${rule.id}"><i class="fa-solid fa-trash"></i></button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-center text-danger">เกิดข้อผิดพลาด: ${err.message}</td></tr>`;
    }
}

const formCustomRule = document.getElementById('form-custom-rule');
if (formCustomRule) {
    formCustomRule.addEventListener('submit', async (e) => {
        e.preventDefault();
        const domain = document.getElementById('custom-domain-input').value;
        const note = document.getElementById('custom-note-input').value;
        try {
            await apiFetch('/api/mikrotik/firewall/custom-rules', {
                method: 'POST',
                body: JSON.stringify({ domain, note })
            });
            document.getElementById('custom-domain-input').value = '';
            document.getElementById('custom-note-input').value = '';
            fetchCustomFirewallRules();
        } catch (err) {
            alert('เกิดข้อผิดพลาด: ' + err.message);
        }
    });
}

async function handleFirewallToggle(service, block) {
    const toggleEl = document.getElementById(`toggle-${service}`);
    const statusEl = document.getElementById(`status-${service}`);
    if (!toggleEl || !statusEl) return;

    toggleEl.disabled = true;
    statusEl.textContent = 'กำลังทำงาน...';
    
    // Get schedule parameters
    const schedEnable = document.querySelector(`.fw-sched-enable[data-service="${service}"]`);
    const schedStart = document.querySelector(`.fw-sched-start[data-service="${service}"]`);
    const schedEnd = document.querySelector(`.fw-sched-end[data-service="${service}"]`);
    const activeDays = Array.from(document.querySelectorAll(`.day-pills[data-service="${service}"] input[type="checkbox"]:checked`)).map(c => c.value);

    const payload = {
        service,
        block,
        scheduleEnabled: schedEnable ? schedEnable.checked : false,
        timeStart: schedStart ? schedStart.value : '',
        timeEnd: schedEnd ? schedEnd.value : '',
        days: activeDays
    };

    try {
        const res = await apiFetch('/api/mikrotik/firewall/toggle', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        
        toggleEl.checked = res.blocked;
        let statusText = res.blocked ? 'BLOCKED' : 'UNBLOCKED';
        if (res.blocked && payload.scheduleEnabled && payload.timeStart && payload.timeEnd) {
            statusText += ` (${payload.timeStart}-${payload.timeEnd})`;
        }
        statusEl.textContent = statusText;
        statusEl.className = 'status-label ' + (res.blocked ? 'blocked' : 'unblocked');
    } catch (err) {
        alert('เกิดข้อผิดพลาด: ' + err.message);
        toggleEl.checked = !block;
        statusEl.textContent = !block ? 'BLOCKED' : 'UNBLOCKED';
        statusEl.className = 'status-label ' + (!block ? 'blocked' : 'unblocked');
    } finally {
        toggleEl.disabled = false;
    }
}

// Bind Schedule Checkbox Toggles & Save Buttons & Custom Rule Deletes
document.addEventListener('change', (e) => {
    if (e.target.classList.contains('fw-sched-enable')) {
        const svc = e.target.getAttribute('data-service');
        const controls = document.getElementById(`sched-controls-${svc}`);
        if (controls) {
            controls.style.display = e.target.checked ? 'block' : 'none';
        }
    }
    if (e.target.id && e.target.id.startsWith('toggle-')) {
        const svc = e.target.getAttribute('data-service');
        if (svc) {
            handleFirewallToggle(svc, e.target.checked);
        }
    }
});

document.addEventListener('click', async (e) => {
    const saveBtn = e.target.closest('.btn-save-schedule');
    if (saveBtn) {
        const svc = saveBtn.getAttribute('data-service');
        const toggleEl = document.getElementById(`toggle-${svc}`);
        if (svc && toggleEl) {
            handleFirewallToggle(svc, toggleEl.checked);
        }
    }
    const delBtn = e.target.closest('.btn-delete-custom-rule');
    if (delBtn) {
        const id = delBtn.getAttribute('data-id');
        if (confirm('คุณต้องการลบกฎบล็อกโดเมนนี้ใช่หรือไม่?')) {
            try {
                await apiFetch(`/api/mikrotik/firewall/custom-rules/${id}`, { method: 'DELETE' });
                fetchCustomFirewallRules();
            } catch (err) {
                alert('เกิดข้อผิดพลาด: ' + err.message);
            }
        }
    }
});


// ==========================================
// ADMIN DASHBOARD USER MANAGEMENT
// ==========================================
async function fetchMenuPermissions() {
    const tbody = document.querySelector('#table-menu-permissions tbody');
    if (!tbody) return;

    try {
        const perms = await apiFetch('/api/settings/menu-permissions');
        const coAdminAllowed = perms['co-admin'] || DEFAULT_MENU_PERMISSIONS_FALLBACK['co-admin'];
        const userAllowed = perms['user'] || DEFAULT_MENU_PERMISSIONS_FALLBACK['user'];

        tbody.innerHTML = ALL_CONFIGURABLE_MENUS.map(m => {
            const coAdminChecked = coAdminAllowed.includes(m.key) ? 'checked' : '';
            const userChecked = userAllowed.includes(m.key) ? 'checked' : '';
            return `
                <tr>
                    <td><i class="fa-solid ${m.icon} text-primary" style="width:20px;"></i> <strong>${m.title}</strong></td>
                    <td class="text-center"><input type="checkbox" class="menu-perm-chk" data-menu="${m.key}" data-role="co-admin" ${coAdminChecked}></td>
                    <td class="text-center"><input type="checkbox" class="menu-perm-chk" data-menu="${m.key}" data-role="user" ${userChecked}></td>
                </tr>
            `;
        }).join('');
    } catch (err) {
        console.error('Failed to load menu permissions:', err);
    }
}

document.getElementById('btn-save-menu-permissions')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const body = { 'co-admin': [], 'user': [] };
    document.querySelectorAll('.menu-perm-chk').forEach(chk => {
        if (chk.checked) {
            const menu = chk.getAttribute('data-menu');
            const role = chk.getAttribute('data-role');
            if (body[role]) body[role].push(menu);
        }
    });
    try {
        btn.disabled = true;
        await apiFetch('/api/settings/menu-permissions', { method: 'POST', body: JSON.stringify(body) });
        alert('บันทึกสิทธิ์การมองเห็นเมนูเรียบร้อยแล้ว');
        if (typeof currentUser !== 'undefined' && currentUser && currentUser.role) {
            configureMenuRoles(currentUser.role);
        }
    } catch (err) {
        alert(err.message);
    } finally {
        btn.disabled = false;
    }
});

async function fetchDashboardUsers() {
    try {
        const users = await apiFetch('/api/users');
        const sitesData = currentSitesData.sites ? currentSitesData : await apiFetch('/api/sites');
        const tbody = document.querySelector('#table-admins tbody');
        tbody.innerHTML = '';
        
        users.forEach(item => {
            let siteBadge = '<span class="badge badge-profile"><i class="fa-solid fa-globe"></i> ทุกไซต์งาน</span>';
            if (item.assignedSiteId && item.assignedSiteId !== 'all') {
                const siteObj = sitesData.sites.find(s => s.id === item.assignedSiteId);
                const siteName = siteObj ? siteObj.name : item.assignedSiteId;
                siteBadge = `<span class="badge" style="background-color: rgba(79, 70, 229, 0.1); color: var(--primary); border: 1px solid rgba(79, 70, 229, 0.2);"><i class="fa-solid fa-location-dot"></i> ${siteName}</span>`;
            }

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${item.username}</strong></td>
                <td>${item.name}</td>
                <td><span class="badge badge-${item.role}">${item.role}</span></td>
                <td>${siteBadge}</td>
                <td class="text-center">
                    <div style="display:flex; gap:6px; justify-content:center;">
                        <button class="btn btn-secondary btn-sm btn-edit-admin" data-item='${JSON.stringify(item).replace(/'/g, "&apos;")}'>
                            <i class="fa-solid fa-pen-to-square"></i> แก้ไข
                        </button>
                        <button class="btn btn-danger btn-sm btn-del-admin" data-id="${item.id}" data-user="${item.username}">
                            <i class="fa-solid fa-trash-can"></i> ลบ
                        </button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
        
        // Bind Edit buttons
        document.querySelectorAll('.btn-edit-admin').forEach(btn => {
            btn.addEventListener('click', () => {
                const item = JSON.parse(btn.getAttribute('data-item'));
                openAdminModal(item);
            });
        });
        
        // Bind Delete buttons
        document.querySelectorAll('.btn-del-admin').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-id');
                const username = btn.getAttribute('data-user');
                if (confirm(`คุณยืนยันต้องการลบผู้ใช้งานระบบ "${username}" ใช่หรือไม่?`)) {
                    try {
                        await apiFetch(`/api/users/${id}`, { method: 'DELETE' });
                        fetchDashboardUsers();
                    } catch (err) {
                        alert(err.message);
                    }
                }
            });
        });
    } catch (err) {
        document.querySelector('#table-admins tbody').innerHTML = `<tr><td colspan="5" class="text-center text-danger">ผิดพลาด: ${err.message}</td></tr>`;
    }
}

// Populate assigned site dropdown in Admin Modal
async function populateAdminSitesDropdown(selectedSiteId = 'all') {
    const select = document.getElementById('admin-assigned-site');
    if (!select) return;
    try {
        const sitesData = await apiFetch('/api/sites');
        let options = '<option value="all">ทุกไซต์งาน (All Sites)</option>';
        if (sitesData && sitesData.sites) {
            sitesData.sites.forEach(s => {
                options += `<option value="${s.id}">${s.name} (${s.host})</option>`;
            });
        }
        select.innerHTML = options;
        select.value = selectedSiteId || 'all';
    } catch (e) {
        console.error(e);
    }
}

// Modal actions
const modalAdmin = document.getElementById('modal-admin');
const formAdminUser = document.getElementById('form-admin-user');
const adminError = document.getElementById('admin-error');

function openAdminModal(item = null) {
    populateAdminSitesDropdown(item ? item.assignedSiteId : 'all');

    if (item) {
        document.getElementById('admin-modal-title').textContent = 'แก้ไขข้อมูลผู้ใช้งานระบบ';
        document.getElementById('admin-user-id').value = item.id;
        document.getElementById('admin-name').value = item.name;
        document.getElementById('admin-username').value = item.username;
        document.getElementById('admin-username').readOnly = true;
        document.getElementById('admin-role').value = item.role;
        document.getElementById('admin-password').value = '';
        document.getElementById('admin-password').required = false;
        document.getElementById('admin-pwd-label-hint').style.display = 'none';
        document.getElementById('admin-pwd-help').style.display = 'block';
    } else {
        document.getElementById('admin-modal-title').textContent = 'เพิ่มผู้ใช้งานระบบใหม่';
        document.getElementById('admin-user-id').value = '';
        document.getElementById('admin-name').value = '';
        document.getElementById('admin-username').value = '';
        document.getElementById('admin-username').readOnly = false;
        document.getElementById('admin-role').value = 'user';
        document.getElementById('admin-password').value = '';
        document.getElementById('admin-password').required = true;
        document.getElementById('admin-pwd-label-hint').style.display = 'inline';
        document.getElementById('admin-pwd-help').style.display = 'none';
    }
    
    adminError.style.display = 'none';
    modalAdmin.classList.add('active');
}

function closeAdminModal() {
    modalAdmin.classList.remove('active');
}

document.querySelectorAll('#modal-admin .modal-cancel, #modal-admin .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', closeAdminModal);
});

document.getElementById('btn-add-admin').addEventListener('click', () => openAdminModal());

formAdminUser.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('admin-user-id').value;
    const name = document.getElementById('admin-name').value;
    const username = document.getElementById('admin-username').value;
    const role = document.getElementById('admin-role').value;
    const assignedSiteId = document.getElementById('admin-assigned-site').value;
    const password = document.getElementById('admin-password').value;
    
    const body = { name, username, role, assignedSiteId };
    if (password) body.password = password;
    
    const url = id ? `/api/users/${id}` : '/api/users';
    const method = id ? 'PUT' : 'POST';
    
    try {
        await apiFetch(url, {
            method,
            body: JSON.stringify(body)
        });
        closeAdminModal();
        fetchDashboardUsers();
        
        // If updating oneself and password or permissions changed, forced logout will happen automatically
        if (id === CURRENT_USER.id && (password || role || assignedSiteId !== CURRENT_USER.assignedSiteId)) {
            alert('ข้อมูลบัญชีหรือสิทธิ์การใช้งานของคุณถูกเปลี่ยนแปลง กรุณาเข้าสู่ระบบอีกครั้ง');
            logout();
        }
    } catch (err) {
        adminError.textContent = err.message;
        adminError.style.display = 'block';
    }
});


// ==========================================
// MULTI-SITE MANAGEMENT CONTROLLERS
// ==========================================
async function fetchSitesManagement() {
    const tableBody = document.querySelector('#table-sites tbody');
    if (!tableBody) return;

    tableBody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">กำลังโหลดข้อมูลไซต์งาน...</td></tr>`;
    try {
        const data = await apiFetch('/api/sites');
        currentSitesData = data;

        // Real WireGuard endpoint IP per site (best-effort — only meaningful
        // for admin + WireGuard-connected sites; silently empty otherwise).
        let peersByIp = {};
        try {
            peersByIp = await apiFetch('/api/wireguard/all-peers-status');
        } catch (e) {
            peersByIp = {};
        }

        if (!data.sites || data.sites.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="7" class="text-center text-muted">ยังไม่มีไซต์งานในระบบ</td></tr>`;
            return;
        }

        tableBody.innerHTML = '';
        data.sites.forEach(site => {
            const isActive = site.id === data.activeSiteId;
            const peer = site.wireguardIp ? peersByIp[site.wireguardIp] : null;
            let realIpCell = '<span class="text-muted">-</span>';
            if (site.connectionType === 'wireguard') {
                realIpCell = peer && peer.endpoint
                    ? `<code>${peer.endpoint}</code> ${peer.connected ? '<span style="color:var(--success);font-size:0.75rem;">● Handshake OK</span>' : '<span style="color:var(--text-muted);font-size:0.75rem;">ไม่มี handshake</span>'}`
                    : '<span class="text-muted">ยังไม่เคยเชื่อมต่อ</span>';
            }
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>
                    ${isActive
                        ? `<span class="site-status-badge site-status-active"><i class="fa-solid fa-circle-check"></i> เลือกใช้งานอยู่</span>`
                        : `<span class="site-status-badge" style="background:#f1f5f9; color:#64748b; border:1px solid #e2e8f0;"><i class="fa-regular fa-circle"></i> สแตนด์บาย</span>`}
                </td>
                <td><strong>${site.name}</strong></td>
                <td><code>${site.host}</code></td>
                <td>${site.port}</td>
                <td>
                    <span id="site-conn-badge-${site.id}" class="badge" style="background:#f8fafc; color:#64748b; border:1px solid #cbd5e1; padding:3px 8px; border-radius:12px; font-size:0.75rem;">
                        <i class="fa-solid fa-spinner fa-spin"></i> กำลังตรวจสอบ...
                    </span>
                </td>
                <td style="font-size:0.82rem;">${realIpCell}</td>
                <td class="text-center">
                    <div style="display:flex; gap:6px; justify-content:center;">
                        ${!isActive ? `<button class="btn btn-primary btn-sm btn-switch-site" data-id="${site.id}" title="เลือกใช้งานไซต์นี้"><i class="fa-solid fa-right-to-bracket"></i> เลือกใช้งาน</button>` : ''}
                        <button class="btn btn-info btn-sm btn-test-site-item" data-id="${site.id}" title="ทดสอบเชื่อมต่อ"><i class="fa-solid fa-plug"></i> ทดสอบ</button>
                        <button class="btn btn-secondary btn-sm btn-edit-site-item" data-item='${JSON.stringify(site)}' title="แก้ไข"><i class="fa-solid fa-pen-to-square"></i></button>
                        <button class="btn btn-danger btn-sm btn-del-site-item" data-id="${site.id}" data-name="${site.name}" title="ลบ"><i class="fa-solid fa-trash-can"></i></button>
                    </div>
                </td>
            `;
            tableBody.appendChild(tr);
        });

        // Automatically test real-time connection status for each site
        data.sites.forEach(async (site) => {
            const badgeEl = document.getElementById(`site-conn-badge-${site.id}`);
            if (!badgeEl) return;
            try {
                await apiFetch(`/api/mikrotik/test-connection?siteId=${site.id}`);
                badgeEl.className = 'badge badge-success';
                badgeEl.style.cssText = 'background:#dcfce7; color:#15803d; border:1px solid #86efac; padding:3px 8px; border-radius:12px; font-weight:600; font-size:0.75rem;';
                badgeEl.innerHTML = '<i class="fa-solid fa-circle-check"></i> ออนไลน์ (Online)';
                badgeEl.title = 'เชื่อมต่อเราท์เตอร์สำเร็จ';
            } catch (e) {
                badgeEl.className = 'badge badge-danger';
                badgeEl.style.cssText = 'background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; padding:3px 8px; border-radius:12px; font-weight:600; font-size:0.75rem;';
                badgeEl.innerHTML = '<i class="fa-solid fa-circle-xmark"></i> ออฟไลน์ (Offline)';
                badgeEl.title = e.message || 'ไม่สามารถเชื่อมต่อได้';
            }
        });
        
        // Bind Switch buttons
        document.querySelectorAll('.btn-switch-site').forEach(btn => {
            btn.addEventListener('click', async () => {
                const siteId = btn.getAttribute('data-id');
                try {
                    await apiFetch(`/api/sites/switch/${siteId}`, { method: 'POST' });
                    fetchSites();
                    fetchSitesManagement();
                    startPolling();
                } catch (err) {
                    alert(err.message);
                }
            });
        });

        // Bind Test buttons to open step-by-step diagnostic breakdown
        document.querySelectorAll('.btn-test-site-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const siteId = btn.getAttribute('data-id');
                openSiteDiagnosticModal(siteId);
            });
        });

        // Bind Edit buttons
        document.querySelectorAll('.btn-edit-site-item').forEach(btn => {
            btn.addEventListener('click', () => {
                const item = JSON.parse(btn.getAttribute('data-item'));
                openSiteModal(item);
            });
        });

        // Bind Delete buttons
        document.querySelectorAll('.btn-del-site-item').forEach(btn => {
            btn.addEventListener('click', async () => {
                const siteId = btn.getAttribute('data-id');
                const siteName = btn.getAttribute('data-name');
                if (confirm(`คุณยืนยันต้องการลบไซต์งาน "${siteName}" ใช่หรือไม่?`)) {
                    try {
                        await apiFetch(`/api/sites/${siteId}`, { method: 'DELETE' });
                        fetchSites();
                        fetchSitesManagement();
                    } catch (err) {
                        alert(err.message);
                    }
                }
            });
        });

    } catch (err) {
        tableBody.innerHTML = `<tr><td colspan="7" class="text-center text-danger">ผิดพลาด: ${err.message}</td></tr>`;
    }
}

// Site Deep Diagnostics Modal Controller
let _currentDiagSiteId = null;

async function openSiteDiagnosticModal(siteId) {
    _currentDiagSiteId = siteId;
    const modal = document.getElementById('modal-site-diagnostics');
    const infoEl = document.getElementById('diag-site-info');
    const stepsListEl = document.getElementById('diag-steps-list');

    if (modal) modal.classList.add('active');
    if (infoEl) infoEl.textContent = `กำลังวิเคราะห์ไซต์งาน (${siteId})...`;
    if (stepsListEl) {
        stepsListEl.innerHTML = `
            <div style="text-align:center; padding:30px 0; color:var(--text-muted);">
                <i class="fa-solid fa-spinner fa-spin text-primary" style="font-size:2rem;"></i>
                <p style="margin-top:12px; font-size:0.9rem;">กำลังทดสอบ DNS, WireGuard VPN, พอร์ต TCP และสิทธิ์ RouterOS Login...</p>
            </div>
        `;
    }

    try {
        const data = await apiFetch(`/api/mikrotik/diagnose-site?siteId=${siteId}`);
        if (infoEl && data.site) {
            infoEl.innerHTML = `📍 ไซต์งาน: <strong>${data.site.name || siteId}</strong> (<code>${data.site.host}:${data.site.port}</code>) — ${data.success ? '<span style="color:#15803d; font-weight:700;">🟢 เชื่อมต่อสมบูรณ์ (Online)</span>' : '<span style="color:#b91c1c; font-weight:700;">🔴 ตรวจพบปัญหา (Offline)</span>'}`;
        }

        if (stepsListEl) {
            stepsListEl.innerHTML = '';
            if (data.steps && data.steps.length > 0) {
                data.steps.forEach(step => {
                    const stepDiv = document.createElement('div');
                    let icon = '<i class="fa-solid fa-circle-check" style="color:#16a34a; font-size:1.15rem;"></i>';
                    let bg = '#f0fdf4';
                    let border = '#bbf7d0';
                    let titleColor = '#166534';

                    if (step.status === 'fail') {
                        icon = '<i class="fa-solid fa-circle-xmark" style="color:#dc2626; font-size:1.15rem;"></i>';
                        bg = '#fef2f2';
                        border = '#fecaca';
                        titleColor = '#991b1b';
                    } else if (step.status === 'warn') {
                        icon = '<i class="fa-solid fa-triangle-exclamation" style="color:#d97706; font-size:1.15rem;"></i>';
                        bg = '#fffbeb';
                        border = '#fde68a';
                        titleColor = '#92400e';
                    }

                    stepDiv.style.cssText = `background:${bg}; border:1px solid ${border}; border-radius:8px; padding:10px 14px; display:flex; gap:12px; align-items:flex-start;`;
                    stepDiv.innerHTML = `
                        <div style="margin-top:2px;">${icon}</div>
                        <div style="flex:1;">
                            <div style="font-weight:700; color:${titleColor}; font-size:0.88rem;">${step.step}</div>
                            <div style="font-size:0.82rem; color:#334155; margin-top:3px; word-break:break-word; line-height:1.4;">${step.detail}</div>
                        </div>
                    `;
                    stepsListEl.appendChild(stepDiv);
                });
            }
        }
    } catch (err) {
        if (stepsListEl) {
            stepsListEl.innerHTML = `
                <div style="background:#fef2f2; border:1px solid #fecaca; border-radius:8px; padding:12px; color:#b91c1c;">
                    <strong>เกิดข้อผิดพลาดในการตรวจสอบ:</strong> ${err.message}
                </div>
            `;
        }
    }
}

document.getElementById('btn-re-diagnose')?.addEventListener('click', () => {
    if (_currentDiagSiteId) openSiteDiagnosticModal(_currentDiagSiteId);
});

document.querySelectorAll('#modal-site-diagnostics .modal-cancel, #modal-site-diagnostics .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.getElementById('modal-site-diagnostics')?.classList.remove('active');
    });
});

// Site Modal Handlers
const modalSite = document.getElementById('modal-site');
const formSiteItem = document.getElementById('form-site-item');
const siteError = document.getElementById('site-error');
const modalWgScript = document.getElementById('modal-wg-script');

function getNextWireguardIp() {
    const sites = (currentSitesData && currentSitesData.sites) ? currentSitesData.sites : [];
    const usedLastOctets = new Set();
    
    // Gateway is 10.10.88.1
    usedLastOctets.add(1);
    
    sites.forEach(site => {
        const ip = site.wireguardIp || site.host || '';
        if (ip.startsWith('10.10.88.')) {
            const parts = ip.split('.');
            if (parts.length === 4) {
                const lastOctet = parseInt(parts[3]);
                if (!isNaN(lastOctet)) {
                    usedLastOctets.add(lastOctet);
                }
            }
        }
    });
    
    let nextOctet = 2;
    while (usedLastOctets.has(nextOctet)) {
        nextOctet++;
    }
    
    return `10.10.88.${nextOctet}`;
}

function openSiteModal(item = null) {
    if (item) {
        document.getElementById('site-modal-title').textContent = 'แก้ไขข้อมูลไซต์งาน / เราท์เตอร์';
        document.getElementById('site-id').value = item.id;
        document.getElementById('site-name').value = item.name;
        document.getElementById('site-conn-type').value = item.connectionType || 'wireguard';
        document.getElementById('site-wg-ip').value = item.wireguardIp || '10.10.88.2';
        document.getElementById('site-host').value = item.host;
        document.getElementById('site-port').value = item.port || 8728;
        document.getElementById('site-username').value = item.username;
        document.getElementById('site-password').value = '';
        document.getElementById('site-pwd-help').style.display = item.hasPassword ? 'block' : 'none';
        document.getElementById('site-dns-logging-enabled').checked = item.dnsLoggingEnabled !== false;
    } else {
        const nextIp = getNextWireguardIp();
        document.getElementById('site-modal-title').textContent = 'เพิ่มไซต์งาน / เราท์เตอร์ใหม่';
        document.getElementById('site-id').value = '';
        document.getElementById('site-name').value = '';
        document.getElementById('site-conn-type').value = 'wireguard';
        document.getElementById('site-wg-ip').value = nextIp;
        document.getElementById('site-host').value = nextIp;
        document.getElementById('site-port').value = '8728';
        document.getElementById('site-username').value = 'admin';
        document.getElementById('site-password').value = '';
        document.getElementById('site-pwd-help').style.display = 'none';
        document.getElementById('site-dns-logging-enabled').checked = true;
    }
    siteError.style.display = 'none';
    modalSite.classList.add('active');
}

const siteConnTypeEl = document.getElementById('site-conn-type');
if (siteConnTypeEl) {
    siteConnTypeEl.addEventListener('change', (e) => {
        if (e.target.value === 'wireguard') {
            const wgIp = document.getElementById('site-wg-ip').value || '10.10.88.2';
            document.getElementById('site-host').value = wgIp;
        }
    });
}

const siteWgIpEl = document.getElementById('site-wg-ip');
if (siteWgIpEl) {
    siteWgIpEl.addEventListener('input', (e) => {
        if (document.getElementById('site-conn-type').value === 'wireguard') {
            document.getElementById('site-host').value = e.target.value;
        }
    });
}

function closeSiteModal() {
    modalSite.classList.remove('active');
}

const btnAddSiteEl = document.getElementById('btn-add-site');
if (btnAddSiteEl) {
    btnAddSiteEl.addEventListener('click', () => openSiteModal());
}

document.querySelectorAll('#modal-site .modal-cancel, #modal-site .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', closeSiteModal);
});

formSiteItem.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('site-id').value;
    const name = document.getElementById('site-name').value;
    const connectionType = document.getElementById('site-conn-type').value;
    const wireguardIp = document.getElementById('site-wg-ip').value;
    const host = document.getElementById('site-host').value;
    const port = document.getElementById('site-port').value;
    const username = document.getElementById('site-username').value;
    const password = document.getElementById('site-password').value;
    const dnsLoggingEnabled = document.getElementById('site-dns-logging-enabled').checked;

    const body = { name, host, port, username, connectionType, wireguardIp, dnsLoggingEnabled };
    if (password) body.password = password;

    const url = id ? `/api/sites/${id}` : '/api/sites';
    const method = id ? 'PUT' : 'POST';

    try {
        await apiFetch(url, { method, body: JSON.stringify(body) });
        closeSiteModal();
        fetchSites();
        fetchSitesManagement();
        startPolling();
    } catch (err) {
        siteError.textContent = err.message;
        siteError.style.display = 'block';
    }
});

// WireGuard Script Generator Action
const btnModalGenWg = document.getElementById('btn-modal-gen-wg');
async function generateWgScript(customPubKey = null) {
    const wireguardIp = document.getElementById('site-wg-ip').value || '10.10.88.2';
    const port = document.getElementById('site-port') ? document.getElementById('site-port').value : '8728';
    const wireguardPublicKey = document.getElementById('site-wg-pubkey') ? document.getElementById('site-wg-pubkey').value.trim() : '';
    const clientPublicKey = wireguardPublicKey || (document.getElementById('wg-client-pubkey-input') ? document.getElementById('wg-client-pubkey-input').value.trim() : '');
    const vpsPublicKey = customPubKey !== null ? customPubKey : (document.getElementById('wg-vps-pubkey-input') ? document.getElementById('wg-vps-pubkey-input').value : '');
    try {
        if (btnModalGenWg) {
            btnModalGenWg.disabled = true;
            btnModalGenWg.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังสร้าง...';
        }
        const siteId = document.getElementById('site-id') ? document.getElementById('site-id').value : '';
        const res = await apiFetch('/api/wireguard/generate-script', {
            method: 'POST',
            body: JSON.stringify({ wireguardIp, port, vpsPublicKey, clientPublicKey, siteId: siteId || null })
        });
        document.getElementById('wg-script-textarea').value = res.script;
        const pubKeyInput = document.getElementById('wg-vps-pubkey-input');
        if (pubKeyInput && res.script) {
            const match = res.script.match(/public-key="([^"]+)"/);
            if (match && match[1] && !match[1].includes('<ใส่_PUBLIC_KEY')) {
                pubKeyInput.value = match[1];
            }
        }
        const clientPubKeyInput = document.getElementById('wg-client-pubkey-input');
        if (clientPubKeyInput && clientPublicKey) {
            clientPubKeyInput.value = clientPublicKey;
        }
        modalWgScript.classList.add('active');
        if (res.autoRegistered) {
            setTimeout(() => {
                alert('ลงทะเบียน Peer บน VPS อัตโนมัติเรียบร้อยแล้ว! สามารถนำสคริปต์ไปวางบน MikroTik เพื่อเชื่อมต่อได้ทันที');
            }, 300);
        }
    } catch (err) {
        alert(err.message);
    } finally {
        if (btnModalGenWg) {
            btnModalGenWg.disabled = false;
            btnModalGenWg.innerHTML = '<i class="fa-solid fa-shield-halved"></i> สร้างสคริปต์ WireGuard';
        }
    }
}

if (btnModalGenWg) {
    btnModalGenWg.addEventListener('click', () => generateWgScript());
}

const btnRegenWg = document.getElementById('btn-regen-wg-script');
if (btnRegenWg) {
    btnRegenWg.addEventListener('click', () => {
        const pubKey = document.getElementById('wg-vps-pubkey-input').value.trim();
        generateWgScript(pubKey);
    });
}

document.querySelectorAll('#modal-wg-script .modal-cancel, #modal-wg-script .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', () => modalWgScript.classList.remove('active'));
});

const btnCopyWgScript = document.getElementById('btn-copy-wg-script');
if (btnCopyWgScript) {
    btnCopyWgScript.addEventListener('click', () => {
        const textarea = document.getElementById('wg-script-textarea');
        textarea.select();
        document.execCommand('copy');
        alert('คัดลอกโค้ดสคริปต์ WireGuard เรียบร้อยแล้ว! นำไปวางใน WinBox Terminal ได้เลย');
    });
}

const btnShowInstallScript = document.getElementById('btn-show-install-script');
const btnShowUninstallScript = document.getElementById('btn-show-uninstall-script');

if (btnShowInstallScript) {
    btnShowInstallScript.addEventListener('click', () => {
        btnShowInstallScript.className = 'btn btn-sm btn-primary';
        if (btnShowUninstallScript) btnShowUninstallScript.className = 'btn btn-sm btn-outline-danger';
        generateWgScript();
    });
}

if (btnShowUninstallScript) {
    btnShowUninstallScript.addEventListener('click', async () => {
        if (btnShowInstallScript) btnShowInstallScript.className = 'btn btn-sm btn-outline-primary';
        btnShowUninstallScript.className = 'btn btn-sm btn-danger';
        try {
            const res = await apiFetch('/api/wireguard/generate-uninstall-script', { method: 'POST' });
            document.getElementById('wg-script-textarea').value = res.script;
        } catch (err) {
            alert(err.message);
        }
    });
}

const btnClearVpsPeer = document.getElementById('btn-clear-vps-peer');
if (btnClearVpsPeer) {
    btnClearVpsPeer.addEventListener('click', async () => {
        const wireguardIp = document.getElementById('site-wg-ip').value || '10.10.88.2';
        if (!confirm(`คุณต้องการล้างค่า WireGuard Peer ของ IP ${wireguardIp} บน VPS หรือไม่?`)) return;
        try {
            btnClearVpsPeer.disabled = true;
            btnClearVpsPeer.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังล้างค่า...';
            const res = await apiFetch('/api/wireguard/remove-peer', {
                method: 'POST',
                body: JSON.stringify({ wireguardIp })
            });
            alert(res.message || 'ล้างค่า Peer บน VPS เรียบร้อยแล้ว');
            document.getElementById('wg-client-pubkey-input').value = '';
        } catch (err) {
            alert(err.message);
        } finally {
            btnClearVpsPeer.disabled = false;
            btnClearVpsPeer.innerHTML = '<i class="fa-solid fa-broom"></i> ล้างค่า Peer บน VPS';
        }
    });
}

const btnRegisterPeer = document.getElementById('btn-register-peer');
if (btnRegisterPeer) {
    btnRegisterPeer.addEventListener('click', async () => {
        const clientPublicKey = document.getElementById('wg-client-pubkey-input').value.trim();
        const wireguardIp = document.getElementById('site-wg-ip').value || '10.10.88.2';
        if (!clientPublicKey) {
            alert('กรุณากรอกหรือวาง Public Key ของ MikroTik ก่อนกดบันทึก');
            return;
        }
        try {
            btnRegisterPeer.disabled = true;
            btnRegisterPeer.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังบันทึก...';
            const res = await apiFetch('/api/wireguard/register-peer', {
                method: 'POST',
                body: JSON.stringify({ clientPublicKey, wireguardIp })
            });
            alert(res.message || 'ลงทะเบียน Peer บน VPS สำเร็จแล้ว! MikroTik สามารถเชื่อมต่อและ ping เจอได้ทันที');
            document.getElementById('wg-client-pubkey-input').value = '';
        } catch (err) {
            alert(err.message);
        } finally {
            btnRegisterPeer.disabled = false;
            btnRegisterPeer.innerHTML = '<i class="fa-solid fa-plus-circle"></i> บันทึก Peer บน VPS';
        }
    });
}

// WireGuard public key format check — catches truncated/mis-pasted keys
// (a real base64 key is always 44 chars ending in '='). Doesn't block
// submit since it's just a typo-catcher, not a full validity guarantee.
function isValidWgPublicKey(key) {
    return /^[A-Za-z0-9+/]{43}=$/.test((key || '').trim());
}

const wgClientPubkeyInputEl = document.getElementById('wg-client-pubkey-input');
const wgPubkeyFormatHintEl = document.getElementById('wg-pubkey-format-hint');
if (wgClientPubkeyInputEl && wgPubkeyFormatHintEl) {
    wgClientPubkeyInputEl.addEventListener('input', () => {
        const val = wgClientPubkeyInputEl.value.trim();
        const showHint = val.length > 0 && !isValidWgPublicKey(val);
        wgPubkeyFormatHintEl.style.display = showHint ? 'block' : 'none';
        wgClientPubkeyInputEl.style.borderColor = showHint ? 'var(--danger)' : '#86efac';
    });
}

// Connection status check — reads live handshake state from the VPS wg0 peer
const btnCheckWgStatus = document.getElementById('btn-check-wg-status');
if (btnCheckWgStatus) {
    btnCheckWgStatus.addEventListener('click', async () => {
        const wireguardIp = document.getElementById('site-wg-ip').value || '10.10.88.2';
        const badge = document.getElementById('wg-status-badge');
        try {
            btnCheckWgStatus.disabled = true;
            btnCheckWgStatus.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังเช็ค...';
            const res = await apiFetch(`/api/wireguard/peer-status?wireguardIp=${encodeURIComponent(wireguardIp)}`);
            if (badge) {
                if (res.connected) {
                    badge.innerHTML = `<span style="color:#166534;"><i class="fa-solid fa-circle-check"></i> เชื่อมต่อแล้ว (handshake ${res.lastHandshakeSecondsAgo}s ที่แล้ว)</span>`;
                } else {
                    badge.innerHTML = '<span style="color:var(--danger);"><i class="fa-solid fa-triangle-exclamation"></i> ยังไม่เชื่อมต่อ / ไม่พบ peer</span>';
                }
            }
        } catch (err) {
            if (badge) badge.innerHTML = `<span style="color:var(--danger);">ผิดพลาด: ${err.message}</span>`;
        } finally {
            btnCheckWgStatus.disabled = false;
            btnCheckWgStatus.innerHTML = '<i class="fa-solid fa-rotate"></i> เช็คสถานะการเชื่อมต่อ';
        }
    });
}


// Modal Test Site Connection button handler
const btnModalTestSite = document.getElementById('btn-modal-test-site');
if (btnModalTestSite) {
    btnModalTestSite.addEventListener('click', async () => {
        const siteId = document.getElementById('site-id').value;
        const host = document.getElementById('site-host').value;
        const port = document.getElementById('site-port').value;
        const username = document.getElementById('site-username').value;
        const password = document.getElementById('site-password').value;

        if (!host || !username) {
            siteError.textContent = 'กรุณากรอก IP Address และ Username ก่อนกดทดสอบ';
            siteError.style.display = 'block';
            return;
        }

        btnModalTestSite.disabled = true;
        btnModalTestSite.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังทดสอบ...';
        siteError.style.display = 'none';

        try {
            if (siteId) {
                // Save current edits then test
                await apiFetch(`/api/sites/${siteId}`, {
                    method: 'PUT',
                    body: JSON.stringify({ name: document.getElementById('site-name').value, host, port, username, password: password || undefined })
                });
                await apiFetch(`/api/mikrotik/test-connection?siteId=${siteId}`);
            } else {
                // Create temp site to test or alert
                alert('โปรดบันทึกไซต์งานใหม่ก่อน แล้วกดปุ่มทดสอบในตารางได้ครับ');
                btnModalTestSite.disabled = false;
                btnModalTestSite.innerHTML = '<i class="fa-solid fa-plug"></i> ทดสอบเชื่อมต่อ';
                return;
            }
            alert('ทดสอบสำเร็จ! สามารถเชื่อมต่อเราท์เตอร์ตัวนี้ได้แล้ว');
        } catch (err) {
            siteError.textContent = `เชื่อมต่อล้มเหลว: ${err.message}`;
            siteError.style.display = 'block';
        } finally {
            btnModalTestSite.disabled = false;
            btnModalTestSite.innerHTML = '<i class="fa-solid fa-plug"></i> ทดสอบเชื่อมต่อ';
        }
    });
}

// ==========================================
// SINGLE VOUCHER PRINT MODAL CONTROLLERS
// ==========================================
const modalPrintSingle = document.getElementById('modal-print-single');
const singleVoucherPreviewContainer = document.getElementById('single-voucher-preview-container');

function openSinglePrintModal(user) {
    currentSinglePrintUser = user;
    const activeSiteObj = currentSitesData.sites ? currentSitesData.sites.find(s => s.id === currentSitesData.activeSiteId) : null;
    
    document.getElementById('single-site-title').value = activeSiteObj ? activeSiteObj.name : 'HOTSPOT WI-FI';
    document.getElementById('single-package-name').value = `แพ็กเกจ ${user.profile}`;
    document.getElementById('single-price').value = '';
    document.getElementById('single-contact').value = '';

    updateSingleVoucherPreview();
    modalPrintSingle.classList.add('active');
}

function closeSinglePrintModal() {
    modalPrintSingle.classList.remove('active');
}

document.querySelectorAll('#modal-print-single .modal-cancel, #modal-print-single .modal-close-btn').forEach(btn => {
    btn.addEventListener('click', closeSinglePrintModal);
});

function updateSingleVoucherPreview() {
    if (!currentSinglePrintUser) return;
    const siteTitle = document.getElementById('single-site-title').value || 'HOTSPOT WI-FI';
    const packageName = document.getElementById('single-package-name').value || `แพ็กเกจ ${currentSinglePrintUser.profile}`;
    const price = document.getElementById('single-price').value || '';
    const contact = document.getElementById('single-contact').value || '';

    const limitTimeText = currentSinglePrintUser.limitUptime === '00:00:00' ? '' : currentSinglePrintUser.limitUptime;
    const limitBytesText = currentSinglePrintUser.limitBytesTotal === 0 ? '' : formatBytes(currentSinglePrintUser.limitBytesTotal);
    const limitText = [limitTimeText, limitBytesText].filter(Boolean).join(' / ') || 'ไม่จำกัด';

    singleVoucherPreviewContainer.innerHTML = `
        <div class="voucher-card printable-single-target" style="width: 260px;">
            <div class="voucher-header">
                <div class="site-brand"><i class="fa-solid fa-wifi"></i> ${siteTitle}</div>
                ${price ? `<div class="price-badge">${price}</div>` : ''}
            </div>
            <div class="voucher-body">
                <div class="voucher-field">
                    <div class="voucher-label">Username</div>
                    <div class="voucher-value">${currentSinglePrintUser.name}</div>
                </div>
                <div class="voucher-field">
                    <div class="voucher-label">Password</div>
                    <div class="voucher-value pwd">${currentSinglePrintUser.password || '(ไม่มี)'}</div>
                </div>
            </div>
            <div class="voucher-footer">
                <div class="pkg-name">${packageName} (${limitText})</div>
                ${contact ? `<div class="contact-info">${contact}</div>` : ''}
            </div>
        </div>
    `;
}

['single-site-title', 'single-package-name', 'single-price', 'single-contact'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', updateSingleVoucherPreview);
});

const btnTriggerSinglePrint = document.getElementById('btn-trigger-single-print');
if (btnTriggerSinglePrint) {
    btnTriggerSinglePrint.addEventListener('click', () => {
        // Temporarily put preview card into voucherResultGrid for standard print CSS target
        const cardHTML = singleVoucherPreviewContainer.innerHTML;
        voucherResultGrid.innerHTML = cardHTML;
        voucherPrintArea.style.display = 'block';
        window.print();
    });
}


// ==========================================
// HOTSPOT HEADERS & STATISTICS LOGIC
// ==========================================

async function updateHotspotTabBadges() {
    try {
        const [active, users, profiles] = await Promise.all([
            apiFetch('/api/mikrotik/hotspot/active'),
            apiFetch('/api/mikrotik/hotspot/users'),
            apiFetch('/api/mikrotik/hotspot/profiles')
        ]);
        
        const badgeActive = document.getElementById('badge-hotspot-active');
        if (badgeActive) badgeActive.textContent = active.length;
        
        const badgeAccounts = document.getElementById('badge-hotspot-accounts');
        if (badgeAccounts) badgeAccounts.textContent = users.length;
        
        const badgeProfiles = document.getElementById('badge-hotspot-profiles');
        if (badgeProfiles) badgeProfiles.textContent = profiles.length;
    } catch (err) {
        console.error('Failed to update tab badges:', err);
    }
}

async function fetchHotspotStats() {
    const activeEl = document.getElementById('stat-hotspot-active');
    const accountsEl = document.getElementById('stat-hotspot-accounts');
    const trafficEl = document.getElementById('stat-hotspot-traffic');
    const profilesEl = document.getElementById('stat-hotspot-profiles');
    
    const profileDistEl = document.getElementById('stats-profile-distribution');
    const loginDistEl = document.getElementById('stats-login-distribution');
    const topUsersEl = document.getElementById('stats-top-users');
    
    // Set loading
    if (activeEl) activeEl.textContent = '...';
    if (accountsEl) accountsEl.textContent = '...';
    if (trafficEl) trafficEl.textContent = '...';
    if (profilesEl) profilesEl.textContent = '...';
    
    if (profileDistEl) profileDistEl.innerHTML = '<div class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin"></i> กำลังโหลด...</div>';
    if (loginDistEl) loginDistEl.innerHTML = '<div class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin"></i> กำลังโหลด...</div>';
    if (topUsersEl) topUsersEl.innerHTML = '<div class="text-center text-muted"><i class="fa-solid fa-spinner fa-spin"></i> กำลังโหลด...</div>';
    
    try {
        const [active, users, profiles] = await Promise.all([
            apiFetch('/api/mikrotik/hotspot/active'),
            apiFetch('/api/mikrotik/hotspot/users'),
            apiFetch('/api/mikrotik/hotspot/profiles')
        ]);
        
        // 1. Update summary cards
        if (activeEl) activeEl.textContent = `${active.length} คน`;
        if (accountsEl) accountsEl.textContent = `${users.length} บัญชี`;
        if (profilesEl) profilesEl.textContent = `${profiles.length} โปรไฟล์`;
        
        // Sum traffic of active users
        let totalBytesIn = 0;
        let totalBytesOut = 0;
        active.forEach(item => {
            totalBytesIn += item.bytesIn || 0;
            totalBytesOut += item.bytesOut || 0;
        });
        const totalTrafficBytes = totalBytesIn + totalBytesOut;
        if (trafficEl) trafficEl.textContent = formatBytes(totalTrafficBytes);
        
        // Map user list to access profiles easily
        const userProfilesMap = {};
        users.forEach(u => {
            userProfilesMap[u.name] = u.profile;
        });
        
        // 2. Profile distribution (Active users by Profile)
        const profileCounts = {};
        active.forEach(item => {
            const profileName = userProfilesMap[item.user] || 'default';
            profileCounts[profileName] = (profileCounts[profileName] || 0) + 1;
        });
        
        if (profileDistEl) {
            profileDistEl.innerHTML = '';
            const profileKeys = Object.keys(profileCounts);
            if (profileKeys.length === 0) {
                profileDistEl.innerHTML = '<div class="text-center text-muted">ไม่มีข้อมูลผู้ใช้งานที่กำลังเชื่อมต่อ</div>';
            } else {
                profileKeys.sort((a, b) => profileCounts[b] - profileCounts[a]);
                
                profileKeys.forEach(profileName => {
                    const count = profileCounts[profileName];
                    const percent = Math.round((count / active.length) * 100);
                    
                    const itemHTML = `
                        <div class="distribution-item">
                            <div class="distribution-header">
                                <div class="distribution-label">
                                    <i class="fa-solid fa-id-card text-primary"></i>
                                    <strong>${profileName}</strong>
                                </div>
                                <div class="distribution-value">${count} คน (${percent}%)</div>
                            </div>
                            <div class="distribution-bar-bg">
                                <div class="distribution-bar-fill" style="width: ${percent}%;"></div>
                            </div>
                        </div>
                    `;
                    profileDistEl.insertAdjacentHTML('beforeend', itemHTML);
                });
            }
        }
        
        // 3. Login methods distribution
        const loginCounts = {};
        active.forEach(item => {
            const method = item.loginBy || 'Unknown';
            loginCounts[method] = (loginCounts[method] || 0) + 1;
        });
        
        if (loginDistEl) {
            loginDistEl.innerHTML = '';
            const loginKeys = Object.keys(loginCounts);
            if (loginKeys.length === 0) {
                loginDistEl.innerHTML = '<div class="text-center text-muted">ไม่มีข้อมูลช่องทางการล็อกอิน</div>';
            } else {
                loginKeys.sort((a, b) => loginCounts[b] - loginCounts[a]);
                
                loginKeys.forEach(method => {
                    const count = loginCounts[method];
                    const percent = Math.round((count / active.length) * 100);
                    
                    let barClass = '';
                    if (method.toLowerCase().includes('cookie')) {
                        barClass = 'success';
                    } else if (method.toLowerCase().includes('chap') || method.toLowerCase().includes('http')) {
                        barClass = 'warning';
                    }
                    
                    const itemHTML = `
                        <div class="distribution-item">
                            <div class="distribution-header">
                                <div class="distribution-label">
                                    <i class="fa-solid fa-key text-success"></i>
                                    <strong>${method}</strong>
                                </div>
                                <div class="distribution-value">${count} คน (${percent}%)</div>
                            </div>
                            <div class="distribution-bar-bg">
                                <div class="distribution-bar-fill ${barClass}" style="width: ${percent}%;"></div>
                            </div>
                        </div>
                    `;
                    loginDistEl.insertAdjacentHTML('beforeend', itemHTML);
                });
            }
        }
        
        // 4. Top 5 active consumers by bytes (bytesIn + bytesOut)
        if (topUsersEl) {
            topUsersEl.innerHTML = '';
            if (active.length === 0) {
                topUsersEl.innerHTML = '<div class="text-center text-muted">ไม่มีข้อมูลผู้ใช้งานที่กำลังเชื่อมต่อ</div>';
            } else {
                const activeSorted = [...active].sort((a, b) => {
                    const totalA = (a.bytesIn || 0) + (a.bytesOut || 0);
                    const totalB = (b.bytesIn || 0) + (b.bytesOut || 0);
                    return totalB - totalA;
                });
                
                const top5 = activeSorted.slice(0, 5);
                const maxUserBytes = (top5[0].bytesIn || 0) + (top5[0].bytesOut || 0) || 1;
                
                top5.forEach((item, index) => {
                    const userBytesTotal = (item.bytesIn || 0) + (item.bytesOut || 0);
                    const percentOfMax = Math.round((userBytesTotal / maxUserBytes) * 100);
                    const userProfile = userProfilesMap[item.user] || 'default';
                    
                    let rankBadge = '';
                    if (index === 0) rankBadge = '<i class="fa-solid fa-trophy" style="color: #eab308;"></i>';
                    else if (index === 1) rankBadge = '<i class="fa-solid fa-medal" style="color: #cbd5e1;"></i>';
                    else if (index === 2) rankBadge = '<i class="fa-solid fa-medal" style="color: #b45309;"></i>';
                    else rankBadge = `<span style="font-weight: 700; color: var(--text-muted); width:16px; display:inline-block; text-align:center;">${index + 1}</span>`;
                    
                    const itemHTML = `
                        <div class="top-user-item">
                            <div class="top-user-info">
                                <div class="top-user-name">
                                    ${rankBadge}
                                    <strong>${item.user}</strong>
                                    <span class="badge badge-profile" style="font-size: 0.7rem; padding: 2px 6px;">${userProfile}</span>
                                </div>
                                <div class="top-user-bytes">${formatBytes(userBytesTotal)}</div>
                            </div>
                            <div class="distribution-bar-bg" style="margin-bottom: 8px;">
                                <div class="distribution-bar-fill success" style="width: ${percentOfMax}%;"></div>
                            </div>
                            <div class="top-user-breakdown">
                                <span class="dl"><i class="fa-solid fa-circle-arrow-down"></i> ดาวน์โหลด: ${formatBytes(item.bytesOut)}</span>
                                <span class="ul"><i class="fa-solid fa-circle-arrow-up"></i> อัปโหลด: ${formatBytes(item.bytesIn)}</span>
                                <span class="time"><i class="fa-solid fa-clock"></i> เวลาล็อกอิน: ${item.uptime}</span>
                            </div>
                        </div>
                    `;
                    topUsersEl.insertAdjacentHTML('beforeend', itemHTML);
                });
            }
        }
        
    } catch (err) {
        console.error('Failed to load hotspot stats data:', err);
        if (profileDistEl) profileDistEl.innerHTML = `<div class="text-center text-danger">เกิดข้อผิดพลาด: ${err.message}</div>`;
        if (loginDistEl) loginDistEl.innerHTML = `<div class="text-center text-danger">เกิดข้อผิดพลาด: ${err.message}</div>`;
        if (topUsersEl) topUsersEl.innerHTML = `<div class="text-center text-danger">เกิดข้อผิดพลาด: ${err.message}</div>`;
    }
}


// ==========================================
// CORE BINDINGS & NAV CLICK EVENT HANDLERS
// ==========================================
async function handleLoginSubmit(e) {
    if (e && typeof e.preventDefault === 'function') {
        e.preventDefault();
        e.stopPropagation();
    }
    const usernameInput = document.getElementById('login-username');
    const passwordInput = document.getElementById('login-password');
    const loginErrEl = document.getElementById('login-error');
    const loginFormEl = document.getElementById('login-form');
    const username = (usernameInput?.value || '').trim();
    const password = passwordInput?.value || '';

    if (!username || !password) {
        if (loginErrEl) {
            loginErrEl.textContent = 'กรุณากรอกชื่อผู้ใช้และรหัสผ่านให้ครบถ้วน';
            loginErrEl.style.display = 'block';
        }
        return false;
    }

    const submitBtn = (loginFormEl ? loginFormEl.querySelector('button[type="submit"]') : null) || document.getElementById('btn-login-submit');
    const origHtml = submitBtn ? submitBtn.innerHTML : '';
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<span>กำลังเข้าสู่ระบบ...</span> <i class="fa-solid fa-spinner fa-spin"></i>';
    }
    if (loginErrEl) loginErrEl.style.display = 'none';

    try {
        const res = await apiFetch('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });

        API_TOKEN = res.token;
        CURRENT_USER = res.user;

        localStorage.setItem('token', API_TOKEN);
        localStorage.setItem('user', JSON.stringify(CURRENT_USER));

        showDashboard();
    } catch (err) {
        if (err.status === 429 || (err.message && err.message.includes('มากเกินไป'))) {
            let remaining = 300;
            if (loginErrEl) {
                loginErrEl.innerHTML = `<i class="fa-solid fa-lock"></i> บัญชีถูกล็อกชั่วคราว — โปรดรอ <strong id="lockout-timer">05:00</strong> นาที`;
                loginErrEl.style.display = 'block';
            }
            if (submitBtn) submitBtn.disabled = true;

            const countdownInterval = setInterval(() => {
                remaining--;
                const min = String(Math.floor(remaining / 60)).padStart(2, '0');
                const sec = String(remaining % 60).padStart(2, '0');
                const timerEl = document.getElementById('lockout-timer');
                if (timerEl) timerEl.textContent = `${min}:${sec}`;
                if (remaining <= 0) {
                    clearInterval(countdownInterval);
                    if (loginErrEl) loginErrEl.style.display = 'none';
                    if (submitBtn) {
                        submitBtn.disabled = false;
                        submitBtn.innerHTML = origHtml || '<span>เข้าสู่ระบบระบบจัดการ</span> <i class="fa-solid fa-arrow-right-to-bracket"></i>';
                    }
                }
            }, 1000);
        } else {
            if (loginErrEl) {
                loginErrEl.textContent = err.message || 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง';
                loginErrEl.style.display = 'block';
            }
            if (loginFormEl) {
                loginFormEl.style.animation = 'none';
                setTimeout(() => { loginFormEl.style.animation = 'shake 0.4s ease'; }, 10);
            }
        }
    } finally {
        if (submitBtn && (!submitBtn.disabled || !document.getElementById('lockout-timer'))) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = origHtml || '<span>เข้าสู่ระบบระบบจัดการ</span> <i class="fa-solid fa-arrow-right-to-bracket"></i>';
        }
    }
    return false;
}

window.handleLoginSubmit = handleLoginSubmit;

if (loginForm) {
    loginForm.addEventListener('submit', handleLoginSubmit);
}
const loginSubmitBtn = document.getElementById('btn-login-submit') || document.querySelector('#login-form button[type="submit"]');
if (loginSubmitBtn) {
    loginSubmitBtn.addEventListener('click', handleLoginSubmit);
}


// Refresh button on top right header
document.getElementById('btn-refresh').addEventListener('click', () => {
    const refreshBtn = document.getElementById('btn-refresh');
    refreshBtn.disabled = true;
    refreshBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังโหลด';
    
    loadPageData(currentActivePage);
    fetchSystemStatus().finally(() => {
        refreshBtn.disabled = false;
        refreshBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> รีเฟรช';
    });
});

// Mobile Sidebar Drawer Controller (iOS & Android Compatible)
function toggleMobileSidebar(forceState) {
    const sidebar = document.querySelector('.sidebar');
    const overlay = document.getElementById('sidebar-overlay') || document.querySelector('.sidebar-overlay');
    
    const isCurrentlyActive = sidebar ? sidebar.classList.contains('active') : false;
    const nextState = typeof forceState === 'boolean' ? forceState : !isCurrentlyActive;

    if (sidebar) {
        if (nextState) sidebar.classList.add('active');
        else sidebar.classList.remove('active');
    }
    if (overlay) {
        if (nextState) overlay.classList.add('active');
        else overlay.classList.remove('active');
    }
}

// Sidebar menu clicks
document.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const targetPage = item.getAttribute('data-target');
        switchPage(targetPage);
        toggleMobileSidebar(false);
    });
});

// Tab buttons click handlers (Scoped per section)
document.querySelectorAll('#page-hotspot .tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        const targetTab = btn.getAttribute('data-tab');
        loadHotspotTab(targetTab);
    });
});

document.querySelectorAll('#settings-tab-nav .tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        const targetTab = btn.getAttribute('data-tab');
        loadSettingsTab(targetTab);
    });
});

// Logout click
document.getElementById('btn-logout')?.addEventListener('click', () => {
    if (confirm('คุณต้องการออกจากระบบแดชบอร์ดใช่หรือไม่?')) {
        logout();
    }
});

// Mobile menu toggles bindings (iOS Touch & Click Compatible)
const btnMenuToggle = document.getElementById('btn-menu-toggle');
if (btnMenuToggle) {
    btnMenuToggle.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleMobileSidebar();
    });
}

const overlayEl = document.getElementById('sidebar-overlay') || document.querySelector('.sidebar-overlay');
if (overlayEl) {
    overlayEl.addEventListener('click', (e) => {
        e.preventDefault();
        toggleMobileSidebar(false);
    });
}

// ==========================================
// ==========================================
// MULTI-WAN TOOL CONTROLLER (Dynamic N-WAN & Real Interface Binding)
// ==========================================
let currentWanLines = [];
let cachedRouterInterfaces = [];

async function fetchRealRouterInterfaces() {
    try {
        const interfaces = await apiFetch('/api/mikrotik/interfaces');
        if (Array.isArray(interfaces)) {
            cachedRouterInterfaces = interfaces;
        }
    } catch (err) {
        console.warn('Failed to fetch real router interfaces:', err);
    }
    return cachedRouterInterfaces;
}

function renderWanLineCards() {
    const container = document.getElementById('wan-lines-container');
    if (!container) return;
    container.innerHTML = '';

    if (!currentWanLines || currentWanLines.length === 0) {
        currentWanLines = [
            { id: 'wan_1', name: 'WAN 1', interface: 'pppoe-out1', type: 'pppoe', gateway: '', speed: 1000, weight: 2, dnsCheck: '8.8.8.8' },
            { id: 'wan_2', name: 'WAN 2', interface: 'ether2-WAN2', type: 'dhcp', gateway: '192.168.2.1', speed: 500, weight: 1, dnsCheck: '1.1.1.1' }
        ];
    }

    currentWanLines.forEach((wan, idx) => {
        const card = document.createElement('div');
        card.className = 'card';
        card.style.padding = '20px';

        const isPPPoE = wan.type === 'pppoe';
        const interfaceOptionsHtml = buildInterfaceOptionsHtml(wan.interface);

        card.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; border-bottom:1px solid var(--border-color); padding-bottom:8px;">
                <h3 style="font-size:1.05rem; font-weight:600; margin:0;">
                    <i class="fa-solid fa-bolt text-primary"></i> ${wan.name || `WAN ${idx + 1}`} ${idx === 0 ? '(Primary)' : ''}
                </h3>
                ${currentWanLines.length > 1 ? `<button type="button" class="btn btn-sm btn-outline-danger btn-remove-wan" data-index="${idx}" style="padding:2px 8px; font-size:0.75rem;"><i class="fa-solid fa-trash"></i> ลบสาย</button>` : ''}
            </div>
            <div class="form-row-2 mb-12">
                <div class="form-group">
                    <label>Interface ราวเตอร์ *</label>
                    <select class="form-control mw-wan-interface" data-index="${idx}">
                        ${interfaceOptionsHtml}
                    </select>
                </div>
                <div class="form-group">
                    <label>ประเภทการเชื่อมต่อ *</label>
                    <select class="form-control mw-wan-type" data-index="${idx}">
                        <option value="pppoe" ${wan.type === 'pppoe' ? 'selected' : ''}>PPPoE Client</option>
                        <option value="dhcp" ${wan.type === 'dhcp' ? 'selected' : ''}>DHCP Client</option>
                        <option value="static" ${wan.type === 'static' ? 'selected' : ''}>Static IP</option>
                    </select>
                </div>
            </div>
            <div class="form-row-2 mb-12">
                <div class="form-group">
                    <label>Gateway IP ${isPPPoE ? '(ไม่ใช้ใน PPPoE)' : '*'}</label>
                    <input type="text" class="form-control mw-wan-gateway" data-index="${idx}" value="${wan.gateway || ''}" ${isPPPoE ? 'disabled' : ''} placeholder="เช่น 192.168.2.1">
                </div>
                <div class="form-group">
                    <label>ความเร็ว (Mbps)</label>
                    <input type="number" class="form-control mw-wan-speed" data-index="${idx}" value="${wan.speed || 500}" placeholder="500">
                </div>
            </div>
            <div class="form-row-2 mb-12">
                <div class="form-group">
                    <label>อัตราส่วน Weight (PCC)</label>
                    <input type="number" class="form-control mw-wan-weight" data-index="${idx}" value="${wan.weight || 1}" min="1" placeholder="1">
                </div>
                <div class="form-group">
                    <label>Target Host Check (DNS)</label>
                    <input type="text" class="form-control mw-wan-dns" data-index="${idx}" value="${wan.dnsCheck || `8.8.8.${idx + 1}`}" placeholder="เช่น 8.8.8.8">
                </div>
            </div>
        `;
        container.appendChild(card);
    });

    bindWanCardsEvents();
}

function buildInterfaceOptionsHtml(selectedVal) {
    if (!cachedRouterInterfaces || cachedRouterInterfaces.length === 0) {
        const defaults = ['pppoe-out1', 'ether1', 'ether2-WAN2', 'ether3', 'ether4', 'ether5', 'sfp-sfpplus1'];
        let options = defaults.map(name => `<option value="${name}" ${name === selectedVal ? 'selected' : ''}>${name}</option>`).join('');
        if (selectedVal && !defaults.includes(selectedVal)) {
            options += `<option value="${selectedVal}" selected>${selectedVal} (ระบุเอง)</option>`;
        }
        return options;
    }

    let options = cachedRouterInterfaces.map(iface => {
        const name = iface.name;
        const typeStr = iface.type ? ` (${iface.type})` : '';
        const disabledStr = iface.disabled ? ' [disabled]' : '';
        return `<option value="${name}" ${name === selectedVal ? 'selected' : ''}>${name}${typeStr}${disabledStr}</option>`;
    }).join('');

    if (selectedVal && !cachedRouterInterfaces.some(i => i.name === selectedVal)) {
        options += `<option value="${selectedVal}" selected>${selectedVal} (custom)</option>`;
    }
    return options;
}

function gcd(a, b) {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b) {
        let t = b;
        b = a % b;
        a = t;
    }
    return a;
}

function autoCalculatePccWeights() {
    const speeds = currentWanLines.map(w => parseInt(w.speed) || 0);
    const nonZeroSpeeds = speeds.filter(s => s > 0);
    if (nonZeroSpeeds.length === 0) return;

    let commonGcd = nonZeroSpeeds[0];
    for (let i = 1; i < nonZeroSpeeds.length; i++) {
        commonGcd = gcd(commonGcd, nonZeroSpeeds[i]);
    }

    currentWanLines.forEach((w, i) => {
        const s = parseInt(w.speed) || 0;
        const calcWeight = s > 0 ? Math.max(1, Math.round(s / commonGcd)) : 1;
        w.weight = calcWeight;
        const weightInput = document.querySelector(`.mw-wan-weight[data-index="${i}"]`);
        if (weightInput) weightInput.value = calcWeight;
    });
}

function bindWanCardsEvents() {
    document.querySelectorAll('.mw-wan-type').forEach(select => {
        select.addEventListener('change', (e) => {
            const idx = parseInt(e.target.getAttribute('data-index'));
            if (currentWanLines[idx]) {
                currentWanLines[idx].type = e.target.value;
                renderWanLineCards();
            }
        });
    });

    document.querySelectorAll('.mw-wan-interface').forEach(select => {
        select.addEventListener('change', (e) => {
            const idx = parseInt(e.target.getAttribute('data-index'));
            if (currentWanLines[idx]) {
                currentWanLines[idx].interface = e.target.value;
                renderPbrRuleRows();
            }
        });
    });

    document.querySelectorAll('.mw-wan-speed').forEach(input => {
        input.addEventListener('input', (e) => {
            const idx = parseInt(e.target.getAttribute('data-index'));
            if (currentWanLines[idx]) {
                currentWanLines[idx].speed = parseInt(e.target.value) || 0;
                autoCalculatePccWeights();
            }
        });
    });

    document.querySelectorAll('.mw-wan-weight').forEach(input => {
        input.addEventListener('input', (e) => {
            const idx = parseInt(e.target.getAttribute('data-index'));
            if (currentWanLines[idx]) {
                currentWanLines[idx].weight = parseInt(e.target.value) || 1;
            }
        });
    });

    document.querySelectorAll('.mw-wan-gateway').forEach(input => {
        input.addEventListener('input', (e) => {
            const idx = parseInt(e.target.getAttribute('data-index'));
            if (currentWanLines[idx]) {
                currentWanLines[idx].gateway = e.target.value;
            }
        });
    });

    document.querySelectorAll('.btn-remove-wan').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(btn.getAttribute('data-index'));
            if (currentWanLines.length > 1) {
                currentWanLines.splice(idx, 1);
                currentWanLines.forEach((w, i) => w.name = `WAN ${i + 1}`);
                autoCalculatePccWeights();
                renderWanLineCards();
                renderPbrRuleRows();
            }
        });
    });
}

let currentPbrRules = [];

function autoGeneratePbrNote(srcInterface, targetWanNum) {
    const wanObj = currentWanLines[targetWanNum - 1];
    const wanStr = wanObj ? `WAN ${targetWanNum} (${wanObj.interface || 'Interface'})` : `WAN ${targetWanNum}`;
    const srcStr = srcInterface || 'Interface';
    return `${srcStr} เจาะจงออก ${wanStr}`;
}

function renderPbrRuleRows() {
    const container = document.getElementById('pbr-rules-container');
    if (!container) return;
    container.innerHTML = '';

    if (!currentPbrRules || currentPbrRules.length === 0) {
        currentPbrRules = [
            { id: 'pbr_1', srcInterface: 'vlan10-hotspot', targetWanNum: 1, note: autoGeneratePbrNote('vlan10-hotspot', 1) },
            { id: 'pbr_2', srcInterface: 'vlan20-pppoe', targetWanNum: 2, note: autoGeneratePbrNote('vlan20-pppoe', 2) }
        ];
    }

    currentPbrRules.forEach((rule, idx) => {
        const tr = document.createElement('tr');
        
        const wanTargetOptions = currentWanLines.map((w, wIdx) => {
            const num = wIdx + 1;
            return `<option value="${num}" ${rule.targetWanNum === num ? 'selected' : ''}>WAN ${num} (${w.interface || 'Interface'})</option>`;
        }).join('');

        const srcOptions = buildPbrSourceInterfaceOptionsHtml(rule.srcInterface);
        const autoNote = autoGeneratePbrNote(rule.srcInterface, rule.targetWanNum);
        const displayNote = rule.note || autoNote;
        rule.note = displayNote;

        tr.innerHTML = `
            <td>
                <select class="form-control mw-pbr-src" data-index="${idx}">
                    ${srcOptions}
                </select>
            </td>
            <td>
                <select class="form-control mw-pbr-target" data-index="${idx}">
                    ${wanTargetOptions}
                </select>
            </td>
            <td>
                <input type="text" class="form-control mw-pbr-note" data-index="${idx}" value="${displayNote}" placeholder="คำอธิบายตาม Interface และ WAN ขาออก">
            </td>
            <td class="text-center">
                <button type="button" class="btn btn-sm btn-outline-danger btn-remove-pbr" data-index="${idx}"><i class="fa-solid fa-trash"></i></button>
            </td>
        `;
        container.appendChild(tr);
    });

    // Auto-update note field on Source Interface or Target WAN selection change
    document.querySelectorAll('.mw-pbr-src').forEach(select => {
        select.addEventListener('change', (e) => {
            const idx = parseInt(e.target.getAttribute('data-index'));
            const targetSelect = document.querySelector(`.mw-pbr-target[data-index="${idx}"]`);
            const noteInput = document.querySelector(`.mw-pbr-note[data-index="${idx}"]`);
            if (currentPbrRules[idx] && targetSelect && noteInput) {
                currentPbrRules[idx].srcInterface = e.target.value;
                const newNote = autoGeneratePbrNote(e.target.value, parseInt(targetSelect.value) || 1);
                currentPbrRules[idx].note = newNote;
                noteInput.value = newNote;
            }
        });
    });

    document.querySelectorAll('.mw-pbr-target').forEach(select => {
        select.addEventListener('change', (e) => {
            const idx = parseInt(e.target.getAttribute('data-index'));
            const srcSelect = document.querySelector(`.mw-pbr-src[data-index="${idx}"]`);
            const noteInput = document.querySelector(`.mw-pbr-note[data-index="${idx}"]`);
            if (currentPbrRules[idx] && srcSelect && noteInput) {
                const targetNum = parseInt(e.target.value) || 1;
                currentPbrRules[idx].targetWanNum = targetNum;
                const newNote = autoGeneratePbrNote(srcSelect.value, targetNum);
                currentPbrRules[idx].note = newNote;
                noteInput.value = newNote;
            }
        });
    });

    document.querySelectorAll('.btn-remove-pbr').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const idx = parseInt(btn.getAttribute('data-index'));
            currentPbrRules.splice(idx, 1);
            renderPbrRuleRows();
        });
    });
}

function buildPbrSourceInterfaceOptionsHtml(selectedVal) {
    const presets = [
        { name: 'vlan10-hotspot', label: 'vlan10-hotspot (VLAN 10 Hotspot)' },
        { name: 'vlan20-pppoe', label: 'vlan20-pppoe (VLAN 20 PPPoE)' },
        { name: 'bridge-lan', label: 'bridge-lan (Local Bridge)' },
        { name: '192.168.10.0/24', label: '192.168.10.0/24 (Subnet)' },
        { name: '192.168.20.0/24', label: '192.168.20.0/24 (Subnet)' }
    ];

    let options = '';
    if (cachedRouterInterfaces && cachedRouterInterfaces.length > 0) {
        options = cachedRouterInterfaces.map(iface => {
            const name = iface.name;
            const label = `${name}${iface.type ? ` (${iface.type})` : ''}`;
            return `<option value="${name}" ${name === selectedVal ? 'selected' : ''}>${label}</option>`;
        }).join('');
    } else {
        options = presets.map(p => `<option value="${p.name}" ${p.name === selectedVal ? 'selected' : ''}>${p.label}</option>`).join('');
    }

    if (selectedVal && !options.includes(`value="${selectedVal}"`)) {
        options += `<option value="${selectedVal}" selected>${selectedVal} (ระบุเอง)</option>`;
    }
    return options;
}

document.getElementById('btn-add-wan-line')?.addEventListener('click', () => {
    const newIdx = currentWanLines.length + 1;
    currentWanLines.push({
        id: `wan_${newIdx}`,
        name: `WAN ${newIdx}`,
        interface: `ether${newIdx}`,
        type: 'dhcp',
        gateway: `192.168.${newIdx}.1`,
        speed: 500,
        weight: 1,
        dnsCheck: `8.8.4.${newIdx}`
    });
    renderWanLineCards();
    renderPbrRuleRows();
});

document.getElementById('btn-add-pbr-rule')?.addEventListener('click', () => {
    const newIdx = currentPbrRules.length + 1;
    currentPbrRules.push({
        id: `pbr_${newIdx}`,
        srcInterface: `vlan${newIdx * 10}`,
        targetWanNum: 1,
        note: `กฎ PBR ${newIdx}`
    });
    renderPbrRuleRows();
});

document.getElementById('btn-refresh-multiwan-interfaces')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-refresh-multiwan-interfaces');
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังดึงข้อมูล...'; }
    await fetchRealRouterInterfaces();
    renderWanLineCards();
    renderPbrRuleRows();
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> ดึงรายการ Interface จากราวเตอร์'; }
    alert('อัปเดตรายการ Interface จากเราท์เตอร์จริงเรียบร้อยแล้ว!');
});

async function renderMultiWanPage() {
    const activeSiteNameEl = document.getElementById('multiwan-active-site-name');
    if (activeSiteNameEl) {
        activeSiteNameEl.textContent = getCurrentSiteName() || 'Default Site';
    }

    await fetchRealRouterInterfaces();

    try {
        const config = await apiFetch('/api/multiwan');
        if (config) {
            if (Array.isArray(config.wans) && config.wans.length > 0) {
                currentWanLines = config.wans;
            } else {
                currentWanLines = [
                    { id: 'wan_1', name: 'WAN 1', interface: config.wan1Interface || 'pppoe-out1', type: config.wan1Type || 'pppoe', gateway: '', speed: config.wan1Speed || 1000, weight: config.wan1Weight || 2, dnsCheck: config.dnsCheckWan1 || '8.8.8.8' },
                    { id: 'wan_2', name: 'WAN 2', interface: config.wan2Interface || 'ether2-WAN2', type: config.wan2Type || 'dhcp', gateway: config.wan2Gateway || '192.168.2.1', speed: config.wan2Speed || 500, weight: config.wan2Weight || 1, dnsCheck: config.dnsCheckWan2 || '1.1.1.1' }
                ];
            }
            renderWanLineCards();

            if (Array.isArray(config.pbrRules) && config.pbrRules.length > 0) {
                currentPbrRules = config.pbrRules;
            } else if (config.pbrVlan10Subnet || config.pbrVlan20Subnet) {
                currentPbrRules = [
                    { id: 'pbr_1', srcInterface: config.pbrVlan10Subnet || '192.168.10.0/24', targetWanNum: 1, note: 'VLAN 10 -> WAN 1' },
                    { id: 'pbr_2', srcInterface: config.pbrVlan20Subnet || '192.168.20.0/24', targetWanNum: 2, note: 'VLAN 20 -> WAN 2' }
                ];
            }
            renderPbrRuleRows();

            if (document.getElementById('mw-telegram-token')) document.getElementById('mw-telegram-token').value = config.telegramToken || '';
            if (document.getElementById('mw-telegram-chatid')) document.getElementById('mw-telegram-chatid').value = config.telegramChatId || '';

            if (document.getElementById('mw-toggle-mss')) document.getElementById('mw-toggle-mss').checked = config.mssClamping !== false;
            if (document.getElementById('mw-toggle-fasttrack')) document.getElementById('mw-toggle-fasttrack').checked = config.fasttrackBypass !== false;
            if (document.getElementById('mw-toggle-dnshijack')) document.getElementById('mw-toggle-dnshijack').checked = config.dnsHijack !== false;
            if (document.getElementById('mw-toggle-hairpin')) document.getElementById('mw-toggle-hairpin').checked = config.hairpinNat !== false;
        }
    } catch (err) {
        console.error('Failed to load Multi-WAN config:', err);
        renderWanLineCards();
        renderPbrRuleRows();
    }
}

function getMultiWanFormPayload() {
    const updatedWans = [];
    document.querySelectorAll('.mw-wan-interface').forEach((el, idx) => {
        const typeEl = document.querySelector(`.mw-wan-type[data-index="${idx}"]`);
        const gwEl = document.querySelector(`.mw-wan-gateway[data-index="${idx}"]`);
        const speedEl = document.querySelector(`.mw-wan-speed[data-index="${idx}"]`);
        const weightEl = document.querySelector(`.mw-wan-weight[data-index="${idx}"]`);
        const dnsEl = document.querySelector(`.mw-wan-dns[data-index="${idx}"]`);

        updatedWans.push({
            id: `wan_${idx + 1}`,
            name: `WAN ${idx + 1}`,
            interface: (el.value || '').trim(),
            type: typeEl ? typeEl.value : 'dhcp',
            gateway: gwEl ? (gwEl.value || '').trim() : '',
            speed: parseInt(speedEl?.value) || 500,
            weight: parseInt(weightEl?.value) || 1,
            dnsCheck: dnsEl ? (dnsEl.value || '').trim() : `8.8.8.${idx + 1}`
        });
    });

    const updatedPbrRules = [];
    document.querySelectorAll('.mw-pbr-src').forEach((el, idx) => {
        const targetEl = document.querySelector(`.mw-pbr-target[data-index="${idx}"]`);
        const noteEl = document.querySelector(`.mw-pbr-note[data-index="${idx}"]`);
        updatedPbrRules.push({
            id: `pbr_${idx + 1}`,
            srcInterface: (el.value || '').trim(),
            targetWanNum: parseInt(targetEl?.value) || 1,
            note: (noteEl?.value || '').trim()
        });
    });

    return {
        wans: updatedWans,
        pbrRules: updatedPbrRules,
        telegramToken: (document.getElementById('mw-telegram-token')?.value || '').trim(),
        telegramChatId: (document.getElementById('mw-telegram-chatid')?.value || '').trim(),
        telegramMsgDown: (document.getElementById('mw-telegram-msg-down')?.value || '').trim(),
        telegramMsgUp: (document.getElementById('mw-telegram-msg-up')?.value || '').trim(),
        mssClamping: !!document.getElementById('mw-toggle-mss')?.checked,
        fasttrackBypass: !!document.getElementById('mw-toggle-fasttrack')?.checked,
        dnsHijack: !!document.getElementById('mw-toggle-dnshijack')?.checked,
        hairpinNat: !!document.getElementById('mw-toggle-hairpin')?.checked
    };
}

document.getElementById('btn-save-multiwan-config')?.addEventListener('click', async () => {
    try {
        const payload = getMultiWanFormPayload();
        await apiFetch('/api/multiwan', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        alert('บันทึกการตั้งค่า Multi-WAN ประจำไซต์งานเรียบร้อยแล้ว!');
    } catch (err) {
        alert('ไม่สามารถบันทึกค่าได้: ' + err.message);
    }
});

document.getElementById('form-multiwan-config')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
        const payload = getMultiWanFormPayload();
        await apiFetch('/api/multiwan', { method: 'POST', body: JSON.stringify(payload) });
        const res = await apiFetch('/api/multiwan/generate-script', { method: 'POST', body: JSON.stringify(payload) });
        const outputCard = document.getElementById('multiwan-script-output-card');
        const textarea = document.getElementById('multiwan-script-textarea');
        if (outputCard && textarea) {
            textarea.value = res.script;
            outputCard.style.display = 'block';
            outputCard.scrollIntoView({ behavior: 'smooth' });
        }
    } catch (err) {
        alert('ไม่สามารถสร้างสคริปต์ได้: ' + err.message);
    }
});

document.getElementById('btn-copy-multiwan-script')?.addEventListener('click', () => {
    const textarea = document.getElementById('multiwan-script-textarea');
    if (textarea && textarea.value) {
        navigator.clipboard.writeText(textarea.value).then(() => {
            alert('คัดลอกสคริปต์ Multi-WAN เรียบร้อยแล้ว! สามารถนำไปวางใน WinBox -> Terminal ได้ทันที');
        }).catch(err => {
            textarea.select();
            document.execCommand('copy');
            alert('คัดลอกสคริปต์เรียบร้อยแล้ว!');
        });
    }
});

document.getElementById('btn-apply-multiwan-api')?.addEventListener('click', async () => {
    if (!confirm('คุณต้องการสั่งให้ระบบตั้งค่า Multi-WAN และบังคับใช้ลงบนเราท์เตอร์ไซต์งานนี้ผ่าน API ทันทีใช่หรือไม่?')) {
        return;
    }
    const btn = document.getElementById('btn-apply-multiwan-api');
    const origHtml = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังตั้งค่าบนเราท์เตอร์...'; }

    try {
        const payload = getMultiWanFormPayload();
        const res = await apiFetch('/api/multiwan/apply', {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        const logMsg = (res.logs || []).join('\n - ');
        alert(`สำเร็จ! ${res.message}\n\nรายการตั้งค่าที่ดำเนินการ:\n - ${logMsg}`);
    } catch (err) {
        alert('เกิดข้อผิดพลาดในการสั่งตั้งค่าบนเราท์เตอร์: ' + err.message);
    } finally {
        if (btn) { btn.disabled = false; btn.innerHTML = origHtml; }
    }
});

// Export Hotspot Accounts CSV (With Passwords)
document.getElementById('btn-export-hotspot-csv')?.addEventListener('click', () => {
    if (!_allHotspotAccounts || _allHotspotAccounts.length === 0) {
        alert('ไม่มีข้อมูลบัญชี Hotspot ที่จะ Export');
        return;
    }

    const headers = ['Username', 'Password', 'Profile', 'Uptime Accumulated', 'Uptime Limit', 'Bytes Total', 'Bytes Limit', 'Comment', 'Status'];
    const rows = [headers];

    _allHotspotAccounts.forEach(acc => {
        rows.push([
            `"${(acc.name || '').replace(/"/g, '""')}"`,
            `"${(acc.password || '').replace(/"/g, '""')}"`,
            `"${(acc.profile || '').replace(/"/g, '""')}"`,
            `"${acc.uptime || '0s'}"`,
            `"${acc['limit-uptime'] || 'Unlimited'}"`,
            `"${acc.bytesTotal || 0}"`,
            `"${acc['limit-bytes-total'] || 'Unlimited'}"`,
            `"${(acc.comment || '').replace(/"/g, '""')}"`,
            `"${acc.disabled ? 'Disabled' : 'Active'}"`
        ]);
    });

    const csvContent = '\uFEFF' + rows.map(r => r.join(',')).join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    const siteName = getCurrentSiteName() || 'mikrotik';
    const timestamp = new Date().toISOString().slice(0, 10);
    link.setAttribute('download', `hotspot_accounts_passwords_${siteName}_${timestamp}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
});

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
    initApp();
});

// ==========================================
// TELEGRAM OPS ALERTS (ช่องทางทีมแอดมิน — แยกจาก LINE ที่ใช้แจ้งลูกค้า)
// ==========================================
function renderTelegramAlertState(cfg) {
    const badge = document.getElementById('telegram-alert-status-badge');
    const toggle = document.getElementById('toggle-telegram-alert');
    const hint = document.getElementById('telegram-token-hint');
    if (toggle) toggle.checked = !!cfg.enabled;
    if (badge) {
        badge.textContent = cfg.enabled ? 'เปิดใช้งาน' : 'ปิดใช้งาน';
        badge.classList.toggle('off', !cfg.enabled);
    }
    const chat = document.getElementById('telegram-chat-id');
    if (chat) chat.value = cfg.chatId || '';
    const off = document.getElementById('telegram-alert-offline');
    if (off) off.checked = cfg.alertOffline !== false;
    const on = document.getElementById('telegram-alert-online');
    if (on) on.checked = cfg.alertOnline !== false;
    // ไม่เคยรับ token กลับมาจาก server — บอกแค่ว่ามีบันทึกไว้แล้วหรือยัง
    if (hint) {
        hint.textContent = cfg.hasBotToken
            ? `บันทึก token ไว้แล้ว (${cfg.botTokenPreview}) — เว้นว่างไว้ถ้าไม่ต้องการเปลี่ยน`
            : 'สร้างบอทที่ @BotFather แล้วนำ token มาวาง';
    }
}

async function loadTelegramAlertConfig() {
    if (!document.getElementById('telegram-alert-card')) return;
    try {
        renderTelegramAlertState(await apiFetch('/api/mikrotik/telegram-alert/config'));
    } catch (err) {
        console.warn('โหลดการตั้งค่า Telegram ไม่ได้:', err.message);
    }
}

function collectTelegramPayload() {
    const tokenEl = document.getElementById('telegram-bot-token');
    const payload = {
        enabled: !!document.getElementById('toggle-telegram-alert')?.checked,
        chatId: (document.getElementById('telegram-chat-id')?.value || '').trim(),
        alertOffline: !!document.getElementById('telegram-alert-offline')?.checked,
        alertOnline: !!document.getElementById('telegram-alert-online')?.checked
    };
    // ส่ง botToken ไปเฉพาะตอนที่กรอกใหม่ ช่องว่าง = ใช้ค่าเดิม
    const t = (tokenEl?.value || '').trim();
    if (t) payload.botToken = t;
    return payload;
}

document.getElementById('btn-save-telegram-alert')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-save-telegram-alert');
    btn.disabled = true;
    try {
        const cfg = await apiFetch('/api/mikrotik/telegram-alert/config', {
            method: 'POST',
            body: JSON.stringify(collectTelegramPayload())
        });
        const tokenEl = document.getElementById('telegram-bot-token');
        if (tokenEl) tokenEl.value = '';
        renderTelegramAlertState(cfg);
        alert('บันทึกการตั้งค่า Telegram เรียบร้อยแล้ว');
    } catch (err) {
        alert('บันทึกไม่สำเร็จ: ' + err.message);
    } finally {
        btn.disabled = false;
    }
});

document.getElementById('btn-test-telegram-alert')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-test-telegram-alert');
    btn.disabled = true;
    const original = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> กำลังส่ง...';
    try {
        const tokenEl = document.getElementById('telegram-bot-token');
        const body = { chatId: (document.getElementById('telegram-chat-id')?.value || '').trim() };
        const t = (tokenEl?.value || '').trim();
        if (t) body.botToken = t;
        const res = await apiFetch('/api/mikrotik/telegram-alert/test', { method: 'POST', body: JSON.stringify(body) });
        alert(res.message || 'ส่งข้อความทดสอบเรียบร้อยแล้ว');
    } catch (err) {
        alert('ส่งไม่สำเร็จ: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = original;
    }
});

document.getElementById('btn-telegram-discover')?.addEventListener('click', async () => {
    const box = document.getElementById('telegram-chat-results');
    const btn = document.getElementById('btn-telegram-discover');
    btn.disabled = true;
    try {
        const tokenEl = document.getElementById('telegram-bot-token');
        const body = {};
        const t = (tokenEl?.value || '').trim();
        if (t) body.botToken = t;
        const res = await apiFetch('/api/mikrotik/telegram-alert/discover-chats', { method: 'POST', body: JSON.stringify(body) });
        if (box) {
            box.style.display = 'block';
            if (!res.chats || !res.chats.length) {
                box.innerHTML = '<span style="color:#b45309;">ยังไม่เห็นแชตใด — เพิ่มบอทเข้ากลุ่ม แล้วพิมพ์ข้อความอะไรก็ได้ในกลุ่ม จากนั้นกดค้นหาอีกครั้ง</span>';
            } else {
                box.innerHTML = '<div style="font-weight:600; margin-bottom:6px;">แชตที่บอทเห็น (กดเพื่อเลือก):</div>' +
                    res.chats.map(c =>
                        `<button type="button" class="btn btn-secondary btn-sm tg-pick" data-chat="${c.chatId}" style="margin:3px 4px 3px 0;">
                            ${c.type === 'private' ? '👤' : '👥'} ${c.title} <code>${c.chatId}</code>
                        </button>`
                    ).join('');
                box.querySelectorAll('.tg-pick').forEach(b => {
                    b.addEventListener('click', () => {
                        const el = document.getElementById('telegram-chat-id');
                        if (el) el.value = b.getAttribute('data-chat');
                    });
                });
            }
        }
    } catch (err) {
        if (box) {
            box.style.display = 'block';
            box.innerHTML = `<span style="color:#b91c1c;">ค้นหาไม่สำเร็จ: ${err.message}</span>`;
        }
    } finally {
        btn.disabled = false;
    }
});
