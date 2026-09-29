import { z } from 'zod';
import {
  channelConnectionSchema,
  channelInputSchema,
  channelQrSchema,
  channelSchema,
  contactSchema,
  deliverySchema,
  groupSchema,
  ingressResultSchema,
  ingressSchema,
  telegramUpdateSchema,
} from './channels.js';
import {
  artifactPageSchema,
  artifactQuerySchema,
  leaseInputSchema,
  leaseSchema,
  mailInputSchema,
  mailSchema,
  pageQuerySchema,
} from './coordination.js';
import {
  decisionsInputSchema,
  decisionsSettingsPatchSchema,
  decisionsStatusSchema,
} from './decisions.js';
import {
  inlineMediaSchema,
  mediaContentSchema,
  mediaRecordSchema,
  stickerImageSchema,
  stickerSchema,
  stickerTagsSchema,
} from './media.js';
import {
  builtinSkillSchema,
  mcpImportResultSchema,
  mcpImportSchema,
  mcpStatusSchema,
  memoryEditSchema,
  memoryKeySchema,
  profilePatchSchema,
  profileSchema,
  sessionModelSchema,
  sessionRenameSchema,
  sessionSchema,
  submitSchema,
} from './profile.js';
import {
  codexLoginSchema,
  modelDefaultsInputSchema,
  modelDefaultsRecordSchema,
  providerInputSchema,
  providerModelListSchema,
  providerRecordSchema,
} from './providers.js';
import {
  activityDaySchema,
  activityQuerySchema,
  checkpointSchema,
  continuationSchema,
  eventSchema,
  memoryRecordSchema,
  messageRecordSchema,
  personSchema,
  profileRecordSchema,
  profileStatsSchema,
  revisionRecordSchema,
  runRecordSchema,
  runTimelineSchema,
  sessionRecordSchema,
  sessionSummarySchema,
  statsQuerySchema,
} from './records.js';
import { releasesSchema, repositorySchema } from './releases.js';
import {
  gatewaySettingsPatchSchema,
  gatewaySettingsSchema,
  scheduleInputSchema,
  schedulePatchSchema,
  scheduleRecordSchema,
  scheduleRunSchema,
} from './schedules.js';
import { panelSessionEndSchema, panelSessionInputSchema, panelSessionSchema } from './security.js';
import { catalogQuerySchema, catalogSchema, skillImportSchema } from './skills.js';
import { webSearchInputSchema, webSearchStatusSchema } from './web.js';
import { workExecutionSchema, workHistorySchema, workItemSchema } from './work.js';

/**
 * `access` is the whole authorization model: the host token opens everything marked `admin`,
 * `public` routes carry their own proof in the body, and a webhook authenticates with the
 * token of its own channel binding.
 */
export type Operation = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  path: string;
  operationId: string;
  access: 'admin' | 'public' | 'webhook';
  body?: z.ZodType;
  query?: z.ZodType;
  // Path parameters are UUIDs unless an operation says otherwise.
  params?: z.ZodType;
  response: z.ZodType;
  status?: number;
  stream?: boolean;
};

const profile = '/v1/profiles/:profileId';
const session = `${profile}/sessions/:sessionId`;

export const cursorSchema = z.strictObject({
  after: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
});

