'use client';

import React, { useState, useEffect } from 'react';
import { Settings, Plus, Server, ShieldCheck, Download, Loader2, HardDriveUpload, Check, Terminal, Copy } from 'lucide-react';
import { Site, SitesData } from '@/lib/types';

export default function SettingsPage() {
  const [sitesData, setSitesData] = useState<SitesData>({ activeSiteId: '', sites: [] });
  const [loading, setLoading] = useState(true);
  const [backupLoading, setBackupLoading] = useState(false);
  const [backupResult, setBackupResult] = useState<string | null>(null);

  // Modal for Add Site
  const [showAddModal, setShowAddModal] = useState(false);
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('8728');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [wireguardIp, setWireguardIp] = useState('10.10.88.2');

  // Modal for WireGuard Script
  const [showWgModal, setShowWgModal] = useState(false);
  const [wgScript, setWgScript] = useState('');
  const [wgLoading, setWgLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const fetchSites = async () => {
    try {
      const res = await fetch('/api/sites');
      const data = await res.json();
      if (res.ok && data.sites) {
        setSitesData(data);
      }
    } catch (e) {
      // Fallback
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSites();
  }, []);

  const handleCreateSite = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/sites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, host, port, username, password, wireguardIp }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาดในการสร้างไซต์งาน');
      setShowAddModal(false);
      setName('');
      fetchSites();
    } catch (err: any) {
      alert(err.message);
    }
  };

  const handleSetActiveSite = async (siteId: string) => {
    try {
      const res = await fetch('/api/sites/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId }),
      });
      if (res.ok) {
        setSitesData(prev => ({
          ...prev,
          activeSiteId: siteId,
          sites: prev.sites.map(s => ({ ...s, is_active: s.id === siteId })),
        }));
        window.location.reload();
      }
    } catch (e) {
      alert('เกิดข้อผิดพลาดในการเลือกไซต์งาน');
    }
  };

  const handleGenerateWgScript = async (site: Site) => {
    setWgLoading(true);
    setShowWgModal(true);
    setWgScript('');
    setCopied(false);
    try {
      const res = await fetch('/api/wireguard/generate-script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wireguardIp: site.wireguardIp || site.host || '10.10.88.2',
          port: site.port || 8728,
          siteId: site.id,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาดในการสร้างสคริปต์');
      setWgScript(data.script);
    } catch (err: any) {
      alert(err.message);
      setShowWgModal(false);
    } finally {
      setWgLoading(false);
    }
  };

  const handleCopyScript = () => {
    navigator.clipboard.writeText(wgScript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCreateBackup = async () => {
    setBackupLoading(true);
    setBackupResult(null);
    try {
      const res = await fetch('/api/backup/routeros', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาดในการสำรองข้อมูล');
      setBackupResult(data.message);
    } catch (err: any) {
      alert(err.message || 'เกิดข้อผิดพลาดในการสำรองข้อมูล');
    } finally {
      setBackupLoading(false);
    }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <Settings className="w-6 h-6 text-indigo-600" />
            <span>จัดการไซต์งานเราท์เตอร์ & WireGuard VPN</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1">สร้างสคริปต์เชื่อมต่อ WireGuard VPN, เพิ่ม แก้ไข และสลับไซต์งาน MikroTik แต่ละสาขา</p>
        </div>

        <button
          onClick={() => setShowAddModal(true)}
          className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-lg shadow-indigo-600/25 flex items-center space-x-2 transition-all"
        >
          <Plus className="w-4 h-4" />
          <span>เพิ่มไซต์งานใหม่</span>
        </button>
      </div>

      {/* RouterOS Config Backup Banner */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-sm space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100">
              <HardDriveUpload className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">ระบบสำรองข้อมูลเราท์เตอร์ RouterOS (Daily Config Backup)</h3>
              <p className="text-xs text-slate-500">สร้างไฟล์สำรองข้อมูล `.backup` และสคริปต์การตั้งค่าคงไว้เพื่อความปลอดภัย</p>
            </div>
          </div>
          <button
            onClick={handleCreateBackup}
            disabled={backupLoading}
            className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white rounded-xl text-xs font-semibold shadow-md flex items-center space-x-2 transition-all"
          >
            {backupLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            <span>{backupLoading ? 'กำลังสร้างไฟล์สำรอง...' : 'สำรองข้อมูลเดี๋ยวนี้'}</span>
          </button>
        </div>

        {backupResult && (
          <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-emerald-700 text-xs font-medium">
            {backupResult}
          </div>
        )}
      </div>

      {/* Site Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {sitesData.sites.length === 0 ? (
          <div className="col-span-2 p-12 text-center bg-white border border-slate-200 rounded-2xl text-slate-500 font-medium">
            ยังไม่มีข้อมูลไซต์งานในระบบ กดปุ่ม "เพิ่มไซต์งานใหม่" เพื่อเริ่มต้นตั้งค่า
          </div>
        ) : (
          sitesData.sites.map((site) => {
            const isActive = site.id === sitesData.activeSiteId;
            return (
              <div
                key={site.id}
                className={`p-5 rounded-2xl bg-white border shadow-sm space-y-4 transition-all ${
                  isActive ? 'border-indigo-500 ring-2 ring-indigo-500/20' : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <div className="flex items-center justify-between border-b border-slate-100 pb-3">
                  <div className="flex items-center space-x-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                      isActive ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600'
                    }`}>
                      <Server className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="font-bold text-sm text-slate-900">{site.name}</h3>
                      <span className="text-[11px] text-slate-500 font-mono">IP: {site.host || site.wireguardIp || '10.10.88.2'}</span>
                    </div>
                  </div>

                  {isActive ? (
                    <span className="px-2.5 py-1 rounded-md bg-emerald-50 text-emerald-600 font-bold text-[11px] flex items-center gap-1">
                      <ShieldCheck className="w-3.5 h-3.5" />
                      <span>กำลังใช้งาน</span>
                    </span>
                  ) : (
                    <button
                      onClick={() => handleSetActiveSite(site.id)}
                      className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-lg transition-colors"
                    >
                      เลือกใช้งานไซต์นี้
                    </button>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3 text-xs text-slate-600">
                  <div>
                    <span className="text-slate-400 block mb-0.5">WireGuard VPN IP:</span>
                    <span className="font-mono text-indigo-600 font-bold">{site.wireguardIp || '10.10.88.2'}</span>
                  </div>
                  <div>
                    <span className="text-slate-400 block mb-0.5">API Port:</span>
                    <span className="font-mono">{site.port || 8728}</span>
                  </div>
                </div>

                <div className="pt-2 border-t border-slate-100 flex items-center justify-between">
                  <button
                    onClick={() => handleGenerateWgScript(site)}
                    className="w-full px-3 py-2 bg-indigo-50 hover:bg-indigo-100 text-indigo-600 font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition-colors"
                  >
                    <Terminal className="w-4 h-4" />
                    <span>สร้างสคริปต์ WireGuard (RouterOS Setup Script)</span>
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* WireGuard Script Modal */}
      {showWgModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-2xl w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="font-bold text-sm text-slate-900 flex items-center gap-2">
                <Terminal className="w-5 h-5 text-indigo-600" />
                <span>RouterOS WireGuard VPN Setup Script</span>
              </h3>
              <button onClick={() => setShowWgModal(false)} className="text-slate-400 hover:text-slate-600 text-lg">
                &times;
              </button>
            </div>

            {wgLoading ? (
              <div className="p-12 text-center text-slate-500 space-y-3">
                <Loader2 className="w-8 h-8 animate-spin mx-auto text-indigo-600" />
                <p className="text-xs font-semibold">กำลังสร้างสคริปต์และสร้างคีย์การเชื่อมต่อ...</p>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-xs text-slate-600">
                  คัดลอกสคริปต์นี้ไปวางใน **Terminal ของ MikroTik** เพื่อตั้งค่าอินเทอร์เฟซ WireGuard และเชื่อมต่อกลับมายัง Dashboard อัตโนมัติ:
                </p>
                <div className="relative">
                  <textarea
                    readOnly
                    value={wgScript}
                    rows={12}
                    className="w-full p-4 bg-slate-900 text-emerald-400 font-mono text-[11px] rounded-xl focus:outline-none leading-relaxed"
                  />
                  <button
                    onClick={handleCopyScript}
                    className="absolute top-3 right-3 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold shadow-md flex items-center space-x-1.5 transition-all"
                  >
                    {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copied ? 'คัดลอกแล้ว!' : 'คัดลอกสคริปต์'}</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Add Site Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="font-bold text-sm text-slate-900">เพิ่มไซต์งานเราท์เตอร์ใหม่ (Add Router Site)</h3>
              <button onClick={() => setShowAddModal(false)} className="text-slate-400 hover:text-slate-600 text-lg">
                &times;
              </button>
            </div>

            <form onSubmit={handleCreateSite} className="space-y-4 text-xs">
              <div>
                <label className="block font-semibold text-slate-700 mb-1">ชื่อไซต์งาน / สาขา *</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="เช่น สาขาที่ 2 (Branch 2)"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Host / IP Address *</label>
                  <input
                    type="text"
                    required
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="10.10.88.3"
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">API Port *</label>
                  <input
                    type="number"
                    required
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Username *</label>
                  <input
                    type="text"
                    required
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-slate-700 mb-1">Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
              </div>

              <div className="flex justify-end space-x-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 bg-slate-100 text-slate-700 text-xs font-semibold rounded-xl"
                >
                  ยกเลิก
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-xl shadow-md"
                >
                  บันทึกไซต์งาน
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
