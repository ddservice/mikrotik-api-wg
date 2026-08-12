'use client';

import React, { useState, useEffect } from 'react';
import { Cpu, HardDrive, Clock, Ticket, DoorOpen, Activity, ArrowUpRight, ArrowDownLeft, Server, ShieldCheck, Loader2, Wifi } from 'lucide-react';

export default function OverviewPage() {
  const [status, setStatus] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/mikrotik/status');
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch (e) {
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const stats = [
    {
      name: 'ผู้ใช้งาน Hotspot ออนไลน์',
      value: loading ? '...' : `${status?.activeHotspot ?? 0} คน`,
      icon: Ticket,
      color: 'from-amber-500 to-amber-600',
    },
    {
      name: 'ห้อง PPPoE ออนไลน์',
      value: loading ? '...' : `${status?.activePppoe ?? 0} ห้อง`,
      icon: DoorOpen,
      color: 'from-emerald-500 to-emerald-600',
    },
    {
      name: 'การใช้งาน CPU',
      value: loading ? '...' : `${status?.cpuLoad ?? 0} %`,
      icon: Cpu,
      color: 'from-indigo-500 to-indigo-600',
    },
    {
      name: 'การใช้งาน Memory (RAM)',
      value: loading ? '...' : `${status?.memoryUsage ?? 0} %`,
      icon: HardDrive,
      color: 'from-sky-500 to-sky-600',
    },
  ];

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      {/* Top Header Card */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center space-x-4">
          <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${
            status?.connected ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' : 'bg-slate-100 text-slate-500'
          }`}>
            <Server className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
              <span>{status?.identity || 'MikroTik Router'}</span>
              {status?.connected && (
                <span className="px-2.5 py-0.5 rounded-full bg-emerald-50 text-emerald-600 border border-emerald-200 text-[11px] font-bold">
                  Online
                </span>
              )}
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              รุ่น {status?.model || 'MikroTik'} | RouterOS {status?.version || '-'} | Uptime: {status?.uptime || '0s'}
            </p>
          </div>
        </div>

        <div className="flex items-center space-x-2 text-xs bg-slate-50 px-4 py-2.5 rounded-xl border border-slate-200 text-slate-700 font-semibold">
          <Clock className="w-4 h-4 text-indigo-600" />
          <span>อัปเดตสถานะเรียลไทม์ทุก 5 วินาที</span>
        </div>
      </div>

      {/* Stat Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
        {stats.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.name} className="p-5 rounded-2xl bg-white border border-slate-200 shadow-sm relative overflow-hidden group hover:border-slate-300 transition-all">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold text-slate-500">{item.name}</p>
                  <h3 className="text-2xl font-bold text-slate-900 mt-1.5">{item.value}</h3>
                </div>
                <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${item.color} flex items-center justify-center shadow-md text-white`}>
                  <Icon className="w-6 h-6" />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Connection & System Status Overview */}
      <div className="p-6 rounded-2xl bg-white border border-slate-200 shadow-sm space-y-4">
        <div className="flex items-center justify-between border-b border-slate-100 pb-4">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-50 text-indigo-600 flex items-center justify-center border border-indigo-100">
              <Activity className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-900">สถานะการเชื่อมต่อเราท์เตอร์ (Router OS Live Status)</h3>
              <p className="text-xs text-slate-500">ตรวจสอบการส่งคำสั่ง API และสถานะระบบประมวลผล</p>
            </div>
          </div>

          <div className="flex items-center space-x-2 text-xs font-semibold">
            {loading ? (
              <div className="flex items-center space-x-1.5 text-slate-400">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>กำลังดึงข้อมูล...</span>
              </div>
            ) : status?.connected ? (
              <div className="flex items-center space-x-1.5 text-emerald-600 font-bold bg-emerald-50 px-3 py-1.5 rounded-lg border border-emerald-200">
                <ShieldCheck className="w-4 h-4" />
                <span>เชื่อมต่อ API สำเร็จ</span>
              </div>
            ) : (
              <div className="flex items-center space-x-1.5 text-rose-600 font-bold bg-rose-50 px-3 py-1.5 rounded-lg border border-rose-200">
                <Wifi className="w-4 h-4" />
                <span>ไม่สามารถเชื่อมต่อเราท์เตอร์ได้</span>
              </div>
            )}
          </div>
        </div>

        {status?.error && (
          <div className="p-4 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-xs font-medium">
            <span className="font-bold">รายละเอียดข้อผิดพลาด: </span>
            {status.error}
          </div>
        )}
      </div>
    </div>
  );
}
