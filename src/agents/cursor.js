import { jsonLine, sniffSessionId } from '../run.js';

export default {
  id: 'cursor',
  name: 'Cursor Agent',
  bin: 'cursor-agent',
  aliases: ['cursor-agent'],
  resumes: true,
  profile:
    'Cursor Agent. Best for: everyday coding tasks for people who also use the Cursor editor.',
  build({ prompt, sessionId, autonomy, extraArgs = [] }) {
    const args = ['-p', '--output-format', 'json'];
    if (sessionId) args.push('--resume', sessionId);
    if (autonomy === 'full') args.push('-f');
    args.push(...extraArgs, prompt);
    return { cmd: 'cursor-agent', args };
  },
  parse(line, state, emit) {
    const ev = jsonLine(line);
    if (!ev) {
      if (line.trim()) emit('text', line);
      return;
    }
    const sid = sniffSessionId(ev);
    if (sid) state.sessionId = sid;
    const text = ev.result ?? ev.text ?? ev.content ?? ev.message?.content;
    if (typeof text === 'string' && text) {
      state.text = text;
      emit('text', text);
    }
    if (ev.is_error || ev.error) state.error = String(ev.error ?? ev.result ?? 'cursor error').slice(0, 300);
  },
};
