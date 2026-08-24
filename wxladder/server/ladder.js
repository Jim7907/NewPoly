// The ladder itself: turn a bias-corrected predictive distribution + a live bucket book
// into a priced, sized basket of 3-4 ADJACENT rungs — or into an explicit refusal.
//
// The structure is the article's. The arithmetic it leaves implied is spelled out here:
//
//   A ladder is not automatically +EV. Buying a contiguous cluster of buckets is just
//   buying a coarser event, and it costs the sum of its parts. "47c for a basket that pays
//   100c" only prints if the true probability of the neighborhood exceeds 47% plus fees —
//   and these ladders quote a real overround (Yes prices sum to ~1.02-1.10), so the basket
//   buyer pays the vig on every rung. Every basket here therefore has to clear
//   MIN_BASKET_EV on a distribution whose realized error we have actually measured.
//
// What the cluster genuinely buys is SHAPE, not free money: it converts "be exactly right"
// into "be approximately right", which is the bet a calibrated forecast can win. The
// positive skew is real; the edge still has to be earned.
const cfg = require("./config");
const M = require("./math");
const { walkAsks } = require("./poly");

const fmtBucket = (b) => b.label || (b.lo === -Infinity ? `<=${b.hi}` : b.hi === Infinity ? `>=${b.lo}` : `${b.lo}`);

// Contiguous index windows of size `w` that contain `center`, clipped to the array.
function windowsAround(center, n, w) {
  const out = [];
  for (let start = Math.max(0, center - w + 1); start <= Math.min(center, n - w); start++) {
    if (start < 0 || start + w > n) continue;
    out.push(Array.from({ length: w }, (_, i) => start + i));
  }
  return out;
}

// Effective per-share buy cost for a bucket, all-in (price + taker fee + slippage).
function legCost(bucket, book, p = cfg) {
  const ask = book && book.ask != null ? book.ask : bucket.ask;
  if (ask == null || !(ask > 0) || ask >= 1) return null;
  const fee = bucket.fee || { rate: p.FEE_RATE, exp: p.FEE_EXP };
  return { ask, qEff: M.effCost(ask, fee.rate, fee.exp, p.SLIP), feePerShare: M.feePerShare(ask, fee.rate, fee.exp) };
}

// Allocate `spend` across the rungs and price the fills against real depth.
function sizeWindow(legs, spend, p) {
  const sizeLegs = legs.map(l => ({ prob: l.prob, qEff: l.qEff }));
  let weights, kellyFrac = null;
  if (p.SIZING === "kelly") {
    // Multi-outcome Kelly across mutually-exclusive rungs. It holds cash back on its own
    // when the rungs are not worth their price, so an all-zero result is a real answer.
    const f = M.kellyAllocate(sizeLegs, p.KELLY_K);
    kellyFrac = M.sum(f);
    weights = kellyFrac > 0 ? f.map(x => x / kellyFrac) : sizeLegs.map(() => 0);
  } else if (p.SIZING === "prob") {
    weights = M.probWeights(sizeLegs);           // article §7: dollars ~ model probability
  } else {
    weights = M.equalShareWeights(sizeLegs);     // equal SHARES: any rung pays the same
  }

  const out = legs.map((l, i) => {
    const dollars = spend * weights[i];
    const rawShares = l.qEff > 0 ? dollars / l.qEff : 0;
    // Respect the venue's minimum order size: a rung we cannot legally place is dropped,
    // not silently rounded up into an order we never intended.
    const minSh = l.bucket.minShares || p.MIN_ORDER_SHARES;
    let shares = rawShares >= minSh ? Math.floor(rawShares * 100) / 100 : 0;
    // Re-price against real depth: what the rung costs to FILL, not just to touch.
    const walked = shares > 0 && l.book ? walkAsks(l.book.asks, shares) : null;
    const unfillable = shares > 0 && l.book != null && walked == null;
    const fillAsk = walked != null ? walked : l.ask;
    const fee = l.bucket.fee || { rate: p.FEE_RATE, exp: p.FEE_EXP };
    const fillQEff = fillAsk == null ? null : M.effCost(fillAsk, fee.rate, fee.exp, p.SLIP);
    // Walking up a thin book costs more per share than the touch price we sized against.
    // Trim the rung back inside its allocation rather than quietly overspending the budget
    // (the walked price is kept, so the trimmed size is if anything conservative).
    if (fillQEff > 0 && shares > 0 && shares * fillQEff > dollars) {
      shares = Math.floor((dollars / fillQEff) * 100) / 100;
      if (shares < minSh) shares = 0;
    }
    return {
      label: l.label, idx: l.idx, deg: l.bucket.deg, type: l.bucket.type,
      marketId: l.bucket.marketId, tokenId: l.bucket.yesToken,
      prob: +l.prob.toFixed(4), pModel: +l.pModel.toFixed(4), pMarket: +l.pMarket.toFixed(4),
      ask: l.ask, qEff: +l.qEff.toFixed(4),
      fillAsk, fillQEff: fillQEff == null ? null : +fillQEff.toFixed(4), unfillable,
      feePerShare: l.feePerShare == null ? null : +l.feePerShare.toFixed(5),
      shares: +shares.toFixed(2),
      dollars: +(shares * (fillQEff ?? l.qEff)).toFixed(2),
      edge: +(l.prob - l.qEff).toFixed(4),
      ev: +M.legEv(l.prob, l.qEff).toFixed(4),
      spreadC: l.spreadC, depthUsd: l.depthUsd,
    };
  });

  const funded = out.filter(l => l.shares > 0);
  const fillMetrics = funded.length
    ? M.basketMetrics(funded.map(l => ({ prob: l.prob, price: l.fillAsk, qEff: l.fillQEff ?? l.qEff, shares: l.shares })))
    : null;
  return {
    legs: out, funded: funded.length,
    kellyFrac: kellyFrac == null ? null : +kellyFrac.toFixed(4),
    outlay: +M.sum(out.map(l => l.dollars)).toFixed(2),
    fillEv: fillMetrics ? fillMetrics.ev : null,
    fillCoverProb: fillMetrics ? fillMetrics.coverProb : null,
    unfillable: out.some(l => l.unfillable),
  };
}

