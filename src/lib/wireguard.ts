import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export interface WireGuardPeerInfo {
  publicKey: string;
  presharedKey: string;
  endpoint: string;
  allowedIps: string;
  latestHandshake: number;
  transferRx: number;
  transferTx: number;
  persistentKeepalive: string;
}

export function cleanupVpsPeerByIp(wireguardIp: string) {
  if (!wireguardIp) return;
  try {
    const dump = execSync('sudo wg show wg0 dump 2>/dev/null', { encoding: 'utf8' });
    const lines = dump.split('\n');
    const targetIpStr = wireguardIp.trim() + '/32';
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 4) {
        const pubKey = parts[0];
        const allowedIps = parts[3];
        if (allowedIps && allowedIps.includes(targetIpStr)) {
          execSync(`sudo wg set wg0 peer "${pubKey}" remove 2>/dev/null`, { encoding: 'utf8' });
        }
      }
    }
  } catch (e: any) {
    console.error('[WireGuard] Error cleaning peer:', e.message);
  }
}

export function registerVpsPeer(wireguardIp: string, clientPublicKey: string) {
  if (!wireguardIp || !clientPublicKey) return;
  cleanupVpsPeerByIp(wireguardIp);
  try {
    execSync(`sudo wg set wg0 peer "${clientPublicKey.trim()}" allowed-ips ${wireguardIp.trim()}/32 2>/dev/null`, { encoding: 'utf8' });
    execSync('sudo wg-quick save wg0 2>/dev/null', { encoding: 'utf8' });
  } catch (e: any) {
    console.error('[WireGuard] Error registering peer:', e.message);
    throw new Error(`WireGuard VPS Peer registration failed: ${e.message}`);
  }
}

export function getVpsPublicKey(): string | null {
  try {
    const pubKey = execSync('wg show wg0 public-key 2>/dev/null || sudo wg show wg0 public-key 2>/dev/null', { encoding: 'utf8' }).trim();
    if (pubKey) return pubKey;
  } catch (e) {}

  const candidatePaths = [
    '/etc/wireguard/publickey',
    path.join(process.cwd(), 'vps_publickey.txt'),
    path.join(process.cwd(), 'publickey')
  ];

  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const pub = fs.readFileSync(p, 'utf8').trim();
        if (pub) return pub;
      }
    } catch (e) {}
  }
  return null;
}

export function getVpsWireGuardStatus(): { active: boolean; peers: WireGuardPeerInfo[] } {
  try {
    const dump = execSync('sudo wg show wg0 dump 2>/dev/null', { encoding: 'utf8' });
    const lines = dump.trim().split('\n');
    const peers: WireGuardPeerInfo[] = [];

    // First line is interface details
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].trim().split(/\s+/);
      if (parts.length >= 8) {
        peers.push({
          publicKey: parts[0],
          presharedKey: parts[1],
          endpoint: parts[2],
          allowedIps: parts[3],
          latestHandshake: Number(parts[4]) || 0,
          transferRx: Number(parts[5]) || 0,
          transferTx: Number(parts[6]) || 0,
          persistentKeepalive: parts[7]
        });
      }
    }

    return { active: true, peers };
  } catch (e) {
    return { active: false, peers: [] };
  }
}
