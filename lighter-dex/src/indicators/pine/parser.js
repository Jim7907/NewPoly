// Pine Script (v4/v5/v6 subset) lexer + parser -> AST.
// Nothing here executes code; the interpreter walks the AST (runtime.js).

export class PineError extends Error {
  constructor(message, line) {
    super(line ? `Line ${line}: ${message}` : message);
    this.line = line;
  }
}

const KEYWORDS = new Set([
  'and', 'or', 'not', 'if', 'else', 'for', 'to', 'by', 'while', 'var', 'varip', 'true', 'false',
  'na', 'switch', 'break', 'continue', 'import', 'export', 'method', 'type', 'in',
]);
const TYPE_WORDS = new Set([
  'int', 'float', 'bool', 'string', 'color', 'series', 'simple', 'const', 'line', 'label', 'box',
  'table', 'array', 'matrix', 'map', 'linefill', 'polyline',
]);
const OPS = [':=', '+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '=>',
  '+', '-', '*', '/', '%', '<', '>', '=', '?', ':', '(', ')', '[', ']', ',', '.'];
const CONT_END = new Set(['+', '-', '*', '/', '%', 'and', 'or', '?', ':', '==', '!=', '<', '>', '<=', '>=', ',', '(', '[', 'not', '=', ':=']);
const CONT_START = new Set(['+', '-', '*', '/', '%', 'and', 'or', '?', ':', ')', ']']);

// ---------------------------------------------------------------- lexer

function stripComment(line) {
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '\\') i++;
      else if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

function tokenizeLine(text, line) {
  const toks = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    const rest = text.slice(i);
    let m;
    if ((m = rest.match(/^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/))) {
      toks.push({ t: 'num', v: Number(m[1]), line });
      i += m[1].length;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      let s = '';
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\' && j + 1 < text.length) { s += text[j + 1] === 'n' ? '\n' : text[j + 1]; j += 2; }
        else s += text[j++];
      }
      if (j >= text.length) throw new PineError('Unterminated string', line);
      toks.push({ t: 'str', v: s, line });
      i = j + 1;
    } else if ((m = rest.match(/^#([0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/))) {
      toks.push({ t: 'color', v: `#${m[1]}`, line });
      i += m[0].length;
    } else if ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/))) {
      const w = m[0];
      toks.push({ t: KEYWORDS.has(w) ? 'kw' : 'id', v: w, line });
      i += w.length;
    } else {
      const op = OPS.find((o) => rest.startsWith(o));
      if (!op) throw new PineError(`Unexpected character "${c}"`, line);
      toks.push({ t: 'op', v: op, line });
      i += op.length;
    }
  }
  return toks;
}

const isOpTok = (tok, set) => tok && (tok.t === 'op' || tok.t === 'kw') && set.has(tok.v);
const BLOCK_KW = new Set(['if', 'else', 'for', 'while', 'switch']);
/** A line whose following indented lines are a block body, not a continuation. */
function opensBlock(toks) {
  if (toks[0]?.t === 'kw' && BLOCK_KW.has(toks[0].v)) return true;
  const last = toks[toks.length - 1];
  if (last?.t === 'op' && last.v === '=>') return true;
  return toks.some((t, i) => t.t === 'kw' && (t.v === 'if' || t.v === 'switch') && toks[i - 1]?.t === 'op' && ['=', ':='].includes(toks[i - 1].v));
}

/** Source -> logical lines [{ indent, toks, line }] with continuation lines joined. */
export function lex(src) {
  const raw = String(src).replace(/\r\n?/g, '\n').split('\n');
  const lines = [];
  raw.forEach((text, idx) => {
    const lineNo = idx + 1;
    const body = stripComment(text);
    if (!body.trim()) return;
    const indent = body.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
    lines.push({ indent, toks: tokenizeLine(body, lineNo), line: lineNo });
  });
  // join continuation lines
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const cur = { ...lines[i], toks: [...lines[i].toks] };
    for (;;) {
      const depth = cur.toks.reduce((d, t) => d + (t.t === 'op' && (t.v === '(' || t.v === '[') ? 1 : t.t === 'op' && (t.v === ')' || t.v === ']') ? -1 : 0), 0);
      const next = lines[i + 1];
      if (!next) break;
      const last = cur.toks[cur.toks.length - 1];
      const endsWithOp = isOpTok(last, CONT_END) && !(last.t === 'op' && last.v === '=>');
      const startsWithOp = next.indent > cur.indent && isOpTok(next.toks[0], CONT_START) && !opensBlock(cur.toks);
      if (depth > 0 || endsWithOp || startsWithOp) {
        cur.toks.push(...next.toks);
        i++;
      } else break;
    }
    out.push(cur);
  }
  return out;
}