// ── Main entry ──────────────────────────────────────────────────
// Pure given its inputs, so the backtester replays the identical decision rule.
//
//   lad       : normalized ladder from poly.toLadder + selectTradable
//   forecast  : { rawCenter, ensSd, ensMean, detMean, members, nMembers }
//   biasFit   : from bias.fitBias
//   spreadHist: past ensSd values for this station+kind+lead
//   books     : { [tokenId]: parsedBook }  (optional; Gamma top-of-book is the fallback)
function buildLadder(input, p = cfg) {
  const { lad, forecast, biasFit, spreadHist = [], books = {}, bankroll = 0, openExposure = 0 } = input;
  const reasons = [];
  const out = {
    eventId: lad.eventId, slug: lad.slug, city: lad.city, kind: lad.kind, date: lad.date,
    station: lad.station.icao, stationName: lad.station.name, tz: lad.station.tz,
    leadDays: lad.leadDays, unit: lad.unit, overround: lad.overround, negRisk: lad.negRisk,
    signal: "—", legs: [], reasons, budget: 0,
  };

  if (lad.unsupported) { reasons.push("station-unsupported"); return out; }
  if (!forecast || forecast.rawCenter == null) { reasons.push("no-forecast"); return out; }

  // ── 1. Center on the bias-corrected STATION forecast (art. §8) ──
  const bias = biasFit && biasFit.ready ? biasFit.bias : 0;
  const center = forecast.rawCenter + bias;
  out.rawCenter = +forecast.rawCenter.toFixed(2);
  out.bias = +bias.toFixed(3);
  out.center = +center.toFixed(2);
  out.biasSamples = biasFit ? biasFit.n : 0;
  out.ensMean = forecast.ensMean; out.detMean = forecast.detMean; out.nMembers = forecast.nMembers;

  // ── 2. Underdispersion filter (art. §6) ──
  // Prefer the ensemble track; fall back to the multi-model track, which is the one that can
  // be seeded from history. Comparing today's spread against its OWN track's median is what
  // keeps the ratio meaningful — the two scales are never pooled.
  const tracks = Array.isArray(spreadHist) ? { ens: spreadHist, det: [] } : (spreadHist || { ens: [], det: [] });
  let dispRatio = M.dispersionRatio(forecast.ensSd, tracks.ens || [], p.MIN_DISP_SAMPLES);
  let dispSource = dispRatio != null ? "ensemble" : null;
  if (dispRatio == null) {
    dispRatio = M.dispersionRatio(forecast.detSd, tracks.det || [], p.MIN_DISP_SAMPLES);
    if (dispRatio != null) dispSource = "multi-model";
  }
  const regime = M.dispersionRegime(dispRatio, p.UNDERDISP_LO, p.OVERDISP_HI);
  out.ensSd = forecast.ensSd; out.detSd = forecast.detSd ?? null;
  out.dispRatio = dispRatio == null ? null : +dispRatio.toFixed(3);
  out.dispSource = dispSource; out.regime = regime;
  out.spreadSamples = (tracks.ens || []).length;
  out.detSpreadSamples = (tracks.det || []).length;

  // ── 3. Predictive sigma, anchored on this station's REALIZED post-correction error ──
  const sigma = M.predictiveSigma({
    rmse: biasFit && biasFit.ready ? biasFit.rmse : null,
    dispRatio, gamma: p.SPREAD_GAMMA, floor: p.SD_FLOOR, fallback: p.SD_FALLBACK, mult: p.SIGMA_MULT,
  });
  out.sigma = +sigma.toFixed(3);

  // ── 4. Model distribution over the buckets ──
  // The bucket rule is per-station: METAR reports whole degrees ("round"), while the HK
  // Observatory reports 0.1 C and the market takes the containing range ("floor"). The two
  // sit half a degree apart, so using the wrong one mis-centres every rung.
  const rule = lad.station.bucketRule || "round";
  out.bucketRule = rule;
  let pModel = M.bucketProbs(lad.buckets, center, sigma, rule);
  if (p.EMPIRICAL_W > 0 && forecast.members && forecast.members.length > 4) {
    const shifted = forecast.members.map(v => v + bias);
    pModel = M.blendProbs(pModel, M.empiricalBucketProbs(lad.buckets, shifted, 1, rule), p.EMPIRICAL_W);
  }

  // ── 5. Price every bucket; de-vig the book into a market distribution ──
  const priced = lad.buckets.map((b, i) => {
    const book = books[b.yesToken] || null;
    const c = legCost(b, book, p);
    const quote = book && book.mid != null ? book.mid
      : (b.bid != null && b.ask != null ? (b.bid + b.ask) / 2 : (b.ask ?? b.lastPrice));
    return {
      idx: i, bucket: b, label: fmtBucket(b), pModel: pModel[i], quote,
      ask: c ? c.ask : null, qEff: c ? c.qEff : null, feePerShare: c ? c.feePerShare : null,
      book, tradable: !!c && b.acceptingOrders !== false,
      spreadC: book ? book.spreadC : null,
      depthUsd: book ? book.askDepthUsd : null,
    };
  });
  const pMarket = M.impliedProbs(priced.map(x => x.quote));
  // P_used: trust the model, but not to the exclusion of what the book knows.
  const pUsed = M.blendProbs(pModel, pMarket, 1 - p.W_MODEL);
  priced.forEach((x, i) => { x.pMarket = pMarket[i]; x.prob = pUsed[i]; });

  const disagreement = M.tvd(pModel, pMarket);
  out.tvd = +disagreement.toFixed(4);
  out.wModel = p.W_MODEL;
  out.distribution = priced.map(x => ({
    label: x.label, pModel: +x.pModel.toFixed(4), pMarket: +x.pMarket.toFixed(4),
    prob: +x.prob.toFixed(4), ask: x.ask,
    edge: x.qEff != null ? +(x.prob - x.qEff).toFixed(4) : null,
  }));

  // ── 6. Pick the rungs: contiguous, centered, 3-4 wide (art. §2, §8) ──
  let centerIdx = 0;
  for (let i = 1; i < pUsed.length; i++) if (pUsed[i] > pUsed[centerIdx]) centerIdx = i;
  out.centerBucket = priced[centerIdx].label;

  const mult = regime === "tight" ? p.TIGHT_BUDGET_MULT : regime === "wide" ? p.WIDE_BUDGET_MULT : 1;
  const room = Math.max(0, p.AGG_CAP * bankroll - openExposure);
  const budget = Math.min(bankroll * p.BUDGET_FRAC * mult, room);
  out.budget = +budget.toFixed(2);
  out.budgetMult = mult;

  // Tight ensemble => the cluster can be narrower; wide => spend the extra rung on cover.
  const widths = regime === "tight" ? [p.LADDER_MIN_W, p.LADDER_MIN_W + 1]
    : regime === "wide" ? [p.LADDER_MAX_W, p.LADDER_MAX_W - 1]
      : [p.LADDER_MIN_W, p.LADDER_MAX_W];
  const allowed = [...new Set(widths)].filter(w => w >= p.LADDER_MIN_W && w <= p.LADDER_MAX_W && w <= priced.length);

  // Score each candidate window AFTER sizing, so a window whose rungs the sizer refuses to
  // fund is never selected and then rejected — we just pick a different window.
  let best = null, cheapest = null;
  for (const w of allowed) {
    for (const idxs of windowsAround(centerIdx, priced.length, w)) {
      const legs = idxs.map(i => priced[i]);
      if (legs.some(l => !l.tradable)) continue;                // a hole breaks the ladder
      const metrics = M.basketMetrics(legs.map(l => ({ prob: l.prob, price: l.ask, qEff: l.qEff })));
      if (!cheapest || metrics.basketCost < cheapest.metrics.basketCost) cheapest = { w, metrics };
      if (metrics.basketCost > p.MAX_BASKET_COST) continue;     // art. §8: too wide/too rich
      const sized = budget > 0 ? sizeWindow(legs, p.SIZING === "kelly"
        ? Math.min(budget, (M.sum(M.kellyAllocate(legs.map(l => ({ prob: l.prob, qEff: l.qEff })), p.KELLY_K))) * bankroll)
        : budget, p) : null;
      const feasible = !!sized && sized.funded >= p.LADDER_MIN_W && !sized.unfillable;
      const score = sized && sized.fillEv != null ? sized.fillEv : metrics.ev;
      const cand = { idxs, legs, w, metrics, sized, feasible, score };
      if (!best || (cand.feasible !== best.feasible ? cand.feasible : cand.score > best.score)) best = cand;
    }
  }

  if (!best) {
    reasons.push(priced.some(l => !l.tradable) ? "no-buildable-window" : "cost>cap");
    if (cheapest) out.cheapestCost = cheapest.metrics.basketCost;
    return out;
  }

  out.width = best.w;
  out.coverProb = best.metrics.coverProb;
  out.grossCost = best.metrics.grossCost;
  out.basketCost = best.metrics.basketCost;
  out.basketEv = best.metrics.ev;
  if (best.sized) {
    out.legs = best.sized.legs;
    out.outlay = best.sized.outlay;
    out.kellyFrac = best.sized.kellyFrac;
    out.fillEv = best.sized.fillEv;
    out.fillCoverProb = best.sized.fillCoverProb;
  } else {
    out.legs = best.legs.map(l => ({ label: l.label, prob: +l.prob.toFixed(4), ask: l.ask, shares: 0, dollars: 0 }));
  }

  // ── 7. Gates — every failure is collected, so a refusal is always explained ──
  if (!(biasFit && biasFit.ready) || (biasFit.n || 0) < p.MIN_BIAS_SAMPLES) reasons.push("bias-uncalibrated");
  if (lad.leadDays < p.MIN_LEAD_DAYS || lad.leadDays > p.MAX_LEAD_DAYS) reasons.push("outside-horizon");
  if (regime === "wide" && p.SKIP_WHEN_WIDE) reasons.push("ensemble-wide");
  if (best.metrics.coverProb < p.MIN_COVER_PROB) reasons.push("cover<min");
  if (disagreement > p.MAX_TVD) reasons.push("model-vs-market-divergent");
  const ev = out.fillEv != null ? out.fillEv : out.basketEv;
  if (ev < p.MIN_BASKET_EV) reasons.push("ev<min");
  if (ev > p.MAX_SANE_EV) reasons.push("ev-implausible");
  for (const l of best.legs) {
    if (l.spreadC != null && l.spreadC > p.MAX_LEG_SPREAD_C) { reasons.push(`spread-wide:${l.label}`); break; }
  }
  for (const l of best.legs) {
    if (l.depthUsd != null && l.depthUsd < p.MIN_LEG_DEPTH_USD) { reasons.push(`thin:${l.label}`); break; }
  }
  if (!(budget > 0)) reasons.push("no-budget");
  else if (!best.sized || best.sized.funded === 0) reasons.push("no-fundable-rung");
  else if (best.sized.funded < p.LADDER_MIN_W) reasons.push(`rungs<${p.LADDER_MIN_W}`);
  if (best.sized && best.sized.unfillable) reasons.push("book-too-thin-to-fill");
  if (best.sized && best.sized.kellyFrac === 0) reasons.push("kelly-zero");

  if (reasons.length === 0) out.signal = `BUY LADDER x${best.sized.funded}`;
  return out;
}

module.exports = { buildLadder, windowsAround, legCost, sizeWindow, fmtBucket };
