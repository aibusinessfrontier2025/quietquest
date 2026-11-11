import { randomBytes } from 'node:crypto';

export const now = () => Date.now();

/** Short, readable ids: p_ab12cd, t_…, a_… */
export function newId(prefix) {
  return `${prefix}_${randomBytes(4).toString('hex')}`;
}

export function slugify(text) {
  const slug = String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'project';
}

export function truncate(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n… [truncated ${s.length - max} chars]`;
}

/** One-line preview of arbitrary text. */
export function oneLine(text, max = 140) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Splits a byte stream into lines and hands each parsed JSON object to `onJson`.
 * Non-JSON lines go to `onOther` (CLIs occasionally print plain text).
 */
export function createJsonLineReader(onJson, onOther = () => {}) {
  let buffer = '';
  const handle = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      onOther(trimmed);
      return;
    }
    onJson(parsed);
  };
  return {
    push(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        handle(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
      }
    },
    flush() {
      if (buffer) handle(buffer);
      buffer = '';
    },
  };
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Shortens an absolute path for one-line display: relative to `base` when inside it, else its tail. */
export function shortPath(value, base = '') {
  const text = String(value ?? '');
  if (!text.startsWith('/')) return text;
  if (base && (text === base || text.startsWith(`${base}/`))) return text.slice(base.length + 1) || '.';
  const parts = text.split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : text;
}
