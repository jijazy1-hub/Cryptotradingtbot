/**
 * ─── Telegram Webhook Handler (Multi-User + Admin Approval) ──────────────────
 * POST /api/telegram-webhook
 *
 * FLOW:
 *  New user → /start → pending request sent to admin
 *  Admin → taps Approve → user gets welcome + full access
 *  Admin → taps Reject  → user gets rejection message
 *
 * ADMIN ONLY COMMANDS:
 *  users    → list all approved users
 *  pending  → list pending requests
 *  block ID → block a user
 *  remove ID → remove a user (numeric chat ID; `remove SOL` still removes a position)
 *
 * SECURITY: requests must carry Telegram's secret-token header
 * (TELEGRAM_WEBHOOK_SECRET, registered by /api/set-commands). Without it anyone
 * could POST a fake update "from" the admin chat ID and get admin powers.
 *
 * FIXES: `sold SOL 92.5 185` now records the trade (it used to be swallowed by
 * the `sell` handler), "Buy #N" numbering, admin `remove` vs position `remove`,
 * `/cmd@BotName` in groups, trade plan locked at buy time.
 */

const { AsyncLocalStorage } = require('async_hooks');
const tg = require('../src/lib/telegram');
const store = require('../src/lib/redis');
const nav = require('../src/lib/navigation');
const { dashboardLink, revokeAll } = require('../src/lib/dashAuth');
const { deferUntilAfterResponse } = require('../src/lib/background');
const { verifyTelegramWebhook } = require('../src/lib/auth');
const { normaliseSymbol, fetchPrice, resolveExchange } = require('../src/lib/market');
const { PROVIDERS, normaliseExchange } = require('../src/lib/exchanges');
const EXCHANGE_LIST = 'Binance, Bybit, OKX, Gate, MEXC, KuCoin, Kraken';
const { fetchCurrentData, buildAdvice, planFromAdvice } = require('../src/services/adviceService');
const {
  getUser, isApproved, isBlocked,
  registerUser, approveUser, blockUser, removeUser,
  getUsersByStatus, formatName,
} = require('../src/services/userService');
const {
  getAllPositions, getPositionsBySymbol, addPosition, updatePosition,
  removePositionById, removeAllBySymbol,
} = require('../src/services/positionStore');
const { recordTrade, getMonthlyStats, getAllTrades, todayLine } = require('../src/services/profitTracker');
const { adviseSplit, compoundingAdvice, targetProgress } = require('../src/services/portfolioAdvisor');
const accounts = require('../src/services/tradingAccounts');
const autoTrader = require('../src/services/autoTrader');
const subs = require('../src/services/subscriptionService');
const practice = require('../src/services/practiceService');
const autoBuyer = require('../src/services/autoBuyer');
const expectations = require('../src/services/expectations');
const savings = require('../src/services/savingsPlan');
const ai = require('../src/services/aiHelper');
const box = require('../src/lib/secretBox');
const { tradingIps } = require('../src/lib/binanceTrade');
const { baseUrl } = require('../src/lib/dashAuth');

// Commands that work while a subscription has ended (paid access only)
// Always allowed, even without a subscription: paying, help, closing positions, and
// connecting Binance / checking the balance (that's how small accounts qualify for free access)
const FREE_COMMANDS = new Set(['subscribe', 'renew', 'pay', 'account', 'subscription', 'plan', 'help', 'menu', 'dashboard', 'autotrade', 'sell', 'sellentry', 'sellall', 'remove', 'golive', 'live', 'balance', 'wallet', 'bal', 'expect']);

const adminId = () => process.env.TELEGRAM_CHAT_ID;
const esc = tg.escapeMd;
const nameOf = (user) => esc(formatName(user));

// ─── Persistent MENU button ───────────────────────────────────────────────────
const PERSISTENT_MENU = {
  keyboard:    [[{ text: '📋 MENU' }]],
  resize_keyboard:          true,
  persistent:               true,
  input_field_placeholder:  'Tap MENU or type a command...',
};

// ─── Inline command buttons (every feature, grouped) ─────────────────────────
const b = (text, data) => ({ text, callback_data: data });
const MENU_ROWS = [
  // Your trades
  [b('💰 Real Positions', 'positions'),   b('⚡ Buy Now', 'buynow_help')],
  [b('📝 Log a Buy', 'buy_help'),          b('🧾 Record a Sale', 'sold_help')],
  [b('🛡 Change a Stop', 'setstop_help'),  b('🗑 Stop Tracking', 'sell_help')],
  [b('🔎 Check a Coin', 'check_help'),     b('📈 My Profits', 'profit')],
  // Automation & practice
  [b('🤖 Auto-trading', 'golive'),         b('🛒 Auto-buy', 'autobuy')],
  [b('💵 Binance Balance', 'balance'),     b('🎮 Practice (play money)', 'practice')],
  [b('🛡 Today\'s Stops (all coins)', 'stops'), b('🐷 Savings Plan', 'save')],
  [b('📏 What to Expect', 'expect'), b('💬 Ask the Bot', 'ask')],
  // Market
  [b('🔍 Scan Now', 'scan'),               b('🌕 Moonshots', 'moonshots')],
  [b('🚀 New Listings', 'newlistings'),    b('💼 Split Capital', 'split_help')],
  // Account & help
  [b('🖥 My Dashboard', 'dashboard'),      b('💳 My Account', 'account')],
  [b('📖 All Commands', 'help'),           b('📚 User Manual', 'manual')],
];
const ADMIN_ROWS = [
  [b('⏳ Pending', 'pending'),   b('👥 Users', 'users')],
  [b('💳 Subscriptions', 'subs'),  b('🔗 Invite Links', 'invite')],
];
const INLINE_MENU = { inline_keyboard: MENU_ROWS };
const menuFor = (chatId) => ({ inline_keyboard: isAdmin(chatId) ? [...MENU_ROWS, ...ADMIN_ROWS] : MENU_ROWS });

const MENU_TEXT = (admin) => [
  `*📋 Menu* — tap any button`,
  ``,
  `Top: your real trades · Middle: auto-trading, practice & stops · Bottom: market, account & help${admin ? ' · Last rows: admin' : ''}`,
].join('\n');

// ─── Send helpers (shared Telegram client, Markdown-safe) ───────────────────
// Every message goes through navSend, which adds the ⬅️ Back button and
// remembers which screen each message belongs to (src/lib/navigation.js).
const navCtx = new AsyncLocalStorage();

function currentNav(chatId) {
  const ctx = navCtx.getStore();
  return ctx && ctx.chatId === String(chatId) ? ctx : null;
}

async function remember(ctx, msg, keep) {
  const id = msg?.message_id;
  if (!id) return;
  if (!keep) {
    await nav.saveMsg(ctx.chatId, id, { s: ctx.screen, b: ctx.back, x: [...ctx.parts] });
    ctx.parts.push(id);
  } else {
    await nav.saveMsg(ctx.chatId, id, { s: ctx.screen, b: ctx.back, k: 1 });
  }
}

/** Send the plain message that was held back, with ⬅️ Back if it's the last one. */
async function flushHeld(ctx, last) {
  const h = ctx.held;
  if (!h) return;
  ctx.held = null;
  const withBackBtn = last && ctx.back && !ctx.backShown;
  if (withBackBtn) ctx.backShown = true;
  const msg = await h.doSend(withBackBtn ? nav.backOnly(ctx.back) : PERSISTENT_MENU);
  // Screens disappear together; results of actions (receipts) stay in the chat
  await remember(ctx, msg, ctx.kind === 'action');
}

async function navSend(chatId, text, markup, long = false) {
  const doSend = (mk) => (long ? tg.sendLong(chatId, text, { markup: mk }) : tg.send(chatId, text, { markup: mk }));
  const ctx = currentNav(chatId);
  if (!ctx) return doSend(markup || PERSISTENT_MENU);

  if (markup && Array.isArray(markup.inline_keyboard)) {
    await flushHeld(ctx, false);
    const mk = nav.withBack(markup, ctx.back);
    if (ctx.back) ctx.backShown = true;
    const msg = await doSend(mk);
    await remember(ctx, msg, false);
    return msg;
  }

  const plain = !markup || markup === PERSISTENT_MENU;
  if (plain && ctx.button && ctx.back && !nav.isProgress(text)) {
    // Hold it: only the LAST plain message of a screen gets the Back button
    await flushHeld(ctx, false);
    ctx.held = { doSend };
    return null;
  }
  await flushHeld(ctx, false);
  const msg = await doSend(markup || PERSISTENT_MENU);
  if (ctx.button && nav.isProgress(text)) await remember(ctx, msg, false);
  return msg;
}

/** Run a command inside a navigation context, then send whatever is still held. */
async function withNav(ctx, fn) {
  const c = { ...ctx, parts: [], held: null, backShown: false };
  return navCtx.run(c, async () => {
    try { return await fn(); } finally { await flushHeld(c, true).catch(err => console.error('[Nav]', err.message)); }
  });
}

/** Delete the screen a button was tapped on (unless it's a receipt we keep). */
async function clearScreen(chatId, messageId, rec) {
  if (!messageId || rec?.k) return;
  const ids = [messageId, ...(rec?.x || [])];
  for (const id of ids) await tg.call('deleteMessage', { chat_id: chatId, message_id: id }).catch(() => {});
  await nav.forget(chatId, ids);
}

async function send(chatId, text, markup) {
  return navSend(chatId, text, markup);
}

async function reply(chatId, text, showInline = false) {
  return send(chatId, text, showInline ? menuFor(chatId) : PERSISTENT_MENU);
}

async function replyChunked(chatId, text, showInline = false) {
  return navSend(chatId, text, showInline ? menuFor(chatId) : PERSISTENT_MENU, true);
}

const answerCallback = tg.answerCallback;

/** Access check that first re-reads a small account's Binance balance (free access). */
async function hasAccessNow(chatId) {
  if (await subs.hasAccess(chatId)) return true;
  if (!(subs.freeLimit() > 0)) return false;
  await subs.refreshSmall(chatId).catch(() => null);
  return subs.hasAccess(chatId);
}

async function lockedText(chatId) {
  const limit = subs.freeLimit();
  const had = chatId ? (await subs.getSub(chatId).catch(() => null))?.paidUntil : null;
  return [
    had ? `🔒 *Your subscription has ended.*` : `🔒 *You need a subscription to use this.*`,
    ``,
    `${had ? 'Renew' : 'Subscribe'} — ${subs.priceLabel()}:`,
    `\`subscribe you@example.com\` (your email is for the payment receipt)`,
    limit > 0 ? `` : null,
    limit > 0 ? `🆓 *Free for small accounts:* if your Binance Spot balance is ${usd(limit)} or less, the bot is free. Connect Binance with \`golive\` (or send \`balance\` if you already have) and access opens straight away.` : null,
    ``,
    `\`account\` shows your status.`,
  ].filter(x => x !== null).join('\n');
}

function isAdmin(chatId) {
  const admin = adminId();
  return !!admin && chatId?.toString() === admin.toString();
}

const isChatId = (v) => /^-?\d{3,}$/.test(String(v || ''));

// ─── Notify admin of new access request ───────────────────────────────────────
async function notifyAdminNewRequest(user) {
  if (!adminId()) return;
  const name = nameOf(user);
  await send(adminId(), [
    `🔔 *New Access Request*`,
    ``,
    `👤 *Name:* ${name}`,
    `🆔 *Chat ID:* \`${user.chatId}\``,
    `⏰ ${new Date().toUTCString()}`,
    ``,
    `Tap a button to approve or reject:`,
  ].join('\n'), {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `approve:${user.chatId}` },
      { text: '❌ Reject',  callback_data: `reject:${user.chatId}`  },
    ]],
  });
}

// ─── Handle admin approval callbacks ─────────────────────────────────────────
async function handleApproval(action, targetId, adminChatId) {
  if (!isAdmin(adminChatId)) return;

  if (action === 'approve') {
    const ok = await approveUser(targetId);
    if (ok) {
      // Notify admin
      const user = await getUser(targetId);
      await reply(adminChatId, `✅ *${nameOf(user)}* has been approved.`);
      // Welcome the new user
      await send(targetId, [
        `🎉 *Your access has been approved!*`,
        ``,
        `Welcome to CryptoBot V2. You now have full access.`,
        ``,
        `Tap the *📋 MENU* button below to get started.`,
      ].join('\n'), PERSISTENT_MENU);
    }
  }

  if (action === 'reject') {
    const user = await getUser(targetId);
    await blockUser(targetId);
    await reply(adminChatId, `❌ *${nameOf(user)}* has been rejected.`);
    await send(targetId, [
      `❌ *Access Denied*`,
      ``,
      `Your request to use CryptoBot V2 was not approved.`,
    ].join('\n'), { remove_keyboard: true });
  }
}

