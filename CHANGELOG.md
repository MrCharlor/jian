# Changelog

Every release of Jian, newest first.

<!-- Generated from docs/releases by scripts/changelog.mjs. Edit the release note, then run `make changelog`. -->

## 0.5.1-rc.2 — 2026-10-01

Keep theme reveals aligned on pages with vertical scrolling.

### Panel

* **Theme reveals on scrolling pages:** the circular theme transition now calculates its origin and radius from the viewport captured by the browser, keeping the reveal anchored to the clicked control on pages with vertical scroll.

### Upgrading

No database migration or configuration change is required. This is a prerelease and does not move the `latest` image tag.

## 0.5.1-rc.1 — 2026-10-01

Keep the theme reveal animation smooth in Chrome.

### Panel

* **Smooth theme transitions in Chrome:** the circular theme reveal now declares its View Transition animation before the browser captures the new page, preventing the animation from stopping early or revealing the page all at once.

### Upgrading

No database migration or configuration change is required. This is a prerelease and does not move the `latest` image tag.

## 0.5.0 — 2026-10-01

Profile SSH key management, richer task workers, themes, release notices, and clearer loading states.

### SSH keys

* **Manage keys in Jian:** create, view, copy, and delete a profile's Ed25519 SSH keys from the panel. Agents can manage their own keys through built-in tools and the `ssh-keys` skill. Private keys stay in the profile workspace and are never returned by the API; the agent shell cannot run `ssh-keygen`.
* **OpenSSH-compatible private keys:** newly generated keys use OpenSSH's native private-key format and are validated against `ssh-keygen`. Existing public keys remain unchanged.

### Task workers

* **Profile context:** task workers use their parent profile's memories, conversations, skills, MCP servers, and tools while keeping a temporary task identity. They report progress through their assigned task but cannot create tasks or spawn more workers.
* **Repository access:** workers continue to use separate Git worktrees. Missing or inaccessible repositories now produce a clearer error, and task repositories must be Git roots inside the profile workspace.

### Panel

* **Light and dark themes:** switch themes from the sidebar footer. Dark remains the default and the choice persists in the browser. Theme changes use a circular reveal, and Storybook pages support theme switching and navigation.
* **Release notices:** the sidebar reports newer stable releases when GitHub provides them. The button opens their notes; Jian does not update itself, so apply a new image tag using your deployment method. If GitHub is unavailable, the panel keeps its normal release-note history.
* **Conventional loading states:** page and data loading use standard spinners, with consistent 32px full-page and 20px compact sizes. Thinking orbs remain reserved for active session processing.

### Upgrading

No database migration or new configuration is required. Keep the profile workspace persistent so SSH keys and CLI authentication survive container recreation. Stable installations can use the `latest` image tag or pin `0.5.0`.

## 0.5.0-rc.2 — 2026-10-01

Fix generated SSH private keys and use conventional spinners for panel loading states.

### SSH keys

* **OpenSSH-compatible private keys:** newly generated Ed25519 keys are now stored in OpenSSH's native private-key format. Existing public keys remain unchanged, and the generated private/public pair is validated against `ssh-keygen`.

### Panel loading

* **Conventional spinners:** page and data loading states now use standard spinners instead of thinking orbs. Thinking orbs remain reserved for the session chat, run progress and tool-call timeline where the agent is actively processing.
* **Consistent sizing:** full-page loading uses a 32px spinner and compact activity loading uses 20px.

### Upgrading

No database migration or configuration change is required. Existing keys created before this release should be regenerated so OpenSSH can use their private files. This is a prerelease and does not move the `latest` image tag.

## 0.5.0-rc.1 — 2026-10-01

Profile SSH key management, fuller task-worker context, light theme, and notices for newer releases.

### SSH keys

* **Manage keys in Jian:** create, view, copy, and delete a profile's Ed25519 SSH keys from the panel. Agents can manage their own keys through built-in tools and the `ssh-keys` skill. Private keys stay in the profile workspace and are never returned by the API; the agent shell cannot run `ssh-keygen`.

### Task workers

* **Profile context:** task workers now use their parent profile's memories, conversations, skills, MCP servers, and tools while keeping their task brief and temporary identity. They can report progress through their assigned task but cannot create tasks or spawn more workers.
* **Repository access:** workers continue to use separate Git worktrees for code. A repository path that is missing or inaccessible now produces a clearer error; task repositories must be Git roots inside the profile workspace.

### Panel

* **Light and dark themes:** switch themes from the sidebar footer. Dark remains the default; the choice persists in the browser. Theme changes use a circular reveal, and Storybook pages support theme switching and navigation.
* **Release notices:** when GitHub reports newer releases, the sidebar shows how many versions are available. Stable installations ignore prereleases; prerelease installations include them. The button opens the notes for those newer versions. Jian does not update itself: apply a new image tag using your deployment method. If GitHub is unavailable, the panel keeps its normal release-note history without an update count.

### Upgrading

No database migration or new configuration is required. Keep the profile workspace persistent so its SSH keys and CLI authentication survive container recreation. This is a prerelease; it does not move the `latest` image tag.

## 0.4.4 — 2026-09-30

The panel follows gateway changes without repeated database polling, and focus rings no longer distract from the interface.

### Live panel updates

* **Event-driven updates:** the gateway wakes profile event streams with PostgreSQL notifications after committed changes, including live run progress. The stream no longer queries the database every second while it waits.
* **Less redundant refresh work:** conversation history and task details now refresh from the existing event stream instead of maintaining their own polling timers. QR pairing, external OAuth status and stream reconnection keep their targeted retries.
* **Durable delivery:** event cursors, replay after reconnect and the existing heartbeat remain unchanged.

### Focus and controls

* **Quiet focus states:** dialogs, cards, inputs, selects, the composer, grouped fields and the audio player no longer draw strong focus outlines or rings. Keyboard focus remains available without the distracting border treatment.

### Upgrading

No migration or configuration change is required.

## 0.4.3 — 2026-09-29

GPT-6.1 Sol and model-specific higher reasoning levels for OpenAI.

### Models and reasoning

* **GPT-6.1 Sol:** ChatGPT-connected accounts can select it when their Codex catalog offers it. The gateway now requests the current Codex model catalog instead of an older client-version view.
* **Extra High and Maximum:** The model and conversation selectors offer `xhigh` and `max` only when the model's capabilities include them. For ChatGPT accounts, supported efforts come from that account's Codex catalog; API-key accounts use the public model catalog.
* **No false Ultracode option:** The Codex catalog's `ultra` level describes automatic task delegation, which the gateway does not implement. It remains unavailable in Jian rather than appearing as a misleading reasoning-only setting.

### Work panel

* Opening a task no longer highlights its title or Close task button. Keyboard navigation remains available inside the dialog.

### Task workers

* Workers now receive their own workspace and repository paths in their task context. When a report mentions another worker's path, the tools explain that it is isolated and direct the worker to its own worktree or the committed branch instead. The isolation boundary is unchanged.

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
