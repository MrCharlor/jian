'use client';

import { supportsModelRole, supportsProviderRole } from '@jian/contracts';
import type { ProfileData, Provider } from '../../lib/api';
import { TYPING_DELAY_MS } from '../../lib/autosave';
import { Button, Field } from '../ui';
import { Select, type SelectOption } from '../ui/select';
import { efforts, modelLabel, optionalRoles, type Role, type roles } from './catalog';

export type RoleValue = {
  providerId: string;
  modelId: string;
  reasoningEffort: string;
  /** The id was typed instead of picked, so the panel knows nothing about its capabilities. */
  manual: boolean;
  disabled: boolean;
};

/** A provider id is a UUID, so the first colon is always where the model id begins. */
export const choiceOf = (providerId: string, modelId: string) =>
  providerId && modelId ? `${providerId}:${modelId}` : '';

const MANUAL = '__manual__:';

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
export function describeRole(
  role: (typeof roles)[number],
  value: RoleValue,
  data: ProfileData,
  configured: Provider[],
) {
  const eligible = configured.filter((provider) => supportsProviderRole(provider, role.key));
  const provider = configured.find((item) => item.id === value.providerId);
  const list = value.providerId ? data.providerModels[value.providerId] : undefined;
  const selected = (list?.models ?? []).find((model) => model.id === value.modelId);
  // A typed id has no capability row here, so every level is offered and the gateway refuses
  // the ones the model does not take.
  const allowed = value.manual
    ? efforts
    : efforts.filter((effort) => selected?.reasoningEfforts.includes(effort.value));

  return { eligible, provider, list, selected, allowed };
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
  /** A delay in ms before saving; a menu choice saves at once, a typed id after a pause. */
  change: (role: Role, patch: Partial<RoleValue>, delay?: number) => void;
}) {
  const { eligible, provider, list, allowed } = describeRole(role, value, data, configured);
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
        <Field
          label="Model"
          hint={
            value.manual
              ? `An id typed by hand for ${provider ? providerName(provider) : 'this provider'}. Use it when the provider publishes no list.`
              : undefined
          }
        >
          {value.manual ? (
            <input
              type="text"
              value={value.modelId}
              disabled={busy}
              maxLength={160}
              placeholder="Model id"
              onChange={(event) =>
                change(role.key, { modelId: event.target.value }, TYPING_DELAY_MS)
              }
            />
          ) : (
            <Select
              value={current}
              disabled={busy}
              onValueChange={(choice) => {
                if (choice === 'disabled') {
                  change(role.key, {
                    providerId: '',
                    modelId: '',
                    reasoningEffort: '',
                    manual: false,
                    disabled: true,
                  });
                } else if (!choice) {
                  change(role.key, {
                    providerId: '',
                    modelId: '',
                    reasoningEffort: '',
                    manual: false,
                    disabled: false,
                  });
                } else if (choice.startsWith(MANUAL)) {
                  change(role.key, {
                    providerId: choice.slice(MANUAL.length),
                    modelId: '',
                    reasoningEffort: '',
                    manual: true,
                    disabled: false,
                  });
                } else {
                  const split = choice.indexOf(':');

                  change(role.key, {
                    providerId: choice.slice(0, split),
                    modelId: choice.slice(split + 1),
                    reasoningEffort: '',
                    manual: false,
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
                ...eligible.map((item) => ({
                  value: `${MANUAL}${item.id}`,
                  label: 'Type an id…',
                  detail: providerName(item),
                })),
              ]}
            />
          )}
        </Field>
        {value.manual && (
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => change(role.key, { manual: false, modelId: '', reasoningEffort: '' })}
          >
            Choose from the list
          </Button>
        )}
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
