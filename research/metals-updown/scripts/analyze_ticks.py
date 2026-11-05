"""Tick-level analysis of recorder output (research/metals-updown/recorder).

For every recorded window, second by second:
  * Chainlink-implied P(Up) = Phi(ln(S/priceToBeat) / (sigma*sqrt(tau))), S = Chainlink (RTDS) price,
    sigma = per-second stdev of Chainlink 1s log returns over the trailing 10 minutes.
  * Executable asks on the Up and Down books (best ask + size), rebuilt from CLOB book/price_change events.
  * "Take" opportunities: model prob - ask - taker fee >= margin, with the $ size actually on the ask.
Also reports: Chainlink(RTDS) vs Gamma priceToBeat/finalPrice agreement, and quote reaction lag.

usage: python3 analyze_ticks.py <recorder data dir> [--margin 0.03] [--min-p 0.8] [--basis-bps 2.5]
"""
import bisect
import collections
import glob
import json
import math
import os
import statistics as st
import sys
import urllib.request

FEE = 0.07
Phi = lambda z: 0.5 * (1 + math.erf(z / math.sqrt(2)))


def load(d):
    cl = collections.defaultdict(list)          # sym -> [(ts_s, price)]
    wins = {}                                   # (asset, start) -> dict
    ev = collections.defaultdict(list)          # asset_id -> [(ts_ms, kind, payload)]
    for f in sorted(glob.glob(os.path.join(d, "*.jsonl"))):
        for line in open(f):
            try:
                m = json.loads(line)
            except ValueError:
                continue
            s = m["src"]
            if s == "cl" and m.get("v") is not None and m.get("ts"):
                cl[m["sym"]].append((m["ts"] // 1000, float(m["v"])))
            elif s == "win":
                k = (m["asset"], m["start"])
                w = wins.setdefault(k, dict(m))
                if m.get("meta"):
                    w["meta"] = m["meta"]
            elif s == "clob":
                et = m.get("event_type")
                if et == "book":
                    ev[m["asset_id"]].append((int(m["timestamp"]), "book", m))
                elif et == "price_change":
                    for c in m.get("price_changes", []):
                        ev[c["asset_id"]].append((int(m["timestamp"]), "pc", c))
    for sym in cl:
        cl[sym] = sorted(set(cl[sym]))
    return cl, wins, ev


class Book:
    """Replays book snapshots + level updates for one token; query best ask/bid at a time."""

    def __init__(self, events):
        self.snaps = []   # (ts_ms, best_bid, bid_sz, best_ask, ask_sz)
        bids, asks = {}, {}
        for ts, kind, p in sorted(events, key=lambda x: x[0]):
            if kind == "book":
                bids = {float(l["price"]): float(l["size"]) for l in p.get("bids", [])}
                asks = {float(l["price"]): float(l["size"]) for l in p.get("asks", [])}
            else:
                side = bids if p["side"] == "BUY" else asks
                px, sz = float(p["price"]), float(p["size"])
                if sz == 0:
                    side.pop(px, None)
                else:
                    side[px] = sz
            bb = max(bids) if bids else None
            ba = min(asks) if asks else None
            self.snaps.append((ts, bb, bids.get(bb, 0) if bb else 0, ba, asks.get(ba, 0) if ba else 0))
        self.ts = [s[0] for s in self.snaps]

    def at(self, ts_ms):
        i = bisect.bisect_right(self.ts, ts_ms) - 1
        return self.snaps[i] if i >= 0 else None


def price_at(series, t):
    ts = [x[0] for x in series]
    i = bisect.bisect_right(ts, t) - 1
    return series[i][1] if i >= 0 else None


def sigma_at(series, t, lookback=600):
    ts = [x[0] for x in series]
    lo, hi = bisect.bisect_left(ts, t - lookback), bisect.bisect_right(ts, t)
    pts = series[lo:hi]
    rets = [math.log(b[1] / a[1]) / max(b[0] - a[0], 1) ** 0.5 for a, b in zip(pts, pts[1:]) if b[0] > a[0]]
    return st.pstdev(rets) if len(rets) > 60 else None


def gamma_meta(slug):
    try:
        req = urllib.request.Request(f"https://gamma-api.polymarket.com/events/slug/{slug}",
                                     headers={"User-Agent": "research-script/1.0"})
        e = json.load(urllib.request.urlopen(req, timeout=15))
        m = e["markets"][0]
        return e.get("eventMetadata") or {}, json.loads(m.get("outcomePrices") or "[]"), m.get("closed")
    except Exception:
        return {}, [], None


def main():
    d = sys.argv[1]
    margin = float(sys.argv[sys.argv.index("--margin") + 1]) if "--margin" in sys.argv else 0.03
    cl, wins, ev = load(d)
    sym = {"XAU": "xauusd", "XAG": "xagusd"}
    print(f"Chainlink points: " + ", ".join(f"{k}={len(v)}" for k, v in cl.items()))

    # 1) RTDS vs Gamma settlement values
    print("\n== RTDS Chainlink vs Gamma priceToBeat / finalPrice")
    resolved, ptbs = {}, {}
    for (a, t0), w in sorted(wins.items()):
        meta, op, closed = gamma_meta(w["slug"])
        s = cl.get(sym[a], [])
        if not s or s[0][0] > t0 or s[-1][0] < t0:
            continue
        o = price_at(s, t0)
        f = price_at(s, t0 + 900) if s[-1][0] >= t0 + 900 else None
        ptb, fin = meta.get("priceToBeat"), meta.get("finalPrice")
        line = f"  {a} {w['slug']}: priceToBeat {ptb} vs RTDS@t0 {o}"
        if fin is not None and f is not None:
            line += f" | finalPrice {fin} vs RTDS@end {f}"
        print(line)
        if op and closed:
            resolved[(a, t0)] = 1 if op[0] == "1" else 0
        if ptb is not None:
            ptbs[(a, t0)] = float(ptb)

    # 2) Per-second take opportunities vs executable asks
    # RTDS matches settlement only to within ~0-3 s, i.e. a few bps at the boundary: model that as basis noise.
    min_p = float(sys.argv[sys.argv.index("--min-p") + 1]) if "--min-p" in sys.argv else 0.0
    basis = float(sys.argv[sys.argv.index("--basis-bps") + 1]) / 1e4 if "--basis-bps" in sys.argv else 2.5e-4
    print(f"\n== Take opportunities (model - ask - fee >= {margin:.2f}, basis noise {basis * 1e4:.1f} bps, model p >= {min_p:.2f}), by seconds-to-close")
    buckets = collections.defaultdict(lambda: [0, 0.0, 0.0, set()])   # n_sec, $avail, pnl_if_filled, windows
    for (a, t0), w in sorted(wins.items()):
        if (a, t0) not in resolved or (a, t0) not in ptbs:
            continue
        s = cl[sym[a]]
        ptb = ptbs[(a, t0)]
        s_close = price_at(s, t0 + 900)
        up_book, dn_book = Book(ev.get(w["up"], [])), Book(ev.get(w["down"], []))
        up_won = resolved[(a, t0)]
        taken = set()
        for t in range(t0 + 60, t0 + 960):                # include the first minute after close
            tau = t0 + 900 - t
            if tau > 0:
                S, sig = price_at(s, t), sigma_at(s, t)
                if S is None or not sig:
                    continue
                pU = Phi(math.log(S / ptb) / math.sqrt(sig * sig * tau + basis * basis))
            else:                                          # outcome fixed; only the basis is unknown
                if s_close is None:
                    continue
                pU = Phi(math.log(s_close / ptb) / basis)
            for side, book, p, won in (("UP", up_book, pU, up_won), ("DOWN", dn_book, 1 - pU, 1 - up_won)):
                snap = book.at(t * 1000)
                if not snap or snap[3] is None or not (0 < snap[3] < 1):
                    continue
                ask, asz = snap[3], snap[4]
                if p >= min_p and p - ask - FEE * ask * (1 - ask) >= margin and (a, t0, side, ask) not in taken:
                    taken.add((a, t0, side, ask))       # count each resting ask level once
                    usd = ask * asz
                    pnl = asz * (won - ask) - asz * FEE * ask * (1 - ask)
                    tb = "after-close" if tau <= 0 else "0-30s" if tau <= 30 else "30-60s" if tau <= 60 else "60-180s" if tau <= 180 else "180-420s" if tau <= 420 else "420s+"
                    for k in ((a, tb), (a, "ALL")):
                        b = buckets[k]; b[0] += 1; b[1] += usd; b[2] += pnl; b[3].add(t0)
    for k in sorted(buckets):
        n, usd, pnl, ws = buckets[k]
        print(f"  {k[0]} {k[1]:9s}: {n:4d} ask levels in {len(ws):3d} windows, ${usd:7,.0f} available, "
              f"P&L if all filled ${pnl:+7,.0f} ({pnl / max(usd, 1e-9):+.1%})")

    # 3) Quote reaction lag: after a >=3-sigma Chainlink second, how long until the Up best ask/bid changes?
    print("\n== Quote reaction to large Chainlink moves (|1s ret| >= 3 sigma)")
    for a in ("XAU", "XAG"):
        lags = []
        s = cl.get(sym[a], [])
        for (aa, t0), w in wins.items():
            if aa != a:
                continue
            book = Book(ev.get(w["up"], []))
            for (t1, p1), (t2, p2) in zip(s, s[1:]):
                if not (t0 + 30 <= t2 <= t0 + 870) or t2 - t1 != 1:
                    continue
                sig = sigma_at(s, t1)
                if not sig or abs(math.log(p2 / p1)) < 3 * sig:
                    continue
                before = book.at(t2 * 1000)
                j = bisect.bisect_right(book.ts, t2 * 1000)
                lag = None
                for snap in book.snaps[j:j + 400]:
                    if before and (snap[1], snap[3]) != (before[1], before[3]):
                        lag = snap[0] / 1000 - t2
                        break
                lags.append(lag)
        got = sorted(x for x in lags if x is not None)
        if got:
            print(f"  {a}: {len(lags)} moves; quotes changed within 1s {sum(x <= 1 for x in got) / len(lags):.0%}, "
                  f"within 3s {sum(x <= 3 for x in got) / len(lags):.0%}; median lag {got[len(got) // 2]:.1f}s; "
                  f"no change before next move {sum(x is None for x in lags)}")
        else:
            print(f"  {a}: no qualifying moves recorded")


if __name__ == "__main__":
    main()
