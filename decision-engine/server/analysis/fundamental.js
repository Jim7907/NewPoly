// Fundamental analysis (contract §2.4). Pure functions: normalized fundamentals in, Signal[] out.
//
// Philosophy
// ----------
// Fundamentals move slowly and their documented return predictability (value, profitability,
// accruals, net issuance, distress) plays out over months, not hours. So:
//   * valuation / quality / balance-sheet / Piotroski / Altman signals carry horizon "position",
//     growth and analyst-target revisions carry "swing" (post-earnings-drift style);
//   * confidence is moderate by design (≤ ~0.6) and is scaled down when the caller asks for a
//     shorter horizon (opts.horizon: intraday ×0.2, swing ×0.6 for "position" signals);
//   * every sub-signal is skipped (never NaN) when any input it needs is null / non-finite.
//
// References behind the bands and signs
//   Piotroski (2000) "Value Investing: The Use of Historical Financial Statement Information…"
//   Altman (1968) Z-score; Altman (1995/2000) Z''-score for non-manufacturers.
//   Novy-Marx (2013) gross profitability (GP / total assets).
//   Sloan (1996) accruals anomaly.  Pontiff & Woodgate (2008) net share issuance.
//   Greenblatt / Gray-Carlisle EBIT/EV ("earnings yield" on enterprise value).
//   Campbell, Hilscher & Szilagyi (2008) — distressed firms earn *lower* returns (distress anomaly).
//   Brav & Lehavy (2003) — analyst price targets are optimistic on average (≈+10–15%).
//   Liu & Tsyvinski (2021), Liu, Tsyvinski & Wu (2022) — crypto time-series / cross-sectional momentum.

