// Versioned champion / challenger model registry (docs/CONTRACT-v2.md §5, registry.js).
//
// Persistence: db.saveModel / db.loadModel (sql.js model_state table).
//   registry:<horizon>  { v, horizon, entries: Entry[], lineage: { slot: [versions promoted, oldest→newest] }, decisions: [...] }
//   registry:_meta      { seq, version, horizons }   seq = last entry version handed out (global,
//                       monotonically increasing across horizons, so promote(version) is unambiguous);
//                       version = change counter bumped on every promotion or rollback (the engine
//                       polls registry.version() to hot-reload champions).
//
// Entry: { version, ts, horizon, kind: "stacker"|"meta"|"mask"|"thresholds", target, metrics,
//          trainedThrough, dataHash, model, status: "champion"|"challenger"|"retired", promotedAt,
//          reason, ...extra (baseRate, calibration, threshold, trainOpts, cycleTs, …) }
//   kind "mask":       model = { [signalId]: multiplier }
//   kind "thresholds": model = { MIN_CONFIDENCE?, MIN_PROB_EDGE?, metaThreshold? }
//   kind stacker/meta: model = Stacker / MetaLabeler toJSON()
//
// Champion identity ("slot"): stackers are keyed by (kind, target) with target ∈ {y, yEx, tbLong}
// (default "y"), so several stackers can be champions at once; meta / mask / thresholds have one
// champion per horizon and ignore target.
//
// Rules:
//   • versions are handed out by a global, monotonically increasing sequence;
//   • promote() retires the slot's current champion ("superseded by vN") and pushes onto the slot's
//     lineage; rollback() retires the current champion and restores the previous one in the lineage;
//   • a rejected challenger is retired with its reason; its model JSON is dropped (metrics kept) —
//     only champions and former champions keep model JSON (rollback targets);
//   • at most maxHistory entries are kept per (horizon, kind); pruning removes rejected challengers
//     first, then the oldest former champions, and NEVER a current champion (nor a challenger that
//     is still awaiting its decision);
//   • every promote / reject / rollback is appended to the decision log with its reason.
"use strict";

const crypto = require("crypto");

const KINDS = Object.freeze(["stacker", "meta", "mask", "thresholds"]);
const STACKER_TARGETS = Object.freeze(["y", "yEx", "tbLong"]);
const DEFAULT_MAX_HISTORY = 30;
const MAX_DECISIONS = 500;
const META_KEY = "registry:_meta";

const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));
const targetOf = (kind, target) => (kind === "stacker" ? (target || "y") : null);
const slotOf = (kind, target) => (kind === "stacker" ? `stacker|${target || "y"}` : kind);
const isoNow = (now) => new Date(now()).toISOString();

/** A Map-backed store with the db.saveModel / loadModel interface (tests, tools). */
function createMemoryStore() {
  const m = new Map();
  return {
    saveModel: (k, v) => { m.set(k, JSON.stringify(v)); },
    loadModel: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null),
    _map: m,
  };
}

/**
 * sha256 of the dataset rows a model was trained / evaluated on (asset, time, pRaw, signals,
 * family aggregates, labels). Streams row by row, so a 50k-row panel never becomes one string.
 */
function hashRows(rows) {
  const h = crypto.createHash("sha256");
  let n = 0;
  for (const r of rows || []) {
    if (!r) continue;
    h.update(JSON.stringify([r.assetId, r.t, r.pRaw, r.sig || null, r.fam || null, r.lab || null]));
    h.update("\n");
    n++;
  }
  h.update(`n=${n}`);
  return h.digest("hex");
}

