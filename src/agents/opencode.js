import { jsonLine, sniffSessionId } from '../run.js';

export default {
  id: 'opencode',
  name: 'OpenCode',
  bin: 'opencode',
  resumes: true,
  profile:
    'OpenCode. Best for: everyday code edits when a specific bring-your-own model is wanted. Requires a provider configured in OpenCode.',
  build({ prompt, sessionId, extraArgs = [] }) {
    const args = ['run', '--format', 'json'];
    if (sessionId) args.push('--session', sessionId);
    args.push(...extraArgs, prompt);
    return { cmd: 'opencode', args };
  },
  parse(line, state, emit) {
    const ev = jsonLine(line);
    if (!ev) return;
    const sid = ev.sessionID ?? sniffSessionId(ev);
    if (sid) state.sessionId = sid;
    const text = ev.part?.text ?? ev.text ?? (ev.type === 'text' ? ev.content : null);
    if (typeof text === 'string' && text) {
      state.text = (state.text ? state.text + '\n' : '') + text;
      emit('text', text);
    }
    if (ev.type === 'tool' || ev.part?.type === 'tool') emit('tool', String(ev.part?.tool ?? ev.tool ?? 'tool'));
    if (ev.type === 'error') state.error = String(ev.error?.data?.message ?? ev.error ?? 'opencode error').slice(0, 300);
  },
};
