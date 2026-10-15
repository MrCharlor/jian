import { HttpResponse, http } from 'msw';
import type {
  KnowledgeProposal,
  KnowledgeRule,
  KnowledgeSettings,
  Mention,
  MentionSettings,
  Plan,
  PlanSettings,
  PriorityProposal,
  RoadmapItem,
  RoadmapProposal,
  RoadmapSettings,
  Routines,
  Screen,
  Validation,
} from '../lib/api';
import { at } from './conversations';
import { ids } from './fixtures';

/**
 * The product owner's pages (Validações, Planos, Rotinas, Priorização, Telas, Conhecimento,
 * Roadmap) with believable work in them: long notes, long links, a plan with questions, a
 * refusal with its comment draft. Synthetic from end to end, like the rest of the fixtures.
 */
const id = (index: number) => `b21a0000-0000-4000-8000-${String(index).padStart(12, '0')}`;

const work = 'https://work.example.com/w/sistemas/b/epics?activity=';
const longPreview =
  'https://pr-1834-faturamento-filtro-por-loja-e-periodo.preview.dev.example.com/vendas/faturamento/listagem?loja=251&periodo=2026-10-01..2026-10-31&ordem=valor_desc';

export const validations: Validation[] = [
  {
    id: id(1),
    number: 14,
    epicWorkId: '88412',
    epicTitle: 'Faturamento: filtro por loja e período na listagem, com totais por loja no rodapé',
    epicUrl: `${work}88412`,
    previewUrl: longPreview,
    prototypeUrl: 'https://draw.example.com/prototipos/faturamento-filtro-loja-periodo/v3',
    pauta: 'Gestores não conseguem ver o faturamento de uma loja só',
    items: [
      { text: 'O filtro de loja lista só as lojas do usuário logado.' },
      {
        text: 'Ao escolher um período maior que 31 dias, a tela avisa e não carrega a listagem inteira de uma vez, para não travar o navegador em lojas com muito movimento.',
      },
      { text: 'O botão Limpar volta loja e período ao padrão (loja do usuário, mês atual).' },
    ],
    tasks: [
      { id: '88413', title: 'Filtro de loja e período na listagem', checklist: [] },
      { id: '88414', title: 'Totais por loja no rodapé', checklist: [] },
    ],
    notes: [
      'Tester (Ana): passei os três itens no preview com o usuário 3433 (251 BH Shopping). O filtro de loja mostrou só a 251, como esperado. Vou deixar registrado que, com período de 45 dias, o aviso apareceu, mas a listagem ainda carregou por trás do aviso e demorou uns 12 segundos; não sei se isso conta como falha do item 2 ou se é aceitável, então deixo para você decidir na validação. O Limpar funcionou.',
      'Lucas: subi o ajuste do rodapé no mesmo PR, os totais agora somam só as lojas filtradas.',
      'Tester (Ana): conferido o rodapé depois do ajuste, ok.',
    ],
    state: 'aberta',
    commented: false,
    returns: [],
    createdAt: at(60 * 5),
    updatedAt: at(60 * 2),
  },
  {
    id: id(2),
    number: 12,
    epicWorkId: '88290',
    epicTitle: 'Cores de Aparelhos: listagem com Exibição Dinâmica ao lado de Ocultar Filtro',
    epicUrl: `${work}88290`,
    previewUrl:
      'https://pr-1812-cores-de-aparelhos-exibicao-dinamica.preview.dev.example.com/cadastros/cores-de-aparelhos',
    pauta: 'Padronizar as listagens de cadastro do ERP',
    items: [
      {
        text: 'Exibição Dinâmica fica à direita, junto do Ocultar Filtro.',
        result: 'passou',
      },
      {
        text: 'As colunas escolhidas na Exibição Dinâmica ficam salvas ao voltar para a tela.',
        result: 'falhou',
        reason:
          'Escolhi só Nome e Código, saí para Marcas e voltei: as colunas voltaram todas. Repeti em aba anônima e aconteceu o mesmo.',
        taskId: '88291',
      },
    ],
    tasks: [{ id: '88291', title: 'Exibição Dinâmica na listagem de Cores', checklist: [] }],
    notes: ['Tester (Ana): passou nos dois itens no meu teste; não testei voltar de outra tela.'],
    state: 'reprovada',
    commented: false,
    comment: {
      state: 'rascunho',
      body: '@Lucas @Ana Reprovado no item 2: as colunas escolhidas na Exibição Dinâmica não ficam salvas. Escolhi só Nome e Código, saí para Marcas e voltei, e as colunas voltaram todas (também em aba anônima). O item 1 passou.',
    },
    returns: [],
    decidedVia: 'panel',
    decidedAt: at(60),
    createdAt: at(60 * 30),
    updatedAt: at(60),
  },
  {
    id: id(3),
    number: 11,
    epicWorkId: '88101',
    epicTitle: 'Tipos e Natureza: tela nova só de leitura',
    epicUrl: `${work}88101`,
    items: [{ text: 'A tela abre sem botões de gravar.', result: 'passou' }],
    tasks: [{ id: '88102', title: 'Tela de leitura', checklist: [] }],
    notes: [],
    state: 'aprovada',
    commented: true,
    comment: {
      state: 'publicado',
      body: 'Aprovado. A tela abre só para leitura, como combinado.',
      publishedAt: at(60 * 48),
    },
    returns: [],
    decidedVia: 'channel',
    decidedAt: at(60 * 48),
    createdAt: at(60 * 72),
    updatedAt: at(60 * 48),
  },
];

