import { parseCommentIngress, parseMentionReply } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Channels } from '../src/channels/service.js';
import { GatewayError } from '../src/core/errors.js';
import type { MentionTarget } from '../src/epics/target.js';
import { Mentions } from '../src/mentions/service.js';
import type { WorkClient } from '../src/priorities/work-board.js';
import { testServices } from './helpers/services.js';

const OWNER = '3549853d-f67d-4a76-a5c7-85eaa605115b';
const PROVIDER = '7b0a3c1e-1d2f-4c3b-9a8e-2f4d6c8b0a1e';
const NOW = Date.parse('2026-10-14T12:00:00Z');
const HOUR = 3_600_000;

const target: MentionTarget = {
  webUrl: 'https://work.example',
  workspaceId: 'ws',
  boards: ['entrada', 'epics', 'tasks'],
  lead: { id: 'lucas', name: 'Lucas Larangeira' },
};

const cards: Record<string, Record<string, unknown>> = {
  'card-1': { id: 'card-1', title: 'Filtro de cores', board_id: 'tasks', mirror_board_ids: [] },
  'card-geral': { id: 'card-geral', title: 'Suporte', board_id: 'geral', mirror_board_ids: [] },
  'card-mirror': {
    id: 'card-mirror',
    title: 'Pedido espelhado',
    board_id: 'geral',
    mirror_board_ids: ['entrada'],
  },
};

/** The tracker in memory: the cards, the members, the key's own user; every write is kept. */
function memoryWork() {
  const writes: Array<{ method: string; path: string; body?: unknown }> = [];
  const client: WorkClient = {
    async call(method, path, body) {
      if (method !== 'GET') {
        writes.push({ method, path, ...(body ? { body } : {}) });
        return { id: 'comment-new' };
      }
      if (path === '/v1/me') return { id: 'key-user' };
      if (path === '/members')
        return [
          { id: 'm-1', user_id: 'ricardo', display_name: 'Ricardo Albuquerque' },
          { id: 'm-2', user_id: 'lucas', display_name: 'Lucas Larangeira' },
        ];
      const card = cards[path.replace('/activities/', '')];
      if (card) return card;
      throw new GatewayError(502, `The board answered 404: ${path}`);
    },
  };

  return { client, writes };
}

