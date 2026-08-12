'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Ticket,
  DoorOpen,
  Network,
  ShieldAlert,
  History,
  Settings,
  Users,
  LogOut,
  Menu,
  X,
  Server,
  Wifi,
  ChevronDown,
  Sun,
  Moon,
  Check
} from 'lucide-react';
import { Site, SitesData } from '@/lib/types';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<any>(null);

  // Theme State: Default to 'light'
  const [darkMode, setDarkMode] = useState(false);

  // Site Selector State
  const [sitesData, setSitesData] = useState<SitesData>({ activeSiteId: '', sites: [] });
  const [siteDropdownOpen, setSiteDropdownOpen] = useState(false);
  const [switchingSite, setSwitchingSite] = useState(false);

  useEffect(() => {
    const storedUser = localStorage.getItem('user');
    const token = localStorage.getItem('token');
    if (!token || !storedUser) {
      router.push('/login');
    } else {
      try {
        setUser(JSON.parse(storedUser));
      } catch (e) {
        router.push('/login');
      }
    }
  }, [router]);

  // Fetch Sites Data
  const fetchSites = async () => {
    try {
      const res = await fetch('/api/sites');
      const data = await res.json();
      if (res.ok && data.sites) {
        setSitesData(data);
      }
    } catch (e) {
      // Fallback default
    }
  };

  useEffect(() => {
    fetchSites();
  }, []);

  const handleSelectSite = async (siteId: string) => {
    if (siteId === sitesData.activeSiteId) {
      setSiteDropdownOpen(false);
      return;
    }
    setSwitchingSite(true);
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
      alert('เกิดข้อผิดพลาดในการสลับไซต์งาน');
    } finally {
      setSwitchingSite(false);
      setSiteDropdownOpen(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    router.push('/login');
  };

  const activeSite = sitesData.sites.find(s => s.id === sitesData.activeSiteId) || sitesData.sites[0];

  const navItems = [
    { name: 'ข้อมูลทั่วไป (Overview)', path: '/overview', icon: LayoutDashboard },
    { name: 'จัดการระบบ Hotspot', path: '/hotspot', icon: Ticket },
    { name: 'จัดการระบบ PPPoE', path: '/pppoe', icon: DoorOpen },
    { name: 'จัดการ Multi-WAN', path: '/multiwan', icon: Network },
    { name: 'จัดการบล็อกเว็บ (Firewall)', path: '/firewall', icon: ShieldAlert },
    { name: 'ประวัติการใช้งาน (Log)', path: '/logs', icon: History },
    { name: 'จัดการไซต์งานเราท์เตอร์', path: '/settings', icon: Settings },
    { name: 'ผู้ใช้งานระบบ Dashboard', path: '/admins', icon: Users, adminOnly: true },
  ];

  return (
    <div className={`min-h-screen flex ${darkMode ? 'bg-slate-900 text-slate-100' : 'bg-slate-50 text-slate-800'}`}>
      {/* Mobile Drawer Backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/60 backdrop-blur-sm lg:hidden transition-opacity"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-50 w-72 flex flex-col transition-transform duration-300 ease-in-out border-r ${
          darkMode
            ? 'bg-slate-950 border-slate-800'
            : 'bg-white border-slate-200'
        } ${mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}
      >
        {/* Header Branding (Logo serves as Light/Dark Theme Switcher) */}
        <div className={`h-20 px-6 flex items-center justify-between border-b ${darkMode ? 'border-slate-800' : 'border-slate-200'}`}>
          <button
            onClick={() => setDarkMode(!darkMode)}
            title="คลิกที่โลโก้เพื่อสลับโหมดสว่าง / โหมดมืด (Light / Dark Mode)"
            className="flex items-center space-x-3 text-left group focus:outline-none"
          >
            <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-600/30 group-hover:scale-105 transition-transform">
              {darkMode ? <Sun className="w-5 h-5 text-amber-300" /> : <Server className="w-5 h-5 text-white" />}
            </div>
            <div>
              <h2 className={`font-bold text-sm tracking-wide ${darkMode ? 'text-white' : 'text-slate-900'}`}>MT Management</h2>
              <div className="flex items-center space-x-1.5 mt-0.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className={`text-[11px] font-medium ${darkMode ? 'text-slate-400' : 'text-slate-500'}`}>
                  {darkMode ? 'Dark Mode' : 'Light Mode (Default)'}
                </span>
              </div>
            </div>
          </button>

          <button
            className="lg:hidden text-slate-400 hover:text-slate-600 p-2"
            onClick={() => setMobileOpen(false)}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Nav Links */}
        <nav className="flex-1 px-4 py-6 space-y-1.5 overflow-y-auto">
          {navItems.map((item) => {
            if (item.adminOnly && user?.role !== 'admin') return null;
            const active = pathname === item.path;
            const Icon = item.icon;

            return (
              <Link
                key={item.path}
                href={item.path}
                onClick={() => setMobileOpen(false)}
                className={`flex items-center space-x-3 px-4 py-3 rounded-xl font-medium text-xs transition-all duration-200 ${
                  active
                    ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-600/25 font-semibold'
                    : darkMode
                    ? 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                    : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                }`}
              >
                <Icon className={`w-4 h-4 ${active ? 'text-white' : darkMode ? 'text-slate-400' : 'text-slate-500'}`} />
                <span>{item.name}</span>
              </Link>
            );
          })}
        </nav>

        {/* User Card & Logout */}
        <div className={`p-4 m-4 rounded-xl border flex items-center justify-between ${
          darkMode ? 'bg-slate-900 border-slate-800' : 'bg-slate-50 border-slate-200'
        }`}>
          <div className="truncate pr-2">
            <p className={`text-xs font-semibold truncate ${darkMode ? 'text-slate-200' : 'text-slate-900'}`}>
              {user?.name || user?.username || 'Admin'}
            </p>
            <span className="inline-block mt-0.5 px-2 py-0.5 text-[10px] font-bold tracking-wider rounded-md bg-indigo-500/10 text-indigo-600 uppercase">
              {user?.role || 'admin'}
            </span>
          </div>
          <button
            onClick={handleLogout}
            title="ออกจากระบบ"
            className="p-2 text-slate-400 hover:text-rose-500 hover:bg-rose-500/10 rounded-lg transition-colors"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Navigation Bar */}
        <header className={`h-20 px-6 lg:px-8 border-b backdrop-blur-md flex items-center justify-between sticky top-0 z-30 ${
          darkMode ? 'bg-slate-950/80 border-slate-800' : 'bg-white/80 border-slate-200'
        }`}>
          <div className="flex items-center space-x-4">
            <button
              onClick={() => setMobileOpen(true)}
              className={`lg:hidden p-2 rounded-lg border ${
                darkMode ? 'bg-slate-900 border-slate-800 text-slate-400' : 'bg-slate-100 border-slate-200 text-slate-600'
              }`}
            >
              <Menu className="w-5 h-5" />
            </button>

            <div>
              <h1 className={`text-base font-bold tracking-tight ${darkMode ? 'text-white' : 'text-slate-900'}`}>
                MikroTik Enterprise Suite
              </h1>
              <p className="text-xs text-slate-500">Next.js 14+ Light Default Architecture</p>
            </div>
          </div>

          {/* Site Selector Dropdown */}
          <div className="relative">
            <button
              onClick={() => setSiteDropdownOpen(!siteDropdownOpen)}
              className={`flex items-center space-x-2.5 px-4 py-2 rounded-xl border text-xs font-semibold transition-all ${
                darkMode
                  ? 'bg-slate-900 border-slate-800 text-slate-200 hover:border-slate-700'
                  : 'bg-white border-slate-200 text-slate-800 shadow-sm hover:border-slate-300'
              }`}
            >
              <Wifi className="w-4 h-4 text-emerald-500" />
              <span>{activeSite ? activeSite.name : 'เลือกไซต์งาน'}</span>
              <ChevronDown className={`w-3.5 h-3.5 text-slate-400 transition-transform ${siteDropdownOpen ? 'rotate-180' : ''}`} />
            </button>

            {/* Dropdown Options */}
            {siteDropdownOpen && (
              <div className={`absolute right-0 mt-2 w-64 rounded-2xl border shadow-2xl py-2 z-50 animate-in fade-in slide-in-from-top-2 ${
                darkMode ? 'bg-slate-900 border-slate-800 text-slate-200' : 'bg-white border-slate-200 text-slate-800'
              }`}>
                <div className="px-4 py-2 border-b border-slate-200 dark:border-slate-800 text-[11px] font-bold text-slate-400 uppercase tracking-wider">
                  เลือกไซต์งานเราท์เตอร์ (Switch Site)
                </div>
                {sitesData.sites.length === 0 ? (
                  <div className="px-4 py-3 text-xs text-slate-400">ยังไม่มีข้อมูลไซต์งาน</div>
                ) : (
                  sitesData.sites.map((site) => {
                    const isSelected = site.id === sitesData.activeSiteId;
                    return (
                      <button
                        key={site.id}
                        onClick={() => handleSelectSite(site.id)}
                        className={`w-full px-4 py-2.5 text-left text-xs flex items-center justify-between transition-colors ${
                          isSelected
                            ? 'bg-indigo-600/10 text-indigo-600 font-bold'
                            : darkMode
                            ? 'hover:bg-slate-800 text-slate-300'
                            : 'hover:bg-slate-50 text-slate-700'
                        }`}
                      >
                        <div className="truncate">
                          <p className="truncate font-semibold">{site.name}</p>
                          <span className="text-[10px] text-slate-400 font-mono">IP: {site.host || site.wireguardIp || '10.10.88.2'}</span>
                        </div>
                        {isSelected && <Check className="w-4 h-4 text-indigo-600 shrink-0 ml-2" />}
                      </button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </header>

        {/* Content Body */}
        <main className="flex-1 p-6 lg:p-8 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
