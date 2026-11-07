import { useRef, useState } from 'react';
import { CUSTOM_TEMPLATE } from '../indicators/builtins.js';

export default function IndicatorsPanel({ indicators, errors, onClose }) {
  const [editing, setEditing] = useState(null); // { id?: string, code: string }
  const [msg, setMsg] = useState(null);
  const fileRef = useRef(null);
  const { list, toggle, setInput, saveCustom, remove } = indicators;

  const save = () => {
    try {
      saveCustom(editing.code, editing.id);
      setEditing(null);
      setMsg(null);
    } catch (e) {
      setMsg(e.message);
    }
  };

  const onFile = async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 20000) return setMsg('File too large (20 KB max)');
    setEditing({ code: await f.text() });
  };

  const copy = async (code) => {
    try {
      await navigator.clipboard.writeText(code);
      setMsg('Copied — share it with anyone, they can paste it under "Import"');
    } catch {
      setMsg('Copy failed — select the code in the editor instead');
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
              Paste an indicator script (JavaScript). It runs in an isolated background worker with no access to your
              wallet, keys or orders. Only import code you understand or trust.
            </p>
            <textarea
              className="code"
              spellCheck={false}
              value={editing.code}
              onChange={(e) => setEditing({ ...editing, code: e.target.value })}
            />
            {msg && <div className="msg error">{msg}</div>}
            <div className="row-gap">
              <button className="btn btn-primary" onClick={save}>Save & show</button>
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="sheet-body">
            <div className="row-gap">
              <button className="btn btn-primary" onClick={() => setEditing({ code: CUSTOM_TEMPLATE })}>+ New / paste</button>
              <button className="btn" onClick={() => fileRef.current?.click()}>Import .js file</button>
              <input ref={fileRef} type="file" accept=".js,.txt,text/javascript,text/plain" hidden onChange={onFile} />
            </div>
            {msg && <div className="msg ok">{msg}</div>}

            <div className="ind-list">
              {list.map((ind) => (
                <div className={`ind-item ${ind.enabled ? 'on' : ''}`} key={ind.id}>
                  <label className="ind-toggle">
                    <input type="checkbox" checked={ind.enabled} onChange={() => toggle(ind.id)} />
                    <span>{ind.name}</span>
                    {!ind.builtin && <span className="tag">custom</span>}
                  </label>
                  <div className="ind-inputs">
                    {Object.entries(ind.inputs ?? {}).map(([k, v]) => (
                      <label key={k} className="ind-input">
                        {k}
                        <input inputMode="decimal" defaultValue={v} onBlur={(e) => setInput(ind.id, k, e.target.value)} />
                      </label>
                    ))}
                  </div>
                  <div className="ind-actions">
                    {ind.builtin ? (
                      <button className="link small" onClick={() => setEditing({ code: `// @name ${ind.name} (copy)\n${Object.entries(ind.inputs).map(([k, v]) => `// @input ${k} ${v}`).join('\n')}\n${ind.code}` })}>
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
