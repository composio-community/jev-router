# jev-router

```
  █ █▀▀ █ █   █▀█ █▀█ █ █ ▀█▀ █▀▀ █▀█
█▄█ ██▄ ▀▄▀   █▀▄ █▄█ █▄█  █  ██▄ █▀▄
```

One place to talk to every coding agent you have installed. Jev picks the agent, runs it in your directory, and keeps the conversation going across agents and across runs.

```
jev-router            # opens the TUI   (jev is a short alias)
jev-router "…"        # one-shot from a script or another shell
```

Every agent that joins a thread gets a compact handoff of what the others did. An agent that comes back resumes its own native session and is told only what happened since it left.

## The TUI

Built on OpenTUI, the same renderer OpenCode uses, so it looks and feels like OpenCode: a scrolling message list with streaming markdown, a prompt pinned at the bottom whose left border takes the colour of the agent you're on, a sidebar on wide terminals, and a one-line footer.

| you do | what happens |
| --- | --- |
| type and press Enter | Jev picks an agent (or uses the pinned one), streams its output into the log, records the turn |
| Shift+Enter or Ctrl+J | newline in the prompt |
| `/` | slash-command popup: `/agent`, `/agents`, `/new` (or `/clear`), `/threads`, `/check`, `/criteria`, `/context`, `/autonomy`, `/model`, `/jev`, `/help`, `/quit`. Up/Down to move, Tab to complete, Enter to run |
| Tab on an empty prompt | cycle the pinned agent (auto → claude → codex → …) |
| Ctrl+O · Ctrl+L · Ctrl+N | agent picker · thread picker · new thread |
| Esc | cancel the running agent, or close a popup or picker |
| PgUp / PgDn | scroll the log |
| Ctrl+C | quit (cancels a running agent first) |

Needs Node 26.4 or newer, because OpenTUI talks to its native renderer over Node's FFI. The one-shot commands below work on the same runtime.

## Install

```bash
npm install          # pulls @opentui/core
npm link             # gives you `jev` on PATH
jev agents           # shows which agents you have: claude, codex, hermes, agy (Antigravity), opencode, kimi, cursor-agent
jev                  # open the TUI
```

Jev itself needs one OpenRouter key to decide routing and to compact long threads. It asks on first use and stores it in `~/.jev/.env`. Force an agent with `--to` and Jev never calls a model of its own.

## Commands

| command | what it does |
| --- | --- |
| `jev` | open the TUI |
| `jev "…"` | one-shot: route, run, remember. Add `--to <agent>` to choose yourself, `--new` to start a fresh thread first. |
| `jev threads [--all]` | threads in this directory, `●` marks the current one |
| `jev new [name]` | start a new thread |
| `jev use <id\|name>` | switch threads |
| `jev history [--full]` | every turn in the current thread, with which agent handled it |
| `jev agents [--reset <id>]` | installed agents, their profiles, and any problem seen on the last run |
| `jev criteria [key] [value]` | how Jev decides: agent profiles, thresholds, the question |
| `jev config [key] [value]` | `model`, `jevModel`, `autonomy` (`edits` or `full`), `keepTurns` |

## How state works

Everything is in `~/.jev` (or `$JEV_HOME`):

- `threads/<id>.json`: the turns (agent, prompt, response, **actions** the agent took such as tool calls and file changes, cost, seconds), one native session id per agent, a rolling summary, and the archived turns that were folded into it. Writes are atomic and guarded by a lock file, so two `jev` processes on one thread cannot clobber each other. Stored responses are capped at 20k characters.
- `current.json`: which thread each directory is on. Threads are per directory by default.
- `config.json`: `model` (compaction), `routerModel` (agent choice), `autonomy`, `keepTurns`, and per-agent overrides (`enabled`, `profile`, `extraArgs`).
- `stats.json`: per-agent runs, failures, average seconds and cost. This is the evidence the router uses.
- `agents-cache.json`: the last auth or config problem an agent hit, so routing avoids it until it works again.

