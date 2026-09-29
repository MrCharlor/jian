'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import type { GatewayApi, ProfileData, ReasoningEffort, Session } from '../../lib/api';
import { efforts, usableProviders } from '../providers/catalog';
import { choiceOf, modelChoices } from '../providers/role-fields';
import { Select } from '../ui/select';

/**
 * The model one conversation runs on, over the profile's defaults, and its reasoning effort.
 * It applies from the next turn; one already under way keeps the model it started with.
 */
export function SessionModel({
  api,
  profileId,
  session,
  data,
  channel,
  saved,
}: {
  api: GatewayApi;
  profileId: string;
  session: Session;
  data: ProfileData;
  /** A WhatsApp or Telegram conversation, which follows the Channels default. */
  channel: boolean;
  saved: () => void;
}) {
  const [model, setModel] = useState(session.model);
  const [busy, setBusy] = useState(false);
  const choices = modelChoices('conversation', data, usableProviders(data));
  const current = model ? choiceOf(model.providerId, model.modelId) : '';
  const listed = model
    ? data.providerModels[model.providerId]?.models.find((item) => item.id === model.modelId)
    : undefined;
  const allowed = efforts.filter((effort) => listed?.reasoningEfforts.includes(effort.value));
  const fallback =
    (channel ? data.modelDefaults.channel : undefined) ?? data.modelDefaults.conversation;
  const fallbackName = fallback
    ? (data.providerModels[fallback.providerId]?.models.find((item) => item.id === fallback.modelId)
        ?.displayName ?? fallback.modelId)
    : 'Automatic';

  const save = async (next: Session['model']) => {
    const previous = model;

    setModel(next);
    setBusy(true);

    try {
      await api.setSessionModel(profileId, session.id, next ?? null);
      saved();
    } catch (error) {
      setModel(previous);
      toast.error(error instanceof Error ? error.message : 'The model could not be changed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="session-model">
      <Select
        aria-label="Model for this conversation"
        value={current}
        disabled={busy}
        onValueChange={(choice) => {
          if (!choice) return void save(undefined);

          const split = choice.indexOf(':');

          void save({ providerId: choice.slice(0, split), modelId: choice.slice(split + 1) });
        }}
        options={[
          { value: '', label: 'Agent default', detail: fallbackName },
          ...choices,
          ...(current && !choices.some((choice) => choice.value === current)
            ? [{ value: current, label: model?.modelId ?? current, detail: 'No longer offered' }]
            : []),
        ]}
      />
      <Select
        aria-label="Reasoning effort for this conversation"
        value={model?.reasoningEffort ?? ''}
        disabled={busy || !model || !allowed.length}
        onValueChange={(effort) =>
          model &&
          void save({
            providerId: model.providerId,
            modelId: model.modelId,
            ...(effort ? { reasoningEffort: effort as ReasoningEffort } : {}),
          })
        }
        options={[{ value: '', label: 'Default effort' }, ...allowed]}
      />
    </div>
  );
}
