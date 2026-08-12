'use client';

import React, { useState } from 'react';
import { Ticket, Download, Plus, RefreshCw, Search, Shield, Zap } from 'lucide-react';
import { HotspotUser } from '@/lib/types';

export default function HotspotPage() {
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<HotspotUser[]>([]);

  const handleExportCSV = () => {
    if (users.length === 0) {
      alert('ไม่มีข้อมูลบัญชี Hotspot ที่จะ Export');
      return;
    }

    const headers = ['Username', 'Password', 'Profile', 'Uptime Accumulated', 'Uptime Limit', 'Bytes Total', 'Bytes Limit', 'Comment', 'Status'];
    const rows = [headers];

    users.forEach(acc => {
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
    link.setAttribute('download', `hotspot_accounts_passwords_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            <Ticket className="w-6 h-6 text-amber-400" />
            <span>จัดการระบบ Hotspot (Hotspot Coupon Manager)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">สร้างคูปอง, ตั้งค่าโปรไฟล์ความเร็ว และพิมพ์บัตรคูปองอินเทอร์เน็ต</p>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={handleExportCSV}
            className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl text-xs font-semibold shadow-lg shadow-emerald-600/25 flex items-center space-x-2 transition-all active:scale-[0.98]"
          >
            <Download className="w-4 h-4" />
            <span>Export CSV (พร้อมรหัสผ่าน)</span>
          </button>

          <button
            className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-lg shadow-indigo-600/25 flex items-center space-x-2 transition-all active:scale-[0.98]"
          >
            <Plus className="w-4 h-4" />
            <span>เพิ่มคูปองใหม่</span>
          </button>
        </div>
      </div>

      {/* Main Table Card */}
      <div className="rounded-2xl bg-slate-950/80 border border-slate-800/80 shadow-xl overflow-hidden">
        {/* Toolbar */}
        <div className="p-4 border-b border-slate-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหาชื่อผู้ใช้, โปรไฟล์, หมายเหตุ..."
              className="w-full pl-10 pr-4 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div className="text-xs text-slate-400 font-medium">
            ทั้งหมด <span className="text-indigo-400 font-bold">{users.length}</span> บัญชี
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-900/90 text-slate-400 uppercase tracking-wider text-[11px] font-semibold border-b border-slate-800">
              <tr>
                <th className="px-5 py-3.5">ชื่อผู้ใช้ (Username)</th>
                <th className="px-5 py-3.5">รหัสผ่าน</th>
                <th className="px-5 py-3.5">โปรไฟล์</th>
                <th className="px-5 py-3.5">เวลาสะสม / จำกัด</th>
                <th className="px-5 py-3.5">เน็ตสะสม / จำกัด</th>
                <th className="px-5 py-3.5">หมายเหตุ</th>
                <th className="px-5 py-3.5 text-center">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {users.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-slate-500 font-medium">
                    ยังไม่มีข้อมูลคูปอง Hotspot ในระบบ
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr key={u.name} className="hover:bg-slate-900/50 transition-colors">
                    <td className="px-5 py-3.5 font-bold text-white">{u.name}</td>
                    <td className="px-5 py-3.5 font-mono text-indigo-300">{u.password || '-'}</td>
                    <td className="px-5 py-3.5">
                      <span className="px-2.5 py-1 rounded-md bg-indigo-500/20 text-indigo-300 font-semibold text-[11px]">
                        {u.profile}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">{u.uptime || '0s'} / {u['limit-uptime'] || 'Unlimited'}</td>
                    <td className="px-5 py-3.5">{u.bytesTotal || 0} / {u['limit-bytes-total'] || 'Unlimited'}</td>
                    <td className="px-5 py-3.5 text-slate-400">{u.comment || '-'}</td>
                    <td className="px-5 py-3.5 text-center space-x-2">
                      <button title="ต่ออายุ" className="p-1.5 rounded-lg bg-amber-500/20 text-amber-400 hover:bg-amber-500/30">
                        <Zap className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
