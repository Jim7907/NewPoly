import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { C, MONO, Panel, Stat, Tag, Btn, Table, Loading, ErrorBox, Empty, MeterBar, inputStyle,
  num, pct, fx, snum, spct, ago, dt, dday, toMs, arr, obj, pick, clamp, divColor, colorSign } from "./ui.jsx";
import { useMeasure } from "./charts.jsx";

// ─── Networking: /api/lab/* may not exist yet ────────────────────────────────
// A missing GET route returns 404, or the SPA fallback (index.html, 200). Both are
// read as "no data yet" (null) and not as an error.
export async function softGet(path) {
  const r = await fetch(path, { headers: { Accept: "application/json" } });
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  let data = null;
  if (ct.includes("json")) { try { data = await r.json(); } catch { data = null; } }
  if (r.status === 404 || r.status === 204) return null;
  if (!r.ok) throw new Error((data && (data.error || data.message)) || `HTTP ${r.status}`);
  return ct.includes("json") ? data : null;
}
export async function softPost(path, body) {
  let r;
  try { r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body ?? {}) }); }
  catch (e) { return { ok: false, msg: e?.message || "network error" }; }
  const ct = (r.headers.get("content-type") || "").toLowerCase();
  let data = null;
  if (ct.includes("json")) { try { data = await r.json(); } catch { data = null; } }
  const emsg = data && (data.error || data.message);
  if ((r.status === 404 || r.status === 405) && !emsg) return { ok: false, missing: true, msg: "endpoint not available on this server yet" };
  if (r.ok && !ct.includes("json")) return { ok: false, missing: true, msg: "endpoint not available on this server yet" };
  if (!r.ok) return { ok: false, status: r.status, data, msg: emsg || `HTTP ${r.status}` };
  if (data && data.ok === false) return { ok: false, data, msg: emsg || "refused" };
  return { ok: true, data };
}
// Loader: { data (undefined until first load, null when missing), err, loading, reload }.
export function useSoft(path, { interval } = {}) {
  const [st, set] = useState({ path, data: undefined, err: null, loading: true });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    const run = (quiet) => {
      if (!quiet) set(s => ({ path, data: s.path === path ? s.data : undefined, err: null, loading: true }));
      softGet(path).then(d => alive && set({ path, data: d, err: null, loading: false }),
        e => alive && set(s => ({ path, data: s.path === path ? s.data : undefined, err: e?.message || String(e), loading: false })));
    };
    run(false);
    const t = interval ? setInterval(() => run(true), interval) : null;
    return () => { alive = false; if (t) clearInterval(t); };
  }, [path, interval, nonce]);
  const reload = useCallback(() => setNonce(n => n + 1), []);
  return { data: st.path === path ? st.data : undefined, err: st.err, loading: st.loading, reload };
}

// ─── Formatting / normalization helpers ──────────────────────────────────────
export const HORIZONS = [["intraday", "INTRADAY"], ["swing", "SWING"], ["position", "POSITION"]];
const HZ = HORIZONS.map(h => h[0]);
const KINDS = ["stacker", "meta", "mask", "thresholds"];
const TARGETS = ["y", "yEx", "tbLong"];
// Fixed per target (validated for CVD separation and contrast on the dark panel surface).
export const TARGET_COLOR = { y: "#0284c7", yEx: "#d97706", tbLong: "#8b5cf6" };
const SLOTS = [
  { key: "stacker:y", kind: "stacker", target: "y", title: "Stacker · y", sub: "P(up), absolute direction" },
  { key: "stacker:yEx", kind: "stacker", target: "yEx", title: "Stacker · yEx", sub: "P(outperform benchmark)" },
  { key: "stacker:tbLong", kind: "stacker", target: "tbLong", title: "Stacker · tbLong", sub: "P(long bracket hits target)" },
  { key: "meta", kind: "meta", title: "Meta-labeler", sub: "P(trade succeeds)" },
  { key: "mask", kind: "mask", title: "Signal mask", sub: "confidence multipliers" },
  { key: "thresholds", kind: "thresholds", title: "Thresholds", sub: "tuned action gates" },
];
const LN2 = Math.log(2);

export const fmtDur = (ms) => {
  const n = num(ms); if (n == null) return "—";
  const s = Math.round(Math.abs(n) / 1000);
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60); if (m < 60) return m + "m " + (s % 60) + "s";
  const h = Math.floor(m / 60); if (h < 48) return h + "h " + (m % 60) + "m";
  return Math.floor(h / 24) + "d " + (h % 24) + "h";
};
const until = (t, now) => { const ms = toMs(t); if (ms == null) return "—"; const d = ms - now; return d <= 0 ? "due now" : "in " + fmtDur(d); };
const vlabel = (v) => { if (v == null || v === "") return "—"; const s = String(v); const t = s.length > 10 ? s.slice(0, 10) + "…" : s; return /^v/i.test(t) ? t : "v" + t; };
const fmtAny = (k, v) => {
  const n = num(v); if (n == null) return v == null ? "—" : typeof v === "object" ? "…" : String(v);
  if (Number.isInteger(n) && Math.abs(n) >= 2) return n.toLocaleString("en-US");
  if (/rate|precision|coverage|activity|pct|frac|hit/i.test(k) && Math.abs(n) <= 1) return pct(n, 1);
  return Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(3);
};

function splitKey(k) {
  const out = {};
  for (const part of String(k).split(/[:._/|\s-]+/)) {
    if (KINDS.includes(part)) out.kind = part;
    else if (TARGETS.includes(part)) out.target = part;
    else if (HZ.includes(part)) out.horizon = part;
  }
  return out;
}
const isEntry = (o) => o && typeof o === "object" && !Array.isArray(o) && (o.version != null || o.metrics != null || o.promotedAt != null || o.trainedThrough != null);
// Registry payloads may be arrays, or maps keyed by horizon / kind / "stacker:yEx". Flatten to entries.
export function flattenEntries(x, hint = {}, out = [], depth = 0) {
  if (!x || typeof x !== "object" || depth > 5) return out;
  if (Array.isArray(x)) { for (const e of x) flattenEntries(e, hint, out, depth + 1); return out; }
  if (isEntry(x)) {
    const kk = splitKey(x.kind || "");
    out.push({ ...x, kind: kk.kind ?? hint.kind ?? x.kind, target: x.target ?? kk.target ?? hint.target, horizon: x.horizon ?? hint.horizon });
    return out;
  }
  for (const [k, v] of Object.entries(x)) flattenEntries(v, { ...hint, ...splitKey(k) }, out, depth + 1);
  return out;
}
const slotKey = (e) => (e?.kind === "stacker" ? `stacker:${TARGETS.includes(e.target) ? e.target : "y"}` : KINDS.includes(e?.kind) ? e.kind : null);
const byHorizon = (list, horizon) => (list.some(e => e.horizon) ? list.filter(e => !e.horizon || e.horizon === horizon) : list);
const vnum = (e) => num(e?.version) ?? toMs(e?.promotedAt ?? e?.ts) ?? 0;
const wasPromoted = (e) => e?.promoted === true || e?.promotedAt != null || e?.status === "champion";

function resolveChampions(status, regEntries, horizon) {
  const s = obj(status);
  const hz = obj(obj(s.horizons)[horizon] ?? obj(s.byHorizon)[horizon]);
  const list = byHorizon(flattenEntries(hz.champions ?? s.champions ?? null), horizon);
  const map = {};
  const put = (e) => { const k = slotKey(e); if (!k) return; if (!map[k] || vnum(e) >= vnum(map[k])) map[k] = e; };
  for (const e of list) if (!e.status || e.status === "champion") put(e);
  for (const e of regEntries) if (e.status === "champion" && !map[slotKey(e)]) put(e);
  return map;
}

const LEVEL_RANK = { ok: 0, warn: 1, drift: 2 };
const LEVEL_COLOR = { ok: C.up, warn: C.amber, drift: C.down };
function resolveDrift(status, horizon) {
  const s = obj(status);
  const hz = obj(obj(s.horizons)[horizon] ?? obj(s.byHorizon)[horizon]);
  let d = hz.drift ?? s.drift;
  if (d && typeof d === "object" && d[horizon] && typeof d[horizon] === "object") d = d[horizon];
  if (typeof d === "string") d = { level: d };
  d = obj(d);
  const isMon = (v) => v && typeof v === "object" && (v.level != null || v.stat != null || v.drift != null);
  const monitors = isMon(d) ? [{ name: d.name || d.metric || "drift", ...d }]
    : Object.entries(d).filter(([, v]) => isMon(v)).map(([k, v]) => ({ name: k, ...v }));
  const lvl = (m) => (m.level ? String(m.level).toLowerCase() : m.drift === true ? "drift" : m.drift === false ? "ok" : null);
  let level = null;
  for (const m of monitors) { const l = lvl(m); if (l && (level == null || (LEVEL_RANK[l] ?? -1) > (LEVEL_RANK[level] ?? -1))) level = l; }
  let dr = hz.deRisk ?? hz.derisk ?? s.deRisk ?? s.derisk ?? d.deRisk ?? d.derisk;
  if (dr && typeof dr === "object" && dr[horizon] != null) dr = dr[horizon];
  const drObj = dr === true ? { active: true } : obj(dr);
  const active = drObj.active === true || (drObj.active == null && toMs(drObj.until) != null && toMs(drObj.until) > Date.now());
  return { level, monitors: monitors.map(m => ({ ...m, _level: lvl(m) })), deRisk: { ...drObj, active } };
}
const isRunning = (s) => { const o = obj(s); return o.running === true || /^(running|busy|training|in[-_ ]?progress)$/i.test(String(o.state ?? o.status ?? "")); };

// Metrics accessors (every field optional)
const Mx = (e) => obj(e?.metrics);
const mLL = (m) => num(pick(m, "logloss", "logLoss", "ll"));
const mLLb = (m) => num(pick(m, "loglossBaseline", "logLossBaseline", "llBaseline")) ?? num(obj(m.baseline).logloss);
const mAUC = (m) => num(m.auc);
const mAUCb = (m) => num(m.aucBaseline) ?? num(obj(m.baseline).auc);
const mBr = (m) => num(m.brier);
const mBrb = (m) => num(m.brierBaseline) ?? num(obj(m.baseline).brier);
const mDmP = (m) => num(obj(m.dm).p ?? m.dmP ?? m.dm_p);
const mDmS = (m) => num(obj(m.dm).stat ?? m.dmStat);

