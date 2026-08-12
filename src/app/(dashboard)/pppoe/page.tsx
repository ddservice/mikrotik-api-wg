'use client';

import React, { useState } from 'react';
import { DoorOpen, Zap, Lock, Unlock, Clock, Search, RefreshCw } from 'lucide-react';
import { PppoeUser } from '@/lib/types';

export default function PppoePage() {
  const [activeTab, setActiveTab] = useState<'accounts' | 'active' | 'profiles' | 'billing'>('accounts');
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<PppoeUser[]>([]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
          <DoorOpen className="w-6 h-6 text-indigo-400" />
          <span>จัดการระบบ PPPoE (Room Billing & Account Manager)</span>
        </h2>
        <p className="text-xs text-slate-400 mt-1">จัดการบัญชีห้องพัก, แพ็กเกจสปีดเน็ต และเช็กสถานะออนไลน์ล่าสุด</p>
      </div>

      {/* Navigation Tabs */}
      <div className="flex border-b border-slate-800 space-x-2">
        <button
          onClick={() => setActiveTab('accounts')}
          className={`px-4 py-2.5 text-xs font-semibold rounded-t-xl transition-all ${
            activeTab === 'accounts'
              ? 'bg-indigo-600 text-white shadow-lg'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
          }`}
        >
          🚪 บัญชีห้องพัก ({users.length})
        </button>
        <button
          onClick={() => setActiveTab('active')}
          className={`px-4 py-2.5 text-xs font-semibold rounded-t-xl transition-all ${
            activeTab === 'active'
              ? 'bg-indigo-600 text-white shadow-lg'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900'
          }`}
        >
          ⚡ สถานะออนไลน์ขณะนี้ (0)
        </button>
      </div>

      {/* Tab Content: Accounts */}
      {activeTab === 'accounts' && (
        <div className="rounded-2xl bg-slate-950/80 border border-slate-800/80 shadow-xl overflow-hidden">
          <div className="p-4 border-b border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="relative flex-1 max-w-md">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="ค้นหาห้องพัก, แพ็กเกจ..."
                className="w-full pl-10 pr-4 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-slate-300">
              <thead className="bg-slate-900/90 text-slate-400 uppercase tracking-wider text-[11px] font-semibold border-b border-slate-800">
                <tr>
                  <th className="px-5 py-3.5">ห้อง (Username)</th>
                  <th className="px-5 py-3.5">รหัสผ่าน</th>
                  <th className="px-5 py-3.5">แพ็กเกจ</th>
                  <th className="px-5 py-3.5">สถานะ & ออนไลน์ล่าสุด</th>
                  <th className="px-5 py-3.5">หมายเหตุ</th>
                  <th className="px-5 py-3.5 text-center">จัดการ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60">
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-5 py-12 text-center text-slate-500 font-medium">
                      ยังไม่มีข้อมูลบัญชีห้องพักในระบบ
                    </td>
                  </tr>
                ) : (
                  users.map((u) => (
                    <tr key={u.id} className="hover:bg-slate-900/50 transition-colors">
                      <td className="px-5 py-3.5 font-bold text-white">{u.name}</td>
                      <td className="px-5 py-3.5 font-mono text-indigo-300">{u.password || '••••••••'}</td>
                      <td className="px-5 py-3.5">
                        <span className="px-2.5 py-1 rounded-md bg-indigo-500/20 text-indigo-300 font-semibold text-[11px]">
                          {u.profile}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        {u.isOnline ? (
                          <span className="inline-flex items-center space-x-1.5 text-emerald-400 font-semibold">
                            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                            <span>ออนไลน์ขณะนี้ ({u.currentUptime})</span>
                          </span>
                        ) : (
                          <span className="text-slate-400 flex items-center space-x-1">
                            <Clock className="w-3.5 h-3.5 text-slate-500" />
                            <span>{u.lastLoggedOut || 'ไม่เคยออนไลน์'}</span>
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-slate-400">{u.comment || '-'}</td>
                      <td className="px-5 py-3.5 text-center space-x-2">
                        <button title="ระงับการใช้งาน" className="p-1.5 rounded-lg bg-rose-500/20 text-rose-400 hover:bg-rose-500/30">
                          <Lock className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