// ─── Main command handler ─────────────────────────────────────────────────────
async function handleMessage(chatId, text, from, meta = {}) {
  const cleanText = text.trim().startsWith('/') ? text.trim().slice(1) : text.trim();
  const parts     = cleanText.split(/\s+/);
  // "/buy@MyBot SOL 1" (group chats) → "buy"
  const cmd       = parts[0]?.toLowerCase().split('@')[0];

  // ── START / New user flow ────────────────────────────────────────────────
  if (cmd === 'start') {
    // Deep link parameter — e.g. /start welcome or /start ref_john
    const param = parts[1] || '';

    if (isAdmin(chatId)) {
      await send(chatId, [
        `👑 *Welcome back, Admin!*`,
        ``,
        `Tap *📋 MENU* to access all commands.`,
        ``,
        `*Admin commands:*`,
        `\`pending\`   — view pending requests`,
        `\`users\`     — view approved users`,
        `\`block ID\`  — block a user`,
        `\`remove ID\` — remove a user`,
        `\`approve ID\` — approve a user`,
        `\`invite\`    — get your invite link`,
      ].join('\n'), {
        keyboard: [
          [{ text: '📋 MENU' }, { text: '🔗 Invite Link' }],
          [{ text: '⏳ Pending' }, { text: '👥 Users' }],
        ],
        resize_keyboard: true,
        persistent: true,
        input_field_placeholder: 'Tap a button or type a command...',
      });
      return;
    }

    const blocked = await isBlocked(chatId);
    if (blocked) {
      await send(chatId, `❌ You do not have access to this bot.`, { remove_keyboard: true });
      return;
    }

    const approved = await isApproved(chatId);
    if (approved) {
      if (param === 'paid' || param === 'payfailed') { await handleSubscribe(chatId, ['check']); return; }
      await send(chatId, [
        `👋 *Welcome back!*`,
        ``,
        `Tap *📋 MENU* to get started.`,
      ].join('\n'), PERSISTENT_MENU);
      return;
    }

    // New user — show welcome message then request access
    const user = await registerUser({
      chatId,
      firstName: from?.first_name || '',
      lastName:  from?.last_name  || '',
      username:  from?.username   || '',
      param,    // store how they found the bot
    });

    await send(chatId, [
      `🤖 *Welcome to CryptoBot V2!*`,
      ``,
      `📊 *What this bot does:*`,
      `  • Practice with $10,000 of play money at real prices`,
      `  • Buys and sells for you on *your own* Binance account (optional — it can never withdraw)`,
      `  • Watches your positions 24/7: stop, take-profit and target alerts`,
      `  • Uses one tested strategy (breakouts to new highs) and tells you why it buys`,
      `  • Finds newly listed coins and market movers (high risk)`,
      ``,
      `🔒 *This is a private bot.*`,
      `Your access request has been sent to the admin.`,
      `You will be notified here as soon as you are approved.`,
      ``,
      `⏳ *Please wait for approval...*`,
    ].join('\n'), { remove_keyboard: true });

    await notifyAdminNewRequest(user);
    return;
  }

  // ── Check access for all other commands ──────────────────────────────────
  if (!isAdmin(chatId)) {
    const blocked  = await isBlocked(chatId);
    const approved = await isApproved(chatId);

    if (blocked) {
      await send(chatId, `❌ You do not have access to this bot.`);
      return;
    }

    if (!approved) {
      const existing = await getUser(chatId);
      if (!existing) {
        // Unregistered — prompt to start
        await send(chatId, `👋 Please type /start to request access.`);
      } else {
        await send(chatId, `⏳ Your request is pending admin approval. Please wait.`);
      }
      return;
    }

    // Paid access: an ended subscription only allows paying, help and closing positions
    const menuText = text.trim() === '📋 MENU' || text.trim() === '🖥 My Dashboard';
    if (!FREE_COMMANDS.has(cmd) && !menuText && !(await hasAccessNow(chatId))) {
      await send(chatId, await lockedText(chatId), subs.freeLimit() > 0 ? { inline_keyboard: [[{ text: '🔗 Connect Binance (free for small accounts)', callback_data: 'golive' }]] } : undefined);
      return;
    }
  }

  // ── GO-LIVE WIZARD: the next message is an API key / secret ─────────────
  if (!text.trim().startsWith('/') && /^[A-Za-z0-9]{32,128}$/.test(text.trim())) {
    if (await handleWizardKey(chatId, text.trim(), meta)) return;
  }

  // ── ADMIN KEYBOARD BUTTON SHORTCUTS ─────────────────────────────────────
  if (text.trim() === '🔗 Invite Link') {
    await handleMessage(chatId, 'invite', from);
    return;
  }
  if (text.trim() === '⏳ Pending') {
    await handleMessage(chatId, 'pending', from);
    return;
  }
  if (text.trim() === '👥 Users') {
    await handleMessage(chatId, 'users', from);
    return;
  }

  // ── ADMIN ONLY COMMANDS ──────────────────────────────────────────────────
  if (isAdmin(chatId)) {

    // Waiting for a date / price typed after tapping a 💳 Subscriptions button?
    const pending = await store.getJSON(`cryptobot:admin:await:${chatId}`, null);
    if (pending && !text.trim().startsWith('/') && !/^[a-z]+(\s|$)/i.test(text.trim())) {
      await store.del(`cryptobot:admin:await:${chatId}`);
      try {
        if (pending.action === 'givedate') {
          const until = await subs.setUntil(pending.target, text.trim(), { grantedBy: chatId });
          await giftDone(chatId, pending.target, until);
        } else if (pending.action === 'price') {
          const p = await subs.setPlan({ price: text.trim() });
          await send(chatId, `✅ Price set: *${subs.priceLabel()}*`, { inline_keyboard: [[b('💳 Back to Subscriptions', 'subs')]] });
        }
      } catch (err) {
        await store.setJSON(`cryptobot:admin:await:${chatId}`, pending);
        await store.cmd('EXPIRE', `cryptobot:admin:await:${chatId}`, 600);
        await reply(chatId, `❌ ${esc(err.message)} — try again, or tap 💳 Subscriptions to cancel.`);
      }
      return;
    }

    if (cmd === 'invite') {
      const BOT_USERNAME = process.env.BOT_USERNAME || 'JijazyBot';
      await reply(chatId, [
        `🔗 *Your Bot Invite Links*`,
        ``,
        `*General invite:*`,
        `https://t.me/${BOT_USERNAME}?start=welcome`,
        ``,
        `*For WhatsApp:*`,
        `https://t.me/${BOT_USERNAME}?start=whatsapp`,
        ``,
        `*For Twitter/X:*`,
        `https://t.me/${BOT_USERNAME}?start=twitter`,
        ``,
        `_Share any of these links. When someone clicks it,_`,
        `_they see the welcome message and you get an_`,
        `_Approve/Reject notification instantly._`,
        ``,
        `💡 Add \`BOT_USERNAME\` to your Vercel env vars`,
        `with your bot's username (without the @)`,
      ].join('\n'));
      return;
    }

    if (cmd === 'pending') {
      const pending = await getUsersByStatus('pending');
      if (pending.length === 0) {
        await reply(chatId, `📭 No pending requests.`);
        return;
      }
      const lines = [`⏳ *Pending Requests (${pending.length})*`, ``];
      pending.forEach(u => {
        lines.push(`👤 *${nameOf(u)}*`);
        lines.push(`   ID: \`${u.chatId}\``);
        lines.push(`   Requested: ${new Date(u.requestedAt).toUTCString()}`);
        lines.push(``);
      });
      lines.push(`To approve: \`approve CHATID\``);
      lines.push(`To reject:  \`block CHATID\``);
      await reply(chatId, lines.join('\n'));
      return;
    }

    if (cmd === 'users') {
      const approved = await getUsersByStatus('approved');
      if (approved.length === 0) {
        await reply(chatId, `📭 No approved users yet.`);
        return;
      }
      const lines = [`✅ *Approved Users (${approved.length})*`, ``];
      approved.forEach(u => {
        lines.push(`👤 *${nameOf(u)}*`);
        lines.push(`   ID: \`${u.chatId}\``);
        lines.push(`   Since: ${new Date(u.approvedAt || u.requestedAt).toUTCString()}`);
        lines.push(``);
      });
      await reply(chatId, lines.join('\n'));
      return;
    }

    if (cmd === 'approve' && isChatId(parts[1])) {
      const ok   = await approveUser(parts[1]);
      const user = await getUser(parts[1]);
      if (ok && user) {
        await reply(chatId, `✅ *${nameOf(user)}* approved.`);
        await send(parts[1], [
          `🎉 *Your access has been approved!*`,
          ``,
          `Welcome to CryptoBot V2. Tap *📋 MENU* to get started.`,
        ].join('\n'), PERSISTENT_MENU);
      } else {
        await reply(chatId, `⚠️ User \`${parts[1]}\` not found.`);
      }
      return;
    }

    if (cmd === 'block' && isChatId(parts[1])) {
      const user = await getUser(parts[1]);
      await blockUser(parts[1]);
      await reply(chatId, `🚫 User \`${parts[1]}\` blocked.`);
      if (user) await send(parts[1], `❌ Your access to CryptoBot V2 has been revoked.`, { remove_keyboard: true });
      return;
    }

    if (cmd === 'grant' && isChatId(parts[1])) {
      // grant ID 30  (days)   ·   grant ID 31/12/2026  (until a date)
      const arg = parts.slice(2).join(' ');
      try {
        const until = subs.parseDate(arg) ? await subs.setUntil(parts[1], arg, { grantedBy: chatId })
          : await subs.extend(parts[1], parseInt(arg, 10) || subs.plan().days, { grantedBy: chatId });
        await giftDone(chatId, parts[1], until);
      } catch (err) { await reply(chatId, `❌ ${esc(err.message)}`); }
      return;
    }

    if (cmd === 'revoke' && isChatId(parts[1])) {
      await subs.revoke(parts[1]);
      await reply(chatId, `⛔ Subscription for \`${parts[1]}\` ended now.`);
      return;
    }

    if (cmd === 'subs' || cmd === 'subscribers' || cmd === 'subscriptions') {
      await handleSubsAdmin(chatId, parts.slice(1));
      return;
    }

    // Only treat `remove <numeric chat id>` as user removal; `remove SOL`
    // falls through to the position-removal command below.
    if (cmd === 'remove' && isChatId(parts[1])) {
      const ok = await removeUser(parts[1]);
      await reply(chatId, ok ? `🗑 User \`${parts[1]}\` removed.` : `⚠️ User not found.`);
      return;
    }
  }

  // ── MENU ─────────────────────────────────────────────────────────────────
  if (cmd === 'menu' || text.trim() === '📋 MENU') {
    await send(chatId, MENU_TEXT(isAdmin(chatId)), menuFor(chatId));
    return;
  }

  // ── DASHBOARD (personal login link) ────────────────────────────────────
  if (cmd === 'dashboard' || cmd === 'web' || text.trim() === '🖥 My Dashboard') {
    if ((parts[1] || '').toLowerCase() === 'logout') {
      await revokeAll(chatId);
      await reply(chatId, `🔒 All your dashboard links are now signed out. Send /dashboard for a new one.`);
      return;
    }
    const link = await dashboardLink(chatId);
    await send(chatId, [
      `🖥 *Your personal dashboard*`,
      ``,
      `Live P&L on every position, your stops and targets, trade history, and buttons to add, update or close positions.`,
      ``,
      `🔐 This link logs you in — *don't share it*. It works for 30 days.`,
      `Lost it or shared it by mistake? Send \`dashboard logout\` to sign out everywhere.`,
    ].join('\n'), { inline_keyboard: [[{ text: '🖥 Open my dashboard', url: link }]] });
    return;
  }

  // ── PRACTICE (play money, real Binance prices) ──────────────────────────
  if (cmd === 'practice' || cmd === 'paper' || cmd === 'demo') {
    await handlePractice(chatId, parts.slice(1));
    return;
  }

  // ── BALANCE (the user's own Binance Spot wallet) ────────────────────────
  if (cmd === 'balance' || cmd === 'wallet' || cmd === 'bal') {
    try {
      const b = await accounts.getBalances(chatId);
      const small = !b.testnet && subs.enabled() && subs.freeLimit() > 0 && !isAdmin(chatId) ? await subs.recordBalance(chatId, b.totalUsd).catch(() => null) : null;
      const n = (x) => String(+Number(x).toFixed(8));
      const lines = [
        `💰 *Your Binance balance*${b.testnet ? ' (testnet — fake money)' : ''}`,
        ``,
        `*Total:* ${usd(b.totalUsd)}`,
        ``,
        ...b.assets.map(a => `• *${a.asset}*: ${n(a.free + a.locked)}${a.usd !== null && !['USDT', 'USDC', 'FDUSD'].includes(a.asset) ? ` ≈ ${usd(a.usd)}` : ''}${a.locked > 0 ? `  _(${n(a.locked)} held by open orders)_` : ''}`),
        b.hiddenDust ? `_+ ${b.hiddenDust} tiny balance${b.hiddenDust === 1 ? '' : 's'} under $1_` : '',
        ``,
        `_Spot wallet only. Coins in Funding or Earn aren't counted — move USDT to Spot for the bot to use it._`,
        small && !(await subs.getSub(chatId)).active ? (small.free
          ? `\n🆓 *Free access:* your balance${small.savingsUsd ? ' (not counting your savings plan)' : ''} is ${usd(small.usd)} — at or under the ${usd(small.limit)} limit, so the bot is free for you.`
          : `\n💳 Your balance${small.savingsUsd ? ' (not counting your savings plan)' : ''} is ${usd(small.usd)} — above the ${usd(small.limit)} free limit. Subscribe to use the bot: \`subscribe\`.`) : '',
      ].filter(x => x !== '');
      await send(chatId, lines.join('\n'), { inline_keyboard: [[{ text: '↻ Refresh', callback_data: 'balance' }, { text: '📊 My positions', callback_data: 'positions' }]] });
    } catch (err) {
      await reply(chatId, `❌ ${err instanceof accounts.TradingError ? err.message : esc(err.message)}`);
    }
    return;
  }

  // ── STOPS: today's stop and signal for every coin ───────────────────────
  if (cmd === 'stops' || cmd === 'coins' || (cmd === 'autobuy' && (parts[1] || '').toLowerCase() === 'coins')) {
    await reply(chatId, `⏳ Working out today's stops for every coin…`);
    try {
      const t = await autoBuyer.coinTable();
      const lines = [
        `🛡 *Today's stop for each coin*`,
        `_${esc(t.strategy.label)}_`,
        ``,
        ...t.rows.map(r => r.stop
          ? `${r.signal ? '✅' : '⚪'} *${r.coin}* $${fmtP(r.close)} → stop $${fmtP(r.stop)} (*−${r.stopPct}%*)`
          : `⚪ *${r.coin}* — ${r.reason}`),
        ``,
        `✅ = buy signal today · ⚪ = no signal (the stop shows where it would be if you used \`buynow\`)`,
        t.regimeUp === false ? `⚠️ BTC is below its 100-day average, so the strategy isn't buying anything right now.` : '',
        t.total > t.rows.length ? `_Showing ${t.rows.length} of ${t.total} coins checked (${t.signals} with a buy signal): signals first, then the coins closest to one._` : '',
        `_Prices are yesterday's daily close; stops are recalculated every day. Once you hold a coin, its stop only moves up._`,
      ].filter(Boolean);
      await send(chatId, lines.join('\n'), { inline_keyboard: [[{ text: '⚡ Buy Now', callback_data: 'buynow' }, { text: '🛒 Auto-buy', callback_data: 'autobuy' }]] });
    } catch (err) {
      await reply(chatId, `❌ Couldn't work out the stops right now: ${esc(err.message)}`);
    }
    return;
  }

  // ── BUY NOW (the user picks the coin; the strategy manages the exit) ────
  if (cmd === 'buynow' || cmd === 'buy_now') {
    await handleBuyNow(chatId, parts.slice(1), 'live');
    return;
  }

  // ── AUTO-BUY (practice now; live only after proven results) ─────────────
  if (cmd === 'autobuy') {
    await handleAutoBuy(chatId, parts.slice(1));
    return;
  }

  // ── WHAT TO EXPECT for an amount ─────────────────────────────────────────
  if (cmd === 'expect' || cmd === 'estimate') {
    const amt = Number(String(parts[1] || '').replace(/[$,]/g, ''));
    if (amt > 0) { await send(chatId, expectations.message(amt), { inline_keyboard: [[{ text: '🐷 Weekly savings plan', callback_data: 'save' }, { text: '🚀 Go live', callback_data: 'golive' }]] }); return; }
    let total = null;
    try { if ((await accounts.getStatus(chatId)).connected) total = (await accounts.getBalances(chatId)).totalUsd; } catch { /* fall back to the table */ }
    if (total > 0) { await send(chatId, expectations.message(total), { inline_keyboard: [[{ text: '🐷 Weekly savings plan', callback_data: 'save' }]] }); return; }
    await reply(chatId, [expectations.table(), ``, `For any amount, send e.g. \`expect 50\`.`].join('\n'));
    return;
  }

  // ── WEEKLY SAVINGS PLAN ──────────────────────────────────────────────────
  if (cmd === 'save' || cmd === 'savings' || cmd === 'saving') {
    await handleSavings(chatId, parts.slice(1));
    return;
  }

  // ── GO LIVE (step-by-step Binance set-up) ───────────────────────────────
  if (cmd === 'golive' || cmd === 'live') {
    await handleGoLive(chatId, parts.slice(1));
    return;
  }

  // ── SUBSCRIPTION (paid access) ───────────────────────────────────────────
  if (cmd === 'subscribe' || cmd === 'renew' || cmd === 'pay') {
    await handleSubscribe(chatId, parts.slice(1));
    return;
  }
  if (cmd === 'account' || cmd === 'subscription' || cmd === 'plan') {
    await handleSubscribe(chatId, ['status']);
    return;
  }

  // ── AUTOTRADE (automated exits on the user's Binance account) ───────────
  if (cmd === 'autotrade' || cmd === 'autoexit' || cmd === 'autoexits') {
    await handleAutotrade(chatId, parts.slice(1), meta);
    return;
  }

  // ── HELP ─────────────────────────────────────────────────────────────────
  if (cmd === 'help') {
    await reply(chatId, [
      `🤖 *All commands* — or just tap *📋 MENU*`,
      ``,
      `━━━ *YOUR TRADES* ━━━`,
      `\`buy SOL 92.50\` — track a buy · add a quantity: \`buy SOL 92.50 2\``,
      `\`buy SOL 92.50 2x\` / \`10%\` — with a target · \`sl 88\` — your own stop`,
      `\`buy PEPE 0.0000098 ex mexc\` — coin on another exchange`,
      `\`positions\` — your open trades · \`check SOL\` — live advice`,
      `\`setstop SOL 90\` — change a stop`,
      `\`sold SOL 92.50 110\` — record a sale (tracks profit)`,
      `\`sell SOL\` — stop tracking (nothing recorded)`,
      `\`profit\` — your stats · \`split 100\` — split capital across top coins`,
      ``,
      `━━━ *AUTO-TRADING (real money)* ━━━`,
      `\`golive\` — connect Binance step by step, then turn on auto-trading`,
      `\`golive off\` — stop the bot buying and selling`,
      `\`buynow SOL 50\` — buy $50 of SOL now; the bot manages the sale`,
      `\`balance\` — your Binance Spot wallet`,
      `\`autobuy\` — the bot's buying strategy, test results and settings`,
      `\`stops\` — today's buy signals and stop-losses across all Binance coins`,
      `\`expect 50\` — what to expect with $50 (or any amount)`,
      ``,
      `━━━ *WEEKLY SAVINGS* ━━━`,
      `\`save 10\` — buy $10 of BTC/ETH every week · \`save\` — your plan`,
      `\`save day monday\` · \`save real\` / \`practice\` · \`save now\` · \`save pause\` · \`save stop\``,
      ``,
      `━━━ *PRACTICE (play money)* ━━━`,
      `\`practice\` — your $10,000 practice account`,
      `\`practice buy SOL 100\` · \`practice buynow SOL 50\` · \`practice sell SOL\` · \`practice reset\``,
      `\`autobuy on\` / \`off\` — let the bot buy with your play money`,
      ``,
      `━━━ *MARKET* ━━━`,
      `\`scan\` · \`moonshots\` — Binance coins with strong momentum (high risk)`,
      `\`newlistings\` — new coins with contract addresses`,
      ``,
      `━━━ *ACCOUNT* ━━━`,
      `\`dashboard\` — your web dashboard · \`dashboard logout\` — sign out everywhere`,
      subs.enabled() ? `\`account\` — your subscription · \`subscribe\` — renew` : `\`account\` — your access`,
      `\`manual\` — the full user guide`,
      `\`ask\` — ask the AI helper a question (or just type it) — it explains, it never trades`,
      isAdmin(chatId) ? `\n━━━ *ADMIN* ━━━\n\`pending\` · \`users\` · \`approve ID\` · \`block ID\` · \`remove ID\` · \`invite\`\n\`subs\` (panel: on/off, plan, give, free for small accounts) · \`subs free 100\` · \`grant ID DAYS\` or \`grant ID 31/12/2026\` · \`revoke ID\`\n\`autobuy run\` · \`autobuy pause\`/\`resume\` · \`autobuy unlock\`/\`lock\`` : '',
    ].filter(x => x !== '').join('\n'));
    return;
  }

  // ── SCAN ─────────────────────────────────────────────────────────────────
  if (cmd === 'scan' || cmd === 'search' || cmd === 'find') {
    await reply(chatId, `🔍 Scanning Binance coins for momentum... about 30 seconds.`);
    try {
      const { getMoonshots } = require('../src/services/listingsService');
      const moonshots = await getMoonshots();

      if (moonshots.length === 0) {
        await reply(chatId, `😴 Nothing scores high enough right now. Try again in 30-60 minutes.`);
        return;
      }

      const onBinance = moonshots.source !== 'KuCoin';
      await reply(chatId, onBinance
        ? `✅ *Found ${moonshots.length} pick${moonshots.length > 1 ? 's' : ''} on Binance*`
        : `✅ *Found ${moonshots.length} pick${moonshots.length > 1 ? 's' : ''} on KuCoin*\n⚠️ _Binance couldn't be reached, so these come from KuCoin and may not be on Binance._`);

      for (const coin of moonshots) {
        const meta     = coin.meta;
        const priceStr = coin.price < 0.001 ? coin.price.toFixed(8)
          : coin.price < 0.01 ? coin.price.toFixed(6) : coin.price.toFixed(4);
        const cgPrice  = meta?.currentPrice
          ? (meta.currentPrice < 0.001 ? meta.currentPrice.toFixed(8) : meta.currentPrice.toFixed(4))
          : priceStr;

        const t2x = (parseFloat(cgPrice) * 2).toFixed(6);
        const t3x = (parseFloat(cgPrice) * 3).toFixed(6);
        const t5x = (parseFloat(cgPrice) * 5).toFixed(6);

        const bandEmoji = { 'VERY HIGH':'🟢','HIGH':'🟡','MODERATE':'🟠','LOW':'🔴' }[coin.band] || '⚪';

        const lines = [
          `🌕 *${meta?.name || coin.base} (${coin.base})*`,
          ``,
          `${bandEmoji} *Score: ${coin.probability}/92 — ${coin.band}*`,
          `_Heuristic score, not a probability — this scanner has not been backtested._`,
          ``,
          `🏦 *Exchange:*  ${coin.exchange === 'kucoin' ? 'KuCoin' : 'Binance'} (${coin.base}/USDT)`,
          `💰 *Price:*     \`$${cgPrice}\``,
          `📈 *24H:*       +${coin.change24h.toFixed(2)}%`,
          `💵 *Volume:*    $${(coin.volume / 1e6).toFixed(2)}M`,
          meta?.marketCap ? `🏦 *Market Cap:* $${(meta.marketCap / 1e6).toFixed(1)}M` : '',
          coin.isTrending ? `🔥 *Trending on CoinGecko*` : '',
          ``,
          `🎯 *Targets:*`,
          `  2X → \`$${t2x}\``,
          `  3X → \`$${t3x}\``,
          `  5X → \`$${t5x}\``,
          ``,
          `📊 *Factor Scores:*`,
          `  Volume:    ${coin.factors?.volumeQuality?.score || 0}/${coin.factors?.volumeQuality?.max || 20}`,
          `  Structure: ${coin.factors?.priceStructure?.score || 0}/${coin.factors?.priceStructure?.max || 20}`,
          `  Liquidity: ${coin.factors?.liquidity?.score || 0}/${coin.factors?.liquidity?.max || 15}`,
          `  Momentum:  ${coin.factors?.momentum?.score || 0}/${coin.factors?.momentum?.max || 15}`,
          ``,
          (coin.greenSignals || []).length > 0 ? `✅ *Signals:*` : '',
          ...(coin.greenSignals || []).slice(0, 3).map(g => `  • ${g}`),
          (coin.redFlags || []).length > 0 ? `\n⚠️ *Warnings:*` : '',
          ...(coin.redFlags || []).slice(0, 3).map(f => `  • ${f}`),
          ``,
        ];

        if (meta?.contracts?.length > 0) {
          lines.push(`📋 *Contract Addresses:*`);
          meta.contracts.slice(0, 3).forEach(ct => {
            lines.push(`  *${ct.chainLabel}:*`);
            lines.push(`  \`${ct.address}\``);
          });
          lines.push(`⚠️ _Verify on CoinGecko before buying_`);
        } else {
          lines.push(`⚠️ _Verify contract on CoinGecko_`);
        }

        if (meta?.cgUrl) lines.push(`🔗 ${meta.cgUrl}`);
        lines.push(``);
        lines.push(`💼 *Position size:* ${coin.positionAdvice}`);
        const ex = coin.exchange === 'kucoin' ? 'kucoin' : 'binance';
        lines.push(`📝 Bought it yourself? Track it: \`buy ${coin.base} ${cgPrice} 2x ex ${ex}\``);
        if (ex === 'binance') lines.push(`⚡ Or buy on Binance now (real money, high risk): \`buynow ${coin.base} 10\` · practice: \`practice buynow ${coin.base} 100\``);

        await replyChunked(chatId, lines.filter(Boolean).join('\n'));
      }
    } catch (err) {
      await reply(chatId, `❌ Scan failed: ${err.message}`);
    }
    return;
  }

  // ── MOONSHOTS ─────────────────────────────────────────────────────────────
  if (cmd === 'moonshots' || cmd === 'moon' || cmd === '5x') {
    await handleMessage(chatId, 'scan', from);
    return;
  }

  // ── NEW LISTINGS ──────────────────────────────────────────────────────────
  if (cmd === 'newlistings' || cmd === 'listings' || cmd === 'new') {
    await reply(chatId, `🔍 Scanning new listings... 20 seconds.`);
    try {
      const { getNewListingsWithMetadata } = require('../src/services/listingsService');
      const { hotCoins, trending }         = await getNewListingsWithMetadata();

      if (hotCoins.length === 0 && trending.length === 0) {
        await reply(chatId, `😴 No strong new listings right now. Check back soon.`);
        return;
      }

      if (hotCoins.length > 0) {
        await reply(chatId, `🔥 *Top New Listings*`);
        for (const coin of hotCoins.slice(0, 5)) {
          const meta     = coin.meta;
          const priceStr = coin.price < 0.01 ? coin.price.toFixed(8) : coin.price.toFixed(4);
          const lines    = [
            `🚀 *${meta?.name || coin.base} (${coin.base})*`,
            `💰 Price: \`$${priceStr}\``,
            `📈 24H: +${coin.change24h.toFixed(2)}%`,
            `💵 Volume: $${(coin.volume / 1e6).toFixed(2)}M`,
            meta?.description ? `📄 _${meta.description.slice(0, 100)}_` : '',
            ``,
          ];
          if (meta?.contracts?.length > 0) {
            lines.push(`📋 *Contracts:*`);
            meta.contracts.slice(0, 2).forEach(ct => {
              lines.push(`  *${ct.chainLabel}:* \`${ct.address}\``);
            });
          }
          if (meta?.cgUrl) lines.push(`🔗 ${meta.cgUrl}`);
          lines.push(`📝 \`buy ${coin.base} ${priceStr}\``);
          await replyChunked(chatId, lines.filter(Boolean).join('\n'));
        }
      }

      if (trending.length > 0) {
        await reply(chatId, `🌊 *CoinGecko Trending*`);
        for (const c of trending.slice(0, 3)) {
          const p = c.currentPrice ? (c.currentPrice < 0.01 ? c.currentPrice.toFixed(8) : c.currentPrice.toFixed(4)) : 'N/A';
          const lines = [
            `🌊 *${c.name} (${c.symbol})*`,
            `💰 Price: \`$${p}\``,
            `📈 24H: ${c.priceChange24h ? (c.priceChange24h >= 0 ? '+' : '') + c.priceChange24h.toFixed(2) + '%' : 'N/A'}`,
            `💵 Volume: ${c.volume24h ? '$' + (c.volume24h / 1e6).toFixed(2) + 'M' : 'N/A'}`,
            ``,
          ];
          if (c.contracts?.length > 0) {
            lines.push(`📋 *Contracts:*`);
            c.contracts.slice(0, 2).forEach(ct => {
              lines.push(`  *${ct.chainLabel}:* \`${ct.address}\``);
            });
          }
          if (c.cgUrl) lines.push(`🔗 ${c.cgUrl}`);
          if (c.currentPrice) lines.push(`📝 \`buy ${c.symbol} ${p}\``);
          await replyChunked(chatId, lines.filter(Boolean).join('\n'));
        }
      }
    } catch (err) {
      await reply(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  // ── BUY ───────────────────────────────────────────────────────────────────
  if (cmd === 'buy') {
    // "confirm" = the user already saw the price warning below
    let confirmed = false;
    for (let k = parts.length - 1; k > 1; k--) if (String(parts[k]).toLowerCase() === 'confirm') { confirmed = true; parts.splice(k, 1); }
    const rawSymbol = parts[1];
    const buyPrice  = parseFloat(parts[2]);
    let quantity = null, targetMultiple = null, targetPct = null;

    // Optional exchange anywhere after the price: "ex mexc", "on mexc", "@mexc" or just "mexc"
    let wantedExchange = null;
    for (let k = 3; k < parts.length; k++) {
      const t = String(parts[k]).toLowerCase();
      if ((t === 'ex' || t === 'on') && normaliseExchange(parts[k + 1])) { wantedExchange = normaliseExchange(parts[k + 1]); parts.splice(k, 2); k--; continue; }
      const bare = normaliseExchange(t.replace(/^@/, ''));
      if (bare) { wantedExchange = bare; parts.splice(k, 1); k--; }
    }

    // Optional custom stop anywhere after the price: "sl 95", "sl95", "stop=95"
    let userStop = null;
    for (let k = 3; k < parts.length; k++) {
      const t = String(parts[k]).toLowerCase();
      const glued = t.match(/^(?:sl|stop)[:=]?(\d*\.?\d+)$/);
      if (glued) { userStop = parseFloat(glued[1]); parts.splice(k, 1); k--; continue; }
      if ((t === 'sl' || t === 'stop') && !isNaN(parseFloat(parts[k + 1]))) {
        userStop = parseFloat(parts[k + 1]); parts.splice(k, 2); k--;
      }
    }

    // Helper: parse a target token — supports "2x", "10%", "10.5%"
    function parseTarget(token) {
      const t = token.toString().toLowerCase().trim();
      if (t.endsWith('%')) {
        const pct = parseFloat(t);
        if (!isNaN(pct) && pct > 0) {
          targetPct = pct;
          targetMultiple = 1 + pct / 100;
        }
      } else if (t.endsWith('x')) {
        const mult = parseFloat(t);
        if (!isNaN(mult) && mult > 0) targetMultiple = mult;
      }
    }

    if (parts[3]) {
      const p3 = parts[3].toString().toLowerCase();
      if (p3.endsWith('x') || p3.endsWith('%')) parseTarget(p3);
      else quantity = parseFloat(p3);
    }
    if (parts[4]) parseTarget(parts[4]);

    if (!rawSymbol || isNaN(buyPrice) || buyPrice <= 0) {
      await reply(chatId, [
        `❌ *Invalid format*`,
        ``,
        `\`buy SOL 92.50\``,
        `\`buy SOL 92.50 10%\`  ← alert at 10% profit`,
        `\`buy SOL 92.50 2x\`   ← alert at 2X`,
        `\`buy SOL 92.50 5x\`   ← alert at 5X`,
        `\`buy SOL 92.50 10 10%\` ← 10 units + 10% target`,
        `\`buy SOL 92.50 10 5x\` ← 10 units + 5X target`,
      ].join('\n'));
      return;
    }

    const symbol      = normaliseSymbol(rawSymbol);
    const targetPrice = targetMultiple ? buyPrice * targetMultiple : null;

    if (userStop !== null && !(userStop > 0 && userStop < buyPrice)) {
      await reply(chatId, `❌ Stop loss must be below your buy price. Example: \`buy SOL 92.50 2x sl 88\``);
      return;
    }

    // Count existing entries BEFORE adding (old code counted after → off by one)
    const existing = await getPositionsBySymbol(chatId, symbol);
    const entryNum = existing.length + 1;
    // Find where this coin trades (the exchange you named, or auto-detect)
    const found = await resolveExchange(symbol, wantedExchange);

    // Catch "buy PEPE 50" meant as "buy $50 of PEPE": the price is far from the market
    if (found?.price && !confirmed) {
      const ratio = buyPrice / found.price;
      if (ratio > 2 || ratio < 0.5) {
        const coin = symbol.replace('USDT', '');
        const again = `${cleanText.split(/\s+/).join(' ')} confirm`;
        const kb = [];
        if (again.length <= 60) kb.push([{ text: `✅ Yes — I bought at $${buyPrice} each`, callback_data: again }]);
        if (buyPrice >= 5) {
          kb.push([{ text: `⚡ Buy $${buyPrice} of ${coin} now (real money)`, callback_data: `buynow ${coin} ${buyPrice}` }]);
          kb.push([{ text: `🎮 Practice: buy $${buyPrice} of ${coin}`, callback_data: `practice buynow ${coin} ${buyPrice}` }]);
        }
        await send(chatId, [
          `🤔 *Check the price — ${coin}*`,
          ``,
          `${coin} trades at about \`$${fmtP(found.price)}\` right now, but you entered \`$${buyPrice}\` as the price you paid *per coin*.`,
          ``,
          `📝 \`buy ${coin} PRICE\` *logs* a buy you already made — PRICE is what you paid per coin.`,
          `⚡ To *spend* $${buyPrice} on ${coin} now, use \`buynow ${coin} ${buyPrice}\` (or \`practice buynow\` for play money).`,
          ``,
          kb.length && again.length <= 60 ? `If $${buyPrice} per coin is right (an old buy), tap Yes.` : `If $${buyPrice} per coin is right, send the same command with \`confirm\` at the end.`,
        ].join('\n'), { inline_keyboard: kb.length ? kb : [[{ text: '📖 How to log a buy', callback_data: 'buy_help' }]] });
        return;
      }
    }
    if (!found) {
      await reply(chatId, wantedExchange
        ? `❌ ${symbol.replace('USDT', '')}/USDT isn't available on ${PROVIDERS[wantedExchange].name}. Check the ticker, or try another exchange.`
        : `❌ Couldn't find ${symbol.replace('USDT', '')}/USDT on ${EXCHANGE_LIST}.\nCheck the ticker. If it trades elsewhere, the bot can't track it yet.`);
      return;
    }
    const newPos   = await addPosition({ chatId, symbol, buyPrice, quantity, targetMultiple, stopLossPrice: userStop, exchange: found.exchange });

    // Build a human-friendly target label e.g. "10% profit" or "2X"
    const targetLabel = targetPct != null
      ? `${targetPct}% profit`
      : targetMultiple ? `${targetMultiple}X` : null;

    // ── Send immediate confirmation ──────────────────────────────────────
    await reply(chatId, [
      `✅ *Buy #${entryNum} Registered — ${symbol}*`,
      existing.length > 0 ? `📌 _You now have ${entryNum} separate entries for ${symbol}_` : '',
      ``,
      `💰 *Buy Price:* \`$${buyPrice}\``,
      `📍 *Prices from:* ${found.name}${wantedExchange ? '' : ' (auto-detected; add "ex mexc" etc. to choose)'}`,
      quantity    ? `📦 *Quantity:* ${quantity} ${symbol.replace('USDT', '')}` : '',
      targetLabel ? `🎯 *Target:*   ${targetLabel} = \`$${targetPrice.toFixed(6)}\`` : '',
      userStop    ? `🛡 *Your stop:* \`$${userStop}\` (${(((buyPrice - userStop) / buyPrice) * 100).toFixed(2)}% below entry)` : '',
      ``,
      `⏳ _Fetching live price and trade plan..._`,
    ].filter(Boolean).join('\n'));

    // ── Immediate first check — runs right now, no waiting for cron ──────
    // This is what actually starts the alerts. Without this, you'd wait
    // up to 30 mins for the cron to notice the new position.
    try {
      const { candles1h, candles4h, currentPrice } = await fetchCurrentData(symbol, { exchange: found.exchange });

      const advice = buildAdvice({
        symbol, buyPrice, currentPrice, candles1h, candles4h,
        lockedPlan: userStop ? { stopLoss: userStop, takeProfits: null } : null,
      });

      // Lock the stop loss + TPs now, so the 10-min quickcheck watches the stop
      // from the start and every later check uses the same levels.
      const plan = planFromAdvice(advice);
      if (plan) {
        await updatePosition(chatId, newPos.positionId, {
          ...plan,
          initialStopPrice: plan.stopLossPrice,
          ...(userStop ? { stopSource: 'user', stopStage: 'user' } : { stopSource: 'atr', stopStage: 'initial' }),
        });
        // Automated exits on → put the stop order on Binance now (sends its own message)
        await autoTrader.sync(chatId, newPos.positionId, { price: found.exchange === 'binance' ? currentPrice : null }).catch(() => null);
      }

      const sl  = advice.tradePlan?.stopLoss;
      const tp1 = advice.tradePlan?.takeProfits?.tp1;
      const tp2 = advice.tradePlan?.takeProfits?.tp2;
      const tp3 = advice.tradePlan?.takeProfits?.tp3;

      const pnlPct = ((currentPrice - buyPrice) / buyPrice) * 100;
      const pnlStr = `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`;

      // Send the live trade plan to ACTION channel (main chat)
      await reply(chatId, [
        `📡 *Live Check — ${symbol}*`,
        ``,
        `💰 *Your entry:*  \`$${buyPrice}\``,
        `📊 *Live price:*  \`$${currentPrice.toFixed(6)}\``,
        `📈 *P&L now:*     ${pnlStr}`,
        ``,
        `🗺 *Your Trade Plan:*`,
        sl  ? `  🛡 Stop loss:  \`$${sl.toFixed(6)}\`  ← EXIT if hit` : '',
        tp1 ? `  🟢 TP1 (40%):  \`$${tp1.price.toFixed(6)}\`` : '',
        tp2 ? `  🟢 TP2 (35%):  \`$${tp2.price.toFixed(6)}\`` : '',
        tp3 ? `  🟢 TP3 (25%):  \`$${tp3.price.toFixed(6)}\`` : '',
        targetLabel ? `  🎯 Your target: \`$${targetPrice.toFixed(6)}\` (${targetLabel})` : '',
        ``,
        `📌 Milestones (every +10%) and 4-hourly HOLD updates arrive here silently.`,
        ``,
        `⏰ Next auto-check in ~30 mins via cron.`,
        `Type \`check ${symbol.replace('USDT','')}\` anytime for an instant update.`,
      ].filter(Boolean).join('\n'));

    } catch (liveErr) {
      // Live check failed — still confirmed, cron will pick it up
      console.error('[Buy live check]', liveErr.message);
      await reply(chatId, [
        ``,
        `⚠️ _Live price fetch failed (${liveErr.message}) — position is saved and will be monitored by cron._`,
        ``,
        `You will be alerted when:`,
        targetLabel ? `  🎯 Price hits \`$${targetPrice.toFixed(6)}\` (${targetLabel}) → SELL NOW` : '',
        `  🔴 Stop loss hit → exit immediately`,
        `  🟢 TP1 / TP2 / TP3 hit → take partial profit`,
        `  📊 Every 10% milestone (silent)`,
        `  ⚪ Hold update every 4 hours (silent)`,
        ``,
        `\`positions\` to see all your entries`,
      ].filter(Boolean).join('\n'));
    }
    return;
  }

  // ── SELL ──────────────────────────────────────────────────────────────────
  // `sold SOL 92.5 185` (with prices) records a trade — handled further down.
  // Plain `sold SOL` keeps working as an alias for `sell SOL`.
  const isSoldRecord = cmd === 'sold' && parts[1] && parts[2] && parts[3];
  if ((cmd === 'sell' || cmd === 'remove' || cmd === 'sold') && !isSoldRecord) {
    const rawSymbol = parts[1];
    if (!rawSymbol) { await reply(chatId, `❌ Example: \`sell SOL\``); return; }
    const symbol   = normaliseSymbol(rawSymbol);
    const entries  = await getPositionsBySymbol(chatId, symbol);

    if (entries.length === 0) {
      await reply(chatId, `⚠️ *${symbol}* not in your positions.`);
      return;
    }

    // Only one entry — remove it directly
    if (entries.length === 1) {
      await removePositionById(chatId, entries[0].positionId);
      await reply(chatId, [
        `✅ *${symbol}* removed. Good trade! 💸`,
        ``,
        `To track profit, record it next time with:`,
        `\`sold ${symbol.replace('USDT', '')} ${entries[0].buyPrice} SELLPRICE\``,
      ].join('\n'));
      return;
    }

    // Multiple entries — show them and ask which to remove
    const lines = [
      `📌 *You have ${entries.length} entries for ${symbol}*`,
      ``,
      `Which one did you sell?`,
      ``,
    ];
    entries.forEach((pos, i) => {
      lines.push(`*Entry ${i + 1}:*`);
      lines.push(`  Price: \`$${pos.buyPrice}\``);
      if (pos.quantity) lines.push(`  Qty: ${pos.quantity}`);
      if (pos.targetMultiple) lines.push(`  Target: ${pos.targetMultiple}X`);
      lines.push(`  Added: ${new Date(pos.addedAt).toUTCString()}`);
      lines.push(`  To remove: \`sellentry ${pos.positionId}\``);
      lines.push(``);
    });
    lines.push(`To remove ALL ${symbol} entries: \`sellall ${symbol}\``);
    await reply(chatId, lines.join('\n'));
    return;
  }

  // ── SETSTOP (change the saved stop of a position) ─────────────────────────
  if (cmd === 'setstop' || cmd === 'setstopid') {
    const byId = cmd === 'setstopid';
    const price = parseFloat(parts[2]);
    if (!parts[1] || isNaN(price) || price <= 0) {
      await reply(chatId, [
        `❌ *Format:*`,
        `\`setstop SOL 88.5\` — set your stop for SOL`,
        `\`setstopid SOLUSDT:1715123456789 88.5\` — one specific entry`,
      ].join('\n'));
      return;
    }

    let targets;
    if (byId) {
      const all = await getAllPositions(chatId);
      targets = all[parts[1]] ? [all[parts[1]]] : [];
    } else {
      targets = await getPositionsBySymbol(chatId, normaliseSymbol(parts[1]));
    }
    if (targets.length === 0) {
      await reply(chatId, `⚠️ No matching position. Type \`positions\` to see your entries.`);
      return;
    }
    if (targets.length > 1) {
      const lines = [`📌 *You have ${targets.length} ${targets[0].symbol} entries — which one?*`, ``];
      targets.forEach((p, i) => lines.push(`*Entry ${i + 1}* at \`$${p.buyPrice}\` → \`setstopid ${p.positionId} ${price}\``));
      await reply(chatId, lines.join('\n'));
      return;
    }

    const pos = targets[0];
    const live = await fetchPrice(pos.symbol, { exchange: pos.exchange || null });
    if (live && price >= live) {
      await reply(chatId, `❌ A stop must be below the current price (\`$${live}\`). For an immediate exit, just sell on your exchange.`);
      return;
    }
    await updatePosition(chatId, pos.positionId, { stopLossPrice: price, stopSource: 'user', stopStage: 'user', stopLossHit: false });
    const vsEntry = ((price - pos.buyPrice) / pos.buyPrice) * 100;
    await reply(chatId, [
      `🛡 *Stop updated — ${pos.symbol}*`,
      ``,
      `Entry: \`$${pos.buyPrice}\``,
      `New stop: \`$${price}\` (${vsEntry >= 0 ? '+' : ''}${vsEntry.toFixed(2)}% vs entry)`,
      pos.stopLossPrice ? `Old stop: \`$${pos.stopLossPrice}\`` : '',
      ``,
      `The 10-minute price check will alert you if it's hit.`,
    ].filter(Boolean).join('\n'));
    await autoTrader.sync(chatId, pos.positionId).catch(() => null); // moves the Binance stop order if auto-exits are on
    return;
  }

  // ── SELLENTRY (remove specific entry by ID) ───────────────────────────────
  if (cmd === 'sellentry' && parts[1]) {
    const positionId = parts[1];
    const removed    = await removePositionById(chatId, positionId);
    await reply(chatId, removed
      ? `✅ Entry removed. Good trade! 💸`
      : `⚠️ Entry not found. Type \`positions\` to see your entries.`
    );
    return;
  }

  // ── SELLALL (remove all entries for a coin) ───────────────────────────────
  if (cmd === 'sellall' && parts[1]) {
    const symbol  = normaliseSymbol(parts[1]);
    const removed = await removeAllBySymbol(chatId, symbol);
    await reply(chatId, removed > 0
      ? `✅ All ${removed} ${symbol} entries removed. Great trading! 💸`
      : `⚠️ No ${symbol} positions found.`
    );
    return;
  }

  // ── POSITIONS ─────────────────────────────────────────────────────────────
  if (cmd === 'positions' || cmd === 'pos') {
    const entries = Object.values(await getAllPositions(chatId)).sort((a, b) => new Date(a.addedAt) - new Date(b.addedAt));
    const practiceOpen = (await practice.getAccount(chatId, { create: false })) ? (await practice.getPositions(chatId)).length : 0;
    const practiceBtn = { inline_keyboard: [[{ text: `🎮 See my PRACTICE positions${practiceOpen ? ` (${practiceOpen})` : ''}`, callback_data: 'practice' }]] };

    if (entries.length === 0) {
      await send(chatId, [
        `💰 *REAL MONEY — your positions*`,
        ``,
        `📭 No real positions open.`,
        `Buy now: \`buynow SOL 50\` · or log a buy you made: \`buy SOL 92.50 2\``,
        ``,
        `_🎮 Practice (play money) is kept separately._`,
      ].join('\n'), practiceBtn);
      return;
    }

    const autoOn = await autoTrader.isOn(chatId);
    const managed = entries.filter(p => p.strategy || (autoOn && autoTrader.eligible(p)));
    const tracked = entries.filter(p => !managed.includes(p));
    const fmtPos = (pos) => {
      const ex = pos.exchange ? ` · ${PROVIDERS[pos.exchange]?.name || pos.exchange}` : '';
      return [
        `*${pos.symbol.replace('USDT', '')}*${ex}`,
        `  Entry \`$${pos.buyPrice}\`${pos.quantity ? ` · Qty ${+Number(pos.quantity).toFixed(8)}` : ''}`,
        pos.stopLossPrice ? `  🛡 Stop \`$${fmtP(pos.stopLossPrice)}\`${pos.strategy ? ' (trailing)' : ''}${pos.auto?.stopOrderId ? ' · order on Binance ✅' : ''}` : '',
        pos.targetMultiple ? `  🎯 Target ${pos.targetMultiple}X = \`$${pos.targetPrice?.toFixed(6)}\`` : '',
        `  Status: ${pos.lastRecommendation || 'waiting for first check'}`,
        `  _id: ${pos.positionId}_`,
      ].filter(Boolean).join('\n');
    };

    const lines = [`💰 *REAL MONEY — your positions (${entries.length})*`, ``];
    if (managed.length) {
      lines.push(`🤖 *Managed by the bot on your Binance account*`, `_The bot sells these for you._`, ``);
      managed.forEach(p => lines.push(fmtPos(p), ``));
    }
    if (tracked.length) {
      lines.push(`📝 *Tracked only — you sell these yourself*`, `_The bot sends alerts; you place the sale on your exchange._`, ``);
      tracked.forEach(p => lines.push(fmtPos(p), ``));
    }
    lines.push(`_🎮 Practice (play money) positions are kept separately._`);
    await replyChunked(chatId, lines.join('\n'));
    await send(chatId, `🎮 *Practice* is separate from your real money.`, practiceBtn);
    return;
  }

  // ── CHECK ─────────────────────────────────────────────────────────────────
  if (cmd === 'check') {
    const rawSymbol = parts[1];
    if (!rawSymbol) { await reply(chatId, `❌ Example: \`check SOL\``); return; }
    const symbol  = normaliseSymbol(rawSymbol);
    const entries = await getPositionsBySymbol(chatId, symbol);

    if (entries.length === 0) {
      await reply(chatId, `⚠️ *${symbol}* not in positions.\n\nAdd it: \`buy ${symbol} YOUR_PRICE\``);
      return;
    }

    await reply(chatId, `🔍 Checking *${symbol}* (${entries.length} entr${entries.length > 1 ? 'ies' : 'y'})...`);

    try {
      // Entries can be on different exchanges: fetch each exchange once
      const marketByEx = {};
      for (let i = 0; i < entries.length; i++) {
        const pos    = entries[i];
        const exKey  = pos.exchange || '';
        marketByEx[exKey] = marketByEx[exKey] || await fetchCurrentData(symbol, { exchange: pos.exchange || null });
        const { candles1h, candles4h, currentPrice } = marketByEx[exKey];
        const lockedPlan = pos.stopLossPrice ? { stopLoss: pos.stopLossPrice, takeProfits: pos.takeProfits || null } : null;
        const advice = buildAdvice({ symbol, buyPrice: pos.buyPrice, currentPrice, candles1h, candles4h, lockedPlan });
        if (!lockedPlan) {
          const plan = planFromAdvice(advice);
          if (plan) await updatePosition(chatId, pos.positionId, plan);
        }
        const tp1    = advice.tradePlan?.takeProfits?.tp1;
        const tp2    = advice.tradePlan?.takeProfits?.tp2;
        const tp3    = advice.tradePlan?.takeProfits?.tp3;
        const sl     = advice.tradePlan?.stopLoss;
        const emoji  = { STOP_LOSS:'🔴',TAKE_PROFIT:'🟢',TRAIL_STOP:'🟡',CLOSE_PARTIAL:'🟠',HOLD:'⚪' }[advice.recommendation] || '⚪';

        const lines = [
          entries.length > 1 ? `*Entry ${i + 1} of ${entries.length}*` : '',
          `${emoji} *${advice.recommendation} — ${symbol}*`,
          ``,
          `💰 *Bought:* \`$${pos.buyPrice}\``,
          pos.quantity ? `📦 *Qty:* ${pos.quantity}` : '',
          `📊 *Now:*    \`$${Number(advice.currentPrice).toFixed(6)}\``,
          `📈 *P&L:*    ${advice.pnlDisplay}`,
          pos.targetMultiple ? `🎯 *${pos.targetMultiple}X:* \`$${pos.targetPrice?.toFixed(6)}\`` : '',
          ``,
          ...(advice.reasons || []).map(r => `  ${r}`),
          ``,
          ...(advice.actions || []).map(a => `  👉 ${a}`),
          ``,
          sl  ? `🛡 Stop: \`$${Number(sl).toFixed(6)}\`` : '',
          tp1 ? `🎯 TP1:  \`$${Number(tp1.price).toFixed(6)}\`` : '',
          tp2 ? `🎯 TP2:  \`$${Number(tp2.price).toFixed(6)}\`` : '',
          tp3 ? `🎯 TP3:  \`$${Number(tp3.price).toFixed(6)}\`` : '',
        ].filter(Boolean).join('\n');

        await reply(chatId, lines);
      }
    } catch (err) {
      await reply(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  // ── MANUAL ───────────────────────────────────────────────────────────────
  if (cmd === 'manual' || cmd === 'guide') {
    // Figures come from the latest lab result, so the manual never goes stale
    const lab = expectations.stats();
    const labYears = lab.years.toFixed(1);
    const payLine = !subs.enabled()
      ? `The bot is free to use right now.`
      : [`Access costs ${subs.priceLabel()} (\`subscribe you@example.com\`; card, bank transfer or USSD).`,
        subs.freeLimit() > 0 ? `🆓 *Free for small accounts:* if your Binance Spot balance is ${usd(subs.freeLimit())} or less, you don't pay. Coins bought by your savings plan don't count. It's checked when you connect and every day.` : ''].filter(Boolean).join('\n');
    // Send manual in chunks — it is long
    const sections = [

      // ── Section 1 ──
      [`📚 *JijazyBot — User Manual*`,
      ``,
      `━━━ *WHAT IS JIJAZYBOT?* ━━━`,
      ``,
      `JijazyBot is a crypto trading assistant inside Telegram. It can:`,
      ``,
      `• *Watch your trades* on 7 exchanges (Binance, Bybit, OKX, Gate, MEXC, KuCoin, Kraken) and alert you at your stop, take-profits and targets.`,
      `• *Practise with play money* — $10,000 that isn't real, at live prices with real fees.`,
      `• *Buy and sell for you on your own Binance account* — only if you connect it and switch it on.`,
      ``,
      `Every message about real money starts with 💰 *REAL*. Every message about play money starts with 🎮 *PRACTICE*.`,
      ].join('\n'),

      // ── Section 2 ──
      [`🔐 *YOUR MONEY STAYS YOURS*`,
      ``,
      `✅ Your money always stays in *your own Binance account*. The bot never holds it.`,
      `✅ The bot only trades if you connect Binance (\`golive\`) and turn auto-trading on.`,
      `✅ Binance keys that can *withdraw* are refused — the bot can buy and sell, never take money out.`,
      `✅ Your keys are deleted from the chat and stored encrypted.`,
      `✅ \`golive off\` stops all buying and selling at once.`,
      ``,
      `Without Binance connected, the bot only tracks and alerts — you place every trade yourself.`,
      ].join('\n'),

      // ── Section 3 ──
      [`🚦 *HOW TO START*`,
      ``,
      `*1. Practise first (no risk)*`,
      `Tap 🎮 *Practice* or send \`practice\`. Then send \`autobuy on\` and the bot will buy and sell with your play money, using the same rules as real trading. Watch it for a few weeks.`,
      ``,
      `*2. Go live when you're ready*`,
      `Tap 🤖 *Auto-trading* or send \`golive\`. The wizard takes you through 4 steps:`,
      `  1. A Binance account`,
      `  2. Buying USDT with Naira on P2P, then moving it from *Funding* to *Spot*`,
      `  3. Creating an API key with the bot's 2 IP addresses`,
      `  4. Pasting the key and secret here`,
      `Then one button turns auto-trading on.`,
      ``,
      `*3. Check your money*`,
      `\`balance\` shows your Binance Spot wallet. \`positions\` shows your real trades.`,
      ``,
      `*Small amount?* Send \`expect 20\` (or your amount) to see honest numbers first, and consider the weekly savings plan: \`save 10\`.`,
      ].join('\n'),

      // ── Section 4 ──
      [`🤖 *HOW THE BOT BUYS*`,
      ``,
      `⚡ *Buy Now — you choose the coin*`,
      `\`buynow SOL 50\` buys $50 of SOL. The bot tells you if the strategy agrees today, asks you to confirm, buys, places a stop order on Binance and moves it up as the price rises.`,
      `Practice version: \`practice buynow SOL 50\`.`,
      ``,
      `🛒 *Auto-buy — the bot chooses*`,
      `Once a day, just after 1am Lagos time, the bot checks *every liquid Binance coin* with the same rule. It buys a coin when it closes above its *55-day high*, but only while *BTC is above its 100-day average*. Every buy comes with a message explaining why.`,
      ``,
      `Safety limits: about 1% of your account at risk per trade · no coin above 20% · at most 5 positions · no new buys after a 3% drop in a day.`,
      ``,
      `*Selling:* every auto-bought trade is sold at the next daily check, or sooner if its stop is hit — the lower of the 20-day low and 2× the coin's usual daily move. \`stops\` shows today's stop for the coins that signal.`,
      ``,
      `Practice auto-buy: \`autobuy on\` / \`autobuy off\`.`,
      `Real auto-buy: \`autobuy live on\` — opens once the strategy has passed its 8-week live test.`,
      ].join('\n'),

      // ── Section 5 ──
      [`📏 *WHAT TO EXPECT — HONESTLY*`,
      ``,
      `• *Some days nothing is bought.* When BTC is below its 100-day average the bot waits. On a quiet day you get a note saying why. (The test results below come from holding trades for weeks on 15 coins; the daily-close version isn't back-tested yet.)`,
      `• *More than half of trades lose a little.* The fewer, bigger winners are meant to make up for them.`,
      `• *Tested on past data:* it made money after fees on ${lab.trades ?? 'about 100'} trades it was never tuned on. Over ${labYears} years it grew an account about ${Math.round(lab.returnPct)}% (about ${lab.yearlyPct.toFixed(0)}% a year, worst drop ${lab.maxDrawdownPct}%)${lab.btcHoldPct != null ? `, while simply holding BTC made ${Math.round(lab.btcHoldPct)}% — with far bigger drops` : ''}. It aims to be steady, not fast.`,
      `• *No strategy can double your money weekly.* Anyone who promises that is not being honest.`,
      ``,
      `After each trading day you get your result — wins, losses and profit.`,
      ].join('\n'),

      // ── Section 5b ──
      [`🐷 *WEEKLY SAVINGS — BEST FOR SMALL AMOUNTS*`,
      ``,
      `With a small account, *adding money regularly* grows it far more than any strategy can. \`save 10\` sets up a weekly plan: every week, on your chosen day at 9am, the bot buys $10 of BTC/ETH for you.`,
      ``,
      `• *Real money:* top up USDT on Binance (P2P) and move it Funding → Spot before your day. The day before, the bot reminds you if it isn't there.`,
      `• *Practice:* the same plan with play money — \`save practice\`.`,
      `• *The bot never sells your savings.* No stops — this is for months and years.`,
      ``,
      `\`expect 50\` shows what the trading strategy could make with $50 (or any amount), honestly — including that small amounts make small dollars.`,
      ].join('\n'),

      // ── Section 5c ──
      [`💳 *DO I HAVE TO PAY?*`,
      ``,
      payLine,
      ``,
      `\`account\` shows your status. Practice, \`expect\`, \`golive\` and \`balance\` always work, so you can try things and connect before paying.`,
      ai.isConfigured() ? `\n💬 *Ask the bot:* tap 💬 Ask the Bot or just type a question, e.g. _why did the bot buy SOL?_ The AI explains using your own trades; it never buys, sells or predicts prices. ${ai.dailyLimit()} questions a day.` : '',
      ].filter(x => x !== '').join('\n'),

      // ── Section 6 ──
      [`📝 *TRADES YOU MAKE YOURSELF*`,
      ``,
      `Bought on your exchange? Tell the bot so it can watch it:`,
      `\`buy SOL 92.50\` ← price you paid *per coin*`,
      `\`buy SOL 92.50 10\` ← with a quantity`,
      `\`buy SOL 92.50 2x\` or \`10%\` ← with a profit target`,
      `\`buy SOL 92.50 sl 88\` ← with your own stop`,
      `\`buy PEPE 0.0000098 ex mexc\` ← coin on another exchange`,
      ``,
      `\`setstop SOL 90\` — change a stop`,
      `\`sold SOL 92.50 110\` — record a sale (counts in \`profit\`)`,
      `\`sell SOL\` — stop tracking (nothing is sold)`,
      ``,
      `If auto-trading is on, Binance positions with a quantity are *managed by the bot* — it places the stop order and sells at the targets for you. Others are *tracked only*: you get alerts and sell yourself.`,
      ].join('\n'),

      // ── Section 7 ──
      [`🔔 *YOUR ALERTS EXPLAINED*`,
      ``,
      `Positions are checked every 10 minutes (price) and every 30 minutes (full check).`,
      ``,
      `⚪ *HOLD* — every 4 hours. All normal, nothing to do.`,
      `🟢 *TP1* — sell 40% of the position. Stop moves to your buy price.`,
      `🟢🟢 *TP2* — sell another 35%. Stop moves to TP1.`,
      `🟢🟢🟢 *TP3* — sell the rest.`,
      `🎯 *Your target (2x, 10%…)* — sell 60% of what's left. Stop moves to your buy price.`,
      `🔴 *STOP HIT* — sell everything. A small loss now prevents a big one later.`,
      ``,
      `For bot-managed positions these sales happen *automatically* on Binance and you get a 💰 REAL message. For tracked-only positions, you sell yourself.`,
      `Coins bought with Buy Now or auto-buy have no take-profits — they sell when the rising stop is hit.`,
      ].join('\n'),

      // ── Section 8 ──
      [`🔍 *MARKET SCANS (HIGH RISK)*`,
      ``,
      `🔍 *Scan* / 🌕 *Moonshots* — smaller Binance coins moving fast, with a score from 0 to 92 built from 7 checks (volume, price structure, size, liquidity, momentum, social interest, red flags).`,
      `🚀 *New Listings* — new coins with their contract address. Always check the address on CoinGecko to avoid fake tokens.`,
      ``,
      `⚠️ This score has *not* been tested on past data and is not a probability. These coins are *not* bought by auto-buy. If you trade them, use small amounts.`,
      ].join('\n'),

      // ── Section 9 ──
      [`❓ *COMMON QUESTIONS*`,
      ``,
      `*Does the bot buy/sell for me?*`,
      `Only if you ask it to. Without Binance connected it just tracks and alerts. With Binance connected and auto-trading on, it places stop orders and sells for you, buys when you use ⚡ Buy Now, and — once you switch it on — buys by itself with auto-buy. Your money stays in your Binance account, and \`golive off\` stops everything.`,
      ``,
      `*I turned on auto-buy. Why hasn't it bought anything?*`,
      `It only buys on a breakout signal, about 3 times a month across all coins, and never while BTC is below its 100-day average. Send \`autobuy\` to see the last check and why, or \`stops\` to see how close each coin is.`,
      ``,
      `*Why is my Binance balance $0?*`,
      `USDT bought on P2P lands in your *Funding* wallet. Move it to *Spot* in the Binance app, then send \`balance\`.`,
      ``,
      `*What is the smallest amount?*`,
      `$5 per order (Binance's minimum). In practice Buy Now needs about $25 and auto-buy about $50 in your account. The weekly savings plan works from $5 a week.`,
      ``,
      `*Can I make $10–$20 a month from $20?*`,
      `No — that would be 50–100% a month, which no honest strategy makes. Anyone promising it is taking huge risks with your money or running a scheme. Send \`expect 20\` to see realistic numbers.`,
      ``,
      `*Can the bot guarantee profits?*`,
      `No. Losses are normal. Only use money you can afford to lose.`,
      ``,
      `*Can I ask the bot questions?*`,
      `If the admin has switched it on: tap 💬 Ask the Bot or just type your question. The AI explains things using your own trades — it never buys, sells or predicts prices.`,
      ``,
      `*Where can I see everything?*`,
      `Send \`dashboard\` for your private web dashboard, or tap 📋 *MENU*.`,
      ``,
      `_Nothing here is financial advice. Trade responsibly._`,
      ].join('\n'),
    ];

    for (const section of sections) {
      await reply(chatId, section, false);
    }

    await reply(chatId, `✅ *End of Manual*\n\nTap *📋 MENU* to start trading.`, true);
    return;
  }

  // ── PROFIT TRACKER ───────────────────────────────────────────────────────
  if (cmd === 'profit' || cmd === 'stats' || cmd === 'pnl') {
    const stats = await getMonthlyStats(chatId);

    if (!stats.allTime) {
      await reply(chatId, [
        `📊 *No closed trades yet*`,
        ``,
        `When you close a trade, use:`,
        `\`sold SYMBOL BUYPRICE SELLPRICE\``,
        `\`sold SOL 92.50 185.00\``,
        ``,
        `The bot will record the trade and track your profit.`,
      ].join('\n'));
      return;
    }

    const m  = stats.thisMonth;
    const at = stats.allTime;

    // Monthly target progress ($50 on $10 capital)
    const progress = stats.thisMonth
      ? targetProgress(10, 50, stats.thisMonth.totalPnlDollar)
      : null;

    const lines = [
      `📊 *Your Trading Stats*`,
      ``,
      `━━━ *THIS MONTH* ━━━`,
      m ? [
        `💰 P&L: ${m.totalPnlDollar >= 0 ? '+' : ''}$${m.totalPnlDollar.toFixed(2)}`,
        `📈 Total % gain: ${m.totalPnlPct >= 0 ? '+' : ''}${m.totalPnlPct}%`,
        `🎯 Win Rate: ${m.winRate}% (${m.wins}W / ${m.losses}L)`,
        `🔢 Trades: ${m.totalTrades}`,
        `📐 Avg multiple: ${m.avgMultiple}X`,
        m.bestTrade  ? `🏆 Best: ${m.bestTrade.symbol} +${m.bestTrade.pnlPct}%` : '',
        m.worstTrade ? `💔 Worst: ${m.worstTrade.symbol} ${m.worstTrade.pnlPct}%` : '',
      ].filter(Boolean).join('\n') : 'No trades this month yet',
      ``,
      progress ? [
        `━━━ *$50 MONTHLY TARGET* ━━━`,
        `Progress: ${progress.pct}% complete`,
        `Earned: $${stats.thisMonth.totalPnlDollar.toFixed(2)} of $50`,
        `Still need: $${progress.remaining.toFixed(2)} more`,
        progress.remaining > 0
          ? `Need your capital to ${progress.neededMultiple}X from here`
          : `🎉 TARGET REACHED!`,
      ].join('\n') : '',
      ``,
      `━━━ *ALL TIME* ━━━`,
      `💰 Total P&L: ${at.totalPnlDollar >= 0 ? '+' : ''}$${at.totalPnlDollar.toFixed(2)}`,
      `🎯 Win Rate: ${at.winRate}% (${at.wins}W / ${at.losses}L)`,
      `🔢 Total Trades: ${at.totalTrades}`,
      ``,
      `━━━ *RECENT TRADES* ━━━`,
      ...(stats.recentTrades || []).map(t =>
        `${t.outcome === 'WIN' ? '🟢' : '🔴'} ${t.symbol}: ${t.pnlPct >= 0 ? '+' : ''}${t.pnlPct}% (${t.multiple}X)${t.pnlDollar ? ' | $' + t.pnlDollar.toFixed(2) : ''}`
      ),
    ].filter(Boolean).join('\n');

    await reply(chatId, lines);
    return;
  }

  // ── SOLD (record a closed trade) ─────────────────────────────────────────
  if (cmd === 'sold' && parts[1] && parts[2] && parts[3]) {
    const symbol    = normaliseSymbol(parts[1]);
    const buyPrice  = parseFloat(parts[2]);
    const sellPrice = parseFloat(parts[3]);
    const quantity  = parts[4] ? parseFloat(parts[4]) : null;

    if (isNaN(buyPrice) || isNaN(sellPrice) || buyPrice <= 0 || sellPrice <= 0) {
      await reply(chatId, [
        `❌ *Invalid format*`,
        ``,
        `\`sold SYMBOL BUYPRICE SELLPRICE\``,
        `\`sold SOL 92.50 185.00\``,
        `\`sold SOL 92.50 185.00 10\` ← with quantity`,
      ].join('\n'));
      return;
    }

    // Find matching position to get targetMultiple
    const positions = await getPositionsBySymbol(chatId, symbol);
    const matchPos  = positions.find(p => Math.abs(p.buyPrice - buyPrice) <= buyPrice * 0.01);
    const targetMultiple = matchPos?.targetMultiple || null;
    const qty = quantity || matchPos?.quantity || null;

    const trade  = await recordTrade({ chatId, symbol, buyPrice, sellPrice, quantity: qty, targetMultiple });
    const pnlSign = trade.pnlPct >= 0 ? '+' : '';

    // Compounding advice
    const compound = qty
      ? compoundingAdvice(buyPrice * qty, trade.pnlDollar || 0)
      : null;

    const lines = [
      `${trade.outcome === 'WIN' ? '🟢' : '🔴'} *Trade Recorded — ${symbol}*`,
      ``,
      `💰 *Bought at:* \`$${buyPrice}\``,
      `💰 *Sold at:*   \`$${sellPrice}\``,
      `📈 *Result:*    ${pnlSign}${trade.pnlPct}% (${trade.multiple}X)`,
      trade.pnlDollar !== null ? `💵 *P&L:*       ${trade.pnlDollar >= 0 ? '+' : '-'}$${Math.abs(trade.pnlDollar).toFixed(2)}` : '',
      ``,
      trade.outcome === 'WIN' ? `🎉 Winning trade! Great discipline.` : `📉 Losing trade. The stop loss protected you from worse.`,
      ``,
      compound && compound.reinvest > 0 ? [
        `━━━ *COMPOUNDING ADVICE* ━━━`,
        `Keep safe (20%):   $${compound.safeProfit} — never risk this again`,
        `Reinvest (80%):    $${compound.reinvest} — into next trade`,
        `New capital:       $${compound.newCapital}`,
      ].join('\n') : '',
      ``,
      todayLine(await getAllTrades(chatId)),
      `Type \`profit\` to see your full stats.`,
    ].filter(Boolean).join('\n');

    await reply(chatId, lines);

    // Also remove position if it exists
    if (matchPos) {
      await removePositionById(chatId, matchPos.positionId);
      await reply(chatId, `🗑 Removed your open ${symbol} entry at \`$${matchPos.buyPrice}\` from monitoring.`);
    }
    return;
  }

  // ── SPLIT (portfolio allocation advisor) ──────────────────────────────────
  if (cmd === 'split' || cmd === 'allocate') {
    const capital = parts[1] ? parseFloat(parts[1]) : 10;

    if (isNaN(capital) || capital <= 0) {
      await reply(chatId, `❌ Example: \`split 10\` or \`split 50\``);
      return;
    }

    await reply(chatId, `🔍 Scanning for best coins to split $${capital} across...`);

    try {
      const { getMoonshots } = require('../src/services/listingsService');
      const coins    = await getMoonshots();
      const filtered = coins.filter(c => c.probability >= 55);

      if (filtered.length === 0) {
        await reply(chatId, `😴 Nothing scores high enough right now. Try again in 30 minutes.`);
        return;
      }

      const splits = adviseSplit(filtered, capital);
      const progress = targetProgress(capital, 50, 0);

      const lines = [
        `💼 *Portfolio Split for $${capital}*`,
        ``,
        `Based on current market scan — here is exactly how to split your capital:`,
        ``,
      ];

      splits.forEach((s, i) => {
        const priceStr = s.entryPrice < 0.01
          ? s.entryPrice?.toFixed(8)
          : s.entryPrice?.toFixed(4);
        lines.push(`*${i + 1}. ${s.symbol}* — score ${s.probability}/92 (${s.band})`);
        lines.push(`  💰 Allocate: \`$${s.allocation}\` (${s.allocationPct}%)`);
        lines.push(`  🛡 Max loss: \`$${s.maxLoss}\` (stop loss at -15%)`);
        lines.push(`  🎯 2X target: \`$${s.target2x}\``);
        lines.push(`  🎯 3X target: \`$${s.target3x}\``);
        if (priceStr) lines.push(`  📝 \`buy ${s.symbol} ${priceStr} 2x\``);
        lines.push(`  _${s.reasoning}_`);
        lines.push(``);
      });

      lines.push(`━━━ *RULES FOR $${capital}* ━━━`);
      lines.push(`  • Max 3 coins open at any time`);
      lines.push(`  • Never risk more than $${(capital * 0.15).toFixed(2)} per trade`);
      lines.push(`  • When any trade hits 2X → sell 60% immediately`);
      lines.push(`  • After a win → reinvest 80%, bank 20%`);
      lines.push(`  • $50 target needs your $${capital} to ${progress.neededMultiple}X total`);

      await replyChunked(chatId, lines.join('\n'));
    } catch (err) {
      await reply(chatId, `❌ Error: ${err.message}`);
    }
    return;
  }

  // ── BUY / SELL GUIDE ──────────────────────────────────────────────────────
  if (cmd === 'buy_guide') {
    await reply(chatId, [
      `📝 *Log a buy you already made*`,
      ``,
      `\`buy COIN PRICE\` — PRICE is what you paid for *one* coin.`,
      `_To spend money on a coin now, use ⚡ Buy Now: \`buynow SOL 50\` (spends $50)._`,
      ``,
      `*Track only:*`,
      `\`buy SOL 92.50\``,
      ``,
      `*Percentage profit targets:*`,
      `\`buy SOL 92.50 10%\`    — alert at 10% profit`,
      `\`buy SOL 92.50 25%\`    — alert at 25% profit`,
      `\`buy SOL 92.50 10 10%\` — 10 units + 10% target`,
      ``,
      `*Multiplier targets:*`,
      `\`buy BTC 80000 2x\`     — alert at 2X`,
      `\`buy ETH 2300 5x\`      — alert at 5X`,
      `\`buy SOL 92.50 10 2x\`  — 10 units + 2X`,
    ].join('\n'));
    return;
  }

  if (cmd === 'sell_guide') {
    await reply(chatId, [
      `💸 *How to Remove a Position*`,
      ``,
      `\`sell SOL\``,
      `\`sell BTC\``,
      ``,
      `Type \`positions\` to see your entries first.`,
    ].join('\n'));
    return;
  }

  if (cmd === 'sold_guide') {
    await reply(chatId, [
      `💰 *Record a Completed Sale*`,
      ``,
      `After selling on your exchange, record it so`,
      `the bot tracks your profit:`,
      ``,
      `\`sold SYMBOL BUYPRICE SELLPRICE\``,
      ``,
      `Examples:`,
      `\`sold SOL 92.50 185.00\``,
      `\`sold BILL 0.107893 0.215786\``,
      `\`sold ETH 2300 4600 0.5\` ← with quantity`,
      ``,
      `The bot will show your P&L, record the trade`,
      `and give you compounding advice.`,
    ].join('\n'));
    return;
  }

  if (cmd === 'setstop_guide') {
    await reply(chatId, [
      `🛡 *Change the stop on a position*`,
      ``,
      `\`setstop SOL 88.5\` — new stop for SOL`,
      `\`setstopid SOLUSDT:1715123456789 88.5\` — one specific entry (IDs are in \`positions\`)`,
      ``,
      `The stop must be below the current price. With auto-trading on, the bot moves your Binance stop order too.`,
    ].join('\n'));
    return;
  }

  if (cmd === 'check_guide') {
    const coins = [...new Set(Object.values(await getAllPositions(chatId)).map(p => p.symbol.replace(/USDT$/, '')))];
    if (!coins.length) { await reply(chatId, `🔎 *Check a coin*\n\nYou have no open positions yet. Add one: \`buy SOL 150\``); return; }
    const rows = [];
    for (let i = 0; i < coins.length && i < 24; i += 3) rows.push(coins.slice(i, i + 3).map(c => b(`🔎 ${c}`, `check ${c}`)));
    await send(chatId, `🔎 *Check a coin* — live price, P&L and advice. Tap one:`, { inline_keyboard: rows });
    return;
  }

  if (cmd === 'split_guide') {
    await reply(chatId, [
      `💼 *Split Capital Across Best Coins*`,
      ``,
      `Scans the market and tells you exactly how to`,
      `split your money for maximum return:`,
      ``,
      `\`split 10\`  ← split $10`,
      `\`split 50\`  ← split $50`,
      `\`split 100\` ← split $100`,
      ``,
      `Returns the top 3 coins right now with exact`,
      `allocation amounts, stop loss levels and targets.`,
    ].join('\n'));
    return;
  }

  // ── ASK THE BOT (AI helper: explains, never trades) ─────────────────────
  if (cmd === 'ask' || cmd === 'question') {
    const q = text.trim().split(/\s+/).slice(1).join(' ');
    if (!q) {
      if (!ai.isConfigured()) { await reply(chatId, aiOffText(chatId)); return; }
      await store.cmd('SET', askKey(chatId), '1', 'EX', 600);
      await reply(chatId, `💬 *Ask me anything about the bot or your trades* — just type your question.\n\nFor example: _why did the bot buy SOL?_ · _what is a stop-loss?_ · _how do I move USDT to Spot?_\n\nI explain; I don't tell you what to buy or predict prices.`);
      return;
    }
    await answerQuestion(chatId, q);
    return;
  }

  // ── Unknown: a question typed into the chat goes to the AI helper ────────
  const plainText = text.trim();
  const looksLikeQuestion = /\?\s*$/.test(plainText) || plainText.split(/\s+/).length >= 3;
  const looksLikeSecret = /^[A-Za-z0-9]{24,}$/.test(plainText);
  if (ai.isConfigured() && !plainText.startsWith('/') && !looksLikeSecret && (looksLikeQuestion || (await store.cmd('GET', askKey(chatId))))) {
    await answerQuestion(chatId, plainText);
    return;
  }
  await reply(chatId, `❓ Unknown command. Tap *📋 MENU* or type \`help\`.${ai.isConfigured() ? ' Or just type a question — e.g. _why did the bot buy SOL?_' : ''}`);
}

const askKey = (chatId) => `cryptobot:ai:await:${chatId}`;

function aiOffText(chatId) {
  return isAdmin(chatId)
    ? `💬 The AI helper isn't switched on. Add \`OPENAI_API_KEY\` (or \`ANTHROPIC_API_KEY\`) in Vercel → Settings → Environment Variables, then redeploy. See SETUP.md.`
    : `💬 The AI helper isn't switched on for this bot yet. Tap *📋 MENU* → 📚 User Manual, or type \`help\`.`;
}

async function answerQuestion(chatId, question) {
  if (!ai.isConfigured()) { await reply(chatId, aiOffText(chatId)); return; }
  await tg.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});
  try {
    const answer = await ai.ask(chatId, question, { isAdmin: isAdmin(chatId) });
    await store.cmd('SET', askKey(chatId), '1', 'EX', 600); // follow-up questions don't need "ask"
    await tg.send(chatId, `💬 ${answer}\n\n— AI answer: it can make mistakes, and it's not financial advice. Trading decisions are made by the tested strategy, not the AI.`, { plain: true, markup: PERSISTENT_MENU });
  } catch (err) {
    const why = err instanceof ai.AiError ? err.message : 'something went wrong';
    if (why === 'limit') { await reply(chatId, `💬 You've asked ${ai.dailyLimit()} questions today — that's the daily limit. Ask again tomorrow, or see 📚 User Manual.`); return; }
    if (why === 'empty') { await reply(chatId, `💬 Type your question after \`ask\`, e.g. \`ask what is a stop-loss?\``); return; }
    await reply(chatId, `💬 Sorry — I couldn't answer right now (${esc(why)}). Try again in a minute, or see 📚 User Manual.`);
  }
}

// ─── Auto-buy ─────────────────────────────────────────────────────────────────
/** One line warning users when the forward test isn't complete yet. */
async function forwardWarning() {
  const g = await autoBuyer.gateStatus();
  if (g.eligible) return `✅ Forward test complete: ${g.forward.days} days, ${g.forward.closedTrades} trades, in profit.`;
  return `⚠️ *Not proven yet:* the bot's own practice run has ${g.forward.days} of ${g.needs.days} days and ${g.forward.closedTrades} of ${g.needs.trades} trades${g.forward.closedTrades ? `, ${g.forward.equity >= g.forward.start ? 'in profit' : 'currently at a loss'}` : ''}.`;
}

const VERDICT_ICON = { PASS: '✅ PASSED', PROMISING: '🟡 PROMISING (could be luck)', FAIL: '❌ FAILED', 'NOT TESTED': '⚪ NOT TESTED YET' };

async function handleAutoBuy(chatId, args) {
  const a = (args[0] || '').toLowerCase();
  const b = (args[1] || '').toLowerCase();
  try {
    if (a === 'on') {
      await autoBuyer.setPractice(chatId, true);
      const today = await autoBuyer.todayCheck().catch(() => null);
      await reply(chatId, [
        `🤖 *Practice auto-buy ON*`,
        ``,
        `Every day just after midnight (UTC) the bot checks ${autoBuyer.currentStrategy().name.toLowerCase()} signals on ${autoBuyer.universeLabel()} and buys the ones that qualify with your *play money* — about 1% of the account at risk per trade, at most 5 at once.`,
        `It sells every auto-bought trade at the next daily check (or sooner if the stop is hit). You'll get a message for every buy (with the reasons it chose that coin) and every sale — and on days with nothing to buy, a short note saying why.`,
        `_Some days no coin qualifies — that's normal._`,
        ``,
        today ? today.text : `*Your first check:* just after 1am Lagos time.`,
        ``,
        `\`autobuy off\` stops new buys. \`practice\` shows your results.`,
      ].join('\n'));
      return;
    }
    if (a === 'off') {
      await autoBuyer.setPractice(chatId, false);
      await reply(chatId, `⏸ Practice auto-buy OFF. Open practice positions keep their stops until they sell (or \`practice sell COIN\`).`);
      return;
    }
    if (a === 'live') {
      if (b === 'off') { await autoBuyer.setLive(chatId, false); await reply(chatId, `⏸ Live auto-buy OFF. No new buys; open positions keep their Binance stop orders.`); return; }
      if (b === 'on' && (args[2] || '').toLowerCase() === 'confirm') {
        await autoBuyer.setLive(chatId, true);
        await reply(chatId, `🟢 *Live auto-buy ON.* The bot may now buy on your Binance account, about 1% of the account at risk per trade and 5 positions at once. \`autobuy live off\` stops it any time.`);
        return;
      }
      if (b === 'on') {
        if (!(await autoBuyer.isLiveUnlocked())) throw new autoBuyer.AutoBuyError(isAdmin(chatId) ? 'Live auto-buy hasn\'t been opened yet. Send `autobuy unlock` to open it (you\'ll see what the forward test still needs).' : 'Live auto-buy hasn\'t been opened by the admin yet. Send `autobuy` to see the forward-test progress.');
        await send(chatId, [
          `⚠️ *Real money — the bot will BUY for you*`,
          ``,
          `Each day it may buy coins on your Binance account using your USDT: about 1% of the account at risk per trade, no coin above 20%, at most 5 positions, and no buying after a 3% drop in a day.`,
          await forwardWarning(),
          `Losses are possible even with a tested strategy.`,
        ].filter(Boolean).join('\n'), { inline_keyboard: [[{ text: '✅ I understand — turn on', callback_data: 'autobuy live on confirm' }], [{ text: 'Not now', callback_data: 'autobuy' }]] });
        return;
      }
    }
    // Admin controls
    if (isAdmin(chatId) && ['unlock', 'lock', 'pause', 'resume', 'run'].includes(a)) {
      if (a === 'unlock') {
        const g = await autoBuyer.unlock(chatId);
        await reply(chatId, [
          `🔓 *Live auto-buy OPEN.*`,
          g.early ? `⚠️ Opened *early* — the forward test isn't finished. Still missing: ${g.missing.join('; ')}. Everyone sees this before they switch it on.` : `✅ The forward test is complete.`,
          ``,
          `Turn it on for your own account: \`autobuy live on\` (or the button after \`golive\`). Users opt in the same way. \`autobuy lock\` closes it again.`,
        ].join('\n'));
        return;
      }
      if (a === 'lock') { await autoBuyer.lock(); await reply(chatId, `🔒 Live auto-buy locked. No new live buys.`); return; }
      if (a === 'pause') { await autoBuyer.pause(true); await reply(chatId, `🛑 Auto-buy PAUSED for everyone (practice and live). \`autobuy resume\` to restart.`); return; }
      if (a === 'resume') { await autoBuyer.pause(false); await reply(chatId, `▶️ Auto-buy resumed.`); return; }
      if (a === 'run') {
        await reply(chatId, `⏳ Running today's auto-buy check now…`);
        const allowed = new Set((await subs.getChatIdsWithAccess()).map(String));
        const r = await autoBuyer.runDaily({ allowed, force: true, send: (id, text) => tg.send(id, text) });
        await reply(chatId, `✅ Done: ${r.signals ?? 0} signal(s), ${r.practice ?? 0} practice account(s), ${r.live ?? 0} live account(s).${r.skipped ? ` (${r.skipped})` : ''}`);
        return;
      }
    }

    // Status
    const st = await autoBuyer.userStatus(chatId);
    const s = st.strategy, f = st.forward, c = st.checks;
    const tick = (ok) => (ok ? '✅' : '⬜');
    const lines = [
      `🤖 *Auto-buy* — the bot picks and buys coins by itself`,
      ``,
      `*Strategy:* ${esc(s.label)}`,
      `*Tested on past data:* ${VERDICT_ICON[s.verdict] || s.verdict}${s.test ? ` — ${s.test.trades} trades on unseen data, ${s.test.expectancyR >= 0 ? '+' : ''}${s.test.expectancyR}R per trade after fees` : ''}`,
      ``,
      `*Forward test* (the bot's own practice account, from today on):`,
      f.startedAt ? `${f.days} days · ${f.closedTrades} closed trades${f.winRatePct !== null ? ` · ${f.winRatePct}% wins` : ''} · ${f.equity >= f.start ? '+' : ''}${usd(f.equity - f.start)} on $10,000` : `starts at the next daily run`,
      ``,
      `*Live auto-buy:* ${st.unlocked ? (st.unlockedEarly && !st.eligible ? '🔓 open early (forward test not finished)' : '🔓 open') : '🔒 not open yet'}${st.paused ? ' · 🛑 paused by admin' : ''}`,
      !st.eligible ? `${tick(c.research)} strategy PASSES the test  ${tick(c.days)} ${st.needs.days}+ days  ${tick(c.trades)} ${st.needs.trades}+ trades  ${tick(c.profit)} in profit` : '',
      ``,
      `*You:* practice auto-buy ${st.practiceOn ? '🟢 ON' : '⚪ OFF'} · live auto-buy ${st.liveOn ? '🟢 ON' : '⚪ OFF'}`,
      st.lastRun ? `*Last check (${st.lastRun.date}):* ${st.lastRun.buys.length ? st.lastRun.buys.map(x => `${x.coin}${x.why ? ` — ${esc(x.why)}` : ''}`).join('; ') : 'no buy signals'}` : `_No daily check has run yet — the first one is just after 1am Lagos time._`,
      st.lastRun?.regimeText ? `${st.lastRun.regimeUp ? '🟢' : '🔴'} ${st.lastRun.regimeText}${st.lastRun.regimeUp === false ? ' — the strategy waits until BTC is back above it' : ''}` : (st.lastRun?.regimeUp === false ? '🔴 BTC is below its 100-day average — the strategy waits' : ''),
    ];
    const kb = [[st.practiceOn ? { text: '⏸ Practice auto-buy off', callback_data: 'autobuy off' } : { text: '🟢 Practice auto-buy on', callback_data: 'autobuy on' }]];
    if (st.unlocked) kb.push([st.liveOn ? { text: '⏸ Live auto-buy off', callback_data: 'autobuy live off' } : { text: '💰 Live auto-buy on', callback_data: 'autobuy live on' }]);
    kb.push([{ text: '🛡 Today\'s stop for each coin', callback_data: 'stops' }]);
    kb.push([{ text: '🎮 My practice account', callback_data: 'practice' }]);
    if (isAdmin(chatId)) lines.push('', `_Admin: \`autobuy run\` · \`autobuy pause\`/\`resume\` · \`autobuy unlock\`/\`lock\`_`);
    await send(chatId, lines.filter(x => x !== '').join('\n'), { inline_keyboard: kb });
  } catch (err) {
    await reply(chatId, `❌ ${err instanceof autoBuyer.AutoBuyError ? err.message : `Auto-buy error: ${esc(err.message)}`}`);
  }
}

// ─── Buy now ──────────────────────────────────────────────────────────────────
async function handleBuyNow(chatId, args, mode) {
  const coin = (args[0] || '').toUpperCase().replace(/USDT$/, '');
  const amount = parseFloat(String(args[1] || '').replace(/[$,]/g, ''));
  const confirm = (args[2] || '').toLowerCase() === 'confirm';
  const prefix = mode === 'practice' ? 'practice buynow' : 'buynow';
  const where = mode === 'practice' ? '🎮 play money' : '💰 real money, on your Binance account';

  if (!coin || !(amount > 0)) {
    await reply(chatId, [
      `⚡ *Buy Now* — you pick the coin, the bot buys it and manages the sale`,
      ``,
      `\`buynow SOL 50\` — buy $50 of SOL on your Binance account`,
      `\`practice buynow SOL 50\` — the same with play money`,
      ``,
      `Before buying, I tell you whether the strategy agrees with buying that coin today.`,
      `Then I put a stop order on Binance and move it up as the price rises (never down). When it's hit, I sell and tell you the result.`,
      `Max ${require('../src/config/autobuy').LIMITS.maxPositionPct}% of your account in one coin. Real money needs auto-trading on (\`golive\`).`,
    ].join('\n'));
    return;
  }

  try {
    if (!confirm) {
      await reply(chatId, `🔎 Checking ${coin} against the strategy…`);
      const a = await autoBuyer.analyseCoin(coin);
      if (!a.stop) { await reply(chatId, `❌ Can't buy ${coin} this way: ${a.reason}.`); return; }
      await send(chatId, [
        `⚡ *Buy $${amount} of ${coin} now?* (${where})`,
        ``,
        a.signal
          ? `✅ *The strategy agrees:* ${coin} has a buy signal today.`
          : `⚠️ *The strategy wouldn't buy ${coin} today* — ${a.reason}.\nYou can still buy: the stop protects you. But this trade isn't backed by the test results.`,
        ``,
        `🛡 *Stop:* $${fmtP(a.stop)} (−${a.stopPct}% from now). It moves up as the price rises, never down. When it's hit, I sell.`,
        mode === 'live' ? `Losses are possible.` : '',
      ].filter(Boolean).join('\n'), { inline_keyboard: [
        [{ text: `✅ Yes, buy $${amount} of ${coin}`, callback_data: `${prefix} ${coin} ${amount} confirm` }],
        [{ text: 'Cancel', callback_data: mode === 'practice' ? 'practice' : 'positions' }],
      ] });
      return;
    }
    const r = await autoBuyer.buyNow(chatId, { symbol: coin, amount, mode });
    await reply(chatId, [
      `✅ *Bought ${+Number(r.qty).toFixed(8)} ${coin}* at ~$${fmtP(r.price)} (${usd(r.spend)}) — ${where}`,
      `🛡 ${mode === 'live' ? 'Stop order placed on Binance' : 'Stop set'} at $${fmtP(r.analysis.stop)} (−${r.analysis.stopPct}%).`,
      ``,
      `I'll message you when the stop moves up, when I sell, and with your result at the end of each day.`,
      mode === 'live' ? `See it any time: \`positions\` · \`balance\`` : `See it any time: \`practice\``,
    ].join('\n'));
  } catch (err) {
    const known = err instanceof autoBuyer.AutoBuyError || err instanceof practice.PracticeError || err instanceof accounts.TradingError;
    await reply(chatId, `❌ ${known ? err.message : `Buy failed: ${esc(err.message)}`}`);
  }
}

// ─── Practice mode ────────────────────────────────────────────────────────────
const usd = (n) => n == null ? '—' : `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pm = (n) => n == null ? '—' : `${n >= 0 ? '+' : ''}${usd(n)}`;
const signed = (n, suffix = '') => n == null ? '—' : `${n >= 0 ? '+' : ''}${n}${suffix}`;
const PRACTICE_BUTTONS = { inline_keyboard: [
  [{ text: '📊 Refresh', callback_data: 'practice' }, { text: '❓ How to buy', callback_data: 'practice help' }],
  [{ text: '🤖 Auto-buy (bot picks the coins)', callback_data: 'autobuy' }],
  [{ text: '🚀 Ready for real money? Go live', callback_data: 'golive' }],
  [{ text: '↺ Start again with $10,000', callback_data: 'practice reset' }],
] };

async function handlePractice(chatId, args) {
  const sub = (args[0] || '').toLowerCase();
  if (sub === 'buynow') { await handleBuyNow(chatId, args.slice(1), 'practice'); return; }
  try {
    if (sub === 'buy') {
      // practice buy SOL 100 [sl 88] [2x|25%]
      const rest = args.slice(1);
      const coin = rest[0];
      const amount = parseFloat(String(rest[1] || '').replace(/[$,]/g, ''));
      let stop = null, target = null;
      for (let i = 2; i < rest.length; i++) {
        const t = rest[i].toLowerCase();
        if ((t === 'sl' || t === 'stop') && rest[i + 1]) { stop = parseFloat(rest[++i]); continue; }
        if (/^\d+(\.\d+)?(x|%)$/.test(t)) target = t;
      }
      const { position: p, cash } = await practice.buy(chatId, { symbol: coin, amount, stop, target });
      const t = p.takeProfits;
      await reply(chatId, [
        `🎮 *PRACTICE buy (play money) — ${p.symbol.replace('USDT', '')}*`,
        ``,
        `Spent ${usd(p.cost)} → ${+p.quantity.toFixed(8)} ${p.symbol.replace('USDT', '')} at $${fmtP(p.buyPrice)}`,
        `_(live Binance price $${fmtP(p.livePriceAtBuy)} + slippage, fee ${usd(p.fees)})_`,
        ``,
        p.stopLossPrice ? `🛡 Stop: $${fmtP(p.stopLossPrice)}` : `⚠️ No stop — couldn't build a plan for this coin`,
        t?.tp1 ? `🟢 TP1 $${fmtP(t.tp1.price)} (sell 40%) · TP2 $${fmtP(t.tp2.price)} (35%) · TP3 $${fmtP(t.tp3.price)} (rest)` : '',
        p.targetPrice ? `🎯 Your target: $${fmtP(p.targetPrice)} (sell 60%)` : '',
        ``,
        `The bot handles every exit automatically, exactly like live mode, and messages you here.`,
        `💵 Practice cash left: ${usd(cash)}`,
      ].filter(Boolean).join('\n'));
      return;
    }

    if (sub === 'sell' && args[1]) {
      const { trades, cash } = await practice.sellNow(chatId, { symbol: args[1] });
      const lines = trades.filter(Boolean).map(t => `${t.symbol.replace('USDT', '')}: ${pm(t.pnlDollar)} (${signed(t.pnlPct, '%')}) after ${usd(t.fees)} fees`);
      await reply(chatId, [`🎮 *Practice — sold*`, ...lines, ``, `💵 Practice cash: ${usd(cash)}`].join('\n'));
      return;
    }

    if (sub === 'reset') {
      if ((args[1] || '').toLowerCase() !== 'confirm') {
        await send(chatId, `↺ Start again with $10,000? Your practice positions and practice history are cleared. (Real positions aren't touched.)`,
          { inline_keyboard: [[{ text: 'Yes, start again', callback_data: 'practice reset confirm' }]] });
        return;
      }
      await practice.reset(chatId);
      await reply(chatId, `🎮 Practice account reset — you have $10,000 of play money again.`);
      return;
    }

    if (sub === 'help') {
      await send(chatId, [
        `🎮 *How practice mode works*`,
        ``,
        `You get *$10,000 of play money*. Buy any Binance coin with it:`,
        `\`practice buy SOL 100\` — spend $100 on SOL`,
        `\`practice buy PEPE 50 2x\` — with your own 2x target`,
        `\`practice buy SOL 100 sl 140\` — with your own stop`,
        `\`practice sell SOL\` — sell it now at the live price`,
        ``,
        `*It's priced like the real thing:* live Binance prices, Binance's 0.1% fee on every buy and sell, a little slippage, and stops that trigger on any dip (and fill lower if the price jumps past them).`,
        `The bot sells for you at the stop and take-profits, exactly as automated exits do with real money. So your practice result is close to what real money would have done.`,
        ``,
        `_Coins you pick yourself aren't backed by any test. The auto-buy strategy passed an 8-year test after fees, but it's steady rather than fast and still has to prove itself live — practise first before using real money._`,
      ].join('\n'), PRACTICE_BUTTONS);
      return;
    }

    // Status
    const s = await practice.summary(chatId);
    const lines = [
      `🎮 *PRACTICE — play money, not real* (live Binance prices)`,
      ``,
      `💰 *Total value:* ${usd(s.equity)}  (${pm(s.returnUsd)} · ${signed(s.returnPct, '%')} since start)`,
      `💵 Cash: ${usd(s.cash)}`,
    ];
    if (s.positions.length) {
      lines.push(``, `*Open:*`);
      for (const p of s.positions) {
        lines.push(`• ${p.coin}: ${usd(p.value)} · ${signed(p.pnlPct, '%')}${p.stopLossPrice ? ` · stop $${fmtP(p.stopLossPrice)}` : ''}${p.tp1Hit ? ' · TP1 ✅' : ''}${p.tp2Hit ? ' TP2 ✅' : ''}`);
      }
    }
    if (s.stats) {
      lines.push(``, `*Closed trades:* ${s.stats.trades} · win rate ${s.stats.winRate}% · P&L ${usd(s.stats.pnlUsd)} (fees paid ${usd(s.stats.fees)})`);
    }
    if (!s.positions.length && !s.stats) lines.push(``, `No trades yet. Try: \`practice buy SOL 100\``);
    await send(chatId, lines.join('\n'), PRACTICE_BUTTONS);
  } catch (err) {
    await reply(chatId, `❌ ${err instanceof practice.PracticeError ? err.message : `Practice error: ${esc(err.message)}`}`);
  }
}

