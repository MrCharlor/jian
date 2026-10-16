/** Where an epic lands on the work tracker and which of its fields the owner fills. */
export type EpicTarget = {
  /** The tracker's web address, for links to the cards. */
  webUrl: string;
  workspaceId: string;
  boardId: string;
  /** The column a new epic and its tasks start in. */
  todoStatusId: string;
  teamId: string;
  requesterFieldId: string;
  requester: string;
  prototypeFieldId: string;
  labels: Record<string, string>;
  /** Who takes the epic from here, told in a comment on it. */
  lead?: { id: string; name: string };
};

/**
 * The Sigma squad at VX Case (10/10/2026). The App field is the tech lead's and is never set;
 * tasks are never mirrored to the Tasks board, which the tech lead does.
 */
export const SIGMA_EPICS: EpicTarget = {
  webUrl: 'https://work.vxcase.com.br',
  workspaceId: '68dcd04e-7851-4e62-8078-b71801657ebb',
  boardId: 'a291bb55-d013-4892-94d1-37e536e6a99a',
  todoStatusId: '317925f8-e7b8-447f-a746-ae500458856e',
  teamId: '883ed188-a0db-4998-b54e-1a994298d728',
  requesterFieldId: '1805dc18-f585-4837-812a-2b5b632282dd',
  requester: '3433',
  prototypeFieldId: 'b1171f23-6505-4458-b3f5-0688d7650533',
  labels: {
    feature: '17b9d203-7e06-42df-8258-25f12874281e',
    refactor: '6b829024-283c-4768-83fc-fed70b0c0ba3',
    bugfix: '38587364-873e-46b5-89e8-e6f781cf1db6',
    hotfix: '6162e0c4-928f-4fc1-91b9-a16fcfdafcb0',
    style: '8508f7f1-e807-4c45-8226-a7caff979c2f',
    docs: '6384c87b-618d-4d53-a3e2-f7c0b6160c4c',
  },
  lead: { id: '2caf7fee-8ea1-4585-a43c-e04d979d23ef', name: 'Lucas Larangeira' },
};

/** What the owner's check reads on the Sigma boards, besides the epic board. */
export const SIGMA_VALIDATION = {
  ...SIGMA_EPICS,
  tasksBoardId: '762d9c12-3467-49f4-9cc8-722762c8a454',
  // stts::awaiting-po, until the Homologação column exists.
  awaitingLabel: 'f5091215-db9a-423d-8e25-876416b2086f',
  // type::returned
  returnedLabel: 'f1183a66-7b43-4c67-bed9-22181f0fbdf1',
  previewFieldId: '368ac481-2c90-4d91-8651-b1e42c232b79',
  // Aceito on the epics board: an epic there is done, whatever label it still carries.
  acceptedStatusId: '715e9f33-97f9-4ccb-be92-7349e377f916',
};

/** What a request the agent writes carries on the Sigma Entrada (16/10/2026). */
export const SIGMA_REQUEST = {
  newStatusId: 'ba9c276f-74cf-4177-bcfb-9cacc39edf63',
  requesterFieldId: 'c76b7190-fd31-442a-8ad9-d1e40231e4cb',
  requester: '3433',
  kindFieldId: '2a81d7f5-6830-4d78-ae2c-7bcb33559a45',
  kinds: {
    suporte: 'd277f168-80df-4e77-b984-64254c26f696',
    qa: '387a2f61-0472-4048-bf2e-672bea9737f4',
    implementacao: '215695ea-7aea-4cc4-86fb-2fdb1df56415',
  },
};

export type RequestTarget = typeof SIGMA_REQUEST;

/** Where the requests of a squad wait and which columns the entry sync reads and moves. */
export type EntryTarget = {
  webUrl: string;
  workspaceId: string;
  /** The squad's Entrada: one request per card, often a mirror of a support card. */
  entryBoardId: string;
  epicsBoardId: string;
  tasksBoardId: string;
  /** The Entrada columns by the names the board shows; their ids are read on the board. */
  entryColumns: { prioritized: string; running: string; blocked: string; done: string };
  /**
   * The start of each Entrada column id, as the team's notes record it. A column found by name
   * with another id stops the sync: the board was changed and the names may no longer mean it.
   */
  entryColumnIds: Partial<Record<keyof EntryTarget['entryColumns'], string>>;
  /** The epic and task columns by name; both boards share them. */
  workColumns: { todo: string; blocked: string; doing: string; review: string; accepted: string };
  /** The id of the epics' "to do" column, already known to the epic drafts. */
  todoStatusId?: string;
  /** Days a request may wait in Priorizado with no epic before the owner hears of it. */
  staleDays: number;
};

/**
 * The Sigma Entrada (13/10/2026). The column names and id starts come from vx-work-fluxo.md;
 * the full ids are read from the board each time, never written here.
 */
export const SIGMA_ENTRY: EntryTarget = {
  webUrl: SIGMA_EPICS.webUrl,
  workspaceId: SIGMA_EPICS.workspaceId,
  entryBoardId: '194a22a4-8df9-4693-bc37-5c2315eed624',
  epicsBoardId: SIGMA_EPICS.boardId,
  tasksBoardId: SIGMA_VALIDATION.tasksBoardId,
  entryColumns: {
    prioritized: 'Priorizado',
    running: 'Em execução',
    blocked: 'Bloqueado',
    done: 'Concluído',
  },
  entryColumnIds: {
    prioritized: '04b3c3f8',
    running: 'da8fb4d4',
    blocked: '90d65b0e',
    done: '22a4b02e',
  },
  workColumns: {
    todo: 'A fazer',
    blocked: 'Bloqueado',
    doing: 'Em andamento',
    review: 'Em revisão',
    accepted: 'Aceito',
  },
  todoStatusId: SIGMA_EPICS.todoStatusId,
  staleDays: 7,
};

/** Where the comments the gateway answers live, and who takes a technical question. */
export type MentionTarget = {
  webUrl: string;
  workspaceId: string;
  /** The boards a comment counts on when the scope is the squad's. */
  boards: string[];
  lead?: { id: string; name: string };
};

/** The Sigma boards (14/10/2026): the Entrada, the epics and the tasks. */
export const SIGMA_MENTIONS: MentionTarget = {
  webUrl: SIGMA_EPICS.webUrl,
  workspaceId: SIGMA_EPICS.workspaceId,
  boards: [SIGMA_ENTRY.entryBoardId, SIGMA_EPICS.boardId, SIGMA_VALIDATION.tasksBoardId],
  ...(SIGMA_EPICS.lead ? { lead: SIGMA_EPICS.lead } : {}),
};
