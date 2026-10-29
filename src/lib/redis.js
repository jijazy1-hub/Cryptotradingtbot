/**
 * ─── Storage (single shared copy) ────────────────────────────────────────────
 * Upstash Redis over REST when UPSTASH_REDIS_REST_URL + _TOKEN are set,
 * otherwise an in-memory emulator (local runs / tests; lost on restart).
 *
 * Two levels:
 *  - Raw commands: cmd('HSET', key, field, value), pipeline([[...], [...]])
 *    Use these for anything several processes can write at the same time —
 *    single commands are atomic in Redis, so nothing gets overwritten.
 *  - JSON helpers: getJSON / setJSON / update — whole-value read-modify-write.
 *    Only safe for data with a single writer (e.g. one cron job's cache).
 */

const axios = require('axios');

function isEnabled() {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

const headers = () => ({ Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`, 'Content-Type': 'application/json' });
const base = () => process.env.UPSTASH_REDIS_REST_URL.replace(/\/$/, '');

// ─── In-memory emulator (subset of Redis used by this app) ───────────────────
const mem = new Map(); // key → { type, value, expiresAt }

function live(key) {
  const e = mem.get(key);
  if (!e) return null;
  if (e.expiresAt && e.expiresAt <= Date.now()) { mem.delete(key); return null; }
  return e;
}
function ensure(key, type, make) {
  let e = live(key);
  if (!e) { e = { type, value: make(), expiresAt: null }; mem.set(key, e); }
  if (e.type !== type) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
  return e;
}
const globRe = (p) => new RegExp('^' + p.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');

function memExec([name, ...a]) {
  const c = String(name).toUpperCase();
  switch (c) {
    case 'GET': { const e = live(a[0]); if (!e) return null; if (e.type !== 'string') throw new Error('WRONGTYPE'); return e.value; }
    case 'SET': {
      const [key, value, ...opts] = a;
      let nx = false, px = null;
      for (let i = 0; i < opts.length; i++) {
        const o = String(opts[i]).toUpperCase();
        if (o === 'NX') nx = true;
        else if (o === 'PX') px = Number(opts[++i]);
        else if (o === 'EX') px = Number(opts[++i]) * 1000;
      }
      if (nx && live(key)) return null;
      mem.set(key, { type: 'string', value: String(value), expiresAt: px ? Date.now() + px : null });
      return 'OK';
    }
    case 'INCR': { const e = live(a[0]); const n = (e ? Number(e.value) : 0) + 1; if (!Number.isFinite(n)) throw new Error('ERR value is not an integer'); if (e) e.value = String(n); else mem.set(a[0], { type: 'string', value: String(n), expiresAt: null }); return n; }
    case 'HLEN': { const e = live(a[0]); return e ? e.value.size : 0; }
    case 'DEL': { let n = 0; for (const k of a) if (live(k)) { mem.delete(k); n++; } return n; }
    case 'EXISTS': return a.filter(k => live(k)).length;
    case 'TYPE': { const e = live(a[0]); return e ? e.type : 'none'; }
    case 'KEYS': { const re = globRe(a[0]); return [...mem.keys()].filter(k => live(k) && re.test(k)); }
    case 'RENAME': { const e = live(a[0]); if (!e) throw new Error('ERR no such key'); mem.delete(a[0]); mem.set(a[1], e); return 'OK'; }
    case 'EXPIRE': { const e = live(a[0]); if (!e) return 0; e.expiresAt = Date.now() + Number(a[1]) * 1000; return 1; }
    case 'HSET': { const e = ensure(a[0], 'hash', () => new Map()); let n = 0; for (let i = 1; i < a.length; i += 2) { if (!e.value.has(a[i])) n++; e.value.set(String(a[i]), String(a[i + 1])); } return n; }
    case 'HSETNX': { const e = ensure(a[0], 'hash', () => new Map()); if (e.value.has(a[1])) return 0; e.value.set(String(a[1]), String(a[2])); return 1; }
    case 'HGET': { const e = live(a[0]); return e ? (e.value.get(String(a[1])) ?? null) : null; }
    case 'HGETALL': { const e = live(a[0]); if (!e) return []; return [...e.value.entries()].flat(); }
    case 'HDEL': { const e = live(a[0]); if (!e) return 0; let n = 0; for (const f of a.slice(1)) if (e.value.delete(String(f))) n++; if (!e.value.size) mem.delete(a[0]); return n; }
    case 'SADD': { const e = ensure(a[0], 'set', () => new Set()); let n = 0; for (const m of a.slice(1)) if (!e.value.has(String(m))) { e.value.add(String(m)); n++; } return n; }
    case 'SREM': { const e = live(a[0]); if (!e) return 0; let n = 0; for (const m of a.slice(1)) if (e.value.delete(String(m))) n++; if (!e.value.size) mem.delete(a[0]); return n; }
    case 'SMEMBERS': { const e = live(a[0]); return e ? [...e.value] : []; }
    case 'SISMEMBER': { const e = live(a[0]); return e && e.value.has(String(a[1])) ? 1 : 0; }
    case 'RPUSH': { const e = ensure(a[0], 'list', () => []); e.value.push(...a.slice(1).map(String)); return e.value.length; }
    case 'LPUSH': { const e = ensure(a[0], 'list', () => []); for (const v of a.slice(1)) e.value.unshift(String(v)); return e.value.length; }
    case 'LRANGE': {
      const e = live(a[0]); if (!e) return [];
      const len = e.value.length; let s = Number(a[1]), t = Number(a[2]);
      if (s < 0) s = Math.max(0, len + s); if (t < 0) t = len + t;
      return e.value.slice(s, t + 1);
    }
    case 'LLEN': { const e = live(a[0]); return e ? e.value.length : 0; }
    default: throw new Error(`memory store: unsupported command ${c}`);
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────
/** One Redis command. Throws on errors. */
async function cmd(...args) {
  if (!isEnabled()) return memExec(args.map(x => (typeof x === 'number' ? String(x) : x)));
  const resp = await axios.post(base(), args.map(String), { headers: headers(), timeout: 8000 });
  if (resp.data && resp.data.error) throw new Error(`Upstash: ${resp.data.error}`);
  return resp.data ? resp.data.result : null;
}

/** Several commands in one round trip (not a transaction). Returns results in order. */
async function pipeline(commands) {
  if (!commands.length) return [];
  if (!isEnabled()) return commands.map(c => memExec(c.map(x => (typeof x === 'number' ? String(x) : x))));
  const resp = await axios.post(`${base()}/pipeline`, commands.map(c => c.map(String)), { headers: headers(), timeout: 10000 });
  return (resp.data || []).map(r => {
    if (r && r.error) throw new Error(`Upstash: ${r.error}`);
    return r ? r.result : null;
  });
}

/** HGETALL result (flat array or object) → plain object. */
function hashToObject(res) {
  if (!res) return {};
  if (!Array.isArray(res)) return res;
  const o = {};
  for (let i = 0; i < res.length; i += 2) o[res[i]] = res[i + 1];
  return o;
}

/** Try to take a short lock. Returns true if this caller owns it. */
async function lock(key, ttlSeconds = 30) {
  return (await cmd('SET', key, String(Date.now()), 'NX', 'EX', ttlSeconds)) === 'OK';
}

// ─── JSON helpers (single-writer data only) ──────────────────────────────────
async function getJSON(key, fallback = null) {
  const raw = await cmd('GET', key);
  if (raw === null || raw === undefined) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

async function setJSON(key, value) {
  await cmd('SET', key, JSON.stringify(value));
}

async function del(key) {
  await cmd('DEL', key);
}

async function keys(pattern) {
  return (await cmd('KEYS', pattern)) || [];
}

async function update(key, fallback, mutate) {
  const current = await getJSON(key, fallback);
  const next = await mutate(current);
  await setJSON(key, next === undefined ? current : next);
  return next === undefined ? current : next;
}

function _resetMemory() { mem.clear(); }

module.exports = {
  isEnabled, cmd, pipeline, hashToObject, lock,
  getJSON, setJSON, del, keys, update, _resetMemory,
};
