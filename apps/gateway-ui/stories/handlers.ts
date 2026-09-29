import { delay, HttpResponse, http } from 'msw';
import { lastMessageOf } from './conversations';
import * as data from './fixtures';

/**
 * The gateway, answered from the fixtures. A page story renders the real layout, which loads
 * everything over HTTP, so the whole API it touches is here — reads return the installation,
 * writes succeed and change nothing.
 */
const ok = <T>(value: T) => HttpResponse.json(value as never);
const byProfile = <T extends { profileId: string }>(items: T[], profileId: string) =>
  items.filter((item) => item.profileId === profileId);

const taskWorker = {
  runId: 'e4b8f462-1615-4de3-82df-f8f8e1308101',
  sessionId: 'c9768216-c155-4751-bf8c-f8f8e1308101',
  role: 'execute',
  name: 'Release verifier',
  status: 'completed',
  input: 'Run checks and report.',
  output: 'Gateway checks passed; ready for independent review.',
  createdAt: data.work[0].createdAt,
  updatedAt: data.work[0].updatedAt,
};

const settings = { timeZone: 'America/Sao_Paulo', timeZoneSource: 'setting' };

const decisions = (configured: boolean) => ({
  provider: 'jev',
  configured,
  ...(configured ? { updatedAt: new Date().toISOString() } : {}),
  uses: { actions: true, outside: true, turn: true, memories: true, learning: true, groups: false },
  usage: [
    {
      day: new Date().toISOString().slice(0, 10),
      use: 'actions',
      requests: 42,
      cached: 9,
      inputTokens: 18_400,
      outputTokens: 840,
    },
    {
      day: new Date().toISOString().slice(0, 10),
      use: 'turn',
      requests: 17,
      cached: 0,
      inputTokens: 51_000,
      outputTokens: 1_200,
    },
  ],
});

