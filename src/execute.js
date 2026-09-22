// Run one turn with one agent: build the command, stream output, capture the session id, verify the resume,
// record what the agent did (not just what it said), and store the turn.
import crypto from 'node:crypto';
import { adapter } from './agents/index.js';
import { runStreaming } from './run.js';
import { buildHandoff } from './context.js';
import { addTurn, noteAgentProblem, clearAgentProblem, recordRun } from './store.js';
import { c } from './ui.js';

export const AUTH_HINTS = [/login/i, /sign in/i, /not authenticated/i, /unauthori[sz]ed/i, /401/, /api key/i, /ineligible/i, /requires a newer version/i, /free tier can only be used/i];
const RESUME_FAIL = [/no conversation found/i, /session .*not found/i, /thread .*not found/i, /no rollout found/i, /resume failed/i, /could not (find|load|resume)/i, /unknown session/i, /no such session/i];

/** Default event sink for the one-shot CLI: prints to stdout. */
export function stdoutSink() {
  let lastKind = null;
  return (kind, text) => {
    if (kind === 'text') process.stdout.write((lastKind === 'tool' ? '\n' : '') + text + '\n');
    else if (kind === 'tool') process.stdout.write(c.dim(`  ⚙ ${text}`) + '\n');
    else if (kind === 'warn') process.stdout.write(c.yellow(`  ! ${text}`) + '\n');
    else if (kind === 'note') process.stdout.write(c.dim(`  ${text}`) + '\n');
    lastKind = kind;
  };
}

/**
 * @param onEvent (kind: 'text'|'tool'|'warn'|'note', text) live output; defaults to stdout
 * @param signal  AbortSignal to cancel the agent
 */
export async function executeTurn({ cfg, thread, agentId, prompt, cwd, quiet = false, onEvent, signal }) {
  const a = adapter(agentId);
  if (!a) throw new Error(`unknown agent "${agentId}"`);
  const sink = quiet ? () => {} : onEvent ?? stdoutSink();
  const prior = thread.agentSessions[a.id];
  const wantResume = Boolean(prior && a.resumes);

  let attempt = await runOnce({ cfg, thread, a, prompt, cwd, sink, signal, resuming: wantResume, prior });
  if (attempt.resumeFailed) {
    sink('note', `${a.name} could not resume session ${prior}; starting fresh with the full thread context`);
    delete thread.agentSessions[a.id];
    attempt = await runOnce({ cfg, thread, a, prompt, cwd, sink, signal, resuming: false, prior: undefined });
  }
  return attempt.result;
}

async function runOnce({ cfg, thread, a, prompt, cwd, sink, signal, resuming, prior }) {
  const handoff = buildHandoff(thread, { forAgent: a.id, resuming, keepTurns: cfg.keepTurns });
  const fullPrompt = handoff + prompt;
  const newSessionId = crypto.randomUUID();
  const { cmd, args, stdin } = a.build({
    prompt: fullPrompt,
    sessionId: resuming ? prior : undefined,
    newSessionId,
    cwd,
    autonomy: cfg.autonomy,
    extraArgs: cfg.agents?.[a.id]?.extraArgs ?? [],
  });

  const state = { text: '', sessionId: null, cost: null, error: null };
  const actions = [];
  const emit = (kind, text) => {
    if (kind === 'tool' || kind === 'warn') actions.push(kind === 'tool' ? text : `warning: ${text}`);
    sink(kind, text);
  };
  let errBuf = '';
  const onStderr = (chunk) => {
    if (!a.parseStderr) return;
    errBuf += chunk;
    let i;
    while ((i = errBuf.indexOf('\n')) >= 0) {
      a.parseStderr(errBuf.slice(0, i), state);
      errBuf = errBuf.slice(i + 1);
    }
  };

  const started = Date.now();
  const res = await runStreaming(cmd, args, { cwd, stdin, signal, onLine: (line) => a.parse(line, state, emit), onStderr });
  const seconds = Math.round((Date.now() - started) / 10) / 100;
  const stderrTail = res.stderr.trim().split('\n').slice(-6).join('\n');

  if (res.aborted) {
    const sid = state.sessionId ?? (resuming ? prior : null);
    if (state.text || sid) addTurn(thread, { agent: a.id, prompt, response: state.text, actions, agentSessionId: sid, resumed: resuming, cost: state.cost, seconds, cwd, cancelled: true });
    const err = new Error(`${a.name} cancelled`);
    err.cancelled = true;
    throw err;
  }

  const failed = res.code !== 0 || state.error || (!state.text && !res.killed && stderrTail);
  if (failed) {
    const msg = state.error || (res.killed ? 'timed out' : stderrTail || `exit code ${res.code}`);
    if (resuming && RESUME_FAIL.some((re) => re.test(msg))) return { resumeFailed: true };
    const authProblem = AUTH_HINTS.some((re) => re.test(msg));
    if (authProblem) noteAgentProblem(a.id, msg);
    recordRun(a.id, { ok: false, seconds });
    const err = new Error(`${a.name} failed: ${msg}`);
    err.partial = state.text;
    err.authProblem = authProblem; // caller may ask Jev to re-decide without this agent
    err.agent = a.id;
    throw err;
  }
  clearAgentProblem(a.id);

  // Resume verification: the agent should hand back the id we asked it to continue.
  let sessionId = state.sessionId;
  let resumeVerified = null;
  if (resuming) {
    resumeVerified = !state.sessionId || state.sessionId === prior;
    if (!resumeVerified) sink('note', `${a.name} returned a different session id (${state.sessionId}); it may not have had its earlier context. Jev now tracks the new one.`);
    sessionId = state.sessionId ?? prior;
  } else if (!sessionId && a.id === 'claude') {
    sessionId = newSessionId; // we pre-set it on the command line
  }

  recordRun(a.id, { ok: true, seconds, cost: state.cost });
  addTurn(thread, { agent: a.id, prompt, response: state.text, actions, agentSessionId: sessionId ?? null, resumed: resuming, resumeVerified, cost: state.cost, seconds, cwd });
  return { result: { text: state.text, sessionId, cost: state.cost, seconds, resumed: resuming, resumeVerified, actions } };
}
