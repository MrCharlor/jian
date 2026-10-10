'use client';

import { Eye, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BuiltinSkill } from '../../lib/api';
import type { SectionProps } from '../props';
import { Button, ResourceRow, Switch } from '../ui';
import { SkillView } from './skill-view';

/**
 * Skills that ship with the gateway. The owner cannot edit one, so the instructions are shown
 * in full: what an agent was told has to be readable by the person answering for it.
 */
export function BuiltinSkills({
  profile,
  api,
  mutate,
  busy,
}: Pick<SectionProps, 'profile' | 'api' | 'mutate' | 'busy'>) {
  const [skills, setSkills] = useState<BuiltinSkill[]>();
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: a toggle bumps the version, and the enabled flags are what must be read again.
  useEffect(() => {
    let alive = true;

    api
      .builtinSkills(profile.id)
      .then((list) => alive && setSkills(list))
      .catch(
        (failure) =>
          alive && setError(failure instanceof Error ? failure.message : 'Could not load.'),
      );

    return () => {
      alive = false;
    };
  }, [api, profile.id, profile.version]);

  const toggle = (skill: BuiltinSkill) =>
    mutate(
      () =>
        api.updateProfile(profile.id, {
          expectedVersion: profile.version,
          disabledSkills: skill.enabled
            ? [...profile.disabledSkills, skill.name]
            : profile.disabledSkills.filter((name) => name !== skill.name),
        }),
      skill.enabled ? `${skill.name} switched off.` : `${skill.name} switched on.`,
    );

  if (error) {
    return (
      <p className="form-error" role="alert">
        {error}
      </p>
    );
  }

  const viewing = skills?.find((skill) => skill.name === open);

  return (
    <section className="row-group" aria-labelledby="skills-built-in">
      <h2 id="skills-built-in">Built in</h2>
      <p>They ship with the gateway and teach the agent to use what Atena gives it.</p>
      <div className="resource-list">
        {(skills ?? []).map((skill) => (
          <ResourceRow
            key={skill.name}
            id={`skill-${skill.name}`}
            icon={<ShieldCheck size={20} strokeWidth={1.6} />}
            name={skill.name}
            description={skill.description}
            facts={skill.origin ? [`From ${skill.origin.marketplace ?? 'a marketplace'}`] : []}
            actions={
              <>
                <Button variant="quiet" onClick={() => setOpen(skill.name)}>
                  <Eye size={16} />
                  View
                </Button>
                <Switch
                  checked={skill.enabled}
                  label={`${skill.name} ${skill.enabled ? 'on' : 'off'}`}
                  disabled={busy}
                  onChange={() => void toggle(skill)}
                />
              </>
            }
          />
        ))}
      </div>
      {viewing && (
        <SkillView
          name={viewing.name}
          description={viewing.description}
          instructions={viewing.instructions}
          close={() => setOpen(undefined)}
        />
      )}
    </section>
  );
}