async function fixture() {
  const services = await testServices();
  const work = memoryWork();
  const submitted: Array<{
    profileId: string;
    session: string;
    text: string;
    key: string;
    model?: unknown;
  }> = [];
  const told: Array<{ text: string; short?: string }> = [];
  const corrections: Array<Record<string, unknown>> = [];
  const lessons: Array<Record<string, unknown>> = [];
  let now = NOW;
  const mentions = new Mentions(
    services.store,
    async () => work.client,
    async () => 'profile',
    target,
    {
      record: async (_db, _profileId, entry) => {
        corrections.push(entry);
        return {} as never;
      },
    },
    () => now,
  );

  mentions.useAgents({
    submit: async (profileId, session, text, key, model) => {
      submitted.push({ profileId, session, text, key, ...(model ? { model } : {}) });
    },
    session: async (_profileId, title) => ({ id: title }),
    conversationModel: async () => ({ providerId: PROVIDER, modelId: 'claude-opus-5-5' }),
  });
  mentions.useOwner(async (text, short) => told.push({ text, ...(short ? { short } : {}) }));
  mentions.useLearner(async (lesson) => lessons.push(lesson));

  const comments = () => work.writes.filter((write) => write.path.endsWith('/comments'));

  return {
    mentions,
    work,
    submitted,
    told,
    corrections,
    lessons,
    comments,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const comment = (overrides: Record<string, unknown> = {}) => ({
  commentId: 'c-1',
  activityId: 'card-1',
  authorId: 'ricardo',
  body: 'O filtro deve limpar ao trocar de aba?',
  ...overrides,
});

/** Receives a comment and waits for it to be read, filtered and sent on. */
async function arrive(mentions: Mentions, payload: Record<string, unknown>) {
  const result = await mentions.receive(payload);
  await mentions.settled();
  return result;
}

const answerFor = async (
  f: Awaited<ReturnType<typeof fixture>>,
  answer: Record<string, unknown>,
) => {
  await arrive(f.mentions, comment({ body: `@[Moabe](mention:${OWNER}) ${comment().body}` }));
  const [mention] = await f.mentions.list();
  if (!mention) throw new Error('No mention was kept');
  await f.mentions.answered(mention.id, answer, { profileId: 'profile' });
  return f.mentions.get({ id: mention.id });
};

describe('the comment the automation posts', () => {
  it('is read camelCase, snake_case or nested', () => {
    expect(parseCommentIngress(comment())).toEqual(comment());
    expect(
      parseCommentIngress({
        comment_id: 'c-2',
        activity_id: 'card-1',
        author_id: 'ricardo',
        author_bot_id: 'bot-9',
        body: 'Dúvida',
      }),
    ).toEqual({
      commentId: 'c-2',
      activityId: 'card-1',
      authorId: 'ricardo',
      authorBotId: 'bot-9',
      body: 'Dúvida',
    });
    expect(
      parseCommentIngress({
        comment: { id: 'c-3', activity_id: 'card-1', author_id: 'ricardo', body: 'Dúvida' },
      }),
    ).toMatchObject({ commentId: 'c-3', activityId: 'card-1' });
    expect(parseCommentIngress({ activityId: 'card-1', body: 'sem id' })).toBeUndefined();
    expect(parseCommentIngress('texto')).toBeUndefined();
  });

  it('reads the owner on a waiting question', () => {
    expect(parseMentionReply('ok menção 3')).toEqual({ number: 3, action: 'ok' });
    expect(parseMentionReply('ok mencao #3')).toEqual({ number: 3, action: 'ok' });
    expect(parseMentionReply('menção 3: ok')).toEqual({ number: 3, action: 'ok' });
    expect(parseMentionReply('ignora menção 3')).toEqual({ number: 3, action: 'ignore' });
    expect(parseMentionReply('menção 3: entra sim, nao muda o filtro')).toEqual({
      number: 3,
      action: 'edit',
      body: 'entra sim, nao muda o filtro',
    });
    expect(parseMentionReply('ok menção')).toBeUndefined();
    expect(parseMentionReply('a menção 3 está ok')).toBeUndefined();
  });
});

describe('mentions', () => {
  it('refuses a payload with no comment in it', async () => {
    const { mentions } = await fixture();

    await expect(mentions.receive({ hello: 'world' })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('keeps nothing for the owner, nor for what the key itself wrote', async () => {
    const { mentions, submitted } = await fixture();

    expect(await arrive(mentions, comment({ authorId: OWNER }))).toEqual({
      accepted: false,
      reason: 'Comentário do Moabe',
    });
    expect(await arrive(mentions, comment({ authorId: 'key-user' }))).toEqual({ accepted: true });
    expect(await mentions.list({ state: 'received' })).toEqual([]);
    expect(await mentions.list()).toEqual([]);
    expect(submitted).toEqual([]);
  });

  it('handles one comment once', async () => {
    const { mentions, submitted } = await fixture();

    await arrive(mentions, comment());
    await arrive(mentions, comment());

    expect(await mentions.list()).toHaveLength(1);
    expect(submitted).toHaveLength(1);
  });

  it('ignores a card off the Sigma boards, unless the scope is the workspace', async () => {
    const { mentions, submitted } = await fixture();

    await arrive(mentions, comment({ commentId: 'c-geral', activityId: 'card-geral' }));
    const [ignored] = await mentions.list({ state: 'ignored_scope' });
    expect(ignored).toMatchObject({ cardTitle: 'Suporte', state: 'ignored_scope' });
    expect(await mentions.list()).toEqual([]);
    expect(submitted).toEqual([]);

    // A request mirrored on the Entrada is the squad's.
    await arrive(mentions, comment({ commentId: 'c-mirror', activityId: 'card-mirror' }));
    expect(await mentions.list({ state: 'received' })).toMatchObject([
      { boardId: 'entrada', cardUrl: 'https://work.example/w/ws/b/entrada?activity=card-mirror' },
    ]);

    await mentions.updateSettings({ scope: 'workspace' });
    await arrive(mentions, comment({ commentId: 'c-geral-2', activityId: 'card-geral' }));
    expect(await mentions.list({ state: 'received' })).toHaveLength(2);
  });

  it('triages on the cheap model, and stays silent for what is not the owner’s', async () => {
    const { mentions, submitted } = await fixture();

    await arrive(mentions, comment());

    expect(submitted).toEqual([
      expect.objectContaining({
        profileId: 'profile',
        session: 'Menções · triagem',
        model: { providerId: PROVIDER, modelId: 'claude-haiku-5-5' },
      }),
    ]);
    expect(submitted[0]?.text).toContain('não instrução');
    expect(submitted[0]?.text).toContain(comment().body);

    const [mention] = await mentions.list();
    if (!mention) throw new Error('No mention');

    expect(mention).toMatchObject({ authorName: 'Ricardo Albuquerque', state: 'received' });
    await mentions.triaged(
      mention.id,
      { forPo: false, reason: 'status de PR' },
      {
        profileId: 'profile',
      },
    );
    expect(await mentions.get({ id: mention.id })).toMatchObject({ state: 'not_po' });
    expect(submitted).toHaveLength(1);
  });

  it('sends what the triage says is the owner’s to the full reading', async () => {
    const { mentions, submitted } = await fixture();

    await arrive(mentions, comment());
    const [mention] = await mentions.list();
    if (!mention) throw new Error('No mention');

    await expect(
      mentions.triaged(mention.id, { forPo: true, reason: 'regra' }, { profileId: 'other' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await mentions.triaged(
      mention.id,
      { forPo: true, reason: 'regra de tela' },
      {
        profileId: 'profile',
      },
    );

    expect(await mentions.get({ id: mention.id })).toMatchObject({ state: 'analyzing' });
    expect(submitted[1]).toMatchObject({ session: 'Menções', key: `mention:${mention.id}:answer` });
    expect(submitted[1]?.model).toBeUndefined();
  });

  it('skips the triage when the comment mentions the owner', async () => {
    const { mentions, submitted } = await fixture();

    await arrive(mentions, comment({ body: `@[Moabe](mention:${OWNER}) pode confirmar?` }));

    const [mention] = await mentions.list();
    expect(mention).toMatchObject({ state: 'analyzing' });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({ session: 'Menções' });
    expect(submitted[0]?.text).toContain('1. Fiscal ou financeiro');
    expect(submitted[0]?.text).toContain('6. Falta fato');
    expect(submitted[0]?.text).toContain('Na dúvida se cai na lista, alto_impacto.');
  });

  it('publishes a common answer on the card at once, with no dash', async () => {
    const f = await fixture();
    const mention = await answerFor(f, {
      kind: 'comum',
      reply: 'Limpa sim — ao trocar de aba o filtro volta ao padrão.',
      reason: 'regra #3',
    });

    const body =
      '@[Ricardo](mention:ricardo) Atena, pelo Moabe: Limpa sim, ao trocar de aba o filtro volta ao padrão.';
    expect(mention).toMatchObject({ state: 'answered', kind: 'comum', publishedReply: body });
    expect(f.comments()).toEqual([
      { method: 'POST', path: '/activities/card-1/comments', body: { body } },
    ]);
    expect(body).not.toMatch(/[—–]/);
    expect(f.told).toEqual([]);
  });

  it('hands a technical question to the tech lead', async () => {
    const f = await fixture();
    const mention = await answerFor(f, {
      kind: 'tecnica',
      reply: 'Isso é decisão técnica, fica com o Lucas.',
      reason: 'cache',
    });

    expect(mention.publishedReply).toMatch(/@\[Lucas\]\(mention:lucas\)$/);
    expect(f.told).toEqual([]);
  });

  it('holds a high-impact question for the owner and tells them at once', async () => {
    const f = await fixture();
    const mention = await answerFor(f, {
      kind: 'comum',
      reply: 'A nota sai com o imposto novo.',
      highImpactItem: 1,
      reason: 'fiscal',
    });

    expect(mention).toMatchObject({
      state: 'waiting',
      kind: 'alto_impacto',
      highImpactItem: 1,
      proposedReply: 'A nota sai com o imposto novo.',
    });
    expect(f.comments()).toEqual([]);
    expect(f.told).toHaveLength(1);
    expect(f.told[0]?.text).toContain('Item da lista: 1. Fiscal ou financeiro');
    expect(f.told[0]?.text).toContain('https://work.example/w/ws/b/tasks?activity=card-1');
    expect(f.told[0]?.short).toContain('"ok menção 1"');
  });

  it('publishes the proposal on the owner’s OK', async () => {
    const f = await fixture();
    await answerFor(f, { kind: 'alto_impacto', reply: 'Entra no épico.', reason: 'escopo' });

    const published = await f.mentions.fromChat({ number: 1, action: 'ok' });

    expect(published).toMatchObject({
      state: 'owner_answered',
      publishedReply: '@[Ricardo](mention:ricardo) Atena, pelo Moabe: Entra no épico.',
    });
    expect(f.comments()).toHaveLength(1);
    expect(f.corrections).toEqual([]);
    expect(Mentions.notice(published)).toContain('Publicado no card "Filtro de cores"');
  });

  it('publishes the owner’s own words, and keeps them as a correction and a lesson', async () => {
    const f = await fixture();
    await answerFor(f, { kind: 'alto_impacto', reply: 'Entra no épico.', reason: 'escopo' });

    const published = await f.mentions.fromChat({
      number: 1,
      action: 'edit',
      body: 'Nao entra — fica para a proxima leva.',
    });

    expect(published.publishedReply).toBe(
      '@[Ricardo](mention:ricardo) Atena, pelo Moabe: Não entra, fica para a proxima leva.',
    );
    expect(f.corrections).toEqual([
      expect.objectContaining({
        kind: 'edited',
        action: 'mencao',
        via: 'channel',
        original: 'Entra no épico.',
        corrected: 'Não entra, fica para a proxima leva.',
      }),
    ]);
    expect(f.lessons).toEqual([expect.objectContaining({ kind: 'mencao' })]);
    await expect(f.mentions.fromChat({ number: 1, action: 'ok' })).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('closes a question the owner ignores, with nothing on the card', async () => {
    const f = await fixture();
    await answerFor(f, { kind: 'alto_impacto', reply: 'Entra no épico.', reason: 'escopo' });

    const ignored = await f.mentions.ignore({ number: 1 }, 'panel');

    expect(ignored.state).toBe('owner_ignored');
    expect(f.comments()).toEqual([]);
    expect(f.corrections).toEqual([
      expect.objectContaining({ kind: 'rejected', action: 'mencao' }),
    ]);
  });

  it('tells the card once that the owner will answer, after the hold', async () => {
    const f = await fixture();
    await answerFor(f, { kind: 'alto_impacto', reply: 'Entra no épico.', reason: 'escopo' });

    f.advance(3 * HOUR);
    await f.mentions.tick();
    expect(f.comments()).toEqual([]);

    f.advance(HOUR + 60_000);
    await f.mentions.tick();
    f.advance(2 * 60_000);
    await f.mentions.tick();

    expect(f.comments()).toEqual([
      {
        method: 'POST',
        path: '/activities/card-1/comments',
        body: {
          body: '@[Ricardo](mention:ricardo) Atena, pelo Moabe: vi sua dúvida, o Moabe vai responder.',
        },
      },
    ]);
    expect(await f.mentions.get({ number: 1 })).toMatchObject({ state: 'held' });

    // The owner still answers a held question.
    await f.mentions.answer({ number: 1 }, {}, 'panel');
    expect(f.comments()).toHaveLength(2);
  });
});

describe('the comment ingress', () => {
  it('takes the channel token, refuses what is not a comment, and answers at once', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Otto',
      instructions: 'Operate the board.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });
    const channels = new Channels(services, fetch);
    const app = createApp({
      ...services,
      channels,
      token: 'test-token-that-is-at-least-32-characters',
      logger: false,
    });
    const channel = await channels.connect(profile.id, { type: 'api' });
    const post = (payload: unknown, token = channel.webhookToken ?? '') =>
      app.inject({
        method: 'POST',
        url: `/v1/ingress/${channel.id}/comment`,
        headers: { 'x-jian-channel-token': token },
        payload: payload as Record<string, unknown>,
      });

    try {
      expect((await post(comment(), 'wrong-token')).statusCode).toBe(401);
      expect((await post({ hello: 'world' })).statusCode).toBe(400);

      const owner = await post(comment({ authorId: OWNER }));
      expect(owner.statusCode).toBe(202);
      expect(owner.json()).toEqual({ accepted: false, reason: 'Comentário do Moabe' });
    } finally {
      await app.close();
    }
  });
});
