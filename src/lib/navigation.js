/**
 * ─── Button navigation: ⬅️ Back on every screen, old screens removed ─────────
 *
 * Every button tap now:
 *   1. deletes the message the button was on (and the rest of that screen),
 *      so the chat never fills up with old menus;
 *   2. shows the next screen with a ⬅️ Back button that returns to the
 *      screen the user came from.
 *
 * SCREENS vs ACTIONS. Only "screens" (read-only views such as positions,
 * practice, autobuy, subs) can be returned to with Back. Anything that does
 * something (buy, confirm, turn on, reset, give a subscription…) is an action:
 * Back from its result goes to the screen the action was started from, and
 * the action itself is NEVER repeated. Unknown buttons count as actions.
 *
 * RECEIPTS ARE KEPT. Plain result messages of actions ("✅ Bought…", "🟢
 * Auto-trading is ON") get a Back button but are not deleted when it's
 * tapped, so a record of what happened always stays in the chat.
 *
 * Storage (expires after 7 days without use):
 *   cryptobot:nav:m:{chatId}  HASH messageId → {"s": screen, "b": back, "k": keep, "x": [other ids of the screen]}
 *   cryptobot:nav:p:{chatId}  HASH screen → the screen Back returns to
 */

const store = require('./redis');

const TTL = 7 * 86400;
const MAX_MSGS = 300;
const msgKey = (chatId) => `cryptobot:nav:m:${chatId}`;
const parentKey = (chatId) => `cryptobot:nav:p:${chatId}`;
const BACK_TEXT = '⬅️ Back';
const MENU = 'menu';

const VIEWS = [
  /^(menu|positions|pos|profit|stats|pnl|balance|wallet|bal|stops|coins|account|subscription|plan|help|manual|guide|pending|users|scan|moonshots|newlistings|autobuy|practice|golive|live|buynow|subs|subscribers|subscriptions|save|savings|expect|ask)$/,
  /^(buy|sell|sold|split|setstop|check|buynow)_(help|guide)$/,
  /^golive [123]$/,
  /^practice help$/,
  /^subs (plan|give|list|end|free)$/,
  /^save (help|day|amount)$/,
  /^subs give \d{3,20}$/,
  /^check [a-z0-9]{2,15}$/,
];

const norm = (s) => String(s || '').trim().replace(/^\//, '').replace(/\s+/g, ' ').toLowerCase();

/** True for read-only screens that are safe to show again with Back. */
function isView(data) {
  const s = norm(data);
  return VIEWS.some(re => re.test(s));
}

/** The id stored for a screen (callback_data is limited to 64 bytes). */
function screenId(data) {
  const s = norm(data);
  return Buffer.byteLength(`nav:${s}`) <= 64 ? s : MENU;
}

/** Progress notes ("⏳ Scanning…") belong to the screen but never carry Back. */
const isProgress = (text) => /^(⏳|🔎 Checking)/.test(String(text || ''));

/**
 * Add a ⬅️ Back row to an inline keyboard — unless it already has a Back /
 * Cancel / Not now button that goes to the same screen (no two Backs).
 */
function withBack(markup, back) {
  if (!back) return markup;
  const rows = (markup?.inline_keyboard || []).map(r => [...r]);
  const isBackLike = (btn) => /back|cancel|not now/i.test(btn.text || '');
  const already = rows.some(r => r.some(btn => btn.callback_data && (String(btn.callback_data).startsWith('nav:') || (screenId(btn.callback_data) === back && isBackLike(btn)))));
  if (already) return { ...markup, inline_keyboard: rows };
  rows.push([{ text: BACK_TEXT, callback_data: `nav:${back}` }]);
  return { ...markup, inline_keyboard: rows };
}

const backOnly = (back) => ({ inline_keyboard: [[{ text: BACK_TEXT, callback_data: `nav:${back}` }]] });

// ─── Storage ──────────────────────────────────────────────────────────────────
async function getMsg(chatId, messageId) {
  if (!messageId) return null;
  const raw = await store.cmd('HGET', msgKey(chatId), String(messageId)).catch(() => null);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function saveMsg(chatId, messageId, rec) {
  if (!messageId) return;
  const k = msgKey(chatId);
  try {
    const n = await store.cmd('HSET', k, String(messageId), JSON.stringify(rec));
    await store.cmd('EXPIRE', k, TTL);
    // Very long histories: start afresh rather than grow forever
    if (n && Number(messageId) % 50 === 0 && Number(await store.cmd('HLEN', k).catch(() => 0)) > MAX_MSGS) await store.cmd('DEL', k);
  } catch { /* navigation is a convenience; never block a reply */ }
}

async function forget(chatId, ids) {
  if (!ids.length) return;
  await store.cmd('HDEL', msgKey(chatId), ...ids.map(String)).catch(() => {});
}

async function parentOf(chatId, screen) {
  if (!screen || screen === MENU) return null;
  const p = await store.cmd('HGET', parentKey(chatId), screen).catch(() => null);
  return p && p !== screen ? p : MENU;
}

async function setParent(chatId, screen, back) {
  if (!screen || screen === MENU || !back || back === screen) return;
  try {
    await store.cmd('HSET', parentKey(chatId), screen, back);
    await store.cmd('EXPIRE', parentKey(chatId), TTL);
  } catch { /* convenience only */ }
}

/**
 * Work out the context for a tap: which screen the result belongs to and
 * where Back goes. `rec` is the stored record of the message that was tapped.
 */
async function contextForTap(chatId, data, rec) {
  const from = rec?.s || MENU;
  if (String(data).startsWith('nav:')) {
    const screen = screenId(String(data).slice(4)) || MENU;
    return { chatId: String(chatId), button: true, kind: 'view', screen, back: await parentOf(chatId, screen), command: screen };
  }
  if (isView(data)) {
    const screen = screenId(data);
    if (screen === MENU) return { chatId: String(chatId), button: true, kind: 'view', screen, back: null, command: data };
    const back = from === screen ? await parentOf(chatId, screen) : from;
    await setParent(chatId, screen, back);
    return { chatId: String(chatId), button: true, kind: 'view', screen, back, command: data };
  }
  // An action: its result belongs to the screen it was started from
  return { chatId: String(chatId), button: true, kind: 'action', screen: from, back: from, command: data };
}

/** Context for a typed command: Back (on button messages) goes to the menu. */
function contextForTyped(chatId, text) {
  const view = isView(text);
  const screen = view ? screenId(text) : MENU;
  return { chatId: String(chatId), button: false, kind: view ? 'view' : 'action', screen, back: screen === MENU && view ? null : MENU };
}

module.exports = {
  isView, screenId, isProgress, withBack, backOnly, getMsg, saveMsg, forget, parentOf, setParent,
  contextForTap, contextForTyped, BACK_TEXT, MENU,
};
