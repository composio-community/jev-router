// Edit what Jev decides with: per-agent profile text, the two thresholds, and the question wording.
import { loadConfig, saveConfig, DEFAULT_ROUTING } from './store.js';
import { ADAPTERS, adapter, installed, profileOf } from './agents/index.js';

export function listCriteria(cfg = loadConfig()) {
  const routing = { ...DEFAULT_ROUTING, ...(cfg.routing ?? {}) };
  const agents = ADAPTERS.filter(installed).map((a) => ({ id: a.id, name: a.name, profile: profileOf(a, cfg), custom: Boolean(cfg.agents?.[a.id]?.profile) }));
  return { routing, agents };
}

/**
 * apply('claude', 'Best for: …') · apply('claude', 'reset') · apply('continue', '0.7') · apply('confidence', '0.5')
 * apply('question', 'Which agent …') · apply('question', 'reset'). Returns a one-line confirmation.
 */
export function applyCriteria(key, value, cfg = loadConfig()) {
  cfg.routing = { ...DEFAULT_ROUTING, ...(cfg.routing ?? {}) };
  const v = String(value ?? '').trim();
  if (key === 'continue' || key === 'confidence') {
    const field = key === 'continue' ? 'continueFloor' : 'confidenceFloor';
    const n = v === 'reset' ? DEFAULT_ROUTING[field] : Number(v);
    if (!(n >= 0 && n <= 1)) throw new Error(`${key} must be a number between 0 and 1 (e.g. 0.7), or "reset"`);
    cfg.routing[field] = n;
    saveConfig(cfg);
    return key === 'continue' ? `Jev keeps the last agent when P(continues) ≥ ${n}` : `Jev asks you when its confidence is below ${n}`;
  }
  if (key === 'question') {
    if (!v) throw new Error('give the question text, or "reset"');
    cfg.routing.question = v === 'reset' ? DEFAULT_ROUTING.question : v;
    saveConfig(cfg);
    return `Jev is now asked: ${cfg.routing.question}`;
  }
  const a = adapter(key);
  if (!a) throw new Error(`unknown key "${key}". Use an agent id (${ADAPTERS.map((x) => x.id).join(', ')}), continue, confidence, or question`);
  cfg.agents = cfg.agents ?? {};
  cfg.agents[a.id] = cfg.agents[a.id] ?? {};
  if (!v) throw new Error(`give the new profile text for ${a.id}, or "reset"`);
  if (v === 'reset') delete cfg.agents[a.id].profile;
  else cfg.agents[a.id].profile = v;
  saveConfig(cfg);
  return v === 'reset' ? `${a.name} profile back to default` : `${a.name} profile updated`;
}
