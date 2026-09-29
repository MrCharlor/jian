# Changelog

Every release of Jian, newest first.

<!-- Generated from docs/releases by scripts/changelog.mjs. Edit the release note, then run `make changelog`. -->

## 0.4.3 — 2026-09-29

GPT-6.1 Sol and model-specific higher reasoning levels for OpenAI.

### Models and reasoning

* **GPT-6.1 Sol:** ChatGPT-connected accounts can select it when their Codex catalog offers it. The gateway now requests the current Codex model catalog instead of an older client-version view.
* **Extra High and Maximum:** The model and conversation selectors offer `xhigh` and `max` only when the model's capabilities include them. For ChatGPT accounts, supported efforts come from that account's Codex catalog; API-key accounts use the public model catalog.
* **No false Ultracode option:** The Codex catalog's `ultra` level describes automatic task delegation, which the gateway does not implement. It remains unavailable in Jian rather than appearing as a misleading reasoning-only setting.

### Upgrading

No migration or configuration change is required. Model availability still depends on the connected account or API key. The model list refreshes automatically; saved defaults remain unchanged.

## 0.4.2 — 2026-09-29

Task workers reuse their profile's Git SSH access, and completed task workspaces are reclaimed.

### Task workers

* **Git authentication:** a worker can use private keys and SSH configuration from its own agent profile without copying the keys into the worker workspace. Landlock-enabled hosts grant read-only access to that profile's `.ssh` directory; the existing no-Landlock caveat still applies elsewhere. Git commands also rewrite `https://bitbucket.org/` URLs to Bitbucket SSH, so existing HTTPS clone instructions can use the profile's SSH key. The profile must already have a usable key and trusted host configuration.
* **Workspace cleanup:** once a task is done and all of its workers have stopped, Jian removes their Git worktrees and temporary workspaces. Cleanup is retried after a restart. Active and blocked tasks keep their workspaces. Commit and push any worker changes before marking a task done: cleanup removes uncommitted files in those worktrees.

### Work panel

* Opening a task focuses its heading instead of highlighting the Close task button. The Activity loading orb is smaller and centered in its panel.

### Upgrading

No migration or configuration change is required. Existing completed tasks with leftover worker workspaces are cleaned up by the run queue.

## 0.4.1 — 2026-09-29

Task workers are easier to follow, and recoverable MCP lookup failures no longer stop a run.

### Agent workflows

* **Task worker reports:** when a worker finishes, its principal is resumed and its response is queued for delivery to the originating chat channel, including Telegram. The report no longer exists only in the gateway session.
* **Isolated repositories:** code tasks can name up to four repository roots in the agent workspace. Each worker receives its own Git worktrees under `repos/`, starting from committed `HEAD`, instead of sharing a writable checkout with the principal. Uncommitted changes are not copied and must be committed before a worktree is prepared.
* **Task details:** the board shows the repositories attached to a task.

### Diagnostics

* **MCP lookup failures:** errors from tools declared read-only are returned to the agent so it can recover or choose another path. Calls that may change external state still stop when their outcome is unknown; the run error now names the tool and the reason. This does not fix errors originating in an MCP server, such as a missing `Mcp-Param-owner` header.
* **Conversation history:** tool steps remain visible with an unanswered or failed run, and a temporary timeline fetch failure no longer clears steps already shown in the panel.

### Upgrading

The gateway adds a `repositories` column to existing tasks on startup. Existing tasks keep an empty repository list; no manual migration is needed.

## 0.4.0 — 2026-09-29

Conversations keep their context across runs, and new Work tasks start an executor automatically.

### Agent context

* **Continuous conversations:** new runs receive session messages since the last saved summary instead of a fixed set of 40 recent messages. Unanswered group messages remain part of that history. Relevant, sanitized tool inputs and results from earlier runs are also available as historical evidence, without repeating the calls.
* **Model-aware compaction:** Jian summarizes older conversation and tool context as the selected model's window fills, preserving the current request and recent work. Original messages remain stored. If context still cannot fit, the run reports the failure instead of silently dropping history.
* **Run limits:** the cumulative 500,000-token stop is removed. Each model call must still fit its model's context window; a 500-step backstop remains. Provider-reported usage continues to be recorded, and provider spending limits still apply.

### Work

* Creating a task now queues an executor subagent in the same transaction. Task guidance asks for enough context to act independently, including the objective, source references, current evidence, acceptance criteria, and next actions. The principal agent can continue orchestrating without duplicating the worker's execution.

### Upgrading

The gateway applies an additive session-summary cursor migration on startup. Existing messages and summaries are retained; no manual configuration is required.

## 0.3.0 — 2026-09-29

More reliable agent workflows, with optional Ponytail and Caveman support.

### Agent workflows

* **Work:** task workers can mark verified work done directly when an independent review is unnecessary. Work guidance now calls for task updates at meaningful checkpoints and before reporting completion, and recommends subagents for substantial independent tasks.
* **Jev:** action decisions can understand a recent, specific owner confirmation without treating older requests as blanket authorization. A held action remains a local decision instead of being misread as outside content. The daily token ceiling and its unused panel controls have been removed; individual Jev uses can still be switched off.
* **Tool results:** with Caveman mode on, large local command and file results preserve a useful beginning and outcome in their previews, with the complete result available as an artifact.

### Optional extensions

* **Ponytail:** built-in coding guidance can be switched off per agent, and its conversation mode can be changed with `/ponytail` commands.
* **Caveman:** built-in concise-response guidance is opt-in per conversation. The image includes a local Caveman proxy in record mode, disabled by default. Set `JIAN_CAVEMAN_ENABLED=true` to start it and route native OpenAI and Anthropic API-key calls through it. Subscription and other provider routes remain direct. The proxy address defaults to `http://127.0.0.1:8788` and can be overridden for an externally managed listener.

### Upgrading

The gateway applies the new conversation-mode migrations on startup. No action is needed unless you want to enable the Caveman proxy; leave `JIAN_CAVEMAN_ENABLED` unset or `false` to keep direct provider calls.

## 0.2.0 — 2026-09-29

Agent-managed work boards and isolated task subagents arrive in Jian.

### Features

* **Work:** agents can track tasks across chats on a durable, per-agent board, with status, progress notes, history and optional images. The gateway panel lets the owner inspect the board and each task's activity, but only the agent can create or change tasks.
* **Task subagents:** a principal agent can spawn anonymous workers for a task with their own identity, brief and private transcript. Workers can execute or review work, and their results are handed back to the principal agent for orchestration.

### Improvements and fixes

* **Work panel:** the board scrolls within the page, and task details open in an overlay with the worker transcript and tool activity.
* **Overview:** waits for usage data before displaying the page, avoiding a layout shift. Codex subscription usage is shown as a weekly window; Claude retains its five-hour and weekly windows.
* **Branding:** browser, Safari and installed-app icons use the Jian mark.

### Upgrading

The gateway applies the new work and subagent database migrations on startup. No manual configuration is required.

## 0.1.0 — 2026-09-29

Welcome to Jian.
