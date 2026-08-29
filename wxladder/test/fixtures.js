// Deterministic, network-free fixtures shared by the tests.
const cfg = require("../server/config");

// An 11-bucket Polymarket-shaped ladder. `asks` are scaled to the requested overround so a
// test can exercise both a fair book and the vig a real ladder actually quotes.
function makeLadder({ city = "Singapore", kind = "high", date = "2026-08-25", leadDays = 1,
                      peakDeg = 30, overround = 1.06, spread = 0.02, minShares = 5 } = {}) {
  const shape = [0.005, 0.012, 0.03, 0.07, 0.15, 0.27, 0.24, 0.13, 0.055, 0.02, 0.008];
  const degs = Array.from({ length: 11 }, (_, i) => peakDeg - 5 + i);
  const total = shape.reduce((a, b) => a + b, 0);
  const buckets = degs.map((d, i) => {
    const ask = +(shape[i] * overround / total).toFixed(4);
    const type = i === 0 ? "tail-low" : i === 10 ? "tail-high" : "exact";
    return {
      lo: type === "tail-low" ? -Infinity : d,
      hi: type === "tail-high" ? Infinity : d,
      deg: d, type,
      label: type === "tail-low" ? `${d}°C or below` : type === "tail-high" ? `${d}°C or higher` : `${d}°C`,
      marketId: `m${d}`, yesToken: `t${d}`, noToken: `n${d}`,
      ask, bid: Math.max(0.001, +(ask - spread).toFixed(4)),
      tick: 0.01, minShares, acceptingOrders: true, liquidity: 2000,
      fee: { rate: 0.05, exp: 1, source: "market" },
    };
  });
  return {
    eventId: "e1", slug: `highest-temperature-in-${city.toLowerCase()}-on-august-25-2026`,
    title: `Highest temperature in ${city} on August 25?`, city, kind,
    station: cfg.UNIVERSE[city], date, endDate: `${date}T12:00:00Z`, negRisk: true, unit: "C",
    buckets, overround: +buckets.reduce((s, b) => s + b.ask, 0).toFixed(4), leadDays,
  };
}

const forecast = (rawCenter, ensSd = 1.05) => ({
  rawCenter, ensSd, ensMean: rawCenter, detMean: rawCenter, nMembers: 120, members: [],
});
const biasFit = (bias = 0, rmse = 1.0, n = 22) => ({ ready: true, n, bias, rmse, sd: rmse, weightedN: n });
const spreadHist = (n = 20, base = 1.0) => Array.from({ length: n }, (_, i) => base + 0.01 * i);

// A Gamma-shaped raw event, for exercising poly.toLadder end to end.
function gammaEvent({ city = "Singapore", kind = "Highest", date = "august-25-2026", peakDeg = 30 } = {}) {
  const lad = makeLadder({ city, peakDeg });
  return {
    id: "42", slug: `${kind.toLowerCase()}-temperature-in-${city.toLowerCase().replace(/ /g, "-")}-on-${date}`,
    title: `${kind} temperature in ${city} on August 25?`,
    endDate: "2026-08-25T12:00:00Z", negRisk: true,
    markets: lad.buckets.map((b, i) => ({
      conditionId: b.marketId, groupItemTitle: b.label, groupItemThreshold: i,
      question: `Will the ${kind.toLowerCase()} temperature in ${city} be ${b.label} on August 25?`,
      clobTokenIds: JSON.stringify([b.yesToken, b.noToken]),
      outcomes: JSON.stringify(["Yes", "No"]),
      outcomePrices: JSON.stringify([String(b.ask), String(1 - b.ask)]),
      bestBid: b.bid, bestAsk: b.ask, orderPriceMinTickSize: 0.01, orderMinSize: 5,
      acceptingOrders: true, liquidityNum: 2000, active: true, archived: false,
      feesEnabled: true, feeSchedule: { exponent: 1, rate: 0.05, takerOnly: true },
    })),
  };
}

module.exports = { makeLadder, forecast, biasFit, spreadHist, gammaEvent };
