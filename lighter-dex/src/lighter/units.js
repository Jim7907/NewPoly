// Lighter encodes prices/sizes as integers scaled by per-market decimals
// (e.g. ETH price_decimals=2 -> $2243.16 is 224316). Do the scaling on strings
// so user input never goes through floating point.

/** "2243.165" with 2 decimals -> "224316" (truncates extra digits). Returns null if invalid. */
export function toScaledInt(value, decimals) {
  const s = String(value ?? '').trim();
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return null;
  const [whole, frac = ''] = s.split('.');
  const digits = (whole || '0') + frac.padEnd(decimals, '0').slice(0, decimals);
  const out = digits.replace(/^0+(?=\d)/, '');
  return out;
}

/** "224316" with 2 decimals -> "2243.16" */
export function fromScaledInt(intStr, decimals) {
  const s = String(intStr).padStart(decimals + 1, '0');
  if (decimals === 0) return s;
  return `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

/** Round a float to the market's tick (as a decimal string). */
export function roundTo(value, decimals, mode = 'round') {
  const f = 10 ** decimals;
  const fn = mode === 'up' ? Math.ceil : mode === 'down' ? Math.floor : Math.round;
  return (fn(Number(value) * f) / f).toFixed(decimals);
}

export function fmtNum(v, decimals = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtUsd(v, decimals = 2) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n < 0 ? '-' : ''}$${fmtNum(Math.abs(n), decimals)}`;
}

export function fmtCompact(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 });
}
