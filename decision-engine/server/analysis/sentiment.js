// Sentiment analysis (contract §2.5). Pure functions, no I/O.
//
// Text scoring follows the Loughran & McDonald (2011) philosophy: generic sentiment dictionaries
// (Harvard GI) misclassify finance text ("liability", "tax", "cost", "capital", "vice president"
// are not negative), so we use a finance-specific word list with positive / negative /
// uncertainty categories, plus hand-weighted domain phrases ("beats estimates", "guidance cut",
// "SEC probe", "ETF approval", "exploit"). As in LM, negation is applied to POSITIVE words (flip);
// negated negative words are only weakly positive ("not bad"). Negation scope = 3 tokens within a
// clause. Intensifiers (×1.5) / diminishers (×0.5) scale the next hit within 2 tokens.
//
// Aggregation: Tetlock (2007) — media pessimism predicts short-horizon downward pressure followed
// by partial reversal, so news sentiment is a SHORT-horizon, moderate-confidence signal with
// exponential recency decay (half-life 24h). Social / Fear&Greed are contrarian at extremes
// (Baker-Wurgler style sentiment extremes mean-revert).

const FAMILY = "sentiment";
const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (x, d = 4) => (isNum(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const logistic = (x) => 1 / (1 + Math.exp(-x));

function makeSignal(id, score, confidence, horizon, value, reason) {
  return {
    id, family: FAMILY,
    score: round(isNum(score) ? clamp(score, -1, 1) : 0),
    confidence: round(isNum(confidence) ? clamp(confidence, 0, 1) : 0),
    horizon, value, reason,
  };
}

// ---------------------------------------------------------------------------------------------
// Tokenizer + light stemmer (applied identically to lexicon entries and text)
// ---------------------------------------------------------------------------------------------
function stem(w) {
  if (w.length <= 4) return w;
  if (w.endsWith("ies") && w.length > 5) return w.slice(0, -3) + "y";
  if (w.endsWith("ing") && w.length > 6) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 5) return w.slice(0, -2);
  if (/(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
  return w;
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\bcan't\b/g, "can not").replace(/\bwon't\b/g, "will not").replace(/\bcannot\b/g, "can not")
    .replace(/n't\b/g, " not")
    .replace(/'s\b/g, "")
    .replace(/—|–/g, " , ");
}

// Split into clauses (negation doesn't cross them), then tokens.
function clauses(text) {
  return normalize(text)
    .split(/[.;!?:|]+|\s,\s|\bbut\b|\bhowever\b|\bwhile\b|\balthough\b/)
    .map((c) => c.split(/[^a-z0-9$%&]+/).filter(Boolean))
    .filter((t) => t.length);
}

// ---------------------------------------------------------------------------------------------
// Lexicon. Weights: ~1 ordinary, 1.5 strong, 2–3 severe events. Entries may list inflections;
// all are stemmed into the same key space. Multi-word phrases are matched greedily (longest first).
// ---------------------------------------------------------------------------------------------
const POSITIVE = {
  1: `good great better best nice gain gains gained gaining rise rises rising rose climb climbs climbed climbing advance advances advanced
    up upbeat improve improves improved improving improvement strong stronger strongest strength strengthen
    growth grow grows grew growing expand expands expanded expanding expansion profit profits profitable profitability
    beat beats beating outperform outperforms outperformed outperformance exceed exceeds exceeded exceeding
    positive optimistic optimism confident confidence favorable favourable robust solid healthy resilient resilience
    boost boosts boosted boosting accelerate accelerates accelerated accelerating momentum recover recovers recovered recovery
    rebound rebounds rebounded rebounding upside win wins winning won success successful succeed achieve achieved
    innovative innovation breakthrough opportunity opportunities efficient efficiency lead leads leading leader
    upgrade upgraded upgrades buy overweight outperformer bull bullish rally rallies rallied rallying higher high
    approve approves approved approval launch launches launched partnership partner partners collaboration adopt adopted
    adoption demand inflow inflows accumulate accumulation accumulating dividend dividends buyback buybacks repurchase
    reward rewarding benefit benefits beneficial attractive undervalued cheap bargain premium popular praise praised
    stable stability secure secured safe settle settled settlement resolve resolved resolution cleared exonerated
    upgrade milestone expansionary easing dovish support supported supportive tailwind tailwinds lift lifts lifted
    greenlight greenlit listing listed staking integration integrates integrated mainnet`,
  1.5: `surge surges surged surging soar soars soared soaring jump jumps jumped jumping skyrocket skyrockets skyrocketed
    blowout stellar outstanding exceptional excellent impressive tremendous boom booming
    breakout moon mooning`,
};

const NEGATIVE = {
  1: `bad poor poorly terrible awful horrible dismal grim bleak loss losses lose loses losing lost decline declines declined declining fall falls fell falling drop drops dropped
    dropping down downturn weak weaker weakest weakness weaken weakened slow slows slowed slowing slowdown
    decrease decreases decreased decreasing shrink shrinks shrank shrinking contraction miss misses missed
    missing underperform underperforms underperformed underperformance negative pessimistic pessimism
    concern concerns concerned worry worries worried fear fears feared risk risky threat threats threaten warning warn warns warned
    caution cautious headwind headwinds pressure pressured pressures challenging challenge difficult difficulty
    problem problems trouble troubled struggle struggles struggling fail fails failed failing failure
    cut cuts cutting reduce reduces reduced layoff layoffs downsize downsizing restructuring restructure
    delay delays delayed postpone postponed halt halts halted suspend suspended suspension disappoint disappoints disappointed
    disappointing disappointment downgrade downgraded downgrades sell underweight bear bearish slump slumps slumped
    tumble tumbles tumbled slide slides slid slip slips slipped sink sinks sank lower low worst worse worsen worsening
    deficit overvalued expensive bubble volatile volatility turmoil uncertainty sluggish stagnant stagnation
    dump dumps dumped dumping selloff outflow outflows liquidation liquidations liquidated recall recalls
    lawsuit lawsuits sue sues sued litigation penalty penalties fined violation violations breach breached
    investigation investigate investigating investigated probe probes subpoena allegation allegations alleged
    dispute disputes adverse unfavorable impairment writedown write-off writeoff shortfall hawkish tightening
    inflation recession stagflation default defaults resign resigns resigned resignation ousted departure
    fud rejection rejected reject rejects denied deny denies ban bans banned crackdown sanction sanctions tariff tariffs
    shortage shortages outage outages glitch vulnerability vulnerabilities attack attacked`,
  1.5: `plunge plunges plunged plunging crash crashes crashed crashing collapse collapses collapsed collapsing plummet
    plummets plummeted plummeting tank tanks tanked tanking sinking rout routed capitulation meltdown panic
    crisis crises distress distressed slash slashes slashed scandal misconduct
    manipulation insolvent insolvency illiquid`,
  2: `fraud fraudulent scam scams ponzi embezzlement indictment indicted charged hack hacked hacks hacker hackers exploit
    exploited exploits rugpull bankrupt bankruptcy bankruptcies delisting delist delisted receivership
    liquidating drained depeg depegged restatement restate restated`,
};

const UNCERTAINTY = `might could possibly perhaps uncertain uncertainty unclear unknown unpredictable volatile
  approximately rumor rumors rumored speculation speculative doubt doubts doubtful pending unconfirmed
  reportedly considering weighs weighing mulls mulling exploring tentative ambiguous fluctuate fluctuation`;

// Domain phrases (weights are totals for the phrase). Written in tokenized, space-separated form.
const PHRASES = {
  // earnings / guidance
  "beats estimates": 1.8, "beat estimates": 1.8, "beats expectations": 1.8, "beat expectations": 1.8,
  "tops estimates": 1.8, "top estimates": 1.8, "topped estimates": 1.8, "tops expectations": 1.8, "above estimates": 1.5,
  "above expectations": 1.5, "better than expected": 1.6, "stronger than expected": 1.6, "earnings beat": 1.8,
  "revenue beat": 1.6, "record revenue": 1.8, "record profit": 1.8, "record earnings": 1.8, "record high": 1.5,
  "all time high": 1.5, "ath": 1.2, "raises guidance": 2, "raised guidance": 2, "raise guidance": 2, "guidance raised": 2,
  "boosts guidance": 2, "lifts guidance": 2, "raises outlook": 1.8, "raised outlook": 1.8, "raises forecast": 1.8,
  "hikes dividend": 1.5, "raises dividend": 1.5, "dividend increase": 1.5, "special dividend": 1.2,
  "share buyback": 1.3, "stock buyback": 1.3, "buyback program": 1.3, "share repurchase": 1.3,
  "misses estimates": -1.8, "miss estimates": -1.8, "missed estimates": -1.8, "misses expectations": -1.8,
  "below estimates": -1.5, "below expectations": -1.5, "worse than expected": -1.6, "weaker than expected": -1.6,
  "earnings miss": -1.8, "revenue miss": -1.6, "guidance cut": -2, "cuts guidance": -2, "cut guidance": -2,
  "lowers guidance": -2, "lowered guidance": -2, "guidance lowered": -2, "slashes guidance": -2.3, "weak guidance": -1.8,
  "soft guidance": -1.5, "cuts outlook": -1.8, "lowers outlook": -1.8, "cuts forecast": -1.8, "profit warning": -2,
  "dividend cut": -1.8, "cuts dividend": -1.8, "suspends dividend": -2, "going concern": -2.5,
  "price target raised": 1.3, "raises price target": 1.3, "price target cut": -1.3, "cuts price target": -1.3,
  "lowers price target": -1.3, "upgraded to buy": 1.6, "downgraded to sell": -1.6, "initiated with buy": 1.2,
  "strong buy": 1.5, "top pick": 1.3,
  // corporate events
  "stock split": 0.8, "takeover bid": 1.2, "buyout offer": 1.2, "acquisition offer": 1.0, "merger agreement": 0.6,
  "fda approval": 2, "fda approves": 2, "fda rejects": -2, "complete response letter": -1.8, "clinical hold": -2,
  "trial success": 1.8, "trial failure": -2, "product recall": -1.5, "data breach": -1.8, "short seller": -1.3,
  "short report": -1.5, "accounting irregularities": -2.5, "ceo resigns": -1.3, "ceo steps down": -1.2,
  "ceo ousted": -1.5, "mass layoffs": -1.3, "job cuts": -1.0, "chapter 11": -2.5, "files for bankruptcy": -3,
  "credit downgrade": -1.5, "junk status": -1.5, "rating cut": -1.3, "antitrust lawsuit": -1.5,
  "class action": -1.3, "sec probe": -2, "sec investigation": -2, "sec charges": -2.3, "sec sues": -2.3,
  "sec lawsuit": -2.2, "doj probe": -2, "doj investigation": -2, "ftc lawsuit": -1.6, "wells notice": -2.2,
  "under investigation": -1.8, "criminal charges": -2.3, "insider trading": -2, "delisting notice": -2.3,
  "trading halted": -1.5, "sec approval": 1.8, "wins contract": 1.5, "contract win": 1.5, "wins approval": 1.6,
  // macro
  "rate cut": 1.0, "rate cuts": 1.0, "cuts rates": 1.0, "rate hike": -1.0, "rate hikes": -1.0, "raises rates": -1.0,
  "soft landing": 1.2, "hard landing": -1.5, "hot inflation": -1.3, "cooling inflation": 1.2, "risk off": -1.2, "risk on": 1.0,
  "bear market": -1.5, "bull market": 1.5, "market crash": -2, "sell off": -1.3, "short squeeze": 1.3,
  "profit taking": -0.6, "dead cat bounce": -1.2, "flight to safety": -1.0, "record low": -1.5,
  // crypto
  "etf approval": 2.2, "etf approved": 2.2, "approves etf": 2.2, "spot etf": 1.0, "etf inflows": 1.8, "etf inflow": 1.8,
  "etf outflows": -1.8, "etf outflow": -1.8, "etf rejection": -2, "etf rejected": -2, "etf delay": -1.2,
  "institutional adoption": 1.6, "buys bitcoin": 1.5, "bitcoin treasury": 1.3, "strategic reserve": 1.6,
  "whale accumulation": 1.4, "whales accumulate": 1.4, "whale sell": -1.3, "whales sell": -1.3, "whale dump": -1.5,
  "exchange inflows": -1.0, "exchange outflows": 1.0, "mainnet launch": 1.4, "network upgrade": 1.0, "halving": 0.8,
  "rug pull": -3, "rugpull": -3, "bridge hack": -3, "exchange hack": -3, "smart contract exploit": -3,
  "funds stolen": -2.8, "private key": -0.8, "withdrawals halted": -3, "withdrawals paused": -2.8, "halts withdrawals": -3,
  "pauses withdrawals": -2.8, "frozen withdrawals": -2.8, "stablecoin depeg": -2.8, "loses peg": -2.5,
  "network outage": -1.8, "chain halted": -2.2, "long liquidations": -1.3, "short liquidations": 1.0,
  "liquidation cascade": -2, "regulatory crackdown": -1.8, "sec lawsuit against": -2.2, "exchange collapse": -3,
  "binance listing": 1.3, "coinbase listing": 1.3, "delisted from": -2.3, "to delist": -2.3, "token unlock": -1.0,
  "golden cross": 1.0, "death cross": -1.0, "fear and greed": 0, "extreme fear": -0.8, "extreme greed": 0.5,
};

const NEGATORS = new Set(["not", "no", "never", "without", "neither", "nor", "none", "hardly", "barely", "nobody", "nothing", "unable", "lack", "lacks", "lacked", "fails", "failed", "failing"]);
// Soft negators are also lexicon words: "fails to beat" negates "beat", but "project failed" is itself negative.
const SOFT_NEGATORS = new Set(["fails", "failed", "failing", "lack", "lacks", "lacked"]);
const INTENSIFIERS = new Set(["very", "sharply", "significantly", "strongly", "hugely", "massive", "massively", "huge",
  "extremely", "deeply", "steep", "steeply", "sharp", "big", "biggest", "major", "severe", "severely", "heavy", "heavily",
  "substantially", "dramatically", "dramatic", "record", "sweeping", "unprecedented", "historic", "wildly", "mega"]);
const DIMINISHERS = new Set(["slightly", "slight", "modestly", "modest", "somewhat", "marginally", "marginal", "little", "mildly", "mild", "partly", "partially", "small"]);

function buildLexicon() {
  const words = new Map();
  const addList = (spec, sign) => {
    for (const [w, str] of Object.entries(spec)) {
      for (const raw of str.split(/\s+/).filter(Boolean)) {
        // hyphenated tokens in the list are single-concept tags; split and join so they map to phrases
        if (raw.includes("-")) continue;
        words.set(stem(raw), { w: sign * Number(w), cat: sign > 0 ? "pos" : "neg" });
      }
    }
  };
  addList(POSITIVE, 1);
  addList(NEGATIVE, -1);
  for (const raw of UNCERTAINTY.split(/\s+/).filter(Boolean)) {
    if (raw.includes("-")) continue;
    const k = stem(raw);
    if (!words.has(k)) words.set(k, { w: -0.25, cat: "unc" });
  }
  const phrases = new Map();
  let maxLen = 1;
  for (const [p, w] of Object.entries(PHRASES)) {
    const toks = p.split(/\s+/).map(stem);
    if (toks.length === 1) { words.set(toks[0], { w, cat: w >= 0 ? "pos" : "neg" }); continue; }
    phrases.set(toks.join(" "), w);
    maxLen = Math.max(maxLen, toks.length);
  }
  // Words that are neutral in finance despite generic-negative connotations (LM 2011).
  for (const neutral of ["tax", "cost", "costs", "liability", "liabilities", "capital", "vice", "board", "crude", "cancer", "mine", "share", "shares", "stock", "estimate", "estimates", "outlook", "guidance", "rate", "rates", "fed", "sec", "etf"]) {
    words.delete(stem(neutral));
  }
  return { words, phrases, maxLen };
}
const LEX = buildLexicon();

// Score one text. Returns { score ∈ [-1,1], hits, pos, neg, unc, severe, terms }.
function scoreText(text) {
  const res = { score: 0, hits: 0, pos: 0, neg: 0, unc: 0, severe: false, terms: [] };
  if (!text || typeof text !== "string") return res;
  let sum = 0;
  for (const raw of clauses(text)) {
    const toks = raw.map(stem);
    let lastNeg = -99, lastMod = -99, mod = 1;
    for (let i = 0; i < toks.length; ) {
      // Longest phrase first.
      let matched = null, len = 0;
      for (let L = Math.min(LEX.maxLen, toks.length - i); L >= 2; L--) {
        const key = toks.slice(i, i + L).join(" ");
        if (LEX.phrases.has(key)) { matched = { w: LEX.phrases.get(key), cat: LEX.phrases.get(key) >= 0 ? "pos" : "neg" }; len = L; break; }
      }
      const t = toks[i];
      if (!matched) {
        if (NEGATORS.has(raw[i])) {
          lastNeg = i;
          if (!SOFT_NEGATORS.has(raw[i]) || raw[i + 1] === "to") { i++; continue; }
        }
        if (INTENSIFIERS.has(raw[i])) { lastMod = i; mod = 1.5; }
        else if (DIMINISHERS.has(raw[i])) { lastMod = i; mod = 0.5; }
        const e = LEX.words.get(t);
        if (!e || e.w === 0) { i++; continue; }
        matched = e; len = 1;
      }
      if (matched.w === 0) { i += len; continue; }
      let w = matched.w;
      if (i - lastMod <= 2 && lastMod !== i) w *= mod;
      const negated = lastNeg < i && i - lastNeg <= 3 && matched.cat !== "unc";
      if (negated) w = w > 0 ? -w : -0.5 * w; // LM: negated positive flips; negated negative is only weakly positive
      sum += w;
      res.hits++;
      if (matched.w <= -2 && !negated) res.severe = true; // severe NEGATIVE event term
      if (matched.cat === "unc") res.unc++; else if (w > 0) res.pos++; else res.neg++;
      if (res.terms.length < 8) res.terms.push((negated ? "¬" : "") + raw.slice(i, i + len).join(" "));
      i += len;
    }
  }
  // VADER-style normalisation: s / sqrt(s² + α) keeps a single ordinary hit at ~±0.45.
  res.score = res.hits ? round(clamp(sum / Math.sqrt(sum * sum + 4), -1, 1)) : 0;
  return res;
}

// ---------------------------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------------------------
const TOP_SOURCES = /reuters|bloomberg|wall street journal|wsj|financial times|\bft\b|cnbc|associated press|\bap\b|barron|marketwatch|coindesk|the block|dow jones/i;

function toMs(ts) {
  if (ts == null) return null;
  if (typeof ts === "number") return ts < 1e12 ? ts * 1000 : ts;
  const p = Date.parse(ts);
  return isNum(p) ? p : null;
}

function newsSignals(headlines, opts = {}) {
  if (!Array.isArray(headlines) || !headlines.length) return [];
  const now = isNum(opts.now) ? opts.now : toMs(opts.now) || Date.now();
  const halfLifeH = isNum(opts.halfLifeHours) ? opts.halfLifeHours : 24;
  const seen = new Set();
  const items = [];
  for (const h of headlines) {
    if (!h || typeof h.title !== "string") continue;
    // Google News titles end with " - Source"; strip for dedupe + scoring.
    const title = h.title.replace(/\s+-\s+[^-]{2,60}$/, "").trim();
    const key = title.toLowerCase().replace(/[^a-z0-9 ]/g, "").slice(0, 70);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const t = toMs(h.ts);
    const ageH = isNum(t) ? Math.max(0, (now - t) / 3.6e6) : 48; // unknown age → treat as 2 days old
    const s = scoreText(title);
    const srcW = TOP_SOURCES.test(`${h.source || ""} ${h.title}`) ? 1.25 : 1;
    items.push({ title, ageH, s, w: Math.pow(0.5, ageH / halfLifeH) * srcW });
  }
  if (!items.length) return [];
  const out = [];

  const scored = items.filter((x) => x.s.hits > 0);
  let agg = 0, sw = 0, swAbs = 0, sw2 = 0;
  for (const x of scored) { agg += x.w * x.s.score; sw += x.w; swAbs += x.w * Math.abs(x.s.score); sw2 += x.w * x.w; }
  const mean = sw > 0 ? agg / sw : 0;
  const effN = sw2 > 0 ? (sw * sw) / sw2 : 0;               // Kish effective sample size
  const agreement = swAbs > 0 ? Math.abs(agg) / swAbs : 0;  // 1 = all same sign
  if (scored.length) {
    const countF = 1 - Math.exp(-effN / 5);
    const freshF = clamp(sw / Math.max(1, scored.length) * 2, 0.2, 1); // mostly-old news → less confidence
    const conf = 0.6 * countF * (0.35 + 0.65 * agreement) * freshF;
    const nPos = scored.filter((x) => x.s.score > 0).length, nNeg = scored.filter((x) => x.s.score < 0).length;
    const top = scored.slice().sort((a, b) => b.w * Math.abs(b.s.score) - a.w * Math.abs(a.s.score))[0];
    out.push(makeSignal("sent.news.aggregate", Math.tanh(1.6 * mean), conf, "swing",
      { mean: round(mean), n: items.length, scored: scored.length, pos: nPos, neg: nNeg, effN: round(effN, 2), agreement: round(agreement, 3) },
      `News tone ${mean >= 0 ? "+" : ""}${mean.toFixed(2)} over ${scored.length}/${items.length} opinionated headlines (${nPos} pos / ${nNeg} neg, 24h half-life); top: "${top.title.slice(0, 80)}"`));
  }

  // Event risk: a severe (hack / bankruptcy / SEC charges) headline in the last 48h dominates.
  const severe = items.filter((x) => x.s.severe && x.s.score < -0.4 && x.ageH <= 48).sort((a, b) => a.ageH - b.ageH);
  if (severe.length) {
    const x = severe[0];
    const decay = Math.pow(0.5, x.ageH / 24);
    out.push(makeSignal("sent.news.event_risk", -0.9 * decay * Math.min(1, 0.7 + 0.15 * severe.length), 0.35 + 0.3 * decay, "swing",
      { count: severe.length, ageHours: round(x.ageH, 1), terms: x.s.terms.slice(0, 3) },
      `${severe.length} severe negative headline(s) in 48h, latest ${x.ageH.toFixed(0)}h ago: "${x.title.slice(0, 80)}"`));
  }

  // Attention spike: last-24h count vs the per-day rate over the prior 6 days. Attention amplifies
  // the prevailing tone short-term (Barber & Odean 2008; Da, Engelberg & Gao 2011).
  const recent = items.filter((x) => x.ageH <= 24).length;
  const prior = items.filter((x) => x.ageH > 24 && x.ageH <= 168).length;
  const oldest = Math.max(...items.map((x) => x.ageH));
  const priorDays = clamp((Math.min(oldest, 168) - 24) / 24, 1, 6);
  if (items.length >= 5 && oldest > 30) {
    const baseline = prior / priorDays;
    const ratio = (recent + 1) / (baseline + 1);
    const spike = Math.max(0, Math.log(ratio));
    const dir = Math.abs(mean) > 0.05 ? Math.sign(mean) : 0;
    out.push(makeSignal("sent.news.volume_spike", dir * 0.5 * Math.tanh(spike), dir ? 0.3 * Math.tanh(spike) : 0, "intraday",
      { recent24h: recent, baselinePerDay: round(baseline, 2), ratio: round(ratio, 2) },
      `${recent} headlines in 24h vs ${baseline.toFixed(1)}/day baseline (×${ratio.toFixed(1)} attention)${dir ? `, amplifying ${dir > 0 ? "positive" : "negative"} tone` : ", tone neutral"}`));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Social (StockTwits-like). Retail bull share runs structurally high (~65–75%), so we centre at
// 0.70: follow the crowd mildly in the normal band, fade it at euphoric (>~90%) or despairing
// (<~35%) extremes.
// ---------------------------------------------------------------------------------------------
function socialSignals(social) {
  if (!social || typeof social !== "object") return [];
  const out = [];
  const bull = isNum(social.bullish) ? Math.max(0, social.bullish) : 0;
  const bear = isNum(social.bearish) ? Math.max(0, social.bearish) : 0;
  const labeled = bull + bear;
  if (labeled > 0) {
    const b = bull / labeled;
    const follow = 0.3 * Math.tanh((b - 0.7) / 0.1);
    const euphoria = 0.6 * logistic((b - 0.92) / 0.02);
    const despair = 0.4 * logistic((0.35 - b) / 0.03);
    const score = follow - euphoria + despair;
    const extreme = euphoria > 0.3 ? "euphoric — contrarian bearish" : despair > 0.2 ? "despairing — contrarian bullish" : "normal band — mild trend-follow";
    out.push(makeSignal("sent.social.bull_share", score, 0.35 * (1 - Math.exp(-labeled / 30)), "intraday",
      { bullShare: round(b, 3), bullish: bull, bearish: bear, total: isNum(social.total) ? social.total : null },
      `${(b * 100).toFixed(0)}% bullish of ${labeled} tagged messages (${extreme})`));
  }
  if (Array.isArray(social.messages) && social.messages.length) {
    let s = 0, n = 0;
    for (const m of social.messages) {
      const body = typeof m === "string" ? m : m && (m.body || m.text);
      const r = scoreText(body);
      if (r.hits) { s += r.score; n++; }
    }
    if (n) {
      const mean = s / n;
      out.push(makeSignal("sent.social.text", 0.6 * Math.tanh(1.5 * mean), 0.25 * (1 - Math.exp(-n / 15)), "intraday",
        { mean: round(mean), n, messages: social.messages.length }, `Social message tone ${mean >= 0 ? "+" : ""}${mean.toFixed(2)} across ${n} opinionated messages`));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Crypto Fear & Greed (alternative.me) — contrarian at extremes, flat in the middle.
// score = −0.65·tanh(((v−50)/25)³): v=10 → +0.65, v=90 → −0.65, v=40 → +0.04.
// ---------------------------------------------------------------------------------------------
function fearGreedSignal(fg) {
  const v = fg && isNum(Number(fg.value)) && fg.value !== null && fg.value !== "" ? Number(fg.value) : null;
  if (!isNum(v)) return makeSignal("sent.feargreed.contrarian", 0, 0, "swing", { value: null }, "Fear & Greed index unavailable");
  const x = (clamp(v, 0, 100) - 50) / 25;
  const t = Math.tanh(x * x * x);
  let score = -0.65 * t;
  let conf = 0.2 + 0.3 * Math.abs(t);
  const hist = Array.isArray(fg.history) ? fg.history.map((h) => Number(h && (h.v ?? h.value))).filter(isNum) : [];
  let avg7 = null;
  if (hist.length >= 7) {
    // history newest-first or oldest-first is unknown → average of 7 obs nearest the current reading is robust enough
    const recentSlice = Math.abs(hist[0] - v) <= Math.abs(hist[hist.length - 1] - v) ? hist.slice(0, 7) : hist.slice(-7);
    avg7 = recentSlice.reduce((a, b) => a + b, 0) / recentSlice.length;
    if ((avg7 - 50) * (v - 50) > 0 && Math.abs(avg7 - 50) > 20) conf += 0.05; // persistent extreme
  }
  const cls = fg.classification || (v <= 25 ? "Extreme Fear" : v < 45 ? "Fear" : v <= 55 ? "Neutral" : v < 75 ? "Greed" : "Extreme Greed");
  return makeSignal("sent.feargreed.contrarian", score, conf, "swing", { value: v, classification: cls, avg7: round(avg7, 1) },
    `Fear & Greed ${v} (${cls})${Math.abs(t) > 0.3 ? ` — contrarian ${score > 0 ? "bullish" : "bearish"}` : " — no extreme, little signal"}`);
}

module.exports = { scoreText, newsSignals, socialSignals, fearGreedSignal, _stem: stem, _lexiconSize: () => LEX.words.size + LEX.phrases.size };