const FAMILY = "fundamental";

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const allNum = (...xs) => xs.every(isNum);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (x, d = 4) => (isNum(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
// Smooth squashing: tanh keeps scores in (-1, 1) and is ~linear near the centre.
const squash = (x) => (isNum(x) ? Math.tanh(x) : 0);

// Horizon multiplier for confidence: a "position"-horizon signal says little about the next 2h.
function horizonMult(signalHorizon, reqHorizon) {
  if (!reqHorizon || reqHorizon === "any" || reqHorizon === signalHorizon) return 1;
  const rank = { intraday: 0, swing: 1, position: 2 };
  const a = rank[signalHorizon], b = rank[reqHorizon];
  if (a == null || b == null) return 1;
  const gap = Math.abs(a - b);
  return gap === 0 ? 1 : gap === 1 ? 0.6 : 0.2;
}

function makeSignal(id, score, confidence, horizon, value, reason, opts = {}) {
  const s = isNum(score) ? clamp(score, -1, 1) : 0;
  let c = isNum(confidence) ? clamp(confidence, 0, 1) : 0;
  c *= horizonMult(horizon, opts.horizon) * (isNum(opts.staleMult) ? opts.staleMult : 1);
  return { id, family: FAMILY, score: round(s, 4), confidence: round(clamp(c, 0, 1), 4), horizon, value, reason };
}

// ---------------------------------------------------------------------------------------------
// Piotroski F-score (Piotroski 2000, Table 1 definitions)
// ---------------------------------------------------------------------------------------------
// Profitability
//   F_ROA      ROA_t = NI_t / beginning-of-year total assets > 0
//   F_CFO      CFO_t > 0
//   F_ΔROA     ROA_t > ROA_{t-1}
//   F_ACCRUAL  CFO_t / beginning assets > ROA_t   (i.e. CFO > NI)
// Leverage / liquidity / source of funds
//   F_ΔLEVER   long-term debt / total assets fell vs prior year (strict, as in the paper: a
//              debt-free firm that stays debt-free scores 0 here, exactly as Piotroski's ratio
//              change of 0 would)
//   F_ΔLIQUID  current ratio rose vs prior year
//   EQ_OFFER   no common equity issued in the year (shares outstanding did not increase)
// Operating efficiency
//   F_ΔMARGIN  gross margin rose vs prior year
//   F_ΔTURN    asset turnover (sales / beginning total assets) rose vs prior year
// Piotroski scales by beginning-of-year assets; we use totalAssetsPrev as beginning assets and fall
// back to current totalAssets when the prior value is missing. roaPrev / grossMarginPrev /
// assetTurnoverPrev / currentRatioPrev come pre-computed from the data layer.
//
// Returns { score, tested, complete, criteria:{name: 0|1|null} } or null when fewer than 5 of the
// 9 criteria can be evaluated (an F-score out of 4 is not the published statistic).
function piotroski(f) {
  if (!f || typeof f !== "object") return null;
  const begAssets = isNum(f.totalAssetsPrev) && f.totalAssetsPrev > 0 ? f.totalAssetsPrev
    : isNum(f.totalAssets) && f.totalAssets > 0 ? f.totalAssets : null;
  const roa = allNum(f.netIncomeTTM, begAssets) ? f.netIncomeTTM / begAssets : null;
  const bin = (cond) => (cond ? 1 : 0);
  const c = {};
  c.roa = isNum(roa) ? bin(roa > 0) : null;
  c.cfo = isNum(f.cfoTTM) ? bin(f.cfoTTM > 0) : null;
  c.deltaRoa = allNum(roa, f.roaPrev) ? bin(roa > f.roaPrev) : null;
  c.accrual = allNum(f.cfoTTM, f.netIncomeTTM) ? bin(f.cfoTTM > f.netIncomeTTM) : null;

  const lev = allNum(f.longTermDebt, f.totalAssets) && f.totalAssets > 0 ? f.longTermDebt / f.totalAssets : null;
  const levPrev = allNum(f.longTermDebtPrev, f.totalAssetsPrev) && f.totalAssetsPrev > 0 ? f.longTermDebtPrev / f.totalAssetsPrev : null;
  c.deltaLever = allNum(lev, levPrev) ? bin(lev < levPrev) : null;

  const cr = allNum(f.currentAssets, f.currentLiabilities) && f.currentLiabilities > 0 ? f.currentAssets / f.currentLiabilities : null;
  c.deltaLiquid = allNum(cr, f.currentRatioPrev) ? bin(cr > f.currentRatioPrev) : null;
  c.eqOffer = allNum(f.sharesOut, f.sharesOutPrev) ? bin(f.sharesOut <= f.sharesOutPrev) : null;

  const gm = allNum(f.grossProfitTTM, f.revenueTTM) && f.revenueTTM > 0 ? f.grossProfitTTM / f.revenueTTM : null;
  c.deltaMargin = allNum(gm, f.grossMarginPrev) ? bin(gm > f.grossMarginPrev) : null;
  const turn = allNum(f.revenueTTM, begAssets) ? f.revenueTTM / begAssets : null;
  c.deltaTurn = allNum(turn, f.assetTurnoverPrev) ? bin(turn > f.assetTurnoverPrev) : null;

  const vals = Object.values(c).filter((v) => v !== null);
  if (vals.length < 5) return null;
  const score = vals.reduce((a, b) => a + b, 0);
  return { score, tested: vals.length, complete: vals.length === 9, criteria: c };
}

// ---------------------------------------------------------------------------------------------
// Altman Z
// ---------------------------------------------------------------------------------------------
// Original Z (Altman 1968; public manufacturers):
//   Z = 1.2·X1 + 1.4·X2 + 3.3·X3 + 0.6·X4 + 1.0·X5
//   X1 = working capital / TA, X2 = retained earnings / TA, X3 = EBIT / TA,
//   X4 = market value of equity / total liabilities, X5 = sales / TA
//   zones: safe > 2.99, grey 1.81–2.99, distress < 1.81
// Z'' (Altman 1995; non-manufacturers / service firms — drops the sales-turnover term, which is
// industry-sensitive, and uses BOOK equity):
//   Z'' = 6.56·X1 + 3.26·X2 + 6.72·X3 + 1.05·X4'   (X4' = book equity / total liabilities)
//   zones: safe > 2.60, grey 1.10–2.60, distress < 1.10
// Model choice: manufacturers (industrials, materials, energy, autos, semis, hardware, chemicals…)
// use Z; everything else (software, internet, services, retail, health-care services…) uses Z''.
// Financials / REITs are excluded (Altman's samples exclude them; leverage is their business) → null.
// opts.model = "Z" | "Z''" overrides the choice.
const FINANCIAL_RE = /financ|bank|insurance|reit|real estate investment|capital markets|brokerage|savings institution|asset management/i;
const MANUFACTURING_RE = /manufactur|industrial|basic material|materials|energy|oil|gas|chemical|steel|metal|mining|machinery|aerospace|defense|auto|vehicle|semiconductor|electronic|hardware|equipment|computer|paper|packaging|construction|building products|consumer durable|capital goods|pharmaceutical preparations/i;

function altmanModel(f) {
  const text = `${f.sector || ""} ${f.industry || ""}`;
  if (FINANCIAL_RE.test(text)) return null;
  return MANUFACTURING_RE.test(text) ? "Z" : "Z''";
}

function altmanZ(f, opts = {}) {
  if (!f || typeof f !== "object") return null;
  const model = opts.model || altmanModel(f);
  if (!model) return null;
  const TA = f.totalAssets, TL = f.totalLiabilities;
  if (!allNum(TA, TL, f.currentAssets, f.currentLiabilities, f.retainedEarnings, f.ebitTTM) || TA <= 0 || TL <= 0) return null;
  const X1 = (f.currentAssets - f.currentLiabilities) / TA;
  const X2 = f.retainedEarnings / TA;
  const X3 = f.ebitTTM / TA;
  if (model === "Z") {
    const mve = isNum(f.marketCap) ? f.marketCap : allNum(f.price, f.sharesOut) ? f.price * f.sharesOut : null;
    if (!allNum(mve, f.revenueTTM)) return null;
    const X4 = mve / TL, X5 = f.revenueTTM / TA;
    const z = 1.2 * X1 + 1.4 * X2 + 3.3 * X3 + 0.6 * X4 + 1.0 * X5;
    const zone = z > 2.99 ? "safe" : z >= 1.81 ? "grey" : "distress";
    return { z, model, zone, safe: 2.99, distress: 1.81, parts: { X1, X2, X3, X4, X5 } };
  }
  if (!isNum(f.equity)) return null;
  const X4 = f.equity / TL;
  const z = 6.56 * X1 + 3.26 * X2 + 6.72 * X3 + 1.05 * X4;
  const zone = z > 2.6 ? "safe" : z >= 1.1 ? "grey" : "distress";
  return { z, model: "Z''", zone, safe: 2.6, distress: 1.1, parts: { X1, X2, X3, X4 } };
}

// Asymmetric map: Altman is a distress predictor. Safe zone = mildly positive (+0.1…+0.3),
// grey = roughly neutral-to-negative, distress = strongly negative (distress anomaly).
function altmanScore(a) {
  const { z, safe, distress } = a;
  if (z >= safe) return 0.1 + 0.2 * Math.tanh((z - safe) / safe);
  if (z >= distress) return -0.3 + 0.4 * ((z - distress) / (safe - distress));
  return -0.3 - 0.6 * Math.tanh((distress - z) / distress);
}

// ---------------------------------------------------------------------------------------------
// Stock signals
// ---------------------------------------------------------------------------------------------
function staleMultiplier(asOf, now) {
  if (!asOf) return 1;
  const t = typeof asOf === "number" ? asOf : Date.parse(asOf);
  const n = isNum(now) ? now : Date.now();
  if (!isNum(t)) return 1;
  const days = (n - t) / 86400000;
  // Quarterly filings: fine for ~4 months, then fade toward 0.5 by ~1 year.
  if (days <= 120) return 1;
  return clamp(1 - 0.5 * (days - 120) / 245, 0.5, 1);
}

function analystSignal(f, price, o) {
  if (!allNum(f.analystTarget, price) || price <= 0 || f.analystTarget <= 0) return null;
  const upside = f.analystTarget / price - 1;
  // Debias for the documented optimism of sell-side targets (~10%).
  const adj = upside - 0.10;
  return makeSignal("fund.analyst.target", 0.6 * squash(adj / 0.2), 0.25 + 0.1 * Math.min(1, Math.abs(adj) / 0.3), "swing",
    { target: f.analystTarget, price, upside: round(upside) },
    `Consensus target $${f.analystTarget.toFixed(2)} vs price $${price.toFixed(2)} = ${pct(upside)} upside (${pct(adj)} after ~10% sell-side optimism haircut)`, o);
}

function stockSignals(f, opts = {}) {
  if (!f || typeof f !== "object") return [];
  const out = [];
  const o = { horizon: opts.horizon, staleMult: staleMultiplier(f.asOf, opts.now) };
  const push = (s) => { if (s) out.push(s); };
  const price = isNum(f.price) ? f.price : null;
  const mcap = isNum(f.marketCap) && f.marketCap > 0 ? f.marketCap
    : allNum(price, f.sharesOut) && price * f.sharesOut > 0 ? price * f.sharesOut : null;
  const isEtf = !!(f.etf || (opts.asset && opts.asset.etf));

  // --- ETFs: no company fundamentals; only analyst target / quoted P/E if the data layer had them.
  if (isEtf) {
    push(analystSignal(f, price, o));
    if (isNum(f.peRatio) && f.peRatio > 0) {
      const ey = 1 / f.peRatio;
      push(makeSignal("fund.value.earnings_yield", 0.5 * squash((ey - 0.045) / 0.03), 0.2, "position",
        { pe: f.peRatio, ey: round(ey) }, `ETF P/E ${f.peRatio.toFixed(1)} → earnings yield ${pct(ey)} vs ~4.5% market norm`, o));
    }
    return out;
  }

  // ---------------- Valuation ----------------
  // Earnings yield E/P (negative earnings → mildly negative: loss-makers lack valuation support).
  let ey = null;
  if (allNum(f.netIncomeTTM, mcap)) ey = f.netIncomeTTM / mcap;
  else if (allNum(f.epsTTM, price) && price > 0) ey = f.epsTTM / price;
  else if (isNum(f.peRatio) && f.peRatio > 0) ey = 1 / f.peRatio;
  if (isNum(ey)) {
    const score = ey > 0 ? squash((ey - 0.04) / 0.04) : -0.3 - 0.3 * squash(-ey / 0.05);
    push(makeSignal("fund.value.earnings_yield", score, 0.3 + 0.15 * Math.abs(squash((ey - 0.04) / 0.04)), "position",
      { ey: round(ey), pe: ey > 0 ? round(1 / ey, 2) : null },
      ey > 0 ? `Earnings yield ${pct(ey)} (P/E ${(1 / ey).toFixed(1)}) vs ~4% neutral band` : `Negative TTM earnings (E/P ${pct(ey)}) — no earnings support for valuation`, o));
  }

  // FCF yield: prefer reported FCF, else CFO − |capex|.
  const fcf = isNum(f.fcfTTM) ? f.fcfTTM : allNum(f.cfoTTM, f.capexTTM) ? f.cfoTTM - Math.abs(f.capexTTM) : null;
  if (allNum(fcf, mcap)) {
    const fy = fcf / mcap;
    push(makeSignal("fund.value.fcf_yield", squash((fy - 0.035) / 0.035), 0.3 + 0.15 * Math.abs(squash((fy - 0.035) / 0.035)), "position",
      { fcfYield: round(fy), fcf }, `Free-cash-flow yield ${pct(fy)} vs ~3.5% neutral`, o));
  }

  // Price/sales, scaled by gross margin when known (a 70%-GM business deserves a higher P/S).
  if (allNum(mcap, f.revenueTTM) && f.revenueTTM > 0) {
    const ps = mcap / f.revenueTTM;
    const gm = allNum(f.grossProfitTTM) ? f.grossProfitTTM / f.revenueTTM : null;
    const fair = isNum(gm) && gm > 0 ? clamp(2.5 * (gm / 0.4), 0.8, 8) : 2.5;
    const x = Math.log(ps / fair) / 1.0;
    push(makeSignal("fund.value.price_sales", -0.8 * squash(x), 0.25, "position",
      { ps: round(ps, 2), fairPs: round(fair, 2) }, `P/S ${ps.toFixed(2)} vs margin-adjusted fair ~${fair.toFixed(1)}`, o));
  }

  // Price/book — low weight: book equity is distorted by buybacks and intangibles for modern firms.
  if (allNum(mcap, f.equity) && f.equity > 0) {
    const pb = mcap / f.equity;
    push(makeSignal("fund.value.price_book", -0.6 * squash(Math.log(pb / 3) / 1.2), 0.15, "position",
      { pb: round(pb, 2) }, `P/B ${pb.toFixed(2)} vs ~3 neutral (low weight: intangibles/buybacks distort book)`, o));
  }

  // EBIT / EV (Greenblatt's earnings yield). EV = mcap + LT debt − cash.
  if (allNum(mcap, f.ebitTTM)) {
    const ev = mcap + (isNum(f.longTermDebt) ? f.longTermDebt : 0) - (isNum(f.cash) ? f.cash : 0);
    if (ev > 0) {
      const y = f.ebitTTM / ev;
      push(makeSignal("fund.value.ebit_ev", squash((y - 0.06) / 0.04), 0.35, "position",
        { ebitEv: round(y), evEbit: y > 0 ? round(1 / y, 2) : null, ev },
        y > 0 ? `EV/EBIT ${(1 / y).toFixed(1)} (EBIT yield ${pct(y)} vs ~6% neutral)` : `Negative EBIT vs EV $${(ev / 1e9).toFixed(1)}B`, o));
    }
  }

  // ---------------- Quality ----------------
  if (allNum(f.netIncomeTTM, f.equity) && f.equity > 0) {
    const roe = f.netIncomeTTM / f.equity;
    push(makeSignal("fund.quality.roe", 0.7 * squash((roe - 0.12) / 0.12), 0.3, "position",
      { roe: round(roe) }, `ROE ${pct(roe)} vs ~12% cost-of-equity benchmark`, o));
  }
  if (allNum(f.netIncomeTTM, f.totalAssets) && f.totalAssets > 0) {
    const roa = f.netIncomeTTM / f.totalAssets;
    push(makeSignal("fund.quality.roa", 0.7 * squash((roa - 0.05) / 0.05), 0.3, "position",
      { roa: round(roa), roaPrev: round(f.roaPrev) }, `ROA ${pct(roa)}${isNum(f.roaPrev) ? ` (prior ${pct(f.roaPrev)})` : ""} vs ~5% benchmark`, o));
  }
  // Novy-Marx (2013): gross profits / assets — the cleanest profitability predictor.
  if (allNum(f.grossProfitTTM, f.totalAssets) && f.totalAssets > 0) {
    const gpa = f.grossProfitTTM / f.totalAssets;
    push(makeSignal("fund.quality.gross_profitability", 0.8 * squash((gpa - 0.3) / 0.2), 0.4, "position",
      { gpa: round(gpa) }, `Gross profitability GP/A ${pct(gpa)} vs ~30% median (Novy-Marx)`, o));
  }
  // Margins: level + trend.
  if (allNum(f.revenueTTM) && f.revenueTTM > 0 && (isNum(f.grossProfitTTM) || isNum(f.operatingIncomeTTM))) {
    const gm = isNum(f.grossProfitTTM) ? f.grossProfitTTM / f.revenueTTM : null;
    const om = isNum(f.operatingIncomeTTM) ? f.operatingIncomeTTM / f.revenueTTM : null;
    let s = 0, n = 0;
    if (isNum(om)) { s += squash((om - 0.12) / 0.12); n++; }
    if (isNum(gm)) { s += 0.5 * squash((gm - 0.35) / 0.2); n++; }
    if (isNum(gm) && isNum(f.grossMarginPrev)) { s += squash((gm - f.grossMarginPrev) / 0.03); n++; }
    const parts = [];
    if (isNum(gm)) parts.push(`gross ${pct(gm)}${isNum(f.grossMarginPrev) ? ` (prior ${pct(f.grossMarginPrev)})` : ""}`);
    if (isNum(om)) parts.push(`operating ${pct(om)}`);
    push(makeSignal("fund.quality.margins", 0.7 * squash(s / Math.max(1, n) * 1.3), 0.3, "position",
      { grossMargin: round(gm), opMargin: round(om), grossMarginPrev: round(f.grossMarginPrev) }, `Margins: ${parts.join(", ")}`, o));
  }
  // Sloan (1996) accruals: (NI − CFO) / average total assets. High accruals → lower future returns.
  if (allNum(f.netIncomeTTM, f.cfoTTM, f.totalAssets) && f.totalAssets > 0) {
    const avgA = isNum(f.totalAssetsPrev) && f.totalAssetsPrev > 0 ? (f.totalAssets + f.totalAssetsPrev) / 2 : f.totalAssets;
    const acc = (f.netIncomeTTM - f.cfoTTM) / avgA;
    push(makeSignal("fund.quality.accruals", -0.7 * squash(acc / 0.05), 0.3 + 0.15 * Math.min(1, Math.abs(acc) / 0.1), "position",
      { accruals: round(acc) }, `Accruals ratio ${pct(acc)} of assets (${acc > 0 ? "earnings ahead of cash — lower quality" : "cash earnings exceed accounting earnings — high quality"}, Sloan)`, o));
  }

  // ---------------- Growth ----------------
  if (allNum(f.revenueTTM, f.revenuePrevTTM) && f.revenuePrevTTM > 0) {
    const g = f.revenueTTM / f.revenuePrevTTM - 1;
    push(makeSignal("fund.growth.revenue", 0.7 * squash((g - 0.05) / 0.15), 0.35, "swing",
      { revGrowth: round(g) }, `Revenue TTM ${g >= 0 ? "+" : ""}${pct(g)} YoY`, o));
  }
  {
    const cur = isNum(f.epsTTM) ? f.epsTTM : f.netIncomeTTM;
    const prev = isNum(f.epsTTM) && isNum(f.epsPrevTTM) ? f.epsPrevTTM : isNum(f.epsTTM) ? null : f.netIncomePrevTTM;
    if (allNum(cur, prev)) {
      let score, g = null, reason;
      if (prev > 0) {
        g = clamp(cur / prev - 1, -3, 3);
        score = 0.7 * squash((g - 0.05) / 0.25);
        reason = `EPS TTM ${g >= 0 ? "+" : ""}${pct(g)} YoY (${prev.toFixed(2)} → ${cur.toFixed(2)})`;
      } else if (cur > 0) { score = 0.45; reason = `EPS turned positive (${prev.toFixed(2)} → ${cur.toFixed(2)})`; }
      else { score = cur > prev ? 0.1 : -0.35; reason = `Loss-making: EPS ${prev.toFixed(2)} → ${cur.toFixed(2)}`; }
      push(makeSignal("fund.growth.eps", score, 0.35, "swing", { epsGrowth: round(g), eps: cur, epsPrev: prev }, reason, o));
    }
  }

  // ---------------- Balance sheet ----------------
  if (allNum(f.longTermDebt, f.equity)) {
    if (f.equity > 0) {
      const de = f.longTermDebt / f.equity;
      push(makeSignal("fund.balance.leverage", 0.5 * squash((1 - de) / 1), 0.25, "position",
        { debtEquity: round(de, 3) }, `Long-term debt/equity ${de.toFixed(2)} (${de < 0.5 ? "conservative" : de < 1.5 ? "moderate" : "high"} leverage)`, o));
    } else {
      // Negative book equity: fine for buyback compounders, deadly otherwise — let coverage decide.
      const cov = allNum(f.ebitTTM, f.interestExpenseTTM) && f.interestExpenseTTM > 0 ? f.ebitTTM / f.interestExpenseTTM : null;
      const s = isNum(cov) && cov > 8 ? 0 : -0.3;
      push(makeSignal("fund.balance.leverage", s, 0.15, "position", { debtEquity: null, equity: f.equity },
        `Negative book equity${isNum(cov) ? ` (interest coverage ${cov.toFixed(1)}x)` : ""}`, o));
    }
  }
  if (allNum(f.currentAssets, f.currentLiabilities) && f.currentLiabilities > 0) {
    const cr = f.currentAssets / f.currentLiabilities;
    push(makeSignal("fund.balance.liquidity", 0.4 * squash((cr - 1.2) / 0.6), 0.2, "position",
      { currentRatio: round(cr, 3), currentRatioPrev: round(f.currentRatioPrev, 3) }, `Current ratio ${cr.toFixed(2)}${isNum(f.currentRatioPrev) ? ` (prior ${f.currentRatioPrev.toFixed(2)})` : ""}`, o));
  }
  if (isNum(f.ebitTTM) && isNum(f.interestExpenseTTM) && Math.abs(f.interestExpenseTTM) > 0) {
    const cov = f.ebitTTM / Math.abs(f.interestExpenseTTM);
    const score = cov <= 0 ? -0.7 : 0.6 * squash(Math.log(cov / 4) / 1.0);
    push(makeSignal("fund.balance.interest_coverage", score, 0.3, "position",
      { coverage: round(cov, 2) }, `Interest coverage (EBIT/interest) ${cov.toFixed(1)}x vs ~4x comfort level`, o));
  }

  // ---------------- Composite scores ----------------
  const pio = piotroski(f);
  if (pio) {
    // Rescale partial scores to a 9-point basis; centre 4.5.
    const f9 = (pio.score / pio.tested) * 9;
    let conf = 0.3 + 0.25 * (pio.tested / 9) * Math.min(1, Math.abs(f9 - 4.5) / 3.5);
    // Piotroski's edge is concentrated in value (high book-to-market) stocks.
    const pb = allNum(mcap, f.equity) && f.equity > 0 ? mcap / f.equity : null;
    if (isNum(pb) && pb < 1.5) conf *= 1.2;
    push(makeSignal("fund.quality.piotroski", squash((f9 - 4.5) / 2.5), conf, "position",
      { fscore: pio.score, tested: pio.tested, criteria: pio.criteria },
      `Piotroski F-score ${pio.score}/${pio.tested}${pio.complete ? "" : ` (≈${f9.toFixed(1)}/9 scaled)`} — ${f9 >= 7 ? "strong" : f9 <= 3 ? "weak" : "average"} fundamentals trend`, o));
  }
  const alt = altmanZ(f);
  if (alt) {
    const s = altmanScore(alt);
    push(makeSignal("fund.risk.altman_z", s, alt.zone === "distress" ? 0.5 : alt.zone === "grey" ? 0.3 : 0.25, "position",
      { z: round(alt.z, 3), model: alt.model, zone: alt.zone },
      `Altman ${alt.model} = ${alt.z.toFixed(2)} → ${alt.zone} zone (thresholds ${alt.distress}/${alt.safe})`, o));
  }

  // ---------------- Capital allocation ----------------
  if (allNum(f.sharesOut, f.sharesOutPrev) && f.sharesOutPrev > 0) {
    const chg = f.sharesOut / f.sharesOutPrev - 1;
    push(makeSignal("fund.capital.share_change", -0.6 * squash(chg / 0.03), 0.3 * Math.min(1, 0.4 + Math.abs(chg) / 0.03), "position",
      { shareChange: round(chg) }, chg < 0 ? `Share count ${pct(chg)} YoY — net buybacks (net-issuance anomaly favours)` : `Share count +${pct(chg)} YoY — net dilution`, o));
  }

  push(analystSignal(f, price, o));
  return out;
}

// ---------------------------------------------------------------------------------------------
// Crypto signals
// ---------------------------------------------------------------------------------------------
// Percent inputs (change7d/30d/1y, athChangePct, sentimentUpPct) are in PERCENT units as CoinGecko
// reports them (e.g. -32.5 = −32.5%). opts.btc = { change30d, change1y } (percent) enables the
// relative-to-BTC signals; without it (or for BTC itself) we emit absolute momentum instead.
const NON_PLATFORM = new Set(["BTC", "XRP", "DOGE", "LTC", "BCH", "LINK"]);

function cryptoSignals(f, opts = {}) {
  if (!f || typeof f !== "object") return [];
  const out = [];
  const o = { horizon: opts.horizon, staleMult: 1 };
  const push = (s) => { if (s) out.push(s); };
  const sym = String(f.symbol || "").toUpperCase();
  const mcap = isNum(f.marketCap) && f.marketCap > 0 ? f.marketCap : null;

  // Turnover / NVT-like: market cap / 24h volume. Very high NVT = valuation not supported by
  // activity (Woo's NVT); very high turnover (>40%/day) = speculative churn → capped.
  if (allNum(mcap, f.volume24h) && f.volume24h > 0) {
    const turnover = f.volume24h / mcap;
    const nvt = 1 / turnover;
    let s = -0.4 * squash(Math.log(nvt / 25) / 1.2);
    if (turnover > 0.4) s = Math.min(s, 0) - 0.1; // froth
    push(makeSignal("fund.crypto.turnover", s, 0.2, "swing",
      { turnover: round(turnover), nvt: round(nvt, 1) }, `24h volume/mcap ${pct(turnover, 2)} (NVT-like ${nvt.toFixed(0)} vs ~25 neutral)`, o));
  }

  // Supply overhang: FDV / mcap (or max/circulating). Large locked/unissued supply = future sell pressure.
  {
    let ratio = null;
    if (allNum(f.fdv, mcap) && f.fdv > 0) ratio = f.fdv / mcap;
    else if (allNum(f.circulatingSupply) && f.circulatingSupply > 0) {
      const cap = isNum(f.maxSupply) && f.maxSupply > 0 ? f.maxSupply : isNum(f.totalSupply) && f.totalSupply > 0 ? f.totalSupply : null;
      if (isNum(cap)) ratio = cap / f.circulatingSupply;
    }
    if (isNum(ratio) && ratio >= 1) {
      const overhang = ratio - 1;
      const uncapped = f.maxSupply == null && f.totalSupply != null;
      let s = -0.6 * squash(overhang / 0.8);
      if (uncapped) s -= 0.05;
      push(makeSignal("fund.crypto.supply_overhang", s, 0.2 + 0.2 * Math.min(1, overhang), "position",
        { fdvToMcap: round(ratio, 3), circulatingPct: round(1 / ratio), uncapped },
        `${pct(1 / ratio)} of fully-diluted supply circulating (FDV/mcap ${ratio.toFixed(2)})${uncapped ? "; no hard cap" : ""}`, o));
    }
  }

  // Drawdown from ATH: near ATH = momentum/anchoring (George & Hwang 52w-high effect); a >80%
  // drawdown usually marks a broken narrative rather than value.
  if (isNum(f.athChangePct)) {
    const dd = f.athChangePct / 100;
    push(makeSignal("fund.crypto.ath_drawdown", 0.35 * squash((dd + 0.45) / 0.2), 0.25, "position",
      { athChangePct: f.athChangePct, ath: isNum(f.ath) ? f.ath : null }, `Price ${pct(dd)} from all-time high`, o));
  }

  // TVL / market cap for smart-contract platforms (a P/B analogue).
  if (allNum(f.tvl, mcap) && f.tvl > 0 && !NON_PLATFORM.has(sym)) {
    const r = f.tvl / mcap;
    push(makeSignal("fund.crypto.tvl_ratio", 0.5 * squash(Math.log(r / 0.1) / 1.2), 0.25, "position",
      { tvlToMcap: round(r) }, `DeFi TVL/mcap ${r.toFixed(3)} vs ~0.10 typical L1`, o));
  }

  // Developer activity (level, not direction — low confidence).
  if (isNum(f.devCommits4w)) {
    const c = Math.max(0, f.devCommits4w);
    push(makeSignal("fund.crypto.dev_activity", 0.3 * squash((Math.log1p(c) - Math.log1p(40)) / 1.2), 0.15, "position",
      { commits4w: c, stars: isNum(f.devStars) ? f.devStars : null }, `${c} GitHub commits in 4 weeks`, o));
  }

  // Momentum: relative to BTC when available, else absolute (crypto TS momentum is robust).
  const btc = opts.btc || {};
  const rel = (a, b) => (allNum(a, b) ? (1 + a / 100) / (1 + b / 100) - 1 : null);
  if (sym !== "BTC" && isNum(btc.change30d) && isNum(f.change30d)) {
    const r = rel(f.change30d, btc.change30d);
    push(makeSignal("fund.crypto.rel_btc_30d", 0.5 * squash(r / 0.15), 0.3, "swing",
      { rel: round(r), change30d: f.change30d, btc30d: btc.change30d }, `30d ${f.change30d.toFixed(1)}% vs BTC ${btc.change30d.toFixed(1)}% → ${pct(r)} relative`, o));
  } else if (isNum(f.change30d)) {
    const r = f.change30d / 100;
    push(makeSignal("fund.crypto.momentum_30d", 0.4 * squash(r / 0.2), 0.2, "swing",
      { change30d: f.change30d }, `30d performance ${f.change30d.toFixed(1)}% (time-series momentum)`, o));
  }
  if (sym !== "BTC" && isNum(btc.change1y) && isNum(f.change1y)) {
    const r = rel(f.change1y, btc.change1y);
    push(makeSignal("fund.crypto.rel_btc_1y", 0.4 * squash(r / 0.5), 0.25, "position",
      { rel: round(r), change1y: f.change1y, btc1y: btc.change1y }, `1y ${f.change1y.toFixed(0)}% vs BTC ${btc.change1y.toFixed(0)}% → ${pct(r)} relative`, o));
  } else if (isNum(f.change1y)) {
    const r = f.change1y / 100;
    push(makeSignal("fund.crypto.momentum_1y", 0.35 * squash(r / 0.8), 0.15, "position",
      { change1y: f.change1y }, `1y performance ${f.change1y.toFixed(0)}%`, o));
  }

  return out;
}

module.exports = { stockSignals, cryptoSignals, piotroski, altmanZ, altmanModel, _altmanScore: altmanScore };
