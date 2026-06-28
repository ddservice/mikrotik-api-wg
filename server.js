const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const db = require('./db');
const RouterOSClient = require('./routeros');


const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory sessions store (token -> { user, expires })
const activeSessions = new Map();
const SESSION_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Middleware: Authentication
function requireAuth(allowedRoles = []) {
    return (req, res, next) => {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ error: 'Unauthorized: Missing token' });
        }
        
        const token = authHeader.substring(7);
        const session = activeSessions.get(token);
        
        if (!session) {
            return res.status(401).json({ error: 'Unauthorized: Invalid token' });
        }
        
        if (session.expires < Date.now()) {
            activeSessions.delete(token);
            return res.status(401).json({ error: 'Unauthorized: Token expired' });
        }
        
        // Refresh session expiry
        session.expires = Date.now() + SESSION_EXPIRY_MS;
        req.user = session.user;
        
        // Role check
        if (allowedRoles.length > 0 && !allowedRoles.includes(session.user.role)) {
            return res.status(403).json({ error: 'Forbidden: Insufficient privileges' });
        }
        
        next();
    };
}

// Router connection runner helper
async function executeOnRouter(fn, siteId) {
    const config = db.getConfig(siteId);
    if (!config.host || !config.username) {
        throw new Error(`Router connection (${config.name || 'Site'}) is not configured. Please setup Router Settings.`);
    }
    const client = new RouterOSClient(config.host, config.port, config.username, config.password);
    await client.connect();
    try {
        return await fn(client);
    } finally {
        client.close();
    }
}

// ==========================================
// Authentication APIs
// ==========================================

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
    }
    
    const user = db.authenticateUser(username, password);
    if (!user) {
        return res.status(400).json({ error: 'Invalid username or password' });
    }
    
    const token = crypto.randomBytes(32).toString('hex');
    activeSessions.set(token, {
        user,
        expires: Date.now() + SESSION_EXPIRY_MS
    });
    
    db.addLog(user.username, 'เข้าสู่ระบบ', 'ล็อกอินเข้าสู่หน้าจัดการสำเร็จ');
    res.json({ token, user });
});

app.post('/api/auth/logout', requireAuth(), (req, res) => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.substring(7);
        activeSessions.delete(token);
    }
    res.json({ success: true });
});

app.get('/api/auth/me', requireAuth(), (req, res) => {
    res.json({ user: req.user });
});

app.get('/api/logs', requireAuth(['admin']), (req, res) => {
    res.json(db.getLogs());
});

// ==========================================
// Dashboard Users CRUD APIs (Admin only)
// ==========================================

app.get('/api/users', requireAuth(['admin']), (req, res) => {
    const users = db.getUsers().map(u => ({
        id: u.id,
        username: u.username,
        role: u.role,
        name: u.name,
        assignedSiteId: u.assignedSiteId || 'all'
    }));
    res.json(users);
});

