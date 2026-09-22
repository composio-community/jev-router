// Adapter registry. Each adapter:
//   id, name, bin, profile (what it's good at, shown to Jev), resumes (bool)
//   build({ prompt, sessionId, newSessionId, cwd, autonomy, extraArgs }) -> { cmd, args, stdin? }
//   parse(line, state, emit) -> mutates state { text, sessionId }; emit(kind, text) for live display
//   finish(state, exit) -> optional post-processing
import { spawnSync } from 'node:child_process';
import claude from './claude.js';
import codex from './codex.js';
import hermes from './hermes.js';
import opencode from './opencode.js';
import antigravity from './antigravity.js';
import kimi from './kimi.js';
import cursor from './cursor.js';

export const ADAPTERS = [claude, codex, hermes, antigravity, opencode, kimi, cursor];

export function adapter(id) {
  return ADAPTERS.find((a) => a.id === id || a.aliases?.includes(id)) ?? null;
}

const which = new Map();
export function installed(a) {
  if (!which.has(a.bin)) {
    const r = spawnSync('sh', ['-c', `command -v ${a.bin}`], { encoding: 'utf8' });
    which.set(a.bin, r.status === 0 ? r.stdout.trim() : '');
  }
  return which.get(a.bin);
}

/** Adapters that are installed and not disabled in config. */
export function available(cfg) {
  return ADAPTERS.filter((a) => installed(a) && cfg.agents?.[a.id]?.enabled !== false);
}

/** Effective profile text for Jev's routing prompt (config can override). */
export function profileOf(a, cfg) {
  return cfg.agents?.[a.id]?.profile || a.profile;
}
