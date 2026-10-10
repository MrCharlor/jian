import { describe, expect, it } from 'vitest';
import { lintDraft } from '../src/epics/lint.js';
import { Epics } from '../src/epics/service.js';
import type { EpicTarget } from '../src/epics/target.js';
import type { WorkClient } from '../src/priorities/work-board.js';
import { testServices } from './helpers/services.js';

const epicText = [
  '## Hoje',
  'A listagem de cores não tem filtro.',
  '## Esperado',
  'Filtrar por situação.',
  '## Decisões',
  'Abre em Todos.',
  '## Ordem de execução',
  '1. Serviço. 2. Tela.',
  '## Pronto quando',
  'O usuário filtra as cores por situação.',
].join('\n');

const taskText = [
  '## Contexto',
  'Cores descrevem o aparelho na OS.',
  '## Hoje',
  'Não existe filtro.',
  '## Regras de negócio',
  '1. **RN-1**: o filtro Situação tem Todos, Ativos e Inativos.',
  '## Referências técnicas',
  '- Tela: /hardware/cores-de-aparelhos',
].join('\n');

const draft = {
  title: '[EPIC] Hardware: filtrar as cores de aparelhos por situação',
  label: 'feature' as const,
  description: epicText,
  prototypeUrl: 'https://claude.ai/artifact/Eg6VkSHNf9qx8UZz9E5eZF',
  requestWorkId: 'pedido-1',
  tasks: [
    {
      title: 'Filtrar a listagem de cores por situação',
      label: 'feature' as const,
      description: taskText,
      criteria: ['CA-1 (RN-1): Ativos mostra só as cores ativas', 'CA-2: make test-web passa'],
    },
  ],
};

const target: EpicTarget = {
  webUrl: 'https://work.example',
  workspaceId: 'ws',
  boardId: 'epics',
  todoStatusId: 'todo',
  teamId: 'sigma',
  requesterFieldId: 'solicitante',
  requester: '3433',
  prototypeFieldId: 'prototipo',
  labels: { feature: 'label-feature' },
  lead: { id: 'lucas', name: 'Lucas Larangeira' },
};

/** The board as a list of calls; one path can be made to fail once. */
function memoryBoard() {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  let next = 0;
  let failOnce: string | undefined;
  const client: WorkClient = {
    async call(method, path, body) {
      if (failOnce && path.includes(failOnce)) {
        failOnce = undefined;
        throw new Error('board down');
      }
      calls.push({ method, path, ...(body ? { body: body as Record<string, unknown> } : {}) });
      if (method === 'POST' && path === '/activities') return { id: `card-${++next}`, version: 1 };
      if (method === 'PATCH') return { version: 2 };
      return {};
    },
  };

  return {
    client,
    calls,
    fail: (path: string) => {
      failOnce = path;
    },
  };
}

async function fixture() {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Subaru',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Épico' });
  const pauta = await services.pautas.create({ title: 'Cores de Aparelhos' });
  const board = memoryBoard();
  const epics = new Epics(
    services.store,
    async () => board.client,
    async () => profile.id,
    target,
    fetch,
    services.quality,
  );
  epics.useAgents({
    remember: (profileId, key, content) =>
      services.memories.remember(profileId, { key, content, expectedVersion: 0 }),
  });
  const by = { profileId: profile.id, sessionId: session.id, name: 'Subaru' };

  return { services, profile, pauta, board, epics, by };
}

describe('the owner rules on a draft', () => {
  it('passes a draft that follows them', () => {
    expect(lintDraft({ ...draft, images: [] })).toEqual([]);
  });

  it('names every rule a draft breaks', () => {
    const problems = lintDraft({
      title: 'Hardware: filtro',
      description: `${epicText.replace('O usuário filtra', 'make test-web passa e o usuário filtra')}\n## Fora do épico\nOutra coisa.\nAbre em Todos ou Ativos?`,
      tasks: [
        {
          title: 'Filtro de situação',
          description: `${taskText}\n2. **RN-2**: input técnico do TL pendente — ver depois.`,
          criteria: ['CA-1 (RN-1): Ativos mostra as ativas'],
        },
      ],
      images: [{ caption: 'Tela do Legado' }],
    });

    expect(problems).toEqual(
      expect.arrayContaining([
        'O título do épico não começa com "[EPIC] ".',
        'O épico tem "Fora do épico"; o que estiver fora vira card próprio.',
        'O "Pronto quando" do épico cita make test; isso vai no checklist das tasks.',
        'Há travessão no texto.',
        'Pergunta aberta: "Abre em Todos ou Ativos?".',
        'Task 1 ("Filtro de situação"): o título não começa com verbo no infinitivo.',
        'Task 1 ("Filtro de situação"): RN-2 não tem critério de aceite.',
        'Task 1 ("Filtro de situação"): o último critério não é o make test.',
      ]),
    );
    expect(problems.some((problem) => problem.includes('input técnico'))).toBe(true);
    expect(problems.some((problem) => problem.includes('tela antiga'))).toBe(true);
  });
});

