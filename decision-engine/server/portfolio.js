// Paper portfolio. PAPER ONLY — there is no code path that sends real orders.
//
// Accounting uses a simple collateral model that works for longs and shorts alike:
//   open : cash -= collateral (qty·entry) + fees
//   value: collateral + dir·(price − entry)·qty
//   close: cash += collateral + pnl − fees
// Exits: stop, target, horizon expiry, opposite high-confidence signal. Stops move to breakeven
// once price has covered half the distance to target. New entries halt when equity is more than
// MAX_DRAWDOWN below its peak (circuit breaker), and stocks only trade in regular hours.
const cfg = require("./config");
const db = require("./db");
const { horizonEndMs } = require("./data/stocks");

const lastPrice = new Map();                 // assetId -> latest mark
const costBps = (assetClass) => (assetClass === "crypto" ? cfg.FEE_BPS_CRYPTO : cfg.FEE_BPS_STOCK) + cfg.SLIPPAGE_BPS;
const dirOf = (p) => (p.direction === "short" ? -1 : 1);

function markPrice(assetId, price) { if (price > 0) lastPrice.set(assetId, price); }

function positionValue(p) {
  const px = lastPrice.get(p.assetId) ?? p.entry;
  return p.costUsd + dirOf(p) * (px - p.entry) * p.qty;
}

function equity() {
  const cash = db.num("cash", cfg.PAPER_BALANCE);
  return cash + db.openPositions().reduce((s, p) => s + positionValue(p), 0);
}

function drawdown() {
  const eq = equity();
  const peak = Math.max(db.num("peak_equity", eq), eq);
  if (peak > db.num("peak_equity", 0)) db.setSetting("peak_equity", peak.toFixed(2));
  return peak > 0 ? 1 - eq / peak : 0;
}

function open(decision, { marketOpen = true } = {}) {
  const r = decision.risk || {};
  if (!r.direction || !(r.sizeUsd > 0) || !(decision.price > 0)) return null;
  if (decision.assetClass === "stock" && !marketOpen) return null;
  if (db.openPosition(decision.assetId)) return null;
  if (drawdown() >= cfg.MAX_DRAWDOWN) return null;           // circuit breaker

  const eq = equity();
  const gross = db.openPositions().reduce((s, p) => s + p.costUsd, 0);
  const room = Math.max(0, cfg.MAX_GROSS * eq - gross);
  const cash = db.num("cash", 0);
  const sizeUsd = Math.min(r.sizeUsd, room, cash * 0.98);
  if (sizeUsd < 10) return null;

  const slip = decision.price * cfg.SLIPPAGE_BPS / 1e4;
  const entry = r.direction === "long" ? decision.price + slip : decision.price - slip;
  const qty = sizeUsd / entry;
  const fees = sizeUsd * (costBps(decision.assetClass) - cfg.SLIPPAGE_BPS) / 1e4;
  const H = cfg.HORIZONS[decision.horizon] || cfg.HORIZONS.swing;

  db.setSetting("cash", (cash - sizeUsd - fees).toFixed(2));
  const id = db.insertPosition({
    assetId: decision.assetId, symbol: decision.symbol, assetClass: decision.assetClass,
    direction: r.direction, qty, entry, stop: r.stop, target: r.target,
    // Holding period in the asset's own trading time (audit fix: stocks used calendar time, so a
    // 5-bar swing position expired after 3.0–4.8 trading days instead of the backtested 5).
    expiresAt: horizonEndMs(decision.assetClass, Date.now(), H.ahead, H.tf), costUsd: sizeUsd, decisionId: decision.decisionId,
    pUp: decision.pUp, confidence: decision.confidence, fees,
  });
  return { id, symbol: decision.symbol, direction: r.direction, qty, entry, sizeUsd, stop: r.stop, target: r.target };
}

function close(p, price, reason) {
  const d = dirOf(p);
  const slip = price * cfg.SLIPPAGE_BPS / 1e4;
  const exit = d === 1 ? price - slip : price + slip;
  const pnlGross = d * (exit - p.entry) * p.qty;
  const fees = Math.abs(exit * p.qty) * (costBps(p.assetClass) - cfg.SLIPPAGE_BPS) / 1e4;
  const pnl = pnlGross - fees - (p.fees || 0);                       // net of entry + exit fees
  const cash = db.num("cash", 0) + p.costUsd + pnlGross - fees;
  db.setSetting("cash", cash.toFixed(2));
  db.closePosition(p.id, { exit, exitReason: reason, pnl, pnlPct: pnl / p.costUsd, fees });
  return { id: p.id, symbol: p.symbol, direction: p.direction, exit, reason, pnl };
}

