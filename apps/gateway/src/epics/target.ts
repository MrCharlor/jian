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
