import { jsonLine, sniffSessionId } from '../run.js';

export default {
  id: 'kimi',
  name: 'Kimi Code',
  bin: 'kimi',
  resumes: true,
  profile:
    'Kimi Code. Best for: routine, well-specified implementation work at low cost.',
  build({ prompt, sessionId, autonomy, extraArgs = [] }) {
    const args = ['-p', prompt, '--output-format', 'stream-json'];
    if (sessionId) args.push('-S', sessionId);
    if (autonomy === 'full') args.push('-y'); // --auto cannot be combined with --prompt, so edits mode uses Kimi's defaults
    args.push(...extraArgs);
    return { cmd: 'kimi', args };
  },
  parse(line, state, emit) {
    const ev = jsonLine(line);
    if (!ev) return;
    const sid = sniffSessionId(ev);
    if (sid) state.sessionId = sid;
    const text = ev.text ?? ev.content ?? ev.message?.content ?? ev.delta;
    if (typeof text === 'string' && text) {
      state.text = (state.text ?? '') + text;
      emit('text', text);
    }
    if (ev.error) state.error = String(ev.error?.message ?? ev.error).slice(0, 300);
  },
};
