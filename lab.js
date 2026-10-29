/**
 * ─── Strategy lab: test the auto-buy strategies honestly ──────────────────────
 *
 *   npm run lab                  # 15 large coins, ~4 years of daily candles
 *   npm run lab -- --days 1000   # less history
 *   npm run lab -- --refresh     # re-download (otherwise cached for 24h)
 *   npm run lab -- --all --top 100   # the 100 most-traded Binance coins instead of the 15 core coins
 *
 * Tests 3 strategy families × their settings × with/without a BTC market filter
 * (22 variants), then shows comparisons for information only: 2% risk, breakout +
 * strongest coins together, and holding BTC only above its 200-day average. Settings are chosen on the older 65% of the history and judged
 * on the newer 35% only. Fees, slippage and price gaps are charged.
 *
 * Writes data/auto-strategy.json — commit it: the bot uses it to decide which
 * strategy practice auto-buy runs, and whether live auto-buy can ever be
 * unlocked (it needs a PASS here plus 8 weeks of profitable forward testing).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { fetchKlinesWithSource } = require('./src/lib/market');
const { research } = require('./src/services/strategyLab');
const { universe, STRATEGY_FILE } = require('./src/config/autobuy');
const { resolveUniverse } = require('./src/services/universe');

const CACHE_DIR = path.join(__dirname, 'data', 'cache');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const flag = (n) => process.argv.includes(`--${n}`);

async function daily(symbol, days, refresh) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, `${symbol}-1d.json`);
  if (!refresh && fs.existsSync(file)) {
    try {
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Date.now() - c.fetchedAt < 24 * 3_600_000 && c.candles.length >= Math.min(days, c.available || days)) return c.candles.slice(-days);
    } catch { /* re-download */ }
  }
  const { candles, exchange } = await fetchKlinesWithSource(symbol, '1d', days, { closedOnly: true, exchange: 'binance' });
  if (exchange !== 'Binance') throw new Error('needs Binance data');
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), available: candles.length, candles }));
  return candles;
}

const pct = (x) => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : ''}${x}%`);
const r = (x) => (x === null || x === undefined ? '—' : `${x >= 0 ? '+' : ''}${x}R`);

(async () => {
  const days = Number(arg('days', 1500));
  // --all [--top 100]: test the most-traded Binance coins instead of the 15 core coins
  const syms = flag('all') ? [...(await resolveUniverse({ force: true, top: Number(arg('top', 100)) })).symbols] : universe();
  if (!syms.includes('BTCUSDT')) syms.unshift('BTCUSDT');
  console.log(`\nStrategy lab — ${syms.length} coins, up to ${days} daily candles each\n`);
  const data = {};
  for (const s of syms) {
    try { data[s] = await daily(s, days, flag('refresh')); console.log(`  ${s.padEnd(10)} ${data[s].length} days`); }
    catch (e) { console.log(`  ${s.padEnd(10)} skipped (${e.message})`); }
  }

  const out = research(data);
  console.log(`\nPeriod ${out.period.from} → ${out.period.to}. Settings chosen on data before ${out.period.split}; judged only after it.`);
  console.log(`Costs: ${out.rules.feePct}% fee + ${out.rules.slippagePct}% slippage per side, stops fill at gaps.\n`);
  console.log('Family              Chosen settings                     Unseen period: trades  win%   avg     95% range          PF    1%-risk portfolio  verdict');
  for (const f of out.families) {
    if (!f.chosen) { console.log(`${f.name.padEnd(20)}${'—'.padEnd(36)}${f.why}`); continue; }
    const t = f.test;
    console.log(`${f.name.padEnd(24)}${f.chosen.id.padEnd(32)}${String(t.trades).padStart(6)}  ${String(t.winRatePct ?? '—').padStart(5)}  ${r(t.expectancyR).padStart(7)}  ${JSON.stringify(t.expectancyRange95).padEnd(17)}  ${String(t.profitFactor ?? '—').padStart(4)}  ${pct(f.portfolioTest.returnPct).padStart(8)} (max DD ${f.portfolioTest.maxDrawdownPct}%)  ${f.verdict}`);
  }
  console.log(`\nBTC buy & hold over the unseen period: ${pct(out.btcBuyHoldTestPct)}`);

  const cmp = out.comparisons || {};
  console.log('\nComparisons on the unseen period — for information only (they do NOT change the pick or auto-buy):');
  const pf = (p) => (p ? `${pct(p.returnPct).padStart(8)} (max DD ${p.maxDrawdownPct}%)` : '—');
  for (const f of out.families) if (f.chosen && cmp.risk2?.[f.family]) console.log(`  ${f.name.padEnd(28)} 1% risk ${pf(f.portfolioTest)}   2% risk ${pf(cmp.risk2[f.family])}`);
  if (cmp.combo) {
    const t = cmp.combo.test;
    console.log(`  ${'Breakout + Strongest coins'.padEnd(28)} 1% risk ${pf(cmp.combo.portfolio1)}   2% risk ${pf(cmp.combo.portfolio2)}   ${t.trades} trades, ${r(t.expectancyR)} avg, PF ${t.profitFactor ?? '—'}, ${cmp.combo.verdict}`);
  }
  if (cmp.btcHold) console.log(`  ${'Hold BTC'.padEnd(28)} ${pf(cmp.btcHold)}`);
  if (cmp.btcTrend200) console.log(`  ${'Hold BTC above its 200-day'.padEnd(28)} ${pf(cmp.btcTrend200)}   in the market ${cmp.btcTrend200.timeInMarketPct}% of days, ${cmp.btcTrend200.switches} buys/sells`);
  console.log('  A better number here is a reason to test further, not proof: these were compared on the same period they are judged on.');
  if (out.pick) {
    console.log(`\nPICKED (best on the training data): ${out.pick.label}`);
    console.log(`VERDICT: ${out.verdict} — ${out.pick.why}`);
  } else {
    console.log('\nVERDICT: FAIL — no strategy had enough trades');
  }
  console.log(out.verdict === 'PASS'
    ? '\nNext: commit data/auto-strategy.json. Practice auto-buy uses this strategy; live auto-buy can be unlocked after 8 weeks of profitable forward testing.'
    : '\nPractice auto-buy will run this pick as a labelled experiment. Live auto-buy stays locked.');

  const file = path.join(__dirname, STRATEGY_FILE);
  const { variants, ...summary } = out;
  fs.writeFileSync(file, JSON.stringify({ ...summary, variants }, null, 2));
  console.log(`\nSaved ${STRATEGY_FILE}\n`);
})().catch(e => { console.error('Lab failed:', e.message); process.exit(1); });
