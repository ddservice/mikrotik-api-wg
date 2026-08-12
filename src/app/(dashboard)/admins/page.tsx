'use client';

import React, { useState } from 'react';
import { Users, Plus, Shield, ShieldCheck, UserCheck } from 'lucide-react';
import { DashboardUser } from '@/lib/types';

export default function AdminsPage() {
  const [users, setUsers] = useState<DashboardUser[]>([
    { id: '1', username: 'admin', name: 'System Administrator', role: 'admin', assignedSiteId: 'all' }
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            <Users className="w-6 h-6 text-indigo-400" />
            <span>ผู้ใช้งานระบบ Dashboard (User & Role Access Manager)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">จัดการบัญชีผู้ใช้งานระบบและกำหนดสิทธิ์เข้าถึง (Admin, Co-Admin, User)</p>
        </div>

        <button className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-lg shadow-indigo-600/25 flex items-center space-x-2">
          <Plus className="w-4 h-4" />
          <span>เพิ่มผู้ใช้ใหม่</span>
        </button>
      </div>

      <div className="rounded-2xl bg-slate-950/80 border border-slate-800/80 shadow-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-900 text-slate-400 uppercase tracking-wider text-[11px] font-semibold border-b border-slate-800">
              <tr>
                <th className="px-5 py-3.5">ชื่อผู้ใช้ (Username)</th>
                <th className="px-5 py-3.5">ชื่อ-นามสกุล / สตาฟฟ์</th>
                <th className="px-5 py-3.5">ระดับสิทธิ์ (Role)</th>
                <th className="px-5 py-3.5">ไซต์งานที่ดูแล</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {users.map((u) => (
                <tr key={u.id} className="hover:bg-slate-900/50">
                  <td className="px-5 py-3.5 font-bold text-white flex items-center gap-2">
                    <UserCheck className="w-4 h-4 text-emerald-400" />
                    <span>{u.username}</span>
                  </td>
                  <td className="px-5 py-3.5 text-slate-300">{u.name}</td>
                  <td className="px-5 py-3.5">
                    <span className="px-2.5 py-1 rounded-md bg-indigo-500/20 text-indigo-300 font-semibold text-[11px] uppercase">
                      {u.role}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-slate-400">ทุกสาขา (All Sites)</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