export const operations: Operation[] = [
  {
    method: 'GET',
    path: `${profile}/work`,
    operationId: 'listWork',
    access: 'admin',
    response: z.array(workItemSchema),
  },
  {
    method: 'GET',
    path: `${profile}/work/:workId/history`,
    operationId: 'getWorkHistory',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), workId: z.uuid() }),
    response: workHistorySchema,
  },
  {
    method: 'GET',
    path: `${profile}/work/:workId/executions`,
    operationId: 'listWorkExecutions',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), workId: z.uuid() }),
    response: workExecutionSchema,
  },
  {
    method: 'GET',
    path: '/v1/releases',
    operationId: 'getReleases',
    access: 'admin',
    response: releasesSchema,
  },
  {
    method: 'POST',
    path: '/v1/releases/seen',
    operationId: 'markReleasesSeen',
    access: 'admin',
    response: releasesSchema,
  },
  {
    method: 'GET',
    path: '/v1/repository',
    operationId: 'getRepository',
    access: 'admin',
    response: repositorySchema,
  },
  {
    method: 'GET',
    path: '/v1/web-search',
    operationId: 'getWebSearch',
    access: 'admin',
    response: webSearchStatusSchema,
  },
  {
    method: 'PUT',
    path: '/v1/web-search',
    operationId: 'setWebSearch',
    access: 'admin',
    body: webSearchInputSchema,
    response: webSearchStatusSchema,
  },
  {
    method: 'DELETE',
    path: '/v1/web-search',
    operationId: 'removeWebSearch',
    access: 'admin',
    response: webSearchStatusSchema,
  },
  {
    method: 'GET',
    path: '/v1/decisions',
    operationId: 'getDecisions',
    access: 'admin',
    response: decisionsStatusSchema,
  },
  {
    method: 'PUT',
    path: '/v1/decisions',
    operationId: 'setDecisions',
    access: 'admin',
    body: decisionsInputSchema,
    response: decisionsStatusSchema,
  },
  {
    method: 'PATCH',
    path: '/v1/decisions',
    operationId: 'updateDecisionsSettings',
    access: 'admin',
    body: decisionsSettingsPatchSchema,
    response: decisionsStatusSchema,
  },
  {
    method: 'DELETE',
    path: '/v1/decisions',
    operationId: 'removeDecisions',
    access: 'admin',
    response: decisionsStatusSchema,
  },
  {
    method: 'POST',
    path: '/v1/providers/openai/oauth',
    operationId: 'startCodexLogin',
    access: 'admin',
    response: codexLoginSchema,
  },
  {
    method: 'GET',
    path: '/v1/providers/openai/oauth',
    operationId: 'getCodexLogin',
    access: 'admin',
    response: codexLoginSchema,
  },
  {
    method: 'GET',
    path: '/v1/providers',
    operationId: 'listProviders',
    access: 'admin',
    response: z.array(providerRecordSchema),
  },
  {
    method: 'POST',
    path: '/v1/providers',
    operationId: 'createProvider',
    access: 'admin',
    body: providerInputSchema,
    response: providerRecordSchema,
    status: 201,
  },
  {
    method: 'GET',
    path: '/v1/providers/:providerId/models',
    operationId: 'listProviderModels',
    access: 'admin',
    response: providerModelListSchema,
  },
  {
    method: 'DELETE',
    path: '/v1/providers/:providerId',
    operationId: 'revokeProvider',
    access: 'admin',
    response: providerRecordSchema,
  },
  {
    method: 'GET',
    path: `${profile}/model-defaults`,
    operationId: 'getModelDefaults',
    access: 'admin',
    response: modelDefaultsRecordSchema,
  },
  {
    method: 'PUT',
    path: `${profile}/model-defaults`,
    operationId: 'setModelDefaults',
    access: 'admin',
    body: modelDefaultsInputSchema,
    response: modelDefaultsRecordSchema,
  },
  {
    method: 'GET',
    path: '/openapi.json',
    operationId: 'getOpenAPI',
    access: 'admin',
    response: z.record(z.string(), z.unknown()),
  },
  {
    method: 'GET',
    path: `${profile}/runs/:runId/checkpoints`,
    operationId: 'listRunCheckpoints',
    access: 'admin',
    response: z.array(checkpointSchema),
  },
  {
    method: 'POST',
    path: `${profile}/runs/:runId/continue`,
    operationId: 'continueRun',
    access: 'admin',
    body: continuationSchema,
    response: runRecordSchema,
    status: 202,
  },
  {
    method: 'POST',
    path: `${profile}/channels`,
    operationId: 'createChannel',
    access: 'admin',
    body: channelInputSchema,
    response: channelSchema.extend({
      webhookToken: z.string(),
      // Present when the gateway tried to register its webhook with the protocol itself.
      webhookRegistered: z.boolean().optional(),
      // What the protocol said when it refused the webhook, for the owner to act on.
      webhookError: z.string().optional(),
    }),
    status: 201,
  },
  {
    method: 'GET',
    path: `${profile}/channels`,
    operationId: 'listChannels',
    access: 'admin',
    response: z.array(channelSchema),
  },
  {
    method: 'DELETE',
    path: `${profile}/channels/:channelId`,
    operationId: 'revokeChannel',
    access: 'admin',
    response: channelSchema,
  },
  {
    method: 'GET',
    path: `${profile}/contacts`,
    operationId: 'listContacts',
    access: 'admin',
    response: z.array(contactSchema),
  },
  {
    method: 'POST',
    path: `${profile}/contacts/:contactId/approve`,
    operationId: 'approveContact',
    access: 'admin',
    response: contactSchema,
  },
  {
    method: 'POST',
    path: `${profile}/contacts/:contactId/block`,
    operationId: 'blockContact',
    access: 'admin',
    response: contactSchema,
  },
  {
    // Rooms cross profiles by nature: one group holds several agents of this installation, and
    // the owner decides about the room, not about one profile's view of it.
    method: 'GET',
    path: '/v1/groups',
    operationId: 'listGroups',
    access: 'admin',
    response: z.array(groupSchema),
  },
  {
    method: 'GET',
    path: `${profile}/deliveries`,
    operationId: 'listDeliveries',
    access: 'admin',
    response: z.array(deliverySchema),
  },
  {
    method: 'POST',
    path: `${profile}/channels/:channelId/connect`,
    operationId: 'connectChannel',
    access: 'admin',
    response: channelConnectionSchema,
    status: 202,
  },
  {
    method: 'GET',
    path: `${profile}/channels/:channelId/connection`,
    operationId: 'getChannelConnection',
    access: 'admin',
    response: channelConnectionSchema,
  },
  {
    method: 'GET',
    path: `${profile}/channels/:channelId/qr`,
    operationId: 'getChannelQr',
    access: 'admin',
    response: channelQrSchema,
  },
  {
    method: 'POST',
    path: `${profile}/channels/:channelId/disconnect`,
    operationId: 'disconnectChannel',
    access: 'admin',
    response: channelConnectionSchema,
    status: 202,
  },
  {
    method: 'POST',
    path: '/v1/ingress/:channelId',
    operationId: 'channelIngress',
    access: 'webhook',
    body: ingressSchema,
    response: ingressResultSchema,
    status: 202,
  },
  {
    method: 'POST',
    path: '/v1/telegram/:channelId',
    operationId: 'telegramIngress',
    access: 'webhook',
    body: telegramUpdateSchema,
    response: ingressResultSchema,
  },
  {
    method: 'GET',
    path: `${profile}/sessions/:sessionId/history`,
    operationId: 'getHistory',
    access: 'admin',
    query: pageQuerySchema,
    response: z.strictObject({
      items: z.array(messageRecordSchema),
      nextCursor: z.string().nullable(),
    }),
  },
  {
    method: 'GET',
    path: `${profile}/history`,
    operationId: 'searchHistory',
    access: 'admin',
    query: pageQuerySchema,
    response: z.strictObject({
      items: z.array(messageRecordSchema),
      nextCursor: z.string().nullable(),
    }),
  },
  {
    method: 'GET',
    path: `${profile}/artifacts/:artifactId`,
    operationId: 'getArtifact',
    access: 'admin',
    query: artifactQuerySchema,
    response: artifactPageSchema,
  },
  {
    method: 'POST',
    path: `${profile}/leases`,
    operationId: 'acquireResource',
    access: 'admin',
    body: leaseInputSchema,
    response: leaseSchema,
  },
  {
    method: 'POST',
    path: `${profile}/leases/release`,
    operationId: 'releaseResource',
    access: 'admin',
    body: leaseInputSchema
      .omit({ ttlSeconds: true })
      .extend({ fence: z.number().int().positive() }),
    response: leaseSchema,
  },
  {
    method: 'POST',
    path: `${profile}/mail`,
    operationId: 'sendSessionMail',
    access: 'admin',
    body: mailInputSchema,
    response: mailSchema,
  },
  {
    method: 'GET',
    path: `${session}/mail`,
    operationId: 'getSessionInbox',
    access: 'admin',
    response: z.array(mailSchema),
  },

  {
    method: 'GET',
    path: '/health',
    operationId: 'health',
    access: 'public',
    response: z.strictObject({ status: z.literal('ok'), service: z.literal('jian') }),
  },
  {
    // Public because the body carries the host token this route exists to verify.
    method: 'POST',
    path: '/v1/panel/session',
    operationId: 'startPanelSession',
    access: 'public',
    body: panelSessionInputSchema,
    response: panelSessionSchema,
    status: 201,
  },
  {
    method: 'DELETE',
    path: '/v1/panel/session',
    operationId: 'endPanelSession',
    access: 'admin',
    response: panelSessionEndSchema,
  },
  {
    method: 'POST',
    path: `${profile}/mcp-servers/import`,
    operationId: 'importMcpServers',
    access: 'admin',
    body: mcpImportSchema,
    response: mcpImportResultSchema,
  },
  {
    // A check the owner asks for, so it runs the connection now instead of reading a cache.
    method: 'POST',
    path: `${profile}/mcp-servers/:name/check`,
    operationId: 'checkMcpServer',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), name: z.string().regex(/^[a-z0-9_]{1,30}$/) }),
    response: mcpStatusSchema,
  },
  {
    // The authorization server sends the owner's browser here, so it answers HTML and carries
    // its proof in the query rather than in a header the redirect could not add.
    method: 'GET',
    path: `${profile}/mcp-servers/:name/oauth/callback`,
    operationId: 'completeMcpLogin',
    access: 'public',
    params: z.strictObject({ profileId: z.uuid(), name: z.string().regex(/^[a-z0-9_]{1,30}$/) }),
    query: z.looseObject({ code: z.string().optional(), state: z.string().optional() }),
    response: z.string(),
  },
  {
    method: 'GET',
    path: `${profile}/activity`,
    operationId: 'getActivityCalendar',
    access: 'admin',
    query: activityQuerySchema,
    response: z.array(activityDaySchema).max(400),
  },
  {
    method: 'GET',
    path: `${profile}/built-in-skills`,
    operationId: 'listBuiltinSkills',
    access: 'admin',
    response: z.array(builtinSkillSchema).max(50),
  },
  {
    method: 'GET',
    path: `${profile}/skill-catalog`,
    operationId: 'listSkillCatalog',
    access: 'admin',
    query: catalogQuerySchema,
    response: catalogSchema,
  },
  {
    method: 'POST',
    path: `${profile}/skills/import`,
    operationId: 'importSkill',
    access: 'admin',
    body: skillImportSchema,
    response: profileRecordSchema,
  },
  {
    method: 'GET',
    path: '/v1/profiles',
    operationId: 'listProfiles',
    access: 'admin',
    response: z.array(profileRecordSchema),
  },
  {
    method: 'POST',
    path: '/v1/profiles',
    operationId: 'createProfile',
    access: 'admin',
    body: profileSchema,
    response: profileRecordSchema,
    status: 201,
  },
  {
    method: 'GET',
    path: profile,
    operationId: 'getProfile',
    access: 'admin',
    response: profileRecordSchema,
  },
  {
    method: 'PATCH',
    path: profile,
    operationId: 'updateProfile',
    access: 'admin',
    body: profilePatchSchema,
    response: profileRecordSchema,
  },
  {
    // Everything the profile ever wrote — sessions, memories, channels, contacts, runs, media —
    // cascades from this row in the database, so the confirmation the owner sees is the whole
    // truth: nothing survives it.
    method: 'DELETE',
    path: profile,
    operationId: 'deleteProfile',
    access: 'admin',
    response: z.strictObject({ id: z.uuid() }),
  },
  {
    // Forgetting, not deleting: sessions, memories and activity go; configuration, channels
    // and contacts stay.
    method: 'POST',
    path: `${profile}/reset`,
    operationId: 'resetProfile',
    access: 'admin',
    response: z.strictObject({
      id: z.uuid(),
      sessions: z.number().int().nonnegative(),
      memories: z.number().int().nonnegative(),
    }),
  },
  {
    method: 'GET',
    path: `${profile}/revisions`,
    operationId: 'listRevisions',
    access: 'admin',
    response: z.array(revisionRecordSchema),
  },
  {
    method: 'GET',
    path: `${profile}/sessions`,
    operationId: 'listSessions',
    access: 'admin',
    response: z.array(sessionSummarySchema),
  },
  {
    method: 'POST',
    path: `${profile}/sessions`,
    operationId: 'createSession',
    access: 'admin',
    body: sessionSchema,
    response: sessionRecordSchema,
    status: 201,
  },
  {
    method: 'PATCH',
    path: session,
    operationId: 'renameSession',
    access: 'admin',
    body: sessionRenameSchema,
    response: sessionRecordSchema,
  },
  {
    method: 'PUT',
    path: `${session}/model`,
    operationId: 'setSessionModel',
    access: 'admin',
    body: sessionModelSchema,
    response: sessionRecordSchema,
  },
  {
    method: 'GET',
    path: '/v1/profiles/:profileId/media/:mediaId',
    operationId: 'readMedia',
    access: 'admin',
    response: mediaContentSchema,
  },
  {
    method: 'GET',
    path: `${session}/messages`,
    operationId: 'listMessages',
    access: 'admin',
    response: z.array(messageRecordSchema),
  },
  {
    method: 'POST',
    path: `${session}/media`,
    operationId: 'uploadMedia',
    access: 'admin',
    body: inlineMediaSchema,
    response: mediaRecordSchema,
    status: 201,
  },
  {
    method: 'GET',
    path: `${session}/timeline`,
    operationId: 'listSessionTimeline',
    access: 'admin',
    response: z.array(runTimelineSchema),
  },
  {
    method: 'GET',
    path: `${session}/people`,
    operationId: 'listSessionPeople',
    access: 'admin',
    response: z.array(personSchema),
  },
  {
    method: 'POST',
    path: `${session}/messages`,
    operationId: 'submitMessage',
    access: 'admin',
    body: submitSchema,
    response: runRecordSchema,
    status: 202,
  },
  {
    method: 'GET',
    path: `${profile}/schedules`,
    operationId: 'listSchedules',
    access: 'admin',
    response: z.array(scheduleRecordSchema),
  },
  {
    method: 'POST',
    path: `${profile}/schedules`,
    operationId: 'createSchedule',
    access: 'admin',
    body: scheduleInputSchema,
    response: scheduleRecordSchema,
    status: 201,
  },
  {
    method: 'PATCH',
    path: `${profile}/schedules/:scheduleId`,
    operationId: 'updateSchedule',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), scheduleId: z.uuid() }),
    body: schedulePatchSchema,
    response: scheduleRecordSchema,
  },
  {
    method: 'DELETE',
    path: `${profile}/schedules/:scheduleId`,
    operationId: 'deleteSchedule',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), scheduleId: z.uuid() }),
    response: scheduleRecordSchema,
  },
  {
    method: 'GET',
    path: `${profile}/schedules/:scheduleId/history`,
    operationId: 'listScheduleRuns',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), scheduleId: z.uuid() }),
    response: z.array(scheduleRunSchema),
  },
  {
    method: 'GET',
    path: '/v1/settings',
    operationId: 'getSettings',
    access: 'admin',
    response: gatewaySettingsSchema,
  },
  {
    method: 'PUT',
    path: '/v1/settings',
    operationId: 'updateSettings',
    access: 'admin',
    body: gatewaySettingsPatchSchema,
    response: gatewaySettingsSchema,
  },
  {
    // Now, once, without moving when it runs next: to see what it does before waiting for it.
    method: 'POST',
    path: `${profile}/schedules/:scheduleId/run`,
    operationId: 'runSchedule',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), scheduleId: z.uuid() }),
    response: runRecordSchema,
    status: 202,
  },
  {
    method: 'GET',
    path: `${profile}/memories`,
    operationId: 'listMemories',
    access: 'admin',
    response: z.array(memoryRecordSchema),
  },
  {
    method: 'PUT',
    path: `${profile}/memories/:memoryKey`,
    operationId: 'editMemory',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), memoryKey: memoryKeySchema }),
    body: memoryEditSchema,
    response: memoryRecordSchema,
  },
  {
    method: 'DELETE',
    path: `${profile}/memories/:memoryKey`,
    operationId: 'forgetMemory',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), memoryKey: memoryKeySchema }),
    response: memoryRecordSchema,
  },
  {
    // Links go both ways: linking a to b is linking b to a, and the answer is `memoryKey`.
    method: 'PUT',
    path: `${profile}/memories/:memoryKey/links/:linkedKey`,
    operationId: 'linkMemories',
    access: 'admin',
    params: z.strictObject({
      profileId: z.uuid(),
      memoryKey: memoryKeySchema,
      linkedKey: memoryKeySchema,
    }),
    response: memoryRecordSchema,
  },
  {
    method: 'DELETE',
    path: `${profile}/memories/:memoryKey/links/:linkedKey`,
    operationId: 'unlinkMemories',
    access: 'admin',
    params: z.strictObject({
      profileId: z.uuid(),
      memoryKey: memoryKeySchema,
      linkedKey: memoryKeySchema,
    }),
    response: memoryRecordSchema,
  },
  {
    method: 'GET',
    path: `${profile}/stats`,
    operationId: 'getProfileStats',
    access: 'admin',
    query: statsQuerySchema,
    response: profileStatsSchema,
  },
  {
    method: 'GET',
    path: `${profile}/stickers`,
    operationId: 'listStickers',
    access: 'admin',
    response: z.array(stickerSchema),
  },
  {
    method: 'DELETE',
    path: `${profile}/stickers`,
    operationId: 'forgetAllStickers',
    access: 'admin',
    response: z.strictObject({ removed: z.number().int().nonnegative() }),
  },
  {
    method: 'GET',
    path: `${profile}/stickers/:stickerId`,
    operationId: 'getSticker',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), stickerId: z.uuid() }),
    response: stickerImageSchema,
  },
  {
    method: 'PUT',
    path: `${profile}/stickers/:stickerId/tags`,
    operationId: 'tagSticker',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), stickerId: z.uuid() }),
    body: stickerTagsSchema,
    response: stickerSchema,
  },
  {
    method: 'DELETE',
    path: `${profile}/stickers/:stickerId`,
    operationId: 'forgetSticker',
    access: 'admin',
    params: z.strictObject({ profileId: z.uuid(), stickerId: z.uuid() }),
    response: stickerSchema,
  },
  {
    method: 'GET',
    path: `${profile}/activities`,
    operationId: 'listActivities',
    access: 'admin',
    response: z.array(runRecordSchema),
  },
  {
    method: 'GET',
    path: `${profile}/runs/:runId`,
    operationId: 'getRun',
    access: 'admin',
    response: runRecordSchema,
  },
  {
    method: 'POST',
    path: `${profile}/runs/:runId/cancel`,
    operationId: 'cancelRun',
    access: 'admin',
    response: runRecordSchema,
  },
  {
    method: 'GET',
    path: `${profile}/events`,
    operationId: 'listEvents',
    access: 'admin',
    query: cursorSchema,
    response: z.array(eventSchema),
  },
  {
    method: 'GET',
    path: `${profile}/events/stream`,
    operationId: 'streamEvents',
    access: 'admin',
    query: cursorSchema,
    response: z.string(),
    stream: true,
  },
];

