import { parseValidationCommentReply, parseValidationReply } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import type { WorkClient } from '../src/priorities/work-board.js';
import { doneWhen, Validations, type ValidationTarget } from '../src/validations/service.js';
import { testServices } from './helpers/services.js';

const target: ValidationTarget = {
  webUrl: 'https://work.example',
  workspaceId: 'ws',
  boardId: 'epics',
  todoStatusId: 'todo',
  teamId: 'sigma',
  requesterFieldId: 'solicitante',
  requester: '3433',
  prototypeFieldId: 'prototipo',
  labels: { bugfix: 'label-bugfix' },
  tasksBoardId: 'tasks',
  awaitingLabel: 'awaiting',
  returnedLabel: 'returned',
  previewFieldId: 'preview',
  acceptedStatusId: 'accepted',
  lead: { id: 'lucas', name: 'Lucas Larangeira' },
};

const epic = {
  id: 'epic-1',
  title: '[EPIC] Hardware: filtrar cores',
  version: 3,
  created_at: '2026-10-01T12:00:00Z',
  updated_at: '2026-10-09T12:00:00Z',
  labels: [{ id: 'awaiting', name: 'stts::awaiting-po' }],
  description:
    '## Hoje\nSem filtro.\n## Pronto quando\n- O usuário filtra por situação.\n- A busca acha a cor pelo nome.',
  custom_field_values: [{ field_id: 'preview', value: 'https://pr-12.preview.dev' }],
};

/** The board as answers per path; every write is recorded. */
function memoryBoard(returned: Array<Record<string, unknown>> = []) {
  const writes: Array<{ method: string; path: string; body?: unknown }> = [];
  const client: WorkClient = {
    async call(method, path, body) {
      if (method !== 'GET') {
        writes.push({ method, path, ...(body ? { body } : {}) });
        if (path === '/activities') return { id: 'return-1', version: 1 };
        if (path.endsWith('/boards')) return { version: 1 };
        return { version: 2 };
      }
      if (path === '/boards/epics/activities') return [epic];
      if (path === '/boards/tasks/activities') return returned;
      if (path === '/activities/epic-1') return epic;
      if (path === '/activities/epic-1/subtasks')
        return [{ id: 'task-1', title: 'Filtrar a listagem', labels: [], assignee_id: 'ricardo' }];
      if (path === '/members')
        return [
          { id: 'm-1', user_id: 'ricardo', display_name: 'Ricardo Albuquerque' },
          { id: 'm-2', user_id: 'lucas', display_name: 'Lucas Larangeira' },
        ];
      if (path.endsWith('/comments'))
        return [{ body: 'Todos os CAs passaram.', created_at: '2026-10-09T13:00:00Z' }];
      if (path.endsWith('/checklist')) return [{ text: 'CA-1 (RN-1): filtra', done: true }];
      if (path.startsWith('/activities/return-'))
        return path.endsWith('/relationships')
          ? { relationships: [] }
          : {
              id: 'return-9',
              title: 'Ajustar o filtro',
              description: 'Hoje: não filtra.',
              labels: [{ id: 'returned', name: 'type::returned' }],
            };
      if (path.includes('/activities/column')) return { items: [{ id: 'other', version: 4 }] };
      return {};
    },
  };

  return { client, writes };
}

async function fixture(returned: Array<Record<string, unknown>> = []) {
  const services = await testServices();
  const board = memoryBoard(returned);
  const told: string[] = [];
  const corrections: Array<Record<string, unknown>> = [];
  const validations = new Validations(
    services.store,
    async () => board.client,
    async () => 'profile',
    target,
    {
      record: async (_db, _profileId, entry) => {
        corrections.push(entry);
        return {} as never;
      },
    },
  );
  validations.useOwner(async (text) => told.push(text));

  return { validations, board, told, corrections };
}

const comments = (writes: Array<{ path: string; body?: unknown }>) =>
  writes.filter((write) => write.path === '/activities/epic-1/comments');