// ---------------------------------------------------------------- expression parser

let nodeSeq = 0;
const node = (type, line, props) => ({ type, id: ++nodeSeq, line, ...props });

class Exprs {
  constructor(toks, line) {
    this.toks = toks;
    this.i = 0;
    this.line = line;
  }
  peek(o = 0) { return this.toks[this.i + o]; }
  isOp(v, o = 0) { const t = this.peek(o); return t && t.t === 'op' && t.v === v; }
  isKw(v, o = 0) { const t = this.peek(o); return t && t.t === 'kw' && t.v === v; }
  next() { return this.toks[this.i++]; }
  expectOp(v) {
    if (!this.isOp(v)) throw new PineError(`Expected "${v}"${this.peek() ? ` but found "${this.peek().v}"` : ''}`, this.line);
    return this.next();
  }
  done() { return this.i >= this.toks.length; }

  expr() { return this.ternary(); }
  ternary() {
    const cond = this.or();
    if (this.isOp('?')) {
      this.next();
      const a = this.ternary();
      this.expectOp(':');
      const b = this.ternary();
      return node('ternary', this.line, { cond, a, b });
    }
    return cond;
  }
  or() {
    let l = this.and();
    while (this.isKw('or')) { this.next(); l = node('bin', this.line, { op: 'or', l, r: this.and() }); }
    return l;
  }
  and() {
    let l = this.not();
    while (this.isKw('and')) { this.next(); l = node('bin', this.line, { op: 'and', l, r: this.not() }); }
    return l;
  }
  not() {
    if (this.isKw('not')) { this.next(); return node('unary', this.line, { op: 'not', e: this.not() }); }
    return this.equality();
  }
  equality() {
    let l = this.comparison();
    while (this.isOp('==') || this.isOp('!=')) { const op = this.next().v; l = node('bin', this.line, { op, l, r: this.comparison() }); }
    return l;
  }
  comparison() {
    let l = this.additive();
    while (['<', '>', '<=', '>='].some((o) => this.isOp(o))) { const op = this.next().v; l = node('bin', this.line, { op, l, r: this.additive() }); }
    return l;
  }
  additive() {
    let l = this.mult();
    while (this.isOp('+') || this.isOp('-')) { const op = this.next().v; l = node('bin', this.line, { op, l, r: this.mult() }); }
    return l;
  }
  mult() {
    let l = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) { const op = this.next().v; l = node('bin', this.line, { op, l, r: this.unary() }); }
    return l;
  }
  unary() {
    if (this.isOp('-') || this.isOp('+')) { const op = this.next().v; return node('unary', this.line, { op, e: this.unary() }); }
    return this.postfix();
  }
  /** Skips a type argument list like `<float>` or `<string, float>` when it is followed by "(". */
  skipTypeArgs() {
    if (!this.isOp('<')) return false;
    let j = this.i;
    let depth = 0;
    for (; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t.t === 'op' && t.v === '<') depth++;
      else if (t.t === 'op' && t.v === '>') { if (--depth === 0) break; }
      else if (!(t.t === 'id' || (t.t === 'op' && t.v === ','))) return false;
    }
    const after = this.toks[j + 1];
    if (depth !== 0 || !(after && after.t === 'op' && after.v === '(')) return false;
    this.i = j + 1;
    return true;
  }
  postfix() {
    let e = this.primary();
    for (;;) {
      if (e.type === 'name' && this.isOp('<')) this.skipTypeArgs(); // array.new<float>(...)
      if (this.isOp('(') && (e.type === 'name' || e.type === 'na')) {
        this.next();
        const { args, named } = this.args();
        e = node('call', this.line, { name: e.type === 'na' ? 'na' : e.name, args, named });
      } else if (this.isOp('[')) {
        this.next();
        const offset = this.expr();
        this.expectOp(']');
        e = node('hist', this.line, { e, offset });
      } else if (this.isOp('.')) {
        // method call on an expression result: array.from(a, b).get(i)
        this.next();
        const m = this.next();
        if (!m || m.t !== 'id' || m.v.includes('.') || !this.isOp('(')) throw new PineError('Expected a method call after "."', this.line);
        this.next();
        const { args, named } = this.args();
        e = node('mcall', this.line, { recv: e, method: m.v, args, named });
      } else return e;
    }
  }
  args() {
    const args = [];
    const named = {};
    if (this.isOp(')')) { this.next(); return { args, named }; }
    for (;;) {
      const t = this.peek();
      if (t && t.t === 'id' && this.isOp('=', 1)) {
        this.next(); this.next();
        named[t.v] = this.expr();
      } else {
        args.push(this.expr());
      }
      if (this.isOp(',')) { this.next(); continue; }
      this.expectOp(')');
      return { args, named };
    }
  }
  primary() {
    const t = this.next();
    if (!t) throw new PineError('Unexpected end of line', this.line);
    if (t.t === 'num') return node('num', this.line, { v: t.v });
    if (t.t === 'str') return node('str', this.line, { v: t.v });
    if (t.t === 'color') return node('str', this.line, { v: t.v });
    if (t.t === 'kw' && (t.v === 'true' || t.v === 'false')) return node('bool', this.line, { v: t.v === 'true' });
    if (t.t === 'kw' && t.v === 'na') return node('na', this.line, {});
    if (t.t === 'id') return node('name', this.line, { name: t.v });
    if (t.t === 'op' && t.v === '(') {
      const e = this.expr();
      this.expectOp(')');
      return e;
    }
    if (t.t === 'op' && t.v === '[') {
      const items = [];
      if (!this.isOp(']')) {
        for (;;) {
          items.push(this.expr());
          if (this.isOp(',')) { this.next(); continue; }
          break;
        }
      }
      this.expectOp(']');
      return node('tuple', this.line, { items });
    }
    if (t.t === 'kw' && (t.v === 'if' || t.v === 'switch')) {
      throw new PineError(`"${t.v}" can only start a line or follow "="`, this.line);
    }
    throw new PineError(`Unexpected "${t.v}"`, this.line);
  }
}