const reviewer = ids.miku;
const author = ids.zero;

const revisedPrototype = `## O que vou desenhar
Listagem de Faturamento no layout do erp-novo, com o filtro de loja e período no topo e a Exibição Dinâmica à direita, junto do Ocultar Filtro.

## De onde veio
- Pauta: gestores não conseguem ver o faturamento de uma loja só.
- Regra #12 (toda listagem do ERP): um filtro rápido só.
- Regra #31: até 5 lojas, linha por loja; acima, resumo.

## O que assumi
- O período padrão é o mês atual.
- O usuário logado é 3433 José Moabe (251 BH Shopping).

## Entrega
Três quadros: listagem, filtro aberto, rodapé com totais.`;

export const plans: Plan[] = [
  {
    id: id(11),
    number: 7,
    action: 'prototype',
    title: 'Faturamento: filtro por loja e período',
    application: 'erp-novo',
    authorProfileId: author,
    authorName: 'Zero Two',
    reviewerProfileId: reviewer,
    reviewerName: 'Miku',
    original: revisedPrototype.replace('Três quadros', 'Quatro quadros, um deles com gráfico'),
    revised: revisedPrototype,
    findings: [
      {
        kind: 'divergencia',
        text: 'O plano do autor previa um gráfico no topo da listagem; a regra #44 diz que listagem não tem quadros de indicadores no topo.',
        source: 'Regra #44 (toda listagem do ERP)',
      },
      {
        kind: 'lacuna',
        text: 'Não está dito se o rodapé soma só as lojas filtradas ou todas as lojas do usuário.',
        source: '',
      },
    ],
    questions: [
      'O rodapé soma só as lojas filtradas, ou todas as lojas do usuário mesmo com o filtro?',
      'Período maior que 31 dias: só avisa, ou bloqueia a busca até o usuário reduzir?',
      'O gestor com mais de 5 lojas vê o resumo já aberto ou recolhido?',
    ],
    rounds: 2,
    state: 'aguardando_po',
    note: 'Tirar o gráfico do topo; listagem não leva indicadores.',
    createdAt: at(60 * 6),
    updatedAt: at(40),
  },
  {
    id: id(12),
    number: 8,
    action: 'entry_sync',
    title: 'Entrada segue o épico (leitura das 9h)',
    authorProfileId: ids.ichigo,
    authorName: 'Ichigo',
    original: 'Dois movimentos e um pedido parado.',
    revised: 'Dois movimentos e um pedido parado. Nenhuma regra sensível.',
    entrySync: {
      moves: [
        {
          workId: '88412',
          title: 'Faturamento: filtro por loja e período na listagem',
          board: 'epics',
          from: 'Em andamento',
          to: 'Em revisão',
          fromStatusId: 's1',
          toStatusId: 's2',
          reason: 'todas as tasks estão em Aceito',
          url: `${work}88412`,
        },
        {
          workId: '77120',
          title: 'Pedido do suporte: relatório de faturamento por loja com período livre',
          board: 'entrada',
          from: 'Priorizado',
          to: 'Em desenvolvimento',
          fromStatusId: 's3',
          toStatusId: 's4',
          reason: 'o épico ligado entrou em andamento',
          url: 'https://work.example.com/w/sistemas/b/entrada-sigma?activity=77120&origem=suporte&referencia=chamado-2026-10-0451',
        },
      ],
      stale: [
        {
          workId: '76001',
          title: 'Ajustar impressão do pedido de compra',
          days: 23,
          url: 'https://work.example.com/w/sistemas/b/entrada-sigma?activity=76001',
        },
      ],
      skipped: [
        {
          workId: '77001',
          title: 'Cadastro de marcas',
          to: 'Concluído',
          reason: 'você recusou esse movimento no plano #5',
        },
      ],
      readAt: at(60 * 3),
    },
    findings: [],
    questions: [],
    rounds: 0,
    state: 'aguardando_po',
    createdAt: at(60 * 3),
    updatedAt: at(60 * 3),
  },
  {
    id: id(13),
    number: 6,
    action: 'priority',
    title: 'Ordem do Aprovado da semana 42',
    authorProfileId: ids.ichigo,
    authorName: 'Ichigo',
    reviewerProfileId: reviewer,
    reviewerName: 'Miku',
    priority: {
      number: 9,
      summary: 'Loja parada primeiro, depois o que o suporte marcou como urgente.',
      cards: [
        {
          workId: '77120',
          title: 'Relatório de faturamento por loja',
          reason: 'três lojas sem fechar o mês',
          raise: true,
        },
        { workId: '76001', title: 'Impressão do pedido de compra', raise: false },
      ],
    },
    revised: 'Ordem mantida; motivo do segundo card faltando.',
    findings: [],
    rounds: 1,
    state: 'em_revisao',
    createdAt: at(60 * 20),
    updatedAt: at(60 * 19),
  },
  {
    id: id(14),
    number: 4,
    action: 'prototype',
    title: 'Cores de Aparelhos',
    application: 'erp-novo',
    authorName: 'Zero Two',
    reviewerName: 'Miku',
    original: 'Listagem padrão.',
    revised: 'Listagem padrão, com Exibição Dinâmica.',
    findings: [],
    rounds: 1,
    state: 'executado',
    approvedBy: 'owner',
    executedAt: at(60 * 50),
    createdAt: at(60 * 70),
    updatedAt: at(60 * 50),
  },
];

