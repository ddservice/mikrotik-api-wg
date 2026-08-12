'use client';

import React, { useState, useEffect } from 'react';
import {
  ShieldAlert,
  Code,
  CheckCircle,
  Lock,
  Copy,
  Plus,
  Trash2,
  Globe,
  Youtube,
  MessageCircle,
  Gamepad2,
  Ban,
  Video,
  Share2,
  Tv,
  Download,
  Cpu,
  Loader2
} from 'lucide-react';
import { FIREWALL_SERVICES } from '@/lib/firewall-services';

export default function FirewallPage() {
  const [status, setStatus] = useState<Record<string, { blocked: boolean }>>({});
  const [customRules, setCustomRules] = useState<Array<{ id: string; address: string }>>([]);
  const [newDomain, setNewDomain] = useState('');
  const [loading, setLoading] = useState(true);
  const [togglingKey, setTogglingKey] = useState<string | null>(null);
  const [addingDomain, setAddingDomain] = useState(false);
  const [showScriptModal, setShowScriptModal] = useState(false);
  const [copied, setCopied] = useState(false);

  const fetchStatusAndRules = async () => {
    try {
      const [resStatus, resRules] = await Promise.all([
        fetch('/api/mikrotik/firewall/status'),
        fetch('/api/mikrotik/firewall/custom-rules')
      ]);

      if (resStatus.ok) {
        const dataStatus = await resStatus.json();
        setStatus(dataStatus);
      }
      if (resRules.ok) {
        const dataRules = await resRules.json();
        setCustomRules(Array.isArray(dataRules) ? dataRules : []);
      }
    } catch (e) {
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatusAndRules();
  }, []);

  const handleToggle = async (key: string, currentBlocked: boolean) => {
    setTogglingKey(key);
    try {
      const res = await fetch('/api/mikrotik/firewall/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceKey: key, block: !currentBlocked }),
      });
      if (res.ok) {
        setStatus((prev) => ({
          ...prev,
          [key]: { ...prev[key], blocked: !currentBlocked },
        }));
      } else {
        const data = await res.json();
        alert(data.error || 'เกิดข้อผิดพลาดในการเปลี่ยนสถานะการบล็อก');
      }
    } catch (err: any) {
      alert('เกิดข้อผิดพลาดในการเชื่อมต่อเราท์เตอร์');
    } finally {
      setTogglingKey(null);
    }
  };

  const handleAddCustomDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newDomain) return;
    setAddingDomain(true);
    try {
      const res = await fetch('/api/mikrotik/firewall/custom-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: newDomain }),
      });
      if (res.ok) {
        setNewDomain('');
        fetchStatusAndRules();
      } else {
        const data = await res.json();
        alert(data.error || 'เกิดข้อผิดพลาดในการบล็อกโดเมน');
      }
    } catch (e) {
      alert('เกิดข้อผิดพลาดในการเชื่อมต่อเราท์เตอร์');
    } finally {
      setAddingDomain(false);
    }
  };

  const handleDeleteCustomDomain = async (id: string) => {
    try {
      const res = await fetch('/api/mikrotik/firewall/custom-rules', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        setCustomRules((prev) => prev.filter((item) => item.id !== id));
      }
    } catch (e) {
      alert('เกิดข้อผิดพลาดในการลบโดเมน');
    }
  };

  const securityScript = `# ==============================================================================
# Enterprise RouterOS v7+ Hardened Security Protection Preset (2026 Standard)
# Protection: WinBox/SSH Brute Force 3-Stage Auto-Blacklist, Open DNS Resolver DDoS Drop
# ==============================================================================

/ip firewall address-list
add list=brute_force_blacklist comment="Permanent 24h Brute-Force Blacklist"

/ip firewall filter
add chain=input action=drop connection-state=invalid comment="Drop Invalid Packets (Input)"
add chain=input action=drop src-address-list=brute_force_blacklist comment="Drop Brute-Force Blacklisted IPs (WinBox/SSH/Web/API)"

add chain=input action=add-src-to-address-list address-list=brute_force_blacklist address-list-timeout=1d protocol=tcp dst-port=22,8291,80,443,8728 src-address-list=bf_stage3 comment="Brute-Force Stage 3 -> Blacklist 24h"
add chain=input action=add-src-to-address-list address-list=bf_stage3 address-list-timeout=1m protocol=tcp dst-port=22,8291,80,443,8728 src-address-list=bf_stage2 comment="Brute-Force Stage 2 -> Stage 3"
add chain=input action=add-src-to-address-list address-list=bf_stage2 address-list-timeout=1m protocol=tcp dst-port=22,8291,80,443,8728 src-address-list=bf_stage1 comment="Brute-Force Stage 1 -> Stage 2"
add chain=input action=add-src-to-address-list address-list=bf_stage1 address-list-timeout=1m protocol=tcp dst-port=22,8291,80,443,8728 comment="Brute-Force Stage 1 Entry"

add chain=input action=drop protocol=udp dst-port=53 in-interface-list=WAN comment="Drop Open DNS Resolver WAN Amplification Attack UDP"
add chain=input action=drop protocol=tcp dst-port=53 in-interface-list=WAN comment="Drop Open DNS Resolver WAN Amplification Attack TCP"

:put "RouterOS v7+ Hardened Protection Rules Applied!"
`;

  const handleCopyScript = () => {
    navigator.clipboard.writeText(securityScript);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getServiceIcon = (key: string) => {
    switch (key) {
      case 'youtube': return Youtube;
      case 'line': return MessageCircle;
      case 'games': return Gamepad2;
      case 'ads': return Ban;
      case 'tiktok': return Video;
      case 'facebook': return Share2;
      case 'netflix': return Tv;
      case 'torrent': return Download;
      case 'crypto': return Cpu;
      default: return Globe;
    }
  };

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <ShieldAlert className="w-6 h-6 text-rose-600" />
            <span>จัดการความปลอดภัย & บล็อกเว็บ (Firewall Preset & Domain Rules)</span>
          </h2>
          <p className="text-xs text-slate-500 mt-1">เปิด-ปิดบล็อกแอปพลิเคชัน เว็บไซต์ยอดนิยม และตั้งค่าบล็อกโดเมนกำหนดเอง</p>
        </div>

        <button
          onClick={() => setShowScriptModal(true)}
          className="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-semibold shadow-md flex items-center space-x-2 transition-all"
        >
          <Code className="w-4 h-4 text-indigo-400" />
          <span>สคริปต์ความปลอดภัย RouterOS CLI</span>
        </button>
      </div>

      {/* 11 Preset Categories Grid */}
      <div className="space-y-3">
        <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">หมวดหมู่บล็อกเว็บและแอปยอดนิยม (Preset Rules)</h3>
        
        {loading ? (
          <div className="p-12 text-center bg-white border border-slate-200 rounded-2xl text-slate-400 font-medium">
            <Loader2 className="w-6 h-6 animate-spin mx-auto text-indigo-600 mb-2" />
            <span>กำลังโหลดสถานะ Firewall...</span>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Object.values(FIREWALL_SERVICES).map((svc) => {
              const Icon = getServiceIcon(svc.key);
              const isBlocked = status[svc.key]?.blocked || false;
              const isToggling = togglingKey === svc.key;

              return (
                <div
                  key={svc.key}
                  className={`p-4 rounded-2xl border bg-white shadow-sm flex items-center justify-between transition-all ${
                    isBlocked ? 'border-rose-200 ring-2 ring-rose-500/10' : 'border-slate-200'
                  }`}
                >
                  <div className="flex items-center space-x-3 truncate pr-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${
                      isBlocked ? 'bg-rose-500/10 text-rose-600' : 'bg-slate-100 text-slate-600'
                    }`}>
                      <Icon className="w-5 h-5" />
                    </div>
                    <div className="truncate">
                      <h4 className="font-bold text-xs text-slate-900 truncate">{svc.name}</h4>
                      <p className="text-[11px] text-slate-500 truncate">{svc.description}</p>
                    </div>
                  </div>

                  <button
                    onClick={() => handleToggle(svc.key, isBlocked)}
                    disabled={isToggling}
                    className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all shrink-0 flex items-center space-x-1.5 ${
                      isBlocked
                        ? 'bg-rose-600 hover:bg-rose-700 text-white shadow-md'
                        : 'bg-slate-100 hover:bg-slate-200 text-slate-700'
                    }`}
                  >
                    {isToggling && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                    <span>{isBlocked ? 'กำลังบล็อก' : 'อนุญาต'}</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Custom Domain Blacklist Manager */}
      <div className="p-6 bg-white border border-slate-200 rounded-2xl shadow-sm space-y-4">
        <div>
          <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
            <Globe className="w-4 h-4 text-indigo-600" />
            <span>บล็อกโดเมนกำหนดเอง (Custom Domain Blacklist)</span>
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">ระบุชื่อโดเมนเพื่อทำการสั่งบล็อกบน MikroTik โดยตรง (เช่น example.com)</p>
        </div>

        <form onSubmit={handleAddCustomDomain} className="flex items-center gap-3">
          <input
            type="text"
            required
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            placeholder="เช่น gambling-site.com หรือ unknown-ad.net"
            className="flex-1 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
          />
          <button
            type="submit"
            disabled={addingDomain}
            className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white font-semibold rounded-xl text-xs shadow-md flex items-center space-x-1.5 transition-all shrink-0"
          >
            {addingDomain ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            <span>เพิ่มโดเมนบล็อก</span>
          </button>
        </form>

        {/* Custom Rules List Table */}
        <div className="pt-2">
          {customRules.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-400 bg-slate-50 rounded-xl border border-slate-100">
              ยังไม่มีการเพิ่มรายการโดเมนบล็อกแบบกำหนดเอง
            </div>
          ) : (
            <div className="space-y-2">
              {customRules.map((rule) => (
                <div
                  key={rule.id}
                  className="p-3 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between text-xs"
                >
                  <span className="font-mono text-slate-800 font-medium">{rule.address}</span>
                  <button
                    onClick={() => handleDeleteCustomDomain(rule.id)}
                    className="p-1.5 text-rose-500 hover:bg-rose-50 rounded-lg transition-colors"
                    title="ลบรายการโดเมนนี้"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* RouterOS CLI Security Script Modal */}
      {showScriptModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-2xl max-w-2xl w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 pb-3">
              <h3 className="font-bold text-sm text-slate-900 flex items-center gap-2">
                <Code className="w-4 h-4 text-indigo-600" />
                <span>สคริปต์ RouterOS v7 Hardened Security Protection</span>
              </h3>
              <button onClick={() => setShowScriptModal(false)} className="text-slate-400 hover:text-slate-600 text-lg">
                &times;
              </button>
            </div>

            <textarea
              readOnly
              value={securityScript}
              className="w-full h-72 p-4 bg-slate-900 text-emerald-400 font-mono text-[11px] rounded-xl border border-slate-800 focus:outline-none leading-relaxed"
            />

            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setShowScriptModal(false)}
                className="px-4 py-2 bg-slate-100 text-slate-700 text-xs font-semibold rounded-xl"
              >
                ปิด
              </button>
              <button
                onClick={handleCopyScript}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white text-xs font-semibold rounded-xl flex items-center space-x-1.5 shadow-md"
              >
                {copied ? <CheckCircle className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                <span>{copied ? 'คัดลอกเรียบร้อยแล้ว!' : 'คัดลอกสคริปต์'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