export function jsonSchema(schema: z.ZodType, io: 'input' | 'output' = 'input') {
  const { $schema: _dialect, ...result } = z.toJSONSchema(schema, { target: 'draft-7', io });

  return result;
}

export const errorSchema = {
  type: 'object',
  properties: { error: { type: 'string' } },
  required: ['error'],
  additionalProperties: false,
};

export function operationSchema(operation: Operation) {
  const names = [...operation.path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1] as string);
  const params =
    operation.params ??
    (names.length
      ? z.strictObject(Object.fromEntries(names.map((name) => [name, z.uuid()])))
      : undefined);

  return {
    operationId: operation.operationId,
    ...(operation.body ? { body: jsonSchema(operation.body) } : {}),
    ...(operation.query ? { querystring: jsonSchema(operation.query) } : {}),
    ...(params ? { params: jsonSchema(params) } : {}),
    response: {
      [operation.status ?? 200]: jsonSchema(operation.response, 'output'),
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 413, 429, 500, 503].map((code) => [code, errorSchema]),
      ),
    },
  };
}

type RouteSchema = ReturnType<typeof operationSchema>;

function securityRequirements(operation: Operation) {
  if (operation.access === 'public') {
    return [];
  }

  if (operation.access === 'webhook') {
    const scheme =
      operation.operationId === 'telegramIngress' ? 'telegramWebhook' : 'channelWebhook';

    return [{ [scheme]: [] }];
  }

  return [{ bearerAuth: [] }];
}

