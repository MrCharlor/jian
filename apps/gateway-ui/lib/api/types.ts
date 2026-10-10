import type { operations } from '@jian/sdk';

/** The body of a response, read straight off the generated operation so nothing is restated. */
type JsonResponse<
  K extends keyof operations,
  S extends keyof operations[K]['responses'],
> = operations[K]['responses'][S] extends { content: { 'application/json': infer T } } ? T : never;

type RequestBody<K extends keyof operations> = operations[K] extends {
  requestBody: { content: { 'application/json': infer T } };
}
  ? T
  : never;

export type Profile = JsonResponse<'getProfile', 200>;
export type McpServer = Profile['mcpServers'][number];
export type McpValue = McpServer['headers'][number];
export type Skill = Profile['skills'][number];
export type Session = JsonResponse<'listSessions', 200>[number];
export type Channel = JsonResponse<'listChannels', 200>[number];
export type ChannelType = Channel['type'];
export type Contact = JsonResponse<'listContacts', 200>[number];
export type Group = JsonResponse<'listGroups', 200>[number];
export type Memory = JsonResponse<'listMemories', 200>[number];
export type Approval = JsonResponse<'listApprovals', 200>[number];
export type Application = JsonResponse<'listApplications', 200>[number];
export type ApplicationFile = JsonResponse<'listApplicationFiles', 200>[number];
export type NewApplication = RequestBody<'createApplication'>;
export type Prototype = JsonResponse<'listPrototypes', 200>[number];
export type Pauta = JsonResponse<'listPautas', 200>[number];
export type NewPauta = RequestBody<'createPauta'>;
export type BoardCard = JsonResponse<'getAgentBoard', 200>[number];
export type Drawing = JsonResponse<'listDrawings', 200>[number];
export type EpicDraft = JsonResponse<'listEpicDrafts', 200>[number];
export type EpicDraftPatch = RequestBody<'updateEpicDraft'>;
export type PriorityProposal = JsonResponse<'listPriorityProposals', 200>[number];
export type PriorityCriteria = JsonResponse<'getPriorityCriteria', 200>;
export type NewPrototype = RequestBody<'createPrototype'>;
export type QualityRow = JsonResponse<'getQuality', 200>[number];
export type ActionPolicy = Profile['actionPolicy'];
export type AutonomyLevel = ActionPolicy['machine'];
export type ProfileStats = JsonResponse<'getProfileStats', 200>;
export type BuiltinSkill = JsonResponse<'listBuiltinSkills', 200>[number];
export type McpStatus = JsonResponse<'checkMcpServer', 200>;
export type Run = JsonResponse<'getRun', 200>;
export type Message = JsonResponse<'listMessages', 200>[number];
export type Person = JsonResponse<'listSessionPeople', 200>[number];
export type RunTimeline = JsonResponse<'listSessionTimeline', 200>[number];
export type ToolStep = RunTimeline['steps'][number];
export type ActivityDay = JsonResponse<'getActivityCalendar', 200>[number];
export type Delivery = JsonResponse<'listDeliveries', 200>[number];
export type Connection = JsonResponse<'getChannelConnection', 200>;

export type Provider = JsonResponse<'listProviders', 200>[number];
export type ModelDefaults = JsonResponse<'getModelDefaults', 200>;
export type ModelSelection = NonNullable<ModelDefaults['conversation']>;
export type ReasoningEffort = NonNullable<ModelSelection['reasoningEffort']>;
export type ProviderModelList = JsonResponse<'listProviderModels', 200>;
export type ProviderModel = ProviderModelList['models'][number];

export type NewProfile = RequestBody<'createProfile'>;
export type MediaUpload = RequestBody<'uploadMedia'>;
export type ScheduleInput = RequestBody<'createSchedule'>;
export type SchedulePatch = RequestBody<'updateSchedule'>;
export type Schedule = JsonResponse<'listSchedules', 200>[number];
export type ScheduleRun = JsonResponse<'listScheduleRuns', 200>[number];
export type WorkItem = JsonResponse<'listWork', 200>[number];
export type WorkHistory = JsonResponse<'getWorkHistory', 200>;
export type WorkExecution = JsonResponse<'listWorkExecutions', 200>[number];
export type ProfilePatch = RequestBody<'updateProfile'>;
export type NewChannel = RequestBody<'createChannel'>;
export type NewProvider = RequestBody<'createProvider'>;
export type ModelDefaultsInput = RequestBody<'setModelDefaults'>;
export type DecisionsStatus = JsonResponse<'getDecisions', 200>;
export type DecisionsSettingsPatch = RequestBody<'updateDecisionsSettings'>;
export type SshKey = JsonResponse<'listSshKeys', 200>[number];
export type NewSshKey = RequestBody<'createSshKey'>;

/** The open profile's whole screenful. Every section reads its slice from here. */
export type ProfileData = {
  providers: Provider[];
  /** One entry per usable provider, keyed by provider id. Absent while a list never arrived. */
  providerModels: Record<string, ProviderModelList>;
  modelDefaults: ModelDefaults;
  sessions: Session[];
  channels: Channel[];
  memories: Memory[];
  activities: Run[];
  deliveries: Delivery[];
  contacts: Contact[];
  groups: Group[];
};

/** Runs an action, shows its outcome and reloads the profile. False means it failed. */
export type Mutation = (action: () => Promise<unknown>, message?: string) => Promise<boolean>;
