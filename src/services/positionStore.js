/**
 * ─── Position Store (multi-user, multi-entry per coin) ───────────────────────
 *
 * STORAGE FORMAT (v2.5)
 *   cryptobot:posidx:{chatId}               SET  of positionIds
 *   cryptobot:pos:{chatId}:{positionId}     HASH field → JSON value
 *
 * Why: the old format kept ALL of a user's positions in one JSON value
 * (cryptobot:positions:{chatId}) and rewrote it on every change. If the
 * monitor and the user (or quickcheck) changed it at the same moment, one
 * change was silently lost — e.g. a "stop hit" flag vanishing, or a new buy
 * disappearing. Now every update writes only the fields it changes, and Redis
 * applies each command atomically.
 *
 * MIGRATION: the first time a user is read, an old-format value is copied into
 * the new format and then RENAMED to cryptobot:positions-legacy-backup:{chatId}
 * (kept, never deleted). Position IDs stay the same: {SYMBOL}:{timestamp}.
 */

const store = require('../lib/redis');

const idxKey = (chatId) => `cryptobot:posidx:${chatId}`;
const posKey = (chatId, id) => `cryptobot:pos:${chatId}:${id}`;
const legacyKey = (chatId) => `cryptobot:positions:${chatId}`;
const backupKey = (chatId) => `cryptobot:positions-legacy-backup:${chatId}`;

const encode = (obj) => Object.entries(obj).flatMap(([k, v]) => [k, JSON.stringify(v === undefined ? null : v)]);
function decode(hash) {
  const out = {};
  for (const [k, v] of Object.entries(store.hashToObject(hash))) {
    try { out[k] = JSON.parse(v); } catch { out[k] = v; }
  }
  return out;
}

// ─── One-time, non-destructive migration from the old single-blob format ─────
const checked = new Set(); // chats already confirmed as new-format in this process

async function migrateLegacy(chatId) {
  if (checked.has(String(chatId))) return false;
  const type = await store.cmd('TYPE', legacyKey(chatId));
  if (type !== 'string') { checked.add(String(chatId)); return false; }
  if (!(await store.lock(`cryptobot:migrate-lock:pos:${chatId}`, 30))) return false; // another instance is on it
  try {
    const raw = await store.cmd('GET', legacyKey(chatId));
    let positions = {};
    try { positions = JSON.parse(raw) || {}; } catch { positions = {}; }
    const cmds = [];
    for (const [id, pos] of Object.entries(positions)) {
      if (!pos || typeof pos !== 'object') continue;
      const positionId = pos.positionId || id;
      // HSETNX per field: never overwrite anything already written in the new format
      for (const [k, v] of Object.entries({ ...pos, positionId, chatId: String(chatId) })) {
        cmds.push(['HSETNX', posKey(chatId, positionId), k, JSON.stringify(v === undefined ? null : v)]);
      }
      cmds.push(['SADD', idxKey(chatId), positionId]);
    }
    await store.pipeline(cmds);
    await store.cmd('RENAME', legacyKey(chatId), backupKey(chatId));
    console.log(`[PositionStore] Migrated ${Object.keys(positions).length} position(s) for ${chatId} (backup kept)`);
    return true;
  } finally {
    await store.cmd('DEL', `cryptobot:migrate-lock:pos:${chatId}`);
  }
}

// ─── Reads ────────────────────────────────────────────────────────────────────
async function getAllPositions(chatId) {
  try {
    await migrateLegacy(chatId);
    const ids = (await store.cmd('SMEMBERS', idxKey(chatId))) || [];
    if (!ids.length) return {};
    const hashes = await store.pipeline(ids.map(id => ['HGETALL', posKey(chatId, id)]));
    const out = {};
    const stale = [];
    ids.forEach((id, i) => {
      const pos = decode(hashes[i]);
      if (!pos.positionId) { stale.push(id); return; }
      out[id] = pos;
    });
    if (stale.length) await store.cmd('SREM', idxKey(chatId), ...stale);
    return out;
  } catch (err) {
    console.error('[PositionStore] read failed:', err.message);
    return {};
  }
}

async function getPositionsBySymbol(chatId, symbol) {
  const all = await getAllPositions(chatId);
  return Object.values(all)
    .filter(p => p.symbol === symbol.toUpperCase())
    .sort((a, b) => new Date(a.addedAt) - new Date(b.addedAt));
}

async function getPositionById(chatId, positionId) {
  const pos = decode(await store.cmd('HGETALL', posKey(chatId, positionId)));
  return pos.positionId ? pos : null;
}

