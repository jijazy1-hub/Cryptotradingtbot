/**
 * ─── 💬 Ask the bot (AI helper) ───────────────────────────────────────────────
 * Answers users' questions in plain words — "why did the bot buy SOL?", "what
 * is a stop?", "how do I move USDT to Spot?" — using the bot's REAL data for
 * that user (positions, practice, auto-buy reasons, savings plan) and the bot's
 * own rules.
 *
 * It EXPLAINS. It never trades, never picks coins, never predicts prices and
 * never promises returns: language models can't be backtested honestly (they
 * were trained on the very prices a test would use) and they can state wrong
 * numbers confidently. All trading decisions stay with the tested strategy.
 *
 * Env (Vercel):
 *   OPENAI_API_KEY     — use OpenAI          (one of these two is needed)
 *   ANTHROPIC_API_KEY  — use Anthropic Claude
 *   AI_PROVIDER        — optional: 'openai' or 'anthropic' if both keys are set
 *   AI_MODEL           — optional: the model name (defaults below)
 *   AI_DAILY_LIMIT     — optional: questions per user per day (default 20; the admin has no limit)
 */

const axios = require('axios');
const store = require('../lib/redis');

const DEFAULT_MODEL = { openai: 'gpt-4.1-mini', anthropic: 'claude-haiku-5-5' };
const MAX_QUESTION = 600;
const TIMEOUT_MS = 25_000;

class AiError extends Error {}

function provider() {
  const want = String(process.env.AI_PROVIDER || '').toLowerCase();
  if (want === 'openai' && process.env.OPENAI_API_KEY) return 'openai';
  if (want === 'anthropic' && process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}
const isConfigured = () => !!provider();
const model = () => process.env.AI_MODEL || DEFAULT_MODEL[provider()] || null;
const dailyLimit = () => Math.max(0, Number(process.env.AI_DAILY_LIMIT ?? 20) || 0);

// ─── What the bot is, and the rules the AI must follow ───────────────────────
const RULES = `You are the help assistant inside JijazyBot, a crypto trading assistant on Telegram used mostly by beginners in Nigeria.

WHAT THE BOT DOES (facts — do not contradict them):
- Tracks positions on 7 exchanges (Binance, Bybit, OKX, Gate, MEXC, KuCoin, Kraken) and sends alerts: stop hit, TP1 (sell 40%, stop to buy price), TP2 (sell 35%, stop to TP1), TP3 (sell the rest), the user's own target (sell 60% of what's left).
- Practice mode: $10,000 of play money at live Binance prices with 0.1% fee and 0.05% slippage.
- On the user's OWN Binance account (only if they connect it with "golive" and turn auto-trading on): stop orders and automatic sells; Buy Now ("buynow SOL 50"); auto-buy. The bot never holds money and its key can never withdraw. "golive off" stops everything.
- Auto-buy strategy ("Breakout to a new high"): once a day just after 1am Lagos time it checks every liquid Binance USDT coin (not just a short list) with the same rule and buys a coin that closes above its 55-day high, only while BTC is above its 100-day average. About 1% of the account at risk per trade, max 20% per coin, max 5 positions, no buys after a 3% daily drop. Every auto-bought trade is sold at the next daily check (just after 1am Lagos time), or sooner if its protective stop is hit (the lower of the 20-day low and 2x the coin's average daily range). The back-tested results below were measured on a hold-until-stop version over 15 coins; the daily-close version is NOT back-tested yet. Some days nothing qualifies and the bot buys nothing.
- Honest test result: it made money after fees on trades it was never tuned on (about +0.4R per trade, ~43% of trades win, winners are bigger than losers), about 7% a year with a worst drop of about 4%. Holding BTC made much more in the same period (about +94%) but with much bigger drops. Real-money auto-buy only opens after an 8-week live forward test.
- Weekly savings plan ("save 10"): every week the bot buys a fixed amount of BTC/ETH; it never sells savings.
- "expect 50" shows what to expect for an amount. Binance minimum order is $5; auto-buy needs about $50.
- P2P USDT arrives in the Binance Funding wallet; it must be moved Funding -> Spot for the bot to use it.
- Scan/Moonshots: smaller Binance coins with a heuristic score that has NOT been tested; high risk; auto-buy never buys them.

RULES (always):
1. Explain and teach. NEVER tell the user to buy, sell or hold a specific coin, and never pick coins for them. If asked, explain what the bot's strategy or data says (and the commands "check SOL", "stops", "autobuy") and say the decision is theirs.
2. NEVER predict prices or say a coin "will" go up or down. NEVER promise or estimate profits beyond the tested figures above. If someone hopes for big monthly returns (e.g. 50-100% a month), say honestly that no honest strategy does that.
3. Use ONLY the facts above and the USER DATA given. If you don't know, say so and point to the right command. Never invent numbers, prices, trades or features.
4. Never ask for passwords, codes or API keys. If the user shares one, tell them to delete the message and, for a Binance key, to delete it on Binance and make a new one.
5. Reply in the user's language (English, Nigerian Pidgin, Yoruba, Hausa or Igbo as they write). Be short and friendly: under 120 words, plain text, no tables, no markdown headings.
6. This is not financial advice; say so briefly only when the question is about money decisions.`;

const r2 = (x) => (Number.isFinite(Number(x)) ? Math.round(Number(x) * 100) / 100 : null);

/** The user's own data, compact, for the AI to explain. No keys, no other users. */
async function userContext(chatId) {
  const out = {};
  const safe = async (k, fn) => { try { const v = await fn(); if (v !== undefined && v !== null) out[k] = v; } catch { /* skip */ } };
  await safe('realPositions', async () => {
    const all = Object.values(await require('./positionStore').getAllPositions(chatId));
    return all.slice(0, 10).map(p => ({ coin: String(p.symbol).replace(/USDT$/, ''), exchange: p.exchange, buyPrice: p.buyPrice, quantity: p.quantity ?? null, stop: p.stopLossPrice ?? null,
      managedByBot: !!p.strategy || !!p.auto, boughtBy: p.autoBought ? 'auto-buy' : p.strategy ? 'Buy Now' : 'user (logged)', reason: p.buyReason || null, tp1Hit: !!p.tp1Hit, tp2Hit: !!p.tp2Hit }));
  });
  await safe('recentRealSales', async () => (await require('./profitTracker').getAllTrades(chatId)).slice(-5).map(t => ({ coin: String(t.symbol || '').replace(/USDT$/, ''), pnlUsd: r2(t.pnlDollar), closedAt: t.closedAt })));
  await safe('practice', async () => {
    const practice = require('./practiceService');
    if (!(await practice.getAccount(chatId, { create: false }))) return null;
    const s = await practice.summary(chatId);
    return { cash: s.cash, equity: s.equity, returnPct: s.returnPct,
      positions: s.positions.slice(0, 10).map(p => ({ coin: p.coin, buyPrice: p.buyPrice, now: p.currentPrice, pnlPct: p.pnlPct, stop: p.stopLossPrice, boughtByAutoBuy: p.auto })),
      lastTrades: s.trades.slice(0, 5).map(t => ({ coin: String(t.symbol || '').replace(/USDT$/, ''), pnlUsd: r2(t.pnlDollar), reason: t.reason || t.exitReason || null })) };
  });
  await safe('autoBuy', async () => {
    const st = await require('./autoBuyer').userStatus(chatId);
    return { practiceAutoBuyOn: st.practiceOn, realAutoBuyOn: st.liveOn, realAutoBuyOpened: st.unlocked,
      lastDailyCheck: st.lastRun ? { date: st.lastRun.date, marketFilter: st.lastRun.regimeText, buySignals: st.lastRun.buys } : null,
      forwardTest: { days: st.forward.days, closedTrades: st.forward.closedTrades } };
  });
  await safe('binance', async () => {
    const s = await require('./tradingAccounts').getStatus(chatId);
    return { connected: s.connected && !s.testnet, autoTradingOn: s.enabled };
  });
  await safe('savingsPlan', async () => {
    const sv = require('./savingsPlan');
    const p = await sv.getPlan(chatId);
    if (!p) return null;
    const s = await sv.summary(chatId);
    return { mode: p.mode, weeklyUsd: p.amount, coins: p.coins, day: sv.DAYS[p.day], active: p.active, nextBuy: p.nextDue, buys: s.buys, putIn: s.invested, worthNow: s.value };
  });
  return out;
}

// ─── Calling the AI ──────────────────────────────────────────────────────────
async function callModel(system, question) {
  const pv = provider();
  if (!pv) throw new AiError('not configured');
  try {
    if (pv === 'openai') {
      // GPT-5 and o-series models think before answering: they take no temperature and need more tokens
      const reasoning = /^(gpt-5|o\d)/i.test(model());
      const r = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: model(), max_completion_tokens: reasoning ? 2000 : 400, ...(reasoning ? {} : { temperature: 0.3 }),
        messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
      }, { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS });
      return String(r.data?.choices?.[0]?.message?.content || '').trim();
    }
    const r = await axios.post('https://api.anthropic.com/v1/messages', {
      model: model(), max_tokens: 400, temperature: 0.3, system,
      messages: [{ role: 'user', content: question }],
    }, { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS });
    return (r.data?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  } catch (err) {
    const status = err?.response?.status;
    const why = status === 401 ? 'the AI key was rejected' : status === 429 ? 'the AI service is busy or out of credit' : status === 404 ? `the model "${model()}" wasn't found (set AI_MODEL)` : err.code === 'ECONNABORTED' ? 'the AI took too long' : 'the AI service had an error';
    throw new AiError(why);
  }
}