const fmtP = (p) => (p == null ? '—' : p >= 1 ? Number(p).toFixed(4) : Number(p).toPrecision(4));

// ─── 🐷 Weekly savings plan ───────────────────────────────────────────────────
function savingsHelp() {
  return [
    `🐷 *Weekly savings plan*`,
    ``,
    `Add a little money every week and let the bot buy BTC/ETH for you. For a small account, adding money regularly matters far more than any trading strategy.`,
    ``,
    `\`save 10\` — buy $10 every week ($5 BTC + $5 ETH)`,
    `\`save 5 btc\` · \`save 20 btc eth\` — choose the coins (${savings.COINS.join(', ')})`,
    `\`save day monday\` — the day (buys at 9am Lagos time)`,
    `\`save real\` / \`save practice\` — your Binance account, or play money`,
    `\`save now\` — buy this week's now · \`save pause\` / \`save resume\` · \`save stop\``,
    ``,
    `*How it works (real money):* each week, top up USDT on Binance (P2P) and move it *Funding → Spot*. On your day the bot buys with it. The day before, it reminds you if the USDT isn't there yet.`,
    `*The bot never sells your savings* — no stops, no take-profits. Prices go down as well as up; this is for months and years.`,
    `Minimum $${require('../src/config/autobuy').LIMITS.minOrderUsd} per coin (Binance's minimum order).`,
  ].join('\n');
}