// ─── Writes (each is a small set of atomic commands) ─────────────────────────
async function addPosition({ chatId, symbol, buyPrice, quantity, accountSize, riskPct, targetMultiple, stopLossPrice = null, exchange = null }) {
  const sym    = symbol.toUpperCase();
  const target = targetMultiple ? parseFloat(targetMultiple) : null;
  let positionId = `${sym}:${Date.now()}`;
  while (await store.cmd('EXISTS', posKey(chatId, positionId))) {
    positionId = `${sym}:${Date.now() + Math.floor(Math.random() * 1000)}`;
  }

  const pos = {
    positionId,
    symbol:             sym,
    exchange:           exchange || null,   // where prices come from (null = auto, Binance first)
    chatId:             chatId.toString(),
    buyPrice:           parseFloat(buyPrice),
    quantity:           quantity    ? parseFloat(quantity)    : null,
    accountSize:        accountSize ? parseFloat(accountSize) : null,
    riskPct:            riskPct     ? parseFloat(riskPct)     : 1,
    targetMultiple:     target,
    targetPrice:        target ? parseFloat(buyPrice) * target : null,
    targetHit:          false,
    stopLossHit:        false,
    // Trade plan is locked the first time it is calculated (or set by the user)
    stopLossPrice:      stopLossPrice ? parseFloat(stopLossPrice) : null,
    initialStopPrice:   stopLossPrice ? parseFloat(stopLossPrice) : null,
    stopSource:         stopLossPrice ? 'user' : null,
    stopStage:          stopLossPrice ? 'user' : 'initial',
    takeProfits:        null,
    addedAt:            new Date().toISOString(),
    lastChecked:        null,
    lastHoldAlertAt:    null,
    lastRecommendation: null,
    highestPrice:       parseFloat(buyPrice),
  };

  await store.pipeline([
    ['HSET', posKey(chatId, positionId), ...encode(pos)],
    ['SADD', idxKey(chatId), positionId],
  ]);
  return pos;
}

/**
 * Write only the given fields. Never resurrects a position that was removed
 * (e.g. the user typed `sell` while the monitor was checking it).
 */
async function updatePosition(chatId, positionId, updates) {
  if (!updates || Object.keys(updates).length === 0) return null;
  await migrateLegacy(chatId);
  if (!(await store.cmd('SISMEMBER', idxKey(chatId), positionId))) return null;
  await store.cmd('HSET', posKey(chatId, positionId), ...encode(updates));
  // Removed in the meantime? Clean up the fields we just wrote.
  if (!(await store.cmd('SISMEMBER', idxKey(chatId), positionId))) {
    await store.cmd('DEL', posKey(chatId, positionId));
    return null;
  }
  return getPositionById(chatId, positionId);
}

// Called after every removal (automated exits use it to cancel a stop order)
const removeHooks = [];
function onRemove(fn) { removeHooks.push(fn); }

async function removePositionById(chatId, positionId) {
  await migrateLegacy(chatId);
  const [removed] = await store.pipeline([
    ['SREM', idxKey(chatId), positionId],
    ['DEL', posKey(chatId, positionId)],
  ]);
  if (removed > 0) {
    for (const fn of removeHooks) {
      try { await fn(String(chatId), positionId); } catch (err) { console.error('[PositionStore] remove hook:', err.message); }
    }
  }
  return removed > 0;
}

async function removeAllBySymbol(chatId, symbol) {
  const entries = await getPositionsBySymbol(chatId, symbol);
  let removed = 0;
  for (const p of entries) if (await removePositionById(chatId, p.positionId)) removed++;
  return removed;
}

async function updateLastChecked(chatId, positionId, recommendation) {
  return updatePosition(chatId, positionId, {
    lastChecked:        new Date().toISOString(),
    lastRecommendation: recommendation,
  });
}

/** Every user who has (or had, in the old format) positions. */
async function getAllChatIdsWithPositions() {
  const [idx, legacy] = await Promise.all([store.keys('cryptobot:posidx:*'), store.keys('cryptobot:positions:*')]);
  const ids = new Set([
    ...idx.map(k => k.slice('cryptobot:posidx:'.length)),
    ...legacy.map(k => k.slice('cryptobot:positions:'.length)),
  ]);
  return [...ids];
}

async function getAllUsersPositions() {
  try {
    const all = [];
    for (const chatId of await getAllChatIdsWithPositions()) {
      for (const pos of Object.values(await getAllPositions(chatId))) all.push(pos);
    }
    return all;
  } catch (err) {
    console.error('[PositionStore] getAllUsersPositions error:', err.message);
    return [];
  }
}

module.exports = {
  getAllPositions,
  getPositionsBySymbol,
  getPositionById,
  addPosition,
  updatePosition,
  removePositionById,
  removeAllBySymbol,
  updateLastChecked,
  getAllUsersPositions,
  getAllChatIdsWithPositions,
  migrateLegacy,
  onRemove,
  _resetMigrationCache: () => checked.clear(),
  get isUsingUpstash() { return store.isEnabled(); },
};