const planSettings: Record<PlanSettings['action'], PlanSettings> = {
  prototype: {
    action: 'prototype',
    automatic: false,
    maxRounds: 2,
    authorProfileId: author,
    reviewerProfileId: reviewer,
    reviewerModel: { providerId: ids.anthropic, modelId: 'claude-opus-5-5' },
  },
  priority: { action: 'priority', automatic: false, maxRounds: 1, reviewerProfileId: reviewer },
  entry_sync: { action: 'entry_sync', automatic: true, maxRounds: 0 },
};

export const routines: Routines = {
  actions: [
    {
      action: 'prototype',
      automatic: false,
      reviewer: true,
      executed: 9,
      clean: 4,
      lastCorrectionAt: at(60 * 24 * 3),
    },
    { action: 'priority', automatic: false, reviewer: true, executed: 3, clean: 3 },
    { action: 'entry_sync', automatic: true, reviewer: false, executed: 12, clean: 12 },
  ],
  questionsPerWeek: [
    { week: '2026-09-21', plans: 4, questions: 15, average: 3.75 },
    { week: '2026-09-28', plans: 6, questions: 14, average: 2.33 },
    { week: '2026-10-05', plans: 5, questions: 7, average: 1.4 },
  ],
  waiting: plans.filter((plan) => plan.state === 'aguardando_po'),
  schedules: [
    {
      id: id(21),
      profileId: ids.zero,
      profileName: 'Zero Two',
      name: 'Olhar validações no Work',
      instruction: 'Traga os épicos com stts::awaiting-po.',
      sessionId: id(22),
      cron: '0 8-19 * * 1-5',
      timeZone: 'America/Sao_Paulo',
      enabled: true,
      nextRunAt: at(-30),
      lastRunAt: at(30),
      createdBy: 'owner',
      createdAt: at(60 * 24 * 20),
      updatedAt: at(60 * 24 * 2),
    },
    {
      id: id(23),
      profileId: ids.ichigo,
      profileName: 'Ichigo',
      name: 'Propor a ordem do Aprovado',
      instruction: 'Proponha a ordem da semana.',
      sessionId: id(24),
      cron: '0 8 * * 1',
      timeZone: 'America/Sao_Paulo',
      enabled: false,
      lastRunAt: at(60 * 24 * 7),
      lastError:
        'O Work respondeu 503 ao ler o board Aprovado (https://work.example.com/api/v2/boards/aprovado-sigma/activities?limit=200); a rotina tenta de novo na próxima.',
      createdBy: 'agent',
      createdAt: at(60 * 24 * 30),
      updatedAt: at(60 * 24 * 7),
    },
  ],
};

