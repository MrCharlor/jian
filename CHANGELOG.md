# Changelog

Every release of Jian, newest first.

<!-- Generated from docs/releases by scripts/changelog.mjs. Edit a note there and run
     `make changelog`; editing this file is editing the copy rather than the thing. -->

## 2.3.0 — 2026-09-27

Each agent works in its own workspace, confined by Landlock and without the gateway's secrets, and the panel's viewer previews PDFs, HTML, Markdown, code and video.

### Features

* **shell:** each profile works in its own workspace, `/home/node/workspaces/<profile id>`, its `HOME` and `TMPDIR` and where it installs, keeps SSH keys and logs in to Git and `gh`; `JIAN_WORKSPACES` moves the parent ([8c832d4](https://github.com/lucasaarch/jian/commit/8c832d4bce3310571166524a8b4054528d36dfef))
* **shell:** commands run under `jian-sandbox`, which confines them with Landlock: full access in the workspace, read and execute in the system directories, nothing else, so a profile cannot read another's workspace, the gateway's files or the gateway's process; it needs no privilege and works with `no-new-privileges`, and on Linux 6.12 or later it also scopes signals and abstract sockets ([8c832d4](https://github.com/lucasaarch/jian/commit/8c832d4bce3310571166524a8b4054528d36dfef))
* **files:** the file tools, `send_file` and `save_attachment` keep to the same line: they write only in the workspace and read in it or in the system directories, with links resolved ([8c832d4](https://github.com/lucasaarch/jian/commit/8c832d4bce3310571166524a8b4054528d36dfef))
* **panel:** the viewer previews HTML in a sandboxed frame, lays out Markdown, colours code and plays video; it says when an HTML page is shown without the scripts or styles it loads from other sites ([be6262f](https://github.com/lucasaarch/jian/commit/be6262f1b083da2b9f2a79b82197ef5f2fd26406)) ([ffcc9d8](https://github.com/lucasaarch/jian/commit/ffcc9d8ff6cb0cea090676056d461383aeefd814))

### Bug Fixes

* **shell:** a command started with the gateway's whole environment, `DATABASE_URL`, `JIAN_MASTER_KEYS`, `JIAN_API_TOKEN` and provider keys included, so a project's database test could run against the gateway's own PostgreSQL; it now starts from an allow-list, and `NODE_ENV` stays out so a project's install keeps its dev dependencies ([7a82342](https://github.com/lucasaarch/jian/commit/7a823422bc87bfb701a82e438263932e14dba1ff))
* **panel:** a PDF opened in the viewer showed a blank page, refused by the panel's policy; it now shows ([ac6608c](https://github.com/lucasaarch/jian/commit/ac6608c4c96a43f51059f0302b98a0c7d1627a73))

### Upgrading

No migration runs. Commands no longer see the rest of `/home/node`: repositories, SSH keys and Git and `gh` logins kept there before this version are out of an agent's reach until they are moved, once, into its workspace under `/home/node/workspaces/<profile id>`. On a kernel without Landlock, commands run unconfined and the gateway logs a warning once; the environment allow-list still applies.

## 2.2.2 — 2026-09-26

Agents on OpenAI and Codex models answer again with stickers on, and send the files they make.

### Bug Fixes

* **stickers:** with stickers on, an OpenAI or Codex model refused every turn with a 400, since the sticker tools described a tag with a Unicode pattern it does not accept; the tools now take the tag as plain text and the gateway still checks it ([82020a9](https://github.com/lucasaarch/jian/commit/82020a92769d7e91c700f848f88269b037687569))
* **media:** a model that fills every field of `send_file`, with placeholders in the ones it does not mean, had every call refused and never sent the file; `send_file` takes an optional `source` naming the field that holds the file, and its error points at it ([a55fb3c](https://github.com/lucasaarch/jian/commit/a55fb3c7f4cd3f0b7c3205df52b750927b47c2f2))

## 2.2.1 — 2026-09-25

Release notes you can open at any time, a panel sidebar that puts the installation's settings first, and dialogs whose actions stay in reach.

### Features

* **releases:** **Release notes**, at the bottom of the sidebar, opens every release up to the one running, newest first; a stable version leaves out the candidates before it ([38a6c52](https://github.com/lucasaarch/jian/commit/38a6c529de84b47bd14fe5feb4e6bfa2fb477a27))
* **panel:** a **Gateway** group opens the sidebar with Providers and Settings, what belongs to the whole installation; Sessions sits under Identity ([38a6c52](https://github.com/lucasaarch/jian/commit/38a6c529de84b47bd14fe5feb4e6bfa2fb477a27))
* **panel:** a link to the repository on GitHub, with its stars, read by the gateway once an hour ([38a6c52](https://github.com/lucasaarch/jian/commit/38a6c529de84b47bd14fe5feb4e6bfa2fb477a27))

### Bug Fixes

* **panel:** a dialog's actions stay fixed below its content instead of scrolling with it, and the page behind an open dialog no longer scrolls ([38a6c52](https://github.com/lucasaarch/jian/commit/38a6c529de84b47bd14fe5feb4e6bfa2fb477a27))
* **models:** the model menus no longer mark models as "capabilities unknown"; Model defaults still says so once one is chosen ([38a6c52](https://github.com/lucasaarch/jian/commit/38a6c529de84b47bd14fe5feb4e6bfa2fb477a27))
* **schedules:** a schedule's thirty days of history were counted from the database's clock; they are now counted from the gateway's, as the times they were due are ([70662a5](https://github.com/lucasaarch/jian/commit/70662a5628876c9e2fe85f6ad1206135fbfc0bcf))

## 2.2.0 — 2026-09-25

Schedules, files and stickers on every channel, an agent that learns from its work and knows what it can do, a model per conversation, and a panel rebuilt around conversations.

Everything from 2.2.0-rc.1 to rc.8, and what came after them. Upgrading from 2.1.0, read **Upgrading** at the end.

### Features

* **schedules:** reminders, daily summaries and recurring checks, once or on a repetition, in any conversation and delivered on its channel, with 30 days of history; the agent can pause one without deleting it
* **files:** send the agent any file on WhatsApp, Telegram or the panel, and get files back: it reads PDFs, Word, Excel, PowerPoint and text files, and sends documents it writes
* **media:** a sticker, a file, an image or a voice note asked for in one conversation can be sent into another of the agent's own
* **stickers:** the agent keeps the stickers people send, described and tagged by what they show, and sends them back as stickers; switch them off per profile, and pick the model that describes them under **Model defaults › Sticker analysis**
* **sessions:** one gateway conversation per profile, the one you write in from the panel, and every conversation read as a messenger, live as the agent works
* **sessions:** **Model** and **Effort** at the top of a conversation choose the model for that conversation alone ([8fb53d6](https://github.com/lucasaarch/jian/commit/8fb53d620e79c216fb84c35ed00cc9532ced5441))
* **models:** Model defaults is one menu listing the models of every connected provider, each with its provider's name; there is no provider to pick first ([8fb53d6](https://github.com/lucasaarch/jian/commit/8fb53d620e79c216fb84c35ed00cc9532ced5441))
* **agents:** **Talk with other agents**, in Identity, on by default; off, the profile leaves the others' list and loses contact with them ([8fb53d6](https://github.com/lucasaarch/jian/commit/8fb53d620e79c216fb84c35ed00cc9532ced5441))
* **learning:** after a long turn, one that recovered from a failed tool, or every fifteen turns, the agent keeps what helps as a skill or a memory, under Sessions › Learning
* **agent:** a turn has no time limit; it stops when a model call or a tool gives no sign of life for five minutes, on Cancel, or at its step and token budgets
* **agent:** each turn says how full its context is; it knows the current date and time; it reads replies, reactions and stickers; and it can write, rewrite and remove its own skills
* **agent:** the tool groups and the about-jian skill say what the agent can do, so it no longer asks for features it already has ([8fb53d6](https://github.com/lucasaarch/jian/commit/8fb53d620e79c216fb84c35ed00cc9532ced5441))
* **memories:** link memories so they are recalled together, and edit one from the panel
* **skills:** every built-in skill rewritten, with new ones for coding, web research, schedules, files, MCP servers, conversations, context and errors
* **mcp:** no limit on servers, connected in parallel; import servers from another agent; switch off a tool and the agent never sees it
* **providers:** Groq and any OpenAI-compatible server, such as a Whisper you run, for incoming audio
* **overview:** tokens, estimated cost, active days and cache share over 7, 30 or 90 days or all time, by model, channel and tool
* **channels:** Telegram bots and WhatsApp numbers show the profile's picture; each group message keeps who wrote it
* **panel:** dark mode and accent colours, Markdown answers, live updates without a reload, and this dialog once after each update

### Bug Fixes

* **models:** a message arriving with no model set up waited in silence and held up every message behind it; the chat is now told why nothing answers, once every ten minutes, and the message stays in the conversation ([8fb53d6](https://github.com/lucasaarch/jian/commit/8fb53d620e79c216fb84c35ed00cc9532ced5441))
* **models:** a default model whose provider was removed kept the automatic choice from stepping in; it now picks another ([8fb53d6](https://github.com/lucasaarch/jian/commit/8fb53d620e79c216fb84c35ed00cc9532ced5441))
* **whatsapp:** an `@Name` the agent writes in a group is a mention that notifies that person, now also in groups that address people by LID ([6256739](https://github.com/lucasaarch/jian/commit/625673982eae4f419a0d0b1d5347ae225378b901))
* **agent:** when a turn fails, the chat receives the real reason in a line, with credentials masked
* **outbound:** file uploads are sent as uploads again, so Groq, OpenAI and Telegram accept voice notes, photos and documents
* **channels:** documents on WhatsApp, and photos, voice notes and files on Telegram, reach the agent
* **telegram:** a bot token Telegram refuses is not connected, and the webhook is registered at `JIAN_PUBLIC_URL` when it is set
* **stickers:** a sticker the cataloguing model declines is left out, and one the owner removes does not come back
* **panel:** every screen and every date in English

### Upgrading

Seventeen migrations run on start. Schedules use the machine's time zone until one is set under **Settings › Gateway**. The discernment nudge starts switched off, and learning and stickers start on; each is a switch per profile. For Telegram to send reactions, disconnect and connect the bot once; in a group the bot must also be an admin. A Whisper server on a private address must be allowed in `JIAN_ALLOW_PRIVATE_ORIGINS`.

## 2.2.0-rc.8 — 2026-09-25

The agent mentions people in WhatsApp groups, and sticker tags are no longer edited by hand.

### Features

* **panel:** Stickers shows each sticker's tags without an editor; the agent keeps them, and a click on one still filters by it ([e945906](https://github.com/lucasaarch/jian/commit/e9459064262d4ca7a5556f5738c64a67c4ad9fc6))

### Bug Fixes

* **whatsapp:** an `@Name` the agent writes in a group became plain text; it is now a mention that notifies that person, when they have written in the group under that name ([3157d0f](https://github.com/lucasaarch/jian/commit/3157d0f8e9e202983202baf2978752d1b5371f72))

## 2.2.0-rc.7 — 2026-09-25

Stickers, files, images and voice sent into any conversation, stickers that should not be sent left out, and stickers you can switch off.

### Features

* **media:** a sticker, a file, an image or a voice note asked for in one conversation can be sent into another of the agent's own, as itself, on that conversation's channel ([c2df3f8](https://github.com/lucasaarch/jian/commit/c2df3f805a379952a3877b8d1e38afd2ea36db38))
* **stickers:** switch stickers off per profile under Stickers; off, nothing is kept or described and the agent has no sticker tools ([c2df3f8](https://github.com/lucasaarch/jian/commit/c2df3f805a379952a3877b8d1e38afd2ea36db38)) ([5145163](https://github.com/lucasaarch/jian/commit/51451630e58e4d7764018aacf0ea71bf7c79b3b3))
* **stickers:** Model defaults › Sticker analysis picks the model that describes and tags them, the image-analysis model when unset ([c2df3f8](https://github.com/lucasaarch/jian/commit/c2df3f805a379952a3877b8d1e38afd2ea36db38)) ([5145163](https://github.com/lucasaarch/jian/commit/51451630e58e4d7764018aacf0ea71bf7c79b3b3))

### Bug Fixes

* **stickers:** asked for a sticker in another conversation, the agent sent its id as text; it now sends the sticker ([c2df3f8](https://github.com/lucasaarch/jian/commit/c2df3f805a379952a3877b8d1e38afd2ea36db38))
* **stickers:** a sticker the cataloguing model declines — sexual content, gore, hate symbols, a private document — is left out, and one the owner removes does not come back when it is sent again ([c2df3f8](https://github.com/lucasaarch/jian/commit/c2df3f805a379952a3877b8d1e38afd2ea36db38)) ([5145163](https://github.com/lucasaarch/jian/commit/51451630e58e4d7764018aacf0ea71bf7c79b3b3))
* **panel:** a dialog that is only a question and its answers no longer shows an empty band above them ([5145163](https://github.com/lucasaarch/jian/commit/51451630e58e4d7764018aacf0ea71bf7c79b3b3))

### Upgrading

One migration runs on start. A sticker kept before this version with a refusal as its description stays until it is removed once under **Stickers**.

## 2.2.0-rc.6 — 2026-09-24

Stickers the agent collects and sends, MCP servers shared between agents without limits, and an Overview that shows where the tokens go.

### Features

* **stickers:** the agent keeps every sticker people send in approved chats, described and tagged by what it shows and counted each time it is sent, and sends them back as stickers on WhatsApp and Telegram; a built-in skill teaches when one fits, and the owner edits tags or removes them under Stickers ([5ca8d48](https://github.com/lucasaarch/jian/commit/5ca8d484d4cebf3c208854a76ed475e7af8ae6fd)) ([29debca](https://github.com/lucasaarch/jian/commit/29debca44bbc6f5399419ed0e352df291291044c)) ([ca78ec9](https://github.com/lucasaarch/jian/commit/ca78ec97c1d522b868b8ccc67473ea06ceb51faa)) ([8175225](https://github.com/lucasaarch/jian/commit/8175225a332660662c1a244bf25e4edb0fee617c))
* **mcp:** import servers from another agent, credentials included; each copy is the importing agent's own, and a server that signs in with OAuth asks for its own sign-in ([ca78ec9](https://github.com/lucasaarch/jian/commit/ca78ec97c1d522b868b8ccc67473ea06ceb51faa)) ([8175225](https://github.com/lucasaarch/jian/commit/8175225a332660662c1a244bf25e4edb0fee617c))
* **mcp:** no limit on how many servers an agent has; they connect in parallel at the start of a turn, each with 20 seconds, so a slow one no longer holds the others ([ca78ec9](https://github.com/lucasaarch/jian/commit/ca78ec97c1d522b868b8ccc67473ea06ceb51faa)) ([8175225](https://github.com/lucasaarch/jian/commit/8175225a332660662c1a244bf25e4edb0fee617c))
* **overview:** turns, time worked, conversations and what the agent kept; tokens, estimated cost from list prices, active days and cache share over 7, 30 or 90 days or all time; daily intensity, token mix, and breakdowns by model, channel and tool ([ca78ec9](https://github.com/lucasaarch/jian/commit/ca78ec97c1d522b868b8ccc67473ea06ceb51faa)) ([8175225](https://github.com/lucasaarch/jian/commit/8175225a332660662c1a244bf25e4edb0fee617c))

### Bug Fixes

* **telegram:** a bot token Telegram refuses is no longer connected as if it worked, and the webhook is registered at `JIAN_PUBLIC_URL` when it is set, with Telegram's reason shown when it refuses ([5ca8d48](https://github.com/lucasaarch/jian/commit/5ca8d484d4cebf3c208854a76ed475e7af8ae6fd)) ([29debca](https://github.com/lucasaarch/jian/commit/29debca44bbc6f5399419ed0e352df291291044c))
* **panel:** counters show their value at once and count only when it changes; the yearly activity no longer scrolls sideways; the separators between a row's facts are visible again ([8175225](https://github.com/lucasaarch/jian/commit/8175225a332660662c1a244bf25e4edb0fee617c))

### Upgrading

One migration runs on start. To have Telegram's webhook registered at a public address rather than the one the panel was opened on, set `JIAN_PUBLIC_URL`.

## 2.2.0-rc.5 — 2026-09-24

File uploads that reach the provider, errors that say what went wrong, and an agent that knows what to do with them.

### Features

* **agent:** a new built-in skill, handling-errors, teaches the agent to read an error and its HTTP status, say what failed and why, and point to where it is fixed ([b73ecca](https://github.com/lucasaarch/jian/commit/b73ecca2a1fc10ff471e1a4c018bc06d1ff83769))
* **media:** when a provider refuses, its own reason comes with the status, one line, with credentials masked ([b73ecca](https://github.com/lucasaarch/jian/commit/b73ecca2a1fc10ff471e1a4c018bc06d1ff83769))

### Bug Fixes

* **outbound:** file uploads were sent without their multipart type, so Groq and OpenAI refused voice notes to transcribe and Telegram refused photos, voice replies and documents; they are sent as uploads again ([b73ecca](https://github.com/lucasaarch/jian/commit/b73ecca2a1fc10ff471e1a4c018bc06d1ff83769))
* **logs:** every failed tool and unreadable attachment is written to the gateway log, not only a failed turn ([b73ecca](https://github.com/lucasaarch/jian/commit/b73ecca2a1fc10ff471e1a4c018bc06d1ff83769))
* **panel:** Incoming audio, Text to speech and Image generation no longer warn about unknown capabilities or offer an effort, since neither applies to them ([0d5c176](https://github.com/lucasaarch/jian/commit/0d5c1766cc059fc14def504c71f009ae72e6d066))

## 2.2.0-rc.4 — 2026-09-24

Voice notes transcribed for free with Groq or a Whisper server you run, busy providers asked again, and a failed turn that says why.

### Features

* **providers:** Groq and any OpenAI-compatible server — a Whisper you run beside the gateway, for one — can be connected under Providers and chosen for incoming audio ([2b2ddc8](https://github.com/lucasaarch/jian/commit/2b2ddc8ccac6ba54e2835534d45344c1f2a7a2e3)) ([9ffc385](https://github.com/lucasaarch/jian/commit/9ffc3859e09a134b549f194171597bb6e204b21f))
* **agent:** when a turn fails, the chat receives the real reason in a line, with credentials masked, instead of a pointer to the gateway log ([2b2ddc8](https://github.com/lucasaarch/jian/commit/2b2ddc8ccac6ba54e2835534d45344c1f2a7a2e3))

### Bug Fixes

* **media:** a provider that answers 5xx, as Gemini does when a model is overloaded, is asked twice more before a voice note is reported as unreadable ([2b2ddc8](https://github.com/lucasaarch/jian/commit/2b2ddc8ccac6ba54e2835534d45344c1f2a7a2e3))

### Upgrading

One migration runs on start. A Whisper server on a private address must be allowed in `JIAN_ALLOW_PRIVATE_ORIGINS`, for example `http://whisper:8000`; see docs/channels.md.

## 2.2.0-rc.3 — 2026-09-24

An agent that learns from its own work, turns without a time limit, and an agent that knows how full its context is.

### Features

* **learning:** after a long turn, one that recovered from a failed tool, or every fifteen turns, the agent looks back and keeps what helps as a skill or a memory; what it kept, and why, is under Sessions › Learning, and **Learn from its work** in Identity turns it off ([87c7910](https://github.com/lucasaarch/jian/commit/87c7910a8dc5f376cf588e2e261a09c83b515998)) ([8527b01](https://github.com/lucasaarch/jian/commit/8527b01b7cc3d079d47b7954e112b63f202c2c68))
* **agent:** a turn has no time limit; it stops only when a model call or a tool gives no sign of life for five minutes, or on Cancel, or at its step and token budgets ([87c7910](https://github.com/lucasaarch/jian/commit/87c7910a8dc5f376cf588e2e261a09c83b515998))
* **agent:** each turn says how full its context is, and a new built-in skill, managing-context, teaches when to compact and what to keep first ([87c7910](https://github.com/lucasaarch/jian/commit/87c7910a8dc5f376cf588e2e261a09c83b515998))

### Bug Fixes

* **groups:** a group conversation stays a group after its contact is gone, as after reconnecting a channel, and shows each person with their name and picture ([87c7910](https://github.com/lucasaarch/jian/commit/87c7910a8dc5f376cf588e2e261a09c83b515998)) ([8527b01](https://github.com/lucasaarch/jian/commit/8527b01b7cc3d079d47b7954e112b63f202c2c68))
* **groups:** a reply names whose message it quotes; a file posted to others shows as an attachment instead of a note ([87c7910](https://github.com/lucasaarch/jian/commit/87c7910a8dc5f376cf588e2e261a09c83b515998)) ([8527b01](https://github.com/lucasaarch/jian/commit/8527b01b7cc3d079d47b7954e112b63f202c2c68))
* **sessions:** conversation titles are in English; "Grupo" and "Agente" are gone from the ones already stored ([87c7910](https://github.com/lucasaarch/jian/commit/87c7910a8dc5f376cf588e2e261a09c83b515998))

### Upgrading

Two migrations run on start. Learning is on for every profile; switch it off per profile under **Identity**.

## 2.2.0-rc.2 — 2026-09-24

Replies, reactions and stickers understood, profile pictures synced to channels, skills an agent writes itself, and a panel that updates live.

### Features

* **channels:** the agent reads the message a reply answers, on WhatsApp and Telegram, and knows when it was its own ([8581057](https://github.com/lucasaarch/jian/commit/8581057419c1d02eacb3fa4f6a1a40e7f3b77e83))
* **channels:** reactions are kept in the conversation without starting a reply; stickers are read as stickers ([8581057](https://github.com/lucasaarch/jian/commit/8581057419c1d02eacb3fa4f6a1a40e7f3b77e83))
* **channels:** a Telegram bot and a paired WhatsApp number show the profile's picture, and follow every change to it ([8581057](https://github.com/lucasaarch/jian/commit/8581057419c1d02eacb3fa4f6a1a40e7f3b77e83))
* **skills:** every agent can write, rewrite and remove its own skills, and only those; a new built-in skill teaches when a routine should be a skill rather than a memory ([8581057](https://github.com/lucasaarch/jian/commit/8581057419c1d02eacb3fa4f6a1a40e7f3b77e83)) ([4085d2e](https://github.com/lucasaarch/jian/commit/4085d2e4a913a986ec4ae0abcbc6e4f6343f7c49))
* **agents:** in a conversation with another agent, the one that works sits on the left, with its tools and its progress live ([8581057](https://github.com/lucasaarch/jian/commit/8581057419c1d02eacb3fa4f6a1a40e7f3b77e83)) ([4085d2e](https://github.com/lucasaarch/jian/commit/4085d2e4a913a986ec4ae0abcbc6e4f6343f7c49))
* **panel:** Overview, Identity, Skills and Memories follow what the agent changes without a reload; Overview counts its numbers up ([4085d2e](https://github.com/lucasaarch/jian/commit/4085d2e4a913a986ec4ae0abcbc6e4f6343f7c49))
* **panel:** the agent's answers render as Markdown, tables included; replies show the quoted message and reactions show as a mark ([4085d2e](https://github.com/lucasaarch/jian/commit/4085d2e4a913a986ec4ae0abcbc6e4f6343f7c49))
* **panel:** dialogs keep their header and footer in place and scroll only their content; the sidebar keeps Settings and Sign out in reach ([4085d2e](https://github.com/lucasaarch/jian/commit/4085d2e4a913a986ec4ae0abcbc6e4f6343f7c49))

### Bug Fixes

* **groups:** a sticker sent as a reply to the agent reaches it, instead of being taken for chatter ([8581057](https://github.com/lucasaarch/jian/commit/8581057419c1d02eacb3fa4f6a1a40e7f3b77e83))
* **agent:** what it says before a tool and after it no longer runs together into one message ([8581057](https://github.com/lucasaarch/jian/commit/8581057419c1d02eacb3fa4f6a1a40e7f3b77e83))
* **agent:** the gateway conversation appears in the agent's own list of conversations ([8581057](https://github.com/lucasaarch/jian/commit/8581057419c1d02eacb3fa4f6a1a40e7f3b77e83))
* **panel:** while the agent writes, the text replaces the thinking orb instead of piling under it ([8581057](https://github.com/lucasaarch/jian/commit/8581057419c1d02eacb3fa4f6a1a40e7f3b77e83)) ([4085d2e](https://github.com/lucasaarch/jian/commit/4085d2e4a913a986ec4ae0abcbc6e4f6343f7c49))
* **panel:** the tool list opens at an even pace however many tools there are; release note links are coloured as links; the loading screen sits in the middle ([4085d2e](https://github.com/lucasaarch/jian/commit/4085d2e4a913a986ec4ae0abcbc6e4f6343f7c49))

### Upgrading

Two migrations run on start. For Telegram to send reactions, disconnect and connect the bot once, so its webhook asks for them; in a group, the bot must also be an admin.

## 2.2.0-rc.1 — 2026-09-24

Schedules, files in and out on every channel, a gateway conversation you write in, linked memories, and a panel rebuilt around conversations.

### Features

* **schedules:** ask for a reminder or a daily summary — once or on a repetition, in any conversation, delivered on its channel, with 30 days of history ([de4febc](https://github.com/lucasaarch/jian/commit/de4febcdfff6dfd4022bd4d0ef4ed7ae727e8a45)) ([d58a3cf](https://github.com/lucasaarch/jian/commit/d58a3cf6d0b7ab8c27167f5d6ad42f76bf488b4b))
* **files:** send the agent any file on WhatsApp, Telegram or the panel, and get files back: it reads PDFs, Word, Excel, PowerPoint and text files, and sends documents it writes or makes ([bf2df09](https://github.com/lucasaarch/jian/commit/bf2df09d391ae2cbf430720e6abb704654a41c68))
* **sessions:** one gateway conversation per profile, the one you write in from the panel, with images, files, voice notes and pasted text ([de4febc](https://github.com/lucasaarch/jian/commit/de4febcdfff6dfd4022bd4d0ef4ed7ae727e8a45)) ([d58a3cf](https://github.com/lucasaarch/jian/commit/d58a3cf6d0b7ab8c27167f5d6ad42f76bf488b4b))
* **sessions:** read every conversation as a messenger: the agent on the left with the tools it used, updating live as it works ([d58a3cf](https://github.com/lucasaarch/jian/commit/d58a3cf6d0b7ab8c27167f5d6ad42f76bf488b4b)) ([b9f2bb3](https://github.com/lucasaarch/jian/commit/b9f2bb3cc192c8c9b03920d5d2e387308674bcfc))
* **groups:** each group message keeps who wrote it, with their name and picture ([de4febc](https://github.com/lucasaarch/jian/commit/de4febcdfff6dfd4022bd4d0ef4ed7ae727e8a45))
* **memories:** link memories that belong together so they are recalled together; edit a memory from the panel; the agent can search, delete and link its own ([de4febc](https://github.com/lucasaarch/jian/commit/de4febcdfff6dfd4022bd4d0ef4ed7ae727e8a45)) ([d58a3cf](https://github.com/lucasaarch/jian/commit/d58a3cf6d0b7ab8c27167f5d6ad42f76bf488b4b))
* **agent:** read PDFs and text files, and know the current date and time ([de4febc](https://github.com/lucasaarch/jian/commit/de4febcdfff6dfd4022bd4d0ef4ed7ae727e8a45))
* **skills:** every built-in skill rewritten, with new ones for coding, web research, schedules, files, MCP servers and conversations; the discernment nudge is now off until you switch it on ([aa5da63](https://github.com/lucasaarch/jian/commit/aa5da6356c3dd73c2c0f869667e58d4e50a8c5c1))
* **mcp:** switch off a server's tool, and the agent never sees it ([de4febc](https://github.com/lucasaarch/jian/commit/de4febcdfff6dfd4022bd4d0ef4ed7ae727e8a45)) ([d58a3cf](https://github.com/lucasaarch/jian/commit/d58a3cf6d0b7ab8c27167f5d6ad42f76bf488b4b))
* **settings:** the gateway's time zone, under Settings › Gateway ([de4febc](https://github.com/lucasaarch/jian/commit/de4febcdfff6dfd4022bd4d0ef4ed7ae727e8a45))
* **panel:** Providers, Skills and MCP as rows with each service's own logo; a switch and a preview for built-in skills ([d58a3cf](https://github.com/lucasaarch/jian/commit/d58a3cf6d0b7ab8c27167f5d6ad42f76bf488b4b))
* **panel:** dark mode and accent colours; channels with their groups and contacts inside; contact pictures ([4552e47](https://github.com/lucasaarch/jian/commit/4552e470365eabcd0b1bcb56e3730ce7a3505174)) ([92b7a3b](https://github.com/lucasaarch/jian/commit/92b7a3b1c8f9db28ebc9c3e39a9bcb08042246a7)) ([ad2ad50](https://github.com/lucasaarch/jian/commit/ad2ad504f2d82b38a1b33c6c0703666356fe8a1b))
* **profiles:** reset or delete a profile, confirmed by typing its name ([2d18fe0](https://github.com/lucasaarch/jian/commit/2d18fe0fffd47ad96448d4fedffd33610f3368ca)) ([c6fdaef](https://github.com/lucasaarch/jian/commit/c6fdaef8cea3be14d9e1037ffd1df2526c39fc50))
* **panel:** identity and model defaults save as you type; model defaults as a grid ([2417d25](https://github.com/lucasaarch/jian/commit/2417d25ffcdd22a8dee608c46d4a4e7e3052b513)) ([60ec14d](https://github.com/lucasaarch/jian/commit/60ec14dedb3e19cbf38762c326f3b697fe8eb677))
* **releases:** this dialog, once after each update ([5a4f06c](https://github.com/lucasaarch/jian/commit/5a4f06c76c7266494a1a98c020612874f7e22bfb))

### Bug Fixes

* **channels:** documents sent on WhatsApp now reach the agent, whatever their format; Telegram now delivers photos, voice notes and files, not only text; a file posted in a group is kept for when the agent is called ([bf2df09](https://github.com/lucasaarch/jian/commit/bf2df09d391ae2cbf430720e6abb704654a41c68))
* **mcp:** testing a server now reaches origins allowed by `JIAN_ALLOW_PRIVATE_ORIGINS`, as the agent does ([4cb9dfd](https://github.com/lucasaarch/jian/commit/4cb9dfd6805832c564752aa49b151777c2bface3))
* **channels:** stop a channel's device before deleting its profile ([c3bbe57](https://github.com/lucasaarch/jian/commit/c3bbe5759d697dd3d933e50e92ff718d49afd8c7))
* **panel:** every screen and every date in English ([7e2b7e7](https://github.com/lucasaarch/jian/commit/7e2b7e7cfbdbaba2e893da8de6042d66566c03a7)) ([d58a3cf](https://github.com/lucasaarch/jian/commit/d58a3cf6d0b7ab8c27167f5d6ad42f76bf488b4b))

### Upgrading

Eight migrations run on start. Schedules use the machine's time zone until one is set under **Settings › Gateway**. The discernment nudge is switched off on every profile; switch it back on under **Skills** if you use it.

## 2.1.0 — 2026-09-23

### Features

* **agent:** edit code precisely and reach every channel conversation ([cbdf85f](https://github.com/lucasaarch/jian/commit/cbdf85fd8bad9149bf185f9e432e5f0ad5d87041))
* **decisions:** ask Jev whether a group message calls an agent and whether an action goes too far ([8704289](https://github.com/lucasaarch/jian/commit/87042890ed033b3f5a267760a071757fa213c352))
* **web:** let an agent search the web and read public pages ([23ca3d7](https://github.com/lucasaarch/jian/commit/23ca3d75d1ba7cc17bf715a950495ca45e0ca65a))

### Bug Fixes

* **groups:** hand other agents the whole turn, not only its last paragraph ([ee6ff48](https://github.com/lucasaarch/jian/commit/ee6ff488f5f88c2636fc8ce23cc0f5c8a94cf715))
* **groups:** show each agent what the others said in a Telegram group ([c5a280d](https://github.com/lucasaarch/jian/commit/c5a280d5e8a94b9879916132de13952f576921e3))
* **mcp:** tell agents which tools their servers offer and find them by words ([414f601](https://github.com/lucasaarch/jian/commit/414f601f05b396501a1222d4d349479ec2edcc54))
* **providers:** carry ChatGPT reasoning between steps instead of referring to it ([09a3714](https://github.com/lucasaarch/jian/commit/09a3714dfcd6a7cfd1f8c8a4cb506170a6888a1c))

## 2.0.0 — 2026-09-23

### ⚠ BREAKING CHANGES

* **mcp:** reach a server by command, by any header, or by signing in to it

### Features

* **agent:** raise the step ceiling to two hundred ([64cc842](https://github.com/lucasaarch/jian/commit/64cc842c90f149adaf462d7a8e3e58d1ad36c4c5))
* **agent:** summarise a conversation that outgrew its request ([3d571db](https://github.com/lucasaarch/jian/commit/3d571dbecdeab8f2eee9ff9c0cec4d04e6432bf3))
* **audio:** unify incoming voice and audio model selection ([1130194](https://github.com/lucasaarch/jian/commit/1130194d9a721094e55ea1f3af18736ab64f9a90))
* **channels:** answer as the work happens, not after it ([045d3d3](https://github.com/lucasaarch/jian/commit/045d3d3afcb719cea43f015853f0c70fae0a57c6))
* **channels:** release an answer a paragraph at a time ([37b73c1](https://github.com/lucasaarch/jian/commit/37b73c10939c1ffda9f0095ebbb4bda75af47996))
* **groups:** read the whole room and answer only mentions and replies ([c771a96](https://github.com/lucasaarch/jian/commit/c771a966d30b2beb3c36762e3cb302caa5736bfc))
* **image:** give agents a workbench of tools and a persistent home ([2e2f663](https://github.com/lucasaarch/jian/commit/2e2f66347acfe9c688fe525e6363b87a5ba67dad))
* **mcp:** reach a server by command, by any header, or by signing in to it ([dca283e](https://github.com/lucasaarch/jian/commit/dca283e3366df7ee2a27d6671e7d7b872a3d16f8))
* **media:** add WhatsApp vision and audio tools with selectable providers ([5c5b0c3](https://github.com/lucasaarch/jian/commit/5c5b0c3a9e2a925b73fd1bf1910eebb1a8efc6c0))
* **panel:** describe a day of the calendar on hover ([90c9911](https://github.com/lucasaarch/jian/commit/90c9911910a75d9a4b427fedfb7147e286645c70))
* **panel:** say which Anthropic credential was pasted ([37f3e20](https://github.com/lucasaarch/jian/commit/37f3e20ed618ff341790da4f39853c98b6370837))
* **panel:** show a year of activity as a calendar ([8a3486c](https://github.com/lucasaarch/jian/commit/8a3486c172d56f35eabe2db205307438afbc2c51))

### Bug Fixes

* **agent:** answer instead of failing, and stop holding a slow colleague ([1ed1630](https://github.com/lucasaarch/jian/commit/1ed163028e60b1075e01e19919ebc5ac04d393db))
* **agent:** carry on when a server reports a failure ([42b007e](https://github.com/lucasaarch/jian/commit/42b007ee819672816019120beb5278e272283fb3))
* **agent:** compact tool work and preserve answers at token limits ([62d0335](https://github.com/lucasaarch/jian/commit/62d0335b11a22044d9f0e143bea20797cd6484c3))
* **agent:** end a spent turn with an answer, not a failure ([8cb201d](https://github.com/lucasaarch/jian/commit/8cb201d1b0afd0d10cd74546f8edfa78eed52480))
* **agent:** let a failure say what actually went wrong ([0af0d7b](https://github.com/lucasaarch/jian/commit/0af0d7bf534eb89ca8bf3cd12016a8b757541e4e))
* **agent:** name MCP tools the way an Anthropic subscription accepts ([45885d1](https://github.com/lucasaarch/jian/commit/45885d1ee125ef0ab86ad71d9e73c6dce691cfb1))
* **agent:** recover missing reports and refresh session status ([6a2927f](https://github.com/lucasaarch/jian/commit/6a2927f28e08119f8b493e0b9fe2928194382095))
* **agent:** stop charging a run for the prompt it already sent ([a318a93](https://github.com/lucasaarch/jian/commit/a318a93fe5e6d31127aa77245ade923c8fa24bdc))
* **channels:** keep long contact messages from blocking delivery ([12dfa0e](https://github.com/lucasaarch/jian/commit/12dfa0eb6f4ddf02dda234c0dc1d2531c0d090c9))
* **channels:** record a message to a contact in their own conversation ([ee0d42d](https://github.com/lucasaarch/jian/commit/ee0d42dcac02d1007536d05f900ad559670602d5))
* **groups:** let the API channel be called by its channel id ([cf83b07](https://github.com/lucasaarch/jian/commit/cf83b079819244eb45c6bf58988df8ac32d03a6c))
* **media:** discover and validate provider speech voices ([c947c50](https://github.com/lucasaarch/jian/commit/c947c5051dcade88a579822790869466a79bbe6c))
* **media:** restore native vision after restart and sanitize channel logs ([865ee00](https://github.com/lucasaarch/jian/commit/865ee008a311e451758917838c1c08f03f6ff0c8))
* **panel:** colour the divider with the group it belongs to ([e102030](https://github.com/lucasaarch/jian/commit/e102030f0e79eff6f76217b61921b9a738f6a2f8))
* **panel:** count a day of activity where the reader is ([1ef99cd](https://github.com/lucasaarch/jian/commit/1ef99cd3d718a71d8771a585acba03a95c8feb29))
* **panel:** draw a name and its value as one control ([1307565](https://github.com/lucasaarch/jian/commit/1307565bd4fd5262755f7100e12c73987c403fc3))
* **panel:** import the stylesheets that were never loaded ([a65830d](https://github.com/lucasaarch/jian/commit/a65830de460ca9c1df2bc30fc063d4837f5b0469))
* **panel:** keep today's square inside the calendar ([487ceca](https://github.com/lucasaarch/jian/commit/487ceca248050c5ddfd9cf9d25e2add4bdf8376e))
* **panel:** stop a select from reflowing the form it opens over ([f7cda1f](https://github.com/lucasaarch/jian/commit/f7cda1fc76976bab88aa8a20c55ec488624e4fd5))
* **peers:** give the agent that asked its half of the thread ([c65f644](https://github.com/lucasaarch/jian/commit/c65f64443ae3319364a566013eb3f0798c0ef2d0))
* **profiles:** stop a partial edit from erasing the summary ([7d8576f](https://github.com/lucasaarch/jian/commit/7d8576f0a94c49c075dbc43019eee37fc669b3ba))
* **providers:** filter media activities by supported provider ([420ec61](https://github.com/lucasaarch/jian/commit/420ec61161c03068700c938a88ec27c24c44711e))
* **providers:** require Claude subscription protocol 2.1.280 ([5e6015d](https://github.com/lucasaarch/jian/commit/5e6015db41f28b3f14c18c0d3599a363afdac0eb))
* **providers:** store the Anthropic credential type the owner chose ([3bd04b9](https://github.com/lucasaarch/jian/commit/3bd04b973ce976dc2fd836a3c03d45f06ff4b757))

### Performance Improvements

* **agent:** let Anthropic read back the stable part of a prompt ([b69e340](https://github.com/lucasaarch/jian/commit/b69e3401f451dfc18fa012aae91a80d0ef49332b))
* **agent:** load tools when the turn asks for them ([8b5ac08](https://github.com/lucasaarch/jian/commit/8b5ac08849715404327b6341fce710e562149e6b))
* **agent:** make the prompt cacheable and size it to the model ([86f91e3](https://github.com/lucasaarch/jian/commit/86f91e378e1cfb4eefce0bf7410a53252ab17d3d))

## 1.0.2 — 2026-09-22

### Bug Fixes

* **channels:** say whether the webhook was registered when a channel connects ([b8d52a5](https://github.com/lucasaarch/jian/commit/b8d52a5f12b46ec05de866484dccaaa568fae552))
* **panel:** stop showing the same token total twice ([e3892bd](https://github.com/lucasaarch/jian/commit/e3892bdb36a366653bbd1f07896ceaf283d95b63))

## 1.0.1 — 2026-09-22

### Bug Fixes

* **image:** ship the migrations the gateway runs on start ([e9eacbf](https://github.com/lucasaarch/jian/commit/e9eacbf90919944c6570280a6e139f7c781579db))

## 1.0.0 — 2026-09-22

### ⚠ BREAKING CHANGES

* **providers:** a vendor credential belongs to the gateway, not to a profile
* **channels:** answer in several finished messages instead of one that rewrites itself
* **providers:** learn model limits instead of shipping a table
* **storage:** replace the record blob with typed tables
* **channels:** createChannel takes {type, botToken?}; channels no longer carry name, sessionId, actorIds or chatIds; the `generic` type is now `api`. Migration 7 rewrites existing channels, keeps one connected channel per type and turns allowed senders into approved contacts on the session their binding used.
* **providers:** `POST /providers` no longer takes `models`, and `PUT /model-defaults` carries seven roles instead of two.
* **panel:** type each secret where the thing is configured

### Features

* bootstrap Elos agent gateway ([708e93c](https://github.com/lucasaarch/jian/commit/708e93cfc371406d74893c7615e0872b0e7824a3))
* **channels:** answer in several finished messages instead of one that rewrites itself ([a8b5e9f](https://github.com/lucasaarch/jian/commit/a8b5e9fb11478422d651dab19383a539be34abcb))
* **channels:** connect one channel per type and approve who talks ([dace6aa](https://github.com/lucasaarch/jian/commit/dace6aa701e1798f8ce0f7342d9afb58940311a3))
* **channels:** put several agents in one group conversation ([9e9d228](https://github.com/lucasaarch/jian/commit/9e9d228beedb0f2c2a141cb8b8922fa8b8cb1df2))
* **contacts:** let a profile ask one of its contacts and bring the answer back ([9fa1cad](https://github.com/lucasaarch/jian/commit/9fa1cadb04c8be1215b89360cc311313be3173f0))
* **mcp:** take the tools from the server instead of from a list ([906d2c1](https://github.com/lucasaarch/jian/commit/906d2c16e071238753b12c733b25191753a8b393))
* **panel:** restyle the workspace on Tailwind, with themes and a settings section ([ce464e8](https://github.com/lucasaarch/jian/commit/ce464e8343cb95222189e1cfee5bbda236f28956))
* **peers:** let the profiles of an installation talk to each other ([2187fe3](https://github.com/lucasaarch/jian/commit/2187fe3e5d21b84ef25fa36e3dc597c3b52f2c36))
* **providers:** a vendor credential belongs to the gateway, not to a profile ([159bb3e](https://github.com/lucasaarch/jian/commit/159bb3e46b15cd203f27e35c0f99150cacb987a7))
* **providers:** accept a Claude subscription token ([2f53882](https://github.com/lucasaarch/jian/commit/2f538820ad23c7a5d74a55f1df4e95527ffbc85e))
* **providers:** let OpenRouter report what each model can do ([9a70250](https://github.com/lucasaarch/jian/commit/9a702502ff5b4940ca3480f67072cd9d76ef3258))
* **providers:** list the models a ChatGPT login may actually call ([06465e4](https://github.com/lucasaarch/jian/commit/06465e4768961b3347a2df66344035e980d046e0))
* **providers:** read the model list from each provider account ([5c977f1](https://github.com/lucasaarch/jian/commit/5c977f1e57294db954dbe74a01a08ded715f8a21))
* restructure into a pnpm monorepo with web panel and Apple client ([ef28fb5](https://github.com/lucasaarch/jian/commit/ef28fb52e25390e9d2432ecedd051448d5101e77))
* **runs:** choose a model when the owner has not ([733ff91](https://github.com/lucasaarch/jian/commit/733ff915e87afee8cacd1944877a877861420b31))
* **runs:** report what the agent is doing while it does it ([ae8743f](https://github.com/lucasaarch/jian/commit/ae8743f9683824386b105fd2a584d025cef6151b))
* **runs:** take a message sent mid-run as a correction, and open the terminal ([2e8d431](https://github.com/lucasaarch/jian/commit/2e8d431e1d059a9f3f89be0e76a079d563e27bfd))
* **sessions:** let the agent name a conversation from its first message ([0549b1c](https://github.com/lucasaarch/jian/commit/0549b1c5b08e97206c67cc8b03db3a3920c31322))
* **skills:** import skills from a repository in the open SKILL.md format ([0f7a4da](https://github.com/lucasaarch/jian/commit/0f7a4daa13ac01a66dd9fbf031af5502ed1fb413))
* **skills:** ship the skills every profile starts with ([2a7b79f](https://github.com/lucasaarch/jian/commit/2a7b79f2fe7ba771fc36549b9b0b840a3ecfca77))

### Bug Fixes

* **channels:** send plain text where the bubble cannot draw markdown ([5b7b191](https://github.com/lucasaarch/jian/commit/5b7b1911c463be2c327129aad680976eb3378c73))
* **panel:** build the script policy from the page being served ([f37fdfd](https://github.com/lucasaarch/jian/commit/f37fdfd88009c653a95fdc4885832f19266d1dc1))
* **panel:** count what the profile has done, and tell it what it runs on ([651cef6](https://github.com/lucasaarch/jian/commit/651cef6a6edfa772f59f7bccd0f10339ea739cce))
* **panel:** make a connected MCP server readable ([8cd586d](https://github.com/lucasaarch/jian/commit/8cd586d7cb8f8e3b1661a92c623624d9fcda31bc))
* **panel:** style the navigation entries as the links they are ([a53feef](https://github.com/lucasaarch/jian/commit/a53feef9da8e0dd7eee40d48760ea4b91f90ccf8))
* **providers:** read a provider stored before the vault moved indoors ([8fb757a](https://github.com/lucasaarch/jian/commit/8fb757a916e7728e8598e4e2cda5976b75bba23c))
* **providers:** read the model catalog entry by entry ([121f9ee](https://github.com/lucasaarch/jian/commit/121f9ee95fb1e95170087868ff6941468e4b9a62))
* **providers:** send the Claude Code identity as its own system block ([94525e4](https://github.com/lucasaarch/jian/commit/94525e464a864e5e1d524d699a19f42310196c1d))
* **runtime:** say what the provider answered when a run fails ([825d63e](https://github.com/lucasaarch/jian/commit/825d63ed1f692701f51c80626d84863ed346ab3a))
* **security:** build the request with the same undici as the dispatcher ([1a60ed4](https://github.com/lucasaarch/jian/commit/1a60ed420b8acc547d8fb3454ad52f35714790d2))
* **security:** carry the whole cause chain into the outbound failure ([53bfeba](https://github.com/lucasaarch/jian/commit/53bfebaf5cddae6b0d5b2362ab4288e793a3816d))
* **security:** say why an outbound request failed ([f7d0096](https://github.com/lucasaarch/jian/commit/f7d00962b50acca079a1a204fe56589fec2d08f2))
* **telegram:** honour the wait Telegram asks for under flood control ([412c0f3](https://github.com/lucasaarch/jian/commit/412c0f34de3247626d800f793b93ed89ef157603))
* **whatsapp:** stop libsignal printing session keys to the log ([e7f2587](https://github.com/lucasaarch/jian/commit/e7f2587790668ccfc8ce128296ef2c9c683038cb))

### Code Refactoring

* **panel:** type each secret where the thing is configured ([2e47bd9](https://github.com/lucasaarch/jian/commit/2e47bd9987cc056acc253ee18ad69c4e1034931c))
* **providers:** learn model limits instead of shipping a table ([434bfd5](https://github.com/lucasaarch/jian/commit/434bfd5936ecd6b1f812b2fb1c1c71362756f9d0))
* **storage:** replace the record blob with typed tables ([8fb3936](https://github.com/lucasaarch/jian/commit/8fb393667d7fa24615e7b932c3b3c66b67c41774))