async function savingsScreen(chatId) {
  const p = await savings.getPlan(chatId);
  if (!p) {
    await send(chatId, savingsHelp(), { inline_keyboard: [
      [{ text: '🐷 Save $5 a week', callback_data: 'save 5' }, { text: '🐷 $10 a week', callback_data: 'save 10' }, { text: '🐷 $20 a week', callback_data: 'save 20' }],
      [{ text: '📏 What to expect', callback_data: 'expect' }],
    ] });
    return;
  }
  const s = await savings.summary(chatId);
  const other = p.mode === 'live' ? 'practice' : 'live';
  const otherHas = (await savings.summary(chatId, { mode: other })).buys;
  const lines = [
    `🐷 *Weekly savings* — ${savings.tag(p.mode)}${p.mode === 'live' ? ' (your Binance account)' : ' (play money)'}`,
    ``,
    `*Every ${savings.DAYS[p.day]}, 9am:* ${savings.usd(p.amount)} → ${p.parts.map(x => `${savings.usd(x.usd)} ${x.coin}`).join(' + ')}`,
    p.active ? `*Next buy:* ${savings.when(p.nextDue)}` : `⏸ *Paused* — \`save resume\` to restart`,
    p.waitDue ? `⏳ _Waiting for USDT in your Spot wallet for this week's buy._` : '',
    ``,
    s.buys
      ? `*So far:* ${s.buys} buy${s.buys === 1 ? '' : 's'} · put in ${savings.usd(s.invested)}${s.value !== null ? ` · worth *${savings.usd(s.value)}* (${s.pnl >= 0 ? '+' : '−'}${savings.usd(Math.abs(s.pnl))}, ${s.pnlPct >= 0 ? '+' : ''}${s.pnlPct}%)` : ''}`
      : `_No buys yet._`,
    ...s.holdings.map(h => `• ${h.coin}: ${String(+h.qty.toPrecision(6))}${h.usd !== null ? ` ≈ ${savings.usd(h.usd)}` : ''}`),
    otherHas ? `${savings.tag(other)} savings so far: ${otherHas} buys — \`save ${other === 'live' ? 'real' : 'practice'}\` to switch.` : '',
    ``,
    p.mode === 'live' ? `_Keep ${savings.usd(p.amount)} USDT in your Spot wallet before each buy. The bot never sells your savings._` : `_Play money: each week's buy is new pretend money, separate from your $10,000 practice account._`,
  ];
  await send(chatId, lines.filter(x => x !== '').join('\n'), { inline_keyboard: [
    [{ text: '⚡ Buy this week\'s now', callback_data: 'save now' }],
    [{ text: '✏️ Change amount', callback_data: 'save amount' }, { text: '📅 Change day', callback_data: 'save day' }],
    [p.active ? { text: '⏸ Pause', callback_data: 'save pause' } : { text: '▶️ Resume', callback_data: 'save resume' },
      p.mode === 'live' ? { text: '🎮 Switch to practice', callback_data: 'save practice' } : { text: '💰 Switch to real', callback_data: 'save real' }],
    [{ text: '🛑 Stop the plan', callback_data: 'save stop' }, { text: '❓ How it works', callback_data: 'save help' }],
  ] });
}

