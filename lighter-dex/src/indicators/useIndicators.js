import { useCallback, useEffect, useState } from 'react';
import { BUILTINS } from './builtins.js';
import { parseHeader } from './runner.js';
import { pineMeta } from './pine/runtime.js';
import { looksLikePine } from './pine/parser.js';

const KEY = 'lighter-dex:indicators:v1';
// Big TradingView scripts are often 50-200 KB. Scripts live in localStorage (~5 MB per site),
// so this only guards against pasting something absurd.
export const MAX_CODE = 512 * 1024;
export const MAX_CODE_LABEL = '512 KB';

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch {
    return {};
  }
}

const defaultsOf = (inputMeta) => Object.fromEntries((inputMeta ?? []).map((i) => [i.name, i.default]));

// Built-ins are Pine scripts; read their names and inputs once.
const BUILTIN_INFO = BUILTINS.map((b) => {
  const meta = pineMeta(b.code);
  return { ...b, lang: 'pine', name: meta.title ?? b.id, inputMeta: meta.inputs, defaults: defaultsOf(meta.inputs) };
});

/** Reads name, language and inputs of pasted script text. Throws on Pine syntax errors. */
export function describeScript(code) {
  if (code.length > MAX_CODE) throw new Error(`Script is too long (${MAX_CODE_LABEL} max)`);
  if (looksLikePine(code)) {
    const meta = pineMeta(code);
    return { lang: 'pine', name: meta.title, inputMeta: meta.inputs, defaults: defaultsOf(meta.inputs), isStrategy: meta.isStrategy };
  }
  const { name, inputs } = parseHeader(code);
  return {
    lang: 'js',
    name,
    inputMeta: Object.entries(inputs).map(([k, v]) => ({ name: k, title: k, type: 'float', default: v })),
    defaults: inputs,
    isStrategy: /signals\s*:/.test(code),
  };
}

/** Indicator list = built-ins (with saved settings) + user-imported scripts. Persisted per browser. */
export function useIndicators() {
  const [saved, setSaved] = useState(() => {
    const s = load();
    return { builtins: s.builtins ?? { ema: { enabled: true } }, custom: Array.isArray(s.custom) ? s.custom : [] };
  });

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* storage unavailable */ }
  }, [saved]);

  const list = [
    ...BUILTIN_INFO.map((b) => ({
      ...b,
      builtin: true,
      enabled: !!saved.builtins[b.id]?.enabled,
      inputs: { ...b.defaults, ...pickKnown(saved.builtins[b.id]?.inputs, b.defaults) },
    })),
    ...saved.custom.map((c) => ({ lang: 'js', inputMeta: [], ...c, builtin: false })),
  ];

  const toggle = useCallback((id) => {
    setSaved((s) => {
      if (BUILTINS.some((b) => b.id === id)) {
        const cur = s.builtins[id] ?? {};
        return { ...s, builtins: { ...s.builtins, [id]: { ...cur, enabled: !cur.enabled } } };
      }
      return { ...s, custom: s.custom.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)) };
    });
  }, []);

  /** value is already typed (number / boolean / string) by the settings form. */
  const setInput = useCallback((id, key, value) => {
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    setSaved((s) => {
      if (BUILTINS.some((b) => b.id === id)) {
        const cur = s.builtins[id] ?? {};
        return { ...s, builtins: { ...s.builtins, [id]: { ...cur, inputs: { ...(cur.inputs ?? {}), [key]: value } } } };
      }
      return { ...s, custom: s.custom.map((c) => (c.id === id ? { ...c, inputs: { ...c.inputs, [key]: value } } : c)) };
    });
  }, []);

  /** Adds or replaces a custom indicator from script text (Pine or JS). Returns its id. Throws on errors. */
  const saveCustom = useCallback((code, id) => {
    const info = describeScript(code);
    const newId = id ?? `c-${Date.now()}`;
    setSaved((s) => {
      const existing = s.custom.find((c) => c.id === newId);
      const entry = {
        id: newId,
        lang: info.lang,
        name: (info.name ?? existing?.name ?? 'Custom indicator').slice(0, 60),
        code,
        inputMeta: info.inputMeta,
        inputs: { ...info.defaults, ...pickKnown(existing?.inputs, info.defaults) },
        strategy: info.isStrategy,
        enabled: existing ? existing.enabled : true,
      };
      return { ...s, custom: existing ? s.custom.map((c) => (c.id === newId ? entry : c)) : [...s.custom, entry] };
    });
    return newId;
  }, []);

  const remove = useCallback((id) => {
    setSaved((s) => ({ ...s, custom: s.custom.filter((c) => c.id !== id) }));
  }, []);

  return { list, enabled: list.filter((i) => i.enabled), toggle, setInput, saveCustom, remove };
}

/** Keep only saved values whose input still exists (scripts can change). */
function pickKnown(saved, defaults) {
  if (!saved) return {};
  return Object.fromEntries(Object.entries(saved).filter(([k]) => k in defaults));
}
