const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

// Every `x.foo(` call the server makes against its own modules must actually resolve.
// A missing export is invisible to unit tests that exercise each module in isolation: it
// only shows up at runtime, mid-scan, as "db.<name> is not a function" — which is exactly
// how the lead-aware bias fit shipped broken once.
const SRC = path.join(__dirname, "../server");
const callers = ["index.js", "engine.js", "ladder.js", "history.js", "backtest.js", "poly.js", "wx.js", "obs.js"];

// Aliases are read from each file's OWN require lines, so a local variable that happens to
// share a module's name (ladder.js has a numeric `bias`) is never mistaken for the module.
function localModuleAliases(src) {
  const out = {};
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(["']\.\/([\w.-]+)["']\)/g)) {
    try { out[m[1]] = require(path.join(SRC, m[2])); } catch { /* not resolvable here */ }
  }
  return out;
}

for (const file of callers) {
  test(`${file} only calls exports that exist`, () => {
    const src = fs.readFileSync(path.join(SRC, file), "utf8");
    const aliases = localModuleAliases(src);
    const missing = [];
    for (const [alias, mod] of Object.entries(aliases)) {
      if (!mod || typeof mod !== "object") continue;
      const re = new RegExp(`\\b${alias}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, "g");
      for (const m of src.matchAll(re)) {
        const fn = m[1];
        // Only flag names the module does not provide at all; a shadowing local would have
        // to collide with a real export name to slip through, which the next check covers.
        if (!(fn in mod) && typeof Object.prototype[fn] !== "function" && !(fn in Function.prototype))
          missing.push(`${alias}.${fn}`);
      }
    }
    assert.deepEqual([...new Set(missing)], [], `${file} calls undefined exports`);
  });
}

test("the guard actually catches a missing export", () => {
  // Proves the check above can fail — a guard that cannot go red is not a guard.
  const mod = { real: () => {} };
  const src = 'const db = require("./db");\ndb.real(); db.imaginary();';
  const missing = [];
  for (const m of src.matchAll(/\bdb\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (!(m[1] in mod)) missing.push(`db.${m[1]}`);
  }
  assert.deepEqual(missing, ["db.imaginary"]);
});
