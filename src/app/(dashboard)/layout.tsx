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
  Wifi
} from 'lucide-react';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<any>(null);

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

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    router.push('/login');
  };

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
    <div className="min-h-screen flex bg-slate-900 text-slate-100">
      {/* Mobile Drawer Backdrop */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-slate-950/70 backdrop-blur-sm lg:hidden transition-opacity"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-50 w-72 bg-slate-950 border-r border-slate-800/80 flex flex-col transition-transform duration-300 ease-in-out ${
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        {/* Header Branding */}
        <div className="h-20 px-6 flex items-center justify-between border-b border-slate-800/80">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg shadow-indigo-600/30">
              <Server className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="font-bold text-sm text-white tracking-wide">MT Management</h2>
              <div className="flex items-center space-x-1.5 mt-0.5">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-[11px] text-slate-400 font-medium">Next.js Connected</span>
              </div>
            </div>
          </div>
          <button
            className="lg:hidden text-slate-400 hover:text-white p-2"
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
                    : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                }`}
              >
                <Icon className={`w-4 h-4 ${active ? 'text-white' : 'text-slate-400'}`} />
                <span>{item.name}</span>
              </Link>
            );
          })}
        </nav>

        {/* User Card & Logout */}
        <div className="p-4 m-4 rounded-xl bg-slate-900/80 border border-slate-800 flex items-center justify-between">
          <div className="truncate pr-2">
            <p className="text-xs font-semibold text-slate-200 truncate">{user?.name || user?.username || 'Admin'}</p>
            <span className="inline-block mt-0.5 px-2 py-0.5 text-[10px] font-bold tracking-wider rounded-md bg-indigo-500/20 text-indigo-400 uppercase">
              {user?.role || 'admin'}
            </span>
          </div>
          <button
            onClick={handleLogout}
            title="ออกจากระบบ"
            className="p-2 text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 bg-slate-900">
        {/* Top Navigation Bar */}
        <header className="h-20 px-6 lg:px-8 border-b border-slate-800/80 bg-slate-950/60 backdrop-blur-md flex items-center justify-between sticky top-0 z-30">
          <div className="flex items-center space-x-4">
            <button
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 text-slate-400 hover:text-white rounded-lg bg-slate-900 border border-slate-800"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div>
              <h1 className="text-lg font-bold text-white tracking-tight">MikroTik Enterprise Suite</h1>
              <p className="text-xs text-slate-400">Next.js 14+ TypeScript Architecture</p>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            <div className="hidden sm:flex items-center space-x-2 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-300">
              <Wifi className="w-4 h-4 text-emerald-400" />
              <span>MikroTik Active</span>
            </div>
          </div>
        </header>

        {/* Content Body */}
        <main className="flex-1 p-6 lg:p-8 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