app.post('/api/users', requireAuth(['admin']), (req, res) => {
    const { username, password, role, name, assignedSiteId } = req.body;
    if (!username || !password || !role || !name) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    if (!['admin', 'co-admin', 'user'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
    }
    try {
        const newUser = db.addUser(username, password, role, name, assignedSiteId || 'all');
        db.addLog(req.user.username, 'เพิ่มบัญชีระบบ', 'เพิ่มบัญชี ' + username + ' (สิทธิ์: ' + role + ', ไซต์: ' + (assignedSiteId || 'all') + ')');
        res.status(201).json(newUser);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.put('/api/users/:id', requireAuth(['admin']), (req, res) => {
    const { username, password, role, name, assignedSiteId } = req.body;
    try {
        const updated = db.updateUser(req.params.id, { username, password, role, name, assignedSiteId });
        
        // If password changed or username changed, terminate that user's sessions
        for (const [token, session] of activeSessions.entries()) {
            if (session.user.id === req.params.id) {
                if (password || username || role || assignedSiteId !== undefined) {
                    activeSessions.delete(token); // Force log them out to re-authenticate
                } else if (name) {
                    session.user.name = name;
                }
            }
        }
        
        db.addLog(req.user.username, 'แก้ไขบัญชีระบบ', 'แก้ไขบัญชี ID ' + req.params.id + ' (ชื่อ: ' + (name || '') + ')');
        res.json(updated);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

app.delete('/api/users/:id', requireAuth(['admin']), (req, res) => {
    try {
        db.deleteUser(req.params.id);
        // Clean sessions
        for (const [token, session] of activeSessions.entries()) {
            if (session.user.id === req.params.id) {
                activeSessions.delete(token);
            }
        }
        db.addLog(req.user.username, 'ลบบัญชีระบบ', 'ลบบัญชี ID ' + req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// ==========================================
// Router Settings Configurations & Multi-Site APIs
// ==========================================

// Get all sites and active site ID (Filtered by user permission)
app.get('/api/sites', requireAuth(['admin', 'co-admin', 'user']), (req, res) => {
    const sitesData = db.getSites();
    if (req.user.role !== 'admin' && req.user.assignedSiteId && req.user.assignedSiteId !== 'all') {
        const allowedSite = sitesData.sites.find(s => s.id === req.user.assignedSiteId);
        return res.json({
            activeSiteId: req.user.assignedSiteId,
            sites: allowedSite ? [allowedSite] : []
        });
    }
    res.json(sitesData);
});

// Switch active site (Validated against assigned permission)
app.post('/api/sites/switch/:id', requireAuth(['admin', 'co-admin', 'user']), (req, res) => {
    if (req.user.role !== 'admin' && req.user.assignedSiteId && req.user.assignedSiteId !== 'all') {
        if (req.params.id !== req.user.assignedSiteId) {
            return res.status(403).json({ error: 'คุณไม่มีสิทธิ์สลับไปใช้งานไซต์งานนี้' });
        }
    }
    try {
        const activeSite = db.setActiveSite(req.params.id);
        db.addLog(req.user.username, 'สลับไซต์งาน', 'สลับไปใช้งานไซต์งาน: ' + activeSite.name);
        res.json({ success: true, activeSite });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});


// Helper for VPS WireGuard Peer Management
function cleanupVpsPeerByIp(wireguardIp) {
    if (!wireguardIp) return;
    try {
        const { execSync } = require('child_process');
        const dump = execSync('sudo wg show wg0 dump 2>/dev/null', { encoding: 'utf8' });
        const lines = dump.split('\n');
        const targetIpStr = wireguardIp.trim() + '/32';
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 4) {
                const pubKey = parts[0];
                const allowedIps = parts[3];
                if (allowedIps && allowedIps.includes(targetIpStr)) {
                    execSync(`sudo wg set wg0 peer "${pubKey}" remove 2>/dev/null || true`, { encoding: 'utf8' });
                }
            }
        }
    } catch (e) {
        console.error('Failed to cleanup VPS peer for IP:', wireguardIp, e.message);
    }
}

function registerVpsPeer(wireguardIp, clientPublicKey) {
    if (!wireguardIp || !clientPublicKey) return;
    cleanupVpsPeerByIp(wireguardIp);
    const { execSync } = require('child_process');
    const cmd = `sudo wg set wg0 peer "${clientPublicKey.trim()}" allowed-ips ${wireguardIp.trim()}/32 && sudo wg-quick save wg0 2>/dev/null || true`;
    execSync(cmd, { encoding: 'utf8' });
}

// Add new site (Admin only)
app.post('/api/sites', requireAuth(['admin']), (req, res) => {
    const { name, host, port, username, password, connectionType, wireguardIp, wireguardPublicKey } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Name is required' });
    }
    try {
        const newSite = db.addSite({ name, host, port, username, password, connectionType, wireguardIp, wireguardPublicKey });
        if (connectionType === 'wireguard' && wireguardPublicKey && wireguardIp) {
            try {
                registerVpsPeer(wireguardIp, wireguardPublicKey);
            } catch (wgErr) {}
        }
        db.addLog(req.user.username, 'เพิ่มไซต์งานใหม่', 'เพิ่มไซต์งาน ' + name + ' (IP: ' + newSite.host + ')');
        res.status(201).json(newSite);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Update site (Admin only)
app.put('/api/sites/:id', requireAuth(['admin']), (req, res) => {
    const { name, host, port, username, password, connectionType, wireguardIp, wireguardPublicKey } = req.body;
    try {
        const updated = db.updateSite(req.params.id, { name, host, port, username, password, connectionType, wireguardIp, wireguardPublicKey });
        if (connectionType === 'wireguard' && wireguardPublicKey && wireguardIp) {
            try {
                registerVpsPeer(wireguardIp, wireguardPublicKey);
            } catch (wgErr) {}
        }
        db.addLog(req.user.username, 'แก้ไขไซต์งาน', 'แก้ไขข้อมูลไซต์งาน: ' + updated.name);
        res.json(updated);
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Generate WireGuard Setup Script for MikroTik
app.post('/api/wireguard/generate-script', requireAuth(['admin']), (req, res) => {
    const { wireguardIp, vpsPublicKey, clientPublicKey } = req.body;
    const targetIp = wireguardIp || '10.10.88.2';
    let autoRegistered = false;

    if (clientPublicKey && clientPublicKey.trim()) {
        try {
            registerVpsPeer(targetIp, clientPublicKey);
            autoRegistered = true;
            db.addLog(req.user.username, 'ลงทะเบียน WireGuard Peer อัตโนมัติ', `ลงทะเบียนคีย์สำหรับ IP ${targetIp}`);
        } catch (e) {}
    }
    
    let pubKey = vpsPublicKey;
    if (!pubKey) {
        try {
            const { execSync } = require('child_process');
            pubKey = execSync('wg show wg0 public-key 2>/dev/null || sudo wg show wg0 public-key 2>/dev/null', { encoding: 'utf8' }).trim();
        } catch (e) {}
    }
    if (!pubKey) {
        try {
            const candidatePaths = [
                '/etc/wireguard/publickey',
                path.join(__dirname, 'vps_publickey.txt'),
                path.join(__dirname, 'publickey')
            ];
            for (const p of candidatePaths) {
                if (fs.existsSync(p)) {
                    pubKey = fs.readFileSync(p, 'utf8').trim();
                    if (pubKey) break;
                }
            }
        } catch (e) {
            console.error('Failed to read VPS public key:', e.message);
        }
    }
    if (!pubKey) {
        pubKey = 'RROe/+EO47I8EntyxINUgX8Q/LExWC9rzFBBgvdIICE=';
    }

    const script = `# ======================================================
# MikroTik RouterOS WireGuard Setup Script (MT Management)
# Targeted IP: ${targetIp}
# VPS Endpoint: 157.85.108.84:51820
# ======================================================

# 1. Clear existing interface if any
/interface/wireguard/remove [find name=wg-gatekeeper]

# 2. Add WireGuard interface
/interface/wireguard/add name=wg-gatekeeper listen-port=13231 comment="MT Management WireGuard"

# 3. Add IP Address
/ip/address/add address=${targetIp}/24 interface=wg-gatekeeper comment="WireGuard VPN IP"

# 4. Add VPS Server Peer
/interface/wireguard/peers/add interface=wg-gatekeeper endpoint-address="157.85.108.84" endpoint-port=51820 allowed-address=10.10.88.0/24 persistent-keepalive=25s comment="VPS Hub Server" public-key="${pubKey}"

# 5. Display Result
:put "--------------------------------------------------------"
:put "WireGuard Interface Setup Successfully!"
:put "Your Router WireGuard Public Key is:"
:put [/interface/wireguard/get [find name=wg-gatekeeper] public-key]
:put "--------------------------------------------------------"
`;

    res.json({ script, wireguardIp: targetIp, autoRegistered });
});

// Register MikroTik Peer into VPS WireGuard automatically
app.post('/api/wireguard/register-peer', requireAuth(['admin']), (req, res) => {
    const { clientPublicKey, wireguardIp } = req.body;
    if (!clientPublicKey || !wireguardIp) {
        return res.status(400).json({ error: 'Client Public Key and WireGuard IP are required' });
    }
    try {
        registerVpsPeer(wireguardIp, clientPublicKey);
        db.addLog(req.user.username, 'ลงทะเบียน WireGuard Peer', `ลงทะเบียนคีย์สำหรับ IP ${wireguardIp}`);
        res.json({ success: true, message: 'ลงทะเบียน Peer บน VPS สำเร็จ (พร้อมล้างค่าคีย์เก่า)' });
    } catch (err) {
        res.status(500).json({ error: `ไม่สามารถลงทะเบียน Peer บน VPS ได้: ${err.message}` });
    }
});

// Remove Peer from VPS WireGuard manually
app.post('/api/wireguard/remove-peer', requireAuth(['admin']), (req, res) => {
    const { wireguardIp } = req.body;
    if (!wireguardIp) {
        return res.status(400).json({ error: 'WireGuard IP is required' });
    }
    try {
        cleanupVpsPeerByIp(wireguardIp);
        const { execSync } = require('child_process');
        execSync('sudo wg-quick save wg0 2>/dev/null || true', { encoding: 'utf8' });
        db.addLog(req.user.username, 'ลบ WireGuard Peer', `ลบ Peer สำหรับ IP ${wireguardIp} บน VPS`);
        res.json({ success: true, message: `ล้างค่า WireGuard Peer สำหรับ IP ${wireguardIp} บน VPS เรียบร้อยแล้ว` });
    } catch (err) {
        res.status(500).json({ error: `ไม่สามารถล้างค่า Peer บน VPS ได้: ${err.message}` });
    }
});

// Generate Uninstall Script for MikroTik
app.post('/api/wireguard/generate-uninstall-script', requireAuth(['admin']), (req, res) => {
    const script = `# ======================================================
# MikroTik RouterOS WireGuard Clean-up / Uninstall Script
# ======================================================

# 1. Remove WireGuard Interface and associated IPs/Peers
/interface/wireguard/remove [find name=wg-gatekeeper]
/ip/address/remove [find comment="WireGuard VPN IP"]

:put "--------------------------------------------------------"
:put "WireGuard Interface & Configuration Removed Successfully!"
:put "--------------------------------------------------------"
`;
    res.json({ script });
});



// Delete site (Admin only)
app.delete('/api/sites/:id', requireAuth(['admin']), (req, res) => {
    try {
        db.deleteSite(req.params.id);
        db.addLog(req.user.username, 'ลบไซต์งาน', 'ลบไซต์งาน ID: ' + req.params.id);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// Legacy single config endpoints (backward compatible)
app.get('/api/config', requireAuth(['admin']), (req, res) => {
    const config = db.getConfig();
    res.json({
        host: config.host,
        port: config.port,
        username: config.username,
        hasPassword: !!config.password
    });
});

app.post('/api/config', requireAuth(['admin']), (req, res) => {
    const { host, port, username, password } = req.body;
    if (!host || !username) {
        return res.status(400).json({ error: 'Host and Username are required' });
    }
    const existingConfig = db.getConfig();
    const newConfig = {
        host,
        port: parseInt(port) || 8728,
        username,
        password: password !== undefined ? password : existingConfig.password
    };
    db.saveConfig(newConfig);
    db.addLog(req.user.username, 'ตั้งค่าเราท์เตอร์', 'อัปเดตข้อมูลเชื่อมโยงเราท์เตอร์ IP: ' + host);
    res.json({ success: true });
});

// ==========================================
// MikroTik Router API Proxy Routes
// ==========================================

// Check router connection test (supports ?siteId=)
app.get('/api/mikrotik/test-connection', requireAuth(['admin']), async (req, res) => {
    const siteId = req.query.siteId;
    try {
        await executeOnRouter(async (client) => {
            await client.exec('/system/resource/print');
        }, siteId);
        res.json({ success: true, message: 'Connected successfully' });
    } catch (err) {
        res.status(500).json({ error: `Connection failed: ${err.message}` });
    }
});

// 1. Overview System Resource status
app.get('/api/mikrotik/status', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const stats = await executeOnRouter(async (client) => {
            const resources = await client.exec('/system/resource/print');
            const routerboard = await client.exec('/system/routerboard/print');
            
            const r = resources[0] || {};
            const rb = routerboard[0] || {};
            
            return {
                uptime: r.uptime || 'N/A',
                version: r.version || 'N/A',
                cpuLoad: r['cpu-load'] ? `${r['cpu-load']}%` : 'N/A',
                freeMemory: r['free-memory'] ? parseInt(r['free-memory']) : 0,
                totalMemory: r['total-memory'] ? parseInt(r['total-memory']) : 0,
                cpu: r.cpu || 'N/A',
                boardName: r['board-name'] || 'N/A',
                model: rb.model || r['board-name'] || 'MikroTik Router',
                serialNumber: rb['serial-number'] || 'N/A'
            };
        });
        res.json(stats);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 2. Read interface list and stats (for real-time traffic graph)
app.get('/api/mikrotik/interfaces', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const interfaces = await executeOnRouter(async (client) => {
            const list = await client.exec('/interface/print');
            return list.map(item => ({
                id: item['.id'],
                name: item.name,
                type: item.type,
                running: item.running === 'true',
                disabled: item.disabled === 'true',
                // Accumulative stats (in bytes)
                rxByte: parseInt(item['rx-byte']) || 0,
                txByte: parseInt(item['tx-byte']) || 0,
                comment: item.comment || ''
            }));
        });
        res.json(interfaces);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// Hotspot Management APIs (Admin and Co-Admin)
// ==========================================

// Read Hotspot users
app.get('/api/mikrotik/hotspot/users', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const users = await executeOnRouter(async (client) => {
            const list = await client.exec('/ip/hotspot/user/print');
            return list.map(item => {
                let userPassword = item.password || item['plain-password'] || item.pass || item.secret || '';
                if (!userPassword) {
                    for (const k of Object.keys(item)) {
                        if (k.toLowerCase().includes('pass') || k.toLowerCase().includes('secret') || k.toLowerCase().includes('pwd')) {
                            if (item[k]) {
                                userPassword = item[k];
                                break;
                            }
                        }
                    }
                }
                return {
                    id: item['.id'],
                    name: item.name,
                    password: userPassword,
                    profile: item.profile,
                    uptime: item.uptime || '0s',
                    bytesIn: parseInt(item['bytes-in']) || 0,
                    bytesOut: parseInt(item['bytes-out']) || 0,
                    limitUptime: item['limit-uptime'] || 'Unlimited',
                    limitBytesTotal: parseInt(item['limit-bytes-total']) || 0,
                    disabled: item.disabled === 'true',
                    comment: item.comment || ''
                };
            });
        });
        res.json(users);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// Create Hotspot user
app.post('/api/mikrotik/hotspot/users', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const { name, password, profile, limitUptime, limitBytesTotal, comment } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Username is required' });
    }
    
    try {
        const result = await executeOnRouter(async (client) => {
            const params = {
                name,
                password: password || '',
                profile: profile || 'default',
                comment: comment || 'Added by Web Dashboard'
            };
            if (limitUptime) params['limit-uptime'] = limitUptime;
            if (limitBytesTotal) params['limit-bytes-total'] = limitBytesTotal;
            
            return await client.exec('/ip/hotspot/user/add', params);
        });
        db.addLog(req.user.username, 'เพิ่มบัญชี Hotspot', 'เพิ่มผู้ใช้ ' + name + ' (โปรไฟล์: ' + profile + ')');
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Edit Hotspot user
app.put('/api/mikrotik/hotspot/users/:id', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const { name, password, profile, limitUptime, limitBytesTotal, comment } = req.body;
    try {
        const result = await executeOnRouter(async (client) => {
            const params = {
                '.id': req.params.id,
                name,
                profile: profile || 'default',
                comment: comment || ''
            };
            if (password !== undefined) params.password = password;
            
            // Set limit properties (empty value removes limits in RouterOS depending on version,
            // but setting limit-uptime="0" or "00:00:00" might clear it, or leaving it out is standard)
            params['limit-uptime'] = limitUptime || '00:00:00';
            params['limit-bytes-total'] = limitBytesTotal || 0;

            return await client.exec('/ip/hotspot/user/set', params);
        });
        db.addLog(req.user.username, 'แก้ไขบัญชี Hotspot', 'แก้ไขผู้ใช้ ID: ' + req.params.id + ' เป็นชื่อ ' + name + ' (โปรไฟล์: ' + profile + ')');
        res.json({ success: true, result });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete Hotspot user
app.delete('/api/mikrotik/hotspot/users/:id', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        await executeOnRouter(async (client) => {
            await client.exec('/ip/hotspot/user/remove', { '.id': req.params.id });
        });
        db.addLog(req.user.username, 'ลบบัญชี Hotspot', 'ลบผู้ใช้ ID: ' + req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Read Hotspot active sessions
app.get('/api/mikrotik/hotspot/active', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const active = await executeOnRouter(async (client) => {
            const list = await client.exec('/ip/hotspot/active/print');
            return list.map(item => ({
                id: item['.id'],
                user: item.user,
                address: item.address,
                macAddress: item['mac-address'],
                uptime: item.uptime || '0s',
                bytesIn: parseInt(item['bytes-in']) || 0,
                bytesOut: parseInt(item['bytes-out']) || 0,
                loginBy: item['login-by'] || ''
            }));
        });
        res.json(active);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Kick Active User
app.delete('/api/mikrotik/hotspot/active/:id', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        await executeOnRouter(async (client) => {
            await client.exec('/ip/hotspot/active/remove', { '.id': req.params.id });
        });
        db.addLog(req.user.username, 'เตะผู้ใช้ Hotspot', 'ตัดการเชื่อมต่อเซสชัน ID: ' + req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Read User Profiles
app.get('/api/mikrotik/hotspot/profiles', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const profiles = await executeOnRouter(async (client) => {
            const list = await client.exec('/ip/hotspot/user/profile/print');
            return list.map(item => ({
                id: item['.id'],
                name: item.name,
                sharedUsers: item['shared-users'] || '1',
                rateLimit: item['rate-limit'] || 'Unlimited',
                sessionTimeout: item['session-timeout'] || '00:00:00',
                idleTimeout: item['idle-timeout'] || 'none'
            }));
        });
        res.json(profiles);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create User Profile
app.post('/api/mikrotik/hotspot/profiles', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const { name, rateLimit, sharedUsers, sessionTimeout } = req.body;
    if (!name) {
        return res.status(400).json({ error: 'Profile name is required' });
    }
    try {
        await executeOnRouter(async (client) => {
            const params = {
                name,
                'shared-users': String(sharedUsers || '1')
            };
            if (rateLimit) params['rate-limit'] = rateLimit;
            if (sessionTimeout) params['session-timeout'] = sessionTimeout;
            await client.exec('/ip/hotspot/user/profile/add', params);
        });
        db.addLog(req.user.username, 'เพิ่มโปรไฟล์ Hotspot', 'เพิ่มโปรไฟล์ ' + name);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Edit User Profile
app.put('/api/mikrotik/hotspot/profiles/:id', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const { name, rateLimit, sharedUsers, sessionTimeout } = req.body;
    try {
        await executeOnRouter(async (client) => {
            const params = {
                '.id': req.params.id,
                name,
                'shared-users': String(sharedUsers || '1'),
                'rate-limit': rateLimit || '',
                'session-timeout': sessionTimeout || '00:00:00'
            };
            await client.exec('/ip/hotspot/user/profile/set', params);
        });
        db.addLog(req.user.username, 'แก้ไขโปรไฟล์ Hotspot', 'แก้ไขโปรไฟล์ ' + name);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete User Profile
app.delete('/api/mikrotik/hotspot/profiles/:id', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        await executeOnRouter(async (client) => {
            await client.exec('/ip/hotspot/user/profile/remove', { '.id': req.params.id });
        });
        db.addLog(req.user.username, 'ลบโปรไฟล์ Hotspot', 'ลบโปรไฟล์ ID: ' + req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// Helper for cleaning expired users
async function runExpiredCleanup(logUsername = 'System Auto') {
    return await executeOnRouter(async (client) => {
        const users = await client.exec('/ip/hotspot/user/print');
        const expired = [];
        
        for (const u of users) {
            const uptime = u.uptime || '0s';
            const limitUptime = u['limit-uptime'] || '';
            const bytesOut = parseInt(u['bytes-out']) || 0;
            const bytesIn = parseInt(u['bytes-in']) || 0;
            const totalBytes = bytesOut + bytesIn;
            const limitBytesTotal = parseInt(u['limit-bytes-total']) || 0;
            const comment = (u.comment || '').toLowerCase();

            let isExpired = false;
            if (comment.includes('expired') || comment.includes('หมดอายุ')) {
                isExpired = true;
            }
            if (limitUptime && limitUptime !== '00:00:00' && limitUptime !== '0s' && uptime === limitUptime) {
                isExpired = true;
            }
            if (limitBytesTotal > 0 && totalBytes >= limitBytesTotal) {
                isExpired = true;
            }

            if (isExpired) {
                expired.push({ id: u['.id'], name: u.name });
            }
        }

        for (const item of expired) {
            try {
                await client.exec('/ip/hotspot/user/remove', { '.id': item.id });
            } catch (e) {}
        }

        if (expired.length > 0) {
            db.addLog(logUsername, 'ลบคูปองหมดอายุ', `ลบผู้ใช้งานที่หมดอายุแล้วจำนวน ${expired.length} บัญชี`);
        }
        return expired.length;
    });
}

// Expired Cleanup Configuration APIs
app.get('/api/mikrotik/hotspot/cleanup-config', requireAuth(['admin', 'co-admin', 'user']), (req, res) => {
    res.json(db.getAutoCleanupConfig());
});

app.post('/api/mikrotik/hotspot/cleanup-config', requireAuth(['admin', 'co-admin', 'user']), (req, res) => {
    const { autoCleanupExpired } = req.body;
    const updated = db.saveAutoCleanupConfig({ autoCleanupExpired: !!autoCleanupExpired });
    db.addLog(req.user.username, 'ตั้งค่าลบคูปองหมดอายุ', `อัปเดตสถานะลบอัตโนมัติ: ${updated.autoCleanupExpired ? 'เปิด' : 'ปิด'}`);
    res.json(updated);
});

// Trigger Immediate Expired Cleanup
app.post('/api/mikrotik/hotspot/cleanup-expired', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const count = await runExpiredCleanup(req.user.username);
        res.json({ success: true, deletedCount: count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Automated background cleanup interval (every 30 minutes)
setInterval(async () => {
    try {
        const config = db.getAutoCleanupConfig();
        if (config && config.autoCleanupExpired) {
            await runExpiredCleanup('Auto Task');
        }
    } catch (e) {
        // Silent catch for background task
    }
}, 30 * 60 * 1000);


// Bulk Generate Hotspot Users (Vouchers)
app.post('/api/mikrotik/hotspot/generate', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const { prefix, qty, profile, limitUptime, limitBytesTotal, siteTitle, packageName, price, contact } = req.body;
    const quantity = parseInt(qty) || 10;
    if (quantity <= 0 || quantity > 100) {
        return res.status(400).json({ error: 'Quantity must be between 1 and 100' });
    }

    const generatedUsers = [];
    const charPool = 'abcdefghijklmnopqrstuvwxyz23456789'; // alphanumeric without confusing chars (1, l, 0, o)
    const genRandomString = (len) => {
        let str = '';
        for (let i = 0; i < len; i++) {
            str += charPool.charAt(Math.floor(Math.random() * charPool.length));
        }
        return str;
    };

    const runPrefix = prefix || '';

    try {
        await executeOnRouter(async (client) => {
            for (let i = 0; i < quantity; i++) {
                // Generate a random username and password (6 chars each)
                const username = runPrefix + genRandomString(5);
                const password = genRandomString(6);
                
                const params = {
                    name: username,
                    password: password,
                    profile: profile || 'default',
                    comment: `Generated by Web Dashboard (${new Date().toLocaleDateString()})`
                };
                
                if (limitUptime) params['limit-uptime'] = limitUptime;
                if (limitBytesTotal) params['limit-bytes-total'] = limitBytesTotal;
                
                await client.exec('/ip/hotspot/user/add', params);
                generatedUsers.push({
                    username,
                    password,
                    profile: profile || 'default',
                    limitUptime: limitUptime || '',
                    limitBytesTotal: limitBytesTotal || '',
                    siteTitle: siteTitle || '',
                    packageName: packageName || '',
                    price: price || '',
                    contact: contact || ''
                });
            }
        });
        db.addLog(req.user.username, 'สร้างคูปองกลุ่ม', 'สร้างคูปองจำนวน ' + quantity + ' ใบ (โปรไฟล์: ' + profile + ')');
        res.json({ success: true, users: generatedUsers });
    } catch (err) {
        res.status(500).json({ error: `Failed during bulk generate: ${err.message}. ${generatedUsers.length} users were created.` });
    }
});

// ==========================================
// Firewall Block/Unblock & Schedule APIs
// ==========================================

const FIREWALL_SERVICES = {
    youtube: {
        comment: 'Block YouTube (Dashboard)',
        listName: 'blocked_youtube',
        domains: ['youtube.com', 'youtu.be', 'googlevideo.com', 'ytimg.com']
    },
    line: {
        comment: 'Block LINE (Dashboard)',
        listName: 'blocked_line',
        domains: ['line.me', 'line-apps.com', 'line-cdn.net']
    },
    games: {
        comment: 'Block Mobile Games (Dashboard)',
        listName: 'blocked_games',
        domains: ['roblox.com', 'rbxcdn.com', 'garena.com', 'freefiremobile.com', 'pubgmobile.com', 'proxima-beta.com', 'hoyoverse.com', 'genshinimpact.com', 'supercell.com', 'clashofclans.com']
    },
    ads: {
        comment: 'Block Ads & Trackers (Dashboard)',
        listName: 'blocked_ads',
        domains: ['doubleclick.net', 'adservice.google.com', 'googlesyndication.com', 'adnxs.com', 'admob.com', 'criteo.com', 'taboola.com', 'outbrain.com', 'appsflyer.com']
    },
    tiktok: {
        comment: 'Block TikTok (Dashboard)',
        listName: 'blocked_tiktok',
        domains: ['tiktok.com', 'tiktokcdn.com', 'byteoversea.com', 'musical.ly']
    },
    facebook: {
        comment: 'Block Facebook & IG (Dashboard)',
        listName: 'blocked_facebook',
        domains: ['facebook.com', 'fbcdn.net', 'instagram.com', 'cdninstagram.com']
    },
    adult: {
        comment: 'Block Adult Content (Dashboard)',
        listName: 'blocked_adult',
        domains: ['pornhub.com', 'xvideos.com', 'xnxx.com', 'stripchat.com', 'xhamster.com']
    },
    netflix: {
        comment: 'Block Netflix & Streaming (Dashboard)',
        listName: 'blocked_netflix',
        domains: ['netflix.com', 'nflxext.com', 'nflxvideo.net', 'disneyplus.com', 'bamgrid.com', 'viu.com', 'wetv.vip']
    },
    torrent: {
        comment: 'Block BitTorrent & P2P (Dashboard)',
        listName: 'blocked_torrent',
        domains: ['torrent.com', 'bittorrent.com', 'thepiratebay.org', '1337x.to', 'rarbg.to', 'yts.mx']
    },
    steam: {
        comment: 'Block Steam & PC Gaming (Dashboard)',
        listName: 'blocked_steam',
        domains: ['steampowered.com', 'steamcommunity.com', 'steamgames.com', 'epicgames.com', 'unrealengine.com']
    },
    crypto: {
        comment: 'Block Crypto Miners & Malware (Dashboard)',
        listName: 'blocked_crypto',
        domains: ['coinhive.com', 'coin-hive.com', 'crypto-loot.com', 'jsecoin.com', 'minr.pw', 'coin-have.com']
    }
};

// Get block status & schedule for all services
app.get('/api/mikrotik/firewall/status', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const status = await executeOnRouter(async (client) => {
            const filterRules = await client.exec('/ip/firewall/filter/print');
            const result = {};
            
            for (const [key, svc] of Object.entries(FIREWALL_SERVICES)) {
                const rule = filterRules.find(r => r.comment === svc.comment);
                let timeStart = '';
                let timeEnd = '';
                if (rule && rule.time) {
                    const parts = rule.time.split('-');
                    if (parts.length === 2) {
                        timeStart = parts[0].substring(0, 5); // HH:MM
                        timeEnd = parts[1].substring(0, 5);   // HH:MM
                    }
                }
                const days = rule && rule.days ? rule.days.split(',') : [];
                
                result[key] = {
                    blocked: rule ? rule.disabled === 'false' : false,
                    scheduleEnabled: !!(rule && (rule.time || rule.days)),
                    timeStart,
                    timeEnd,
                    days
                };
            }
            
            return result;
        });
        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get custom address list rules
app.get('/api/mikrotik/firewall/custom-rules', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        const rules = await executeOnRouter(async (client) => {
            const addrLists = await client.exec('/ip/firewall/address-list/print');
            return addrLists.filter(item => item.list === 'blocked_custom').map(item => ({
                id: item['.id'],
                address: item.address,
                comment: item.comment || '',
                disabled: item.disabled === 'true'
            }));
        });
        res.json(rules);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add custom domain block rule
app.post('/api/mikrotik/firewall/custom-rules', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const { domain, note } = req.body;
    if (!domain || !domain.trim()) {
        return res.status(400).json({ error: 'Domain/IP is required' });
    }
    const cleanDomain = domain.trim().toLowerCase();
    try {
        await executeOnRouter(async (client) => {
            const listName = 'blocked_custom';
            const addrLists = await client.exec('/ip/firewall/address-list/print');
            const exists = addrLists.some(item => item.list === listName && item.address === cleanDomain);
            if (!exists) {
                await client.exec('/ip/firewall/address-list/add', {
                    list: listName,
                    address: cleanDomain,
                    comment: note ? `Custom: ${note}` : 'Custom Block (Dashboard)'
                });
            }
            
            // Ensure drop filter rule for custom list exists
            const filterRules = await client.exec('/ip/firewall/filter/print');
            const ruleComment = 'Block Custom Domains (Dashboard)';
            const ruleExists = filterRules.some(r => r.comment === ruleComment);
            if (!ruleExists) {
                await client.exec('/ip/firewall/filter/add', {
                    chain: 'forward',
                    action: 'drop',
                    'dst-address-list': listName,
                    comment: ruleComment,
                    disabled: 'no'
                });
            }
        });
        db.addLog(req.user.username, 'เพิ่มกฎบล็อกกำหนดเอง', `บล็อกโดเมน: ${cleanDomain}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Delete custom domain block rule
app.delete('/api/mikrotik/firewall/custom-rules/:id', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    try {
        await executeOnRouter(async (client) => {
            await client.exec('/ip/firewall/address-list/remove', { '.id': req.params.id });
        });
        db.addLog(req.user.username, 'ลบกฎบล็อกกำหนดเอง', `ลบกฎ ID: ${req.params.id}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Toggle blocks and update schedule
app.post('/api/mikrotik/firewall/toggle', requireAuth(['admin', 'co-admin', 'user']), async (req, res) => {
    const { service, block, scheduleEnabled, timeStart, timeEnd, days } = req.body;
    
    if (!FIREWALL_SERVICES[service]) {
        return res.status(400).json({ error: `Invalid service: ${service}` });
    }
    
    const svcConfig = FIREWALL_SERVICES[service];
    const targetBlockState = !!block;
    const ruleComment = svcConfig.comment;
    const listName = svcConfig.listName;
    const domains = svcConfig.domains;

    try {
        await executeOnRouter(async (client) => {
            const filterRules = await client.exec('/ip/firewall/filter/print');
            const existingRule = filterRules.find(r => r.comment === ruleComment);
            
            // Format schedule parameters
            const setParams = {
                disabled: targetBlockState ? 'no' : 'yes'
            };

            if (scheduleEnabled && timeStart && timeEnd) {
                setParams.time = `${timeStart}:00-${timeEnd}:00`;
            } else {
                setParams.time = '';
            }

            if (scheduleEnabled && Array.isArray(days) && days.length > 0) {
                setParams.days = days.join(',');
            } else {
                setParams.days = '';
            }

            if (existingRule) {
                setParams['.id'] = existingRule['.id'];
                await client.exec('/ip/firewall/filter/set', setParams);
            } else {
                if (targetBlockState) {
                    // Add address list items if needed
                    const addrLists = await client.exec('/ip/firewall/address-list/print');
                    for (const domain of domains) {
                        const exists = addrLists.some(item => item.list === listName && item.address === domain);
                        if (!exists) {
                            await client.exec('/ip/firewall/address-list/add', {
                                list: listName,
                                address: domain,
                                comment: 'Added by Web Dashboard'
                            });
                        }
                    }
                    
                    // Create filter rule
                    const addParams = {
                        chain: 'forward',
                        action: 'drop',
                        'dst-address-list': listName,
                        comment: ruleComment,
                        disabled: 'no'
                    };
                    if (scheduleEnabled && timeStart && timeEnd) {
                        addParams.time = `${timeStart}:00-${timeEnd}:00`;
                    }
                    if (scheduleEnabled && Array.isArray(days) && days.length > 0) {
                        addParams.days = days.join(',');
                    }

                    await client.exec('/ip/firewall/filter/add', addParams);
                }
            }
        });
        
        db.addLog(req.user.username, targetBlockState ? 'ตั้งค่าการบล็อก' : 'ปิดการบล็อก', `บริการ: ${service} (สเกดดูล: ${scheduleEnabled ? 'เปิด' : 'ปิด'})`);
        res.json({ success: true, blocked: targetBlockState });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start the server
app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

