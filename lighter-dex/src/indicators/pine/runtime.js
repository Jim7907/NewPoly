// Pine Script interpreter: runs the AST once per candle, like TradingView.
//
// - `na` is NaN; comparisons involving na are false.
// - Every ta.* call site keeps its own state across bars (keyed by call path + node id),
//   so user functions that call ta.* behave like Pine (one state per call site).
// - `x[n]` reads the value x had at the end of bar (current - n).
// Output: { title, overlay, plots, levels, signals, inputs } (see runPine).
import { PineError, parsePine } from './parser.js';

const MAX_STEPS = 3_000_000;
const MAX_LOOP = 10_000;

const isNa = (v) => v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v));
const num = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === null || v === undefined ? NaN : Number(v));
const truthy = (v) => (typeof v === 'boolean' ? v : typeof v === 'number' ? !Number.isNaN(v) && v !== 0 : !!v);

const COLORS = {
  'color.red': '#F23645', 'color.green': '#089981', 'color.blue': '#2962FF', 'color.orange': '#FF9800',
  'color.yellow': '#FFEB3B', 'color.purple': '#9C27B0', 'color.white': '#FFFFFF', 'color.black': '#363A45',
  'color.gray': '#787B86', 'color.silver': '#B2B5BE', 'color.teal': '#089981', 'color.aqua': '#00BCD4',
  'color.lime': '#00E676', 'color.maroon': '#880E4F', 'color.navy': '#311B92', 'color.olive': '#808000',
  'color.fuchsia': '#E040FB',
};
// Namespaced constants we accept and return as their own name (styles, shapes, etc.).
const CONST_NS = /^(plot\.style_|shape\.|location\.|size\.|display\.|hline\.style_|line\.style_|label\.style_|extend\.|position\.|text\.|font\.|xloc\.|yloc\.|format\.|scale\.|barmerge\.|currency\.|order\.|alert\.freq_|plot\.linestyle_)/;
// Drawing / cosmetic functions we accept and ignore so imported scripts still run.
const IGNORED = /^(fill|bgcolor|barcolor|plotcandle|plotbar|alert|log\.\w+|runtime\.log|line\.\w+|label\.\w+|box\.\w+|table\.\w+|linefill\.\w+|polyline\.\w+|matrix\.\w+|map\.\w+|max_bars_back|strategy\.cancel|strategy\.cancel_all|strategy\.risk\.\w+)$/;

/** A Pine `array<T>`. A class (not a bare JS array) so it is never mistaken for a tuple. */
class PineArray {
  constructor(items = []) { this.a = items; }
}
const ORDER_DESC = 'order.descending';

/** Seconds in a timeframe string: TradingView style ("15", "60", "1D", "1W") or app style ("15m", "1h"). */
function tfSeconds(tf) {
  const m = String(tf ?? '').trim().match(/^(\d*)\s*([smhdDwWM]?)$/);
  if (!m) return NaN;
  const k = m[1] === '' ? 1 : Number(m[1]);
  const unit = { s: 1, m: 60, h: 3600, d: 86400, D: 86400, w: 604800, W: 604800, M: 2592000, '': 60 }[m[2]];
  return k * unit;
}

