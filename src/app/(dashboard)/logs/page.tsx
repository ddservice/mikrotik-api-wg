'use client';

import React, { useState } from 'react';
import { History, Search, FileText, Activity, Globe } from 'lucide-react';
import { ActivityLog } from '@/lib/types';

export default function LogsPage() {
  const [activeTab, setActiveTab] = useState<'activity' | 'traffic' | 'dns'>('activity');
  const [search, setSearch] = useState('');
  const [logs, setLogs] = useState<ActivityLog[]>([]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
          <History className="w-6 h-6 text-indigo-400" />
          <span>ประวัติการใช้งาน (Computer Crime Act Logs)</span>
        </h2>
        <p className="text-xs text-slate-400 mt-1">บันทึกกิจกรรมการใช้งานระบบและประวัติจราจรคอมพิวเตอร์ตาม พรบ. คอมพิวเตอร์ มาตรา 26</p>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-slate-800 space-x-2">
        <button
          onClick={() => setActiveTab('activity')}
          className={`px-4 py-2.5 text-xs font-semibold rounded-t-xl transition-all ${
            activeTab === 'activity' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <FileText className="w-4 h-4 inline mr-1.5" />
          ประวัติกิจกรรมผู้ดูแลระบบ
        </button>
        <button
          onClick={() => setActiveTab('traffic')}
          className={`px-4 py-2.5 text-xs font-semibold rounded-t-xl transition-all ${
            activeTab === 'traffic' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Activity className="w-4 h-4 inline mr-1.5" />
          ประวัติการเข้าใช้งานผู้ใช้
        </button>
        <button
          onClick={() => setActiveTab('dns')}
          className={`px-4 py-2.5 text-xs font-semibold rounded-t-xl transition-all ${
            activeTab === 'dns' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          <Globe className="w-4 h-4 inline mr-1.5" />
          ประวัติการเข้าเว็บ (DNS Query History)
        </button>
      </div>

      {/* Content Table */}
      <div className="rounded-2xl bg-slate-950/80 border border-slate-800/80 shadow-xl overflow-hidden">
        <div className="p-4 border-b border-slate-800/80">
          <div className="relative max-w-md">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="ค้นหาประวัติการใช้งาน..."
              className="w-full pl-10 pr-4 py-2 bg-slate-900 border border-slate-800 rounded-xl text-xs text-slate-200 focus:outline-none"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-900 text-slate-400 uppercase tracking-wider text-[11px] font-semibold border-b border-slate-800">
              <tr>
                <th className="px-5 py-3.5">วัน/เวลา</th>
                <th className="px-5 py-3.5">ผู้ดำเนินการ</th>
                <th className="px-5 py-3.5">กิจกรรม / Action</th>
                <th className="px-5 py-3.5">รายละเอียด</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-5 py-12 text-center text-slate-500 font-medium">
                    ยังไม่มีข้อมูลประวัติในหมวดหมู่นี้
                  </td>
                </tr>
              ) : (
                logs.map((l, idx) => (
                  <tr key={idx} className="hover:bg-slate-900/50">
                    <td className="px-5 py-3.5 text-slate-400 font-mono">{l.timestamp}</td>
                    <td className="px-5 py-3.5 font-bold text-white">{l.username}</td>
                    <td className="px-5 py-3.5 text-indigo-300 font-medium">{l.action}</td>
                    <td className="px-5 py-3.5 text-slate-300">{l.details}</td>
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
