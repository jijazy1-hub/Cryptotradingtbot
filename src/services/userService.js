/**
 * ─── User Service ─────────────────────────────────────────────────────────────
 * Approved, pending and blocked users.
 *
 * STORAGE (v2.5): cryptobot:userhash — a Redis HASH, field = chat id,
 * value = user JSON. Each change writes only that user's field, so e.g. a new
 * /start can't wipe out an approval that happened at the same moment (the old
 * format rewrote one JSON object holding every user).
 * The old cryptobot:users value is migrated on first use and kept as
 * cryptobot:users-legacy-backup.
 *
 * USER STATES: pending → approved | blocked
 */

const store = require('../lib/redis');

const HASH = 'cryptobot:userhash';
const LEGACY = 'cryptobot:users';
const BACKUP = 'cryptobot:users-legacy-backup';
let migrated = false;

async function migrateLegacy() {
  if (migrated) return;
  if ((await store.cmd('TYPE', LEGACY)) !== 'string') { migrated = true; return; }
  if (!(await store.lock('cryptobot:migrate-lock:users', 30))) return;
  try {
    let users = {};
    try { users = JSON.parse(await store.cmd('GET', LEGACY)) || {}; } catch { users = {}; }
    const cmds = Object.entries(users).map(([id, u]) => ['HSETNX', HASH, String(id), JSON.stringify(u)]);
    await store.pipeline(cmds);
    await store.cmd('RENAME', LEGACY, BACKUP);
    migrated = true;
  } finally {
    await store.cmd('DEL', 'cryptobot:migrate-lock:users');
  }
}

const parse = (raw) => { try { return raw ? JSON.parse(raw) : null; } catch { return null; } };

async function getAllUsers() {
  try {
    await migrateLegacy();
    const obj = store.hashToObject(await store.cmd('HGETALL', HASH));
    const out = {};
    for (const [id, raw] of Object.entries(obj)) { const u = parse(raw); if (u) out[id] = u; }
    return out;
  } catch (err) {
    console.error('[UserService] read failed:', err.message);
    return {};
  }
}

async function getUser(chatId) {
  try {
    await migrateLegacy();
    return parse(await store.cmd('HGET', HASH, chatId.toString()));
  } catch (err) {
    console.error('[UserService] read failed:', err.message);
    return null;
  }
}

async function saveUser(user) {
  await store.cmd('HSET', HASH, user.chatId.toString(), JSON.stringify(user));
}

function isAdminId(chatId) {
  const admin = process.env.TELEGRAM_CHAT_ID;
  return !!admin && chatId?.toString() === admin.toString();
}

async function isApproved(chatId) {
  if (isAdminId(chatId)) return true;
  return (await getUser(chatId))?.status === 'approved';
}

async function isBlocked(chatId) {
  return (await getUser(chatId))?.status === 'blocked';
}

async function registerUser({ chatId, firstName, lastName, username, param }) {
  const id = chatId.toString();
  const existing = await getUser(id);
  if (existing?.status === 'approved' || existing?.status === 'blocked') return existing;

  const user = {
    chatId:      id,
    firstName:   firstName || '',
    lastName:    lastName  || '',
    username:    username  || '',
    source:      param     || '',
    status:      'pending',
    requestedAt: existing?.requestedAt || new Date().toISOString(),
    approvedAt:  null,
  };
  // HSETNX first: if two /start messages race, only one creates the record
  if (!existing) {
    const created = await store.cmd('HSETNX', HASH, id, JSON.stringify(user));
    if (!created) return getUser(id);
  } else {
    await saveUser(user);
  }
  return user;
}

async function setStatus(chatId, status, stampField) {
  const user = await getUser(chatId);
  if (!user) return false;
  user.status = status;
  user[stampField] = new Date().toISOString();
  await saveUser(user);
  return true;
}

async function approveUser(chatId) { return setStatus(chatId, 'approved', 'approvedAt'); }
async function blockUser(chatId)   { return setStatus(chatId, 'blocked',  'blockedAt'); }

async function removeUser(chatId) {
  await migrateLegacy();
  return (await store.cmd('HDEL', HASH, chatId.toString())) > 0;
}

async function getUsersByStatus(status) {
  return Object.values(await getAllUsers()).filter(u => u.status === status);
}

async function getAllActiveChatIds() {
  const approved = await getUsersByStatus('approved');
  return [...new Set([process.env.TELEGRAM_CHAT_ID, ...approved.map(u => u.chatId)])].filter(Boolean).map(String);
}

function formatName(user) {
  if (!user) return 'Unknown user';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ') || 'Unknown';
  const tag  = user.username ? `@${user.username}` : `ID: ${user.chatId}`;
  return `${name} (${tag})`;
}

module.exports = {
  getUser, getAllUsers, isApproved, isBlocked, isAdminId,
  registerUser, approveUser, blockUser, removeUser,
  getUsersByStatus, getAllActiveChatIds, formatName,
  _resetMigrationCache: () => { migrated = false; },
};
