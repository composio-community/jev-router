// Everything Jev remembers lives in ~/.jev:
//   config.json           settings + per-agent overrides
//   current.json          which thread each directory is on
//   threads/<id>.json     one conversation: turns, per-agent session ids, rolling summary
//   agents-cache.json     last known problem per agent (so the router stops picking a broken one)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const JEV_HOME = process.env.JEV_HOME || path.join(os.homedir(), '.jev');
const CONFIG = path.join(JEV_HOME, 'config.json');
const CURRENT = path.join(JEV_HOME, 'current.json');
const THREADS = path.join(JEV_HOME, 'threads');
const AGENT_CACHE = path.join(JEV_HOME, 'agents-cache.json');

export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file); // atomic on POSIX: readers never see a half-written file
}

/** Simple advisory lock so two jev processes can't clobber one thread. Stale after 30s. */
export function withLock(file, fn) {
  const lock = file + '.lock';
  const start = Date.now();
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age > 30_000) {
        fs.rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() - start > 10_000) throw new Error(`thread is locked by another jev process (${lock})`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

// ---- config ----
export const DEFAULT_JEV_MODEL = 'jev-latest'; // TypeSafe's System One model, via OpenRouter's /v1/systemone

export function defaultConfig() {
  return {
    model: DEFAULT_MODEL, // OpenRouter model used to compact history
    jevModel: DEFAULT_JEV_MODEL, // Jev decides which agent gets each request
    autonomy: 'edits', // edits = agents may edit files but not run risky commands; full = skip all approvals
    keepTurns: 10, // verbatim turns kept in the handoff context before older ones are summarised
    agents: {}, // per-agent: { enabled: false, profile: "what it's good at", extraArgs: [] }
    routing: { ...DEFAULT_ROUTING },
  };
}

// The knobs Jev's decision is built from. All editable with `jev-router criteria` or /criteria in the TUI.
export const DEFAULT_ROUTING = {
  continueFloor: 0.7, // P(request continues the last turn) at or above this → the last agent keeps it
  confidenceFloor: 0.5, // Jev's confidence in its agent choice below this → ask the person
  question: 'Which coding agent should handle `request`? Judge by what the work needs.',
};
export function loadConfig() {
  const base = defaultConfig();
  const saved = readJson(CONFIG, {});
  return { ...base, ...saved, agents: { ...base.agents, ...(saved.agents ?? {}) }, routing: { ...DEFAULT_ROUTING, ...(saved.routing ?? {}) } };
}
export function saveConfig(cfg) {
  writeJson(CONFIG, cfg);
}
export function configPath() {
  return CONFIG;
}

// ---- agent cache (problems seen at runtime) ----
export function loadAgentCache() {
  return readJson(AGENT_CACHE, {});
}
export function noteAgentProblem(id, message) {
  const cache = loadAgentCache();
  cache[id] = { problem: String(message).slice(0, 300), at: new Date().toISOString() };
  writeJson(AGENT_CACHE, cache);
}
export function clearAgentProblem(id) {
  const cache = loadAgentCache();
  if (cache[id]) {
    delete cache[id];
    writeJson(AGENT_CACHE, cache);
  }
}

// ---- threads ----
function threadFile(id) {
  return path.join(THREADS, id + '.json');
}
export function newThread(cwd, name = '') {
  const id = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + crypto.randomBytes(3).toString('hex');
  const t = { id, name, cwd, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), summary: '', turns: [], agentSessions: {} };
  writeJson(threadFile(id), t);
  setCurrent(cwd, id);
  return t;
}
export function loadThread(id) {
  return readJson(threadFile(id), null);
}
const MAX_RESPONSE = 20_000;
const MAX_ACTIONS = 60;

export function saveThread(t) {
  t.updatedAt = new Date().toISOString();
  writeJson(threadFile(t.id), t);
}

/** Re-read the thread under a lock, apply fn to the fresh copy, save. Returns the fresh thread. */
export function updateThread(t, fn) {
  return withLock(threadFile(t.id), () => {
    const fresh = loadThread(t.id) ?? t;
    fn(fresh);
    saveThread(fresh);
    Object.assign(t, fresh);
    return t;
  });
}
export function listThreads(cwd) {
  if (!fs.existsSync(THREADS)) return [];
  return fs
    .readdirSync(THREADS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(THREADS, f), null))
    .filter((t) => t && (!cwd || t.cwd === cwd))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}
/** Resolve a thread by exact id, id prefix, or name. */
export function findThread(ref, cwd) {
  const all = listThreads();
  return all.find((t) => t.id === ref) ?? all.find((t) => t.name && t.name === ref) ?? all.find((t) => t.id.startsWith(ref)) ?? (cwd ? all.find((t) => t.cwd === cwd && t.name === ref) : null) ?? null;
}

// ---- current thread per directory ----
export function currentThread(cwd, { create = true } = {}) {
  const map = readJson(CURRENT, {});
  const id = map[cwd];
  const t = id ? loadThread(id) : null;
  if (t) return t;
  return create ? newThread(cwd) : null;
}
export function setCurrent(cwd, id) {
  const map = readJson(CURRENT, {});
  map[cwd] = id;
  writeJson(CURRENT, map);
}

export function addTurn(t, turn) {
  const record = { ts: new Date().toISOString(), ...turn };
  if (typeof record.response === 'string' && record.response.length > MAX_RESPONSE) record.response = record.response.slice(0, MAX_RESPONSE) + '\n…[stored response truncated]';
  if (Array.isArray(record.actions) && record.actions.length > MAX_ACTIONS) record.actions = [...record.actions.slice(0, MAX_ACTIONS - 1), `… ${record.actions.length - MAX_ACTIONS + 1} more`];
  updateThread(t, (fresh) => {
    fresh.turns.push(record);
    if (turn.agentSessionId) fresh.agentSessions[turn.agent] = turn.agentSessionId;
  });
}

// ---- per-agent evidence: runs, failures, timing, cost (feeds routing) ----
const STATS = path.join(JEV_HOME, 'stats.json');
export function loadStats() {
  return readJson(STATS, {});
}
export function recordRun(agentId, { ok, seconds, cost }) {
  const stats = loadStats();
  const s = stats[agentId] ?? { runs: 0, failures: 0, seconds: 0, cost: 0 };
  s.runs += 1;
  if (!ok) s.failures += 1;
  if (ok && seconds) s.seconds += seconds;
  if (ok && cost) s.cost += cost;
  s.lastAt = new Date().toISOString();
  stats[agentId] = s;
  writeJson(STATS, stats);
}
export function statsLine(stats, id) {
  const s = stats[id];
  if (!s || !s.runs) return 'no runs yet';
  const okRuns = s.runs - s.failures;
  const avg = okRuns ? (s.seconds / okRuns).toFixed(0) : '?';
  const cost = okRuns && s.cost ? ` · avg $${(s.cost / okRuns).toFixed(2)}` : '';
  return `${s.runs} runs, ${s.failures} failed, avg ${avg}s${cost}`;
}