function openAPIParameters(schema: RouteSchema) {
  const params = schema.params?.properties ?? {};
  const query = schema.querystring?.properties ?? {};

  return [
    ...Object.entries(params).map(([name, value]) => ({
      name,
      in: 'path',
      required: true,
      schema: value,
    })),
    ...Object.entries(query).map(([name, value]) => ({
      name,
      in: 'query',
      required: false,
      schema: value,
    })),
  ];
}

function openAPIResponses(operation: Operation, schema: RouteSchema) {
  return Object.fromEntries(
    Object.entries(schema.response).map(([code, value]) => {
      const contentType =
        operation.stream && code === '200' ? 'text/event-stream' : 'application/json';

      return [
        code,
        {
          description: Number(code) < 400 ? 'Success' : 'Error',
          content: { [contentType]: { schema: value } },
        },
      ];
    }),
  );
}

function openAPIOperation(operation: Operation) {
  const schema = operationSchema(operation);

  return {
    operationId: operation.operationId,
    security: securityRequirements(operation),
    description: `Required permission: ${operation.access}.`,
    parameters: openAPIParameters(schema),
    ...(schema.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: schema.body } },
          },
        }
      : {}),
    responses: openAPIResponses(operation, schema),
  };
}

/** Runtime validation and client generation share the same operation definitions. */
export function createOpenAPI() {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const operation of operations) {
    const path = operation.path.replace(/:([A-Za-z]+)/g, '{$1}');

    paths[path] ??= {};
    paths[path][operation.method.toLowerCase()] = openAPIOperation(operation);
  }

  return {
    openapi: '3.1.0',
    info: { title: 'Jian Gateway', version: '0.2.0' },
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer' },
        telegramWebhook: { type: 'apiKey', in: 'header', name: 'X-Telegram-Bot-Api-Secret-Token' },
        channelWebhook: { type: 'apiKey', in: 'header', name: 'X-Jian-Channel-Token' },
      },
    },
  };
}
