import { type Client, profile } from './params';
import { result } from './result';
import type { NewApplication, ScheduleInput, SchedulePatch } from './types';

/** What the agent carries between runs: what it remembers and what it knows how to do. */
export const resourceCalls = (client: Client) => ({
  sshKeys: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/ssh-keys', { params: profile(profileId) })),
  createSshKey: (profileId: string, body: { name: string }) =>
    result(client.POST('/v1/profiles/{profileId}/ssh-keys', { params: profile(profileId), body })),
  deleteSshKey: (profileId: string, keyId: string) =>
    result(
      client.DELETE('/v1/profiles/{profileId}/ssh-keys/{keyId}', {
        params: { path: { profileId, keyId } },
      }),
    ),
  work: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/work', { params: profile(profileId) })),
  workHistory: (profileId: string, workId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/work/{workId}/history', {
        params: { path: { profileId, workId } },
      }),
    ),
  workExecutions: (profileId: string, workId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/work/{workId}/executions', {
        params: { path: { profileId, workId } },
      }),
    ),
  memories: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/memories', { params: profile(profileId) })),
  forget: (profileId: string, memoryKey: string) =>
    result(
      client.DELETE('/v1/profiles/{profileId}/memories/{memoryKey}', {
        params: { path: { profileId, memoryKey } },
      }),
    ),
  editMemory: (profileId: string, memoryKey: string, content: string, expectedVersion: number) =>
    result(
      client.PUT('/v1/profiles/{profileId}/memories/{memoryKey}', {
        params: { path: { profileId, memoryKey } },
        body: { content, expectedVersion },
      }),
    ),
  linkMemories: (profileId: string, memoryKey: string, linkedKey: string) =>
    result(
      client.PUT('/v1/profiles/{profileId}/memories/{memoryKey}/links/{linkedKey}', {
        params: { path: { profileId, memoryKey, linkedKey } },
      }),
    ),
  unlinkMemories: (profileId: string, memoryKey: string, linkedKey: string) =>
    result(
      client.DELETE('/v1/profiles/{profileId}/memories/{memoryKey}/links/{linkedKey}', {
        params: { path: { profileId, memoryKey, linkedKey } },
      }),
    ),
  stats: (profileId: string, days: number) =>
    result(
      client.GET('/v1/profiles/{profileId}/stats', {
        params: { path: { profileId }, query: { days } },
      }),
    ),
  applications: () => result(client.GET('/v1/applications')),
  createApplication: (body: NewApplication) => result(client.POST('/v1/applications', { body })),
  applicationFiles: (slug: string) =>
    result(client.GET('/v1/applications/{slug}/files', { params: { path: { slug } } })),
  applicationFile: (slug: string, path: string) =>
    result(
      client.GET('/v1/applications/{slug}/file', { params: { path: { slug }, query: { path } } }),
    ),
  writeApplicationFile: (slug: string, path: string, text: string) =>
    result(
      client.PUT('/v1/applications/{slug}/file', {
        params: { path: { slug }, query: { path } },
        body: { text },
      }),
    ),
  applicationPreview: (slug: string, path: string) =>
    result(
      client.POST('/v1/applications/{slug}/preview', {
        params: { path: { slug }, query: { path } },
      }),
    ),
  approvals: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/approvals', { params: profile(profileId) })),
  approve: (profileId: string, approvalId: string, reason?: string, input?: unknown) =>
    result(
      client.POST('/v1/profiles/{profileId}/approvals/{approvalId}/approve', {
        params: { path: { profileId, approvalId } },
        body: { ...(reason ? { reason } : {}), ...(input !== undefined ? { input } : {}) },
      }),
    ),
  quality: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/quality', { params: profile(profileId) })),
  reject: (profileId: string, approvalId: string, reason?: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/approvals/{approvalId}/reject', {
        params: { path: { profileId, approvalId } },
        body: reason ? { reason } : {},
      }),
    ),
  schedules: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/schedules', { params: profile(profileId) })),
  createSchedule: (profileId: string, body: ScheduleInput) =>
    result(client.POST('/v1/profiles/{profileId}/schedules', { params: profile(profileId), body })),
  updateSchedule: (profileId: string, scheduleId: string, body: SchedulePatch) =>
    result(
      client.PATCH('/v1/profiles/{profileId}/schedules/{scheduleId}', {
        params: { path: { profileId, scheduleId } },
        body,
      }),
    ),
  deleteSchedule: (profileId: string, scheduleId: string) =>
    result(
      client.DELETE('/v1/profiles/{profileId}/schedules/{scheduleId}', {
        params: { path: { profileId, scheduleId } },
      }),
    ),
  scheduleHistory: (profileId: string, scheduleId: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/schedules/{scheduleId}/history', {
        params: { path: { profileId, scheduleId } },
      }),
    ),
  settings: () => result(client.GET('/v1/settings')),
  runSchedule: (profileId: string, scheduleId: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/schedules/{scheduleId}/run', {
        params: { path: { profileId, scheduleId } },
      }),
    ),
  builtinSkills: (profileId: string) =>
    result(client.GET('/v1/profiles/{profileId}/built-in-skills', { params: profile(profileId) })),
  skillCatalog: (profileId: string, url: string) =>
    result(
      client.GET('/v1/profiles/{profileId}/skill-catalog', {
        params: { path: { profileId }, query: { url } },
      }),
    ),
  importSkill: (profileId: string, url: string) =>
    result(
      client.POST('/v1/profiles/{profileId}/skills/import', {
        params: profile(profileId),
        body: { url },
      }),
    ),
});
