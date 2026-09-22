// All CLI commands. Small enough to live in one file.
import { loadEnv, saveEnvValue, HOME_ENV } from './env.js';
import { loadConfig, saveConfig, configPath, currentThread, newThread, listThreads, findThread, setCurrent, loadAgentCache, clearAgentProblem, loadStats, statsLine, JEV_HOME } from './store.js';
import { ADAPTERS, adapter, installed, available, profileOf } from './agents/index.js';
import { route } from './router.js';
import { executeTurn } from './execute.js';
import { compactIfNeeded } from './context.js';
import { checkAgents } from './probe.js';
import { listCriteria, applyCriteria } from './criteria.js';
import { c, ok, warn, fail, log, hr, ask, truncate, closePrompt } from './ui.js';

const cwd = () => process.cwd();

async function ensureKey() {
  loadEnv();
  if (process.env.OPENROUTER_API_KEY) return;
  log(`Jev needs an OpenRouter key to decide which agent gets a request. Get one at ${c.cyan('https://openrouter.ai/keys')}.`);
  const key = await ask('OpenRouter API key', { secret: true });
  if (!key) throw new Error('no key given');
  saveEnvValue('OPENROUTER_API_KEY', key);
  ok(`Saved to ${HOME_ENV}`);
  closePrompt();
}

/** jev "<prompt>" [--to <agent>] [--new] [--quiet] */
export async function askCmd(prompt, { to, fresh, quiet }) {
  if (!prompt?.trim()) {
    log('Usage: jev "what you want done"   (add --to claude|codex|hermes|antigravity|… to skip routing)');
    return;
  }
  const cfg = loadConfig();
  const thread = fresh ? newThread(cwd()) : currentThread(cwd());
  let agentId = to;
  let reason = 'you asked for it';
  if (to && !adapter(to)) throw new Error(`unknown agent "${to}". Known: ${ADAPTERS.map((a) => a.id).join(', ')}`);
  if (to && !installed(adapter(to))) throw new Error(`${to} is not installed (not on PATH)`);
  if (!agentId) {
    loadEnv();
    let r;
    try {
      r = await route(cfg, thread, prompt);
    } catch (err) {
      if (!err.needsKey) throw new Error(`Jev could not decide: ${err.message}. Pin an agent with --to <id> or try again.`);
      await ensureKey();
      r = await route(cfg, thread, prompt);
    }
    agentId = r.agent;
    reason = `${r.reason} · ${(r.ms / 1000).toFixed(1)}s`;
    if (r.unsure) warn(`Jev is not confident. Going with ${agentId}; use --to <id> to override.`);
  }
  const a = adapter(agentId);
  const resuming = Boolean(thread.agentSessions[a.id]);
  log(`${c.bold('→ ' + a.name)} ${c.dim(reason)} ${c.dim(resuming ? '· resuming its session' : thread.turns.length ? '· new session, with thread context' : '· new session')}`);
  hr();
  try {
    let r;
    const excluded = [];
    for (;;) {
      try {
        r = await executeTurn({ cfg, thread, agentId, prompt, cwd: cwd(), quiet });
        break;
      } catch (err) {
        if (!err.authProblem || to || excluded.length >= 2) throw err;
        excluded.push(agentId);
        warn(`${adapter(agentId).name} cannot run here: ${err.message.replace(/^.*?failed: /, '')}. Asking Jev again without it.`);
        const again = await route(cfg, thread, prompt, { exclude: excluded });
        agentId = again.agent;
        log(`${c.bold('→ ' + adapter(agentId).name)} ${c.dim(again.reason)}`);
      }
    }
    hr();
    const bits = [`${r.seconds}s`];
    if (r.cost != null) bits.push(`$${r.cost.toFixed(3)}`);
    if (r.resumed) bits.push(r.resumeVerified === false ? 'resume unverified' : 'resumed');
    if (r.actions?.length) bits.push(`${r.actions.length} actions`);
    log(c.dim(`${a.name} · ${bits.join(' · ')} · thread ${thread.id}${thread.name ? ` (${thread.name})` : ''} · turn ${thread.turns.length}`));
    if (process.env.OPENROUTER_API_KEY) {
      try {
        if (await compactIfNeeded(thread, cfg)) log(c.dim('  (older turns folded into the thread summary)'));
      } catch (err) {
        warn(`could not compact thread: ${err.message}`);
      }
    }
  } catch (err) {
    hr();
    fail(err.message);
    const others = available(cfg).filter((x) => x.id !== agentId);
    if (others.length) log(c.dim(`Try another agent: jev --to ${others[0].id} "…"   (jev agents shows what is usable)`));
    process.exitCode = 1;
  }
}

export function newCmd(name) {
  const t = newThread(cwd(), name ?? '');
  ok(`New thread ${c.bold(t.id)}${name ? ` (${name})` : ''} for ${cwd()}`);
}

export function threadsCmd({ all }) {
  const cur = currentThread(cwd(), { create: false });
  const list = listThreads(all ? undefined : cwd());
  if (!list.length) {
    log(`No threads${all ? '' : ' in this directory'} yet. Just run: jev "…"`);
    return;
  }
  for (const t of list) {
    const mark = cur?.id === t.id ? c.green('●') : ' ';
    const last = t.turns.at(-1);
    log(`${mark} ${c.bold(t.id)} ${t.name ? c.cyan(t.name) + ' ' : ''}${c.dim(`${t.turns.length} turns · ${t.updatedAt.slice(0, 16).replace('T', ' ')}${all ? ' · ' + t.cwd : ''}`)}`);
    if (last) log(`   ${c.dim(`[${last.agent}]`)} ${truncate(last.prompt, 80)}`);
  }
}

