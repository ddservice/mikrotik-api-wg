'use client';

import React, { useState } from 'react';
import { Network, Plus, Trash2, Zap, Send, Code, CheckCircle } from 'lucide-react';
import { WanLine, PbrRule } from '@/lib/types';

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

export default function MultiWanPage() {
  const [wans, setWans] = useState<WanLine[]>([
    { id: 'wan_1', name: 'WAN 1', interface: 'pppoe-out1', type: 'pppoe', gateway: '', speed: 1000, weight: 2, dnsCheck: '8.8.8.8' },
    { id: 'wan_2', name: 'WAN 2', interface: 'ether2-WAN2', type: 'dhcp', gateway: '192.168.2.1', speed: 500, weight: 1, dnsCheck: '1.1.1.1' },
  ]);

  const [pbrRules, setPbrRules] = useState<PbrRule[]>([
    { id: 'pbr_1', srcInterface: 'vlan10-hotspot', targetWanNum: 1, note: 'vlan10-hotspot เจาะจงออก WAN 1 (pppoe-out1)' },
    { id: 'pbr_2', srcInterface: 'vlan20-pppoe', targetWanNum: 2, note: 'vlan20-pppoe เจาะจงออก WAN 2 (ether2-WAN2)' },
  ]);

  const [telegramToken, setTelegramToken] = useState('');
  const [telegramChatId, setTelegramChatId] = useState('');
  const [telegramMsgDown, setTelegramMsgDown] = useState('⚠️ [แจ้งเตือน] เน็ตสาย {WAN_NAME} ({INTERFACE}) IP: {GATEWAY} หลุดการเชื่อมต่อ! เวลา {TIME}');
  const [telegramMsgUp, setTelegramMsgUp] = useState('✅ [แจ้งเตือน] เน็ตสาย {WAN_NAME} ({INTERFACE}) IP: {GATEWAY} กลับมาใช้งานได้ตามปกติแล้ว! เวลา {TIME}');

  // Auto-calculate PCC Weights from Mbps speeds using Greatest Common Divisor (GCD)
  const recalculateWeights = (updatedWans: WanLine[]) => {
    const speeds = updatedWans.map(w => Number(w.speed) || 0);
    const validSpeeds = speeds.filter(s => s > 0);
    if (validSpeeds.length === 0) return updatedWans;

    let commonGcd = validSpeeds[0];
    for (let i = 1; i < validSpeeds.length; i++) {
      commonGcd = gcd(commonGcd, validSpeeds[i]);
    }

    return updatedWans.map(w => ({
      ...w,
      weight: w.speed > 0 ? Math.max(1, Math.round(w.speed / commonGcd)) : 1,
    }));
  };

  const handleSpeedChange = (index: number, speed: number) => {
    const newWans = [...wans];
    newWans[index].speed = speed;
    setWans(recalculateWeights(newWans));
  };

  const handleAddWan = () => {
    const num = wans.length + 1;
    const newWans = [
      ...wans,
      {
        id: `wan_${num}`,
        name: `WAN ${num}`,
        interface: `ether${num}`,
        type: 'dhcp' as const,
        gateway: `192.168.${num}.1`,
        speed: 500,
        weight: 1,
        dnsCheck: `8.8.8.${num}`,
      },
    ];
    setWans(recalculateWeights(newWans));
  };

  const handleRemoveWan = (index: number) => {
    if (wans.length <= 1) return;
    const updated = wans.filter((_, i) => i !== index).map((w, idx) => ({ ...w, name: `WAN ${idx + 1}` }));
    setWans(recalculateWeights(updated));
  };

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="p-6 rounded-2xl bg-gradient-to-r from-indigo-950 via-slate-900 to-slate-950 border border-slate-800 shadow-xl flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            <Network className="w-6 h-6 text-indigo-400" />
            <span>จัดการระบบ Multi-WAN & Load Balance (FortiGate Enterprise SD-WAN Standard)</span>
          </h2>
          <p className="text-xs text-slate-400 mt-1">ตั้งค่าสายสัญญาณอินเทอร์เน็ตไม่จำกัด (N-WAN), คำนวณ PCC ให้อัตโนมัติ และแยกทราฟฟิก PBR</p>
        </div>
      </div>

      {/* STEP 1: WAN Lines & Auto PCC Weights */}
      <div className="p-6 rounded-2xl bg-slate-950/80 border border-slate-800/80 shadow-xl space-y-6">
        <div className="flex items-center justify-between border-b border-slate-800/80 pb-4">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              <span>ขั้นตอนที่ 1: กำหนดสายสัญญาณอินเทอร์เน็ต (WAN Lines & PCC Weights)</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">ระบุความเร็ว (Mbps) ระบบจะคำนวณอัตราส่วน Weight (PCC) ให้อัตโนมัติผ่านสูตร GCD</p>
          </div>
          <button
            onClick={handleAddWan}
            className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-md flex items-center space-x-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>เพิ่มสาย WAN</span>
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {wans.map((wan, idx) => (
            <div key={wan.id} className="p-5 rounded-xl bg-slate-900 border border-slate-800 space-y-4">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <span className="font-bold text-sm text-white flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
                  <span>{wan.name} {idx === 0 ? '(Primary)' : ''}</span>
                </span>
                {wans.length > 1 && (
                  <button onClick={() => handleRemoveWan(idx)} className="text-rose-400 hover:text-rose-300 text-xs flex items-center gap-1">
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>ลบสาย</span>
                  </button>
                )}
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block text-slate-400 mb-1">Interface ราวเตอร์ *</label>
                  <input
                    type="text"
                    value={wan.interface}
                    onChange={(e) => {
                      const updated = [...wans];
                      updated[idx].interface = e.target.value;
                      setWans(updated);
                    }}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-white font-mono"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">ประเภทการเชื่อมต่อ *</label>
                  <select
                    value={wan.type}
                    onChange={(e) => {
                      const updated = [...wans];
                      updated[idx].type = e.target.value as any;
                      setWans(updated);
                    }}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-white"
                  >
                    <option value="pppoe">PPPoE Client</option>
                    <option value="dhcp">DHCP Client</option>
                    <option value="static">Static IP</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block text-slate-400 mb-1">ความเร็ว (Mbps)</label>
                  <input
                    type="number"
                    value={wan.speed}
                    onChange={(e) => handleSpeedChange(idx, Number(e.target.value))}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-amber-400 font-bold"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">อัตราส่วน Weight (PCC) [Auto]</label>
                  <input
                    type="number"
                    readOnly
                    value={wan.weight}
                    className="w-full px-3 py-2 bg-slate-800/80 border border-slate-700 rounded-lg text-indigo-300 font-bold"
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* STEP 2: Policy-Based Routing Rules */}
      <div className="p-6 rounded-2xl bg-slate-950/80 border border-slate-800/80 shadow-xl space-y-6">
        <div className="flex items-center justify-between border-b border-slate-800/80 pb-4">
          <div>
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <Network className="w-4 h-4 text-indigo-400" />
              <span>ขั้นตอนที่ 2: กำหนดการแยกทราฟฟิก (Interface-Based Policy Routing - PBR)</span>
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">เลือก Interface ขาเข้า และเลือกสาย WAN ขาออกที่ต้องการเจาะจง</p>
          </div>
          <button
            onClick={() => {
              const num = pbrRules.length + 1;
              setPbrRules([
                ...pbrRules,
                { id: `pbr_${num}`, srcInterface: `vlan${num * 10}`, targetWanNum: 1, note: `กฎ PBR ${num}` },
              ]);
            }}
            className="px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-md flex items-center space-x-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>เพิ่มกฎ PBR</span>
          </button>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs text-slate-300">
            <thead className="bg-slate-900 text-slate-400 uppercase tracking-wider text-[11px] font-semibold border-b border-slate-800">
              <tr>
                <th className="px-4 py-3">Source Interface / Subnet</th>
                <th className="px-4 py-3">เจาะจงออกสาย WAN</th>
                <th className="px-4 py-3">คำอธิบายกฎ</th>
                <th className="px-4 py-3 text-center">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {pbrRules.map((rule, idx) => (
                <tr key={rule.id}>
                  <td className="px-4 py-3">
                    <input
                      type="text"
                      value={rule.srcInterface}
                      onChange={(e) => {
                        const updated = [...pbrRules];
                        updated[idx].srcInterface = e.target.value;
                        setPbrRules(updated);
                      }}
                      className="w-full px-3 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-white"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={rule.targetWanNum}
                      onChange={(e) => {
                        const updated = [...pbrRules];
                        updated[idx].targetWanNum = Number(e.target.value);
                        setPbrRules(updated);
                      }}
                      className="w-full px-3 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-white"
                    >
                      {wans.map((w, wIdx) => (
                        <option key={w.id} value={wIdx + 1}>
                          WAN {wIdx + 1} ({w.interface})
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="text"
                      value={rule.note || ''}
                      onChange={(e) => {
                        const updated = [...pbrRules];
                        updated[idx].note = e.target.value;
                        setPbrRules(updated);
                      }}
                      className="w-full px-3 py-1.5 bg-slate-900 border border-slate-800 rounded-lg text-slate-400"
                    />
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => setPbrRules(pbrRules.filter((_, i) => i !== idx))}
                      className="text-rose-400 hover:text-rose-300 p-1"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* STEP 3: Custom Telegram Notifications */}
      <div className="p-6 rounded-2xl bg-slate-950/80 border border-slate-800/80 shadow-xl space-y-4">
        <h3 className="text-sm font-bold text-white flex items-center gap-2 border-b border-slate-800/80 pb-3">
          <Send className="w-4 h-4 text-sky-400" />
          <span>ขั้นตอนที่ 3: ระบบแจ้งเตือนเน็ตหลุด/เน็ตมาผ่าน Telegram</span>
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          <div>
            <label className="block text-slate-400 mb-1">Telegram Bot Token</label>
            <input
              type="text"
              value={telegramToken}
              onChange={(e) => setTelegramToken(e.target.value)}
              placeholder="เช่น 123456789:ABCdefGHIjklMNO..."
              className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-white font-mono"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">Telegram Chat ID</label>
            <input
              type="text"
              value={telegramChatId}
              onChange={(e) => setTelegramChatId(e.target.value)}
              placeholder="เช่น -100123456789 หรือ 987654321"
              className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-white font-mono"
            />
          </div>
        </div>

        <div className="space-y-3 text-xs pt-2">
          <div>
            <label className="block text-slate-400 mb-1">ข้อความเมื่อเน็ตหลุด (WAN Down Template)</label>
            <input
              type="text"
              value={telegramMsgDown}
              onChange={(e) => setTelegramMsgDown(e.target.value)}
              className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-amber-300"
            />
          </div>
          <div>
            <label className="block text-slate-400 mb-1">ข้อความเมื่อเน็ตกลับมา (WAN Up Template)</label>
            <input
              type="text"
              value={telegramMsgUp}
              onChange={(e) => setTelegramMsgUp(e.target.value)}
              className="w-full px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-emerald-300"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