export function pcRows(metrics) {
  const pa = obj(metrics).precisionAt ?? obj(metrics).precision_at;
  const list = Array.isArray(pa)
    ? pa.map(r => ({ thr: num(pick(obj(r), "thr", "threshold", "t")), precision: num(obj(r).precision), coverage: num(obj(r).coverage), n: num(obj(r).n) }))
    : Object.entries(obj(pa)).map(([k, v]) => ({ thr: num(k), precision: num(typeof v === "number" ? v : obj(v).precision), coverage: num(obj(v).coverage), n: num(obj(v).n) }));
  return list.filter(r => r.thr != null && r.precision != null).sort((a, b) => a.thr - b.thr);
}
function thrVals(e) {
  const m = { ...obj(e?.model), ...obj(e?.thresholds), ...obj(e?.value) };
  return {
    minConf: num(pick(m, "minConfidence", "MIN_CONFIDENCE", "min_confidence")),
    minEdge: num(pick(m, "minProbEdge", "MIN_PROB_EDGE", "min_prob_edge")),
    metaThr: num(pick(m, "metaThreshold", "metaP", "meta_threshold", "minMetaP", "META_THRESHOLD")),
  };
}
function maskSummary(e) {
  const raw = obj(obj(e?.model).mask ?? e?.model ?? e?.mask);
  const vals = Object.values(raw).map(num).filter(v => v != null);
  if (!vals.length) return null;
  return { n: vals.length, zero: vals.filter(v => v === 0).length, down: vals.filter(v => v > 0 && v < 1).length, one: vals.filter(v => v === 1).length, up: vals.filter(v => v > 1).length, map: raw };
}
const cyclesOf = (data) => arr(data?.cycles ?? data?.reports ?? data?.history ?? data).filter(c => c && typeof c === "object").sort((a, b) => (toMs(b.ts) ?? 0) - (toMs(a.ts) ?? 0));

// ─── Small primitives ────────────────────────────────────────────────────────
const Mono = ({ children, color = C.sub, size = 10, style }) => <span style={{ fontFamily: MONO, fontSize: size, color, ...style }}>{children}</span>;
function Pill({ color, bg, children, title, strong }) {
  return <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 4, color, background: bg || C.inset, border: `1px solid ${color}${strong ? "" : "88"}`, borderRadius: 4, padding: "2px 7px", fontFamily: MONO, fontSize: 9.5, fontWeight: 800, letterSpacing: 0.6, whiteSpace: "nowrap" }}>{children}</span>;
}
const LevelChip = ({ level }) => {
  const l = level || null;
  const c = LEVEL_COLOR[l] || C.dim;
  const icon = l === "ok" ? "●" : l === "warn" ? "▲" : l === "drift" ? "◆" : "○";
  return <Pill color={c} title="drift monitor state (Page-Hinkley over live log-loss / hit rate)">{icon} DRIFT {l ? l.toUpperCase() : "—"}</Pill>;
};
function Segmented({ value, options, onChange, small }) {
  return (
    <div role="group" style={{ display: "inline-flex", border: `1px solid ${C.borderHi}`, borderRadius: 6, overflow: "hidden", flex: "none" }}>
      {options.map(([k, l], i) => {
        const on = value === k;
        return <button key={k} onClick={() => !on && onChange(k)} aria-pressed={on} style={{ background: on ? C.blue : "transparent", color: on ? "#041018" : C.sub, border: "none", borderLeft: i ? `1px solid ${C.borderHi}` : "none", padding: small ? "4px 8px" : "6px 10px", fontFamily: MONO, fontSize: small ? 9.5 : 10, fontWeight: 700, cursor: on ? "default" : "pointer", letterSpacing: 0.5 }}>{l}</button>;
      })}
    </div>
  );
}
export { Segmented };
const TargetKey = ({ target }) => <span style={{ display: "inline-block", width: 10, height: 3, borderRadius: 2, background: TARGET_COLOR[target] || C.sub, verticalAlign: "middle", marginRight: 5 }} />;

// ─── 1. Status header ────────────────────────────────────────────────────────
function StatusHeader({ s, missing, horizon, setHorizon, running, onRun, busy, msg, now, drift, champCount, last, narrow }) {
  const so = obj(s);
  const cur = obj(so.current ?? so.currentCycle ?? so.active);
  const sched = obj(so.schedule);
  const nextRun = pick(so, "nextRun", "nextRunAt", "next", "nextAt") ?? sched.nextRun ?? sched.nextRunAt;
  const every = num(pick(so, "everyMs", "intervalMs")) ?? num(sched.everyMs);
  const lastTs = last?.ts ?? so.lastRunAt ?? so.lastRun;
  const dur = num(pick(obj(last), "durationMs", "duration", "ms", "elapsedMs"));
  const startedAt = cur.startedAt ?? cur.ts ?? so.startedAt;
  const stage = cur.stage ?? cur.step ?? cur.phase ?? so.stage;
  const progress = num(cur.progress ?? so.progress);
  const dr = drift.deRisk;
  const bump = num(pick(dr, "minConfidenceBump", "minConfBump", "confBump", "minConfDelta", "minConfidenceDelta")) ?? 0.05;
  const size = num(pick(dr, "sizeMult", "sizeMultiplier", "sizeFactor", "size")) ?? 0.5;
  const worst = drift.monitors.find(m => m._level === drift.level) || drift.monitors[0];
  return (
    <Panel pad={12} style={{ borderColor: running ? C.blue + "77" : drift.level === "drift" ? C.down + "77" : dr.active ? C.amber + "66" : C.border }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ minWidth: 0, flex: "1 1 260px" }}>
          <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontFamily: MONO, fontSize: 10, letterSpacing: 1.6, color: C.sub, fontWeight: 700 }}>SELF-LEARNING LAB</span>
            {running
              ? <Pill color={C.blue} bg="#062033" strong><span className="de-pulse">●</span> RUNNING</Pill>
              : <Pill color={missing ? C.dim : C.sub}>{missing ? "○ NO STATUS" : "■ IDLE"}</Pill>}
            <LevelChip level={drift.level} />
            {dr.active && <Pill color={C.amber} bg="#1f1404" strong>⚠ DE-RISK</Pill>}
          </div>
          <div style={{ fontSize: 11, color: C.sub, lineHeight: 1.45, marginTop: 5 }}>
            {running
              ? <>Cycle running{cur.horizon ? ` · ${cur.horizon}` : ""}{stage ? <> · <b style={{ color: C.text }}>{String(stage)}</b></> : ""}{toMs(startedAt) != null ? ` · ${fmtDur(now - toMs(startedAt))} elapsed` : ""}{cur.reason ? ` · ${cur.reason}` : ""}</>
              : missing ? "The lab hasn't reported a status yet. Run a cycle to build the dataset, the report card and the first champions."
                : <>Idle. Challengers retrain every {fmtDur(every ?? 6 * 3600e3)} and go live only if they beat the champion out of sample (DM p &lt; 0.10).</>}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <Segmented value={horizon} onChange={setHorizon} options={narrow ? HORIZONS.map(([k]) => [k, k.slice(0, 5).toUpperCase()]) : HORIZONS} small={narrow} />
          <Btn active color={C.violet} onClick={onRun} disabled={running || busy === "run"} title={`POST /api/lab/run {horizon:"${horizon}"}`}>
            {busy === "run" ? <span className="de-pulse">STARTING…</span> : running ? "RUNNING…" : "▶ RUN CYCLE NOW"}
          </Btn>
        </div>
      </div>
      {running && progress != null && <div style={{ marginTop: 8 }}><MeterBar v={progress} h={4} title={pct(progress, 0)} /></div>}
      {msg && <div className="de-in" style={{ marginTop: 8, padding: "6px 10px", border: `1px solid ${msg.color}66`, borderRadius: 6, fontFamily: MONO, fontSize: 10.5, color: msg.color, background: C.inset }}>{msg.text}</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(112px, 1fr))", gap: 6, marginTop: 10 }}>
        <Stat label="next run" value={running ? "after this" : until(nextRun, now)} sub={toMs(nextRun) != null ? dt(nextRun) : "not scheduled"} />
        <Stat label="last cycle" value={toMs(lastTs) != null ? ago(lastTs, now) : "never"} sub={toMs(lastTs) != null ? `${dt(lastTs)}${dur != null ? " · " + fmtDur(dur) : ""}` : "—"} />
        <Stat label="last reason" value={last?.reason ? String(last.reason) : "—"} sub={last?.horizon ? `horizon ${last.horizon}` : null} />
        <Stat label="dataset rows" value={num(last?.datasetRows) != null ? num(last.datasetRows).toLocaleString("en-US") : "—"} />
        <Stat label="champions" value={`${champCount} / ${SLOTS.length}`} color={champCount ? C.text : C.dim} sub={horizon} />
        <Stat label="drift stat" value={worst ? fx(worst.stat, 2) : "—"} color={LEVEL_COLOR[drift.level] || C.text}
          sub={worst ? `${worst.name}${num(pick(worst, "threshold", "lambda")) != null ? ` · λ ${fx(pick(worst, "threshold", "lambda"), 1)}` : ""}` : "no monitor"} />
      </div>
      {drift.monitors.length > 1 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 6, marginTop: 6 }}>
          {drift.monitors.map(m => {
            const thr = num(pick(m, "threshold", "lambda"));
            return (
              <div key={m.name} style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 8, alignItems: "center", fontFamily: MONO, fontSize: 10, padding: "5px 8px", border: `1px solid ${C.border}`, borderRadius: 6, background: C.inset }}>
                <span style={{ color: C.sub }}>{m.name}</span>
                <MeterBar v={thr ? clamp((num(m.stat) ?? 0) / thr, 0, 1) : 0} h={4} color={LEVEL_COLOR[m._level] || C.sub} />
                <span style={{ color: C.text }}>{fx(m.stat, 2)}{thr ? ` / ${fx(thr, 1)}` : ""} <span style={{ color: LEVEL_COLOR[m._level] || C.dim }}>{m._level || "—"}</span></span>
              </div>
            );
          })}
        </div>
      )}
      {dr.active && (
        <div style={{ marginTop: 8, padding: "7px 10px", border: `1px dashed ${C.amber}88`, borderRadius: 6, fontFamily: MONO, fontSize: 10.5, color: C.text, lineHeight: 1.5 }}>
          <b style={{ color: C.amber }}>DE-RISK ACTIVE</b> → min confidence <b>+{fx(bump, 2)}</b> · position size <b>×{fx(size, 2)}</b>
          {toMs(dr.until) != null && <> · until {dt(dr.until)} ({until(dr.until, now)})</>}
          {dr.reason && <span style={{ color: C.sub }}> · {String(dr.reason)}</span>}
          <span style={{ color: C.dim }}> · lifts on the next promotion or after 2× the horizon</span>
        </div>
      )}
    </Panel>
  );
}