async function handleSavings(chatId, args) {
  const a = (args[0] || '').toLowerCase().replace(/^\$/, '');
  try {
    if (!a) return await savingsScreen(chatId);
    if (a === 'help' || a === 'how') { await send(chatId, savingsHelp(), { inline_keyboard: [[{ text: '🐷 My savings plan', callback_data: 'save' }]] }); return; }
    if (a === 'amount') { await reply(chatId, `✏️ Send the weekly amount, e.g. \`save 10\` (or \`save 10 btc\` for BTC only).`); return; }

    if (a === 'day') {
      const d = args[1] ? savings.parseDay(args[1]) : -1;
      if (d < 0) {
        await send(chatId, `📅 *Which day should the bot buy?* (9am Lagos time)`, { inline_keyboard: [
          savings.DAYS.slice(1, 4).map((n, i) => ({ text: n, callback_data: `save day ${n.toLowerCase()}` })),
          [...savings.DAYS.slice(4), savings.DAYS[0]].map(n => ({ text: n, callback_data: `save day ${n.toLowerCase()}` })),
        ] });
        return;
      }
      const p = await savings.setPlan(chatId, { day: d });
      await reply(chatId, `📅 Savings day: *${savings.DAYS[p.day]}*, 9am. Next buy: ${savings.when(p.nextDue)}.`);
      return;
    }

    if (a === 'real' || a === 'live') {
      const st = await accounts.getStatus(chatId);
      if (!st.connected || st.testnet) { await send(chatId, `💰 To save with real money, connect your Binance account first.`, { inline_keyboard: [[{ text: '🚀 Connect Binance', callback_data: 'golive' }]] }); return; }
      if (!(await savings.getPlan(chatId))) { await reply(chatId, `Start a plan first, e.g. \`save 10\`.`); return; }
      const p = await savings.setPlan(chatId, { mode: 'live' });
      await reply(chatId, [
        `💰 *Savings plan: REAL money*`,
        `Every ${savings.DAYS[p.day]} at 9am the bot buys ${p.parts.map(x => `${savings.usd(x.usd)} of ${x.coin}`).join(' + ')} on your Binance account. Next: ${savings.when(p.nextDue)}.`,
        st.enabled ? '' : `⚠️ Auto-trading is off — turn it on (\`golive\`) or the buys will wait.`,
        `Keep ${savings.usd(p.amount)} USDT in your *Spot* wallet before each buy. The bot never sells your savings.`,
      ].filter(Boolean).join('\n'));
      return;
    }
    if (a === 'practice' || a === 'play') {
      if (!(await savings.getPlan(chatId))) { await reply(chatId, `Start a plan first, e.g. \`save 10\`.`); return; }
      await savings.setPlan(chatId, { mode: 'practice' });
      await reply(chatId, `🎮 *Savings plan: play money.* Same weekly buys at real prices, no real money. \`save real\` switches back.`);
      return;
    }
    if (a === 'pause' || a === 'off') { await savings.setActive(chatId, false); await reply(chatId, `⏸ Savings plan paused. What you've saved stays where it is. \`save resume\` restarts it.`); return; }
    if (a === 'resume' || a === 'on') { const p = await savings.setActive(chatId, true); await reply(chatId, `▶️ Savings plan on. Next buy: ${savings.when(p.nextDue)}, 9am.`); return; }
    if (a === 'stop' || a === 'delete' || a === 'cancel') {
      if ((args[1] || '').toLowerCase() !== 'confirm') {
        await send(chatId, `🛑 *Stop your savings plan?* No more weekly buys. Nothing is sold — your coins stay in your account.`, { inline_keyboard: [[{ text: '🛑 Yes, stop it', callback_data: 'save stop confirm' }], [{ text: 'Keep it', callback_data: 'save' }]] });
        return;
      }
      await savings.stop(chatId);
      await reply(chatId, `🛑 Savings plan stopped. Nothing was sold. Start again any time with \`save 10\`.`);
      return;
    }
    if (a === 'now') {
      const p = await savings.getPlan(chatId);
      if (!p) { await reply(chatId, `Start a plan first, e.g. \`save 10\`.`); return; }
      if (p.mode === 'live' && (args[1] || '').toLowerCase() !== 'confirm') {
        await send(chatId, `⚡ *Buy now with real money?* ${p.parts.map(x => `${savings.usd(x.usd)} of ${x.coin}`).join(' + ')} on your Binance account.${new Date(p.nextDue) > new Date() ? ` This is an extra buy — the next scheduled one is still ${savings.when(p.nextDue)}.` : ''}`,
          { inline_keyboard: [[{ text: `✅ Yes, buy ${savings.usd(p.amount)}`, callback_data: 'save now confirm' }], [{ text: 'Not now', callback_data: 'save' }]] });
        return;
      }
      await reply(chatId, `⏳ Buying…`);
      const r = await savings.runOne(chatId, { scheduled: false });
      await reply(chatId, r.message || (r.status === 'busy' ? `⏳ A buy is already in progress — try again in a minute.` : `Nothing to buy right now.`));
      return;
    }

    // save AMOUNT [coins…]
    const amt = Number(a.replace(/[$,]/g, ''));
    if (amt > 0) {
      const coins = args.slice(1).map(x => x.toUpperCase()).filter(x => !['WEEKLY', 'WEEK', 'A', 'EVERY', 'PER'].includes(x));
      const before = await savings.getPlan(chatId);
      let mode;
      if (!before) {
        const st = await accounts.getStatus(chatId);
        mode = st.connected && !st.testnet && st.enabled ? 'live' : 'practice';
      }
      const p = await savings.setPlan(chatId, { amount: amt, ...(coins.length ? { coins } : {}), ...(mode ? { mode } : {}) });
      await send(chatId, [
        `🐷 *Weekly savings ${before ? 'updated' : 'started'}* — ${savings.tag(p.mode)}${p.mode === 'live' ? ' (your Binance account)' : ' (play money)'}`,
        ``,
        `Every *${savings.DAYS[p.day]}* at 9am: ${p.parts.map(x => `${savings.usd(x.usd)} of ${x.coin}`).join(' + ')}.`,
        `Next buy: ${savings.when(p.nextDue)}.`,
        p.mode === 'live' ? `Keep ${savings.usd(p.amount)} USDT in your *Spot* wallet before each buy — I'll remind you the day before if it isn't there.`
          : `This is play money. When you're ready: connect Binance (\`golive\`), turn on auto-trading, then \`save real\`.`,
        `In a year that's ${savings.usd(p.amount * 52)} put in. The bot never sells your savings.`,
      ].join('\n'), { inline_keyboard: [
        [{ text: '⚡ Make the first buy now', callback_data: 'save now' }],
        [{ text: '📅 Change day', callback_data: 'save day' }, { text: '🐷 My savings plan', callback_data: 'save' }],
      ] });
      return;
    }
    await send(chatId, savingsHelp());
  } catch (err) {
    await reply(chatId, `❌ ${err instanceof savings.SavingsError || err instanceof accounts.TradingError ? err.message : esc(err.message)}`);
  }
}

