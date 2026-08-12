'use client';

import React, { useState } from 'react';
import { Settings, Plus, Server, Key, ShieldCheck } from 'lucide-react';
import { Site } from '@/lib/types';

export default function SettingsPage() {
  const [sites, setSites] = useState<Site[]>([
    { id: 'site_1', name: 'สาขาหลัก (Main Site)', host: '10.10.88.2', port: 8728, username: 'admin', wireguardIp: '10.10.88.2', is_active: true }
  ]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            <Settings className="w-6 h-6 text-indigo-400" />
            <span>จัดการไซต์งานเราท์เตอร์ (Multi-Site Router Manager)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">เพิ่ม แก้ไข และสลับเปลี่ยนไซต์งาน MikroTik แต่ละสาขาผ่าน WireGuard VPN</p>
        </div>

        <button className="px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-lg shadow-indigo-600/25 flex items-center space-x-2">
          <Plus className="w-4 h-4" />
          <span>เพิ่มไซต์งานใหม่</span>
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {sites.map((site) => (
          <div key={site.id} className="p-5 rounded-2xl bg-slate-950/80 border border-slate-800/80 shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-indigo-500/20 text-indigo-400 flex items-center justify-center">
                  <Server className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-sm text-white">{site.name}</h3>
                  <span className="text-[11px] text-slate-400 font-mono">IP: {site.host || 'ยังไม่กำหนด'}</span>
                </div>
              </div>
              {site.is_active && (
                <span className="px-2.5 py-1 rounded-md bg-emerald-500/20 text-emerald-400 font-semibold text-[11px] flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  <span>กำลังใช้งาน</span>
                </span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs text-slate-300">
              <div>
                <span className="text-slate-400 block mb-0.5">WireGuard VPN IP:</span>
                <span className="font-mono text-indigo-300 font-bold">{site.wireguardIp || '10.10.88.2'}</span>
              </div>
              <div>
                <span className="text-slate-400 block mb-0.5">API Port:</span>
                <span className="font-mono">{site.port}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
