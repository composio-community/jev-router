#!/usr/bin/env node
import { c, fail } from '../src/ui.js';
import * as cmds from '../src/commands.js';

const argv = process.argv.slice(2);
const flags = {};
const rest = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--to' || a === '-t') flags.to = argv[++i];
  else if (a === '--new' || a === '-n') flags.fresh = true;
  else if (a === '--quiet' || a === '-q') flags.quiet = true;
  else if (a === '--all') flags.all = true;
  else if (a === '--full') flags.full = true;
  else if (a === '--yes' || a === '-y') flags.yes = true;
  else if (a === '--archived') flags.archived = true;
  else if (a === '--check') flags.check = true;
  else if (a === '--reset') flags.reset = argv[++i];
  else rest.push(a);
}

const LOGO = [
  `${c.dim('  █ █▀▀ █ █')}   ${c.bold('█▀█ █▀█ █ █ ▀█▀ █▀▀ █▀█')}`,
  `${c.dim('█▄█ ██▄ ▀▄▀')}   ${c.bold('█▀▄ █▄█ █▄█  █  ██▄ █▀▄')}`,
].join('\n');

const HELP = `
${LOGO}

${c.bold('jev-router')} — one command in front of every coding agent you have installed. ${c.dim('(`jev` works too)')}

  ${c.bold('jev-router')}                 open the TUI (chat with all your agents in one place)
  ${c.bold('jev-router "do the thing"')}  one-shot: Jev picks an agent, runs it here, remembers the turn
  ${c.bold('jev --to codex "…"')}          skip routing and name the agent (claude, codex, hermes, antigravity, opencode, kimi, cursor)
  ${c.bold('jev --new "…"')}               start a fresh thread first

  ${c.bold('jev threads')} [--all]         threads in this directory (● = current)
  ${c.bold('jev new')} [name]              start a new thread
  ${c.bold('jev use <id|name>')}           switch the current thread
  ${c.bold('jev history')} [--full|--archived]  what has happened in the current thread, across agents
  ${c.bold('jev agents')} [--check|--reset <id>]  what is installed; --check sends one tiny prompt to each
  ${c.bold('jev criteria')} [key] [value]  how Jev decides: per-agent profiles, thresholds, the question. No args lists it.
  ${c.bold('jev config')} [key] [value]    model · jevModel · autonomy (edits|full, needs --yes) · keepTurns

Jev (TypeSafe's System One model, via OpenRouter) picks the agent. Every agent sees the thread so far when it joins,
and resumes its own native session when it comes back.
State lives in ~/.jev. Set JEV_HOME to move it.
`;

const COMMANDS = new Set(['tui', 'threads', 'new', 'use', 'history', 'agents', 'criteria', 'config', 'help', '--help', '-h']);
const cmd = COMMANDS.has(rest[0]) ? rest.shift() : rest.length ? 'ask' : 'tui';

try {
  switch (cmd) {
    case 'tui':
      await (await import('../src/tui.js')).tui();
      break;
    case 'ask':
      await cmds.askCmd(rest.join(' '), flags);
      break;
    case 'threads':
      cmds.threadsCmd(flags);
      break;
    case 'new':
      cmds.newCmd(rest[0]);
      break;
    case 'use':
      cmds.useCmd(rest[0] ?? '');
      break;
    case 'history':
      cmds.historyCmd(flags);
      break;
    case 'agents':
      if (flags.reset) cmds.agentsReset(flags.reset);
      else if (flags.check) await cmds.agentsCheck();
      else cmds.agentsCmd();
      break;
    case 'criteria':
      cmds.criteriaCmd(rest[0], rest.slice(1).join(' '));
      break;
    case 'config':
      cmds.configCmd(rest[0], rest[1], flags);
      break;
    case 'help':
    case '--help':
    case '-h':
    default:
      console.log(HELP);
  }
} catch (err) {
  fail(err?.message ?? String(err));
  if (process.env.JEV_DEBUG) console.error(err);
  process.exitCode = 1;
}
