'use client';

import { supportsModelRole, supportsProviderRole } from '@jian/contracts';
import type { ProfileData, Provider } from '../../lib/api';
import { Field } from '../ui';
import { Select, type SelectOption } from '../ui/select';
import { efforts, modelLabel, optionalRoles, type Role, type roles } from './catalog';

export type RoleValue = {
  providerId: string;
  modelId: string;
  reasoningEffort: string;
  disabled: boolean;
};

/** A provider id is a UUID, so the first colon is always where the model id begins. */
export const choiceOf = (providerId: string, modelId: string) =>
  providerId && modelId ? `${providerId}:${modelId}` : '';

export const providerName = (provider: Provider) =>
  `${provider.name}${provider.kind === 'openai' ? (provider.authMode === 'codex' ? ' · ChatGPT' : ' · API key') : ''}`;

/**
 * Every model of every connected provider that can do this activity, in one list: the owner
 * picks a model, and the provider comes with it. Each one names its provider underneath, so
 * the same model reached through two accounts stays two choices.
 */
export function modelChoices(
  role: Role,
  data: ProfileData,
  configured: Provider[],
): SelectOption[] {
  return configured
    .filter((provider) => supportsProviderRole(provider, role))
    .flatMap((provider) =>
      (data.providerModels[provider.id]?.models ?? [])
        .filter((model) => supportsModelRole(provider, model, role))
        .map((model) => ({
          value: choiceOf(provider.id, model.id),
          // Only the name: an uncatalogued model is flagged once it is chosen, not in the menu.
          label: modelLabel(model, false),
          detail: providerName(provider),
        })),
    );
}

/** What one activity can offer and has chosen, read the same by its card and its dialog. */
export function describeRole(value: RoleValue, data: ProfileData, configured: Provider[]) {
  const provider = configured.find((item) => item.id === value.providerId);
  const list = value.providerId ? data.providerModels[value.providerId] : undefined;
  const selected = (list?.models ?? []).find((model) => model.id === value.modelId);
  const allowed = efforts.filter((effort) => selected?.reasoningEfforts.includes(effort.value));

  return { provider, list, selected, allowed };
}

export function RoleFields({
  role,
  value,
  data,
  configured,
  hasOpenAIKey,
  busy,
  change,
}: {
  role: (typeof roles)[number];
  value: RoleValue;
  data: ProfileData;
  configured: Provider[];
  hasOpenAIKey: boolean;
  busy: boolean;
  change: (role: Role, patch: Partial<RoleValue>) => void;
}) {
  const { provider, list, allowed } = describeRole(value, data, configured);
  const choices = modelChoices(role.key, data, configured);
  const current = value.disabled ? 'disabled' : choiceOf(value.providerId, value.modelId);

  return (
    <>
      {list?.stale && (
        <p className="note" role="status">
          The list is stale: the provider did not answer the last read.
        </p>
      )}
      <div className="settings-fields">
        <Field label="Model">
          <Select
            value={current}
            disabled={busy}
            onValueChange={(choice) => {
              if (choice === 'disabled') {
                change(role.key, {
                  providerId: '',
                  modelId: '',
                  reasoningEffort: '',
                  disabled: true,
                });
              } else if (!choice) {
                change(role.key, {
                  providerId: '',
                  modelId: '',
                  reasoningEffort: '',
                  disabled: false,
                });
              } else {
                const split = choice.indexOf(':');

                change(role.key, {
                  providerId: choice.slice(0, split),
                  modelId: choice.slice(split + 1),
                  reasoningEffort: '',
                  disabled: false,
                });
              }
            }}
            options={[
              ...(optionalRoles.has(role.key) ? [{ value: 'disabled', label: 'Disabled' }] : []),
              { value: '', label: 'Automatic' },
              ...choices,
              ...(current && !choices.some((choice) => choice.value === current)
                ? [
                    {
                      value: current,
                      label: value.modelId,
                      detail: provider
                        ? `${providerName(provider)} · not offered for this activity`
                        : 'Saved provider, no longer connected',
                    },
                  ]
                : []),
            ]}
          />
        </Field>
        {role.key === 'image' && !value.disabled && !hasOpenAIKey && (
          <p className="note">
            <a href="/ui/providers/">Configure an OpenAI API key in Providers.</a> ChatGPT login
            does not authorize image generation.
          </p>
        )}
        {role.tools && !value.disabled && (
          <Field label="Effort">
            <Select
              value={value.reasoningEffort}
              disabled={busy || !allowed.length}
              onValueChange={(reasoningEffort) => change(role.key, { reasoningEffort })}
              options={[{ value: '', label: "The provider's own default" }, ...allowed]}
            />
          </Field>
        )}
      </div>
    </>
  );
}
