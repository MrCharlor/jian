import { parseValidationReply } from '@jian/contracts';
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
        return [{ id: 'task-1', title: 'Filtrar a listagem', labels: [] }];
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
  const validations = new Validations(
    services.store,
    async () => board.client,
    async () => 'profile',
    target,
  );
  validations.useOwner(async (text) => told.push(text));

  return { validations, board, told };
}

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

  it('comments the approval on the epic', async () => {
    const { validations, board } = await fixture();
    await validations.scan();

    const answered = await validations.answer(
      { number: 1 },
      { items: [{ result: 'passou' }, { result: 'passou' }] },
      'panel',
    );

    expect(answered).toMatchObject({ state: 'aprovada', commented: true, returns: [] });
    const comment = board.writes.find((write) => write.path === '/activities/epic-1/comments');
    expect(JSON.stringify(comment?.body)).toContain('Aprovado na validação do PO');
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
    expect(answered.returns[0]).toMatchObject({
      taskId: 'task-1',
      label: 'bugfix',
      state: 'rascunho',
      criteria: ['CA-1 (RN-1): A busca acha a cor pelo nome.', 'make test-web passa'],
    });
    expect(answered.returns[0]?.description).toContain('**Aconteceu:** a busca ignora acento');

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
