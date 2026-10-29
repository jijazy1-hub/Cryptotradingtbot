/**
 * ─── Telegram client (single shared copy) ────────────────────────────────────
 * Every module sends Telegram messages through here.
 *
 * - Reads env vars at call time (so tests / late config work).
 * - Markdown safety net: if Telegram rejects a message because a coin name or
 *   username contains `_`, `*`, `[` etc. ("can't parse entities"), the message
 *   is re-sent as plain text instead of being silently lost.
 * - Long messages are split under Telegram's 4096-char limit.
 */

const axios = require('axios');

const MAX_LEN = 4000;

function token() {
  return process.env.TELEGRAM_BOT_TOKEN;
}

function isConfigured() {
  return !!token();
}

/** Low-level Bot API call. Throws on network / API errors. */
async function call(method, payload, timeout = 10000) {
  if (!token()) throw new Error('TELEGRAM_BOT_TOKEN not set');
  const resp = await axios.post(`https://api.telegram.org/bot${token()}/${method}`, payload, { timeout });
  if (!resp.data || !resp.data.ok) {
    throw new Error(`Telegram ${method} failed: ${JSON.stringify(resp.data)}`);
  }
  return resp.data.result;
}

function isParseError(err) {
  const desc = err?.response?.data?.description || err?.message || '';
  return /can't parse entities|can't find end of the entity/i.test(desc);
}

/**
 * Send one message.
 * @param {string|number} chatId
 * @param {string} text
 * @param {object} [opts]
 * @param {object} [opts.markup]   reply_markup
 * @param {boolean} [opts.silent]  deliver without a notification sound
 * @param {boolean} [opts.plain]   send without Markdown
 * @param {boolean} [opts.throwOnError] rethrow instead of logging
 * @returns {Promise<object|null>} Telegram message, or null if not sent
 */
async function send(chatId, text, opts = {}) {
  if (!token() || chatId === undefined || chatId === null || chatId === '') {
    console.warn('[Telegram] Missing token or chat id — message skipped');
    return null;
  }

  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (!opts.plain) payload.parse_mode = 'Markdown';
  if (opts.markup) payload.reply_markup = opts.markup;
  if (opts.silent) payload.disable_notification = true;

  try {
    return await call('sendMessage', payload, 10000);
  } catch (err) {
    if (!opts.plain && isParseError(err)) {
      // Retry as plain text so the user still gets the alert.
      try {
        const { parse_mode, ...plainPayload } = payload;
        return await call('sendMessage', plainPayload, 10000);
      } catch (err2) {
        err = err2;
      }
    }
    const detail = err?.response?.data?.description || err.message;
    if (opts.throwOnError) throw new Error(detail);
    console.error(`[Telegram] Send to ${chatId} failed: ${detail}`);
    return null;
  }
}

/** Split long text on line boundaries and send each part. */
async function sendLong(chatId, text, opts = {}) {
  if (text.length <= MAX_LEN) return send(chatId, text, opts);
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if ((current + line + '\n').length > MAX_LEN && current) {
      chunks.push(current);
      current = '';
    }
    current += line + '\n';
  }
  if (current) chunks.push(current);
  let last = null;
  for (let i = 0; i < chunks.length; i++) {
    // Only attach the keyboard to the final chunk
    const chunkOpts = i === chunks.length - 1 ? opts : { ...opts, markup: undefined };
    last = await send(chatId, chunks[i], chunkOpts);
  }
  return last;
}

async function answerCallback(callbackQueryId) {
  try {
    await call('answerCallbackQuery', { callback_query_id: callbackQueryId }, 5000);
  } catch { /* non-fatal */ }
}

/** Escape user-controlled text for legacy Markdown (names, descriptions). */
function escapeMd(text) {
  return String(text ?? '').replace(/([_*`\[])/g, '\\$1');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

module.exports = { call, send, sendLong, answerCallback, escapeMd, isConfigured, sleep };
