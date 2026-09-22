// Jev TUI on @opentui/core (no JSX, no build step). Shape follows OpenCode: scrolling message list,
// prompt pinned at the bottom with a colored left border, slash commands with a popup, pickers as overlays,
// a sidebar on wide terminals, and a one-line status footer.
import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  TextareaRenderable,
  MarkdownRenderable,
  SelectRenderable,
  SelectRenderableEvents,
  ASCIIFontRenderable,
  SyntaxStyle,
  RGBA,
} from '@opentui/core';
import { loadEnv } from './env.js';
import { loadConfig, saveConfig, currentThread, newThread, listThreads, findThread, setCurrent, loadAgentCache, loadStats } from './store.js';
import { ADAPTERS, adapter, installed, available } from './agents/index.js';
import { route, pct } from './router.js';
import { executeTurn } from './execute.js';
import { compactIfNeeded, buildHandoff } from './context.js';
import { checkAgents } from './probe.js';
import { listCriteria, applyCriteria } from './criteria.js';

// ---- theme (dark, terminal background left alone) ----
const T = {
  text: '#d6d6d6',
  muted: '#7a7a7a',
  faint: '#4a4a4a',
  primary: '#7aa2f7',
  user: '#9ece6a',
  warn: '#e0af68',
  error: '#f7768e',
  panel: '#1c1c1c',
  element: '#242424',
  menu: '#2a2a2a',
  select: '#33467c',
};
const AGENT_COLOR = { claude: '#d19a66', codex: '#61afef', hermes: '#c678dd', opencode: '#98c379', antigravity: '#56b6c2', kimi: '#e5c07b', cursor: '#e06c75', auto: T.primary };

const SLASH = [
  { name: '/agent', args: '<id|auto>', desc: 'pin an agent for this thread, or let Jev choose' },
  { name: '/agents', args: '', desc: 'pick an agent from a list' },
  { name: '/new', args: '[name]', desc: 'start a new thread (clears the chat; the old one stays in /threads)' },
  { name: '/clear', args: '', desc: 'same as /new' },
  { name: '/threads', args: '', desc: 'switch thread' },
  { name: '/autonomy', args: 'edits|full', desc: 'edits = agents edit files only; full = skip all approvals' },
  { name: '/check', args: '', desc: 'send one tiny prompt to every untested agent to see which ones work' },
  { name: '/criteria', args: '[agent|continue|confidence|question] [text]', desc: 'see or change how Jev decides' },
  { name: '/context', args: '[agent]', desc: 'show exactly what that agent would be told next' },
  { name: '/model', args: '<openrouter model>', desc: 'model used to compact long threads' },
  { name: '/jev', args: '<model>', desc: 'Jev model used to route (jev-latest)' },
  { name: '/help', args: '', desc: 'keys and commands' },
  { name: '/quit', args: '', desc: 'exit' },
];

const KEYS_HELP = `Enter send · Shift+Enter / Ctrl+J newline · Esc cancel run or close · Tab cycle agent (empty prompt)
Ctrl+N new thread · Ctrl+L threads · Ctrl+O agents · PgUp/PgDn scroll · Ctrl+C quit`;