// Called on every price update. Returns closed trades (for WS broadcast).
function onPrice(assetId, price, nowMs = Date.now()) {
  markPrice(assetId, price);
  const out = [];
  for (const p of db.openPositions().filter(x => x.assetId === assetId)) {
    const d = dirOf(p);
    if (p.stop != null && d * (price - p.stop) <= 0) { out.push(close(p, price, "stop")); continue; }
    if (p.target != null && d * (price - p.target) >= 0) { out.push(close(p, price, "target")); continue; }
    if (p.expiresAt && nowMs >= p.expiresAt) { out.push(close(p, price, "horizon")); continue; }
    // Breakeven stop once half-way to target.
    if (p.target != null && p.stop != null && d * (p.stop - p.entry) < 0 &&
        d * (price - p.entry) >= 0.5 * d * (p.target - p.entry)) db.updateStop(p.id, p.entry);
  }
  return out;
}

// Called with every fresh decision. Returns { opened, closed }.
function onDecision(decision, { marketOpen = true, autoTrade = true } = {}) {
  const res = { opened: null, closed: null };
  if (!(decision.price > 0)) return res;
  markPrice(decision.assetId, decision.price);
  const p = db.openPosition(decision.assetId);
  const a = decision.action;
  if (p) {
    const flip = (p.direction === "long" && (a === "SELL" || a === "STRONG_SELL")) ||
                 (p.direction === "short" && (a === "BUY" || a === "STRONG_BUY"));
    if (flip && (decision.assetClass !== "stock" || marketOpen)) res.closed = close(p, decision.price, "signal-flip");
    else return res;
  }
  if (autoTrade && a !== "HOLD") res.opened = open(decision, { marketOpen });
  return res;
}

function snapshot() {
  const cash = db.num("cash", cfg.PAPER_BALANCE);
  const positions = db.openPositions().map(p => {
    const mark = lastPrice.get(p.assetId) ?? p.entry;
    const upnl = dirOf(p) * (mark - p.entry) * p.qty;
    return { ...p, side: p.direction, price: mark, mark, value: p.costUsd + upnl, upnl, upnlPct: upnl / p.costUsd };
  });
  const eq = cash + positions.reduce((s, p) => s + p.value, 0);
  const trades = db.closedTrades(500).map(t => ({ ...t, side: t.direction }));
  const wins = trades.filter(t => t.pnl > 0), losses = trades.filter(t => t.pnl <= 0);
  const sum = (a) => a.reduce((s, t) => s + (t.pnl || 0), 0);
  const curve = db.equityCurve().map(pt => ({ ...pt, t: pt.ts, v: pt.equity }));
  const rets = [];
  for (let i = 1; i < curve.length; i++) if (curve[i - 1].equity > 0) rets.push(curve[i].equity / curve[i - 1].equity - 1);
  const mean = rets.length ? rets.reduce((s, x) => s + x, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1)) : 0;
  let peak = -Infinity, maxDD = 0;
  for (const pt of curve) { peak = Math.max(peak, pt.equity); maxDD = Math.max(maxDD, 1 - pt.equity / peak); }
  const start = db.num("start_equity", cfg.PAPER_BALANCE);
  return {
    equity: eq, cash, startEquity: start, startingEquity: start, returnPct: eq / start - 1, drawdown: drawdown(),
    breaker: drawdown() >= cfg.MAX_DRAWDOWN, positions, trades, equityCurve: curve,
    stats: {
      nTrades: trades.length, winRate: trades.length ? wins.length / trades.length : null,
      profitFactor: losses.length && sum(losses) !== 0 ? sum(wins) / Math.abs(sum(losses)) : null,
      avgWin: wins.length ? sum(wins) / wins.length : null, avgLoss: losses.length ? sum(losses) / losses.length : null,
      realizedPnl: sum(trades),
      // Sharpe of the minute-sampled equity curve, annualized by sample count per year (approximate).
      // Only once the curve spans ≥ 7 days: annualizing a few hours of minute marks is meaningless.
      sharpe: sd > 0 && curve.length > 100 && (new Date(curve.at(-1).ts) - new Date(curve[0].ts)) >= 7 * 86400e3 ? (mean / sd) * Math.sqrt(525600 / Math.max(1, (new Date(curve.at(-1).ts) - new Date(curve[0].ts)) / 60000 / rets.length)) : null,
      maxDD,
    },
  };
}

function reset(amount = cfg.PAPER_BALANCE) {
  for (const p of db.openPositions()) close(p, lastPrice.get(p.assetId) ?? p.entry, "reset");
  db.setSetting("cash", amount.toFixed(2));
  db.setSetting("start_equity", amount.toFixed(2));
  db.setSetting("peak_equity", amount.toFixed(2));
}

module.exports = { markPrice, equity, drawdown, open, close, onPrice, onDecision, snapshot, reset, lastPrice };
