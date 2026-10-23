// Byte formatting for the decoded view.

const hex2 = (b) => b.toString(16).toUpperCase().padStart(2, '0');

export const FORMATS = [
  ['hex', 'Hex'],
  ['ascii', 'ASCII (escaped)'],
  ['dec', 'Decimal'],
  ['bin', 'Binary'],
  ['dump', 'Hex + ASCII'],
];

const ESC = { 0x00: '\\0', 0x07: '\\a', 0x08: '\\b', 0x09: '\\t', 0x0a: '\\n', 0x0d: '\\r', 0x1b: '\\e' };

function escapeControl(ch) {
  const c = ch.codePointAt(0);
  if (c in ESC) return ESC[c];
  if (c < 0x20 || c === 0x7f) return `\\x${hex2(c)}`;
  return ch;
}

/** UTF-8 text with control characters escaped; falls back to per-byte escapes for binary data. */
function asciiText(bytes) {
  let out = '';
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    for (const ch of text) {
      out += escapeControl(ch);
      if (ch === '\n') out += '\n';
    }
    return out;
  } catch {
    for (const b of bytes) {
      out += b < 0x80 ? escapeControl(String.fromCharCode(b)) : `\\x${hex2(b)}`;
      if (b === 0x0a) out += '\n';
    }
    return out;
  }
}

function hexDump(bytes) {
  const rows = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    const hex = Array.from(chunk, hex2).join(' ').padEnd(47, ' ');
    const txt = Array.from(chunk, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    rows.push(`${i.toString(16).toUpperCase().padStart(4, '0')}  ${hex}  |${txt}|`);
  }
  return rows.join('\n');
}

export function formatBytes(bytes, fmt) {
  switch (fmt) {
    case 'dec':
      return Array.from(bytes, (b) => String(b)).join(' ');
    case 'bin':
      return Array.from(bytes, (b) => b.toString(2).padStart(8, '0')).join(' ');
    case 'ascii':
      return asciiText(bytes);
    case 'dump':
      return hexDump(bytes);
    default:
      return Array.from(bytes, hex2).join(' ');
  }
}

export const hexToRgb = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [213, 221, 232];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