export const priorityCriteria = {
  text: 'Loja parada primeiro.\nDepois o que o suporte marcou como urgente.\nEm empate, o pedido mais antigo na Entrada.',
  updatedAt: at(60 * 24 * 6),
};

export const priorityProposals: PriorityProposal[] = [
  {
    id: id(31),
    number: 9,
    state: 'proposta',
    workspaceId: 'sistemas',
    boardId: 'aprovado',
    statusId: 'aprovado',
    summary:
      '**Loja parada primeiro.** Três lojas não fecham o mês sem o relatório por loja; depois o pedido de compra, que o suporte marcou como urgente na sexta.',
    cards: [
      {
        workId: '77120',
        title: 'Relatório de faturamento por loja com período livre e totais no rodapé',
        reason:
          'Três lojas (251, 260, 312) não conseguem fechar o mês sem ver o faturamento separado; o suporte abriu quatro chamados na última semana.',
        raise: true,
      },
      {
        workId: '76001',
        title: 'Impressão do pedido de compra',
        reason: 'urgente para o suporte',
        raise: false,
      },
      { workId: '75500', title: 'Cadastro de marcas: busca por código', raise: false },
    ],
    current: [
      { workId: '76001', title: 'Impressão do pedido de compra' },
      { workId: '75500', title: 'Cadastro de marcas: busca por código' },
    ],
    proposedBy: 'Ichigo',
    planNumber: 6,
    createdAt: at(60 * 20),
  },
  {
    id: id(32),
    number: 8,
    state: 'aplicada',
    workspaceId: 'sistemas',
    boardId: 'aprovado',
    statusId: 'aprovado',
    summary: 'Cores de Aparelhos antes de Marcas.\nO resto mantido.',
    cards: [],
    current: [],
    adjusted: true,
    proposedBy: 'Ichigo',
    decidedVia: 'panel',
    decidedAt: at(60 * 24 * 6),
    createdAt: at(60 * 24 * 7),
  },
  {
    id: id(33),
    number: 7,
    state: 'descartada',
    workspaceId: 'sistemas',
    boardId: 'aprovado',
    statusId: 'aprovado',
    summary: 'Marcas primeiro.',
    cards: [],
    current: [],
    note: 'Marcas não é prioridade este mês; o suporte não tem chamado aberto sobre isso e o time está fechando o faturamento.',
    proposedBy: 'Ichigo',
    decidedAt: at(60 * 24 * 13),
    createdAt: at(60 * 24 * 14),
  },
];