// ─── Go live: step-by-step Binance set-up with buttons ───────────────────────
const wizardKey = (chatId) => `cryptobot:wizard:${chatId}`;
const next = (label, data) => ({ inline_keyboard: [[{ text: label, callback_data: data }], [{ text: '✕ Stop for now', callback_data: 'golive cancel' }]] });

async function handleGoLive(chatId, args) {
  const step = (args[0] || '').toLowerCase();

  if (step === 'cancel') {
    await store.cmd('DEL', wizardKey(chatId));
    await reply(chatId, `👍 Stopped. Send \`golive\` any time to continue. Meanwhile you can keep practising: \`practice\`.`);
    return;
  }

  if (!box.isConfigured()) {
    await reply(chatId, `⚠️ Live trading isn't switched on for this bot yet. Practise in the meantime: \`practice\`.`);
    return;
  }

  if (step === '' || step === 'start') {
    const st = await accounts.getStatus(chatId);
    if (st.connected && !st.testnet) {
      const buyingOn = (await autoBuyer.userStatus(chatId)).liveOn;
      const on = st.enabled && buyingOn;
      await send(chatId, `✅ Your real Binance account is connected (key ${st.keyHint}).\nAuto-trading: ${on ? '🟢 ON — the bot buys and sells' : st.enabled ? '🟡 selling only (stops and take-profits)' : '⚪ OFF'}.`,
        { inline_keyboard: [[on ? { text: '⏸ Turn off auto-trading', callback_data: 'golive off' } : { text: '🤖 Turn on auto-trading', callback_data: 'golive on' }], [{ text: '💰 My balance', callback_data: 'balance' }]] });
      return;
    }
    let practiceLine = `💡 *Tip:* practise first with play money — \`practice\`.`;
    try {
      const s = await practice.summary(chatId);
      if (s.stats) practiceLine = `🎮 Your practice so far: ${s.stats.trades} closed trades, ${signed(s.returnPct, '%')} overall.`;
    } catch { /* ignore */ }
    await send(chatId, [
      `🚀 *Go live — 4 short steps*`,
      ``,
      `1. A Binance account`,
      `2. Money in it (USDT, bought with Naira)`,
      `3. A "key" that lets the bot buy and sell for you — it can *never* withdraw your money`,
      `4. Paste the key here`,
      ``,
      `Your money stays in *your own* Binance account the whole time. The bot places stop orders and sells for your positions, buys when you tap ⚡ Buy Now, and — once you turn it on — buys by itself with auto-buy.`,
      ``,
      practiceLine,
      ``,
      expectations.table(),
      `_Holding BTC made more in the same test period, with much bigger drops. Real money can be lost; past results don't guarantee future ones._`,
      subs.enabled() && subs.freeLimit() > 0 && !isAdmin(chatId) ? `\n🆓 Free for accounts up to ${usd(subs.freeLimit())}.` : '',
    ].filter(x => x !== '').join('\n'), { inline_keyboard: [
      [{ text: 'Start step 1 →', callback_data: 'golive 1' }],
      [{ text: '📏 What to expect for my amount', callback_data: 'expect' }, { text: '🐷 Save weekly instead', callback_data: 'save' }],
      [{ text: '✕ Stop for now', callback_data: 'golive cancel' }],
    ] });
    return;
  }

  if (step === '1') {
    await send(chatId, [
      `*Step 1 of 4 — Binance account*`,
      ``,
      `1. Install the *Binance* app (Play Store / App Store) or go to binance.com`,
      `2. Sign up with your email or phone number`,
      `3. Complete *identity verification* (photo of your NIN slip, ID card or passport + a selfie). It usually takes a few minutes.`,
      ``,
      `Already have a verified account? Tap Done.`,
    ].join('\n'), { inline_keyboard: [
      [{ text: 'Open Binance', url: 'https://www.binance.com/en/register' }],
      [{ text: '✅ Done — next step', callback_data: 'golive 2' }],
      [{ text: '✕ Stop for now', callback_data: 'golive cancel' }],
    ] });
    return;
  }

  if (step === '2') {
    await send(chatId, [
      `*Step 2 of 4 — Add money (Naira → USDT)*`,
      ``,
      `In the Binance app: *Trade → P2P → Buy → USDT*, payment *Bank transfer*, currency *NGN*.`,
      `1. Pick a seller with a ✔ badge and a high completion rate`,
      `2. Enter the amount, then pay the seller from your bank app *exactly* as shown`,
      `3. Tap *Transferred, notify seller* — only after you've actually paid`,
      `4. The seller releases the USDT to you`,
      ``,
      `⚠️ *Important:* P2P coins arrive in your *Funding* wallet. Move them to *Spot*: Assets → Funding → Transfer → Funding to Spot. The bot can only see your Spot wallet.`,
      `Never send money outside the Binance P2P screen, and never share your password or codes with anyone.`,
    ].join('\n'), { inline_keyboard: [
      [{ text: 'Open Binance P2P (NGN)', url: 'https://p2p.binance.com/en/trade/all-payments/USDT?fiat=NGN' }],
      [{ text: '✅ Done — next step', callback_data: 'golive 3' }],
      [{ text: '✕ Stop for now', callback_data: 'golive cancel' }],
    ] });
    return;
  }

  if (step === '3') {
    await send(chatId, [
      `*Step 3 of 4 — Create the key for the bot*`,
      ``,
      `Easiest on binance.com (phone browser or computer):`,
      `1. Tap your *profile icon → Account → API Management*`,
      `2. *Create API* → choose *System generated* → name it \`JijazyBot\` → confirm with your codes`,
      `3. Tap *Edit restrictions*:`,
      `   • IP access: choose *Restrict access to trusted IPs only*`,
      ...(tradingIps().length
        ? [
          ...tradingIps().map((ip, k) => `   • Paste IP ${k + 1}: \`${ip}\` → tap *Confirm*`),
          `     _(tap an IP above to copy it. Add them ONE AT A TIME — no commas. You need ${tradingIps().length === 1 ? 'it' : `all ${tradingIps().length}`}: with one missing, about half the bot's orders would be rejected.)_`,
        ]
        : [`     _(the bot's IP addresses aren't set up yet — ask the admin)_`]),
      `   • Check ${tradingIps().length > 1 ? 'both IPs show' : 'the IP shows'} in the list, then ✅ tick *Enable Spot & Margin Trading*`,
      `   • leave ❌ *Enable Withdrawals* OFF (the bot refuses keys that can withdraw)`,
      `4. *Save*. You'll see two codes: *API Key* and *Secret Key*. Copy both — the Secret Key is shown only once.`,
      ``,
      `_Binance only allows trading on keys locked to fixed IPs. These are the bot's own addresses, so only the bot can use your key._`,
    ].join('\n'), { inline_keyboard: [
      [{ text: 'Open API Management', url: 'https://www.binance.com/en/my/settings/api-management' }],
      [{ text: '✅ I have both codes', callback_data: 'golive 4' }],
      [{ text: '✕ Stop for now', callback_data: 'golive cancel' }],
    ] });
    return;
  }

  if (step === '4') {
    await store.cmd('SET', wizardKey(chatId), JSON.stringify({ step: 'key' }), 'EX', 900);
    await reply(chatId, [
      `*Step 4 of 4 — Paste the codes*`,
      ``,
      `Paste your *API Key* (the first code) and send it as a message.`,
      `_I'll delete it from this chat straight away and store it encrypted._`,
    ].join('\n'));
    return;
  }

  if (step === 'off') {
    await autoBuyer.setLive(chatId, false).catch(() => {});
    await accounts.setEnabled(chatId, false).catch(() => {});
    const n = await autoTrader.cancelAll(chatId);
    await reply(chatId, `⏸ *Auto-trading OFF.* No buying or selling by the bot${n ? `; ${n} stop order${n === 1 ? '' : 's'} cancelled on Binance` : ''}. Your coins stay in your account. Alerts carry on as normal.`);
    return;
  }

  if (step === 'on') {
    const st = await accounts.getStatus(chatId);
    if (!st.connected) { await handleGoLive(chatId, ['4']); return; }
    if (!isAdmin(chatId) && !(await hasAccessNow(chatId))) { await send(chatId, await lockedText(chatId)); return; }
    const open = await autoBuyer.isLiveUnlocked();
    if ((args[1] || '').toLowerCase() !== 'confirm') {
      await send(chatId, [
        `⚠️ *Last check — real money*`,
        ``,
        `With auto-trading on, the bot works on *your Binance account*:`,
        open ? `🛒 *Buys:* once a day it may buy coins with your USDT — about 1% of the account at risk per trade, no coin above 20%, at most 5 at once.`
          : `🛒 *Buys:* not open yet — the admin opens buying once the strategy has proven itself. Until then the bot only sells.`,
        `🛡 *Sells:* a stop order on Binance for every position, and sales at take-profits / the trailing stop.`,
        open ? await forwardWarning() : '',
        `It can't withdraw. Turn it off any time with \`golive off\`.`,
        ``,
        `Losses are possible. Turn it on?`,
      ].filter(Boolean).join('\n'), { inline_keyboard: [
        [{ text: '✅ Yes, I understand — turn on', callback_data: 'golive on confirm' }],
        [{ text: 'Not now', callback_data: 'golive cancel' }],
      ] });
      return;
    }
    try {
      await accounts.setEnabled(chatId, true, { confirmLive: accounts.LIVE_CONFIRM });
      let buying = false;
      if (open) { await autoBuyer.setLive(chatId, true); buying = true; }
      await reply(chatId, [
        `🟢 *Auto-trading is ON*`,
        ``,
        buying ? `🛒 The bot checks the market once a day (just after 1am Lagos time) and buys the coins that signal, then manages the exits. You'll get a message for every buy, every sale, and your profit for the day.`
          : isAdmin(chatId) ? `🛡 Selling is on. Buying isn't open yet — send \`autobuy unlock\` to open it (you'll see what the forward test still needs), then \`autobuy live on\`.`
          : `🛡 Selling is on. Buying opens once the admin switches it on — you'll be able to turn it on from \`autobuy\`.`,
        `💰 Check your money any time: \`balance\``,
      ].join('\n'));
      await autoTrader.syncUser(chatId);
    } catch (err) {
      await reply(chatId, `❌ ${err instanceof accounts.TradingError || err instanceof autoBuyer.AutoBuyError ? err.message : esc(err.message)}`);
    }
    return;
  }

  await handleGoLive(chatId, []);
}

