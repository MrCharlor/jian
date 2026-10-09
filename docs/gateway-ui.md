# Gateway panel

`apps/gateway-ui` is a Next.js app with `output: 'export'`, React and TypeScript. The panel uses the SDK generated from the OpenAPI document; validation, authorization and domain rules stay in the gateway.

## Build and hosting

`pnpm build` and `pnpm --filter @jian/gateway build` compile the contracts, the SDK, the panel and the server. The export is copied into `apps/gateway/dist/ui` and shipped in the production package and in the Docker image. The runtime serves `/ui/` with Fastify; no Next.js is needed on the server.

`pnpm --filter @jian/gateway build:server` compiles only the server, for development. A run from source serves whatever export is in `dist/ui`. The script policy is derived from the file being served, so replacing the export under a running gateway is safe; use the Next.js dev server for hot reload.

The application exports static routes (`/ui/channels/`, for example). There are no server actions, no SSR and no provider code in the browser. Fonts, icons and the QR code are local, with no external rendering service.

## Storybook

`make storybook` opens every component and every screen on `:6006` without a gateway or a database. The pages render the real workspace layout: each request the panel makes is answered by [Mock Service Worker](https://mswjs.io) from `stories/handlers.ts`, with the synthetic installation in `stories/fixtures.ts` — three agents, their conversations, channels, a pending contact, a group, providers and a year of activity. The toolbar switches the accent, light or dark mode, and the text size.

- **Components** keep their stories beside them, as `*.stories.tsx`. A section takes the props the layout would hand it from `sectionProps()` in `stories/section.ts`.
- **Pages** are in `stories/pages`: every route inside the layout, plus a first run with nothing configured, the dialog after an update, and a phone-sized view.
- **Another state** is another handler list: `parameters: { msw: { handlers: [http.get(...), ...handlers] } }` puts one answer ahead of the defaults.

`make storybook-smoke` builds Storybook and opens each story in headless Chromium, failing on one that throws, logs an error, renders nothing or never gets past the session check. CI runs it on every change. The service worker lives in `.storybook/public`, so it never ships in the panel's export.

## Setting up a profile

1. Sign in with the host token, `JIAN_API_TOKEN`.
2. Create a profile with a name and instructions. Role, tone and goals belong in the instructions.
3. Under **Providers**, one row per vendor, configure a credential for Anthropic, Gemini or OpenAI. `ANTHROPIC_API_KEY`, `ANTHROPIC_API_TOKEN`, `GEMINI_API_TOKEN` and `OPENAI_API_KEY` in the environment are detected on their own. OpenAI also accepts a ChatGPT login by device code. The API key and ChatGPT login coexist; image generation and speech synthesis use the API key. A credential belongs to the installation: configure it once and every profile can use it.

   Anthropic issues two credentials that are not interchangeable, so its row asks which one you are pasting: an API key, sent as a key, or a subscription token from `claude setup-token`, sent as a bearer from a caller presenting itself as Claude Code. Either one sent as the other answers 401 on every run and on the model listing. Unstated, the choice is read from the credential's own prefix, and failing that from the variable it came in — `ANTHROPIC_API_TOKEN` holds the bearer one.
4. Under **Model defaults**, choose the model for each activity. One menu lists the models of every connected provider, each with its provider's name under it; picking a model picks its provider. The list comes from the provider account, never from a list written in this repository, and the panel marks the models whose capabilities the gateway cannot catalog. Reasoning effort appears where the model accepts one. With nothing chosen — or with a chosen model whose provider was removed — the first run picks a model and saves it as the default. When there is no model to pick at all, a message arriving on WhatsApp or Telegram is kept in its conversation and the chat is told, once every ten minutes, that no model is set up; it no longer waits in silence.

   Model defaults execute conversations, channels, context compaction, image analysis, image generation, incoming audio and text to speech. Each picker filters incompatible models. Compaction uses its selected model, falling back to the conversation model, and can run automatically or through `compact_context`. Empty media selections use Gemini (`gemini-flash-latest`, `gemini-2.5-flash-image`, `gemini-2.5-flash-preview-tts`). Image generation also supports OpenAI GPT Image and DALL-E with an API key. When a provider does not answer, its last model list stays visible with a warning.

5. Add skills, written on the screen or imported from a GitHub repository in the open `SKILL.md` format — the same one Claude Code, Codex and Copilot read. An import copies the instructions once and records where they came from; the repository changing later never rewrites what the agent already follows, and only the owner imports. Add MCP servers too: the tools come from the server, and the agent loads one before it can call it. A server is reached over HTTP or by running a command on this machine, and an HTTP one authenticates with headers you write — `Bearer`, `Basic`, anything it asks for — or by signing in to the server itself, which needs `JIAN_PUBLIC_URL` so the redirect can come back. The official Claude and Codex catalogs are on the Skills screen itself. An import copies the instructions only: scripts and supporting files are not installed.
6. Under **Channels**, connect WhatsApp, Telegram or the API server. Each type exists once and reads as connected or not, as under Providers. For a room with several agents, connect one channel per profile — a number or a bot for each — and approve the room in every profile that should speak in it.
7. Under **Sessions**, read the history by channel and search by title or identifier. At the top of a conversation, **Model** and **Effort** choose the model for that conversation alone, from its next turn; **Profile default** returns it to Model defaults. Only the gateway conversation is written to from the panel; the others are written to through their channels. The worker must be running for incoming messages to be processed.

The ChatGPT login talks to the Codex backend with the same context cycle, tools and usage recording as the rest of Jian, and its own model catalog is read from that account. OAuth tokens are encrypted in the vault and refreshed by the gateway. Do not paste a login token into the API key field. Older profiles carrying `model` and `contextPolicy` stay readable and usable.

Connecting WhatsApp means scanning the QR code: the panel opens the pairing immediately and follows the connection and the first encrypted copy of the session. The QR expires and is never written to the browser. Connecting Telegram means giving the BotFather token, which the gateway keeps encrypted; the panel shows the webhook URL and secret once, and `setWebhook` remains a step you take outside. Connecting the API server produces the same URL and token. Nothing else is asked — no name, no session, no list of senders.

Whoever writes for the first time appears under **Contact requests**, with their name, their identifier and the message that was held. Approving opens the conversation and releases that message; refusing blocks the sender silently. The request arrives on its own: the panel follows the profile's event stream and refreshes when a contact or a channel changes, with no page reload. See [channels](channels.md) for the guarantees on the gateway side.

A room appears in the same list, marked as one, and approval covers the whole room: there is no request per participant, and nothing is held waiting for a decision. Once approved it appears under **Rooms**, with its name, its channel and which of your profiles are in it — each profile joins through its own connection, so each is approved separately, and the panel shows the ones still pending as not participating. Inside a room with more than one agent, each answers only when a message carries its name, and the conversation between agents stops at the turn limit until a person writes again.

Secrets have no screen of their own: a provider key is typed under **Providers**, an MCP server token next to its server, and a bot token next to its channel. The vault keeps encrypting them without showing anything in the panel, and no value is ever displayed again — to change one, send another; to remove one, remove the thing that uses it.

**Approvals** lists what the agent prepared at level 2 and waits on, each with the exact call and a reason field, and below it what was already decided. Levels are set under **Identity › Autonomy**, by kind of action and for exact actions. In a chat the owner answers `ok 3` or `não 3: motivo`; a contact answers for the owner only once marked **Owner** under Channels.

**Memories** is read-only: the screen lists what the agent kept, searches by key and by content, and deletes an entry. The agent is the one who writes, through its own tools.

The activity calendar counts a day as it ends where the reader is: the browser's own zone travels with the request, because a calendar drawn in UTC puts an evening in Brazil on tomorrow's square.

## Security and limits

- The sign-in page and the assets are public. Every API route needs the host token, or the panel cookie signed with it; there is no reduced-permission client key.
- The sign-in form only enables submission after hydration and falls back to POST, so the token never travels in a URL. The host token is exchanged once for a session cookie and is kept in neither localStorage nor sessionStorage. Visual preferences — accent colour, light or dark mode, motion and text size — live in localStorage. The mode defaults to the device's own setting. Every colour is declared once with `light-dark()` in `app/styles/themes.css`, so an accent is one entry with a light and a dark value, not a second theme.
- The panel cookie is `HttpOnly`, `SameSite=Strict`, valid for 30 days, and `Secure` when the request arrives over HTTPS. It carries only its own expiry and an HMAC signature derived from `JIAN_API_TOKEN`: nothing is stored in the database, and changing the host token ends every open session. Reloading keeps the session; signing out deletes the cookie.
- The gateway accepts the cookie only on requests that also send `x-jian-panel: 1`. A custom header needs a CORS preflight, which the gateway does not answer, so another site cannot use the cookie. Sign-in has its own limit of 10 attempts a minute.
- Requests go to the same origin, with no cache and with a timeout. The panel carries no credentials in its build.
- The content security policy allows scripts from the gateway itself and the exact hashes of the export's hydration scripts, read from the page being served. Framing, plugins and changing the base URL are blocked.
- Input is rendered as text; history and instructions never execute HTML.
- A profile change carries `expectedVersion`. The panel does not create sessions and does not send messages.
- Listings follow the API's current limits: up to 100 sessions, recent messages, memories and deliveries, up to 200 contacts, and up to 500 room contacts across the whole installation. The panel does not replace the paginated history API.
- The event stream uses the same session cookie and the same header as every other call, read through `fetch` because `EventSource` cannot send headers. The gateway rechecks the session on every cycle and ends the stream when it expires; the panel reopens from the last event it saw.

Infrastructure stays in the server configuration: PostgreSQL, the encryption keyring, the host token, the API/worker role, HTTPS and the network rules. The panel does not turn this single-owner installation into a multi-tenant SaaS.

Looking at the screen, and local HTTP tests, prove neither PostgreSQL persistence nor delivery through an external service nor a real WhatsApp pairing.

Incoming audio uses one selection for WhatsApp voice notes and attached audio files. It preserves speech verbatim and adds relevant sound context when the model supports it. The deprecated API `transcription` field is a compatibility alias for `audio`; existing selections are preserved, with `audio` taking precedence.