export const screens: Screen[] = [
  {
    id: id(41),
    application: 'erp-novo',
    route: '/vendas/faturamento/listagem-de-faturamento-por-loja-e-periodo-com-totais',
    menuPath: 'Vendas › Faturamento › Listagem',
    title: 'Faturamento',
    squad: 'Sigma',
    state: 'draft',
    sheet: {
      today: [
        { text: 'Lista as notas do mês atual de todas as lojas do usuário.', source: 'screen' },
        {
          text: 'Os filtros ficam num painel à esquerda, recolhível pelo botão Ocultar Filtro; a busca só roda ao clicar em Pesquisar.',
          source: 'screen',
        },
        { text: 'A rota chama /api/faturamento?loja=&inicio=&fim=.', source: 'code' },
      ],
      requirements: [
        { text: 'Um usuário só vê as lojas a que tem acesso.', source: 'code' },
        { text: 'O total do rodapé soma o que está filtrado.', source: 'unknown' },
      ],
      questions: [
        {
          text: 'Ações desta tela reproduzem na tela antiga em produção? Não testei nenhuma.',
          source: 'unknown',
        },
      ],
      problems: [],
    },
    workUrl: 'https://work.example.com/w/sistemas/d/mapa-de-telas-erp-novo-faturamento-listagem',
    prints: [],
    mappedAt: at(60 * 24),
    createdAt: at(60 * 24 * 9),
    updatedAt: at(60 * 24),
  },
  {
    id: id(42),
    application: 'erp-novo',
    route: '/cadastros/cores-de-aparelhos',
    menuPath: 'Cadastros › Aparelhos › Cores',
    title: 'Cores de Aparelhos',
    state: 'reviewed',
    prints: [],
    createdAt: at(60 * 24 * 9),
    updatedAt: at(60 * 24 * 2),
  },
  {
    id: id(43),
    application: 'app-gestores',
    route: '/vendas',
    menuPath: '',
    title: 'Vendas',
    state: 'listed',
    prints: [],
    createdAt: at(60 * 24 * 9),
    updatedAt: at(60 * 24 * 9),
  },
];

export const knowledgeRules: KnowledgeRule[] = [
  {
    id: id(51),
    number: 12,
    code: 'L-01',
    text: 'Toda listagem do ERP tem um filtro rápido só; o resto fica no painel de filtros.',
    scope: { kind: 'tipo_de_tela', screen: 'listagem', application: 'ERP' },
    source: { kind: 'decisao', ref: 'Pauta padrão de telas', date: '2026-09-21' },
    sensitive: false,
    state: 'ativa',
    createdAt: at(60 * 24 * 20),
    updatedAt: at(60 * 24 * 20),
  },
  {
    id: id(52),
    number: 31,
    text: 'App Gestores: até 5 lojas, uma linha por loja; acima de 5, um resumo. Vale para qualquer cargo, nunca "diretoria". Exceção só registrada aqui, com a pauta que a pediu e a data, e só depois do OK do PO em Validações ou no chat.',
    scope: { kind: 'aplicacao', application: 'App Gestores' },
    source: {
      kind: 'correcao',
      ref: 'https://work.example.com/w/sistemas/b/epics?activity=87001&comentario=correcao-regra-lojas',
      date: '2026-09-30',
    },
    sensitive: false,
    state: 'ativa',
    replaces: 18,
    createdAt: at(60 * 24 * 12),
    updatedAt: at(60 * 24 * 12),
  },
  {
    id: id(53),
    number: 40,
    text: 'Faturamento novo: nenhuma ação é executada em teste; reproduz na tela antiga em produção.',
    scope: { kind: 'tela', screen: 'Faturamento', application: 'ERP' },
    source: { kind: 'manual', ref: '' },
    sensitive: true,
    state: 'pendente',
    createdAt: at(60 * 24),
    updatedAt: at(60 * 24),
  },
];

