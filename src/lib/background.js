/**
 * Run work after the HTTP response has been sent.
 *
 * On Vercel, @vercel/functions' waitUntil keeps the function alive (up to its
 * maxDuration) after we reply. That lets the Telegram webhook answer instantly
 * — so Telegram doesn't time out and re-send the same message — while a slow
 * command like `scan` keeps running.
 *
 * Off Vercel (local runs, tests) there is no such mechanism, so callers await
 * the work inline instead.
 */
let waitUntil = null;
try { ({ waitUntil } = require('@vercel/functions')); } catch { /* optional dependency */ }

/** @returns {boolean} true if the work was handed off to run in the background */
function deferUntilAfterResponse(promise) {
  if (process.env.VERCEL === '1' && typeof waitUntil === 'function') {
    waitUntil(promise);
    return true;
  }
  return false;
}

module.exports = { deferUntilAfterResponse };
