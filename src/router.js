// Routing = one Jev call. Jev (TypeSafe's System One model) reads the request and the recent thread and returns
// a calibrated choice over the available agents. Code applies the two gates: "continue with the last agent"
// and "confidence too low to act". There is no heuristic path and no silent fallback: if Jev cannot be
// reached, the caller gets an error and the user picks.
import { systemOne, choice, noul } from './jev.js';
import { available, profileOf } from './agents/index.js';
import { loadAgentCache } from './store.js';

import { DEFAULT_ROUTING } from './store.js';
export const CONTINUE_FLOOR = DEFAULT_ROUTING.continueFloor;
export const CONFIDENCE_FLOOR = DEFAULT_ROUTING.confidenceFloor;
const routingOf = (cfg) => ({ ...DEFAULT_ROUTING, ...(cfg.routing ?? {}) });

const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n) + '…' : String(s ?? ''));

/** Build the Jev request for a prompt. Exported so /context and tests can show exactly what Jev sees. */
export function buildDecision(cfg, thread, prompt, pool) {
  const last = thread.turns.at(-1);
  const lastAgent = last && pool.find((a) => a.id === last.agent);
  const recent = thread.turns.slice(-4).map((t) => ({ agent: t.agent, request: clip(t.prompt, 300), answer: clip(t.response, 300) }));
  const state = {
    request: prompt.slice(0, 4000),
    last_turn: last ? { agent: last.agent, request: clip(last.prompt, 400), answer: clip(last.response, 400), did: (last.actions ?? []).slice(0, 8) } : null,
    earlier_turns: recent.slice(0, -1),
  };
  const criteria = {};
  for (const a of pool) {
    const profile = profileOf(a, cfg);
    criteria[a.id] = lastAgent?.id === a.id ? { covers: profile, note: 'This agent handled last_turn and still has that context loaded.' } : profile;
  }
  const questions = {
    agent: choice(routingOf(cfg).question, criteria),
  };
  if (lastAgent) {
    questions.continues = noul('Does `request` continue, correct, or extend the work described in `last_turn`, rather than start something new?', {
      true: 'It refers to what was just done ("now add a test for it", "fix that", "make it shorter") or asks for the next step of the same task.',
      false: 'It is a new, separate task, or a greeting or question unrelated to last_turn.',
    });
  }
  return { state, questions, lastAgent };
}

export async function route(cfg, thread, prompt, { fetchImpl, exclude = [] } = {}) {
  const t0 = Date.now();
  const cache = loadAgentCache();
  const candidates = available(cfg);
  if (!candidates.length) throw new Error('No coding agents found on PATH. Install one of: claude, codex, hermes, agy (Antigravity), opencode, kimi, cursor-agent.');
  const pool = candidates.filter((a) => !cache[a.id] && !exclude.includes(a.id));
  if (!pool.length) throw new Error(`Every installed agent failed its last run (${candidates.map((a) => a.id).join(', ')}). Fix one and run \`jev agents --reset <id>\`, or \`jev agents --check\`.`);
  if (pool.length === 1) return { agent: pool[0].id, reason: 'only usable agent', confidence: 1, probabilities: { [pool[0].id]: 1 }, ms: Date.now() - t0 };

  const { state, questions, lastAgent } = buildDecision(cfg, thread, prompt, pool);
  const res = await systemOne({ model: cfg.jevModel || 'jev-latest', state, questions, fetchImpl });
  const agentAnswer = res.answers.agent;
  const continues = res.answers.continues?.noul ?? 0;
  const probabilities = agentAnswer.probabilities ?? {};
  const ms = Date.now() - t0;
  const { continueFloor, confidenceFloor } = routingOf(cfg);

  if (lastAgent && continues >= continueFloor) {
    return { agent: lastAgent.id, reason: `continues its last turn (${pct(continues)})`, confidence: continues, probabilities, continues, ms, model: res.model };
  }
  const pick = pool.find((a) => a.id === agentAnswer.choice) ?? pool[0];
  const conf = Number(agentAnswer.confidence) || 0;
  const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${pct(v)}`).join(', ');
  return {
    agent: pick.id,
    reason: conf < confidenceFloor ? `Jev is split: ${top}` : `Jev: ${top}`,
    confidence: conf,
    unsure: conf < confidenceFloor,
    probabilities,
    continues,
    ms,
    model: res.model,
  };
}

export const pct = (v) => `${Math.round((Number(v) || 0) * 100)}%`;
