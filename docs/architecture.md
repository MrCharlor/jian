# Gateway architecture

```text
Clients / channels -> API and contracts -> services -> PostgreSQL
                                                    -> queue -> runtime -> provider / MCP
```

`apps/gateway` holds the runnable product. `packages/contracts` defines the inputs, the public outputs, the permissions and the stable operation identifiers. `packages/sdk` depends only on the generated HTTP contract. Each product keeps its own tests and build; Biome, pnpm and the git hooks are shared at the root.

Every area is a folder under `apps/gateway/src` with a service, its routes, its port and its record types; a new area is a new folder with those four pieces. Dependency runs one way: `core/` — errors, clock, store, events — knows no area, the areas depend on `core/`, `app.ts` registers each area's routes and `main.ts` assembles the process. The map of persisted records lives in `src/records.ts`, next to `src/services.ts`, in the composition layer, because listing the areas is the job of whoever composes them; in `core/` it would make `core/` import back what depends on it. A consumer is handed the port it needs, never the whole service: `agent/tools.ts` declares `ProfileAdmin`, `MemoryWriter`, `SessionReader`, `RunReader`, `PeerAgents` and `RunExecution`, never the classes that satisfy them.

Profiles, revisions, sessions, messages, memories and runs are areas of the gateway; `Vault`, `Coordination`, `Peers` and `Channels` isolate encrypted storage, history/artifacts/leases, conversation between profiles, and outside transport. The vault has no routes of its own: every secret is addressed by the thing that uses it (`provider:<id>`, `mcp:<name>`, `channel:<id>`), so removing that thing removes the secret. The HTTP layer holds no provider rules and never touches a ciphertext. `http/security.ts` centralises authentication and public errors; `http/events.ts` owns the event connections. Inside `agent/`, MCP discovery and result handling stay apart from running the agent.

Channels implement `Channel` and are chosen through an adapter registry. The shared service owns access and durable delivery; each adapter translates only its own protocol. See [Channels](channels.md).

PostgreSQL stores typed records and durable events. Indexes cover profile/type/order, JSONB filters and text search over content and keys. History pages through a record cursor and a monotonic sequence, never OFFSET. Transactions are short and take a per-profile advisory lock; no model call ever happens inside one.

Versioned migrations run in a transaction under a global lock. The first version can adopt an existing installation; a schema newer than the binary stops it from starting. Legacy profiles and snapshots are given identity and budget defaults when read. Historic revisions keep the version they were written with.

The dispatcher hands persisted runs to pg-boss; a transactional claim keeps two workers from executing the same run. A lease and a heartbeat detect a worker that is gone. Checkpoints record when a tool starts and how a step ended. Large results are referenced as artifacts; small ones are persisted with a cap and with known secrets redacted.

Tools are loaded within a run rather than offered all at once. Every definition is re-sent on every model call, so a complete set is paid for by turns that use none of it — measured at 8.5 KB of prompt for a greeting. What stays always available is what a turn is likely to need before it can ask: memory, skills, the profile's own activity, and the other agents, so a conversation between profiles still costs one call. The rest — files, commands, other sessions, long-running work, contacts, self-management — is named in one loader and arrives when the agent asks for it. MCP tools follow the same rule, by server. A group loaded stays loaded for that run and for no other.

Every ceiling a run is given — how much prompt it may carry, how much history, how large a tool result may be — is a share of the window the chosen model really has. A fixed number written for a small model turns a large one into a small one, which is what made an ordinary conversation compact itself every few turns.

A run has a 500-step loop backstop, but no cumulative token cap. Each model call must fit that model's context window, with room reserved for its response. Provider-reported input, output and cache reads remain usage metrics; they do not determine how much conversation fits in a call.

The instructions are built once for a turn and held. Rebuilding them per step — the same memories, the same skills, a different list of what the profile happens to be doing — changed the one part of the request a provider can reuse, so every step paid for the whole prompt again. Anything that has to reach the agent mid-turn arrives as a message instead.

Anthropic requests use at most four cache boundaries: one after the stable instructions and up to three on messages. Retrieved memories, activities and the session summary follow the stable system boundary. Human conversations use the one-hour TTL; peer calls use five minutes. MCP discovery stays lazy, but selected tools remain available until a 32-tool working set evicts the oldest selection. Loading a new schema can still invalidate the cache; switching back to an already loaded tool does not change the schema list. Provider-reported cache reads are recorded per step. These are token counts, not billing amounts.

Compaction runs when the estimated request exceeds 85% of its input allowance. It summarizes the actual loop messages, including tool results, preserves the current user request and recent work, and keeps each tool call with its results. A replacement must reduce message tokens by at least 20%; automatic attempts are separated by four steps. Successful summaries are saved in the run checkpoints and session before the next request uses them. The session cursor advances only through messages covered by the summary; original messages remain in storage. Compaction has the same subscription identity as normal requests. Failures are recorded in checkpoints, without injecting repeated announcements into chat. If a prompt still cannot fit, the run fails explicitly rather than silently dropping history; complete tool results remain in checkpoints or artifacts.