describe('the owner reply', () => {
  it('reads approval and refusal, with or without the number', () => {
    expect(parseValidationReply('aprovado')).toEqual({ approved: true });
    expect(parseValidationReply('validação 3: reprovada, o filtro não limpa')).toEqual({
      number: 3,
      approved: false,
      reason: 'o filtro não limpa',
    });
    expect(parseValidationReply('reprovado 2: falta a busca')).toEqual({
      number: 2,
      approved: false,
      reason: 'falta a busca',
    });
    expect(parseValidationReply('o épico foi aprovado ontem')).toBeUndefined();
    expect(parseValidationReply('reprovado 6: testei e nao funcionou')).toEqual({
      number: 6,
      approved: false,
      reason: 'testei e nao funcionou',
    });
  });

  it('reads a refusal that asks for a return card', () => {
    expect(parseValidationReply('reprovado 6 com retorno: o print não entra')).toEqual({
      number: 6,
      approved: false,
      reason: 'o print não entra',
      withReturn: true,
    });
    expect(parseValidationReply('Reprovada com retorno: falta a busca')).toEqual({
      approved: false,
      reason: 'falta a busca',
      withReturn: true,
    });
    expect(parseValidationReply('aprovado 2')).toEqual({ number: 2, approved: true });
  });

  it('reads the owner on a comment draft', () => {
    expect(parseValidationCommentReply('ok comentario 6')).toEqual({ number: 6 });
    expect(parseValidationCommentReply('ok comentário #6')).toEqual({ number: 6 });
    expect(parseValidationCommentReply('publica 6')).toEqual({ number: 6 });
    expect(parseValidationCommentReply('comentario 6: @Ricardo olha o print')).toEqual({
      number: 6,
      body: '@Ricardo olha o print',
    });
    expect(parseValidationCommentReply('ok 6')).toBeUndefined();
    expect(parseValidationCommentReply('comentario 6:')).toBeUndefined();
  });

  it('turns the done-when section into items', () => {
    expect(doneWhen(epic.description)).toEqual([
      'O usuário filtra por situação.',
      'A busca acha a cor pelo nome.',
    ]);
  });
});