/** Questions left today for this user (Infinity for the admin). */
async function remaining(chatId, { isAdmin = false } = {}) {
  if (isAdmin) return Infinity;
  const used = Number(await store.cmd('GET', `cryptobot:ai:count:${new Date().toISOString().slice(0, 10)}:${chatId}`)) || 0;
  return Math.max(0, dailyLimit() - used);
}

/** Answer one question for one user. */
async function ask(chatId, question, { isAdmin = false } = {}) {
  if (!isConfigured()) throw new AiError('not configured');
  const q = String(question || '').trim().slice(0, MAX_QUESTION);
  if (q.length < 2) throw new AiError('empty');
  if (!isAdmin) {
    const key = `cryptobot:ai:count:${new Date().toISOString().slice(0, 10)}:${chatId}`;
    const n = Number(await store.cmd('INCR', key)) || 1;
    if (n === 1) await store.cmd('EXPIRE', key, 2 * 86400).catch(() => {});
    if (n > dailyLimit()) throw new AiError('limit');
  }
  const ctx = await userContext(chatId);
  const system = `${RULES}\n\nTODAY: ${new Date().toISOString().slice(0, 10)}\nUSER DATA (this user only; may be empty):\n${JSON.stringify(ctx)}`;
  const answer = await callModel(system, q);
  if (!answer) throw new AiError('the AI gave an empty answer');
  return answer.slice(0, 3500);
}

module.exports = { AiError, ask, isConfigured, provider, model, dailyLimit, remaining, userContext, RULES };
