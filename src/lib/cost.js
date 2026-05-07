// Per-tick token usage + estimated USD cost for the Claude Code runtime.
//
// Reads the agent's session JSONL files at ~/.claude/projects/<slug>/
// (slug = agent dir with `/` replaced by `-`), filters events to those
// written since `tickStartEpochSeconds`, sums per-model usage, applies
// Anthropic public pricing, and returns a single one-line summary.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Anthropic public pricing (USD per 1M tokens), current as of 2026.
//   (input, output, cache_write_5m, cache_read)
const PRICING = {
  opus: [15.0, 75.0, 18.75, 1.5],
  sonnet: [3.0, 15.0, 3.75, 0.3],
  haiku: [0.8, 4.0, 1.0, 0.08],
};

function priceFor(model) {
  const m = (model || '').toLowerCase();
  if (m.includes('opus')) return PRICING.opus;
  if (m.includes('sonnet')) return PRICING.sonnet;
  if (m.includes('haiku')) return PRICING.haiku;
  return PRICING.sonnet;
}

function fmtTok(n) {
  for (const [unit, div] of [
    ['B', 1_000_000_000],
    ['M', 1_000_000],
    ['k', 1_000],
  ]) {
    if (n >= div) return (n / div).toFixed(2) + unit;
  }
  return String(Math.floor(n));
}

function shortModel(model) {
  return model.startsWith('claude-') ? model.slice('claude-'.length) : model;
}

/**
 * @param {string} agentDir   absolute agent dir
 * @param {number} tickStartEpochSeconds  epoch seconds at start of tick
 * @returns {string|null} one-line summary, or null if no usage events found
 */
export function tickCostLine(agentDir, tickStartEpochSeconds) {
  // Match the Python tick-cost behaviour: replace each `/` with `-` on the
  // absolute path. "/Users/foo/bar" → "-Users-foo-bar" (leading dash kept).
  const slug = path.resolve(agentDir).split('/').join('-');
  const sessionDir = path.join(os.homedir(), '.claude', 'projects', slug);

  let entries;
  try {
    entries = readdirSync(sessionDir);
  } catch {
    return null; // no session yet
  }

  /** @type {Record<string, [number, number, number, number, number]>} */
  const byModel = {};

  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(sessionDir, name);
    let mtimeSec;
    try {
      mtimeSec = statSync(file).mtimeMs / 1000;
    } catch {
      continue;
    }
    if (mtimeSec < tickStartEpochSeconds - 1) continue;

    let raw;
    try {
      raw = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let ev;
      try {
        ev = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const ts = ev.timestamp || ev.time;
      if (!ts) continue;
      let t;
      try {
        t = new Date(ts).getTime() / 1000;
      } catch {
        continue;
      }
      if (!Number.isFinite(t) || t < tickStartEpochSeconds) continue;

      const usage = ev.message?.usage;
      if (!usage) continue;
      const model = ev.message?.model || 'unknown';
      const b = (byModel[model] ||= [0, 0, 0, 0, 0]);
      b[0] += Number(usage.input_tokens || 0);
      b[1] += Number(usage.output_tokens || 0);
      b[2] += Number(usage.cache_creation_input_tokens || 0);
      b[3] += Number(usage.cache_read_input_tokens || 0);
      b[4] += 1;
    }
  }

  const models = Object.keys(byModel).sort();
  if (!models.length) return null;

  let totalTok = 0;
  let totalCost = 0;
  const parts = [];
  for (const model of models) {
    const [i, o, cc, cr, m] = byModel[model];
    const [pin, pout, pcc, pcr] = priceFor(model);
    const cost = (i * pin + o * pout + cc * pcc + cr * pcr) / 1_000_000;
    const tok = i + o + cc + cr;
    totalTok += tok;
    totalCost += cost;
    parts.push(
      `${shortModel(model)}:msgs=${m} tok=${fmtTok(tok)}(${fmtTok(i + o)}+cc=${fmtTok(cc)}+cr=${fmtTok(cr)}) $${cost.toFixed(4)}`,
    );
  }
  return `tick-cost total=${fmtTok(totalTok)} $${totalCost.toFixed(4)}  [${parts.join(' | ')}]`;
}