describe('creating an epic on the board', () => {
  it('writes the epic, its tasks and criteria, links the request and tells the lead', async () => {
    const { epics, pauta, board, by } = await fixture();
    const drafted = await epics.draft({ ...draft, pautaId: pauta.id }, by);

    const created = await epics.create(drafted.id);
    const cards = board.calls.filter((call) => call.path === '/activities');

    expect(created).toMatchObject({
      state: 'criado',
      work: { epicId: 'card-1', taskIds: ['card-2'], linked: true, announced: true },
    });
    expect(cards[0]?.body).toMatchObject({
      board_id: 'epics',
      status_id: 'todo',
      label_ids: ['label-feature'],
      custom_field_values: [
        { field_id: 'solicitante', value: '3433' },
        { field_id: 'prototipo', value: draft.prototypeUrl },
      ],
    });
    expect(cards[1]?.body).toMatchObject({ parent_id: 'card-1' });
    expect(JSON.stringify(board.calls)).not.toContain('"App"');
    expect(board.calls).toContainEqual({
      method: 'PATCH',
      path: '/activities/card-1',
      body: { team_id: 'sigma', expected_version: 1 },
    });
    expect(
      board.calls
        .filter((call) => call.path === '/activities/card-2/checklist')
        .map((call) => call.body?.text),
    ).toEqual(draft.tasks[0]?.criteria);
    expect(board.calls).toContainEqual({
      method: 'POST',
      path: '/activities/pedido-1/relationships',
      body: { relation_type: 'depends_on', target_id: 'card-1' },
    });
    expect(
      board.calls.find((call) => call.path === '/activities/card-1/comments')?.body?.body,
    ).toContain('@[Lucas Larangeira](mention:lucas)');
  });

  it('tells the lead an integration test asks nothing of him', async () => {
    const { epics, pauta, board, by } = await fixture();
    const drafted = await epics.draft(
      { ...draft, title: `[TESTE DE INTEGRAÇÃO] ${draft.title} (pode apagar)`, pautaId: pauta.id },
      by,
    );

    await epics.create(drafted.id);

    const comment = board.calls.find((call) => call.path === '/activities/card-1/comments')?.body
      ?.body as string;
    expect(comment).toContain('@[Lucas Larangeira](mention:lucas)');
    expect(comment).toContain('teste de integração');
    expect(comment).not.toContain('espelhar as tasks');
  });

  it('goes on from where a create stopped, without making a card twice', async () => {
    const { epics, pauta, board, by } = await fixture();
    const drafted = await epics.draft({ ...draft, pautaId: pauta.id }, by);

    board.fail('/relationships');
    await expect(epics.create(drafted.id)).rejects.toThrow('board down');
    expect(await epics.get({ id: drafted.id })).toMatchObject({
      state: 'rascunho',
      error: 'board down',
      work: { epicId: 'card-1', taskIds: ['card-2'], linked: false },
    });

    await epics.create(drafted.id);

    expect(board.calls.filter((call) => call.path === '/activities')).toHaveLength(2);
  });

  it('counts what the owner changed as a correction the agent remembers', async () => {
    const { services, epics, pauta, profile, by } = await fixture();
    const drafted = await epics.draft({ ...draft, pautaId: pauta.id }, by);

    await epics.update(drafted.id, {
      title: '[EPIC] Hardware: filtrar e ordenar as cores de aparelhos',
    });
    await epics.create(drafted.id);

    const [row] = (await services.quality.report(profile.id)).filter(
      (item) => item.automation === 'epico',
    );
    expect(row?.lastCorrection).toMatchObject({
      kind: 'edited',
      note: 'O Moabe mudou: título do épico.',
    });
    expect((await services.memories.memories(profile.id)).map((memory) => memory.key)).toContain(
      'epico-1',
    );
  });
});