function parseExpr(toks, line) {
  if (!toks.length) throw new PineError('Missing expression', line);
  const p = new Exprs(toks, line);
  const e = p.expr();
  if (!p.done()) throw new PineError(`Unexpected "${p.peek().v}"`, line);
  return e;
}

// ---------------------------------------------------------------- statement parser

const UNSUPPORTED = {
  import: 'Libraries (import) are not supported',
  export: 'Libraries (export) are not supported',
  method: 'User-defined methods are not supported',
  type: 'User-defined types are not supported',
};

class Parser {
  constructor(lines) {
    this.lines = lines;
    this.i = 0;
  }

  /** Statements at exactly `indent`, stopping at the first line indented less. */
  block(indent) {
    const out = [];
    while (this.i < this.lines.length) {
      const ln = this.lines[this.i];
      if (ln.indent < indent) break;
      if (ln.indent > indent) throw new PineError('Unexpected indentation', ln.line);
      out.push(this.statement(ln));
    }
    return out;
  }

  /** Indented body after a header line (if/for/while/function). */
  body(parent) {
    const next = this.lines[this.i];
    if (!next || next.indent <= parent.indent) throw new PineError('Expected an indented block', parent.line);
    return this.block(next.indent);
  }

  statement(ln) {
    const { toks, line } = ln;
    const t0 = toks[0];
    if (t0.t === 'kw' && UNSUPPORTED[t0.v]) throw new PineError(UNSUPPORTED[t0.v], line);
    if (t0.t === 'kw' && t0.v === 'if') { this.i++; return this.ifStmt(ln, toks.slice(1)); }
    if (t0.t === 'kw' && t0.v === 'switch') { this.i++; return this.switchStmt(ln, toks.slice(1)); }
    if (t0.t === 'kw' && t0.v === 'for') { this.i++; return this.forStmt(ln); }
    if (t0.t === 'kw' && t0.v === 'while') {
      this.i++;
      return node('while', line, { cond: parseExpr(toks.slice(1), line), body: this.body(ln) });
    }
    if (t0.t === 'kw' && (t0.v === 'break' || t0.v === 'continue')) { this.i++; return node(t0.v, line, {}); }
    if (t0.t === 'kw' && t0.v === 'else') throw new PineError('"else" without "if"', line);

    // function definition: name(params) => ...
    if (t0.t === 'id' && toks[1]?.t === 'op' && toks[1].v === '(') {
      const close = matchParen(toks, 1);
      if (close > 0 && toks[close + 1]?.t === 'op' && toks[close + 1].v === '=>') {
        this.i++;
        const params = parseParams(toks.slice(2, close), line);
        const rest = toks.slice(close + 2);
        const body = rest.length ? [node('expr', line, { e: this.rhs(ln, rest) })] : this.body(ln);
        return node('func', line, { name: t0.v, params, body });
      }
    }

    // tuple declaration: [a, b] = expr
    if (t0.t === 'op' && t0.v === '[') {
      const close = matchBracket(toks, 0);
      if (close > 0 && toks[close + 1]?.t === 'op' && (toks[close + 1].v === '=' || toks[close + 1].v === ':=')) {
        this.i++;
        const names = toks.slice(1, close).filter((t) => t.t === 'id').map((t) => t.v);
        return node('tupleDecl', line, { names, e: this.rhs(ln, toks.slice(close + 2)) });
      }
    }

    // declarations / assignments
    let k = 0;
    let isVar = false;
    if (toks[k]?.t === 'kw' && (toks[k].v === 'var' || toks[k].v === 'varip')) { isVar = true; k++; }
    // optional type prefix: `float x`, `series float x`, `array<float> x`, `map<string, int> m`
    for (;;) {
      const after = skipType(toks, k);
      if (after === k || toks[after]?.t !== 'id') break;
      k = after;
    }
    if (toks[k]?.t === 'id' && toks[k + 1]?.t === 'op') {
      const name = toks[k].v;
      const op = toks[k + 1].v;
      if (op === '=') {
        this.i++;
        return node('decl', line, { name, isVar, e: this.rhs(ln, toks.slice(k + 2)) });
      }
      if (!isVar && [':=', '+=', '-=', '*=', '/=', '%='].includes(op)) {
        this.i++;
        return node('assign', line, { name, op, e: this.rhs(ln, toks.slice(k + 2)) });
      }
    }
    if (isVar) throw new PineError('Expected a variable name after "var"', line);

    this.i++;
    return node('expr', line, { e: parseExpr(toks, line) });
  }