function createRegistry({ store, maxHistory = DEFAULT_MAX_HISTORY, maxDecisions = MAX_DECISIONS, now = () => Date.now() } = {}) {
  const getStore = () => store || require("../db");
  const cache = new Map();   // horizon -> blob (write-through)
  let meta = null;

  function loadMeta() {
    if (!meta) {
      const m = getStore().loadModel(META_KEY);
      meta = m && typeof m === "object" ? { seq: Number(m.seq) || 0, version: Number(m.version) || 0, horizons: Array.isArray(m.horizons) ? m.horizons : [] }
        : { seq: 0, version: 0, horizons: [] };
    }
    return meta;
  }
  const saveMeta = () => getStore().saveModel(META_KEY, meta);

  function blob(horizon) {
    if (!horizon || typeof horizon !== "string") throw new Error("registry: horizon required");
    let b = cache.get(horizon);
    if (!b) {
      const raw = getStore().loadModel(`registry:${horizon}`);
      b = raw && typeof raw === "object" && Array.isArray(raw.entries)
        ? { v: 1, horizon, entries: raw.entries, lineage: raw.lineage || {}, decisions: raw.decisions || [] }
        : { v: 1, horizon, entries: [], lineage: {}, decisions: [] };
      cache.set(horizon, b);
    }
    return b;
  }
  const save = (horizon) => getStore().saveModel(`registry:${horizon}`, cache.get(horizon));

  const championIn = (b, slot) => b.entries.find((e) => e.status === "champion" && slotOf(e.kind, e.target) === slot) || null;

  function find(version, horizon) {
    const v = Number(version);
    const hs = horizon ? [horizon] : loadMeta().horizons;
    for (const h of hs) {
      const b = blob(h);
      const e = b.entries.find((x) => x.version === v);
      if (e) return { b, e };
    }
    return null;
  }

  function logDecision(horizon, d) {
    const b = blob(horizon);
    b.decisions.push({ ts: isoNow(now), ...d });
    if (b.decisions.length > maxDecisions) b.decisions.splice(0, b.decisions.length - maxDecisions);
    save(horizon);
  }

  function prune(b, kind) {
    const all = b.entries.filter((e) => e.kind === kind);
    let excess = all.length - maxHistory;
    if (excess <= 0) return [];
    // deletion order: never-promoted entries first (oldest first), then former champions (oldest
    // first). Current champions and still-pending challengers are never deleted.
    const cands = all.filter((e) => e.status === "retired")
      .sort((a, c) => (a.promotedAt ? 1 : 0) - (c.promotedAt ? 1 : 0) || a.version - c.version);
    const drop = new Set();
    for (const e of cands) { if (excess <= 0) break; drop.add(e.version); excess--; }
    b.entries = b.entries.filter((e) => !drop.has(e.version));
    for (const k of Object.keys(b.lineage)) b.lineage[k] = b.lineage[k].filter((v) => !drop.has(v));
    return [...drop];
  }

  // ── public API ──

  /** Current champion of (horizon, kind[, target]) — a deep copy — or null. */
  function champion(horizon, kind, target) {
    if (!KINDS.includes(kind)) return null;
    return clone(championIn(blob(horizon), slotOf(kind, target)));
  }

  /** { stacker: { y, yEx, tbLong }, meta, mask, thresholds } without model JSON. */
  function champions(horizon) {
    const b = blob(horizon);
    const lite = (e) => (e ? (({ model, ...rest }) => ({ ...clone(rest), hasModel: model != null }))(e) : null);
    const out = { stacker: {} };
    for (const t of STACKER_TARGETS) out.stacker[t] = lite(championIn(b, slotOf("stacker", t)));
    for (const k of ["meta", "mask", "thresholds"]) out[k] = lite(championIn(b, k));
    return out;
  }

  /** Register a challenger. Assigns version / ts / status. Returns the stored entry (copy). */
  function propose(entry) {
    if (!entry || typeof entry !== "object") throw new Error("registry.propose: entry required");
    const { horizon, kind } = entry;
    if (!horizon) throw new Error("registry.propose: entry.horizon required");
    if (!KINDS.includes(kind)) throw new Error(`registry.propose: kind must be one of ${KINDS.join("|")}`);
    if (kind === "stacker" && entry.target && !STACKER_TARGETS.includes(entry.target)) throw new Error(`registry.propose: stacker target must be one of ${STACKER_TARGETS.join("|")}`);
    const m = loadMeta();
    const b = blob(horizon);
    m.seq += 1;
    if (!m.horizons.includes(horizon)) m.horizons.push(horizon);
    const e = {
      ...clone(entry),
      version: m.seq, ts: isoNow(now), horizon, kind, target: targetOf(kind, entry.target ?? null),
      metrics: clone(entry.metrics ?? null), trainedThrough: entry.trainedThrough ?? null, dataHash: entry.dataHash ?? null,
      model: clone(entry.model ?? null), status: "challenger", promotedAt: null, reason: entry.reason || "proposed",
    };
    b.entries.push(e);
    prune(b, kind);
    saveMeta(); save(horizon);
    return clone(e);
  }

  /** Promote an entry (any status) to champion of its slot. Bumps version(). */
  function promote(version, reason = "promoted", horizon) {
    const f = find(version, horizon);
    if (!f) throw new Error(`registry.promote: version ${version} not found`);
    const { b, e } = f;
    if (e.status === "champion") return clone(e);
    if (e.model == null) throw new Error(`registry.promote: version ${version} has no model (rejected entries drop their model)`);
    const slot = slotOf(e.kind, e.target);
    const cur = championIn(b, slot);
    const ts = isoNow(now);
    if (cur) { cur.status = "retired"; cur.retiredAt = ts; cur.reason = `superseded by v${e.version}`; }
    e.status = "champion"; e.promotedAt = ts; e.reason = reason;
    (b.lineage[slot] ||= []).push(e.version);
    const m = loadMeta();
    m.version += 1;
    b.decisions.push({ ts, action: "promote", version: e.version, kind: e.kind, target: e.target, replaced: cur ? cur.version : null, reason });
    if (b.decisions.length > maxDecisions) b.decisions.splice(0, b.decisions.length - maxDecisions);
    prune(b, e.kind);
    saveMeta(); save(b.horizon);
    return clone(e);
  }

  /** Record a rejected challenger: retired with its reason, model JSON dropped (unless keepModel). */
  function reject(version, reason = "rejected", { horizon, keepModel = false } = {}) {
    const f = find(version, horizon);
    if (!f) throw new Error(`registry.reject: version ${version} not found`);
    const { b, e } = f;
    if (e.status === "champion") throw new Error(`registry.reject: version ${version} is the champion`);
    e.status = "retired"; e.rejectedAt = isoNow(now); e.reason = reason;
    if (!keepModel) { e.model = null; e.modelDropped = true; }
    b.decisions.push({ ts: e.rejectedAt, action: "reject", version: e.version, kind: e.kind, target: e.target, reason });
    if (b.decisions.length > maxDecisions) b.decisions.splice(0, b.decisions.length - maxDecisions);
    save(b.horizon);
    return clone(e);
  }

  /** Retire the slot's champion and restore the previous one. Bumps version(). */
  function rollback(horizon, kind, target) {
    if (!KINDS.includes(kind)) throw new Error(`registry.rollback: kind must be one of ${KINDS.join("|")}`);
    const b = blob(horizon);
    const slot = slotOf(kind, target);
    const cur = championIn(b, slot);
    if (!cur) throw new Error(`registry.rollback: no ${slot} champion for ${horizon}`);
    const line = (b.lineage[slot] || []).filter((v) => v !== cur.version);
    let prev = null;
    while (line.length) {
      const cand = b.entries.find((e) => e.version === line[line.length - 1]);
      if (cand && cand.model != null) { prev = cand; break; }
      line.pop();
    }
    if (!prev) throw new Error(`registry.rollback: no previous ${slot} champion to restore for ${horizon}`);
    const ts = isoNow(now);
    cur.status = "retired"; cur.retiredAt = ts; cur.rolledBackAt = ts; cur.reason = `rolled back to v${prev.version}`;
    prev.status = "champion"; prev.restoredAt = ts; prev.reason = `restored by rollback of v${cur.version}`;
    b.lineage[slot] = line;
    const m = loadMeta();
    m.version += 1;
    b.decisions.push({ ts, action: "rollback", version: prev.version, kind, target: targetOf(kind, target), replaced: cur.version, reason: `rollback: v${cur.version} → v${prev.version}` });
    if (b.decisions.length > maxDecisions) b.decisions.splice(0, b.decisions.length - maxDecisions);
    saveMeta(); save(horizon);
    return { restored: clone(prev), retired: clone(cur) };
  }

  /** Entries newest first, model JSON stripped (hasModel flag instead). opts: { kind, target, limit, includeModel }. */
  function history(horizon, { kind, target, limit, includeModel = false } = {}) {
    const b = blob(horizon);
    let es = b.entries.slice().sort((a, c) => c.version - a.version);
    if (kind) es = es.filter((e) => e.kind === kind);
    if (kind === "stacker" && target) es = es.filter((e) => e.target === target);
    if (limit) es = es.slice(0, limit);
    return es.map((e) => (includeModel ? clone(e) : (({ model, ...rest }) => ({ ...clone(rest), hasModel: model != null }))(e)));
  }

  /** Promotion / rejection / rollback log, newest first. */
  function decisions(horizon, { limit = 100 } = {}) {
    return clone(blob(horizon).decisions.slice(-limit).reverse());
  }

  /** Change counter: bumps on every promotion and rollback. */
  function version() { return loadMeta().version; }

  /** Drop in-memory caches (e.g. after the underlying db was re-initialised). */
  function reload() { cache.clear(); meta = null; }

  return { champion, champions, propose, promote, reject, rollback, history, decisions, version, logDecision, reload,
    get maxHistory() { return maxHistory; } };
}

const defaultRegistry = createRegistry();

module.exports = {
  champion: (...a) => defaultRegistry.champion(...a),
  champions: (...a) => defaultRegistry.champions(...a),
  propose: (...a) => defaultRegistry.propose(...a),
  promote: (...a) => defaultRegistry.promote(...a),
  reject: (...a) => defaultRegistry.reject(...a),
  rollback: (...a) => defaultRegistry.rollback(...a),
  history: (...a) => defaultRegistry.history(...a),
  decisions: (...a) => defaultRegistry.decisions(...a),
  version: (...a) => defaultRegistry.version(...a),
  logDecision: (...a) => defaultRegistry.logDecision(...a),
  reload: () => defaultRegistry.reload(),
  defaultRegistry, createRegistry, createMemoryStore, hashRows, slotOf,
  KINDS, STACKER_TARGETS, DEFAULT_MAX_HISTORY,
};
