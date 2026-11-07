import { useCallback, useEffect, useState } from 'react';
import { BUILTINS } from './builtins.js';
import { parseHeader } from './runner.js';

const KEY = 'lighter-dex:indicators:v1';
const MAX_CODE = 20000;

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch {
    return {};
  }
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
    ...BUILTINS.map((b) => ({
      ...b,
      builtin: true,
      enabled: !!saved.builtins[b.id]?.enabled,
      inputs: { ...b.inputs, ...(saved.builtins[b.id]?.inputs ?? {}) },
    })),
    ...saved.custom.map((c) => ({ ...c, builtin: false })),
  ];

  const toggle = useCallback((id) => {
    setSaved((s) => {
      if (s.builtins[id] !== undefined || BUILTINS.some((b) => b.id === id)) {
        const cur = s.builtins[id] ?? {};
        return { ...s, builtins: { ...s.builtins, [id]: { ...cur, enabled: !cur.enabled } } };
      }
      return { ...s, custom: s.custom.map((c) => (c.id === id ? { ...c, enabled: !c.enabled } : c)) };
    });
  }, []);

  const setInput = useCallback((id, key, value) => {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    setSaved((s) => {
      if (BUILTINS.some((b) => b.id === id)) {
        const cur = s.builtins[id] ?? {};
        return { ...s, builtins: { ...s.builtins, [id]: { ...cur, inputs: { ...(cur.inputs ?? {}), [key]: v } } } };
      }
      return { ...s, custom: s.custom.map((c) => (c.id === id ? { ...c, inputs: { ...c.inputs, [key]: v } } : c)) };
    });
  }, []);

  /** Adds or replaces a custom indicator from script text. Returns its id. */
  const saveCustom = useCallback((code, id) => {
    if (code.length > MAX_CODE) throw new Error('Indicator script is too long (20 KB max)');
    const { name, inputs } = parseHeader(code);
    const newId = id ?? `c-${Date.now()}`;
    setSaved((s) => {
      const existing = s.custom.find((c) => c.id === newId);
      const entry = {
        id: newId,
        name: name ?? existing?.name ?? 'Custom indicator',
        code,
        inputs: { ...inputs, ...(existing?.inputs ?? {}) },
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