/** A message that looks like a key arrived. Returns true if the wizard used it. */
async function handleWizardKey(chatId, value, meta) {
  const raw = await store.cmd('GET', wizardKey(chatId));
  if (!raw) return false;
  let st; try { st = JSON.parse(raw); } catch { return false; }
  if (meta.messageId) await tg.call('deleteMessage', { chat_id: chatId, message_id: meta.messageId }).catch(() => {});

  if (st.step === 'key') {
    await store.cmd('SET', wizardKey(chatId), JSON.stringify({ step: 'secret', key: box.encrypt(value) }), 'EX', 900);
    await reply(chatId, `✅ Got the API Key (deleted from the chat).\n\nNow paste the *Secret Key* (the second code).`);
    return true;
  }
  if (st.step === 'secret') {
    const apiKey = box.decrypt(st.key);
    if (apiKey === value) { await reply(chatId, `That's the API Key again — please paste the *Secret Key* (the second code).`); return true; }
    await reply(chatId, `⏳ Checking with Binance…`);
    try {
      await accounts.connect(chatId, { apiKey, apiSecret: value, live: true });
      await store.cmd('DEL', wizardKey(chatId));
      let balance = '', total = null, small = null;
      try {
        const b = await accounts.getBalances(chatId);
        total = b.totalUsd;
        balance = `\n💵 Your Spot wallet: ${usd(b.totalUsd)} (USDT free: ${usd(b.usdtFree)})${b.usdtFree < 10 ? '\n⚠️ That\'s very little — remember to move USDT from Funding to Spot (step 2).' : ''}`;
        if (subs.enabled() && subs.freeLimit() > 0 && !isAdmin(chatId)) small = await subs.recordBalance(chatId, b.totalUsd).catch(() => null);
      } catch { /* balance is just a nice-to-have */ }
      const freeLine = small && !(await subs.getSub(chatId)).active
        ? (small.free ? `\n🆓 Your balance is under ${usd(small.limit)}, so the bot is *free* for you.` : `\n💳 Your balance is above the ${usd(small.limit)} free limit — you'll need a subscription to turn on auto-trading: \`subscribe\`.`)
        : '';
      await send(chatId, `🔐 *Binance connected!* Key ${'…' + apiKey.slice(-4)}, withdrawals blocked.${balance}${freeLine}\n\nLast step: turn on auto-trading — the bot buys and sells for you.`,
        { inline_keyboard: [[{ text: '🤖 Turn on auto-trading', callback_data: 'golive on' }], [{ text: '🐷 Set up weekly savings', callback_data: 'save' }]] });
      if (total !== null && total > 0) await send(chatId, expectations.message(total)).catch(() => {});
    } catch (err) {
      await store.cmd('SET', wizardKey(chatId), JSON.stringify({ step: 'key' }), 'EX', 900);
      const why = err instanceof accounts.TradingError ? err.message : err.message;
      await reply(chatId, `❌ ${esc(why)}\n\nLet's try again: paste your *API Key* (the first code). Or send \`golive 3\` to see how to create the key.`);
    }
    return true;
  }
  return false;
}

// ─── 💳 Subscriptions (admin panel) ──────────────────────────────────────────
const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Lagos' });

async function giftDone(adminId, target, until) {
  const u = await getUser(target);
  await send(adminId, `🎁 ${nameOf(u || { chatId: target })} has access until *${fmtDay(until)}*.`, { inline_keyboard: [[b('💳 Back to Subscriptions', 'subs')]] });
  await send(target, `🎁 *You've been given access to the bot until ${fmtDay(until)}.*\n\nTap *📋 MENU* to get started.`).catch(() => {});
}

