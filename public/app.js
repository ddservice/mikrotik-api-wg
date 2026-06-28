// ==========================================================================
// STATE MANAGEMENT & CONSTANTS
// ==========================================================================
let API_TOKEN = localStorage.getItem('token');
let CURRENT_USER = JSON.parse(localStorage.getItem('user'));
let currentActivePage = 'page-overview';
let activeHotspotTab = 'tab-hotspot-active';
let currentSitesData = { activeSiteId: '', sites: [] };
let currentSinglePrintUser = null;

// Polling intervals
let statsInterval = null;
let trafficInterval = null;

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
    // RouterOS uptime looks like: 2w4d12h30m15s or 12h30m15s or 05:30:10
    // We just return it directly as RouterOS formats it nicely
    return uptimeStr || '-';
}

async function apiFetch(endpoint, options = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...options.headers
    };
    
    if (API_TOKEN) {
        headers['Authorization'] = `Bearer ${API_TOKEN}`;
    }
    
    let response;
    try {
        response = await fetch(endpoint, { ...options, headers });
    } catch (netErr) {
        throw new Error('ไม่สามารถเชื่อมต่อ Server ได้ กรุณาตรวจสอบว่า Node.js (node server.js) กำลังทำงานอยู่');
    }
    
    if (response.status === 401) {
        // Session expired or invalid
        logout();
        throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    }
    
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
        throw new Error(`เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (HTTP ${response.status}) กรุณาเข้าใช้งานผ่าน http://localhost:3000 และเปิดเซิร์ฟเวอร์ด้วยคำสั่ง node server.js`);
    }

    let data;
    try {
        data = await response.json();
    } catch (e) {
        throw new Error('รูปแบบข้อมูลจากเซิร์ฟเวอร์ไม่ถูกต้อง (JSON syntax error)');
    }

    if (!response.ok) {
        throw new Error(data.error || 'เกิดข้อผิดพลาดในการเรียกข้อมูล');
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
    } catch (err) {
        console.error('Failed to fetch sites:', err);
    }
}