Handoff rules, in [src/context.js](src/context.js):

1. New agent in a thread: gets the summary plus the last `keepTurns` exchanges. Each exchange carries the prompt, what the agent **did** (tool calls, files written), and what it answered, clipped from the middle so both the start and the conclusion survive.
2. Returning agent: resumed with its own session id, plus only the exchanges other agents had since its last turn. Jev checks that the agent echoed the same session id; if the resume failed outright it retries once as a fresh session with the full context and says so.
3. Long threads: turns beyond `2 × keepTurns` are folded into the summary by one model call. The originals are kept under `archivedTurns` (`jev history --archived`).
4. The block is labelled as a quoted record, with an explicit instruction not to follow directives found inside it.

`/context [agent]` in the TUI shows the exact block that agent would receive next.

## Routing

[src/router.js](src/router.js), fastest path first:

1. **No model call** when an agent is pinned, when only one usable agent exists, or when the request reads as a follow-up to the last turn within two hours (short messages, "now…", "fix that", pronouns pointing at previous work). These route in under a millisecond and the agent resumes its own session.
2. Otherwise **one small-model call** (`routerModel`, default a flash-class model) gets each agent's profile plus measured evidence: runs, failures, average seconds and cost, and whether it already has a session here. Trivial asks are steered to the fastest cheap agent, hard ones to the most capable.
3. If the model call fails or there is no key, Jev falls back to the last agent used.

## Changing how Jev decides

Everything Jev's decision is built from is editable, from the TUI (`/criteria`) or the shell (`jev-router criteria`). No arguments lists the current state.

| change | TUI | shell |
| --- | --- | --- |
| what an agent is for (the text Jev reads) | `/criteria codex Best for: … Not for: …` | `jev-router criteria codex "Best for: … Not for: …"` |
| when the last agent keeps a follow-up | `/criteria continue 0.7` | `jev-router criteria continue 0.7` |
| when Jev asks you instead of guessing | `/criteria confidence 0.5` | `jev-router criteria confidence 0.5` |
| the question Jev is asked | `/criteria question Which agent …` | `jev-router criteria question "Which agent …"` |
| back to default | `/criteria <key> reset` | `jev-router criteria <key> reset` |

Jev reads profile text literally, so write it as "Best for: … Not for: …" with concrete task types, and avoid numbers or comparisons (see TypeSafe's notes on [jagged edges](https://docs.typesafe.ai/model-jaggedness/jev-1.13)). Changes apply to the next request. The routing line in the log always shows the reason and Jev's top probabilities.

## Autonomy

`edits` (default) passes each agent's edit-friendly mode: Claude `acceptEdits`, Codex `workspace-write` sandbox, Antigravity `--mode accept-edits`. Agents still differ in what they will run without asking. `full` passes each agent's skip-all-approvals flag and needs `/autonomy full confirm` in the TUI or `jev config autonomy full --yes` in the shell.

## How each agent is driven

Flags verified by running each CLI.

| agent | headless | resume | session id from |
| --- | --- | --- | --- |
| claude | `claude -p --output-format stream-json`, prompt on stdin | `--resume <id>`; Jev pre-sets `--session-id` | result event `session_id` |
| codex | `codex exec --json -`, prompt on stdin | `codex exec resume <id>` | `thread.started.thread_id` |
| hermes | `hermes chat -Q -q` | `--resume <id>` | `session_id:` line on stderr |
| opencode | `opencode run --format json` | `--session <id>` | `sessionID` in events |
| antigravity | `agy -p --output-format stream-json --add-dir <cwd>` | `--conversation <id>` | `init.conversation_id` |
| kimi | `kimi -p --output-format stream-json` | `-S <id>` | sniffed from events |
| cursor | `cursor-agent -p --output-format json` | `--resume <id>` | sniffed from events |

Autonomy `edits` (default) lets agents edit files but keeps their own approval rules for commands. `full` passes each agent's skip-all-approvals flag.