Context is built once at the start of a run: profile instructions and identity, skill names and descriptions, relevant memories, activity summaries, the session summary and all messages after its cursor. This includes group messages the agent heard without answering. Sanitized tool inputs, results and uncertain outcomes from those turns are replayed from their checkpoints as historical data, never as calls to execute again; tool evidence already covered by the saved summary is not replayed. Skill bodies and additional tools load on demand. Steps append tool results and steering messages. Every prepared prompt records estimated system, tool and message costs plus active tool names; each completed step records reported usage and cached input. For unknown tokenizers, estimates are conservative byte counts, not provider usage.

The final report and compaction calls are recorded in usage but do not increment the tool-loop step count. If the closing model call fails, the run returns an explicit partial-work notice pointing to saved checkpoints. Conversation titles are derived locally from the opening message without a model request.

Large JSON MCP results are decoded before truncation and artifact storage. Artifact pages are sized against their serialized token estimate, including JSON escaping and the next-page cursor. Nothing is removed from the persisted full result.

Memories are explicit, versioned and shared across the profile; there is no weight training and no literal awareness. Sessions talk to each other through an inbox that can be read back; a message to a channel conversation — a person or an approved group on WhatsApp or Telegram — is delivered on that channel and recorded in that conversation instead, and the prompt lists those conversations so an agent reached on one channel knows the others. The agent chooses to look at history, checkpoints, artifacts and other activity through tools.

## Conversation between profiles

A turn that runs out of anything it is bounded by — tool calls or tokens — is not thrown away: one more bounded request, carrying the current compacted context and no tools at all, turns the work into an answer that says what was found and what is still unknown.

An agent waiting on a colleague waits for less than a minute. Past that the call is not lost and nobody is held: the answer is addressed to the conversation that asked and arrives there as an ordinary turn once it lands, so the agent that asked passes it on itself. A failure travels the same way.

The isolation between profiles has one declared door, and it carries data only: a profile discovers the others of the installation and speaks to one of them, but what crosses is text. Discovery returns an identifier, a name and the summary the owner wrote — never instructions, identity, skills, memories, credentials or history. Every other read stays bound to the calling profile; no tool and no route reads another profile's records.

The door can be closed per profile: **Talk with other agents**, in Identity, is on by default. Off, the profile leaves the list the others read and refuses their calls, and it loses them in turn — its list comes back empty, its calls are refused, and it is not offered the tools or the skill for either. The switch is read when a call is made, not from the frozen run, so turning it off also ends calls already under way.

A call becomes an ordinary run in the profile being called: its request key, its context, its lease, its checkpoints. It happens in the session that pair of agents shares — one per pair, on the callee's side, marked with `peerProfileId` and invisible to the caller — so colleagues keep continuity instead of starting over on every request. The caller waits for the run to finish and receives its output as text; a colleague that fails or stalls becomes an explicit error, never silence. Both profiles record the event (`agent.call.sent` and `agent.call.received`), which is how the owner audits who spoke to whom.

A conversation between agents ends, because every round costs money. The depth budget travels with the chain: the run a call creates keeps in `call` what has been spent and the ordered list of profiles the conversation passed through, and the callee inherits that spend instead of starting from zero. Going past the limit is a clear error. Only the agent addressed answers — the reply goes back to the caller and to nobody else — and a profile that already spoke in the chain is not called again, so nothing reopens what it closed and no cycle forms.

## Approvals

How far an agent goes on its own is the owner's setting, not the judge's. Every action that lands outside the conversation — a command or a file on the machine, a write to a connected service, a message to someone — has a level in the profile's **action policy**: `1` the agent only proposes and the owner acts, `2` the agent prepares and waits, `3` the agent acts and reports. The level is read for the exact action first (`run_command`, or `server.tool` for a connected server, a name that outlives the hashed one the model calls) and for the kind of action otherwise. A profile starts at `2` for everything.

At level 2 the call does not run. The gateway records an **approval**: a short number that counts up per profile, the tool, the exact input and a hash of it, and the run and session it came from. The tool answers the agent with that number, and the agent tells the owner and ends its turn. The owner answers in the panel, by API, or in a chat with `ok 3` or `não 3: motivo`; in a chat only a message from the owner counts — the gateway conversation, or a contact the owner marked as speaking for them — and the words never reach the model: the decision is recorded first, and what the agent reads is the decision and what to do with it. Approved, the agent calls the same tool with the same input, the hash matches, the approval is spent and the call runs once. A different input is a new request; an approval nobody spends expires with the request, after seven days.

The judge keeps its place behind the policy: a level-3 action still passes through it, and an action the policy holds is never sent to it. Every request and decision is an event (`approval.requested`, `approval.decided`, `approval.used`), which is how the owner sees, action by action, how often they corrected the agent before raising a level.

## Product limits

- No embeddings, semantic search or summarisation by a second model.
- No multiple organisations, and no per-participant ACL inside a profile.
- No public protocol between installations.
- No exactly-once replay guarantee for effects outside the gateway.
- No sandbox around the commands an agent runs, and no arbitrary MCP installer. Skill import is the owner's, from GitHub repositories only, and copies the text instead of following the source.
- No financial accounting in currency; token counts and limits are recorded. Input, output and the part of the input a provider served from its own cache are counted apart, because every provider prices them differently. A step that reports no usage is counted by the gateway itself and marks the whole run as estimated. None of these numbers is a bill.

Extensions must use the public contracts and preserve the authorization boundaries that exist today.
