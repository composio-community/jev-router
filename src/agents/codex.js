import { jsonLine } from '../run.js';

export default {
  id: 'codex',
  name: 'Codex CLI',
  bin: 'codex',
  resumes: true,
  profile:
    'Codex CLI. Best for: writing a new script or small feature from a clear spec, running tests and fixing failures, contained tasks in one area of the code. Fast, sandboxed. Not for: broad questions about how a codebase works.',
  build({ prompt, sessionId, autonomy, extraArgs = [] }) {
    // `codex exec resume` accepts --json/--skip-git-repo-check/--dangerously-bypass… but NOT -s:
    // a resumed thread keeps the sandbox it was created with.
    const args = ['exec'];
    if (sessionId) args.push('resume', sessionId);
    args.push('--json', '--skip-git-repo-check');
    if (autonomy === 'full') args.push('--dangerously-bypass-approvals-and-sandbox');
    else if (!sessionId) args.push('-s', 'workspace-write');
    args.push(...extraArgs, '-'); // '-' = read the prompt from stdin
    return { cmd: 'codex', args, stdin: prompt };
  },
  parse(line, state, emit) {
    const ev = jsonLine(line);
    if (!ev) return;
    if (ev.type === 'thread.started' && ev.thread_id) state.sessionId = ev.thread_id;
    if (ev.type === 'item.completed' || ev.type === 'item.updated') {
      const it = ev.item ?? {};
      if (it.type === 'agent_message' && it.text) {
        state.text = it.text;
        emit('text', it.text);
      } else if (it.type === 'command_execution' && it.command && ev.type === 'item.completed') emit('tool', `run ${String(it.command).slice(0, 80)}`);
      else if (it.type === 'file_change' && ev.type === 'item.completed') emit('tool', `edit ${(it.changes ?? []).map((c) => c.path).join(', ').slice(0, 80)}`);
      else if (it.type === 'error' && it.message && !/deprecated/i.test(it.message)) emit('warn', it.message); // config deprecation notices are noise, not failures
    }
    if (ev.type === 'turn.completed' && ev.usage) state.usage = ev.usage;
    if (ev.type === 'error' || ev.type === 'turn.failed') state.error = String(ev.message ?? ev.error ?? 'codex error').slice(0, 300);
  },
};
