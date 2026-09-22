// One tiny prompt per agent, in parallel, to find out which installed agents actually work here.
// Records the outcome in stats and the problem cache exactly like a real run would, but never touches a thread.
import { runStreaming } from './run.js';
import { recordRun, noteAgentProblem, clearAgentProblem } from './store.js';
import { AUTH_HINTS } from './execute.js';

const PROBE = 'Reply with exactly the word: ready';

export async function probeAgent(cfg, a, { cwd = process.cwd(), timeoutMs = 90_000 } = {}) {
  const { cmd, args, stdin } = a.build({ prompt: PROBE, autonomy: 'edits', extraArgs: cfg.agents?.[a.id]?.extraArgs ?? [], newSessionId: undefined });
  const state = { text: '', sessionId: null, error: null };
  const started = Date.now();
  let res;
  try {
    res = await runStreaming(cmd, args, { cwd, stdin, timeoutMs, onLine: (line) => a.parse(line, state, () => {}), onStderr: (chunk) => a.parseStderr && chunk.split('\n').forEach((l) => a.parseStderr(l, state)) });
  } catch (err) {
    return finish(a, false, err.message, started);
  }
  const stderrTail = res.stderr.trim().split('\n').slice(-4).join('\n');
  const failed = res.code !== 0 || state.error || (!state.text && stderrTail) || res.killed;
  return finish(a, !failed, failed ? state.error || (res.killed ? 'timed out' : stderrTail || `exit code ${res.code}`) : '', started);
}

function finish(a, ok, message, started) {
  const seconds = Math.round((Date.now() - started) / 10) / 100;
  recordRun(a.id, { ok, seconds });
  if (ok) clearAgentProblem(a.id);
  else if (AUTH_HINTS.some((re) => re.test(message))) noteAgentProblem(a.id, message);
  return { id: a.id, name: a.name, ok, seconds, message: String(message).slice(0, 200) };
}

/** Probe several agents at once. onResult fires as each finishes. */
export async function checkAgents(cfg, agents, { onResult, cwd } = {}) {
  return Promise.all(agents.map((a) => probeAgent(cfg, a, { cwd }).then((r) => (onResult?.(r), r))));
}