export const knowledgeProposals: KnowledgeProposal[] = [
  {
    id: id(61),
    number: 5,
    kind: 'mudar',
    ruleNumber: 12,
    ruleText: 'Toda listagem do ERP tem um filtro rápido só; o resto fica no painel de filtros.',
    text: 'Toda listagem do ERP tem um filtro rápido só; o resto fica no painel de filtros, e a Exibição Dinâmica fica à direita, junto do Ocultar Filtro.',
    scope: { kind: 'tipo_de_tela', screen: 'listagem', application: 'ERP' },
    sensitive: false,
    reason:
      'Você respondeu no plano #7 que a Exibição Dinâmica sempre fica ao lado do Ocultar Filtro; com abas, o pop-up configura cada aba.',
    source: { kind: 'plano', ref: 'plano #7', date: '2026-10-13' },
    state: 'aguardando_po',
    proposedBy: 'Miku',
    createdAt: at(30),
  },
  {
    id: id(62),
    number: 4,
    kind: 'incluir',
    text: 'Tipos e Natureza: não gravar em produção.',
    scope: { kind: 'tela', screen: 'Tipos e Natureza' },
    sensitive: true,
    reason: 'Correção sua na validação #11.',
    source: { kind: 'validacao', ref: 'validação #11' },
    state: 'aplicada',
    appliedBy: 'owner',
    createdAt: at(60 * 24 * 2),
  },
];

const knowledgeSettings: KnowledgeSettings = {
  automatic: false,
  sensitiveAlwaysAsks: true,
  curatorProfileId: reviewer,
};

const card = (board: string, activity: string) =>
  `https://work.example.com/w/sistemas/b/${board}?activity=${activity}`;

export const mentions: Mention[] = [
  {
    id: id(80),
    number: 7,
    commentId: 'comment-7',
    activityId: '88413',
    boardId: 'tasks',
    cardTitle: 'Filtro de loja e período na listagem',
    cardUrl: card('tasks', '88413'),
    authorId: 'user-ricardo',
    authorName: 'Ricardo Albuquerque',
    body: 'Quatro pontos de regra ficaram assumidos e pedem confirmação do PO. O principal: o total do rodapé deve considerar as notas canceladas no período ou só as autorizadas? Hoje o Faturamento antigo soma as duas.',
    state: 'waiting',
    kind: 'alto_impacto',
    highImpactItem: 1,
    proposedReply:
      'Só as autorizadas. Nota cancelada não entra no total do rodapé, igual ao relatório fiscal. Os outros três pontos seguem como você assumiu.',
    reason: 'Toca o Faturamento: total de notas, que o Zend também lê.',
    createdAt: at(50),
    updatedAt: at(48),
  },
  {
    id: id(81),
    number: 6,
    commentId: 'comment-6',
    activityId: '88414',
    boardId: 'tasks',
    cardTitle: 'Totais por loja no rodapé',
    cardUrl: card('tasks', '88414'),
    authorId: 'user-ana',
    authorName: 'Ana Tester',
    body: 'O botão Limpar deve voltar o período para o mês atual ou para os últimos 30 dias?',
    state: 'answered',
    kind: 'comum',
    proposedReply: 'Volta para o mês atual, como diz o Pronto quando do épico.',
    publishedReply:
      '@[Ana](mention:user-ana) Atena, pelo Moabe: Volta para o mês atual, como diz o Pronto quando do épico.',
    reason: 'Pronto quando do épico, item 3.',
    createdAt: at(60 * 3),
    updatedAt: at(60 * 3 - 2),
  },
  {
    id: id(82),
    number: 5,
    commentId: 'comment-5',
    activityId: '88413',
    boardId: 'tasks',
    cardTitle: 'Filtro de loja e período na listagem',
    cardUrl: card('tasks', '88413'),
    authorId: 'user-lucas',
    authorName: 'Lucas Larangeira',
    body: 'PR aberto, pipeline verde.',
    state: 'not_po',
    reason: 'Status de PR.',
    createdAt: at(60 * 5),
    updatedAt: at(60 * 5),
  },
];

