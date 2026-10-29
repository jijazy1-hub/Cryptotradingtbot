/**
 * GET /api/backtest — the saved backtest results for the live strategy.
 *
 * A real backtest (months of 15m candles × every coin) is too heavy for a
 * serverless request, so it runs with `npm run backtest` and the summary is
 * committed as data/strategy-stats.json. This endpoint just serves that file.
 */

const { loadSavedStats } = require('../src/services/strategyStats');
const { cors } = require('../src/lib/auth');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const stats = loadSavedStats();
  if (!stats) {
    return res.status(200).json({
      success: true,
      available: false,
      message: 'No backtest results yet. Run `npm run backtest` locally, then commit data/strategy-stats.json.',
    });
  }
  return res.status(200).json({ success: true, ...stats });
};