// ─── 2. Champion cards ───────────────────────────────────────────────────────
function MetricRow({ label, v, base, d = 3, better = "lower", note }) {
  const a = num(v), b = num(base);
  const delta = a != null && b != null ? a - b : null;
  const good = delta == null ? null : better === "lower" ? delta < 0 : delta > 0;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "54px 1fr auto", gap: 6, alignItems: "baseline", fontFamily: MONO, fontSize: 10.5 }}>
      <span style={{ color: C.dim, fontSize: 9, letterSpacing: 0.8, textTransform: "uppercase" }}>{label}</span>
      <span style={{ color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        <b>{a == null ? "—" : a.toFixed(d)}</b>{b != null && <span style={{ color: C.dim }}> vs {b.toFixed(d)}</span>}{note && <span style={{ color: C.dim }}> {note}</span>}
      </span>
      <span style={{ color: good == null ? C.dim : good ? C.up : C.down, whiteSpace: "nowrap" }}>{delta == null ? "" : (delta > 0 ? "+" : "") + delta.toFixed(d)}</span>
    </div>
  );
}

function ChampionCard({ slot, e, onRollback, busy, horizon }) {
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (!confirm) return; const t = setTimeout(() => setConfirm(false), 8000); return () => clearTimeout(t); }, [confirm]);
  const m = Mx(e);
  const dmp = mDmP(m);
  const color = slot.target ? TARGET_COLOR[slot.target] : slot.kind === "meta" ? C.blue : slot.kind === "mask" ? C.sub : C.warn;
  const rb = busy === "rb:" + slot.key;
  let body;
  if (!e) body = <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.dim, padding: "10px 0", lineHeight: 1.5 }}>no champion yet{slot.kind === "stacker" ? " · v1 pooled pRaw is live" : ""}</div>;
  else if (slot.kind === "stacker") body = (
    <div style={{ display: "grid", gap: 3 }}>
      <MetricRow label="AUC" v={mAUC(m)} base={mAUCb(m)} better="higher" />
      <MetricRow label="Brier" v={mBr(m)} base={mBrb(m)} d={4} />
      <MetricRow label="log-loss" v={mLL(m)} base={mLLb(m)} d={4} />
      <div style={{ display: "grid", gridTemplateColumns: "54px 1fr", gap: 6, fontFamily: MONO, fontSize: 10.5 }}>
        <span style={{ color: C.dim, fontSize: 9, letterSpacing: 0.8 }}>DM p</span>
        <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}><b style={{ color: dmp == null ? C.dim : dmp < 0.1 ? C.up : C.down }}>{dmp == null ? "—" : dmp < 0.001 ? "<0.001" : dmp.toFixed(3)}</b>
          <span style={{ color: C.dim }}>{dmp != null ? (dmp < 0.1 ? " · significant" : " · n.s.") : ""}{mDmS(m) != null ? ` · stat ${snum(mDmS(m), 2)}` : ""}</span></span>
      </div>
    </div>
  );
  else if (slot.kind === "meta") {
    const rows = pcRows(m);
    const feas = rows.filter(r => (r.coverage ?? 0) >= 0.15 && r.precision >= 0.55).sort((a, b) => b.precision - a.precision)[0];
    body = (
      <div style={{ display: "grid", gap: 3 }}>
        <MetricRow label="AUC" v={mAUC(m)} base={mAUCb(m) ?? 0.5} better="higher" />
        <MetricRow label="Brier" v={mBr(m)} base={mBrb(m)} d={4} />
        <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.sub }}>
          {feas ? <>best feasible: <b style={{ color: C.text }}>{pct(feas.precision, 1)}</b> precision @ {pct(feas.coverage, 0)} coverage (thr {fx(feas.thr, 2)})</> : rows.length ? "no threshold meets ≥55% precision at ≥15% coverage" : "no precision@threshold table"}
        </div>
      </div>
    );
  } else if (slot.kind === "mask") {
    const ms = maskSummary(e);
    body = ms ? (
      <div style={{ display: "grid", gap: 5 }}>
        <div style={{ display: "flex", height: 8, borderRadius: 2, overflow: "hidden", gap: 2, background: C.panel }} title="signals by multiplier: ×0 · <1 · =1 · >1">
          {[[ms.zero, C.down], [ms.down, C.amber], [ms.one, C.hold], [ms.up, C.up]].filter(([n]) => n > 0).map(([n, c], i) => <div key={i} style={{ flex: n, background: c }} />)}
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10, color: C.sub, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <span><b style={{ color: C.text }}>{ms.n}</b> signals</span><span>×0 <b style={{ color: C.text }}>{ms.zero}</b></span><span>&lt;1 <b style={{ color: C.text }}>{ms.down}</b></span><span>=1 <b style={{ color: C.text }}>{ms.one}</b></span><span>&gt;1 <b style={{ color: C.text }}>{ms.up}</b></span>
        </div>
      </div>
    ) : <div style={{ fontFamily: MONO, fontSize: 10.5, color: C.sub }}>{Object.keys(m).length ? Object.entries(m).filter(([, v]) => typeof v !== "object").slice(0, 4).map(([k, v]) => `${k} ${fmtAny(k, v)}`).join(" · ") : "multipliers not included in status"}</div>;
  } else {
    const t = thrVals(e);
    const dsr = num(pick(m, "deflatedSharpe", "dsr", "DSR"));
    const pbo = num(pick(m, "pbo", "PBO"));
    body = (
      <div style={{ display: "grid", gap: 4 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 4 }}>
          <Stat label="min conf" value={fx(t.minConf, 2)} />
          <Stat label="min edge" value={fx(t.minEdge, 3)} />
          <Stat label="meta-P" value={fx(t.metaThr, 2)} />
        </div>
        <div style={{ fontFamily: MONO, fontSize: 10, color: C.sub, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <span>DSR <b style={{ color: dsr == null ? C.dim : dsr >= 0.5 ? C.up : C.down }}>{fx(dsr, 2)}</b></span>
          <span>PBO <b style={{ color: pbo == null ? C.dim : pbo <= 0.5 ? C.up : C.down }}>{fx(pbo, 2)}</b></span>
          {num(pick(m, "activity", "coverage")) != null && <span>activity <b style={{ color: C.text }}>{pct(pick(m, "activity", "coverage"), 0)}</b></span>}
          {num(m.precision) != null && <span>precision <b style={{ color: C.text }}>{pct(m.precision, 1)}</b></span>}
          {num(pick(m, "netRet", "expRet", "netExpRet")) != null && <span>net/decision <b style={{ color: colorSign(pick(m, "netRet", "expRet", "netExpRet")) }}>{spct(pick(m, "netRet", "expRet", "netExpRet"), 2)}</b></span>}
        </div>
      </div>
    );
  }
  return (
    <div style={{ background: C.panel2, border: `1px solid ${e ? C.borderHi : C.border}`, borderRadius: 8, padding: 10, display: "grid", gap: 7, alignContent: "start", minWidth: 0, borderTop: `2px solid ${e ? color : C.faint}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: MONO, fontSize: 11, fontWeight: 800, color: C.text, letterSpacing: 0.5 }}>{slot.title}</div>
          <div style={{ fontSize: 10.5, color: C.dim }}>{slot.sub}</div>
        </div>
        {e && <Pill color={C.up} bg={C.upBg}>{vlabel(e.version)}</Pill>}
      </div>
      {e && <div style={{ fontFamily: MONO, fontSize: 9.5, color: C.dim, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <span>trained → <span style={{ color: C.sub }}>{dday(e.trainedThrough)}</span></span>
        <span>promoted <span style={{ color: C.sub }} title={dt(e.promotedAt)}>{toMs(e.promotedAt) != null ? ago(e.promotedAt) : "—"}</span></span>
        {e.dataHash && <span title={String(e.dataHash)}>#{String(e.dataHash).slice(0, 7)}</span>}
      </div>}
      {body}
      {e?.reason && <div style={{ fontSize: 10.5, color: C.sub, lineHeight: 1.4, borderLeft: `2px solid ${C.faint}`, paddingLeft: 7 }}>{String(e.reason)}</div>}
      {e && <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}>
        {confirm ? <>
          <span style={{ fontFamily: MONO, fontSize: 9.5, color: C.amber }}>restore previous {slot.kind}{slot.target ? "·" + slot.target : ""} for {horizon}?</span>
          <Btn small onClick={() => setConfirm(false)}>cancel</Btn>
          <Btn small active color={C.down} onClick={() => { setConfirm(false); onRollback(slot); }}>confirm</Btn>
        </> : <Btn small onClick={() => setConfirm(true)} disabled={rb} title={`POST /api/lab/rollback {horizon, kind:"${slot.kind}"${slot.target ? `, target:"${slot.target}"` : ""}}`}>{rb ? <span className="de-pulse">rolling back…</span> : "↶ rollback"}</Btn>}
      </div>}
    </div>
  );
}

// ─── 3a. Champion OOS log-loss over versions (SVG) ───────────────────────────
function lossPoints(regEntries, cycles) {
  const reg = regEntries.filter(e => e.kind === "stacker" && mLL(Mx(e)) != null);
  if (reg.length) {
    const sorted = [...reg].sort((a, b) => (toMs(a.ts) ?? vnum(a)) - (toMs(b.ts) ?? vnum(b)) || vnum(a) - vnum(b));
    return sorted.map((e, i) => ({ i, label: vlabel(e.version), target: TARGETS.includes(e.target) ? e.target : "y", ll: mLL(Mx(e)), base: mLLb(Mx(e)), promoted: wasPromoted(e), version: e.version, ts: e.ts, reason: e.reason }));
  }
  // Fallback: challengers recorded in cycle reports (one x slot per cycle).
  const out = [];
  [...cycles].reverse().forEach((c, i) => {
    for (const ch of arr(c.challengers)) {
      const k = splitKey(ch?.kind || "");
      if ((k.kind ?? ch?.kind) !== "stacker") continue;
      const ll = mLL(Mx(ch)); if (ll == null) continue;
      out.push({ i, label: dday(c.ts), target: TARGETS.includes(ch.target) ? ch.target : k.target || "y", ll, base: mLLb(Mx(ch)), promoted: ch.promoted === true, version: ch.version, ts: c.ts, reason: ch.reason });
    }
  });
  return out;
}

function LossChart({ points, height = 210 }) {
  const [ref, W] = useMeasure();
  const [hv, setHv] = useState(null);
  const w = Math.max(W, 240);
  if (!points.length) return <div ref={ref}><Empty>no stacker versions yet — run a cycle</Empty></div>;
  const padL = 8, padR = 50, padT = 10, padB = 22;
  const nX = Math.max(...points.map(p => p.i)) + 1;
  const base = [...points].reverse().find(p => p.base != null)?.base ?? null;
  const vals = points.map(p => p.ll).concat(base != null ? [base] : []);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - LN2 < 0.02 && LN2 - lo < 0.06) { lo = Math.min(lo, LN2); hi = Math.max(hi, LN2); }
  const pd = (hi - lo) * 0.12 || 0.005; lo -= pd; hi += pd;
  const x = (i) => padL + (nX > 1 ? i / (nX - 1) : 0.5) * (w - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (height - padT - padB);
  const step = (hi - lo) / 4;
  const ticks = [0, 1, 2, 3, 4].map(k => lo + k * step);
  const series = TARGETS.map(t => {
    const pts = points.filter(p => p.target === t).sort((a, b) => a.i - b.i);
    let cur = null; const st = [];
    for (const p of pts) if (p.promoted) { cur = p.ll; st.push([p.i, cur]); }
    let d = "";
    st.forEach(([i, v], k) => { d += k === 0 ? `M${x(i).toFixed(1)},${y(v).toFixed(1)}` : `H${x(i).toFixed(1)}V${y(v).toFixed(1)}`; });
    if (st.length) d += `H${x(nX - 1).toFixed(1)}`;
    return { t, pts, d, last: st.length ? st[st.length - 1][1] : null };
  }).filter(s => s.pts.length);
  const labelIdx = nX <= 6 ? [...Array(nX).keys()] : [0, Math.round((nX - 1) / 3), Math.round((2 * (nX - 1)) / 3), nX - 1];
  const labelFor = (i) => points.find(p => p.i === i)?.label || "";
  const onMove = (ev) => {
    const r = ev.currentTarget.getBoundingClientRect(); const px = ev.clientX - r.left, py = ev.clientY - r.top;
    let best = null, bd = 18 * 18;
    for (const p of points) { const dx = x(p.i) - px, dy = y(p.ll) - py, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = p; } }
    setHv(best);
  };
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontFamily: MONO, fontSize: 10, color: C.sub, marginBottom: 4 }}>
        {series.map(s => <span key={s.t}><TargetKey target={s.t} />{s.t}{s.last != null ? <span style={{ color: C.dim }}> {s.last.toFixed(4)}</span> : ""}</span>)}
        <span style={{ color: C.dim }}>● promoted ○ rejected · lower is better</span>
      </div>
      <svg width={w} height={height} style={{ display: "block", touchAction: "pan-y" }} onMouseMove={onMove} onMouseLeave={() => setHv(null)}>
        {ticks.map((t, k) => <g key={k}><line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke="#111823" /><text x={w - padR + 6} y={y(t) + 3} fill={C.dim} fontSize={9} fontFamily={MONO}>{t.toFixed(3)}</text></g>)}
        {LN2 > lo && LN2 < hi && <g><line x1={padL} x2={w - padR} y1={y(LN2)} y2={y(LN2)} stroke={C.sub} strokeDasharray="4 4" opacity={0.7} /><text x={padL + 4} y={y(LN2) - 3} fill={C.sub} fontSize={8.5} fontFamily={MONO}>coin flip ln2</text></g>}
        {base != null && base > lo && base < hi && Math.abs(base - LN2) > 0.0002 && <g><line x1={padL} x2={w - padR} y1={y(base)} y2={y(base)} stroke={C.warn} strokeDasharray="4 4" opacity={0.6} /><text x={w - padR - 4} y={y(base) + (base > LN2 ? -3 : 10)} fill={C.warn} fontSize={8.5} textAnchor="end" fontFamily={MONO}>v1 baseline</text></g>}
        {series.map(s => <path key={s.t} d={s.d} stroke={TARGET_COLOR[s.t]} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />)}
        {series.map(s => s.pts.map((p, k) => p.promoted
          ? <circle key={s.t + k} cx={x(p.i)} cy={y(p.ll)} r={4} fill={TARGET_COLOR[s.t]} stroke={C.panel} strokeWidth={2} />
          : <circle key={s.t + k} cx={x(p.i)} cy={y(p.ll)} r={3.5} fill={C.panel} stroke={TARGET_COLOR[s.t]} strokeWidth={1.5} opacity={0.8} />))}
        {hv && <circle cx={x(hv.i)} cy={y(hv.ll)} r={7} fill="none" stroke={C.text} strokeWidth={1} pointerEvents="none" />}
        {labelIdx.map(i => <text key={i} x={clamp(x(i), padL + 14, w - padR - 14)} y={height - 6} fill={C.dim} fontSize={9} textAnchor="middle" fontFamily={MONO}>{labelFor(i)}</text>)}
      </svg>
      {hv && <div style={{ position: "absolute", top: 22, left: clamp(x(hv.i) + 12, 0, w - 220), width: 210, background: "#0b1119ee", border: `1px solid ${C.borderHi}`, borderRadius: 5, padding: "6px 8px", fontFamily: MONO, fontSize: 10, pointerEvents: "none", color: C.text, lineHeight: 1.5 }}>
        <div><TargetKey target={hv.target} />stacker·{hv.target} <b>{hv.version != null ? vlabel(hv.version) : hv.label}</b> <span style={{ color: hv.promoted ? C.up : C.down }}>{hv.promoted ? "✓ promoted" : "✗ rejected"}</span></div>
        <div>log-loss <b>{hv.ll.toFixed(4)}</b>{hv.base != null ? <span style={{ color: C.dim }}> · base {hv.base.toFixed(4)}</span> : ""}</div>
        {hv.ts && <div style={{ color: C.dim }}>{dt(hv.ts)}</div>}
        {hv.reason && <div style={{ color: C.sub, whiteSpace: "normal" }}>{String(hv.reason)}</div>}
      </div>}
    </div>
  );
}

// ─── 5. Meta-labeler precision / coverage curve (SVG) ────────────────────────
function PCCurve({ rows, current, height = 220 }) {
  const [ref, W] = useMeasure();
  const [hv, setHv] = useState(null);
  const w = Math.max(W, 220);
  const useCov = rows.some(r => r.coverage != null);
  const X = (r) => (useCov ? r.coverage : r.thr);
  const pts = rows.filter(r => X(r) != null && r.precision != null).sort((a, b) => X(a) - X(b));
  if (!pts.length) return <div ref={ref}><Empty>no meta-labeler precision table yet — run a cycle</Empty></div>;
  const padL = 36, padR = 12, padT = 12, padB = 26;
  const xs = pts.map(X), ps = pts.map(r => r.precision);
  const x0 = useCov ? 0 : Math.min(...xs), x1 = useCov ? 1 : Math.max(...xs) || 1;
  const ylo = Math.max(0, Math.floor((Math.min(0.5, ...ps) - 0.02) * 20) / 20);
  const yhi = Math.min(1, Math.ceil((Math.max(0.6, ...ps) + 0.03) * 20) / 20);
  const x = (v) => padL + ((v - x0) / (x1 - x0 || 1)) * (w - padL - padR);
  const y = (v) => padT + (1 - (v - ylo) / (yhi - ylo || 1)) * (height - padT - padB);
  const yTicks = []; const ys = (yhi - ylo) > 0.3 ? 0.1 : 0.05;
  for (let v = Math.ceil(ylo / ys) * ys; v <= yhi + 1e-9; v += ys) yTicks.push(+v.toFixed(2));
  const xTicks = useCov ? [0, 0.25, 0.5, 0.75, 1] : [x0, (x0 + x1) / 2, x1];
  const cur = num(current);
  const curPt = cur == null ? null : pts.reduce((b, r) => (b == null || Math.abs(r.thr - cur) < Math.abs(b.thr - cur) ? r : b), null);
  const d = pts.map((r, i) => `${i ? "L" : "M"}${x(X(r)).toFixed(1)},${y(r.precision).toFixed(1)}`).join("");
  const fx0 = useCov ? x(0.15) : null, fy0 = y(clamp(0.55, ylo, yhi));
  const ends = pts.length > 1 ? [pts[0], pts[pts.length - 1]] : [pts[0]];
  return (
    <div ref={ref} style={{ position: "relative" }}>
      <svg width={w} height={height} style={{ display: "block", touchAction: "pan-y" }} onMouseLeave={() => setHv(null)}>
        {useCov && 0.55 < yhi && <rect x={fx0} y={padT} width={Math.max(0, x(1) - fx0)} height={Math.max(0, fy0 - padT)} fill={C.up} opacity={0.06} />}
        {yTicks.map(t => <g key={t}><line x1={padL} x2={w - padR} y1={y(t)} y2={y(t)} stroke="#111823" /><text x={padL - 5} y={y(t) + 3} fill={C.dim} fontSize={9} textAnchor="end" fontFamily={MONO}>{Math.round(t * 100)}%</text></g>)}
        {xTicks.map((t, k) => <text key={k} x={clamp(x(t), padL + 8, w - padR - 10)} y={height - 8} fill={C.dim} fontSize={9} textAnchor="middle" fontFamily={MONO}>{useCov ? Math.round(t * 100) + "%" : t.toFixed(2)}</text>)}
        {0.55 > ylo && 0.55 < yhi && <line x1={padL} x2={w - padR} y1={y(0.55)} y2={y(0.55)} stroke={C.up} strokeDasharray="4 4" opacity={0.55} />}
        {useCov && <line x1={x(0.15)} x2={x(0.15)} y1={padT} y2={height - padB} stroke={C.up} strokeDasharray="4 4" opacity={0.55} />}
        {useCov && 0.55 < yhi && <text x={w - padR - 4} y={padT + 10} fill={C.up} fontSize={8.5} textAnchor="end" fontFamily={MONO} opacity={0.85}>feasible: prec ≥ 55%, cov ≥ 15%</text>}
        <path d={d} stroke={C.blue} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />
        {pts.map((r, i) => <circle key={i} cx={x(X(r))} cy={y(r.precision)} r={4} fill={C.blue} stroke={C.panel} strokeWidth={2} />)}
        {ends.map((r, i) => r === curPt ? null : <text key={"e" + i} x={clamp(x(X(r)) + (i ? -6 : 6), padL + 4, w - padR - 4)} y={i ? y(r.precision) + 16 : y(r.precision) - 8} fill={C.sub} fontSize={8.5} textAnchor={i ? "end" : "start"} fontFamily={MONO}>thr {fx(r.thr, 2)}</text>)}
        {curPt && <g>
          <circle cx={x(X(curPt))} cy={y(curPt.precision)} r={7} fill="none" stroke={C.warn} strokeWidth={2} />
          <text x={clamp(x(X(curPt)), padL + 40, w - padR - 40)} y={clamp(y(curPt.precision) + 18, padT + 10, height - padB - 4)} fill={C.text} fontSize={9} textAnchor="middle" fontFamily={MONO}>live thr {fx(cur, 2)}</text>
        </g>}
        {pts.map((r, i) => <circle key={"h" + i} cx={x(X(r))} cy={y(r.precision)} r={11} fill="transparent" onMouseEnter={() => setHv(r)} />)}
        <text x={padL + 2} y={padT - 2} fill={C.dim} fontSize={8.5} fontFamily={MONO}>precision ↑</text>
        <text x={w - padR} y={height - padB - 4} fill={C.dim} fontSize={8.5} textAnchor="end" fontFamily={MONO}>{useCov ? "coverage →" : "threshold →"}</text>
      </svg>
      {hv && <div style={{ position: "absolute", top: 4, left: clamp(x(X(hv)) + 12, 0, w - 170), background: "#0b1119ee", border: `1px solid ${C.borderHi}`, borderRadius: 5, padding: "5px 8px", fontFamily: MONO, fontSize: 10, color: C.text, pointerEvents: "none" }}>
        thr <b>{fx(hv.thr, 2)}</b> · precision <b>{pct(hv.precision, 1)}</b> · coverage <b>{pct(hv.coverage, 1)}</b>{hv.n != null ? ` · n ${hv.n}` : ""}
      </div>}
    </div>
  );
}

// ─── 3b. Cycle history timeline ──────────────────────────────────────────────
function flatSummary(x) {
  const out = [];
  for (const [k, v] of Object.entries(obj(x))) {
    if (v == null) continue;
    if (typeof v === "object" && !Array.isArray(v)) { for (const [k2, v2] of Object.entries(v)) if (v2 != null && typeof v2 !== "object") out.push([k2, v2]); }
    else if (typeof v !== "object") out.push([k, v]);
  }
  return out.slice(0, 12);
}

function ChallengerRow({ ch, narrow }) {
  const c = obj(ch);
  const k = splitKey(c.kind || "");
  const kind = k.kind ?? c.kind ?? "?";
  const target = c.target ?? k.target;
  const m = Mx(c);
  const ok = c.promoted === true;
  const bits = [];
  if (mLL(m) != null) bits.push(["ll", mLL(m).toFixed(4)]);
  if (mAUC(m) != null) bits.push(["auc", mAUC(m).toFixed(3)]);
  if (mDmP(m) != null) bits.push(["DM p", mDmP(m).toFixed(3)]);
  if (kind === "meta") { const rows = pcRows(m); if (rows.length) bits.push(["P@max", pct(Math.max(...rows.map(r => r.precision)), 0)]); }
  if (kind === "thresholds") { const t = thrVals(c); if (t.minConf != null) bits.push(["conf", fx(t.minConf, 2)]); const dsr = num(pick(m, "deflatedSharpe", "dsr")); if (dsr != null) bits.push(["DSR", fx(dsr, 2)]); const pbo = num(pick(m, "pbo", "PBO")); if (pbo != null) bits.push(["PBO", fx(pbo, 2)]); }
  return (
    <div style={{ display: "grid", gridTemplateColumns: narrow ? "16px minmax(0, 1fr)" : "16px 150px 250px minmax(0, 1fr)", gap: narrow ? "2px 6px" : 8, alignItems: "baseline", fontFamily: MONO, fontSize: 10.5, padding: "3px 0" }}>
      <span style={{ color: ok ? C.up : C.down, fontWeight: 800 }} aria-label={ok ? "promoted" : "rejected"}>{ok ? "✓" : "✗"}</span>
      <span style={{ color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{target && <TargetKey target={target} />}{kind}{target ? "·" + target : ""}{c.version != null ? <span style={{ color: C.dim }}> {vlabel(c.version)}</span> : ""}</span>
      {narrow && <span />}
      <span style={{ color: C.sub, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{bits.length ? bits.map(([a, b]) => <span key={a} style={{ marginRight: 9 }}><span style={{ color: C.dim }}>{a}</span> {b}</span>) : <span style={{ color: C.dim }}>—</span>}</span>
      {narrow && <span />}
      <span style={{ color: ok ? C.up : C.sub, fontFamily: "Inter, system-ui, sans-serif", fontSize: 10.5, lineHeight: 1.35 }}>{ok ? "promoted" : "rejected"}{c.reason ? <span style={{ color: C.sub }}> — {String(c.reason)}</span> : ""}</span>
    </div>
  );
}

function CycleItem({ c, first, narrow, now }) {
  const chs = arr(c.challengers);
  const nProm = chs.filter(x => x?.promoted === true).length;
  const summ = flatSummary(c.reportCardSummary);
  const thr = thrVals({ model: c.thresholds });
  const drift = typeof c.drift === "string" ? c.drift : c.drift?.level ?? (c.drift?.drift === true ? "drift" : null);
  const dur = num(pick(c, "durationMs", "duration", "ms", "elapsedMs"));
  const failed = c.error || c.ok === false || c.status === "failed";
  const dotColor = failed ? C.down : nProm ? C.up : C.hold;
  return (
    <div style={{ position: "relative", paddingLeft: 20, paddingBottom: 12 }}>
      <div style={{ position: "absolute", left: 5, top: 4, width: 10, height: 10, borderRadius: 5, background: dotColor, boxShadow: `0 0 0 2px ${C.panel}` }} />
      <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap", fontFamily: MONO, fontSize: 10.5 }}>
        <b style={{ color: C.text }}>{dt(c.ts)}</b><span style={{ color: C.dim }}>{ago(c.ts, now)}</span>
        {c.reason && <Tag color={/drift/i.test(c.reason) ? C.amber : /manual|api|user/i.test(c.reason) ? C.violet : C.sub}>{String(c.reason)}</Tag>}
        {c.horizon && <Tag>{c.horizon}</Tag>}
        {num(c.datasetRows) != null && <span style={{ color: C.dim }}>{num(c.datasetRows).toLocaleString("en-US")} rows</span>}
        {dur != null && <span style={{ color: C.dim }}>· {fmtDur(dur)}</span>}
        <span style={{ color: nProm ? C.up : C.dim }}>· {nProm}/{chs.length} promoted</span>
        {drift && <span style={{ color: LEVEL_COLOR[drift] || C.dim }}>· drift {drift}</span>}
        {first && <Tag color={C.blue}>latest</Tag>}
      </div>
      {failed && <div style={{ fontFamily: MONO, fontSize: 10.5, color: "#fca5a5", marginTop: 3 }}>⚠ {String(c.error || "cycle failed")}</div>}
      {summ.length > 0 && <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 5 }}>
        {summ.map(([k, v]) => <Tag key={k} color={/keep/i.test(k) ? C.up : /drop/i.test(k) ? C.down : /invert/i.test(k) ? C.violet : /weak/i.test(k) ? C.warn : C.sub}>{k} {fmtAny(k, v)}</Tag>)}
      </div>}
      {chs.length > 0 && <div style={{ marginTop: 5, borderLeft: `1px solid ${C.border}`, paddingLeft: 8 }}>{chs.map((ch, i) => <ChallengerRow key={i} ch={ch} narrow={narrow} />)}</div>}
      {(thr.minConf != null || thr.minEdge != null || thr.metaThr != null) && <div style={{ fontFamily: MONO, fontSize: 10, color: C.dim, marginTop: 4 }}>
        thresholds → conf {fx(thr.minConf, 2)} · edge {fx(thr.minEdge, 3)} · meta-P {fx(thr.metaThr, 2)}
      </div>}
    </div>
  );
}

function Timeline({ cycles, narrow, now }) {
  const [all, setAll] = useState(false);
  if (!cycles.length) return <Empty>no cycles recorded yet — run a cycle</Empty>;
  const shown = all ? cycles : cycles.slice(0, 5);
  return (
    <div style={{ position: "relative" }}>
      <div style={{ position: "absolute", left: 9.5, top: 8, bottom: 14, width: 1, background: C.border }} />
      {shown.map((c, i) => <CycleItem key={(c.ts ?? "") + ":" + i} c={c} first={i === 0} narrow={narrow} now={now} />)}
      {cycles.length > 5 && <div style={{ paddingLeft: 20 }}><Btn small onClick={() => setAll(a => !a)}>{all ? "show fewer" : `show all ${cycles.length}`}</Btn></div>}
    </div>
  );
}

// ─── 4. Signal report card ───────────────────────────────────────────────────
const VERDICT = {
  keep: { c: C.up, bg: C.upBg, l: "KEEP", i: "✓" },
  weak: { c: C.warn, bg: "#1d1804", l: "WEAK", i: "~" },
  drop: { c: C.down, bg: C.downBg, l: "DROP", i: "✗" },
  "invert-candidate": { c: C.violet, bg: "#160f2a", l: "INVERT?", i: "⇅" },
  unknown: { c: C.dim, bg: C.inset, l: "LOW-N", i: "·" },
};
const VERDICT_ORDER = ["keep", "weak", "drop", "invert-candidate", "unknown"];
const normVerdict = (v) => { const s = String(v || "").toLowerCase(); return s.startsWith("keep") ? "keep" : s.startsWith("weak") ? "weak" : s.startsWith("drop") ? "drop" : s.startsWith("invert") ? "invert-candidate" : "unknown"; };
export const VerdictChip = ({ v }) => { const m = VERDICT[normVerdict(v)]; return <Pill color={m.c} bg={m.bg} title={String(v || "unknown / low n")}>{m.i} {m.l}</Pill>; };
const FAM_PREFIX = { tech: "technical", rel: "relative", reg: "regime", macro: "macro", fg: "sentiment", sent: "sentiment", ml: "ml", fund: "fundamental" };
const famOf = (s) => s.family || FAM_PREFIX[String(s.id).split(".")[0]] || String(s.id).split(".")[0] || "?";

export function sigList(rc) {
  const s = obj(rc).signals;
  const list = Array.isArray(s) ? s : Object.entries(obj(s)).map(([id, v]) => ({ id, ...obj(v) }));
  return list.filter(x => x && typeof x === "object" && x.id != null).map(x => {
    const ci = arr(x.hitRateCI ?? x.hitCI).map(num);
    const dec = obj(x.decay);
    return {
      ...x, id: String(x.id), _fam: famOf(x), _v: normVerdict(x.verdict),
      _ic: num(x.ic), _t: num(x.icT ?? x.tStat ?? x.t), _p: num(x.icP ?? x.p), _hit: num(x.hitRate), _lo: ci[0] ?? null, _hi: ci[1] ?? null,
      _n: num(x.n), _nEff: num(x.nEff ?? x.n_eff), _stable: x.stable === true ? true : x.stable === false ? false : null,
      _h1: num(dec.ic_h1 ?? dec.h1), _h2: num(dec.ic_h2 ?? dec.h2),
    };
  });
}

function TBar({ t, max, w = 96 }) {
  const n = num(t);
  const m = Math.max(2.5, max || 3);
  const X = (v) => ((clamp(v, -m, m) + m) / (2 * m)) * 100;
  const sig = n != null && Math.abs(n) >= 1.96;
  const col = n == null ? C.faint : sig ? (n > 0 ? C.up : C.down) : divColor(n / (m * 2.2));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }} title={n == null ? "no t-stat" : `IC t = ${n.toFixed(2)} (Newey–West HAC)${sig ? " · |t| ≥ 1.96" : ""}`}>
      <div style={{ width: w, height: 8, position: "relative", background: C.inset, border: `1px solid ${C.border}`, borderRadius: 2, flex: "none" }}>
        {n != null && <div style={{ position: "absolute", top: 0, bottom: 0, left: Math.min(X(0), X(n)) + "%", width: Math.abs(X(n) - X(0)) + "%", background: col, borderRadius: 1 }} />}
        <div style={{ position: "absolute", top: -2, bottom: -2, left: "50%", width: 1, background: C.sub }} />
        {[-1.96, 1.96].map(v => <div key={v} style={{ position: "absolute", top: -2, bottom: -2, left: X(v) + "%", width: 1, background: C.dim }} />)}
      </div>
      <span style={{ width: 38, textAlign: "right", color: sig ? C.text : C.sub, fontWeight: sig ? 700 : 400 }}>{snum(n, 2)}</span>
    </div>
  );
}

function HitCI({ hit, lo, hi, dom, w = 70 }) {
  const h = num(hit);
  const X = (v) => clamp(((v - (0.5 - dom)) / (2 * dom)) * 100, 0, 100);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }} title={h == null ? "no hit rate" : `hit ${pct(h, 1)}${lo != null ? ` · 95% CI [${pct(lo, 1)}, ${pct(hi, 1)}]` : ""}`}>
      <div style={{ width: w, height: 10, position: "relative", flex: "none" }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 4.5, height: 1, background: C.faint }} />
        <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: C.sub }} />
        {lo != null && hi != null && <div style={{ position: "absolute", left: X(lo) + "%", width: Math.max(1, X(hi) - X(lo)) + "%", top: 3, height: 4, background: lo > 0.5 ? C.up + "66" : hi < 0.5 ? C.down + "66" : C.hold + "88", borderRadius: 2 }} />}
        {h != null && <div style={{ position: "absolute", left: `calc(${X(h)}% - 3px)`, top: 2, width: 6, height: 6, borderRadius: 3, background: lo != null && lo > 0.5 ? C.up : hi != null && hi < 0.5 ? C.down : C.text }} />}
      </div>
      <span style={{ color: C.text, width: 42, textAlign: "right" }}>{pct(h, 1)}</span>
    </div>
  );
}

function RegimeBars({ by, labels, max, h = 18 }) {
  const b = obj(by);
  if (!labels.length) return <span style={{ color: C.dim }}>—</span>;
  const bw = 7, gap = 2, W = labels.length * (bw + gap) - gap, mid = h / 2;
  return (
    <svg width={W} height={h} style={{ display: "block" }}>
      <line x1={0} x2={W} y1={mid} y2={mid} stroke={C.faint} />
      {labels.map((l, i) => {
        const e = obj(b[l]); const ic = num(e.ic);
        const hh = ic == null ? 0 : Math.max(1, (Math.abs(ic) / (max || 0.05)) * (mid - 1));
        return <g key={l}>
          <rect x={i * (bw + gap)} y={ic == null ? mid - 0.5 : ic >= 0 ? mid - hh : mid} width={bw} height={ic == null ? 1 : hh} rx={1} fill={ic == null ? C.faint : divColor(ic / (max || 0.05))} />
          <rect x={i * (bw + gap)} y={0} width={bw} height={h} fill="transparent"><title>{`${l}: ${ic == null ? "no data" : "IC " + snum(ic, 3)}${e.n != null ? " · n " + e.n : ""}`}</title></rect>
        </g>;
      })}
    </svg>
  );
}

function SignalDetail({ s, labels, rmax, mult, onClose }) {
  const cls = Object.entries(obj(s.byClass));
  return (
    <div className="de-in" style={{ marginTop: 8, border: `1px solid ${C.borderHi}`, borderRadius: 6, padding: 10, background: C.panel2 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <b style={{ fontFamily: MONO, fontSize: 12, color: C.text, wordBreak: "break-all" }}>{s.id}</b><Tag>{s._fam}</Tag><VerdictChip v={s.verdict} />
        {mult != null && <Tag color={mult === 0 ? C.down : mult > 1 ? C.up : C.sub}>mask ×{fx(mult, 2)}</Tag>}
        <span style={{ flex: 1 }} /><Btn small onClick={onClose}>✕</Btn>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(96px, 1fr))", gap: 6 }}>
        <Stat label="IC" value={snum(s._ic, 3)} color={colorSign(s._ic)} />
        <Stat label="IC t (HAC)" value={snum(s._t, 2)} sub={s._p != null ? `p ${s._p < 0.001 ? "<0.001" : s._p.toFixed(3)}` : null} />
        <Stat label="hit rate" value={pct(s._hit, 1)} sub={s._lo != null ? `[${pct(s._lo, 1)}, ${pct(s._hi, 1)}]` : null} />
        <Stat label="n / n_eff" value={s._n != null ? s._n.toLocaleString("en-US") : "—"} sub={s._nEff != null ? `eff ${Math.round(s._nEff).toLocaleString("en-US")}` : null} />
        <Stat label="stable" value={s._stable == null ? "—" : s._stable ? "yes" : "sign flips"} color={s._stable == null ? C.text : s._stable ? C.up : C.down} sub={s._h1 != null || s._h2 != null ? `h1 ${snum(s._h1, 3)} · h2 ${snum(s._h2, 3)}` : null} />
        <Stat label="ret | long" value={spct(s.meanRetWhenLong, 2)} color={colorSign(s.meanRetWhenLong)} />
        <Stat label="ret | short" value={spct(s.meanRetWhenShort, 2)} color={colorSign(num(s.meanRetWhenShort) == null ? null : -num(s.meanRetWhenShort))} sub="short profits if < 0" />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 240px), 1fr))", gap: 10, marginTop: 10 }}>
        <div>
          <div style={{ fontFamily: MONO, fontSize: 9, color: C.dim, letterSpacing: 1.2, marginBottom: 4 }}>IC BY REGIME</div>
          {labels.length ? labels.map(l => { const e = obj(obj(s.byRegime)[l]); const ic = num(e.ic); return (
            <div key={l} style={{ display: "grid", gridTemplateColumns: "minmax(0, 150px) 1fr 52px 48px", gap: 6, alignItems: "center", fontFamily: MONO, fontSize: 10, padding: "1px 0" }}>
              <span style={{ color: C.sub, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={l}>{l}</span>
              <div style={{ height: 6, background: C.inset, borderRadius: 2, position: "relative" }}><div style={{ position: "absolute", left: "50%", top: -1, bottom: -1, width: 1, background: C.faint }} />{ic != null && <div style={{ position: "absolute", top: 0, bottom: 0, [ic >= 0 ? "left" : "right"]: "50%", width: Math.min(50, (Math.abs(ic) / rmax) * 50) + "%", background: divColor(ic / rmax), borderRadius: 1 }} />}</div>
              <span style={{ color: colorSign(ic), textAlign: "right" }}>{snum(ic, 3)}</span>
              <span style={{ color: C.dim, textAlign: "right" }}>{e.n ?? "—"}</span>
            </div>); }) : <Empty>no regime breakdown</Empty>}
        </div>
        <div>
          <div style={{ fontFamily: MONO, fontSize: 9, color: C.dim, letterSpacing: 1.2, marginBottom: 4 }}>IC BY ASSET CLASS</div>
          {cls.length ? cls.map(([k, v]) => { const ic = num(obj(v).ic); return (
            <div key={k} style={{ display: "grid", gridTemplateColumns: "60px 1fr 52px 48px", gap: 6, alignItems: "center", fontFamily: MONO, fontSize: 10, padding: "1px 0" }}>
              <span style={{ color: C.sub }}>{k}</span>
              <div style={{ height: 6, background: C.inset, borderRadius: 2, position: "relative" }}><div style={{ position: "absolute", left: "50%", top: -1, bottom: -1, width: 1, background: C.faint }} />{ic != null && <div style={{ position: "absolute", top: 0, bottom: 0, [ic >= 0 ? "left" : "right"]: "50%", width: Math.min(50, (Math.abs(ic) / rmax) * 50) + "%", background: divColor(ic / rmax), borderRadius: 1 }} />}</div>
              <span style={{ color: colorSign(ic), textAlign: "right" }}>{snum(ic, 3)}</span>
              <span style={{ color: C.dim, textAlign: "right" }}>{obj(v).n ?? "—"}</span>
            </div>); }) : <Empty>no class breakdown</Empty>}
        </div>
      </div>
    </div>
  );
}

const SORTS = [["t", "|IC t| ▾"], ["ic", "IC ▾"], ["hit", "hit rate ▾"], ["neff", "n_eff ▾"], ["id", "id ▴"]];

function ReportCard({ rc, loading, err, reload, mask, narrow }) {
  const [fam, setFam] = useState("all");
  const [verdict, setVerdict] = useState("all");
  const [q, setQ] = useState("");
  const [sortKey, setSortKey] = useState("t");
  const [sel, setSel] = useState(null);
  const sigs = useMemo(() => sigList(rc), [rc]);
  const regimeLabels = useMemo(() => {
    const cnt = {};
    for (const s of sigs) for (const [l, v] of Object.entries(obj(s.byRegime))) cnt[l] = (cnt[l] || 0) + (num(obj(v).n) ?? 1);
    return Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).slice(0, 8);
  }, [sigs]);
  const rmax = useMemo(() => Math.max(0.02, ...sigs.flatMap(s => Object.values(obj(s.byRegime)).map(v => Math.abs(num(obj(v).ic) ?? 0)))), [sigs]);
  const tmax = useMemo(() => Math.max(3, ...sigs.map(s => Math.abs(s._t ?? 0))), [sigs]);
  const hitDom = useMemo(() => Math.max(0.05, ...sigs.flatMap(s => [s._hit, s._lo, s._hi]).filter(v => v != null).map(v => Math.abs(v - 0.5))), [sigs]);
  const fams = useMemo(() => { const m = {}; for (const s of sigs) m[s._fam] = (m[s._fam] || 0) + 1; return m; }, [sigs]);
  const verds = useMemo(() => { const m = {}; for (const s of sigs) m[s._v] = (m[s._v] || 0) + 1; return m; }, [sigs]);
  const famStats = useMemo(() => {
    const given = obj(obj(rc).families);
    return Object.keys(fams).sort().map(f => {
      const ss = sigs.filter(s => s._fam === f);
      const ics = ss.map(s => s._ic).filter(v => v != null);
      const g = obj(given[f]);
      return { f, n: ss.length, ic: num(g.ic ?? g.icMean ?? g.meanIc) ?? (ics.length ? ics.reduce((a, b) => a + b, 0) / ics.length : null), keep: ss.filter(s => s._v === "keep").length };
    });
  }, [sigs, fams, rc]);
  const maskMap = mask ? obj(mask.map) : null;
  const rows = sigs.filter(s => (fam === "all" || s._fam === fam) && (verdict === "all" || s._v === verdict) && (!q || s.id.toLowerCase().includes(q.toLowerCase())));
  const selected = sel ? sigs.find(s => s.id === sel) : null;
  const fdr = obj(obj(rc).fdr);

  if (rc === undefined && loading) return <Panel title="Signal report card"><Loading label="report card" /></Panel>;
  if (err && !rc) return <Panel title="Signal report card"><ErrorBox err={err} onRetry={reload} /></Panel>;
  if (!sigs.length) return <Panel title="Signal report card"><Empty>no report card yet — run a cycle (built from the point-in-time panel dataset)</Empty></Panel>;

  const icCell = (s) => <span style={{ color: colorSign(s._ic) }}>{snum(s._ic, 3)}</span>;
  const cols = narrow ? [
    { key: "id", label: "signal", sort: s => s.id, render: s => <div style={{ minWidth: 0 }}><div style={{ color: C.text, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis" }} title={s.id}>{s.id}</div><div style={{ color: C.dim, fontSize: 9 }}>{s._fam} · IC {snum(s._ic, 3)}</div></div> },
    { key: "t", label: "IC t", sort: s => (s._t == null ? null : Math.abs(s._t)), render: s => <TBar t={s._t} max={tmax} w={60} /> },
    { key: "v", label: "verdict", sort: s => VERDICT_ORDER.indexOf(s._v), render: s => <VerdictChip v={s.verdict} /> },
  ] : [
    { key: "id", label: "signal", sort: s => s.id, render: s => <span title={s.id} style={{ color: sel === s.id ? C.blue : C.text }}>{s.id}</span>, maxWidth: 230 },
    { key: "fam", label: "family", sort: s => s._fam, render: s => <span style={{ color: C.sub }}>{s._fam}</span> },
    { key: "ic", label: "IC", align: "right", sort: s => s._ic, render: icCell },
    { key: "t", label: "IC t-stat (±1.96)", sort: s => (s._t == null ? null : Math.abs(s._t)), render: s => <TBar t={s._t} max={tmax} /> },
    { key: "hit", label: "hit rate · 95% CI", sort: s => s._hit, render: s => <HitCI hit={s._hit} lo={s._lo} hi={s._hi} dom={hitDom} /> },
    { key: "neff", label: "n_eff", align: "right", sort: s => s._nEff ?? s._n, render: s => <span title={`n ${s._n ?? "—"}`}>{s._nEff != null ? Math.round(s._nEff).toLocaleString("en-US") : "—"}<span style={{ color: C.dim }}>{s._n != null ? ` / ${s._n.toLocaleString("en-US")}` : ""}</span></span> },
    { key: "stab", label: "stable", sort: s => (s._stable == null ? null : s._stable ? 1 : 0), render: s => <span title={`IC 1st half ${snum(s._h1, 3)} · 2nd half ${snum(s._h2, 3)}`} style={{ color: s._stable == null ? C.dim : s._stable ? C.up : C.down }}>{s._stable == null ? "—" : s._stable ? "✓ stable" : "✗ flips"}</span> },
    { key: "v", label: "verdict", sort: s => VERDICT_ORDER.indexOf(s._v), render: s => <VerdictChip v={s.verdict} /> },
    { key: "reg", label: "IC by regime", render: s => <RegimeBars by={s.byRegime} labels={regimeLabels} max={rmax} /> },
    ...(maskMap && Object.keys(maskMap).length ? [{ key: "mask", label: "mask", align: "right", sort: s => num(maskMap[s.id]), render: s => { const m = num(maskMap[s.id]); return <span style={{ color: m == null ? C.dim : m === 0 ? C.down : m > 1 ? C.up : C.sub }}>{m == null ? "—" : "×" + m.toFixed(2)}</span>; } }] : []),
  ];
  const initialSort = sortKey === "id" ? { key: "id", dir: "asc" } : { key: narrow && !["t", "id"].includes(sortKey) ? "t" : sortKey, dir: "desc" };
  const nSig = num(fdr.nSignificant);

  return (
    <Panel title={`Signal report card · ${sigs.length} signals`} pad={10}
      right={<span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>{obj(rc).target ? `target ${rc.target} · ` : ""}{num(fdr.q) != null ? `BH q=${fx(fdr.q, 2)} · ` : ""}{nSig != null ? `${nSig} significant · ` : ""}built {ago(obj(rc).built)}</span>}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 130px), 1fr))", gap: 6, marginBottom: 8 }}>
        {famStats.map(f => (
          <div key={f.f} onClick={() => setFam(x => (x === f.f ? "all" : f.f))} className="de-card" style={{ background: fam === f.f ? "#0f1824" : C.inset, border: `1px solid ${fam === f.f ? C.blue : C.border}`, borderRadius: 6, padding: "6px 8px", cursor: "pointer", fontFamily: MONO }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: C.dim, letterSpacing: 1, textTransform: "uppercase" }}><span>{f.f}</span><span>{f.keep}/{f.n} keep</span></div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
              <div style={{ flex: 1, height: 5, background: C.panel, borderRadius: 2, position: "relative" }}><div style={{ position: "absolute", left: "50%", top: -1, bottom: -1, width: 1, background: C.faint }} />{f.ic != null && <div style={{ position: "absolute", top: 0, bottom: 0, [f.ic >= 0 ? "left" : "right"]: "50%", width: Math.min(50, (Math.abs(f.ic) / Math.max(0.02, ...famStats.map(z => Math.abs(z.ic ?? 0)))) * 50) + "%", background: divColor(f.ic * 12), borderRadius: 1 }} />}</div>
              <span style={{ fontSize: 10, color: colorSign(f.ic), width: 46, textAlign: "right" }}>{snum(f.ic, 3)}</span>
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim, letterSpacing: 1.2, width: 54 }}>VERDICT</span>
        <Btn small active={verdict === "all"} onClick={() => setVerdict("all")}>all {sigs.length}</Btn>
        {VERDICT_ORDER.filter(v => verds[v]).map(v => <Btn small key={v} active={verdict === v} color={VERDICT[v].c} onClick={() => setVerdict(x => (x === v ? "all" : v))}>{VERDICT[v].l.toLowerCase()} {verds[v]}</Btn>)}
      </div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
        <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim, letterSpacing: 1.2, width: 54 }}>FAMILY</span>
        <Btn small active={fam === "all"} onClick={() => setFam("all")}>all</Btn>
        {Object.keys(fams).sort().map(f => <Btn small key={f} active={fam === f} onClick={() => setFam(x => (x === f ? "all" : f))}>{f} {fams[f]}</Btn>)}
        <span style={{ flex: 1 }} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="search id" aria-label="search signal id" style={{ ...inputStyle, width: narrow ? 110 : 140 }} />
        <select value={sortKey} onChange={e => setSortKey(e.target.value)} aria-label="sort" style={inputStyle}>
          {SORTS.map(([k, l]) => <option key={k} value={k}>sort: {l}</option>)}
        </select>
      </div>
      <Table key={sortKey + (narrow ? ":n" : ":w")} dense maxHeight={520} rows={rows} rowKey={s => s.id} initialSort={initialSort} cols={cols}
        onRowClick={s => setSel(x => (x === s.id ? null : s.id))} empty="no signals match the filter" />
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", fontFamily: MONO, fontSize: 9, color: C.dim, marginTop: 6 }}>
        <span>{rows.length} shown · click a row for detail</span>
        {!narrow && regimeLabels.length > 0 && <span>regime bars (left→right): {regimeLabels.join(" · ")}</span>}
        <span>IC = per-date Spearman, averaged (Fama–MacBeth) · t uses Newey–West HAC, lag = horizon · invert candidates are reported only, never auto-applied</span>
      </div>
      {selected && <SignalDetail s={selected} labels={regimeLabels} rmax={rmax} mult={maskMap ? num(maskMap[selected.id]) : null} onClose={() => setSel(null)} />}
    </Panel>
  );
}

// ─── Tab ─────────────────────────────────────────────────────────────────────
export default function LabTab({ defaultHorizon }) {
  const [horizon, setHorizon] = useState(() => { try { return localStorage.getItem("de.lab.hz") || defaultHorizon || "swing"; } catch { return defaultHorizon || "swing"; } });
  useEffect(() => { try { localStorage.setItem("de.lab.hz", horizon); } catch {} }, [horizon]);
  const [ref, W] = useMeasure();
  const narrow = W > 0 && W < 720;
  const [now, setNow] = useState(Date.now());
  const [kick, setKick] = useState(0); // poll fast for a while after POST /run
  const [busy, setBusy] = useState(null);
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (!msg) return; const t = setTimeout(() => setMsg(null), 9000); return () => clearTimeout(t); }, [msg]);

  const hq = encodeURIComponent(horizon);
  const [fastUntil, setFastUntil] = useState(0);
  const [pollFast, setPollFast] = useState(false);
  const status = useSoft("/api/lab/status", { interval: pollFast ? 3000 : 15000 });
  const s = status.data;
  const running = isRunning(s);
  const cycles = useSoft(`/api/lab/cycles?horizon=${hq}`, { interval: running ? 10000 : 60000 });
  const registry = useSoft(`/api/lab/registry?horizon=${hq}`, {});
  const card = useSoft(`/api/lab/report-card?horizon=${hq}`, {});
  useEffect(() => { setPollFast(running || now < fastUntil); }, [running, now, fastUntil]);
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), pollFast ? 1000 : 5000); return () => clearInterval(t); }, [pollFast]);

  // When a cycle finishes, refresh everything it may have changed.
  const was = useRef(false);
  useEffect(() => {
    if (was.current && !running) { cycles.reload(); registry.reload(); card.reload(); }
    was.current = running;
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const regEntries = useMemo(() => {
    const d = registry.data;
    return byHorizon(flattenEntries(d?.history ?? d?.entries ?? d?.registry ?? d), horizon);
  }, [registry.data, horizon]);
  const cycleList = useMemo(() => byHorizon(cyclesOf(cycles.data).map(c => ({ ...c })), horizon), [cycles.data, horizon]);
  const champs = useMemo(() => resolveChampions(s, regEntries, horizon), [s, regEntries, horizon]);
  const drift = useMemo(() => resolveDrift(s, horizon), [s, horizon]);
  const champCount = SLOTS.filter(sl => champs[sl.key]).length;
  const so = obj(s);
  const hzObj = obj(obj(so.horizons)[horizon]);
  const last = obj(hzObj.lastReport ?? cycleList[0] ?? so.lastReport ?? so.last ?? so.lastCycle);
  const lossPts = useMemo(() => lossPoints(regEntries, cycleList), [regEntries, cycleList]);
  const metaEntry = champs.meta || null;
  const metaMetrics = metaEntry ? Mx(metaEntry) : Mx(arr(cycleList[0]?.challengers).find(c => splitKey(c?.kind || "").kind === "meta" || c?.kind === "meta"));
  const metaRows = pcRows(metaMetrics);
  const metaThr = thrVals(champs.thresholds).metaThr ?? thrVals({ model: so.thresholds ?? last.thresholds }).metaThr ?? num(metaEntry?.threshold ?? obj(metaEntry?.model).threshold);

  const loaded = s !== undefined && cycles.data !== undefined && card.data !== undefined && registry.data !== undefined;
  const nothing = loaded && !s && !cycleList.length && !sigList(card.data).length && !regEntries.length;

  const onRun = async () => {
    setBusy("run");
    const r = await softPost("/api/lab/run", { horizon });
    setBusy(null);
    if (r.ok && r.data?.started !== false) { setMsg({ text: `▶ cycle started for ${horizon} — this page polls every 3s while it runs`, color: C.up }); setFastUntil(Date.now() + 30000); status.reload(); }
    else if (r.ok) setMsg({ text: `not started: ${r.data?.reason || r.data?.error || "a cycle is already running"}`, color: C.amber });
    else setMsg({ text: r.missing ? "POST /api/lab/run isn't available on this server yet (404). The integrator is still wiring /api/lab/*." : `run failed: ${r.msg}`, color: r.missing ? C.amber : C.down });
  };
  const onRollback = async (slot) => {
    setBusy("rb:" + slot.key);
    const r = await softPost("/api/lab/rollback", { horizon, kind: slot.kind, ...(slot.target ? { target: slot.target } : {}) });
    setBusy(null);
    if (r.ok) { setMsg({ text: `↶ ${slot.kind}${slot.target ? "·" + slot.target : ""} rolled back${r.data?.version != null ? ` → ${vlabel(r.data.version)}` : r.data?.champion?.version != null ? ` → ${vlabel(r.data.champion.version)}` : ""}`, color: C.up }); status.reload(); registry.reload(); cycles.reload(); }
    else setMsg({ text: r.missing ? "POST /api/lab/rollback isn't available on this server yet (404)." : `rollback failed: ${r.msg}`, color: r.missing ? C.amber : C.down });
  };

  return (
    <div ref={ref} style={{ display: "grid", gap: 10 }}>
      <StatusHeader s={s} missing={s === null} horizon={horizon} setHorizon={setHorizon} running={running} onRun={onRun} busy={busy} msg={msg}
        now={now} drift={drift} champCount={champCount} last={Object.keys(last).length ? last : null} narrow={narrow} />
      {status.err && <ErrorBox err={"status: " + status.err} onRetry={status.reload} />}

      {!loaded && <Loading label="lab" />}
      {nothing && (
        <Panel pad={18} style={{ borderStyle: "dashed", borderColor: C.borderHi }}>
          <div style={{ textAlign: "center", fontFamily: MONO, color: C.sub, fontSize: 12, lineHeight: 1.7 }}>
            <div style={{ fontSize: 22, color: C.faint, marginBottom: 4 }}>◇</div>
            <b style={{ color: C.text }}>No data yet: run a cycle.</b><br />
            <span style={{ fontSize: 10.5, color: C.dim }}>A cycle builds the point-in-time panel dataset, scores every signal (IC report card), trains challenger stackers for y / yEx / tbLong,<br />trains a meta-labeler, tunes thresholds, and promotes a challenger only when it beats the champion out of sample.</span>
            <div style={{ marginTop: 12 }}><Btn active color={C.violet} onClick={onRun} disabled={busy === "run"}>{busy === "run" ? "STARTING…" : "▶ RUN FIRST CYCLE"}</Btn></div>
          </div>
        </Panel>
      )}

      {loaded && !nothing && <>
        <Panel title={`Champion models · ${horizon}`} pad={10} right={<span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>OOS metrics vs the calibrated v1 baseline, on the same rows · promotion needs DM p &lt; 0.10</span>}>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${W >= 1760 ? 6 : W >= 900 ? 3 : W >= 560 ? 2 : 1}, minmax(0, 1fr))`, gap: 8 }}>
            {SLOTS.map(sl => <ChampionCard key={sl.key} slot={sl} e={champs[sl.key]} onRollback={onRollback} busy={busy} horizon={horizon} />)}
          </div>
        </Panel>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 10 }}>
          <Panel title="Stacker OOS log-loss by version" pad={10} right={registry.err ? <Tag color={C.down}>registry: {registry.err}</Tag> : <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>line = champion · dots = every challenger</span>}>
            <LossChart points={lossPts} />
          </Panel>
          <Panel title="Meta-labeler · precision vs coverage" pad={10} right={<span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}>{metaEntry ? `champion ${vlabel(metaEntry.version)}` : metaRows.length ? "latest challenger" : ""}{num(mAUC(metaMetrics)) != null ? ` · AUC ${fx(mAUC(metaMetrics), 3)}` : ""}</span>}>
            <PCCurve rows={metaRows} current={metaThr} />
            {metaRows.length > 0 && <div style={{ fontFamily: MONO, fontSize: 9, color: C.dim, marginTop: 4, lineHeight: 1.5 }}>
              Each dot is a meta-P threshold. Higher thresholds trade coverage (share of primary calls taken) for precision (share whose bracket return beats costs).
              {metaThr != null ? ` The live threshold ${fx(metaThr, 2)} is ringed.` : ""}
            </div>}
          </Panel>
        </div>

        <Panel title={`Cycle history · ${cycleList.length}`} pad={10} right={cycles.err ? <Tag color={C.down}>{cycles.err}</Tag> : <span style={{ fontFamily: MONO, fontSize: 9, color: C.dim }}><span style={{ color: C.up }}>✓</span> promoted <span style={{ color: C.down }}>✗</span> rejected</span>}>
          <Timeline cycles={cycleList} narrow={narrow} now={now} />
        </Panel>

        <ReportCard rc={card.data} loading={card.loading} err={card.err} reload={card.reload} mask={maskSummary(champs.mask)} narrow={narrow} />
      </>}
    </div>
  );
}
