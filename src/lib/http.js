/**
 * GET with retries for rate limits (429) and temporary server errors (5xx),
 * honouring Retry-After. Used for CoinGecko / KuCoin, which throttle free users.
 */
const axios = require('axios');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getWithRetry(url, config = {}, { retries = 2, baseDelayMs = 1500, maxDelayMs = 8000 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      return await axios.get(url, config);
    } catch (err) {
      const status = err?.response?.status;
      const retryable = status === 429 || (status >= 500 && status < 600) || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED';
      if (!retryable || attempt >= retries) throw err;
      const ra = Number(err?.response?.headers?.['retry-after']);
      const wait = Math.min(maxDelayMs, Number.isFinite(ra) && ra > 0 ? ra * 1000 : baseDelayMs * 2 ** attempt);
      attempt++;
      await sleep(wait);
    }
  }
}

module.exports = { getWithRetry, sleep };