/** str.tostring(value, format): supports "#.##", "0.00", format.mintick / percent / volume. */
function formatNumber(v, fmt, priceDecimals) {
  if (typeof v !== 'number') return String(v);
  if (Number.isNaN(v)) return 'NaN';
  if (fmt === 'format.mintick') return v.toFixed(priceDecimals);
  if (fmt === 'format.percent') return `${v.toFixed(2)}%`;
  if (fmt === 'format.volume') {
    const a = Math.abs(v);
    return a >= 1e9 ? `${(v / 1e9).toFixed(3)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(3)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(3)}K` : String(v);
  }
  if (typeof fmt === 'string' && /[#0]/.test(fmt)) {
    const dec = fmt.split('.')[1] ?? '';
    const fixed = (dec.match(/0/g) ?? []).length;
    const opt = (dec.match(/#/g) ?? []).length;
    let s = v.toFixed(fixed + opt);
    if (opt) s = s.replace(new RegExp(`0{1,${opt}}$`), '').replace(/\.$/, '');
    return `${s}${fmt.endsWith('%') ? '%' : ''}`;
  }
  return String(v);
}

function hexToRgba(hex, transp = 0) {
  const h = String(hex).replace('#', '');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return hex;
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, 1 - Number(transp || 0) / 100));
  return `rgba(${r},${g},${b},${a})`;
}

const SIGNAL_WORDS = [
  [/\b(buy|long|bull(ish)?)\b/i, 'long'],
  [/\b(sell|short|bear(ish)?)\b/i, 'short'],
  [/\b(exit|close|flat)\b/i, 'exit'],
];
const signalFromText = (txt) => {
  for (const [re, s] of SIGNAL_WORDS) if (re.test(String(txt ?? ''))) return s;
  return null;
};

class Break {}
class Continue {}

/**
 * Runs a Pine script over candles.
 * @param inputValues overrides keyed by input variable name (or title)
 * @param opts { priceDecimals, resolution, ticker }
 */
export function runPine(source, candles, inputValues = {}, opts = {}) {
  const ast = typeof source === 'string' ? parsePine(source) : source;
  const n = candles.length;
  const out = {
    title: null,
    overlay: false,
    isStrategy: false,
    plots: new Map(), // nodeId -> { title, color, style, values }
    levels: [],
    signals: new Array(n).fill(null),
    hasSignals: false,
    inputs: [],
  };

  // precomputed series-variable builtins
  const tr = candles.map((c, i) => (i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close))));
  const obv = [];
  const vwap = [];
  {
    let o = 0, day = null, pv = 0, vv = 0;
    candles.forEach((c, i) => {
      if (i > 0) o += c.close > candles[i - 1].close ? c.volume : c.close < candles[i - 1].close ? -c.volume : 0;
      obv.push(o);
      const d = Math.floor(c.time / 86400);
      if (d !== day) { day = d; pv = 0; vv = 0; }
      pv += ((c.high + c.low + c.close) / 3) * c.volume; vv += c.volume;
      vwap.push(vv ? pv / vv : NaN);
    });
  }

  const st = {
    bar: 0,
    steps: 0,
    state: new Map(), // per-call-site state for ta.* and history buffers
    hist: new Map(), // variable key -> array of values per bar
    varStore: new Map(), // `var` declarations: key -> value
    funcs: new Map(),
    position: 0,
    pendingPosition: null,
    declName: null,
    initialCapital: 1e6, // TradingView's default
  };

  /** Calendar parts of a UNIX-ms time in a Pine timezone ("UTC", "GMT+2", "America/New_York"). */
  const timeParts = (ms, tz) => {
    if (isNa(ms)) return null;
    const d = new Date(ms);
    const z = String(tz ?? 'UTC').trim();
    const off = z.match(/^(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i);
    if (!z || /^(UTC|GMT|Etc\/UTC|Etc\/GMT)$/i.test(z) || off) {
      const shift = off ? (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3] ?? 0)) * 60000 : 0;
      const u = new Date(ms + shift);
      return { year: u.getUTCFullYear(), month: u.getUTCMonth() + 1, day: u.getUTCDate(), dow: u.getUTCDay() + 1, hour: u.getUTCHours(), minute: u.getUTCMinutes(), second: u.getUTCSeconds() };
    }
    try {
      const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        timeZone: z, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: 'numeric', second: 'numeric',
      }).formatToParts(d).map((x) => [x.type, x.value]));
      return {
        year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second,
        dow: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) + 1,
      };
    } catch {
      throw new PineError(`Unknown timezone "${z}"`);
    }
  };

  const seriesVar = (name, bar) => {
    const c = candles[bar];
    if (!c) return NaN;
    switch (name) {
      case 'open': return c.open;
      case 'high': return c.high;
      case 'low': return c.low;
      case 'close': return c.close;
      case 'volume': return c.volume;
      case 'hl2': return (c.high + c.low) / 2;
      case 'hlc3': return (c.high + c.low + c.close) / 3;
      case 'ohlc4': return (c.open + c.high + c.low + c.close) / 4;
      case 'hlcc4': return (c.high + c.low + 2 * c.close) / 4;
      case 'time': case 'time_close': return c.time * 1000;
      case 'bar_index': return bar;
      case 'ta.tr': return tr[bar];
      case 'ta.obv': return obv[bar];
      case 'ta.vwap': return vwap[bar];
      default: return undefined;
    }
  };
  const SOURCES = new Set(['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'hlcc4']);

  // ---------------------------------------------------------------- scopes
  class Scope {
    constructor(parent, path) {
      this.vars = new Map();
      this.parent = parent;
      this.path = path; // call path for history/state keys
    }
    find(name) {
      for (let s = this; s; s = s.parent) if (s.vars.has(name)) return s;
      return null;
    }
  }
  const histKey = (scope, name) => `${scope.path}|${name}`;
  const record = (scope, name, value) => {
    const k = histKey(scope, name);
    let h = st.hist.get(k);
    if (!h) { h = []; st.hist.set(k, h); }
    h[st.bar] = value;
  };

  // ---------------------------------------------------------------- evaluation
  function evalNode(e, scope) {
    if (++st.steps > MAX_STEPS) throw new PineError('Script is too heavy (too many operations)');
    switch (e.type) {
      case 'num': return e.v;
      case 'value': return e.v; // already-evaluated receiver of a method call
      case 'str': return e.v;
      case 'bool': return e.v;
      case 'na': return NaN;
      case 'tuple': return e.items.map((x) => evalNode(x, scope));
      case 'name': return lookup(e, scope);
      case 'ternary': return truthy(evalNode(e.cond, scope)) ? evalNode(e.a, scope) : evalNode(e.b, scope);
      case 'unary': {
        const v = evalNode(e.e, scope);
        if (e.op === 'not') return !truthy(v);
        return e.op === '-' ? -num(v) : num(v);
      }
      case 'bin': return binary(e, scope);
      case 'hist': return history(e, scope);
      case 'call': return call(e, scope);
      case 'mcall': return methodCall(evalNode(e.recv, scope), e.method, e, scope);
      case 'blockExpr': return execStmt(e.stmt, scope, true);
      default: throw new PineError(`Unsupported expression (${e.type})`, e.line);
    }
  }

  function binary(e, scope) {
    if (e.op === 'and') return truthy(evalNode(e.l, scope)) && truthy(evalNode(e.r, scope));
    if (e.op === 'or') return truthy(evalNode(e.l, scope)) || truthy(evalNode(e.r, scope));
    const a = evalNode(e.l, scope);
    const b = evalNode(e.r, scope);
    switch (e.op) {
      case '+':
        if (typeof a === 'string' || typeof b === 'string') return `${isNa(a) ? 'NaN' : a}${isNa(b) ? 'NaN' : b}`;
        return num(a) + num(b);
      case '-': return num(a) - num(b);
      case '*': return num(a) * num(b);
      case '/': return num(a) / num(b);
      case '%': return num(a) % num(b);
    }
    if (isNa(a) || isNa(b)) return false;
    switch (e.op) {
      case '==': return a === b || (typeof a !== 'string' && num(a) === num(b));
      case '!=': return !(a === b || (typeof a !== 'string' && num(a) === num(b)));
      case '<': return num(a) < num(b);
      case '>': return num(a) > num(b);
      case '<=': return num(a) <= num(b);
      case '>=': return num(a) >= num(b);
      default: throw new PineError(`Unknown operator ${e.op}`, e.line);
    }
  }

  function lookup(e, scope) {
    const name = e.name;
    const s = scope.find(name);
    if (s) return s.vars.get(name);
    const sv = seriesVar(name, st.bar);
    if (sv !== undefined) return sv;
    if (COLORS[name]) return COLORS[name];
    switch (name) {
      case 'last_bar_index': return n - 1;
      case 'barstate.islast': return st.bar === n - 1;
      case 'barstate.isfirst': return st.bar === 0;
      case 'barstate.isconfirmed': return st.bar < n - 1;
      case 'barstate.isrealtime': return st.bar === n - 1;
      case 'barstate.ishistory': return st.bar < n - 1;
      case 'barstate.isnew': return true;
      case 'strategy.long': return 'long';
      case 'strategy.short': return 'short';
      case 'strategy.position_size': return st.position;
      case 'strategy.opentrades': return st.position !== 0 ? 1 : 0;
      // The app trades from a strategy's signals and sizes orders from its own settings,
      // so equity is the strategy's initial capital and P&L is not simulated here.
      case 'strategy.equity': case 'strategy.initial_capital': return st.initialCapital;
      case 'strategy.netprofit': case 'strategy.openprofit': case 'strategy.grossprofit': case 'strategy.grossloss': return 0;
      case 'strategy.closedtrades': case 'strategy.wintrades': case 'strategy.losstrades': return 0;
      case 'strategy.percent_of_equity': case 'strategy.fixed': case 'strategy.cash':
      case 'strategy.commission.percent': case 'strategy.commission.cash_per_order': case 'strategy.commission.cash_per_contract':
        return name;
      case 'syminfo.mintick': return 10 ** -(opts.priceDecimals ?? 2);
      case 'syminfo.ticker': case 'syminfo.tickerid': return opts.ticker ?? '';
      case 'timeframe.period': return opts.resolution ?? '';
      case 'timeframe.isintraday': return !/d|w|M/.test(opts.resolution ?? '');
      case 'math.pi': return Math.PI;
      case 'math.e': return Math.E;
      case 'dayofweek': return new Date(candles[st.bar].time * 1000).getUTCDay() + 1;
      case 'hour': return new Date(candles[st.bar].time * 1000).getUTCHours();
      case 'minute': return new Date(candles[st.bar].time * 1000).getUTCMinutes();
    }
    if (CONST_NS.test(name)) return name;
    if (name.startsWith('dayofweek.')) return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(name.slice(10)) + 1;
    throw new PineError(`Unknown variable "${name}"`, e.line);
  }

  function history(e, scope) {
    const off = Math.floor(num(evalNode(e.offset, scope)));
    if (!(off >= 0)) throw new PineError('History offset must be a non-negative number', e.line);
    const target = st.bar - off;
    if (e.e.type === 'name') {
      const name = e.e.name;
      const s = scope.find(name);
      if (s) {
        if (off === 0) return s.vars.get(name);
        const h = st.hist.get(histKey(s, name));
        const v = h?.[target];
        return v === undefined ? NaN : v;
      }
      const sv = seriesVar(name, target);
      if (sv !== undefined || SOURCES.has(name)) return target < 0 ? NaN : sv;
    }
    // any other expression: keep a buffer of its values per bar at this site
    const v = evalNode(e.e, scope);
    const key = `${scope.path}/h${e.id}`;
    let buf = st.state.get(key);
    if (!buf) { buf = []; st.state.set(key, buf); }
    buf[st.bar] = v;
    const r = buf[target];
    return r === undefined ? NaN : r;
  }

  // ---------------------------------------------------------------- statements
  function execBlock(stmts, scope, wantValue = false) {
    let last;
    for (const s of stmts) last = execStmt(s, scope, wantValue);
    return last;
  }

  function assignVar(scope, name, value, line) {
    const s = scope.find(name);
    if (!s) throw new PineError(`"${name}" is not declared (use "=" to declare it first)`, line);
    s.vars.set(name, value);
    record(s, name, value);
    const vk = `${s.path}|var|${name}`;
    if (st.varStore.has(vk)) st.varStore.set(vk, value);
  }

  function execStmt(s, scope, wantValue = false) {
    if (++st.steps > MAX_STEPS) throw new PineError('Script is too heavy (too many operations)');
    switch (s.type) {
      case 'expr': return evalNode(s.e, scope);
      case 'decl': {
        let value;
        if (s.isVar) {
          const vk = `${scope.path}|var|${s.name}`;
          if (!st.varStore.has(vk)) {
            st.declName = s.name;
            st.varStore.set(vk, evalNode(s.e, scope));
            st.declName = null;
          }
          value = st.varStore.get(vk);
        } else {
          st.declName = s.name;
          value = evalNode(s.e, scope);
          st.declName = null;
        }
        scope.vars.set(s.name, value);
        record(scope, s.name, value);
        return value;
      }
      case 'tupleDecl': {
        const v = evalNode(s.e, scope);
        if (!Array.isArray(v)) throw new PineError('Right side does not return a tuple', s.line);
        s.names.forEach((name, i) => {
          if (name === '_') return;
          const x = v[i];
          if (scope.find(name)) assignVar(scope, name, x, s.line);
          else { scope.vars.set(name, x); record(scope, name, x); }
        });
        return v;
      }
      case 'assign': {
        const target = scope.find(s.name);
        if (!target) throw new PineError(`"${s.name}" is not declared (use "=" to declare it first)`, s.line);
        const rhs = evalNode(s.e, scope);
        const cur = target.vars.get(s.name);
        const v = s.op === ':=' ? rhs
          : s.op === '+=' ? (typeof cur === 'string' ? cur + rhs : num(cur) + num(rhs))
            : s.op === '-=' ? num(cur) - num(rhs)
              : s.op === '*=' ? num(cur) * num(rhs)
                : s.op === '/=' ? num(cur) / num(rhs)
                  : num(cur) % num(rhs);
        assignVar(scope, s.name, v, s.line);
        return v;
      }
      case 'if': {
        if (truthy(evalNode(s.cond, scope))) return execBlock(s.then, scope, wantValue);
        if (s.otherwise) return execBlock(s.otherwise, scope, wantValue);
        return wantValue ? NaN : undefined;
      }
      case 'switch': {
        const subj = s.subject ? evalNode(s.subject, scope) : undefined;
        for (const c of s.cases) {
          if (c.test === null) return execBlock(c.body, scope, wantValue);
          const t = evalNode(c.test, scope);
          const hit = s.subject ? (t === subj || (!isNa(t) && !isNa(subj) && num(t) === num(subj) && typeof t !== 'string')) : truthy(t);
          if (hit) return execBlock(c.body, scope, wantValue);
        }
        return wantValue ? NaN : undefined;
      }
      case 'for': {
        const from = num(evalNode(s.from, scope));
        const to = num(evalNode(s.to, scope));
        if (isNa(from) || isNa(to)) return undefined;
        let step = s.step ? Math.abs(num(evalNode(s.step, scope))) : 1;
        if (!(step > 0)) step = 1;
        const dir = to >= from ? 1 : -1;
        let count = 0;
        let last;
        for (let i = from; dir > 0 ? i <= to : i >= to; i += dir * step) {
          if (++count > MAX_LOOP) throw new PineError('Loop runs too many times', s.line);
          scope.vars.set(s.v, i);
          try {
            last = execBlock(s.body, scope, wantValue);
          } catch (x) {
            if (x instanceof Break) break;
            if (x instanceof Continue) continue;
            throw x;
          }
        }
        return last;
      }
      case 'forIn': {
        const src = evalNode(s.src, scope);
        const items = src instanceof PineArray ? src.a : Array.isArray(src) ? src : null;
        if (!items) throw new PineError('"for … in" needs an array', s.line);
        let last;
        // iterate a snapshot length, like Pine (changes to the array's size inside the loop aren't visited)
        const len = items.length;
        if (len > MAX_LOOP) throw new PineError('Loop runs too many times', s.line);
        for (let i = 0; i < len && i < items.length; i++) {
          if (s.idxV) scope.vars.set(s.idxV, i);
          scope.vars.set(s.v, items[i]);
          try {
            last = execBlock(s.body, scope, wantValue);
          } catch (x) {
            if (x instanceof Break) break;
            if (x instanceof Continue) continue;
            throw x;
          }
        }
        return last;
      }
      case 'while': {
        let count = 0;
        let last;
        while (truthy(evalNode(s.cond, scope))) {
          if (++count > MAX_LOOP) throw new PineError('Loop runs too many times', s.line);
          try {
            last = execBlock(s.body, scope, wantValue);
          } catch (x) {
            if (x instanceof Break) break;
            if (x instanceof Continue) continue;
            throw x;
          }
        }
        return last;
      }
      case 'break': throw new Break();
      case 'continue': throw new Continue();
      case 'func':
        st.funcs.set(s.name, s);
        return undefined;
      default: throw new PineError(`Unsupported statement (${s.type})`, s.line);
    }
  }

  // ---------------------------------------------------------------- calls
  function call(e, scope) {
    const name = e.name;
    const user = st.funcs.get(name);
    if (user) return callUser(user, e, scope);
    if (IGNORED.test(name)) return ignoredCall(e, scope);
    const fn = BUILTINS[name];
    if (!fn) {
      // method call on a variable: arr.get(i) -> array.get(arr, i); drawings (tb.cell(...)) are skipped
      const dot = name.lastIndexOf('.');
      const owner = dot > 0 ? scope.find(name.slice(0, dot)) : null;
      if (owner) return methodCall(owner.vars.get(name.slice(0, dot)), name.slice(dot + 1), e, scope);
      throw new PineError(`${name}() is not supported yet`, e.line);
    }
    const key = `${scope.path}/c${e.id}`;
    const A = (i, d) => (e.args[i] !== undefined ? evalNode(e.args[i], scope) : d);
    const N = (k, i, d) => (e.named[k] !== undefined ? evalNode(e.named[k], scope) : e.args[i] !== undefined ? evalNode(e.args[i], scope) : d);
    return fn({ A, N, e, key, scope });
  }

  /** recv.method(args) -> array.method(recv, args) / str.method(recv, args); drawing handles are skipped. */
  function methodCall(recv, method, e, scope) {
    const viaNs = (ns) => call({ ...e, type: 'call', name: `${ns}.${method}`, args: [{ type: 'value', v: recv }, ...e.args] }, scope);
    if (recv instanceof PineArray) {
      if (!BUILTINS[`array.${method}`]) throw new PineError(`array.${method}() is not supported yet`, e.line);
      return viaNs('array');
    }
    if (typeof recv === 'string' && BUILTINS[`str.${method}`]) return viaNs('str');
    return ignoredCall(e, scope); // label / line / box / table handle
  }

  /** Drawing calls are skipped, but their arguments still run (e.g. label.delete(arr.shift())). */
  function ignoredCall(e, scope) {
    for (const x of [...e.args, ...Object.values(e.named)]) {
      try { evalNode(x, scope); } catch (err) { if (!(err instanceof PineError)) throw err; }
    }
    return NaN;
  }

  function callUser(f, e, scope) {
    if (e.args.length > f.params.length) throw new PineError(`${f.name}() takes ${f.params.length} arguments`, e.line);
    const local = new Scope(globalScope, `${scope.path}/${e.id}`);
    f.params.forEach((p, i) => {
      const v = e.named[p.name] !== undefined ? evalNode(e.named[p.name], scope)
        : e.args[i] !== undefined ? evalNode(e.args[i], scope)
          : p.def ? evalNode(p.def, scope) : NaN;
      local.vars.set(p.name, v);
      record(local, p.name, v);
    });
    return execBlock(f.body, local, true);
  }

  // ---------------------------------------------------------------- builtins
  const S = (key, init) => {
    let s = st.state.get(key);
    if (!s) { s = init(); st.state.set(key, s); }
    return s;
  };
  /** Push this bar's value into a per-site buffer (once per bar) and return the buffer. */
  const series = (key, v) => {
    const s = S(key, () => ({ vals: [], bars: [] }));
    if (s.bars[s.bars.length - 1] === st.bar) s.vals[s.vals.length - 1] = v;
    else { s.vals.push(v); s.bars.push(st.bar); }
    return s.vals;
  };
  const windowOf = (vals, len) => (vals.length < len ? null : vals.slice(vals.length - len));
  const sma = (key, v, len) => {
    const w = windowOf(series(key, v), len);
    if (!w || w.some(isNa)) return NaN;
    return w.reduce((a, b) => a + b, 0) / len;
  };
  // Matches TradingView: ta.ema starts from the first value; ta.rma starts from an SMA seed.
  const smooth = (key, v, len, alpha, smaSeed) => {
    const s = S(key, () => ({ prev: NaN, seed: [], lastBar: -1, lastVal: NaN }));
    if (s.lastBar === st.bar) return s.lastVal;
    s.lastBar = st.bar;
    if (isNa(v)) { s.lastVal = s.prev; return s.prev; }
    if (isNa(s.prev)) {
      if (!smaSeed) s.prev = v;
      else {
        s.seed.push(v);
        if (s.seed.length >= len) s.prev = s.seed.slice(-len).reduce((a, b) => a + b, 0) / len;
      }
    } else s.prev = alpha * v + (1 - alpha) * s.prev;
    s.lastVal = s.prev;
    return s.prev;
  };
  const ema = (key, v, len) => smooth(key, v, len, 2 / (len + 1), false);
  const rma = (key, v, len) => smooth(key, v, len, 1 / len, true);
  const wma = (key, v, len) => {
    const w = windowOf(series(key, v), len);
    if (!w || w.some(isNa)) return NaN;
    let s = 0;
    w.forEach((x, i) => { s += x * (i + 1); });
    return s / ((len * (len + 1)) / 2);
  };
  const stdev = (key, v, len) => {
    const w = windowOf(series(key, v), len);
    if (!w || w.some(isNa)) return NaN;
    const m = w.reduce((a, b) => a + b, 0) / len;
    return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / len);
  };
  const prevOf = (key, v) => {
    const s = S(key, () => ({ prev: NaN, cur: NaN, bar: -1 }));
    if (s.bar !== st.bar) { s.prev = s.cur; s.bar = st.bar; }
    s.cur = v;
    return s.prev;
  };
  const C = (bar = st.bar) => candles[bar];
  const lenArg = (v, line) => {
    const l = Math.round(num(v));
    if (!(l >= 1)) throw new PineError('Length must be at least 1', line);
    return l;
  };

  // ---------------------------------------------------------------- arrays
  const arr = (v, e) => {
    if (v instanceof PineArray) return v.a;
    throw new PineError(isNa(v) ? 'Array is na (not created yet)' : 'Expected an array', e.line);
  };
  const idx = (a, i, e) => {
    let k = Math.trunc(num(i));
    if (k < 0) k += a.length; // Pine v6 negative indexes count from the end
    if (!(k >= 0 && k < a.length)) throw new PineError(`Array index ${num(i)} is out of bounds (size ${a.length})`, e.line);
    return k;
  };
  const nums = (a) => a.map(num).filter((x) => !Number.isNaN(x));
  const mean = (x) => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : NaN);
  const newArray = ({ A }) => {
    const size = Math.max(0, Math.round(num(A(0, 0))) || 0);
    const init = A(1, NaN);
    return new PineArray(Array.from({ length: size }, () => init));
  };
  const ARRAY_BUILTINS = {
    'array.new': newArray,
    ...Object.fromEntries(['float', 'int', 'bool', 'string', 'color', 'line', 'label', 'box', 'table', 'linefill'].map((t) => [`array.new_${t}`, newArray])),
    'array.from': ({ e, scope }) => new PineArray(e.args.map((x) => evalNode(x, scope))),
    'array.copy': ({ A, e }) => new PineArray([...arr(A(0), e)]),
    'array.size': ({ A, e }) => arr(A(0), e).length,
    'array.get': ({ A, e }) => { const a = arr(A(0), e); return a[idx(a, A(1), e)]; },
    'array.set': ({ A, e }) => { const a = arr(A(0), e); a[idx(a, A(1), e)] = A(2); return NaN; },
    'array.first': ({ A, e }) => { const a = arr(A(0), e); return a[idx(a, 0, e)]; },
    'array.last': ({ A, e }) => { const a = arr(A(0), e); return a[idx(a, -1, e)]; },
    'array.push': ({ A, e }) => { arr(A(0), e).push(A(1)); return NaN; },
    'array.unshift': ({ A, e }) => { arr(A(0), e).unshift(A(1)); return NaN; },
    'array.pop': ({ A, e }) => { const a = arr(A(0), e); if (!a.length) throw new PineError('Cannot pop from an empty array', e.line); return a.pop(); },
    'array.shift': ({ A, e }) => { const a = arr(A(0), e); if (!a.length) throw new PineError('Cannot shift an empty array', e.line); return a.shift(); },
    'array.insert': ({ A, e }) => { const a = arr(A(0), e); const k = Math.trunc(num(A(1))); if (!(k >= 0 && k <= a.length)) throw new PineError(`Array index ${k} is out of bounds`, e.line); a.splice(k, 0, A(2)); return NaN; },
    'array.remove': ({ A, e }) => { const a = arr(A(0), e); return a.splice(idx(a, A(1), e), 1)[0]; },
    'array.clear': ({ A, e }) => { arr(A(0), e).length = 0; return NaN; },
    'array.fill': ({ A, e }) => {
      const a = arr(A(0), e);
      const from = Math.max(0, Math.trunc(num(A(2, 0))));
      const to = Math.min(a.length, Math.trunc(num(A(3, a.length))));
      for (let i = from; i < to; i++) a[i] = A(1);
      return NaN;
    },
    'array.concat': ({ A, e }) => { const a = arr(A(0), e); a.push(...arr(A(1), e)); return A(0); },
    'array.slice': ({ A, e }) => new PineArray(arr(A(0), e).slice(Math.trunc(num(A(1))), Math.trunc(num(A(2))))),
    'array.reverse': ({ A, e }) => { arr(A(0), e).reverse(); return NaN; },
    'array.sort': ({ A, e }) => {
      const desc = A(1, 'order.ascending') === ORDER_DESC;
      arr(A(0), e).sort((x, y) => (typeof x === 'string' ? String(x).localeCompare(y) : num(x) - num(y)) * (desc ? -1 : 1));
      return NaN;
    },
    'array.sort_indices': ({ A, e }) => {
      const a = arr(A(0), e);
      const desc = A(1, 'order.ascending') === ORDER_DESC;
      return new PineArray(a.map((_, i) => i).sort((x, y) => (num(a[x]) - num(a[y])) * (desc ? -1 : 1)));
    },
    'array.includes': ({ A, e }) => arr(A(0), e).includes(A(1)),
    'array.indexof': ({ A, e }) => arr(A(0), e).indexOf(A(1)),
    'array.lastindexof': ({ A, e }) => arr(A(0), e).lastIndexOf(A(1)),
    'array.join': ({ A, e }) => arr(A(0), e).map((x) => formatNumber(x, null)).join(String(A(1, ''))),
    'array.sum': ({ A, e }) => nums(arr(A(0), e)).reduce((s, v) => s + v, 0),
    'array.avg': ({ A, e }) => mean(nums(arr(A(0), e))),
    'array.max': ({ A, e }) => { const x = nums(arr(A(0), e)).sort((p, q) => q - p); return x[Math.trunc(num(A(1, 0)))] ?? NaN; },
    'array.min': ({ A, e }) => { const x = nums(arr(A(0), e)).sort((p, q) => p - q); return x[Math.trunc(num(A(1, 0)))] ?? NaN; },
    'array.range': ({ A, e }) => { const x = nums(arr(A(0), e)); return x.length ? Math.max(...x) - Math.min(...x) : NaN; },
    'array.median': ({ A, e }) => {
      const x = nums(arr(A(0), e)).sort((p, q) => p - q);
      if (!x.length) return NaN;
      const m = Math.floor(x.length / 2);
      return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
    },
    'array.variance': ({ A, e }) => { const x = nums(arr(A(0), e)); const m = mean(x); return mean(x.map((v) => (v - m) ** 2)); },
    'array.stdev': ({ A, e }) => { const x = nums(arr(A(0), e)); const m = mean(x); return Math.sqrt(mean(x.map((v) => (v - m) ** 2))); },
    'array.abs': ({ A, e }) => new PineArray(arr(A(0), e).map((v) => Math.abs(num(v)))),
    'array.every': ({ A, e }) => arr(A(0), e).every(truthy),
    'array.some': ({ A, e }) => arr(A(0), e).some(truthy),
  };

  const BUILTINS = {
    // --- declarations & inputs
    indicator: ({ N }) => { out.title = N('title', 0, out.title); out.overlay = truthy(N('overlay', 2, false)); return NaN; },
    study: ({ N }) => { out.title = N('title', 0, out.title); out.overlay = truthy(N('overlay', 2, false)); return NaN; },
    strategy: ({ N }) => {
      out.title = N('title', 0, out.title);
      out.overlay = truthy(N('overlay', 2, false));
      out.isStrategy = true;
      const cap = num(N('initial_capital', 99, 1e6));
      if (cap > 0) st.initialCapital = cap;
      return NaN;
    },
    input: (c) => inputFn(c, 'auto'),
    'input.int': (c) => inputFn(c, 'int'),
    'input.float': (c) => inputFn(c, 'float'),
    'input.bool': (c) => inputFn(c, 'bool'),
    'input.string': (c) => inputFn(c, 'string'),
    'input.source': (c) => inputFn(c, 'source'),
    'input.color': (c) => inputFn(c, 'color'),
    'input.timeframe': (c) => inputFn(c, 'string'),
    'input.symbol': (c) => inputFn(c, 'string'),
    'input.session': (c) => inputFn(c, 'string'),
    'input.price': (c) => inputFn(c, 'float'),
    'input.time': (c) => inputFn(c, 'float'),
    'input.text_area': (c) => inputFn(c, 'string'),

    // --- outputs
    plot: ({ A, N, e }) => {
      const v = A(0);
      let p = out.plots.get(e.id);
      if (!p) {
        p = { title: N('title', 1, null), color: null, style: N('style', 99, 'plot.style_line'), values: new Array(n).fill(null) };
        out.plots.set(e.id, p);
      }
      const col = N('color', 2, null);
      if (!p.color && typeof col === 'string') p.color = col;
      p.values[st.bar] = isNa(v) || typeof v !== 'number' ? (typeof v === 'boolean' ? (v ? 1 : 0) : null) : v;
      return e.id;
    },
    hline: ({ A, e }) => {
      if (st.bar === 0) { const v = num(A(0)); if (Number.isFinite(v)) out.levels.push(v); }
      return e.id;
    },
    plotshape: ({ A, N }) => { shapeSignal(A(0), N('title', 1, null) ?? N('text', 99, null)); return NaN; },
    plotchar: ({ A, N }) => { shapeSignal(A(0), N('title', 1, null) ?? N('text', 99, null)); return NaN; },
    plotarrow: ({ A }) => {
      const v = num(A(0));
      if (v > 0) setSignal('long'); else if (v < 0) setSignal('short');
      return NaN;
    },
    alertcondition: ({ A, N }) => {
      if (truthy(A(0))) {
        const sig = signalFromText(N('title', 1, '')) ?? signalFromText(N('message', 2, ''));
        if (sig) setSignal(sig);
      }
      return NaN;
    },
    'strategy.entry': ({ A, N }) => {
      const when = N('when', 99, true);
      if (!truthy(when)) return NaN;
      const dir = N('direction', 1, 'long');
      setSignal(dir === 'short' ? 'short' : 'long', true);
      st.pendingPosition = dir === 'short' ? -1 : 1;
      return NaN;
    },
    'strategy.order': ({ N }) => {
      if (!truthy(N('when', 99, true))) return NaN;
      const dir = N('direction', 1, 'long');
      setSignal(dir === 'short' ? 'short' : 'long', true);
      st.pendingPosition = dir === 'short' ? -1 : 1;
      return NaN;
    },
    'strategy.close': ({ N }) => {
      if (!truthy(N('when', 99, true))) return NaN;
      setSignal('exit');
      if (st.pendingPosition === null) st.pendingPosition = 0;
      return NaN;
    },
    'strategy.close_all': ({ N }) => {
      if (!truthy(N('when', 99, true))) return NaN;
      setSignal('exit');
      if (st.pendingPosition === null) st.pendingPosition = 0;
      return NaN;
    },
    'strategy.exit': () => NaN, // TP/SL come from the bot's settings

    // --- na / math / strings / colors
    na: ({ A }) => isNa(A(0)),
    nz: ({ A }) => { const v = A(0); return isNa(v) ? A(1, 0) : v; },
    fixnan: ({ A, key }) => { const v = A(0); const s = S(key, () => ({ last: NaN })); if (!isNa(v)) s.last = v; return s.last; },
    'math.abs': ({ A }) => Math.abs(num(A(0))),
    'math.max': ({ e, scope }) => Math.max(...e.args.map((x) => num(evalNode(x, scope)))),
    'math.min': ({ e, scope }) => Math.min(...e.args.map((x) => num(evalNode(x, scope)))),
    'math.avg': ({ e, scope }) => { const v = e.args.map((x) => num(evalNode(x, scope))); return v.reduce((a, b) => a + b, 0) / v.length; },
    'math.pow': ({ A }) => num(A(0)) ** num(A(1)),
    'math.sqrt': ({ A }) => Math.sqrt(num(A(0))),
    'math.log': ({ A }) => Math.log(num(A(0))),
    'math.log10': ({ A }) => Math.log10(num(A(0))),
    'math.exp': ({ A }) => Math.exp(num(A(0))),
    'math.sign': ({ A }) => Math.sign(num(A(0))),
    'math.floor': ({ A }) => Math.floor(num(A(0))),
    'math.ceil': ({ A }) => Math.ceil(num(A(0))),
    'math.round': ({ A }) => { const v = num(A(0)); const p = A(1, 0); const f = 10 ** num(p); return Math.round(v * f) / f; },
    'math.round_to_mintick': ({ A }) => { const t = 10 ** -(opts.priceDecimals ?? 2); return Math.round(num(A(0)) / t) * t; },
    'math.sum': ({ A, key, e }) => { const len = lenArg(A(1), e.line); const w = windowOf(series(key, num(A(0))), len); return !w || w.some(isNa) ? NaN : w.reduce((a, b) => a + b, 0); },
    'math.sin': ({ A }) => Math.sin(num(A(0))),
    'math.cos': ({ A }) => Math.cos(num(A(0))),
    'math.tan': ({ A }) => Math.tan(num(A(0))),
    'math.atan': ({ A }) => Math.atan(num(A(0))),
    'math.todegrees': ({ A }) => (num(A(0)) * 180) / Math.PI,
    'math.toradians': ({ A }) => (num(A(0)) * Math.PI) / 180,
    'color.new': ({ A }) => hexToRgba(A(0), A(1, 0)),
    'color.rgb': ({ A }) => `rgba(${num(A(0))},${num(A(1))},${num(A(2))},${1 - num(A(3, 0)) / 100})`,
    color: ({ A }) => A(0),
    int: ({ A }) => Math.trunc(num(A(0))),
    float: ({ A }) => num(A(0)),
    bool: ({ A }) => truthy(A(0)),
    timestamp: () => NaN,

    // --- moving averages & stats
    'ta.sma': ({ A, key, e }) => sma(key, num(A(0)), lenArg(A(1), e.line)),
    'ta.ema': ({ A, key, e }) => ema(key, num(A(0)), lenArg(A(1), e.line)),
    'ta.rma': ({ A, key, e }) => rma(key, num(A(0)), lenArg(A(1), e.line)),
    'ta.wma': ({ A, key, e }) => wma(key, num(A(0)), lenArg(A(1), e.line)),
    'ta.vwma': ({ A, key, e }) => {
      const len = lenArg(A(1), e.line);
      const v = num(A(0));
      const a = sma(`${key}a`, v * C().volume, len);
      const b = sma(`${key}b`, C().volume, len);
      return a / b;
    },
    'ta.hma': ({ A, key, e }) => {
      const len = lenArg(A(1), e.line);
      const v = num(A(0));
      const half = wma(`${key}h`, v, Math.max(1, Math.floor(len / 2)));
      const full = wma(`${key}f`, v, len);
      return wma(`${key}s`, 2 * half - full, Math.max(1, Math.floor(Math.sqrt(len))));
    },
    'ta.stdev': ({ A, key, e }) => stdev(key, num(A(0)), lenArg(A(1), e.line)),
    'ta.variance': ({ A, key, e }) => stdev(key, num(A(0)), lenArg(A(1), e.line)) ** 2,
    'ta.dev': ({ A, key, e }) => {
      const len = lenArg(A(1), e.line);
      const w = windowOf(series(key, num(A(0))), len);
      if (!w || w.some(isNa)) return NaN;
      const m = w.reduce((a, b) => a + b, 0) / len;
      return w.reduce((a, b) => a + Math.abs(b - m), 0) / len;
    },
    'ta.linreg': ({ A, key, e }) => {
      const len = lenArg(A(1), e.line);
      const off = num(A(2, 0));
      const w = windowOf(series(key, num(A(0))), len);
      if (!w || w.some(isNa)) return NaN;
      let sx = 0, sy = 0, sxy = 0, sxx = 0;
      w.forEach((y, i) => { sx += i; sy += y; sxy += i * y; sxx += i * i; });
      const slope = (len * sxy - sx * sy) / (len * sxx - sx * sx);
      const intercept = (sy - slope * sx) / len;
      return intercept + slope * (len - 1 - off);
    },
    'ta.highest': ({ A, key, e }) => {
      const one = e.args.length === 1;
      const src = one ? C().high : num(A(0));
      const len = lenArg(one ? A(0) : A(1), e.line);
      const w = windowOf(series(key, src), len);
      return !w ? NaN : Math.max(...w);
    },
    'ta.lowest': ({ A, key, e }) => {
      const one = e.args.length === 1;
      const src = one ? C().low : num(A(0));
      const len = lenArg(one ? A(0) : A(1), e.line);
      const w = windowOf(series(key, src), len);
      return !w ? NaN : Math.min(...w);
    },
    'ta.highestbars': ({ A, key, e }) => {
      const one = e.args.length === 1;
      const len = lenArg(one ? A(0) : A(1), e.line);
      const w = windowOf(series(key, one ? C().high : num(A(0))), len);
      if (!w) return NaN;
      return w.lastIndexOf(Math.max(...w)) - (len - 1);
    },
    'ta.lowestbars': ({ A, key, e }) => {
      const one = e.args.length === 1;
      const len = lenArg(one ? A(0) : A(1), e.line);
      const w = windowOf(series(key, one ? C().low : num(A(0))), len);
      if (!w) return NaN;
      return w.lastIndexOf(Math.min(...w)) - (len - 1);
    },
    'ta.change': ({ A, key }) => {
      const len = Math.max(1, Math.round(num(A(1, 1))));
      const vals = series(key, A(0));
      const cur = vals[vals.length - 1];
      const old = vals[vals.length - 1 - len];
      if (typeof cur === 'boolean') return old === undefined ? false : cur !== old;
      return old === undefined ? NaN : num(cur) - num(old);
    },
    'ta.mom': ({ A, key, e }) => { const len = lenArg(A(1), e.line); const vals = series(key, num(A(0))); const old = vals[vals.length - 1 - len]; return old === undefined ? NaN : vals[vals.length - 1] - old; },
    'ta.roc': ({ A, key, e }) => { const len = lenArg(A(1), e.line); const vals = series(key, num(A(0))); const old = vals[vals.length - 1 - len]; return old === undefined ? NaN : (100 * (vals[vals.length - 1] - old)) / old; },
    'ta.cum': ({ A, key }) => { const s = S(key, () => ({ sum: 0, bar: -1, prevSum: 0 })); if (s.bar !== st.bar) { s.prevSum = s.sum; s.bar = st.bar; } const v = num(A(0)); s.sum = s.prevSum + (isNa(v) ? 0 : v); return s.sum; },
    'ta.crossover': ({ A, key }) => {
      const a = num(A(0)), b = num(A(1));
      const pa = prevOf(`${key}a`, a), pb = prevOf(`${key}b`, b);
      return !isNa(pa) && !isNa(pb) && a > b && pa <= pb;
    },
    'ta.crossunder': ({ A, key }) => {
      const a = num(A(0)), b = num(A(1));
      const pa = prevOf(`${key}a`, a), pb = prevOf(`${key}b`, b);
      return !isNa(pa) && !isNa(pb) && a < b && pa >= pb;
    },
    'ta.cross': ({ A, key }) => {
      const a = num(A(0)), b = num(A(1));
      const pa = prevOf(`${key}a`, a), pb = prevOf(`${key}b`, b);
      return !isNa(pa) && !isNa(pb) && ((a > b && pa <= pb) || (a < b && pa >= pb));
    },
    'ta.rising': ({ A, key, e }) => { const len = lenArg(A(1), e.line); const w = windowOf(series(key, num(A(0))), len + 1); return !!w && w.every((v, i) => i === 0 || v > w[i - 1]); },
    'ta.falling': ({ A, key, e }) => { const len = lenArg(A(1), e.line); const w = windowOf(series(key, num(A(0))), len + 1); return !!w && w.every((v, i) => i === 0 || v < w[i - 1]); },
    'ta.barssince': ({ A, key }) => { const s = S(key, () => ({ last: -1 })); if (truthy(A(0))) s.last = st.bar; return s.last < 0 ? NaN : st.bar - s.last; },
    'ta.valuewhen': ({ A, key }) => {
      const s = S(key, () => ({ vals: [], bar: -1 }));
      const cond = truthy(A(0));
      const v = A(1);
      const occ = Math.max(0, Math.round(num(A(2, 0))));
      if (s.bar !== st.bar) { s.bar = st.bar; if (cond) s.vals.push(v); }
      const r = s.vals[s.vals.length - 1 - occ];
      return r === undefined ? NaN : r;
    },

    // --- oscillators / volatility
    'ta.rsi': ({ A, key, e }) => {
      const len = lenArg(A(1), e.line);
      const v = num(A(0));
      const p = prevOf(`${key}p`, v);
      const ch = isNa(p) ? NaN : v - p;
      const up = rma(`${key}u`, isNa(ch) ? NaN : Math.max(ch, 0), len);
      const dn = rma(`${key}d`, isNa(ch) ? NaN : Math.max(-ch, 0), len);
      if (isNa(up) || isNa(dn)) return NaN;
      return dn === 0 ? 100 : up === 0 ? 0 : 100 - 100 / (1 + up / dn);
    },
    'ta.macd': ({ A, key }) => {
      const v = num(A(0));
      const f = ema(`${key}f`, v, Math.round(num(A(1, 12))));
      const s = ema(`${key}s`, v, Math.round(num(A(2, 26))));
      const line = f - s;
      const sig = ema(`${key}g`, line, Math.round(num(A(3, 9))));
      return [line, sig, line - sig];
    },
    'ta.bb': ({ A, key, e }) => {
      const v = num(A(0));
      const len = lenArg(A(1), e.line);
      const mult = num(A(2, 2));
      const mid = sma(`${key}m`, v, len);
      const sd = stdev(`${key}d`, v, len);
      return [mid, mid + mult * sd, mid - mult * sd];
    },
    'ta.bbw': ({ A, key, e }) => {
      const v = num(A(0));
      const len = lenArg(A(1), e.line);
      const mid = sma(`${key}m`, v, len);
      const sd = stdev(`${key}d`, v, len);
      return ((2 * num(A(2, 2)) * sd) / mid) * 100;
    },
    'ta.kc': ({ A, key, e }) => {
      const v = num(A(0));
      const len = lenArg(A(1), e.line);
      const mid = ema(`${key}m`, v, len);
      const rng = ema(`${key}r`, tr[st.bar], len);
      const m = num(A(2, 1.5));
      return [mid, mid + m * rng, mid - m * rng];
    },
    'ta.tr': ({ A }) => (st.bar === 0 && !truthy(A(0, false)) ? NaN : tr[st.bar]),
    'ta.atr': ({ A, key, e }) => rma(key, tr[st.bar], lenArg(A(0), e.line)),
    'ta.cci': ({ A, key, e }) => {
      const len = lenArg(A(1), e.line);
      const w = windowOf(series(key, num(A(0))), len);
      if (!w || w.some(isNa)) return NaN;
      const m = w.reduce((a, b) => a + b, 0) / len;
      const dev = w.reduce((a, b) => a + Math.abs(b - m), 0) / len;
      return dev === 0 ? 0 : (w[len - 1] - m) / (0.015 * dev);
    },
    'ta.stoch': ({ A, key, e }) => {
      const len = lenArg(A(3), e.line);
      const hi = windowOf(series(`${key}h`, num(A(1))), len);
      const lo = windowOf(series(`${key}l`, num(A(2))), len);
      if (!hi || !lo) return NaN;
      const H = Math.max(...hi), L = Math.min(...lo);
      return H === L ? 50 : (100 * (num(A(0)) - L)) / (H - L);
    },
    'ta.mfi': ({ A, key, e }) => {
      const len = lenArg(A(1), e.line);
      const v = num(A(0));
      const p = prevOf(`${key}p`, v);
      const vol = C().volume;
      const pos = series(`${key}+`, isNa(p) ? NaN : v > p ? v * vol : 0);
      const neg = series(`${key}-`, isNa(p) ? NaN : v < p ? v * vol : 0);
      const wp = windowOf(pos, len), wn = windowOf(neg, len);
      if (!wp || !wn || wp.some(isNa) || wn.some(isNa)) return NaN;
      const sp = wp.reduce((a, b) => a + b, 0), sn = wn.reduce((a, b) => a + b, 0);
      return sn === 0 ? 100 : 100 - 100 / (1 + sp / sn);
    },
    'ta.vwap': ({ A, key }) => {
      const v = num(A(0));
      const s = S(key, () => ({ day: null, pv: 0, vv: 0, bar: -1, res: NaN }));
      if (s.bar === st.bar) return s.res;
      s.bar = st.bar;
      const d = Math.floor(C().time / 86400);
      if (d !== s.day) { s.day = d; s.pv = 0; s.vv = 0; }
      s.pv += v * C().volume; s.vv += C().volume;
      s.res = s.vv ? s.pv / s.vv : NaN;
      return s.res;
    },
    'ta.supertrend': ({ A, key, e }) => {
      const factor = num(A(0));
      const atr = rma(`${key}a`, tr[st.bar], lenArg(A(1), e.line));
      const c = C();
      const src = (c.high + c.low) / 2;
      const s = S(key, () => ({ bar: -1, up: NaN, dn: NaN, dir: 1, st: NaN, pUp: NaN, pDn: NaN, pDir: 1, pSt: NaN }));
      if (s.bar === st.bar) return [s.st, s.dir];
      if (s.bar >= 0) { s.pUp = s.up; s.pDn = s.dn; s.pDir = s.dir; s.pSt = s.st; }
      s.bar = st.bar;
      if (isNa(atr)) { s.st = NaN; return [NaN, 1]; }
      let upper = src + factor * atr;
      let lower = src - factor * atr;
      const prevClose = st.bar > 0 ? candles[st.bar - 1].close : NaN;
      lower = !isNa(s.pDn) && !(lower > s.pDn || prevClose < s.pDn) ? s.pDn : lower;
      upper = !isNa(s.pUp) && !(upper < s.pUp || prevClose > s.pUp) ? s.pUp : upper;
      let dir;
      if (isNa(s.pSt)) dir = 1;
      else if (s.pSt === s.pUp) dir = c.close > upper ? -1 : 1;
      else dir = c.close < lower ? 1 : -1;
      s.up = upper; s.dn = lower; s.dir = dir;
      s.st = dir === -1 ? lower : upper;
      return [s.st, dir];
    },
    'ta.dmi': ({ A, key, e }) => {
      const diLen = lenArg(A(0), e.line);
      const adxLen = lenArg(A(1), e.line);
      const c = C();
      const p = st.bar > 0 ? candles[st.bar - 1] : null;
      const up = p ? c.high - p.high : NaN;
      const down = p ? p.low - c.low : NaN;
      const plusDM = isNa(up) ? NaN : up > down && up > 0 ? up : 0;
      const minusDM = isNa(down) ? NaN : down > up && down > 0 ? down : 0;
      const trur = rma(`${key}t`, tr[st.bar], diLen);
      const plus = (100 * rma(`${key}p`, plusDM, diLen)) / trur;
      const minus = (100 * rma(`${key}m`, minusDM, diLen)) / trur;
      const sum = plus + minus;
      const adx = 100 * rma(`${key}x`, Math.abs(plus - minus) / (sum === 0 ? 1 : sum), adxLen);
      return [plus, minus, adx];
    },
    'ta.pivothigh': ({ A, key, e }) => pivot(A, key, e, true),
    'ta.pivotlow': ({ A, key, e }) => pivot(A, key, e, false),

    // --- time parts: dayofweek(time, "UTC"), hour(t), ...
    ...Object.fromEntries([['dayofweek', 'dow'], ['hour', 'hour'], ['minute', 'minute'], ['second', 'second'], ['dayofmonth', 'day'], ['month', 'month'], ['year', 'year']]
      .map(([fn, part]) => [fn, ({ A, e }) => {
        try {
          const p = timeParts(num(A(0, candles[st.bar].time * 1000)), A(1, 'UTC'));
          return p ? p[part] : NaN;
        } catch (err) { throw new PineError(err.message.replace(/^Line \d+: /, ''), e.line); }
      }])),

    // --- timeframe / other-timeframe data
    'timeframe.in_seconds': ({ A }) => tfSeconds(A(0, opts.resolution ?? '')),
    // Intrabar (lower timeframe) data isn't available here. Asking for the chart's own
    // timeframe gives one value per bar, as on TradingView; a lower timeframe gives empty arrays.
    'request.security_lower_tf': ({ A, e, scope }) => {
      const tf = A(1, '');
      const same = tf === '' || tf === (opts.resolution ?? '') || tfSeconds(tf) === tfSeconds(opts.resolution ?? '');
      const expr = e.args[2] ?? e.named.expression;
      if (!expr) throw new PineError('request.security_lower_tf() needs an expression', e.line);
      if (!same) return expr.type === 'tuple' ? expr.items.map(() => new PineArray()) : new PineArray();
      const v = evalNode(expr, scope);
      return Array.isArray(v) ? v.map((x) => new PineArray([x])) : new PineArray([v]);
    },

    // --- strings
    'str.tostring': ({ A }) => formatNumber(A(0), A(1, null), opts.priceDecimals ?? 2),
    tostring: ({ A }) => formatNumber(A(0), A(1, null), opts.priceDecimals ?? 2),
    'str.format': ({ e, scope }) => {
      const vals = e.args.map((x) => evalNode(x, scope));
      return String(vals[0]).replace(/\{(\d+)(?:,\s*number,\s*([^}]*))?\}/g, (_, i, f) => {
        const v = vals[Number(i) + 1];
        return v === undefined ? '' : f ? formatNumber(v, f.trim(), opts.priceDecimals ?? 2) : formatNumber(v, null);
      });
    },
    'str.length': ({ A }) => String(A(0)).length,
    'str.contains': ({ A }) => String(A(0)).includes(String(A(1))),
    'str.startswith': ({ A }) => String(A(0)).startsWith(String(A(1))),
    'str.endswith': ({ A }) => String(A(0)).endsWith(String(A(1))),
    'str.pos': ({ A }) => { const p = String(A(0)).indexOf(String(A(1))); return p < 0 ? NaN : p; },
    'str.upper': ({ A }) => String(A(0)).toUpperCase(),
    'str.lower': ({ A }) => String(A(0)).toLowerCase(),
    'str.trim': ({ A }) => String(A(0)).trim(),
    'str.substring': ({ A }) => String(A(0)).substring(num(A(1, 0)), A(2) === undefined ? undefined : num(A(2))),
    'str.replace': ({ A }) => {
      const s = String(A(0)), target = String(A(1)), repl = String(A(2));
      let occ = Math.max(0, Math.round(num(A(3, 0))));
      let from = 0;
      for (;;) {
        const p = s.indexOf(target, from);
        if (p < 0 || !target) return s;
        if (occ-- === 0) return s.slice(0, p) + repl + s.slice(p + target.length);
        from = p + target.length;
      }
    },
    'str.replace_all': ({ A }) => { const t = String(A(1)); return t ? String(A(0)).split(t).join(String(A(2))) : String(A(0)); },
    'str.split': ({ A }) => new PineArray(String(A(0)).split(String(A(1)))),
    'str.tonumber': ({ A }) => { const v = Number(A(0)); return Number.isFinite(v) ? v : NaN; },
    'str.repeat': ({ A }) => { const n = Math.max(0, Math.round(num(A(1, 0)))); return Array.from({ length: n }, () => String(A(0))).join(String(A(2, ''))); },

    ...ARRAY_BUILTINS,
  };

  function pivot(A, key, e, high) {
    const three = e.args.length >= 3;
    const src = three ? num(A(0)) : high ? C().high : C().low;
    const left = lenArg(three ? A(1) : A(0), e.line);
    const right = lenArg(three ? A(2) : A(1), e.line);
    const w = windowOf(series(key, src), left + right + 1);
    if (!w) return NaN;
    const mid = w[left];
    const ok = w.every((v, i) => i === left || (high ? v < mid : v > mid));
    return ok ? mid : NaN;
  }

  function inputFn({ A, N, e }, type) {
    const def = N('defval', 0, NaN);
    const title = N('title', 1, null);
    const name = st.declName ?? title ?? `input${e.id}`;
    if (st.bar === 0 && !out.inputs.some((x) => x.name === name)) {
      let t = type;
      if (t === 'auto') t = typeof def === 'boolean' ? 'bool' : typeof def === 'string' ? 'string' : 'float';
      if (t === 'source' || (type === 'auto' && e.args[0]?.type === 'name' && SOURCES.has(e.args[0].name))) t = 'source';
      const options = e.named.options?.type === 'tuple' ? e.named.options.items.map((x) => evalNode(x, globalScope)) : null;
      out.inputs.push({
        name, title: title ?? name, type: t,
        default: t === 'source' ? (e.args[0]?.type === 'name' ? e.args[0].name : 'close') : def,
        options, min: e.named.minval ? num(evalNode(e.named.minval, globalScope)) : null,
        max: e.named.maxval ? num(evalNode(e.named.maxval, globalScope)) : null,
      });
    }
    const meta = out.inputs.find((x) => x.name === name);
    const override = inputValues[name] ?? (title ? inputValues[title] : undefined);
    if (meta.type === 'source') {
      const srcName = override ?? meta.default;
      const v = seriesVar(String(srcName), st.bar);
      return v === undefined ? def : v;
    }
    if (override === undefined || override === '' || override === null) return def;
    if (meta.type === 'bool') return override === true || override === 'true' || override === 1 || override === '1';
    if (meta.type === 'int') return Math.round(Number(override));
    if (meta.type === 'float') return Number(override);
    return override;
  }

  function setSignal(sig, strong = false) {
    out.hasSignals = true;
    const cur = out.signals[st.bar];
    // entries beat exits within the same bar
    if (!cur || strong || cur === 'exit') out.signals[st.bar] = cur && !strong && sig === 'exit' ? cur : sig;
  }
  function shapeSignal(cond, text) {
    if (!truthy(cond)) return;
    const sig = signalFromText(text);
    if (sig) setSignal(sig);
  }

  // ---------------------------------------------------------------- run
  // Function definitions are hoisted.
  for (const s of ast.body) if (s.type === 'func') st.funcs.set(s.name, s);
  const globalScope = new Scope(null, 'g');
  for (let bar = 0; bar < n; bar++) {
    st.bar = bar;
    if (st.pendingPosition !== null) { st.position = st.pendingPosition; st.pendingPosition = null; }
    globalScope.vars.clear();
    try {
      for (const s of ast.body) execStmt(s, globalScope);
    } catch (x) {
      if (x instanceof Break || x instanceof Continue) throw new PineError('"break"/"continue" outside a loop');
      throw x;
    }
  }

  const plots = [...out.plots.values()].map((p, i) => ({
    name: p.title ?? `Plot ${i + 1}`,
    color: p.color && /^(#|rgb)/.test(p.color) ? p.color : null,
    type: /histogram|columns|area/.test(String(p.style)) ? 'histogram' : 'line',
    values: p.values,
  }));
  return {
    title: out.title,
    pane: out.overlay ? 'overlay' : 'separate',
    plots,
    levels: out.levels,
    signals: out.hasSignals ? out.signals : null,
    inputs: out.inputs,
    isStrategy: out.isStrategy,
  };
}

/**
 * Name + inputs of a script without needing real data (runs it on a few dummy candles).
 * Used when importing, to build the settings form.
 */
export function pineMeta(source) {
  const ast = parsePine(source);
  const dummy = Array.from({ length: 3 }, (_, i) => ({ time: i * 60, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
  try {
    const r = runPine(ast, dummy);
    return { title: r.title, inputs: r.inputs, isStrategy: r.isStrategy };
  } catch (e) {
    if (e instanceof PineError) throw e;
    throw new PineError(e.message);
  }
}