  /** Right-hand side: an expression, or an if/switch whose value is used. */
  rhs(ln, toks) {
    if (toks[0]?.t === 'kw' && toks[0].v === 'if') return node('blockExpr', ln.line, { stmt: this.ifStmt(ln, toks.slice(1)) });
    if (toks[0]?.t === 'kw' && toks[0].v === 'switch') return node('blockExpr', ln.line, { stmt: this.switchStmt(ln, toks.slice(1)) });
    return parseExpr(toks, ln.line);
  }

  ifStmt(ln, condToks) {
    const cond = parseExpr(condToks, ln.line);
    const then = this.body(ln);
    let otherwise = null;
    const nx = this.lines[this.i];
    if (nx && nx.indent === ln.indent && nx.toks[0]?.t === 'kw' && nx.toks[0].v === 'else') {
      this.i++;
      if (nx.toks[1]?.t === 'kw' && nx.toks[1].v === 'if') {
        otherwise = [this.ifStmt(nx, nx.toks.slice(2))];
      } else {
        otherwise = this.body(nx);
      }
    }
    return node('if', ln.line, { cond, then, otherwise });
  }

  switchStmt(ln, subjToks) {
    const subject = subjToks.length ? parseExpr(subjToks, ln.line) : null;
    const first = this.lines[this.i];
    if (!first || first.indent <= ln.indent) throw new PineError('Expected switch cases', ln.line);
    const caseIndent = first.indent;
    const cases = [];
    while (this.i < this.lines.length && this.lines[this.i].indent === caseIndent) {
      const c = this.lines[this.i];
      const arrow = c.toks.findIndex((t) => t.t === 'op' && t.v === '=>');
      if (arrow < 0) throw new PineError('Expected "=>" in switch case', c.line);
      this.i++;
      const test = arrow === 0 ? null : parseExpr(c.toks.slice(0, arrow), c.line);
      const rest = c.toks.slice(arrow + 1);
      const body = rest.length ? [this.inlineStatement(c, rest)] : this.body(c);
      cases.push({ test, body });
    }
    return node('switch', ln.line, { subject, cases });
  }

  /** A statement written after "=>" on the same line (e.g. in a switch case). */
  inlineStatement(ln, toks) {
    const sub = new Parser([{ indent: 0, toks, line: ln.line }]);
    return sub.statement(sub.lines[0]);
  }

