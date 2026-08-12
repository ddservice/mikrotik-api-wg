'use client';

import React from 'react';
import { Cpu, HardDrive, Clock, Ticket, DoorOpen, Activity, ArrowUpRight, ArrowDownLeft } from 'lucide-react';

export default function OverviewPage() {
  const stats = [
    { name: 'ผู้ใช้งาน Hotspot ออนไลน์', value: '0 คน', icon: Ticket, color: 'from-amber-500 to-amber-600' },
    { name: 'ห้อง PPPoE ออนไลน์', value: '0 ห้อง', icon: DoorOpen, color: 'from-emerald-500 to-emerald-600' },
    { name: 'การใช้งาน CPU', value: '4 %', icon: Cpu, color: 'from-indigo-500 to-indigo-600' },
    { name: 'การใช้งาน RAM / Memory', value: '28 MB', icon: HardDrive, color: 'from-sky-500 to-sky-600' },
  ];

  return (
    <div className="space-y-8">
      {/* Top Header Card */}
      <div className="p-6 rounded-2xl bg-gradient-to-r from-indigo-900/60 via-slate-900 to-slate-950 border border-slate-800 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight">ภาพรวมแดชบอร์ด (System Overview)</h2>
          <p className="text-xs text-slate-400 mt-1">ติดตามทราฟฟิกและสถานะเราท์เตอร์ MikroTik ในรูปแบบเรียลไทม์</p>
        </div>
        <div className="flex items-center space-x-2 text-xs bg-slate-950/80 px-4 py-2 rounded-xl border border-slate-800 text-slate-300">
          <Clock className="w-4 h-4 text-indigo-400" />
          <span>ระบบ Next.js 14+ พร้อมทำงาน</span>
        </div>
      </div>

      {/* Stat Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {stats.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.name} className="p-5 rounded-2xl bg-slate-950/80 border border-slate-800/80 shadow-lg relative overflow-hidden group hover:border-slate-700 transition-all">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium text-slate-400">{item.name}</p>
                  <h3 className="text-2xl font-bold text-white mt-1.5">{item.value}</h3>
                </div>
                <div className={`w-12 h-12 rounded-xl bg-gradient-to-br ${item.color} flex items-center justify-center shadow-lg text-white`}>
                  <Icon className="w-6 h-6" />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Traffic Monitoring Area */}
      <div className="p-6 rounded-2xl bg-slate-950/80 border border-slate-800/80 shadow-xl space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800/80 pb-4">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center border border-indigo-500/20">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">กราฟทราฟฟิกสด (Live Interface Traffic)</h3>
              <p className="text-xs text-slate-400">อัปเดตสปีดดาวน์โหลด / อัปโหลดทุก 2 วินาที</p>
            </div>
          </div>
          <div className="flex items-center space-x-4 text-xs font-semibold">
            <div className="flex items-center space-x-1.5 text-emerald-400">
              <ArrowDownLeft className="w-4 h-4" />
              <span>Download: 0.00 Mbps</span>
            </div>
            <div className="flex items-center space-x-1.5 text-sky-400">
              <ArrowUpRight className="w-4 h-4" />
              <span>Upload: 0.00 Mbps</span>
            </div>
          </div>
        </div>

        {/* Visual Stream Container */}
        <div className="h-64 rounded-xl bg-slate-900 border border-slate-800/80 flex items-center justify-center relative overflow-hidden">
          <div className="absolute inset-0 bg-[radial-gradient(#334155_1px,transparent_1px)] [background-size:16px_16px] opacity-20" />
          <div className="text-center relative z-10 space-y-2">
            <Activity className="w-10 h-10 text-indigo-400 animate-pulse mx-auto" />
            <p className="text-xs text-slate-400 font-medium">กำลังแสดงทราฟฟิกแบบเรียลไทม์ผ่าน WebSocket Connection</p>
          </div>
        </div>
      </div>
    </div>
  );
}