const selectActiveSiteEl = document.getElementById('select-active-site');
if (selectActiveSiteEl) {
    selectActiveSiteEl.addEventListener('change', async (e) => {
        const siteId = e.target.value;
        if (!siteId) return;
        try {
            await apiFetch(`/api/sites/switch/${siteId}`, { method: 'POST' });
            fetchSites();
            loadPageData(currentActivePage);
            startPolling();
        } catch (err) {
            alert('ไม่สามารถสลับไซต์งานได้: ' + err.message);
        }
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

function configureMenuRoles(role) {
    // Hide all role-restricted menu items first
    document.getElementById('nav-hotspot').style.display = 'none';
    document.getElementById('nav-firewall').style.display = 'none';
    document.getElementById('nav-admins').style.display = 'none';
    document.getElementById('nav-settings').style.display = 'none';
    document.getElementById('nav-logs').style.display = 'none';
    
    if (role === 'admin') {
        document.getElementById('nav-hotspot').style.display = 'flex';
        document.getElementById('nav-firewall').style.display = 'flex';
        document.getElementById('nav-admins').style.display = 'flex';
        document.getElementById('nav-settings').style.display = 'flex';
        document.getElementById('nav-logs').style.display = 'flex';
    } else if (role === 'co-admin' || role === 'user') {
        document.getElementById('nav-hotspot').style.display = 'flex';
        document.getElementById('nav-firewall').style.display = 'flex';
    }
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
}

function stopPolling() {
    if (statsInterval) clearInterval(statsInterval);
    if (trafficInterval) clearInterval(trafficInterval);
    statsInterval = null;
    trafficInterval = null;
}

// ==========================================
// PAGE CONTROLLER
// ==========================================
function switchPage(targetPageId) {
    // Role protection guards
    const role = CURRENT_USER ? CURRENT_USER.role : 'user';
    if (role !== 'admin') {
        if (['page-admins', 'page-settings', 'page-logs'].includes(targetPageId)) {
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
        'page-hotspot': { title: 'จัดการ Hotspot', desc: 'ควบคุมระบบคูปองอินเตอร์เน็ตและผู้ใช้งานทั้งหมด' },
        'page-firewall': { title: 'จัดการบล็อกเว็บ (Firewall)', desc: 'เปิด/ปิดบล็อกบริการเครือข่ายสังคมออนไลน์ด้วยคลิกเดียว' },
        'page-admins': { title: 'ผู้ใช้งานระบบ Dashboard', desc: 'จัดการผู้ใช้งานและสิทธิ์การเข้าถึงแดชบอร์ด' },
        'page-settings': { title: 'จัดการไซต์งานเราท์เตอร์', desc: 'เพิ่ม แก้ไข และสลับเปลี่ยนไซต์งาน MikroTik แต่ละสาขา' },
        'page-logs': { title: 'ประวัติการทำงาน (Logs)', desc: 'แสดงบันทึกประวัติการเข้าใช้งานและจัดการระบบ' }
    };
    
    const info = titleMap[targetPageId] || { title: 'แดชบอร์ด', desc: '' };
    document.getElementById('page-title').textContent = info.title;
    document.getElementById('page-description').textContent = info.desc;
    
    // Fetch page data immediately on switch
    loadPageData(targetPageId);
}

function loadPageData(pageId) {
    if (pageId === 'page-overview') {
        // Polling will handle it
    } else if (pageId === 'page-hotspot') {
        loadHotspotTab(activeHotspotTab);
    } else if (pageId === 'page-firewall') {
        fetchFirewallStatus();
    } else if (pageId === 'page-admins') {
        fetchDashboardUsers();
    } else if (pageId === 'page-settings') {
        fetchSitesManagement();
    } else if (pageId === 'page-logs') {
        fetchSystemLogs();
    }
}

// ==========================================
// OVERVIEW - SYSTEM & TRAFFIC LOGIC
// ==========================================
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
        
        document.getElementById('stat-uptime').textContent = formatTime(status.uptime);
        document.getElementById('stat-model').textContent = status.model;
        
        updateTimer.innerHTML = `<i class="fa-solid fa-rotate"></i> อัปเดตล่าสุด: ${new Date().toLocaleTimeString()}`;
    } catch (err) {
        console.error(err);
        routerConnStatus.innerHTML = '<span class="status-dot status-offline"></span> Disconnected';
        // Clear card values
        document.getElementById('stat-cpu').textContent = '-';
        document.getElementById('stat-ram').textContent = '-';
        document.getElementById('stat-uptime').textContent = '-';
        document.getElementById('stat-model').textContent = 'Cannot Connect';
    }
}

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
    
    // Fetch tab-specific data
    if (tabId === 'tab-hotspot-active') {
        fetchActiveHotspotUsers();
    } else if (tabId === 'tab-hotspot-accounts') {
        fetchHotspotAccounts();
        fetchAutoCleanupConfig();
    } else if (tabId === 'tab-hotspot-profiles') {
        fetchHotspotProfiles();
    } else if (tabId === 'tab-hotspot-vouchers') {
        fetchProfilesToDropdown();
    }
}

// Tab: Active Hotspot Sessions
async function fetchActiveHotspotUsers() {
    try {
        const active = await apiFetch('/api/mikrotik/hotspot/active');
        const tbody = document.querySelector('#table-active-users tbody');
        tbody.innerHTML = '';
        
        if (active.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">ไม่มีผู้ใช้งานเชื่อมต่ออยู่ในขณะนี้</td></tr>';
            return;
        }
        
        active.forEach(item => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td><strong>${item.user}</strong></td>
                <td>${item.address}</td>
                <td><code style="color:var(--text-muted);">${item.macAddress}</code></td>
                <td><span class="badge badge-profile">${item.loginBy}</span></td>
                <td>${item.uptime}</td>
                <td>${formatBytes(item.bytesOut)}</td> <!-- Bytes Out = Bytes Downloaded by Client -->
                <td>${formatBytes(item.bytesIn)}</td>  <!-- Bytes In = Bytes Uploaded by Client -->
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
            btn.addEventListener('click', async (e) => {
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
    } catch (err) {
        document.querySelector('#table-active-users tbody').innerHTML = `<tr><td colspan="8" class="text-center text-danger">ผิดพลาด: ${err.message}</td></tr>`;
    }
}

// Tab: Registered Hotspot Accounts
async function fetchHotspotAccounts() {
    try {
        const users = await apiFetch('/api/mikrotik/hotspot/users');
        const tbody = document.querySelector('#table-hotspot-users tbody');
        tbody.innerHTML = '';
        
        const chkSelectAll = document.getElementById('chk-select-all-users');
        if (chkSelectAll) chkSelectAll.checked = false;

        if (users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="10" class="text-center text-muted">ไม่พบข้อมูลบัญชี Hotspot</td></tr>';
            return;
        }
        
        users.forEach(item => {
            const limitTimeText = item.limitUptime === '00:00:00' ? 'ไม่จำกัด' : item.limitUptime;
            const limitBytesText = item.limitBytesTotal === 0 ? 'ไม่จำกัด' : formatBytes(item.limitBytesTotal);
            
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td style="text-align:center;"><input type="checkbox" class="chk-user-select" data-item='${JSON.stringify(item).replace(/'/g, "&apos;")}'></td>
                <td><strong>${item.name}</strong></td>
                <td><code>${item.password || '(ไม่มี)'}</code></td>
                <td><span class="badge badge-profile">${item.profile}</span></td>
                <td>${limitTimeText}</td>
                <td>${limitBytesText}</td>
                <td>${item.uptime}</td>
                <td>${formatBytes(item.bytesOut + item.bytesIn)}</td>
                <td><span style="font-size:0.8rem;color:var(--text-muted);">${item.comment || '-'}</span></td>
                <td class="text-center">
                    <div style="display:flex; gap:6px; justify-content:center;">
                        <button class="btn btn-primary btn-sm btn-print-single-user" data-item='${JSON.stringify(item).replace(/'/g, "&apos;")}' title="พิมพ์คูปอง">
                            <i class="fa-solid fa-print"></i> พิมพ์
                        </button>
                        <button class="btn btn-secondary btn-sm btn-edit-hotspot" data-item='${JSON.stringify(item).replace(/'/g, "&apos;")}' title="แก้ไข">
                            <i class="fa-solid fa-pen-to-square"></i>
                        </button>
                        <button class="btn btn-danger btn-sm btn-del-hotspot" data-id="${item.id}" data-user="${item.name}" title="ลบ">
                            <i class="fa-solid fa-trash-can"></i>
                        </button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });
        
        // Bind Select All Checkbox
        if (chkSelectAll) {
            chkSelectAll.addEventListener('change', (e) => {
                document.querySelectorAll('.chk-user-select').forEach(chk => {
                    chk.checked = e.target.checked;
                });
            });
        }

        // Bind Print Single buttons
        document.querySelectorAll('.btn-print-single-user').forEach(btn => {
            btn.addEventListener('click', () => {
                const item = JSON.parse(btn.getAttribute('data-item'));
                openSinglePrintModal(item);
            });
        });

        // Bind Edit buttons
        document.querySelectorAll('.btn-edit-hotspot').forEach(btn => {
            btn.addEventListener('click', () => {
                const item = JSON.parse(btn.getAttribute('data-item'));
                openHotspotModal(item);
            });
        });
        
        // Bind Delete buttons
        document.querySelectorAll('.btn-del-hotspot').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-id');
                const username = btn.getAttribute('data-user');
                if (confirm(`คุณยืนยันต้องการลบบัญชีผู้ใช้ "${username}" ใช่หรือไม่?`)) {
                    try {
                        await apiFetch(`/api/mikrotik/hotspot/users/${id}`, { method: 'DELETE' });
                        fetchHotspotAccounts();
                    } catch (err) {
                        alert(err.message);
                    }
                }
            });
        });
    } catch (err) {
        document.querySelector('#table-hotspot-users tbody').innerHTML = `<tr><td colspan="10" class="text-center text-danger">ผิดพลาด: ${err.message}</td></tr>`;
    }
}

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
async function fetchAutoCleanupConfig() {
    try {
        const config = await apiFetch('/api/mikrotik/hotspot/cleanup-config');
        const toggle = document.getElementById('toggle-auto-cleanup');
        if (toggle) toggle.checked = config.autoCleanupExpired;
    } catch (e) {}
}