const mentionSettings: MentionSettings = {
  enabled: true,
  scope: 'sigma',
  signature: 'Atena, pelo Moabe:',
  holdHours: 4,
  highImpact: [
    'Fiscal ou financeiro: nota, imposto, valor, Tipos e Natureza, Faturamento.',
    'Dado em produção ou ação irreversível.',
    'Escopo de épico em andamento.',
    'Contradiz o Moabe.',
    'Fora da Sigma.',
    'Falta fato.',
  ],
  ownerUserId: 'b21a0000-0000-4000-8000-000000000099',
};

const erp = id(90);
const gestores = id(91);
const entrada = (activity: string) => card('entrada', activity);

const roadmapItem = (
  index: number,
  number: number,
  fields: Partial<RoadmapItem> & Pick<RoadmapItem, 'title' | 'lane'>,
): RoadmapItem => ({
  id: id(index),
  number,
  applicationId: gestores,
  application: 'app-gestores',
  applicationName: 'App Gestores',
  summary: '',
  kind: 'feature',
  position: 0,
  state: 'ativo',
  blocked: false,
  origin: 'pedido',
  epicWorkIds: [],
  createdBy: 'owner',
  createdAt: at(60 * 24 * 9),
  updatedAt: at(60 * 24),
  ...fields,
});

export const roadmapItems: RoadmapItem[] = [
  roadmapItem(92, 3, {
    title: 'Faturamento: filtro por loja e período na listagem, com totais por loja no rodapé',
    lane: 'agora',
    applicationId: erp,
    application: 'erp',
    applicationName: 'ERP',
    summary:
      'Gestores não conseguem ver o faturamento de uma loja só. Hoje exportam a listagem inteira e filtram na planilha.',
    theme: 'Fiscal',
    requestWorkId: '88410',
    requestUrl: entrada('88410'),
    epicWorkIds: ['88412'],
    pautaId: id(93),
    pautaTitle: 'Gestores não conseguem ver o faturamento de uma loja só',
  }),
  roadmapItem(94, 5, {
    title: 'Encomendas no App Gestores',
    lane: 'agora',
    position: 1,
    summary: 'Gestor acompanha as encomendas da loja pelo celular, sem abrir o ERP.',
    theme: 'Encomendas',
    blocked: true,
    requestWorkId: '88501',
    requestUrl: entrada('88501'),
    epicWorkIds: ['88502', '88503'],
  }),
  roadmapItem(95, 7, {
    title: 'Meta do dia por loja na tela inicial',
    lane: 'proximo',
    kind: 'melhoria',
    origin: 'sugestao',
    summary: 'Até 5 lojas, uma linha por loja; acima, o resumo.',
  }),
  roadmapItem(96, 9, {
    title: 'Tipos e Natureza: revisar os cadastros lidos pelo Zend',
    lane: 'depois',
    kind: 'divida',
    origin: 'pauta',
    applicationId: erp,
    application: 'erp',
    applicationName: 'ERP',
    theme: 'Fiscal',
  }),
  roadmapItem(97, 10, {
    title: 'Ranking de lojas por ticket médio',
    lane: 'depois',
    position: 1,
    kind: 'ideia',
    origin: 'moabe',
  }),
  roadmapItem(98, 1, {
    title: 'Cores de Aparelhos com amostra ao lado do nome',
    lane: 'agora',
    state: 'concluido',
    applicationId: erp,
    application: 'erp',
    applicationName: 'ERP',
    concludedAt: at(60 * 24 * 3),
  }),
];

