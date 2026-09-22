export default {
  id: 'hermes',
  name: 'Hermes Agent',
  bin: 'hermes',
  resumes: true,
  profile:
    'Hermes Agent. Best for: research and web lookups, summarising external information, ops and glue tasks outside a code repository, tasks that need memory across days. Not for: editing source code in a repository.',
  build({ prompt, sessionId, autonomy, extraArgs = [] }) {
    const args = ['chat', '-Q', '-q', prompt];
    if (sessionId) args.push('--resume', sessionId);
    if (autonomy === 'full') args.push('--yolo');
    args.push(...extraArgs);
    return { cmd: 'hermes', args };
  },
  // Hermes prints "session_id: …" on stderr, the answer on stdout.
  parseStderr(line, state) {
    const m = line.match(/^session_id:\s*(\S+)/);
    if (m) state.sessionId = m[1];
  },
  parse(line, state, emit) {
    if (/^session_id:\s*\S+/.test(line)) {
      state.sessionId = line.split(/\s+/)[1];
      return;
    }
    state.text = (state.text ? state.text + '\n' : '') + line;
    emit('text', line);
  },
};