  forStmt(ln) {
    const { toks, line } = ln;
    // for x in arr  /  for [i, x] in arr
    const inIdx = toks.findIndex((t) => t.t === 'kw' && t.v === 'in');
    if (inIdx > 0) {
      const head = toks.slice(1, inIdx).filter((t) => t.t === 'id').map((t) => t.v);
      const tuple = toks[1]?.t === 'op' && toks[1].v === '[';
      if (!head.length || (tuple ? head.length !== 2 : head.length !== 1)) throw new PineError('Expected "for x in array" or "for [i, x] in array"', line);
      return node('forIn', line, {
        idxV: tuple ? head[0] : null,
        v: tuple ? head[1] : head[0],
        src: parseExpr(toks.slice(inIdx + 1), line),
        body: this.body(ln),
      });
    }
    if (toks[1]?.t !== 'id' || !(toks[2]?.t === 'op' && toks[2].v === '=')) throw new PineError('Expected "for i = start to end"', line);
    const toIdx = toks.findIndex((t) => t.t === 'kw' && t.v === 'to');
    if (toIdx < 0) throw new PineError('Expected "to" in for loop', line);
    const byIdx = toks.findIndex((t) => t.t === 'kw' && t.v === 'by');
    const from = parseExpr(toks.slice(3, toIdx), line);
    const to = parseExpr(toks.slice(toIdx + 1, byIdx > 0 ? byIdx : undefined), line);
    const step = byIdx > 0 ? parseExpr(toks.slice(byIdx + 1), line) : null;
    return node('for', line, { v: toks[1].v, from, to, step, body: this.body(ln) });
  }
}

/** If toks[k] starts a type (`float`, `array<float>`, `map<string, int>`), returns the index after it; else k. */
function skipType(toks, k) {
  const t = toks[k];
  if (!(t?.t === 'id' && TYPE_WORDS.has(t.v))) return k;
  let j = k + 1;
  if (toks[j]?.t === 'op' && toks[j].v === '<') {
    let depth = 0;
    for (; j < toks.length; j++) {
      const x = toks[j];
      if (x.t === 'op' && x.v === '<') depth++;
      else if (x.t === 'op' && x.v === '>') { if (--depth === 0) return j + 1; }
      else if (!(x.t === 'id' || (x.t === 'op' && x.v === ','))) return k;
    }
    return k;
  }
  return j;
}

function matchParen(toks, open) {
  let d = 0;
  for (let i = open; i < toks.length; i++) {
    if (toks[i].t === 'op' && toks[i].v === '(') d++;
    if (toks[i].t === 'op' && toks[i].v === ')' && --d === 0) return i;
  }
  return -1;
}
function matchBracket(toks, open) {
  let d = 0;
  for (let i = open; i < toks.length; i++) {
    if (toks[i].t === 'op' && toks[i].v === '[') d++;
    if (toks[i].t === 'op' && toks[i].v === ']' && --d === 0) return i;
  }
  return -1;
}

function parseParams(toks, line) {
  const params = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const eq = cur.findIndex((t) => t.t === 'op' && t.v === '=');
    const head = eq >= 0 ? cur.slice(0, eq) : cur;
    const ids = head.filter((t) => t.t === 'id');
    const name = ids[ids.length - 1]?.v;
    if (!name) throw new PineError('Bad function parameter', line);
    params.push({ name, def: eq >= 0 ? parseExpr(cur.slice(eq + 1), line) : null });
    cur = [];
  };
  let depth = 0;
  for (const t of toks) {
    if (t.t === 'op' && (t.v === '(' || t.v === '[')) depth++;
    if (t.t === 'op' && (t.v === ')' || t.v === ']')) depth--;
    if (depth === 0 && t.t === 'op' && t.v === ',') flush();
    else cur.push(t);
  }
  flush();
  return params;
}

/** Pine source -> { body: Statement[] } */
export function parsePine(src) {
  const lines = lex(src);
  if (!lines.length) throw new PineError('The script is empty');
  const base = lines[0].indent;
  const p = new Parser(lines);
  const body = p.block(base);
  if (p.i < lines.length) throw new PineError('Unexpected indentation', lines[p.i].line);
  return { body };
}

/** Quick check used to tell Pine apart from JavaScript when importing. */
export function looksLikePine(src) {
  return /(^|\n)\s*\/\/\s*@version\s*=\s*\d/.test(src)
    || /(^|\n)\s*(indicator|study|strategy)\s*\(/.test(src)
    || /\bta\.\w+\s*\(/.test(src) && !/\breturn\b/.test(src);
}