export const roadmapProposals: RoadmapProposal[] = [
  {
    id: id(99),
    number: 12,
    kind: 'incluir',
    application: 'app-gestores',
    applicationName: 'App Gestores',
    lane: 'depois',
    item: {
      application: 'app-gestores',
      title: 'Alerta de meta não batida às 18h',
      summary: 'O gestor só descobre que a loja ficou abaixo da meta no dia seguinte.',
      kind: 'feature',
      lane: 'depois',
      theme: 'Metas',
      origin: 'sugestao',
      epicWorkIds: [],
    },
    reason: 'Três validações reprovadas citaram a falta de aviso, e a menção #7 perguntou o mesmo.',
    counterpoint:
      'Notificação demais cansa: se o alerta vier todo dia para quem já sabe, vira ruído e o gestor desliga.',
    evidence: ['Validação #14', 'Menção #7', `${work}88412`],
    highImpact: false,
    state: 'aguardando_po',
    proposedBy: 'Estrategista',
    createdAt: at(30),
  },
  {
    id: id(100),
    number: 11,
    kind: 'mover',
    itemId: id(94),
    itemNumber: 5,
    itemTitle: 'Encomendas no App Gestores',
    application: 'app-gestores',
    applicationName: 'App Gestores',
    fromLane: 'agora',
    lane: 'proximo',
    reason: 'O pedido voltou para Priorizado: o épico 88502 foi para Bloqueado e saiu da sprint.',
    evidence: [entrada('88501')],
    highImpact: false,
    state: 'aguardando_po',
    proposedBy: 'Estrategista',
    createdAt: at(90),
  },
];

const roadmapSettings: RoadmapSettings = {
  strategistProfileId: reviewer,
  automaticMoves: false,
  suggestionsPerRound: 3,
  applications: ['erp', 'app-gestores'],
};

const ok = <T>(value: T) => HttpResponse.json(value as never);

/** Reads answer from the data above; every write succeeds and changes nothing. */
export const atenaHandlers = [
  http.get('*/v1/roadmap', () => ok(roadmapItems)),
  http.post('*/v1/roadmap/items', () => ok(roadmapItems[0])),
  http.patch('*/v1/roadmap/items/*', () => ok(roadmapItems[0])),
  http.post('*/v1/roadmap/sync', () =>
    ok({ kind: 'leitura', profileId: reviewer, sessionId: id(101), workRead: true }),
  ),
  http.get('*/v1/roadmap-proposals', () => ok(roadmapProposals)),
  http.post('*/v1/roadmap-proposals/*', () => ok(roadmapProposals[0])),
  http.get('*/v1/roadmap-settings', () => ok(roadmapSettings)),
  http.put('*/v1/roadmap-settings', () => ok(roadmapSettings)),
  http.get('*/v1/mentions', () => ok(mentions)),
  http.post('*/v1/mentions/*', () => ok(mentions[0])),
  http.get('*/v1/mention-settings', () => ok(mentionSettings)),
  http.put('*/v1/mention-settings', () => ok(mentionSettings)),
  http.get('*/v1/validations', () => ok(validations)),
  http.post('*/v1/validations/*', () => ok(validations[0])),
  http.patch('*/v1/validations/*', () => ok(validations[0])),
  http.get('*/v1/plans', () => ok(plans)),
  http.post('*/v1/plans/*', () => ok(plans[0])),
  http.get('*/v1/plan-settings/:action', ({ params }) =>
    ok(planSettings[params.action as PlanSettings['action']]),
  ),
  http.put('*/v1/plan-settings/:action', ({ params }) =>
    ok(planSettings[params.action as PlanSettings['action']]),
  ),
  http.post('*/v1/entry-sync/run', () =>
    ok({ moves: 0, stale: 0, skipped: 0, unchanged: true, message: 'Nada mudou.' }),
  ),
  http.get('*/v1/routines', () => ok(routines)),
  http.get('*/v1/priorities/criteria', () => ok(priorityCriteria)),
  http.put('*/v1/priorities/criteria', () => ok(priorityCriteria)),
  http.get('*/v1/priorities', () => ok(priorityProposals)),
  http.post('*/v1/priorities/*', () => ok(priorityProposals[0])),
  http.get('*/v1/screens', () => ok(screens)),
  http.post('*/v1/screens/*', () => ok(screens[0])),
  http.get('*/v1/knowledge', () => ok(knowledgeRules)),
  http.patch('*/v1/knowledge/*', () => ok(knowledgeRules[0])),
  http.get('*/v1/knowledge-proposals', () => ok(knowledgeProposals)),
  http.post('*/v1/knowledge-proposals/*', () => ok(knowledgeProposals[0])),
  http.get('*/v1/knowledge-settings', () => ok(knowledgeSettings)),
  http.put('*/v1/knowledge-settings', () => ok(knowledgeSettings)),
];