export async function tui({ renderer: injected, cwd: cwdOverride } = {}) {
  loadEnv();
  const cfg = loadConfig();
  const cwd = cwdOverride ?? process.cwd();
  let thread = currentThread(cwd);
  let pinned = 'auto';
  let running = null; // { abort: AbortController, agent }
  let dialog = null; // { box, select, onClose }
  let popup = null; // slash popup { box, items, index }

  const renderer = injected ?? (await createCliRenderer({ exitOnCtrlC: false, useMouse: true, targetFps: 60, autoFocus: false }));
  const syntax = SyntaxStyle.fromStyles({
    default: { fg: RGBA.fromHex(T.text) },
    'markup.heading': { fg: RGBA.fromHex(T.primary), bold: true },
    'markup.strong': { bold: true },
    'markup.italic': { italic: true },
    'markup.raw': { fg: RGBA.fromHex('#c0caf5') },
    'markup.link': { fg: RGBA.fromHex(T.primary), underline: true },
    'markup.link.url': { fg: RGBA.fromHex(T.muted) },
    'markup.list': { fg: RGBA.fromHex(T.primary) },
    'markup.quote': { fg: RGBA.fromHex(T.muted), italic: true },
  });

  const wide = () => renderer.width >= 100;

  // ---- layout ----
  const root = new BoxRenderable(renderer, { id: 'root', width: '100%', height: '100%', flexDirection: 'column' });
  const body = new BoxRenderable(renderer, { id: 'body', flexDirection: 'row', flexGrow: 1, minHeight: 0 });
  const main = new BoxRenderable(renderer, { id: 'main', flexDirection: 'column', flexGrow: 1, minHeight: 0, paddingLeft: 1, paddingRight: 1 });
  const log = new ScrollBoxRenderable(renderer, { id: 'log', flexGrow: 1, minHeight: 0, stickyScroll: true, stickyStart: 'bottom', scrollY: true, contentOptions: { flexDirection: 'column', gap: 1, paddingTop: 1, paddingBottom: 1 } });

  const promptWrap = new BoxRenderable(renderer, { id: 'promptWrap', flexShrink: 0, flexDirection: 'column', border: ['left'], borderColor: AGENT_COLOR.auto, backgroundColor: T.element, paddingLeft: 1, paddingRight: 1 });
  const input = new TextareaRenderable(renderer, {
    id: 'input',
    minHeight: 1,
    maxHeight: 8,
    wrapMode: 'word',
    backgroundColor: T.element,
    focusedBackgroundColor: T.element,
    textColor: T.text,
    placeholder: 'Ask anything. / for commands',
    placeholderColor: T.muted,
    keyBindings: [
      { name: 'return', action: 'submit' },
      { name: 'return', shift: true, action: 'newline' },
      { name: 'linefeed', action: 'newline' },
      { name: 'j', ctrl: true, action: 'newline' },
    ],
    onContentChange: () => updatePopup(),
    onSubmit: () => submit(),
  });
  const promptMeta = new TextRenderable(renderer, { id: 'promptMeta', fg: T.muted, content: '' });
  promptWrap.add(input);
  promptWrap.add(promptMeta);
  main.add(log);
  main.add(promptWrap);

  const sidebar = new BoxRenderable(renderer, { id: 'sidebar', width: 34, flexShrink: 0, flexDirection: 'column', paddingLeft: 1, paddingRight: 1, paddingTop: 1, gap: 1, visible: wide() });
  const sbThread = new TextRenderable(renderer, { id: 'sbThread', fg: T.text, content: '' });
  const sbAgents = new TextRenderable(renderer, { id: 'sbAgents', fg: T.text, content: '' });
  const sbFooter = new TextRenderable(renderer, { id: 'sbFooter', fg: T.muted, content: '' });
  sidebar.add(new TextRenderable(renderer, { fg: T.primary, content: 'jev-router' }));
  sidebar.add(sbThread);
  sidebar.add(sbAgents);
  sidebar.add(sbFooter);

  body.add(main);
  body.add(sidebar);
  const status = new TextRenderable(renderer, { id: 'status', fg: T.muted, height: 1, paddingLeft: 1, content: '' });
  root.add(body);
  root.add(status);
  renderer.root.add(root);

  // ---- helpers ----
  const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const agentName = (id) => adapter(id)?.name ?? id;
  const setStatus = (msg) => (status.content = msg);
  const idleStatus = () => setStatus('Enter send · / commands · Tab agent · Ctrl+L threads · Ctrl+N new · Esc cancel · Ctrl+C quit');

  function refreshMeta() {
    const color = AGENT_COLOR[pinned] ?? T.primary;
    promptWrap.borderColor = color;
    const agentLabel = pinned === 'auto' ? 'auto (Jev picks)' : agentName(pinned);
    promptMeta.content = `${agentLabel}  ·  ${thread.name || thread.id}  ·  autonomy ${cfg.autonomy}`;
    const cache = loadAgentCache();
    const stats = loadStats();
    const lines = ['agents'];
    for (const a of ADAPTERS) {
      if (!installed(a)) continue;
      const mark = thread.agentSessions[a.id] ? '●' : '○';
      const proven = (stats[a.id]?.runs ?? 0) > (stats[a.id]?.failures ?? 0);
      const state = cache[a.id] ? 'needs attention' : cfg.agents?.[a.id]?.enabled === false ? 'disabled' : proven ? '' : 'untested';
      lines.push(`  ${mark} ${a.id.padEnd(9)}${state}`);
    }
    sbAgents.content = lines.join('\n');
    const cost = thread.turns.reduce((s, t) => s + (t.cost ?? 0), 0);
    sbThread.content = `thread\n  ${thread.name || thread.id}\n  ${thread.turns.length} turns${cost ? ` · $${cost.toFixed(2)}` : ''}`;
    sbFooter.content = `${short(cwd.replace(process.env.HOME ?? '', '~'), 30)}\n● session here · /check tests\n  the untested ones`;
  }

  function addUser(text) {
    const box = new BoxRenderable(renderer, { flexDirection: 'column', border: ['left'], borderColor: T.user, paddingLeft: 1, backgroundColor: T.panel });
    box.add(new TextRenderable(renderer, { fg: T.text, content: text, wrapMode: 'word' }));
    log.add(box);
    return box;
  }
  function addNote(text, color = T.muted) {
    const t = new TextRenderable(renderer, { fg: color, content: text, wrapMode: 'word' });
    log.add(t);
    return t;
  }
  function addError(text) {
    const box = new BoxRenderable(renderer, { flexDirection: 'column', border: ['left'], borderColor: T.error, paddingLeft: 1 });
    box.add(new TextRenderable(renderer, { fg: T.error, content: text, wrapMode: 'word' }));
    log.add(box);
  }
  /** One assistant block: header line, tool lines, streaming markdown, footer. */
  function addAssistant(agentId) {
    const box = new BoxRenderable(renderer, { flexDirection: 'column', gap: 0 });
    const head = new TextRenderable(renderer, { fg: AGENT_COLOR[agentId] ?? T.primary, content: agentName(agentId) });
    const md = new MarkdownRenderable(renderer, { content: '', syntaxStyle: syntax, streaming: true, fg: T.text });
    box.add(head);
    box.add(md);
    log.add(box);
    let text = '';
    let lastTool = null;
    return {
      head,
      text: (s) => {
        text += (text ? '\n\n' : '') + s;
        md.content = text;
      },
      tool: (s) => {
        // tools go above the markdown so prose stays at the bottom while streaming
        const t = new TextRenderable(renderer, { fg: T.muted, content: `  ⚙ ${s}` });
        box.insertBefore(t, md);
        lastTool = t;
      },
      warn: (s) => box.insertBefore(new TextRenderable(renderer, { fg: T.warn, content: `  ! ${s}` }), md),
      note: (s) => box.insertBefore(new TextRenderable(renderer, { fg: T.muted, content: `  ${s}` }), md),
      done: (footer) => {
        md.streaming = false;
        box.add(new TextRenderable(renderer, { fg: T.muted, content: footer }));
      },
    };
  }
  const toBottom = () => log.scrollTo(log.scrollHeight);

  function loadHistory() {
    for (const child of log.getChildren()) log.remove(child);
    if (thread.summary) addNote(`Earlier in this thread (summarised):\n${thread.summary}`);
    for (const t of thread.turns) {
      addUser(t.prompt);
      const a = addAssistant(t.agent);
      if (t.response) a.text(t.response);
      a.done(`${agentName(t.agent)} · ${t.seconds ?? '?'}s${t.cost != null ? ` · $${t.cost.toFixed(3)}` : ''}${t.resumed ? ' · resumed' : ''}`);
    }
    if (!thread.turns.length) {
      // Home: block-letter logo above the prompt, like OpenCode's start screen.
      const logo = new BoxRenderable(renderer, { flexDirection: 'row', gap: 2, marginTop: 1 });
      logo.add(new ASCIIFontRenderable(renderer, { text: 'JEV', font: 'tiny', color: T.muted }));
      logo.add(new ASCIIFontRenderable(renderer, { text: 'ROUTER', font: 'tiny', color: T.text }));
      log.add(logo);
      addNote(`One prompt, every coding agent you have. Jev decides who takes it.\nThread in ${short(cwd.replace(process.env.HOME ?? '', '~'), 60)}. Type a task, / for commands, /agent to pin.`);
    }
    toBottom();
  }

  // ---- slash popup ----
  const popupBox = new BoxRenderable(renderer, { id: 'popup', position: 'absolute', zIndex: 50, flexDirection: 'column', backgroundColor: T.menu, paddingLeft: 1, paddingRight: 1, visible: false });
  root.add(popupBox);
  function updatePopup() {
    const v = input.plainText;
    if (!v.startsWith('/') || v.includes('\n') || v.includes(' ')) return hidePopup();
    const items = SLASH.filter((c) => c.name.startsWith(v));
    if (!items.length) return hidePopup();
    const index = popup ? Math.min(popup.index, items.length - 1) : 0;
    popup = { items, index };
    for (const c of popupBox.getChildren()) popupBox.remove(c);
    items.forEach((c, i) => {
      const sel = i === index;
      popupBox.add(new TextRenderable(renderer, { fg: sel ? T.text : T.muted, bg: sel ? T.select : undefined, content: `${(c.name + ' ' + c.args).padEnd(24)} ${c.desc}` }));
    });
    popupBox.visible = true;
    placePopup();
  }
  function placePopup() {
    if (!popup) return;
    popupBox.left = main.x + 1;
    popupBox.top = Math.max(0, promptWrap.y - popup.items.length);
    popupBox.width = Math.min(main.width - 2, 80);
  }
  function hidePopup() {
    popup = null;
    popupBox.visible = false;
  }

  // ---- dialogs (agent / thread pickers) ----
  function openDialog(title, options, onPick, onCancel) {
    closeDialog();
    const box = new BoxRenderable(renderer, { id: 'dialog', position: 'absolute', zIndex: 100, flexDirection: 'column', backgroundColor: T.panel, border: true, borderColor: T.primary, title: ` ${title} `, titleColor: T.primary, paddingLeft: 1, paddingRight: 1, width: Math.min(76, renderer.width - 4), height: Math.min(options.length * 2 + 3, renderer.height - 4) });
    box.left = Math.max(0, Math.floor((renderer.width - box.width) / 2));
    box.top = Math.max(0, Math.floor((renderer.height - box.height) / 2));
    const select = new SelectRenderable(renderer, {
      options, showDescription: true, wrapSelection: true, backgroundColor: T.panel, focusedBackgroundColor: T.panel, selectedBackgroundColor: T.select, selectedTextColor: T.text, textColor: T.text, descriptionColor: T.muted, selectedDescriptionColor: T.muted, flexGrow: 1,
      // the focused select sees keys before global listeners, so Escape is handled here
      onKeyDown: (key) => {
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
          key.preventDefault();
          key.stopPropagation();
          closeDialog({ cancelled: true });
        }
      },
    });
    select.on(SelectRenderableEvents.ITEM_SELECTED, (_i, opt) => {
      closeDialog();
      onPick(opt);
    });
    box.add(select);
    box.add(new TextRenderable(renderer, { fg: T.muted, content: 'Enter choose · Esc close' }));
    root.add(box);
    dialog = { box, select, onCancel };
    select.focus();
  }
  function closeDialog({ cancelled = false } = {}) {
    if (!dialog) return;
    const d = dialog;
    root.remove(d.box);
    d.box.destroy();
    dialog = null;
    input.focus();
    if (cancelled) d.onCancel?.();
  }
  function pickAgent() {
    const cache = loadAgentCache();
    const opts = [{ name: 'auto', description: 'let Jev choose per request', value: 'auto' }];
    for (const a of available(cfg)) opts.push({ name: a.id, description: `${a.name}${cache[a.id] ? ' · last run failed: ' + short(cache[a.id].problem, 40) : ''}${thread.agentSessions[a.id] ? ' · has a session here' : ''}`, value: a.id });
    openDialog('Agent', opts, (o) => setPinned(o.value));
  }
  function pickThread() {
    const list = listThreads(cwd);
    const opts = list.map((t) => ({ name: `${t.name || t.id}${t.id === thread.id ? '  (current)' : ''}`, description: `${t.turns.length} turns · ${t.updatedAt.slice(0, 16).replace('T', ' ')} · ${short(t.turns.at(-1)?.prompt ?? '', 50)}`, value: t.id }));
    opts.unshift({ name: '+ new thread', description: 'start fresh in this directory', value: '__new' });
    openDialog('Threads', opts, (o) => {
      if (o.value === '__new') return switchThread(newThread(cwd));
      const t = findThread(o.value);
      if (t) switchThread(t);
    });
  }
  function switchThread(t) {
    thread = t;
    setCurrent(cwd, t.id);
    pinned = 'auto';
    loadHistory();
    refreshMeta();
    setStatus(`Now on thread ${t.name || t.id}`);
  }
  function setPinned(id) {
    if (id !== 'auto' && !adapter(id)) return setStatus(`unknown agent "${id}"`);
    if (id !== 'auto' && !installed(adapter(id))) return setStatus(`${id} is not installed`);
    pinned = id;
    refreshMeta();
    setStatus(pinned === 'auto' ? 'Jev picks the agent for each request' : `Pinned to ${agentName(pinned)}`);
  }
  function cycleAgent(dir = 1) {
    const ids = ['auto', ...available(cfg).map((a) => a.id)];
    const i = ids.indexOf(pinned);
    setPinned(ids[(i + dir + ids.length) % ids.length]);
  }

  // ---- commands ----
  async function command(line) {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (cmd) {
      case '/agent':
        if (!arg) return pickAgent();
        return setPinned(arg);
      case '/agents':
        return pickAgent();
      case '/new':
      case '/clear':
        return switchThread(newThread(cwd, arg));
      case '/threads':
        return pickThread();
      case '/autonomy': {
        const [mode, confirm] = arg.split(/\s+/);
        if (!['edits', 'full'].includes(mode)) return setStatus('usage: /autonomy edits|full');
        if (mode === 'full' && confirm !== 'confirm') {
          addError('full autonomy lets every agent run commands and edit files with no approval, in this directory, unattended. Type  /autonomy full confirm  if that is what you want.');
          return toBottom();
        }
        cfg.autonomy = mode;
        saveConfig(cfg);
        refreshMeta();
        return setStatus(`autonomy ${mode}`);
      }
      case '/criteria': {
        const [key, ...restWords] = rest;
        if (key) {
          try {
            const msg = applyCriteria(key, restWords.join(' '), cfg);
            Object.assign(cfg, loadConfig());
            addNote(msg, T.user);
          } catch (err) {
            addError(err.message);
          }
          return toBottom();
        }
        const { routing, agents } = listCriteria(cfg);
        addNote(
          `How Jev decides\n  question    ${routing.question}\n  continue    keep the last agent when P(continues) ≥ ${routing.continueFloor}\n  confidence  ask you when Jev's confidence < ${routing.confidenceFloor}\n\nWhat each agent is for (exactly what Jev reads):\n` +
            agents.map((a) => `  ${a.id.padEnd(12)}${a.custom ? '[custom] ' : ''}${a.profile}`).join('\n') +
            `\n\nChange: /criteria claude Best for: … Not for: …   ·   /criteria continue 0.7   ·   /criteria confidence 0.5   ·   /criteria question …   ·   /criteria <key> reset`,
        );
        return toBottom();
      }
      case '/context': {
        const id = arg || (pinned !== 'auto' ? pinned : thread.turns.at(-1)?.agent) || 'claude';
        if (!adapter(id)) return setStatus(`unknown agent "${id}"`);
        const resuming = Boolean(thread.agentSessions[id]);
        const block = buildHandoff(thread, { forAgent: id, resuming, keepTurns: cfg.keepTurns });
        addNote(`What ${agentName(id)} would be told next (${resuming ? 'resuming its session, so only what others did since' : 'fresh session, so the thread so far'}):\n${block || '(nothing: it already has everything in its own session)'}`);
        return toBottom();
      }
      case '/jev':
        if (!arg) return setStatus(`Jev model is ${cfg.jevModel}`);
        cfg.jevModel = arg;
        saveConfig(cfg);
        return setStatus(`Jev model ${arg}`);
      case '/model':
        if (!arg) return setStatus(`model is ${cfg.model}`);
        cfg.model = arg;
        saveConfig(cfg);
        return setStatus(`model ${arg}`);
      case '/check': {
        const cache = loadAgentCache();
        const stats = loadStats();
        const targets = available(cfg).filter((a) => cache[a.id] || (stats[a.id]?.runs ?? 0) <= (stats[a.id]?.failures ?? 0));
        if (!targets.length) return setStatus('Every installed agent already has a successful run here.');
        addNote(`Checking ${targets.map((a) => a.id).join(', ')} with one tiny prompt each…`);
        toBottom();
        setStatus('Checking agents…');
        await checkAgents(cfg, targets, {
          cwd,
          onResult: (r) => {
            addNote(r.ok ? `  ✔ ${r.name} works (${r.seconds}s)` : `  ✖ ${r.name}: ${r.message}`, r.ok ? T.user : T.error);
            refreshMeta();
            toBottom();
          },
        });
        idleStatus();
        return;
      }
      case '/help':
        addNote(`Commands\n${SLASH.map((c) => `  ${(c.name + ' ' + c.args).padEnd(26)} ${c.desc}`).join('\n')}\n\nKeys\n  ${KEYS_HELP.replace(/\n/g, '\n  ')}`);
        return toBottom();
      case '/quit':
      case '/exit':
        return quit();
      default:
        return setStatus(`unknown command ${cmd}. Try /help`);
    }
  }

  // ---- send ----
  async function submit() {
    if (popup) {
      const c = popup.items[popup.index];
      const typed = input.plainText.trim();
      hidePopup();
      // Enter runs the command when it is typed in full or takes no arguments; otherwise it completes it.
      if (!c.args || typed === c.name) {
        input.clear();
        hidePopup();
        return command(c.name);
      }
      input.setText(c.name + ' ');
      input.cursorOffset = input.plainText.length;
      return;
    }
    const text = input.plainText.trim();
    if (!text) return;
    if (running) return setStatus('An agent is still working. Esc cancels it.');
    input.clear();
    if (text.startsWith('/')) return command(text);
    addUser(text);
    toBottom();

    let agentId = pinned;
    let reason = 'pinned';
    let routeInfo = '';
    if (agentId === 'auto') {
      setStatus('Jev is deciding…');
      let r;
      try {
        r = await route(cfg, thread, text);
      } catch (err) {
        addError(err.needsKey ? 'No OPENROUTER_API_KEY, so Jev cannot decide. Put the key in ~/.jev/.env, or pin an agent with /agent <id>.' : `Jev could not decide: ${err.message}. Pin an agent with /agent <id> or try again.`);
        idleStatus();
        return;
      }
      agentId = r.agent;
      reason = r.reason;
      routeInfo = ` · ${(r.ms / 1000).toFixed(1)}s`;
      if (r.unsure) {
        // Jev is split: show the split and let the person choose, instead of guessing.
        const opts = Object.entries(r.probabilities)
          .sort((a, b) => b[1] - a[1])
          .map(([id, p]) => ({ name: `${id}  ${pct(p)}`, description: adapter(id)?.name ?? id, value: id }));
        addNote(`Jev is split on this one: ${r.reason.replace(/^Jev is split: /, '')}. Pick who should take it.`);
        toBottom();
        const picked = await new Promise((resolve) => openDialog('Jev is not sure. Who takes it?', opts, (o) => resolve(o.value), () => resolve(null)));
        if (!picked) {
          idleStatus();
          return;
        }
        agentId = picked;
        reason = `you chose (Jev had ${pct(r.probabilities[picked] ?? 0)})`;
      }
    }
    const resuming = Boolean(thread.agentSessions[agentId]);
    addNote(`→ ${agentName(agentId)} · ${reason}${routeInfo}${resuming ? ' · resuming its session' : thread.turns.length ? ' · new session with thread context' : ''}`);
    const block = addAssistant(agentId);
    const abort = new AbortController();
    running = { abort, agent: agentId };
    let dots = 0;
    const spin = setInterval(() => {
      dots = (dots + 1) % 4;
      setStatus(`${agentName(agentId)} is working${'.'.repeat(dots)}   Esc to cancel`);
    }, 300);
    try {
      let r;
      const excluded = [];
      for (;;) {
        try {
          r = await executeTurn({ cfg, thread, agentId, prompt: text, cwd, signal: abort.signal, onEvent: (kind, s) => (kind === 'text' ? block.text(s) : kind === 'tool' ? block.tool(s) : kind === 'note' ? block.note(s) : block.warn(s)) });
          break;
        } catch (err) {
          // The agent Jev picked cannot run here (login, config). Ask Jev again without it, once or twice.
          if (!err.authProblem || pinned !== 'auto' || excluded.length >= 2) throw err;
          excluded.push(agentId);
          block.warn(`${agentName(agentId)} cannot run here: ${err.message.replace(/^.*?failed: /, '')}`);
          const again = await route(cfg, thread, text, { exclude: excluded });
          agentId = again.agent;
          block.head.content = agentName(agentId);
          block.head.fg = AGENT_COLOR[agentId] ?? T.primary;
          addNote(`→ ${agentName(agentId)} · ${again.reason} · re-decided without ${excluded.join(', ')}`);
          running.agent = agentId;
        }
      }
      block.done(`${agentName(agentId)} · ${r.seconds}s${r.cost != null ? ` · $${r.cost.toFixed(3)}` : ''}${r.resumed ? (r.resumeVerified === false ? ' · resume unverified' : ' · resumed') : ''}${r.actions?.length ? ` · ${r.actions.length} actions` : ''}`);
      try {
        if (await compactIfNeeded(thread, cfg)) addNote('(older turns folded into the thread summary)');
      } catch {
        /* non-fatal */
      }
    } catch (err) {
      block.done(err.cancelled ? 'cancelled' : 'failed');
      if (!err.cancelled) addError(err.message);
    } finally {
      clearInterval(spin);
      running = null;
      refreshMeta();
      idleStatus();
      toBottom();
    }
  }

  function quit() {
    if (running) running.abort.abort();
    renderer.destroy();
    if (injected) return;
    process.stdout.write(`jev-router · thread ${thread.name || thread.id} · ${thread.turns.length} turns · resume with: jev-router\n`);
    process.exit(0);
  }

  // ---- keys (global, run before the focused textarea) ----
  renderer.keyInput.on('keypress', (key) => {
    const name = key.name;
    if (process.env.JEV_KEYDEBUG) console.error('[key]', name, key.ctrl ? 'ctrl' : '', key.shift ? 'shift' : '');
    if (dialog) {
      if (name === 'escape') {
        key.preventDefault();
        key.stopPropagation();
        closeDialog({ cancelled: true });
      }
      return;
    }
    if (popup) {
      if (name === 'up' || name === 'down') {
        popup.index = (popup.index + (name === 'up' ? -1 : 1) + popup.items.length) % popup.items.length;
        updatePopup();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (name === 'tab') {
        const c = popup.items[popup.index];
        input.setText(c.name + (c.args ? ' ' : ''));
        input.cursorOffset = input.plainText.length;
        hidePopup();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
      if (name === 'escape') {
        hidePopup();
        key.preventDefault();
        key.stopPropagation();
        return;
      }
    }
    if (key.ctrl && name === 'c') {
      key.preventDefault();
      key.stopPropagation();
      if (running) {
        running.abort.abort();
        setStatus('Cancelling…');
        return;
      }
      if (input.plainText) return input.clear();
      return quit();
    }
    if (name === 'escape') {
      if (running) {
        running.abort.abort();
        setStatus('Cancelling…');
      }
      return;
    }
    if (key.ctrl && name === 'n') {
      key.preventDefault();
      key.stopPropagation();
      return switchThread(newThread(cwd));
    }
    if (key.ctrl && name === 'l') {
      key.preventDefault();
      key.stopPropagation();
      return pickThread();
    }
    if (key.ctrl && name === 'o') {
      key.preventDefault();
      key.stopPropagation();
      return pickAgent();
    }
    if (name === 'tab' && !input.plainText) {
      key.preventDefault();
      key.stopPropagation();
      return cycleAgent(key.shift ? -1 : 1);
    }
    if (name === 'pageup' || name === 'pagedown') {
      key.preventDefault();
      key.stopPropagation();
      log.scrollBy(name === 'pageup' ? -Math.floor(log.height / 2) : Math.floor(log.height / 2));
    }
  });
  renderer.on('resize', () => {
    sidebar.visible = wide();
    placePopup();
  });

  loadHistory();
  refreshMeta();
  idleStatus();
  input.focus();
  return { renderer, submit, command, get thread() { return thread; }, get pinned() { return pinned; }, get running() { return running; }, get dialogOpen() { return Boolean(dialog); } };
}
