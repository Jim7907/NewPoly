import { useMemo, useRef, useState } from 'react';
import { CUSTOM_TEMPLATE } from '../indicators/builtins.js';
import { MAX_CODE, MAX_CODE_LABEL, describeScript } from '../indicators/useIndicators.js';

const SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'volume'];

export default function IndicatorsPanel({ indicators, errors, onClose }) {
  const [editing, setEditing] = useState(null); // { id?: string, code: string }
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);
  const { list, toggle, setInput, saveCustom, remove } = indicators;

  // live check while typing: language, name, inputs, or the first error
  const check = useMemo(() => {
    if (!editing?.code?.trim()) return null;
    try {
      return { ok: true, ...describeScript(editing.code) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }, [editing?.code]);

  const save = () => {
    try {
      saveCustom(editing.code, editing.id);
      setEditing(null);
      setMsg(null);
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > MAX_CODE) return setMsg({ ok: false, text: `File too large (${MAX_CODE_LABEL} max)` });
    setEditing({ code: await f.text() });
  };

  const copy = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      setMsg({ ok: true, text: 'Copied. Anyone can paste it under "+ Import Pine Script" (or into TradingView).' });
    } catch {
      setMsg({ ok: false, text: 'Copy failed. Open Edit and copy the code from there.' });
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Indicators">
        <div className="sheet-head">
          <strong>Indicators</strong>
          <button className="chip" onClick={onClose}>Close</button>
        </div>

        {editing ? (
          <div className="sheet-body">
            <p className="muted small">
              Paste a <b>Pine Script</b> indicator or strategy from TradingView (v4–v6). Supported: inputs, <code>ta.*</code>,
              <code> math.*</code>, <code>plot</code>, <code>hline</code>, <code>if/for/switch</code>, <code>var</code>, functions.
              Drawings (labels, lines, tables) are skipped; <code>request.security</code> isn&apos;t available.
              For the auto-trader, use <code>strategy.entry/close</code> or <code>alertcondition(cond, &quot;Buy&quot;/&quot;Sell&quot;)</code>.
              Scripts run isolated from your wallet and keys.
            </p>
            <textarea
              className="code"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              value={editing.code}
              onChange={(e) => setEditing({ ...editing, code: e.target.value })}
            />
            {check && (
              check.ok ? (
                <div className="msg ok small">
                  ✓ {check.lang === 'pine' ? 'Pine Script' : 'JavaScript'} · “{check.name ?? 'Untitled'}”
                  {check.inputMeta.length > 0 && ` · ${check.inputMeta.length} setting(s)`}
                  {check.isStrategy ? ' · can drive the auto-trader' : ''}
                </div>
              ) : (
                <div className="msg error small">{check.error}</div>
              )
            )}
            {msg && !msg.ok && <div className="msg error">{msg.text}</div>}
            <div className="row-gap">
              <button className="btn btn-primary" onClick={save} disabled={check && !check.ok}>Save & show</button>
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="sheet-body">
            <div className="row-gap">
              <button className="btn btn-primary" onClick={() => setEditing({ code: CUSTOM_TEMPLATE })}>+ Import Pine Script</button>
              <button className="btn" onClick={() => fileRef.current?.click()}>Upload .pine file</button>
              <input ref={fileRef} type="file" accept=".pine,.txt,.js,text/plain" hidden onChange={onFile} />
            </div>
            {msg && <div className={`msg ${msg.ok ? 'ok' : 'error'}`}>{msg.text}</div>}

            <div className="ind-list">
              {list.map((ind) => (
                <div className={`ind-item ${ind.enabled ? 'on' : ''}`} key={ind.id}>
                  <label className="ind-toggle">
                    <input type="checkbox" checked={ind.enabled} onChange={() => toggle(ind.id)} />
                    <span>{ind.name}</span>
                    {!ind.builtin && <span className="tag">{ind.lang === 'pine' ? 'pine' : 'js'}</span>}
                    {ind.strategy && <span className="tag tag-up">strategy</span>}
                  </label>
                  <div className="ind-inputs">
                    {(ind.inputMeta?.length ? ind.inputMeta : Object.keys(ind.inputs ?? {}).map((k) => ({ name: k, title: k, type: 'float' })))
                      .map((meta) => (
                        <InputField key={`${ind.id}-${meta.name}`} meta={meta} value={ind.inputs?.[meta.name]} onChange={(v) => setInput(ind.id, meta.name, v)} />
                      ))}
                  </div>
                  <div className="ind-actions">
                    {ind.builtin ? (
                      <button className="link small" onClick={() => setEditing({ code: ind.code.replace(/(indicator|strategy)\("([^"]*)"/, '$1("$2 (copy)"') })}>
                        Copy as custom
                      </button>
                    ) : (
                      <>
                        <button className="link small" onClick={() => setEditing({ id: ind.id, code: ind.code })}>Edit</button>
                        <button className="link small" onClick={() => copy(ind.code)}>Share</button>
                        <button className="link small down" onClick={() => remove(ind.id)}>Delete</button>
                      </>
                    )}
                  </div>
                  {errors[ind.id] && <div className="msg error small">{errors[ind.id]}</div>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function InputField({ meta, value, onChange }) {
  const label = String(meta.title ?? meta.name).slice(0, 24);
  if (meta.type === 'bool') {
    return (
      <label className="ind-input">
        <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> {label}
      </label>
    );
  }
  if (meta.type === 'source' || (meta.options && meta.options.length)) {
    const opts = meta.type === 'source' ? SOURCES : meta.options;
    return (
      <label className="ind-input">
        {label}
        <select value={String(value ?? meta.default)} onChange={(e) => onChange(meta.type === 'source' || typeof meta.default === 'string' ? e.target.value : Number(e.target.value))}>
          {opts.map((o) => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
        </select>
      </label>
    );
  }
  if (meta.type === 'string' || meta.type === 'color') {
    return (
      <label className="ind-input">
        {label}
        <input className="wide" defaultValue={value ?? ''} onBlur={(e) => onChange(e.target.value)} />
      </label>
    );
  }
  return (
    <label className="ind-input">
      {label}
      <input
        inputMode="decimal"
        defaultValue={value}
        onBlur={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(meta.type === 'int' ? Math.round(v) : v);
        }}
      />
    </label>
  );
}
