// Google Antigravity CLI (`agy`), the successor to Gemini CLI for individual developers.
// Verified 2026-09-21 on agy 1.2.7: `agy -p <prompt> --output-format stream-json` emits
//   {event:'init', conversation_id}
//   {event:'step_update', step_update:{step_type:'user_input'|'agent_response'|'tool', state, tool_name, tool_info:{parameters,output}, text_delta}}
//   {event:'result', result:{conversation_id, status, response, duration_seconds, usage}}
// Resume with --conversation <id>. Without --add-dir it runs shell commands in its own scratch dir, so we always pass the cwd.
import { jsonLine } from '../run.js';

export default {
  id: 'antigravity',
  name: 'Antigravity',
  bin: 'agy',
  aliases: ['agy', 'gemini'],
  resumes: true,
  profile:
    'Google Antigravity CLI (Gemini models). Best for: summarising very large documents or many files at once, Google Cloud and Google Workspace APIs, quick scripts. Not for: deep multi-file refactors when Claude Code is available.',
  build({ prompt, sessionId, cwd, autonomy, extraArgs = [] }) {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--disable-slash-commands'];
    if (cwd) args.push('--add-dir', cwd);
    if (sessionId) args.push('--conversation', sessionId);
    if (autonomy === 'full') args.push('--dangerously-skip-permissions');
    else args.push('--mode', 'accept-edits');
    args.push(...extraArgs);
    return { cmd: 'agy', args };
  },
  parse(line, state, emit) {
    const ev = jsonLine(line);
    if (!ev) {
      // agy prints permission denials as plain text; surface them so the user knows why nothing happened
      if (/permission|auto-denied|allow-rule/i.test(line)) emit('warn', line.trim().slice(0, 200));
      return;
    }
    if (ev.event === 'init' && ev.conversation_id) state.sessionId = ev.conversation_id;
    if (ev.event === 'step_update') {
      const su = ev.step_update ?? {};
      if (su.step_type === 'tool' && su.state === 'ACTIVE') {
        const p = su.tool_info?.parameters ?? {};
        const detail = p.CommandLine ?? p.command ?? p.AbsolutePath ?? p.path ?? p.TargetFile ?? p.Query ?? Object.values(p).find((v) => typeof v === 'string') ?? '';
        emit('tool', `${su.tool_name ?? 'tool'} ${String(detail).slice(0, 80)}`);
      } else if (su.step_type === 'tool' && su.state === 'ERROR') {
        emit('warn', `${su.tool_name ?? 'tool'} failed`);
      } else if (su.step_type === 'agent_response' && typeof su.text_delta === 'string') {
        state.partial = (state.partial ?? '') + su.text_delta;
      }
    }
    if (ev.event === 'result') {
      const r = ev.result ?? {};
      if (r.conversation_id) state.sessionId = r.conversation_id;
      if (typeof r.response === 'string') {
        state.text = r.response.trim();
        if (state.text) emit('text', state.text);
      }
      if (r.status && r.status !== 'SUCCESS') state.error = `agy status ${r.status}`;
    }
  },
};