describe('validations', () => {
  it('opens a check for a ready epic once, and tells the owner', async () => {
    const { validations, told } = await fixture();

    expect((await validations.scan()).prepared).toEqual([1]);
    expect((await validations.scan()).prepared).toEqual([]);

    const [check] = await validations.list();
    expect(check).toMatchObject({
      epicTitle: epic.title,
      previewUrl: 'https://pr-12.preview.dev',
      items: [
        { text: 'O usuário filtra por situação.' },
        { text: 'A busca acha a cor pelo nome.' },
      ],
      tasks: [{ id: 'task-1', checklist: [{ text: 'CA-1 (RN-1): filtra', done: true }] }],
      state: 'aberta',
    });
    expect(check?.notes[0]).toContain('Todos os CAs passaram.');
    expect(told).toHaveLength(1);
  });

  it('closes the check of an epic that reached Aceito, quietly, and never opens one for it', async () => {
    const { validations, board } = await fixture();

    await validations.scan();
    expect((await validations.list())[0]?.state).toBe('aberta');

    Object.assign(epic, { status_id: 'accepted' });
    try {
      await (validations as unknown as { look(): Promise<unknown> }).look();
      const checks = await validations.list();

      expect(checks).toHaveLength(1);
      expect(checks[0]?.state).toBe('aprovada');
      expect(board.writes).toEqual([]);
    } finally {
      Object.assign(epic, { status_id: undefined });
    }
  });

  it('comments the approval on the epic', async () => {
    const { validations, board } = await fixture();
    await validations.scan();

    const answered = await validations.answer(
      { number: 1 },
      { items: [{ result: 'passou' }, { result: 'passou' }] },
      'panel',
    );

    expect(answered).toMatchObject({
      state: 'aprovada',
      commented: true,
      returns: [],
      comment: { state: 'publicado', body: 'Aprovado na validação do PO.' },
    });
    expect(comments(board.writes)).toEqual([
      {
        method: 'POST',
        path: '/activities/epic-1/comments',
        body: { body: 'Aprovado na validação do PO.' },
      },
    ]);
  });

  it('keeps the approval short, with the owner note and without the done-when', async () => {
    const { validations, board } = await fixture();
    await validations.scan();

    await validations.fromChat({ number: 1, approved: true });
    const { validations: other, board: second } = await fixture();
    await other.scan();
    await other.answer(
      { number: 1 },
      { items: [{ result: 'passou' }, { result: 'passou' }], note: 'Ficou ótimo no celular.' },
      'panel',
    );

    expect(comments(board.writes)[0]?.body).toEqual({ body: 'Aprovado na validação do PO.' });
    expect(comments(second.writes)[0]?.body).toEqual({
      body: 'Aprovado na validação do PO.\n\nFicou ótimo no celular.',
    });
  });

  it('drafts the refusal comment for the owner and writes nothing on the board', async () => {
    const original = epic.description;
    epic.description = '## Pronto quando\n- No preview: abrir um documento e colar um print.';
    try {
      const { validations, board } = await fixture();
      await validations.scan();

      const refused = await validations.fromChat({
        number: 1,
        approved: false,
        reason: 'testei e nao funcionou',
      });

      expect(board.writes).toEqual([]);
      expect(refused).toMatchObject({ state: 'reprovada', commented: false, returns: [] });
      expect(refused?.comment).toEqual({
        state: 'rascunho',
        body: '@[Ricardo](mention:ricardo) @[Lucas](mention:lucas) testei e não funcionou. Podem dar uma olhada? Quando subir a correção, valido de novo.',
      });
      expect(refused?.comment?.body).not.toContain('Pronto quando');
      expect(refused?.comment?.body).not.toContain('colar um print');
      expect(refused?.comment?.body).not.toContain(' — ');
      expect(Validations.notice(refused as never)).toContain('ok comentario 1');
    } finally {
      epic.description = original;
    }
  });

  it('publishes the draft on "ok comentario"', async () => {
    const { validations, board, corrections } = await fixture();
    await validations.scan();
    await validations.answer(
      { number: 1 },
      { items: [{ result: 'passou' }, { result: 'falhou', reason: 'a busca ignora acento' }] },
      'panel',
    );
    const drafted = (await validations.get({ number: 1 })).comment?.body;

    expect(drafted).toBe(
      '@[Ricardo](mention:ricardo) @[Lucas](mention:lucas) testei no preview e a busca ignora acento. Podem dar uma olhada? Quando subir a correção, valido de novo.',
    );

    const published = await validations.commentFromChat(
      parseValidationCommentReply('ok comentario 1') as { number: number },
    );

    expect(published).toMatchObject({ commented: true, comment: { state: 'publicado' } });
    expect(comments(board.writes)).toEqual([
      { method: 'POST', path: '/activities/epic-1/comments', body: { body: drafted } },
    ]);
    expect(corrections).toEqual([]);
    await expect(validations.commentFromChat({ number: 1 })).rejects.toThrow('no comment draft');
  });

  it('publishes the owner words instead of the draft, as a correction', async () => {
    const { validations, board, corrections } = await fixture();
    await validations.scan();
    await validations.fromChat({ number: 1, approved: false, reason: 'o filtro não limpa' });

    const text = '@[Ricardo](mention:ricardo) o filtro não limpa ao trocar de aba, olha o print.';
    const published = await validations.commentFromChat(
      parseValidationCommentReply(`comentario 1: ${text}`) as { number: number; body: string },
    );

    expect(published.comment).toMatchObject({ state: 'publicado', body: text });
    expect(comments(board.writes)[0]?.body).toEqual({ body: text });
    expect(corrections).toEqual([
      expect.objectContaining({
        kind: 'edited',
        via: 'channel',
        action: 'validacao',
        corrected: text,
      }),
    ]);
  });

  it('discards the draft from the panel, with nothing on the board', async () => {
    const { validations, board } = await fixture();
    await validations.scan();
    const refused = await validations.fromChat({ number: 1, approved: false, reason: 'x' });

    const discarded = await validations.discardComment(refused?.id ?? '');

    expect(discarded.comment?.state).toBe('descartado');
    expect(comments(board.writes)).toEqual([]);
  });

  it('takes a refusal from the chat once, on the item it is about', async () => {
    const { validations } = await fixture();
    await validations.scan();

    const refused = await validations.fromChat({
      number: 1,
      approved: false,
      reason: 'a busca ignora acento',
    });

    expect(refused?.items.map((item) => item.text)).toEqual([
      'O usuário filtra por situação.',
      'A busca acha a cor pelo nome.',
      'Reprovado pelo PO no chat',
    ]);
    await expect(
      validations.fromChat({ number: 1, approved: false, reason: 'de novo' }),
    ).rejects.toThrow('already reprovada');
    expect((await validations.get({ number: 1 })).items).toHaveLength(3);
  });

  it('drafts a return card only when the chat refusal asks for one', async () => {
    const original = epic.description;
    epic.description = '## Pronto quando\n- O usuário filtra por situação.';
    try {
      const { validations, board } = await fixture();
      await validations.scan();

      const refused = await validations.fromChat(
        parseValidationReply('reprovado 1 com retorno: o filtro não aparece') as {
          approved: boolean;
        },
      );

      expect(board.writes).toEqual([]);
      expect(refused?.returns).toHaveLength(1);
      expect(refused?.returns[0]?.state).toBe('rascunho');

      expect(refused?.items).toEqual([
        {
          text: 'O usuário filtra por situação.',
          result: 'falhou',
          reason: 'o filtro não aparece',
        },
      ]);
      expect(refused?.returns[0]?.description).toContain(
        '**Esperado:** O usuário filtra por situação.',
      );
    } finally {
      epic.description = original;
    }
  });

  it('turns a failed item into a return card, created and mirrored on top of the tasks', async () => {
    const { validations, board } = await fixture();
    await validations.scan();

    const answered = await validations.answer(
      { number: 1 },
      { items: [{ result: 'passou' }, { result: 'falhou', reason: 'a busca ignora acento' }] },
      'panel',
    );

    expect(answered.state).toBe('reprovada');
    expect(answered.returns).toEqual([]);

    const asked = await validations.draftReturns({ id: answered.id });

    expect(asked.returns[0]).toMatchObject({
      taskId: 'task-1',
      label: 'bugfix',
      state: 'rascunho',
      criteria: ['CA-1 (RN-1): A busca acha a cor pelo nome.', 'make test-web passa'],
    });
    expect(asked.returns[0]?.description).toContain('**Aconteceu:** a busca ignora acento');

    const created = await validations.createReturn(answered.id, 0);

    expect(created.returns[0]).toMatchObject({ state: 'criado', workId: 'return-1' });
    expect(board.writes).toContainEqual({
      method: 'POST',
      path: '/activities',
      body: expect.objectContaining({
        parent_id: 'epic-1',
        label_ids: ['returned', 'label-bugfix'],
      }),
    });
    expect(board.writes).toContainEqual({
      method: 'POST',
      path: '/activities/return-1/relationships',
      body: { relation_type: 'depends_on', target_id: 'task-1' },
    });
    expect(board.writes).toContainEqual({
      method: 'POST',
      path: '/activities/return-1/boards',
      body: { board_id: 'tasks' },
    });
    expect(board.writes).toContainEqual({
      method: 'POST',
      path: '/activities/return-1/boards/tasks/move',
      body: expect.objectContaining({ before_activity_id: null, after_activity_id: 'other' }),
    });
  });

  it('checks the tester returns that appear after the first look', async () => {
    const returned = [{ id: 'return-8', labels: [{ id: 'returned', name: 'type::returned' }] }];
    const { validations, told } = await fixture(returned);

    await validations.scan();
    returned.push({ id: 'return-9', labels: [{ id: 'returned', name: 'type::returned' }] });
    told.length = 0;
    await validations.scan();

    expect(told[0]).toContain('Retorno do Tester fora do modelo: "Ajustar o filtro"');
    expect(told[0]).not.toContain('return-8');
  });
});

describe('two looks at once', () => {
  it('open a check only once', async () => {
    const { validations } = await fixture();

    await Promise.all([validations.scan(), validations.scan()]);

    expect(await validations.list()).toHaveLength(1);
  });
});
