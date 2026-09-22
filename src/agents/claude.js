import { jsonLine } from '../run.js';

export default {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  resumes: true,
  profile:
    'Claude Code. Best for: explaining or exploring an existing codebase, answering questions about how code works, multi-file refactors, debugging tricky bugs, careful edits with tests. Slower and more expensive per run.',
  build({ prompt, sessionId, newSessionId, autonomy, extraArgs = [] }) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose'];
    if (sessionId) args.push('--resume', sessionId);
    else if (newSessionId) args.push('--session-id', newSessionId);
    if (autonomy === 'full') args.push('--dangerously-skip-permissions');
    else args.push('--permission-mode', 'acceptEdits');
    args.push(...extraArgs);
    // prompt goes over stdin: no argv length limit, no shell quoting surprises
    return { cmd: 'claude', args, stdin: prompt };
  },
  parse(line, state, emit) {
    const ev = jsonLine(line);
    if (!ev) return;
    if (ev.session_id) state.sessionId = ev.session_id;
    if (ev.type === 'assistant') {
      for (const part of ev.message?.content ?? []) {
        if (part.type === 'text' && part.text) emit('text', part.text);
        if (part.type === 'tool_use') emit('tool', `${part.name} ${summarize(part.input)}`);
      }
    } else if (ev.type === 'result') {
      if (typeof ev.result === 'string') state.text = ev.result;
      if (ev.total_cost_usd != null) state.cost = ev.total_cost_usd;
      if (ev.is_error) state.error = ev.result || ev.subtype || 'error';
    }
  },
};

function summarize(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.query ?? input.description ?? '';
  return String(v).slice(0, 80);
}