async function handleSubsAdmin(chatId, args) {
  const a = (args[0] || '').toLowerCase();
  const awaitKey = `cryptobot:admin:await:${chatId}`;
  try {
    if (a === 'toggle') {
      const turningOn = !subs.enabled();
      if (turningOn && (args[1] || '') !== 'confirm') {
        const without = await subs.countWithoutAccess();
        await send(chatId, [
          `💳 *Turn paid access ON?*`,
          ``,
          `Approved users will need an active subscription (${subs.priceLabel()}) to use the bot. You never pay.`,
          without ? `⚠️ *${without} user${without === 1 ? ' has' : 's have'} no subscription* and will lose access straight away.` : `✅ Every approved user already has an active subscription.`,
          !subs.providers().length ? `⚠️ No payment provider is set up (FLW_SECRET_KEY or PAYSTACK_SECRET_KEY), so users can't pay yet — only subscriptions you give will work.` : '',
        ].filter(Boolean).join('\n'), { inline_keyboard: [
          ...(without ? [[b(`🎁 Give those ${without} users 7 days, then turn on`, 'subs giveall 7')]] : []),
          [b('✅ Turn on now', 'subs toggle confirm')],
          [b('Cancel', 'subs')],
        ] });
        return;
      }
      await subs.setPaidAccess(turningOn);
      await reply(chatId, turningOn ? `🟢 *Paid access is ON.* Users without a subscription are asked to \`subscribe\`.` : `⚪ *Paid access is OFF.* Everyone approved can use the bot for free.`);
      return handleSubsAdmin(chatId, []);
    }
    if (a === 'giveall') {
      const days = parseInt(args[1], 10) || 7;
      const n = await subs.giveAllWithout(days, { grantedBy: chatId });
      await subs.setPaidAccess(true);
      await reply(chatId, `🎁 Gave ${n} user${n === 1 ? '' : 's'} ${days} days. 🟢 Paid access is now ON.`);
      return handleSubsAdmin(chatId, []);
    }
    if (a === 'plan') {
      const p = subs.plan();
      await send(chatId, [
        `💵 *Your plan:* ${subs.priceLabel()}`,
        ``,
        `Tap to change, or type:`,
        `\`subs price 5000\` · \`subs days 30\` · \`subs currency NGN\``,
      ].join('\n'), { inline_keyboard: [
        [b('✏️ Set the price', 'subs price')],
        [b(`${p.days === 7 ? '✅ ' : ''}1 week`, 'subs days 7'), b(`${p.days === 30 ? '✅ ' : ''}1 month`, 'subs days 30'), b(`${p.days === 90 ? '✅ ' : ''}3 months`, 'subs days 90')],
        subs.CURRENCIES.map(c => b(`${p.currency === c ? '✅ ' : ''}${c}`, `subs currency ${c}`)),
        [b('💳 Back to Subscriptions', 'subs')],
      ] });
      return;
    }
    if (a === 'price') {
      if (args[1]) { await subs.setPlan({ price: args[1] }); return handleSubsAdmin(chatId, ['plan']); }
      await store.setJSON(awaitKey, { action: 'price' }); await store.cmd('EXPIRE', awaitKey, 600);
      await reply(chatId, `✏️ Send the new price per period as a number, e.g. \`5000\` (currency: ${subs.plan().currency}).`);
      return;
    }
    if (a === 'free') {
      if (args[1]) {
        const limit = await subs.setFreeLimit(args[1]);
        await reply(chatId, limit > 0 ? `🆓 Free access for Binance balances up to *${usd(limit)}*.` : `⚪ Free access for small accounts is *off*.`);
        return handleSubsAdmin(chatId, []);
      }
      const cur = subs.freeLimit();
      await send(chatId, [
        `🆓 *Free for small accounts*`,
        ``,
        `With paid access on, users whose Binance *Spot* balance is at or under this limit use the bot for free. Coins bought by their weekly savings plan don't count.`,
        `Checked when they connect, open \`balance\` or \`account\`, and once a day. Anyone who grows above the limit is told once and asked to subscribe.`,
        ``,
        `*Now:* ${cur > 0 ? `up to ${usd(cur)}` : 'off'}`,
        `Or type \`subs free 150\` / \`subs free off\`.`,
      ].join('\n'), { inline_keyboard: [
        [50, 100, 200].map(v => b(`${cur === v ? '✅ ' : ''}$${v}`, `subs free ${v}`)),
        [b(`${cur === 500 ? '✅ ' : ''}$500`, 'subs free 500'), b(`${cur === 0 ? '✅ ' : ''}Off`, 'subs free off')],
        [b('💳 Back to Subscriptions', 'subs')],
      ] });
      return;
    }
    if (a === 'days' && args[1]) { await subs.setPlan({ days: args[1] }); return handleSubsAdmin(chatId, ['plan']); }
    if (a === 'currency' && args[1]) { await subs.setPlan({ currency: args[1] }); return handleSubsAdmin(chatId, ['plan']); }

    if (a === 'give') {
      const target = args[1];
      if (!target) {
        const list = await getUsersByStatus('approved');
        if (!list.length) { await reply(chatId, `No approved users yet.`); return; }
        const rows = list.slice(0, 40).map(u => [b(formatName(u).slice(0, 40), `subs give ${u.chatId}`)]);
        await send(chatId, `🎁 *Give a subscription* — who to?`, { inline_keyboard: [...rows, [b('Cancel', 'subs')]] });
        return;
      }
      if (!isChatId(target)) { await reply(chatId, `❌ Unknown user.`); return; }
      const how = (args[2] || '').toLowerCase();
      if (how === 'date') {
        await store.setJSON(awaitKey, { action: 'givedate', target }); await store.cmd('EXPIRE', awaitKey, 600);
        await reply(chatId, `📅 Send the date their access should end, e.g. \`31/12/2026\`. It ends at midnight (Lagos time) that day.`);
        return;
      }
      if (/^\d+$/.test(how)) { await giftDone(chatId, target, await subs.extend(target, Number(how), { grantedBy: chatId })); return; }
      const u = await getUser(target);
      const cur = await subs.getSub(target);
      await send(chatId, [
        `🎁 *${nameOf(u || { chatId: target })}*`,
        cur.active ? `Has access until ${fmtDay(cur.paidUntil)} — extra time is added on top.` : `No active subscription.`,
        ``,
        `How long?`,
      ].join('\n'), { inline_keyboard: [
        [b('1 week', `subs give ${target} 7`), b('1 month', `subs give ${target} 30`), b('3 months', `subs give ${target} 90`)],
        [b('6 months', `subs give ${target} 182`), b('1 year', `subs give ${target} 365`)],
        [b('📅 Until a date I choose…', `subs give ${target} date`)],
        [b('Cancel', 'subs')],
      ] });
      return;
    }
    if (a === 'end') {
      const target = args[1];
      if (!target) {
        const rows = [];
        for (const { user, sub } of await subs.listSubscribers()) if (sub.active) rows.push([b(`⛔ ${formatName(user).slice(0, 34)} (${fmtDay(sub.paidUntil)})`, `subs end ${user.chatId}`)]);
        await send(chatId, rows.length ? `⛔ *End whose subscription?* (It ends immediately.)` : `No active subscriptions.`, { inline_keyboard: [...rows, [b('Cancel', 'subs')]] });
        return;
      }
      await subs.revoke(target);
      await reply(chatId, `⛔ Subscription ended for \`${target}\`.`);
      return handleSubsAdmin(chatId, []);
    }
    if (a === 'list') {
      const lines = [`👥 *Subscribers*`, ``];
      for (const { user, sub } of await subs.listSubscribers()) {
        lines.push(`${sub.active ? '🟢' : '⚪'} ${nameOf(user)} — ${sub.active ? `until ${fmtDay(sub.paidUntil)} (${sub.daysLeft}d)` : sub.paidUntil ? `ended ${fmtDay(sub.paidUntil)}` : 'never subscribed'}`);
      }
      if (lines.length === 2) lines.push('No approved users yet.');
      await replyChunked(chatId, lines.join('\n'));
      return;
    }

    // The panel
    await store.del(awaitKey).catch(() => {});
    const list = await subs.listSubscribers();
    const active = list.filter(x => x.sub.active).length;
    const on = subs.enabled();
    await send(chatId, [
      `💳 *Subscriptions*`,
      ``,
      `*Paid access:* ${on ? '🟢 ON — users need a subscription' : '⚪ OFF — the bot is free for approved users'}`,
      `*Plan:* ${subs.priceLabel()}`,
      `*Active subscriptions:* ${active} of ${list.length} approved user${list.length === 1 ? '' : 's'}`,
      `*Payments:* ${subs.providers().length ? subs.providers().map(pv => `✅ ${subs.PROVIDER_NAMES[pv]}`).join(' · ') : '⚠️ not set up — users can\'t pay yet (add FLW_SECRET_KEY or PAYSTACK_SECRET_KEY)'}`,
      `*Free for small accounts:* ${subs.freeLimit() > 0 ? `🆓 Binance balance up to ${usd(subs.freeLimit())}` : '⚪ off'}`,
    ].join('\n'), { inline_keyboard: [
      [b(on ? '⚪ Turn paid access OFF' : '🟢 Turn paid access ON', 'subs toggle')],
      [b('🆓 Free for small accounts', 'subs free')],
      [b('💵 Plan & price', 'subs plan'), b('🎁 Give a subscription', 'subs give')],
      [b('👥 List subscribers', 'subs list'), b('⛔ End a subscription', 'subs end')],
    ] });
  } catch (err) {
    await reply(chatId, `❌ ${err instanceof subs.PaymentError ? err.message : esc(err.message)}`);
  }
}

// ─── Paid access: subscribe / check / status ─────────────────────────────────
async function handleSubscribe(chatId, args) {
  const sub = (args[0] || '').toLowerCase();
  const fmtDate = (iso) => new Date(iso).toUTCString();

  if (sub === 'check') {
    const s = await subs.getSub(chatId);
    if (s.lastRef) {
      try {
        const r = await subs.confirmPayment(s.lastRef);
        if (r.credited) { await subs.notifyCredited(r); return; }
        if (!r.already && !s.active) {
          await reply(chatId, `⏳ The payment provider hasn't confirmed your payment yet (${esc(r.reason || 'pending')}). If you've paid, send \`subscribe check\` again in a minute.`);
          return;
        }
      } catch (err) {
        await reply(chatId, `⚠️ Couldn't check your payment right now: ${esc(err.message)}`);
        return;
      }
    }
    return handleSubscribe(chatId, ['status']);
  }

  if (sub === 'status' || (!sub && !subs.enabled())) {
    if (subs.enabled() && !isAdmin(chatId)) await subs.refreshSmall(chatId).catch(() => null);
    const st = await subs.status(chatId);
    const paid = st.paidUntil && new Date(st.paidUntil) > new Date();
    await reply(chatId, [
      `💳 *Your account*`,
      ``,
      !st.required ? (st.isAdmin ? `👑 Admin — free access.` : `✅ Access is free on this bot right now.`)
        : paid ? `🟢 Active until *${fmtDate(st.paidUntil)}* (${st.daysLeft} day${st.daysLeft === 1 ? '' : 's'} left)`
        : st.freeSmall ? `🆓 *Free — small account.* Your Binance balance is ${usd(st.smallUsd)}, at or under the ${usd(st.freeLimit)} limit. It's re-checked every day.`
        : st.paidUntil ? `🔒 Ended on ${fmtDate(st.paidUntil)}` : `🔒 No subscription yet`,
      st.required ? `` : '',
      st.required ? `Price: ${st.price}` : '',
      st.required ? `Renew any time with \`subscribe\` — time is added to what you have left.` : '',
      st.required && !paid && !st.freeSmall && st.freeLimit > 0 ? `🆓 Free if your Binance Spot balance is ${usd(st.freeLimit)} or less${st.smallUsd !== null ? ` (last check: ${usd(st.smallUsd)})` : ' — connect with `golive`'}.` : '',
    ].filter(x => x !== '').join('\n'));
    return;
  }

  if (!subs.enabled()) { await reply(chatId, `✅ Access is free on this bot right now — nothing to pay.`); return; }
  if (isAdmin(chatId)) { await reply(chatId, `👑 You're the admin — you never pay.`); return; }

  try {
    // subscribe [email]  ·  subscribe via flutterwave|paystack (after choosing)
    const via = (args[0] || '').toLowerCase() === 'via' ? (args[1] || '').toLowerCase() : null;
    const email = via ? null : args[0];
    const available = subs.providers();
    if (!via && available.length > 1) {
      const saved = (await subs.getSub(chatId)).email;
      const e = String(email || saved || '').trim().toLowerCase();
      if (!subs.validEmail(e)) throw new subs.PaymentError('Send your email for the receipt, e.g. `subscribe you@example.com`');
      if (e !== saved) await store.cmd('HSET', `cryptobot:sub:${chatId}`, 'email', e);
      await send(chatId, [
        `💳 *Subscribe — ${subs.priceLabel()}*`,
        ``,
        `How would you like to pay? Both accept Nigerian cards, bank transfer and USSD.`,
      ].join('\n'), { inline_keyboard: available.map(pv => [{ text: `💳 Pay with ${subs.PROVIDER_NAMES[pv]}`, callback_data: `subscribe via ${pv}` }]) });
      return;
    }
    const link = await subs.startCheckout(chatId, { email, provider: via, callbackUrl: `${baseUrl()}/paid` });
    await send(chatId, [
      `💳 *Subscribe — ${link.price}*`,
      ``,
      `Tap the button to pay securely with ${link.providerName} (card, bank transfer or USSD).`,
      `When it's done you'll be brought back here and your access starts straight away.`,
      ``,
      `_Paid but nothing happened? Send_ \`subscribe check\`.`,
    ].join('\n'), { inline_keyboard: [[{ text: `💳 Pay ${link.price}`, url: link.url }]] });
  } catch (err) {
    await reply(chatId, `❌ ${err instanceof subs.PaymentError ? err.message : `Couldn't start the payment: ${esc(err.message)}`}`);
  }
}

// ─── Automated exits: connect / on / off / status ────────────────────────────
async function handleAutotrade(chatId, args, meta = {}) {
  const sub = (args[0] || '').toLowerCase();

  if (sub === 'connect') {
    // The message holds an API secret: delete it from the chat first
    if (meta.messageId) await tg.call('deleteMessage', { chat_id: chatId, message_id: meta.messageId }).catch(() => {});
    const live = (args[1] || '').toLowerCase() === 'live';
    const [apiKey, apiSecret] = live ? args.slice(2) : args.slice(1);
    if (!apiKey || !apiSecret) {
      await reply(chatId, [
        `❌ *Format:* \`autotrade connect API_KEY API_SECRET\` (test mode)`,
        `or \`autotrade connect live API_KEY API_SECRET\` (real money)`,
        ``,
        `_I deleted your message so the keys don't stay in this chat._`,
      ].join('\n'));
      return;
    }
    try {
      const s = await accounts.connect(chatId, { apiKey, apiSecret, live });
      await reply(chatId, [
        `🔐 *Binance ${s.testnet ? 'TESTNET (fake money)' : 'LIVE (real money)'} connected* — key ${s.keyHint}`,
        `_I deleted your message; the keys are stored encrypted._`,
        ``,
        `Auto-exits are still *OFF*. Turn them on with:`,
        s.testnet ? `\`autotrade on\`` : `\`autotrade on ${accounts.LIVE_CONFIRM}\``,
      ].join('\n'));
    } catch (err) {
      await reply(chatId, `❌ ${err instanceof accounts.TradingError ? err.message : `Couldn't connect: ${err.message}`}\n\n_I deleted your message so the keys don't stay in this chat._`);
    }
    return;
  }

  try {
    if (sub === 'on') {
      const s = await accounts.setEnabled(chatId, true, { confirmLive: args.slice(1).join(' ') });
      await reply(chatId, [
        `🤖 *Auto-exits ON* — Binance ${s.testnet ? 'testnet (fake money)' : '*LIVE (real money)*'}${s.dryRun ? ' — DRY RUN, no real orders' : ''}`,
        ``,
        `For each Binance position that has a quantity, the bot now:`,
        `  🛡 keeps a stop order on Binance at your saved stop`,
        `  🟢 sells 40% at TP1, 35% at TP2 and the rest at TP3`,
        `  🎯 sells 60% at your own target`,
        `  🔴 sells the rest if the stop is hit`,
        `Auto-exits only sell — buying happens only with ⚡ Buy Now or auto-buy, which you switch on separately. \`sell SOL\` or Remove cancels the stop order without selling.`,
        ``,
        `⏳ Placing your stop orders now…`,
      ].join('\n'));
      const results = await autoTrader.syncUser(chatId);
      if (!results.length) await reply(chatId, `ℹ️ No eligible positions yet. Add one with a quantity on Binance, e.g. \`buy SOL 92.50 2\`.`);
      return;
    }

    if (sub === 'off') {
      await accounts.setEnabled(chatId, false);
      const n = await autoTrader.cancelAll(chatId);
      await reply(chatId, `⏸ *Auto-exits OFF.* ${n ? `Cancelled ${n} stop order${n === 1 ? '' : 's'} on Binance.` : ''} Your alerts carry on as before — you sell by hand.`);
      return;
    }

    if (sub === 'disconnect') {
      const n = await autoTrader.cancelAll(chatId);
      await accounts.removeKeys(chatId);
      await reply(chatId, `🔓 *Binance disconnected.* Keys deleted${n ? `, ${n} stop order${n === 1 ? '' : 's'} cancelled` : ''}. You can also delete the API key on Binance.`);
      return;
    }

    if (sub === 'resume' && args[1]) {
      const entries = await getPositionsBySymbol(chatId, normaliseSymbol(args[1]));
      for (const p of entries) await autoTrader.resume(chatId, p.positionId);
      await reply(chatId, entries.length ? `▶️ Auto-exits resumed for ${entries[0].symbol}.` : `⚠️ No ${normaliseSymbol(args[1])} positions.`);
      return;
    }
  } catch (err) {
    await reply(chatId, `❌ ${err instanceof accounts.TradingError ? err.message : err.message}`);
    return;
  }

  // Status + how-to
  const s = await accounts.getStatus(chatId);
  await reply(chatId, [
    `🤖 *Automated exits*`,
    ``,
    !s.encryptionReady ? `⚠️ Not set up on this bot yet (admin: add TRADING_ENCRYPTION_KEY in Vercel).` : '',
    s.connected
      ? `Account: Binance ${s.testnet ? 'testnet (fake money)' : '*LIVE (real money)*'} · key ${s.keyHint}\nStatus: ${s.enabled ? '🟢 ON' : '⚪ OFF'}${s.dryRun ? ' · DRY RUN' : ''}`
      : `Status: not connected`,
    s.lastError ? `Last problem: _${esc(s.lastError)}_` : '',
    ``,
    `*What it does:* sells for you on Binance at your stop and take-profits. Auto-exits on their own never buy (buying is ⚡ Buy Now or auto-buy, switched on separately) and can't withdraw.`,
    ``,
    `*Set up (test mode first):*`,
    `1. Get free testnet keys at https://testnet.binance.vision (log in with GitHub → Generate HMAC key)`,
    `2. Send \`autotrade connect API_KEY API_SECRET\``,
    `3. Send \`autotrade on\``,
    ``,
    `*Real money:* create a Binance API key with *Spot trading ON and withdrawals OFF* (keys that can withdraw are refused), then \`autotrade connect live KEY SECRET\` and \`autotrade on ${accounts.LIVE_CONFIRM}\`.`,
    ``,
    `\`autotrade off\` — stop (cancels the bot's stop orders)`,
    `\`autotrade disconnect\` — delete your keys`,
  ].filter(Boolean).join('\n'));
}

// ─── Process one Telegram update ─────────────────────────────────────────────
async function handleUpdate(body) {
  await subs.loadSettings().catch(() => {});
  // ── Button taps ─────────────────────────────────────────────────────────
  if (body.callback_query) {
    const cq     = body.callback_query;
    const chatId = cq.message?.chat?.id?.toString();
    const data   = cq.data || '';

    await answerCallback(cq.id);
    if (!chatId) return;

    // Tapping any button removes the screen it was on (keeps the chat tidy).
    // Receipts of actions ("✅ Bought…") are kept.
    const msgId = cq.message?.message_id;
    const rec = await nav.getMsg(chatId, msgId);
    await clearScreen(chatId, msgId, rec);

    if (data.startsWith('approve:') || data.startsWith('reject:')) {
      const [action, targetId] = data.split(':');
      await handleApproval(action, targetId, chatId);
      return;
    }

    const commandMap = {
      scan:        'scan',
      moonshots:   'moonshots',
      newlistings: 'newlistings',
      positions:   'positions',
      help:        'help',
      buy_help:    'buy_guide',
      sell_help:   'sell_guide',
      sold_help:   'sold_guide',
      split_help:  'split_guide',
      setstop_help: 'setstop_guide',
      check_help:  'check_guide',
      buynow_help: 'buynow',
      profit:      'profit',
      manual:      'manual',
    };
    // ⬅️ Back (nav:SCREEN) shows that screen again; anything else runs as before
    const ctx = await nav.contextForTap(chatId, data, rec);
    const command = data.startsWith('nav:') ? ctx.command : data;
    await withNav(ctx, () => handleMessage(chatId, commandMap[command] || command, cq.from));
    return;
  }

  // ── Regular messages ────────────────────────────────────────────────────
  const { message } = body;
  if (!message || !message.text) return;
  const chatId = message.chat?.id?.toString();
  // Never log API keys (`autotrade connect …`, or a key pasted into the go-live wizard)
  const looksSecret = /[A-Za-z0-9]{32,}/.test(message.text) || /^\/?auto(trade|exits?)(@\w+)?\s+connect/i.test(message.text.trim());
  const logText = looksSecret ? '[message with a key — not logged]' : message.text.slice(0, 80);
  console.log(`[Webhook] From ${chatId}: ${logText}`);
  // Typed commands: screens with buttons get ⬅️ Back to the menu. (Never stores
  // the typed text unless it is a known screen name, so keys can't leak here.)
  await withNav(nav.contextForTyped(chatId, message.text), () => handleMessage(chatId, message.text, message.from, { messageId: message.message_id }));
}

/** Telegram re-sends an update if we're slow; process each update_id once. */
async function firstTimeSeen(updateId) {
  if (updateId === undefined || updateId === null) return true;
  try {
    return (await store.cmd('SET', `cryptobot:tgupdate:${updateId}`, '1', 'NX', 'EX', 3600)) === 'OK';
  } catch {
    return true; // storage down: better to risk a duplicate than drop the message
  }
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).json({ ok: true });

  if (!verifyTelegramWebhook(req)) {
    console.warn('[Webhook] Rejected request without valid secret token');
    return res.status(401).json({ ok: false });
  }

  const body = req.body || {};
  if (!(await firstTimeSeen(body.update_id))) {
    return res.status(200).json({ ok: true, duplicate: true });
  }

  const work = handleUpdate(body).catch(err => console.error('[Webhook] Error:', err.stack || err.message));

  // On Vercel: reply to Telegram immediately and keep working in the background,
  // so slow commands (scan, newlistings, split) never time out or get re-sent.
  if (deferUntilAfterResponse(work)) return res.status(200).json({ ok: true });

  await work;
  return res.status(200).json({ ok: true });
};