const toggleAutoCleanup = document.getElementById('toggle-auto-cleanup');
if (toggleAutoCleanup) {
    toggleAutoCleanup.addEventListener('change', async (e) => {
        try {
            await apiFetch('/api/mikrotik/hotspot/cleanup-config', {
                method: 'POST',
                body: JSON.stringify({ autoCleanupExpired: e.target.checked })
            });
        } catch (err) {
            alert(err.message);
            e.target.checked = !e.target.checked;
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


// Add/Edit Hotspot Account Modal Actions
const modalHotspot = document.getElementById('modal-hotspot');
const formHotspotUser = document.getElementById('form-hotspot-user');
const hotspotError = document.getElementById('hotspot-error');

function openHotspotModal(item = null) {
    fetchProfilesToDropdown();
    
    if (item) {
        document.getElementById('hotspot-modal-title').textContent = 'แก้ไขบัญชีผู้ใช้ Hotspot';
        document.getElementById('hotspot-user-id').value = item.id;
        document.getElementById('hotspot-name').value = item.name;
        document.getElementById('hotspot-name').readOnly = true; // RouterOS does not allow renaming easily
        document.getElementById('hotspot-password').value = item.password || '';
        document.getElementById('hotspot-profile').value = item.profile;
        document.getElementById('hotspot-limit-uptime').value = item.limitUptime === '00:00:00' ? '' : item.limitUptime;
        document.getElementById('hotspot-limit-bytes').value = item.limitBytesTotal === 0 ? '' : item.limitBytesTotal;
        document.getElementById('hotspot-comment').value = item.comment || '';
    } else {
        document.getElementById('hotspot-modal-title').textContent = 'เพิ่มผู้ใช้ Hotspot ใหม่';
        document.getElementById('hotspot-user-id').value = '';
        document.getElementById('hotspot-name').value = '';
        document.getElementById('hotspot-name').readOnly = false;
        document.getElementById('hotspot-password').value = '';
        document.getElementById('hotspot-profile').value = 'default';
        document.getElementById('hotspot-limit-uptime').value = '';
        document.getElementById('hotspot-limit-bytes').value = '';
        document.getElementById('hotspot-comment').value = '';
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
    
    const body = {
        name,
        password,
        profile,
        limitUptime: limitUptime || undefined,
        limitBytesTotal: limitBytesTotal ? parseInt(limitBytesTotal) : undefined,
        comment
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
    
    tableBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">กำลังโหลดข้อมูลไซต์งาน...</td></tr>`;
    try {
        const data = await apiFetch('/api/sites');
        currentSitesData = data;
        
        if (!data.sites || data.sites.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">ยังไม่มีไซต์งานในระบบ</td></tr>`;
            return;
        }
        
        tableBody.innerHTML = '';
        data.sites.forEach(site => {
            const isActive = site.id === data.activeSiteId;
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>
                    ${isActive 
                        ? `<span class="site-status-badge site-status-active"><i class="fa-solid fa-circle-check"></i> กำลังใช้งาน</span>` 
                        : `<span class="site-status-badge site-status-normal"><i class="fa-regular fa-circle"></i> ปิดใช้งาน</span>`}
                </td>
                <td><strong>${site.name}</strong></td>
                <td><code>${site.host}</code></td>
                <td>${site.port}</td>
                <td>${site.username}</td>
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

        // Bind Test buttons
        document.querySelectorAll('.btn-test-site-item').forEach(btn => {
            btn.addEventListener('click', async () => {
                const siteId = btn.getAttribute('data-id');
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
                try {
                    await apiFetch(`/api/mikrotik/test-connection?siteId=${siteId}`);
                    alert('การเชื่อมต่อสำเร็จ! เราท์เตอร์ตอบรับปกติ');
                } catch (err) {
                    alert(`เชื่อมต่อล้มเหลว: ${err.message}`);
                } finally {
                    btn.disabled = false;
                    btn.innerHTML = '<i class="fa-solid fa-plug"></i> ทดสอบ';
                }
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
        tableBody.innerHTML = `<tr><td colspan="6" class="text-center text-danger">ผิดพลาด: ${err.message}</td></tr>`;
    }
}

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

    const body = { name, host, port, username, connectionType, wireguardIp };
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
        const res = await apiFetch('/api/wireguard/generate-script', {
            method: 'POST',
            body: JSON.stringify({ wireguardIp, port, vpsPublicKey, clientPublicKey })
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

// Fetch and render system audit logs (Admin only)
async function fetchSystemLogs() {
    const tableBody = document.querySelector('#table-logs tbody');
    if (!tableBody) return;
    
    tableBody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">กำลังโหลดข้อมูลประวัติ...</td></tr>`;
    try {
        const logs = await apiFetch('/api/logs');
        if (logs.length === 0) {
            tableBody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">ไม่มีข้อมูลบันทึกประวัติในระบบ</td></tr>`;
            return;
        }
        tableBody.innerHTML = '';
        logs.forEach(log => {
            const tr = document.createElement('tr');
            
            // Format time nicely in user locale
            const dt = new Date(log.timestamp);
            const formattedTime = isNaN(dt) ? log.timestamp : dt.toLocaleString('th-TH');
            
            // Format actions with badges or styles
            let actionBadge = `<span class="badge badge-profile">${log.action}</span>`;
            if (log.action.includes('เพิ่ม')) {
                actionBadge = `<span class="badge" style="background-color: rgba(5, 150, 105, 0.1); color: var(--success); border: 1px solid rgba(5, 150, 105, 0.2);">${log.action}</span>`;
            } else if (log.action.includes('ลบ') || log.action.includes('เตะ')) {
                actionBadge = `<span class="badge" style="background-color: rgba(220, 38, 38, 0.1); color: var(--danger); border: 1px solid rgba(220, 38, 38, 0.2);">${log.action}</span>`;
            } else if (log.action.includes('บล็อก') || log.action.includes('ปิด') || log.action.includes('เปิด')) {
                actionBadge = `<span class="badge" style="background-color: rgba(217, 119, 6, 0.1); color: var(--warning); border: 1px solid rgba(217, 119, 6, 0.2);">${log.action}</span>`;
            } else if (log.action.includes('ระบบ') || log.action.includes('ตั้งค่า') || log.action.includes('เราท์เตอร์')) {
                actionBadge = `<span class="badge" style="background-color: rgba(79, 70, 229, 0.1); color: var(--primary); border: 1px solid rgba(79, 70, 229, 0.2);">${log.action}</span>`;
            }
            
            tr.innerHTML = `
                <td><strong>${formattedTime}</strong></td>
                <td><span class="badge badge-co-admin"><i class="fa-solid fa-user-shield"></i> ${log.username}</span></td>
                <td>${actionBadge}</td>
                <td>${log.details}</td>
            `;
            tableBody.appendChild(tr);
        });
    } catch (err) {
        tableBody.innerHTML = `<tr><td colspan="4" class="text-center text-danger">ไม่สามารถโหลดข้อมูลประวัติได้: ${err.message}</td></tr>`;
    }
}

// Logs refresh button click
const btnRefreshLogs = document.getElementById('btn-refresh-logs');
if (btnRefreshLogs) {
    btnRefreshLogs.addEventListener('click', fetchSystemLogs);
}

// ==========================================
// CORE BINDINGS & NAV CLICK EVENT HANDLERS
// ==========================================
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('login-username').value;
    const password = document.getElementById('login-password').value;
    
    const submitBtn = loginForm.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    loginError.style.display = 'none';
    
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
        loginError.textContent = err.message;
        loginError.style.display = 'block';
    } finally {
        submitBtn.disabled = false;
    }
});

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

// Sidebar menu clicks
document.querySelectorAll('.menu-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const targetPage = item.getAttribute('data-target');
        switchPage(targetPage);
        
        // Close sidebar drawer on mobile
        document.querySelector('.sidebar').classList.remove('active');
        document.querySelector('.sidebar-overlay').classList.remove('active');
    });
});

// Hotspot tabs clicks
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        e.preventDefault();
        const targetTab = btn.getAttribute('data-tab');
        loadHotspotTab(targetTab);
    });
});

// Logout click
document.getElementById('btn-logout').addEventListener('click', () => {
    if (confirm('คุณต้องการออกจากระบบแดชบอร์ดใช่หรือไม่?')) {
        logout();
    }
});

// Mobile menu toggles bindings
document.getElementById('btn-menu-toggle').addEventListener('click', () => {
    document.querySelector('.sidebar').classList.add('active');
    document.querySelector('.sidebar-overlay').classList.add('active');
});

document.getElementById('sidebar-overlay').addEventListener('click', () => {
    document.querySelector('.sidebar').classList.remove('active');
    document.querySelector('.sidebar-overlay').classList.remove('active');
});

// Initialize on page load
window.addEventListener('DOMContentLoaded', () => {
    initApp();
});