export const handlers = [
  http.get('*/v1/profiles/:profileId/work', ({ params }) =>
    ok(byProfile(data.work, String(params.profileId))),
  ),
  http.get('*/v1/profiles/:profileId/work/:workId/history', ({ params }) =>
    ok(data.workHistory[String(params.workId)] ?? []),
  ),
  http.get('*/v1/profiles/:profileId/work/:workId/executions', ({ params }) =>
    ok(params.workId === data.work[0].id ? [taskWorker] : []),
  ),
  http.get('*/v1/profiles', () => ok(data.profiles)),
  http.get('*/v1/profiles/:profileId', ({ params }) =>
    ok(data.profiles.find((profile) => profile.id === params.profileId) ?? data.profiles[0]),
  ),
  http.patch('*/v1/profiles/:profileId', async ({ params, request }) => {
    const current = data.profiles.find((profile) => profile.id === params.profileId);

    const patch = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    return ok({ ...current, ...patch });
  }),
  http.delete('*/v1/profiles/:profileId', ({ params }) => ok({ id: params.profileId })),
  http.post('*/v1/profiles/:profileId/reset', ({ params }) =>
    ok({ id: params.profileId, sessions: 3, memories: 2 }),
  ),
  http.post('*/v1/profiles', async ({ request }) => {
    const input = (await request.json().catch(() => ({}))) as Record<string, unknown>;

    return ok({ ...data.profiles[2], ...input });
  }),

  // The last line of each conversation, read again: the mock agent adds to them as it answers.
  http.get('*/v1/profiles/:profileId/sessions', ({ params }) =>
    ok(
      byProfile(data.sessions, String(params.profileId)).map((session) => {
        const lastMessage = lastMessageOf(session.id);

        return lastMessage ? { ...session, lastMessage } : session;
      }),
    ),
  ),
  http.get('*/v1/profiles/:profileId/sessions/:sessionId/messages', ({ params }) =>
    ok(
      params.sessionId === taskWorker.sessionId
        ? [
            {
              id: 'a5bf11e2-918d-4634-a181-f8f8e1308101',
              profileId: data.work[0].profileId,
              sessionId: taskWorker.sessionId,
              runId: taskWorker.runId,
              role: 'user',
              content: taskWorker.input,
              createdAt: taskWorker.createdAt,
            },
            {
              id: 'a5bf11e2-918d-4634-a181-f8f8e1308102',
              profileId: data.work[0].profileId,
              sessionId: taskWorker.sessionId,
              runId: taskWorker.runId,
              role: 'assistant',
              content: taskWorker.output,
              createdAt: taskWorker.updatedAt,
            },
          ]
        : data.messages.filter((message) => message.sessionId === params.sessionId),
    ),
  ),
  http.get('*/v1/profiles/:profileId/media/:mediaId', ({ params }) => {
    const item = data.media[String(params.mediaId)];

    return item
      ? ok({
          id: params.mediaId,
          profileId: params.profileId,
          bytes: Math.floor((item.data.length * 3) / 4),
          createdAt: new Date().toISOString(),
          ...item,
        })
      : HttpResponse.json({ error: 'Media not found' }, { status: 404 });
  }),
  http.post('*/v1/profiles/:profileId/sessions/:sessionId/media', async ({ request, params }) => {
    const body = (await request.json()) as { mimeType: string; name?: string; data: string };

    // Slow enough to see a tile uploading.
    await delay(600);
    return HttpResponse.json(
      {
        id: crypto.randomUUID(),
        profileId: params.profileId,
        mimeType: body.mimeType,
        ...(body.name ? { name: body.name } : {}),
        bytes: Math.floor((body.data.length * 3) / 4),
        createdAt: new Date().toISOString(),
      },
      { status: 201 },
    );
  }),
  // The gateway's live stream, as far as the mock agent needs it: while any run works, a
  // progress update each second, so an open conversation follows along as it does for real.
  http.get('*/v1/profiles/:profileId/events/stream', ({ request }) => {
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setInterval>;
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(': connected\n\n'));
        const seen = new Set<string>();

        timer = setInterval(() => {
          const working = data.runs.filter(
            (run) => run.status === 'queued' || run.status === 'running',
          );

          // A run this stream saw working that has stopped: its answer is in, as the gateway's
          // own `run.completed` would say.
          for (const runId of seen) {
            const run = data.runs.find((item) => item.id === runId);

            if (run && !working.includes(run)) {
              seen.delete(runId);
              controller.enqueue(
                encoder.encode(
                  `event: run.${run.status}\ndata: ${JSON.stringify({ sessionId: run.sessionId })}\n\n`,
                ),
              );
            }
          }
          for (const run of working) seen.add(run.id);

          for (const run of working) {
            controller.enqueue(
              encoder.encode(
                `event: run.progress\ndata: ${JSON.stringify({ runId: run.id, sessionId: run.sessionId })}\n\n`,
              ),
            );
          }
          if (!working.length) controller.enqueue(encoder.encode(': heartbeat\n\n'));
        }, 1000);
        request.signal.addEventListener('abort', () => {
          clearInterval(timer);
          controller.close();
        });
      },
      cancel() {
        clearInterval(timer);
      },
    });

    return new HttpResponse(body, { headers: { 'content-type': 'text/event-stream' } });
  }),
  http.get('*/v1/profiles/:profileId/sessions/:sessionId/timeline', ({ params }) =>
    ok(data.timelines[String(params.sessionId)] ?? []),
  ),
  http.get('*/v1/profiles/:profileId/sessions/:sessionId/people', ({ params }) =>
    ok(data.people[String(params.sessionId)] ?? []),
  ),
  // A small agent: the message lands, the run thinks, uses a tool, writes, and answers, so a
  // story shows every state the conversation passes through after a send.
  http.post(
    '*/v1/profiles/:profileId/sessions/:sessionId/messages',
    async ({ params, request }) => {
      const body = (await request.json()) as { text: string; mediaIds?: string[] };
      const now = () => new Date().toISOString();
      const sessionId = String(params.sessionId);
      const profileId = String(params.profileId);
      const run: (typeof data.runs)[number] = {
        id: crypto.randomUUID(),
        profileId,
        sessionId,
        requestKey: crypto.randomUUID(),
        input: body.text,
        status: 'queued',
        createdAt: now(),
        updatedAt: now(),
      };
      const content = [body.text, ...(body.mediaIds ?? []).map((id) => `[Attached media: ${id}]`)]
        .filter(Boolean)
        .join('\n');

      data.messages.push({
        id: crypto.randomUUID(),
        profileId,
        sessionId,
        runId: run.id,
        role: 'user',
        content,
        createdAt: now(),
      } as (typeof data.messages)[number]);
      data.runs.push(run);

      const steps: (typeof data.timelines)[string][number]['steps'] = [];
      data.timelines[sessionId] = [...(data.timelines[sessionId] ?? []), { runId: run.id, steps }];
      const tool = (ms: number, toolName: string, lasting: number) => {
        setTimeout(() => {
          const step: (typeof steps)[number] = {
            toolCallId: crypto.randomUUID(),
            toolName,
            status: 'running',
            startedAt: now(),
          };

          steps.push(step);
          setTimeout(() => Object.assign(step, { status: 'done', finishedAt: now() }), lasting);
        }, ms);
      };
      tool(1500, 'search_history', 1500);
      tool(3500, 'web_search', 2500);
      const at = (ms: number, change: Partial<typeof run>) =>
        setTimeout(() => Object.assign(run, change, { updatedAt: now() }), ms);
      at(800, {
        status: 'running',
        progress: { phase: 'thinking', text: '', steps: 1, updatedAt: now() },
      } as never);
      at(3500, {
        progress: { phase: 'tool', tool: 'web_search', text: '', steps: 2, updatedAt: now() },
      } as never);
      at(6500, {
        progress: { phase: 'writing', text: 'Got it, I will', steps: 3, updatedAt: now() },
      } as never);
      setTimeout(() => {
        Object.assign(run, {
          status: 'completed',
          output: 'Got it, I will look into this.',
          progress: undefined,
          updatedAt: now(),
        });
        data.messages.push({
          id: crypto.randomUUID(),
          profileId,
          sessionId,
          runId: run.id,
          role: 'assistant',
          content: 'Got it, I will look into this.',
          createdAt: now(),
        } as (typeof data.messages)[number]);
      }, 9000);

      return HttpResponse.json(run as never, { status: 202 });
    },
  ),
  http.get('*/v1/profiles/:profileId/activities', ({ params }) =>
    ok(byProfile(data.runs, String(params.profileId))),
  ),
  http.get('*/v1/profiles/:profileId/runs/:runId', ({ params }) =>
    ok(data.runs.find((run) => run.id === params.runId) ?? data.runs[0]),
  ),
  http.get('*/v1/profiles/:profileId/activity', () => ok(data.activityCalendar)),
  // The live feed: held open and silent, the way a quiet gateway keeps it.
  http.get('*/v1/profiles/:profileId/channels', ({ params }) =>
    ok(byProfile(data.channels, String(params.profileId))),
  ),
  http.post('*/v1/profiles/:profileId/channels', ({ params }) =>
    ok({
      ...data.channels[0],
      profileId: params.profileId,
      webhookToken: 'synthetic-webhook-token',
    }),
  ),
  http.get('*/v1/profiles/:profileId/channels/:channelId/connection', () => ok(data.connection)),
  http.get('*/v1/profiles/:profileId/channels/:channelId/qr', () =>
    ok({
      qr: 'synthetic-qr-payload-for-storybook',
      expiresAt: new Date(Date.now() + 45_000).toISOString(),
    }),
  ),
  http.post('*/v1/profiles/:profileId/channels/:channelId/:action', () => ok(data.connection)),
  http.delete('*/v1/profiles/:profileId/channels/:channelId', () => ok(data.channels[0])),
  http.get('*/v1/profiles/:profileId/contacts', ({ params }) =>
    ok(byProfile(data.contacts, String(params.profileId))),
  ),
  http.post('*/v1/profiles/:profileId/contacts/:contactId/:decision', ({ params }) =>
    ok(data.contacts.find((contact) => contact.id === params.contactId)),
  ),
  http.get('*/v1/groups', () => ok(data.groups)),
  http.get('*/v1/profiles/:profileId/deliveries', ({ params }) =>
    ok(byProfile(data.deliveries, String(params.profileId))),
  ),

  // Schedules change as the story is used, as they would on the gateway.
  http.get('*/v1/profiles/:profileId/schedules', ({ params }) =>
    ok(byProfile(data.schedules, String(params.profileId))),
  ),
  http.post('*/v1/profiles/:profileId/schedules', async ({ params, request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    const created = {
      ...body,
      id: crypto.randomUUID(),
      profileId: String(params.profileId),
      createdBy: 'owner',
      nextRunAt: (body.at as string | undefined) ?? new Date(Date.now() + 86_400_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as (typeof data.schedules)[number];

    data.schedules.push(created);
    return HttpResponse.json(created as never, { status: 201 });
  }),
  http.patch('*/v1/profiles/:profileId/schedules/:id', async ({ params, request }) => {
    const found = data.schedules.find((item) => item.id === params.id);
    const body = (await request.json()) as Record<string, unknown>;

    if (!found) return HttpResponse.json({ error: 'Schedule not found' }, { status: 404 });
    if (body.at) delete found.cron;
    if (body.cron) delete found.at;
    Object.assign(found, body, { updatedAt: new Date().toISOString() });
    return ok(found);
  }),
  http.delete('*/v1/profiles/:profileId/schedules/:id', ({ params }) => {
    const index = data.schedules.findIndex((item) => item.id === params.id);

    return ok(index >= 0 ? data.schedules.splice(index, 1)[0] : data.schedules[0]);
  }),
  http.get('*/v1/profiles/:profileId/schedules/:id/history', ({ params }) => {
    const found = data.schedules.find((item) => item.id === params.id);

    if (!found?.cron) return ok([]);
    // A month of mornings: mostly fine, one that failed, one that did not start, one by hand.
    return ok(
      Array.from({ length: 12 }, (_, index) => {
        const due = new Date(Date.UTC(2026, 8, 24 - index, 11));

        return {
          id: `${String(params.id).slice(0, 24)}${String(index).padStart(12, '0')}`,
          dueAt: due.toISOString(),
          manual: index === 3,
          createdAt: due.toISOString(),
          ...(index === 5
            ? { error: 'The provider key is not configured. Add one under Providers.' }
            : {
                runId: `66b4c0ba-2222-4a4a-8a8a-${String(index).padStart(12, '0')}`,
                status: index === 8 ? 'failed' : 'completed',
              }),
          ...(index === 8 ? { error: 'The provider ended without a final response.' } : {}),
        };
      }),
    );
  }),
  http.get('*/v1/settings', () => ok(settings)),
  http.post('*/v1/profiles/:profileId/schedules/:id/run', () =>
    HttpResponse.json(data.runs[0] as never, { status: 202 }),
  ),

  http.post('*/v1/profiles/:profileId/mcp-servers/import', async ({ request }) => {
    const { servers = [] } = (await request.json()) as { servers?: string[] };

    return ok({
      imported: servers,
      skipped: [],
      signIn: servers.filter((name) => name === 'linear'),
    });
  }),
  http.get('*/v1/profiles/:profileId/stats', ({ request }) =>
    ok(data.statsFor(Number(new URL(request.url).searchParams.get('days') ?? 30))),
  ),
  http.get('*/v1/profiles/:profileId/memories', ({ params }) =>
    ok(byProfile(data.memories, String(params.profileId))),
  ),
  // The notebook changes as the story is used: an edit is a new version, a link shows on both
  // memories, and deleting one takes its links with it.
  http.put('*/v1/profiles/:profileId/memories/:key', async ({ params, request }) => {
    const found = data.memories.find((item) => item.key === params.key);
    const body = (await request.json()) as { content: string };

    if (!found) return HttpResponse.json({ error: 'Memory not found' }, { status: 404 });
    Object.assign(found, {
      content: body.content,
      version: found.version + 1,
      sourceSessionId: undefined,
      updatedAt: new Date().toISOString(),
    });
    return ok(found);
  }),
  http.put('*/v1/profiles/:profileId/memories/:key/links/:other', ({ params }) => {
    const [a, b] = [params.key, params.other].map((key) =>
      data.memories.find((item) => item.key === key),
    );

    if (!a || !b) return HttpResponse.json({ error: 'Memory not found' }, { status: 404 });
    a.links = [...new Set([...(a.links ?? []), b.key])].sort();
    b.links = [...new Set([...(b.links ?? []), a.key])].sort();
    return ok(a);
  }),
  http.delete('*/v1/profiles/:profileId/memories/:key/links/:other', ({ params }) => {
    for (const item of data.memories) {
      if (item.key === params.key) item.links = item.links?.filter((key) => key !== params.other);
      if (item.key === params.other) item.links = item.links?.filter((key) => key !== params.key);
    }
    return ok(data.memories.find((item) => item.key === params.key));
  }),
  http.delete('*/v1/profiles/:profileId/memories/:key', ({ params }) => {
    const index = data.memories.findIndex((item) => item.key === params.key);
    const [gone] = index >= 0 ? data.memories.splice(index, 1) : [];

    for (const item of data.memories) item.links = item.links?.filter((key) => key !== params.key);
    return ok(gone ?? data.memories[0]);
  }),

  http.get('*/v1/providers', () => ok(data.providers)),
  http.post('*/v1/providers', () => ok(data.providers[0])),
  http.delete('*/v1/providers/:providerId', () => ok(data.providers[0])),
  http.get('*/v1/providers/openai/oauth', () => ok({ status: 'connected' })),
  http.post('*/v1/providers/openai/oauth', () =>
    ok({
      status: 'pending',
      verificationUrl: 'https://auth.openai.com/codex/device',
      userCode: 'ABCD-1234',
    }),
  ),
  http.get('*/v1/providers/:providerId/models', ({ params }) =>
    ok(data.providerModels[String(params.providerId)]),
  ),
  http.get('*/v1/profiles/:profileId/model-defaults', () => ok(data.modelDefaults)),
  http.put('*/v1/profiles/:profileId/model-defaults', () => ok(data.modelDefaults)),

  http.get('*/v1/profiles/:profileId/built-in-skills', () => ok(data.builtinSkills)),
  http.get('*/v1/profiles/:profileId/skill-catalog', () =>
    ok({
      marketplace: 'example-skills',
      entries: [
        {
          name: 'concise',
          description: 'Answer in the first sentence.',
          url: 'https://github.com/example/skills/tree/main/concise',
        },
        {
          name: 'code-review',
          description: 'Review a diff for correctness.',
          url: 'https://github.com/example/skills/tree/main/code-review',
        },
      ],
    }),
  ),
  http.post('*/v1/profiles/:profileId/skills/import', ({ params }) =>
    ok(data.profiles.find((profile) => profile.id === params.profileId)),
  ),
  http.post('*/v1/profiles/:profileId/mcp-servers/:name/check', async ({ params }) => {
    await delay(400);

    return ok({
      name: params.name,
      reachable: true,
      tools: [
        { name: 'search_code', description: 'Search code across repositories.' },
        { name: 'create_issue', description: 'Open an issue.' },
        { name: 'list_pull_requests' },
      ],
      checkedAt: new Date().toISOString(),
    });
  }),

  http.get('*/v1/web-search', () =>
    ok({ provider: 'tavily', configured: true, updatedAt: '2026-09-20T12:00:00.000Z' }),
  ),
  http.put('*/v1/web-search', () =>
    ok({ provider: 'tavily', configured: true, updatedAt: new Date().toISOString() }),
  ),
  http.delete('*/v1/web-search', () => ok({ provider: 'tavily', configured: false })),
  http.get('*/v1/decisions', () => ok(decisions(false))),
  http.put('*/v1/decisions', () => ok(decisions(true))),
  http.patch('*/v1/decisions', () => ok(decisions(true))),
  http.delete('*/v1/decisions', () => ok(decisions(false))),

  // Most stories are about a screen, not about the update dialog opening over it.
  http.get('*/v1/releases', () => ok({ ...data.releases, unseen: [] })),
  http.post('*/v1/releases/seen', () => ok({ ...data.releases, unseen: [] })),
  http.get('*/v1/repository', () => ok({ url: 'https://github.com/lucasaarch/jian', stars: 1284 })),

  http.post('*/v1/panel/session', () => new HttpResponse(null, { status: 204 })),
  http.delete('*/v1/panel/session', () => new HttpResponse(null, { status: 204 })),
];

/** The same gateway with nothing in it yet: a first run. */
export const emptyHandlers = [
  http.get('*/v1/profiles/:profileId/sessions', () => ok([])),
  http.get('*/v1/profiles/:profileId/activities', () => ok([])),
  http.get('*/v1/profiles/:profileId/channels', () => ok([])),
  http.get('*/v1/profiles/:profileId/contacts', () => ok([])),
  http.get('*/v1/profiles/:profileId/memories', () => ok([])),
  http.get('*/v1/profiles/:profileId/deliveries', () => ok([])),
  http.get('*/v1/groups', () => ok([])),
  http.get('*/v1/providers', () => ok([])),
  http.get('*/v1/profiles/:profileId/activity', () => ok([])),
  ...handlers,
];

/** An update just landed: the release dialog opens over the page. */
export const updatedHandlers = [http.get('*/v1/releases', () => ok(data.releases)), ...handlers];