export function useCmd(ref) {
  const t = findThread(ref, cwd());
  if (!t) throw new Error(`no thread matching "${ref}"`);
  setCurrent(cwd(), t.id);
  ok(`Now on thread ${t.id}${t.name ? ` (${t.name})` : ''}`);
}

export function historyCmd({ full, archived }) {
  const t = currentThread(cwd(), { create: false });
  if (archived && t?.archivedTurns?.length) {
    log(c.bold(`Archived turns (folded into the summary)`));
    for (const turn of t.archivedTurns) log(`${c.cyan(turn.agent)} ${c.dim(turn.ts.slice(0, 16))} ${truncate(turn.prompt, 100)}`);
    return;
  }
  if (!t || !t.turns.length) {
    log('Nothing yet in this thread.');
    return;
  }
  log(c.bold(`Thread ${t.id}${t.name ? ` (${t.name})` : ''}`) + c.dim(` · ${t.cwd}`));
  if (t.summary) log(`\n${c.dim('Summary of earlier turns:')}\n${t.summary}\n`);
  for (const [i, turn] of t.turns.entries()) {
    hr();
    log(`${c.bold(`#${i + 1}`)} ${c.cyan(turn.agent)} ${c.dim(turn.ts.slice(0, 16).replace('T', ' '))}${turn.resumed ? c.dim(' · resumed') : ''}`);
    log(c.bold('you: ') + (full ? turn.prompt : truncate(turn.prompt, 200)));
    if (turn.actions?.length) log(c.dim('did: ') + c.dim(full ? turn.actions.join(' | ') : truncate(turn.actions.join(' | '), 200)));
    log(c.bold('agent: ') + (full ? turn.response : truncate(turn.response, 300)));
  }
}

export async function agentsCheck() {
  loadEnv();
  const cfg = loadConfig();
  const targets = available(cfg);
  log(`Sending one tiny prompt to ${targets.map((a) => a.id).join(', ')}…`);
  await checkAgents(cfg, targets, { onResult: (r) => (r.ok ? ok(`${r.name} works (${r.seconds}s)`) : fail(`${r.name}: ${r.message}`)) });
}

export function agentsCmd() {
  const cfg = loadConfig();
  const cache = loadAgentCache();
  const stats = loadStats();
  for (const a of ADAPTERS) {
    const path = installed(a);
    const disabled = cfg.agents?.[a.id]?.enabled === false;
    const proven = (stats[a.id]?.runs ?? 0) > (stats[a.id]?.failures ?? 0);
    let status;
    if (!path) status = c.dim('not installed');
    else if (disabled) status = c.yellow('disabled in config');
    else if (cache[a.id]) status = c.red('problem: ') + truncate(cache[a.id].problem, 90);
    else if (!proven) status = c.yellow('untested') + c.dim(' — no successful run here yet; `jev-router agents --check` sends it one tiny prompt');
    else status = c.green('ready') + c.dim(' · ' + statsLine(stats, a.id));
    log(`${c.bold(a.id.padEnd(9))} ${a.name.padEnd(14)} ${status}`);
    if (path) log(`          ${c.dim(profileOf(a, cfg))}`);
  }
  log(`\n${c.dim(`Edit profiles or disable agents in ${configPath()}. "problem" clears itself after a successful run, or: jev agents --reset <id>`)}`);
}

export function agentsReset(id) {
  clearAgentProblem(id);
  ok(`cleared problem flag for ${id}`);
}

export function configCmd(key, value, { yes } = {}) {
  const cfg = loadConfig();
  if (!key) {
    log(JSON.stringify(cfg, null, 2));
    log(c.dim(`\n${configPath()}\nkeys in ${JEV_HOME}/.env`));
    return;
  }
  if (!['model', 'jevModel', 'autonomy', 'keepTurns'].includes(key)) throw new Error(`settable keys: model (compaction), jevModel (routing), autonomy (edits|full), keepTurns. For per-agent settings edit ${configPath()}`);
  if (value == null) {
    log(String(cfg[key]));
    return;
  }
  if (key === 'autonomy' && !['edits', 'full'].includes(value)) throw new Error('autonomy must be "edits" or "full"');
  if (key === 'autonomy' && value === 'full' && !yes) throw new Error('full autonomy lets every agent run commands and edit files with no approval. Re-run with --yes if that is what you want.');
  cfg[key] = key === 'keepTurns' ? Number(value) : value;
  saveConfig(cfg);
  ok(`${key} = ${cfg[key]}`);
}

/** jev-router criteria [key] [value] */
export function criteriaCmd(key, value) {
  if (key) {
    ok(applyCriteria(key, value));
    return;
  }
  const { routing, agents } = listCriteria();
  log(c.bold('How Jev decides'));
  log(`  question    ${routing.question}`);
  log(`  continue    keep the last agent when P(continues) ≥ ${routing.continueFloor}`);
  log(`  confidence  ask you when Jev's confidence < ${routing.confidenceFloor}`);
  log('');
  log(c.bold('What each agent is for') + c.dim('  (this text is exactly what Jev reads)'));
  for (const a of agents) log(`  ${c.cyan(a.id.padEnd(12))}${a.custom ? c.yellow('custom  ') : c.dim('default ')}${a.profile}`);
  log(c.dim(`\nChange with: jev-router criteria <agent> "Best for: … Not for: …"  ·  criteria continue 0.7  ·  criteria confidence 0.5  ·  criteria question "…"  ·  any key + reset`));
}
