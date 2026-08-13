/**
 * Resolve the dynamic RouterOS interface that carries PPPoE session counters.
 *
 * /ppp/active/print does not expose bytes-in/out. Traffic lives on the
 * dynamic interface created per session. Naming varies slightly by ROS
 * version / server vs client role — try the common forms before giving up.
 */

'use strict';

function pppoeIfaceCandidates(username) {
    const u = String(username || '');
    if (!u) return [];
    return [
        `<pppoe-${u}>`,
        `pppoe-${u}`,
        `<pppoe-${u}`,
        `pppoe-${u}>`
    ];
}

/**
 * @param {Map<string, object>|Record<string, object>} ifaceByName
 * @param {string} username
 * @returns {object|null}
 */
function resolvePppoeIface(ifaceByName, username) {
    if (!username) return null;
    const get = typeof ifaceByName.get === 'function'
        ? (k) => ifaceByName.get(k)
        : (k) => ifaceByName[k];
    const has = typeof ifaceByName.has === 'function'
        ? (k) => ifaceByName.has(k)
        : (k) => Object.prototype.hasOwnProperty.call(ifaceByName, k);

    for (const name of pppoeIfaceCandidates(username)) {
        if (has(name)) return get(name);
    }

    // Last resort: any interface whose name contains the username and "pppoe"
    const needle = String(username).toLowerCase();
    const entries = typeof ifaceByName.entries === 'function'
        ? ifaceByName.entries()
        : Object.entries(ifaceByName);
    for (const [name, iface] of entries) {
        const n = String(name).toLowerCase();
        if (n.includes('pppoe') && n.includes(needle)) return iface;
    }
    return null;
}

module.exports = { resolvePppoeIface, pppoeIfaceCandidates };
