'use client';

import { Plus } from 'lucide-react';
import { useWorkspace } from '../../lib/workspace';
import { Avatar } from '../profile/avatar-field';
import { Select } from '../ui/select';

export function ProfileSwitcher({ onCreate }: { onCreate: () => void }) {
  const { profiles, profile, selected, select, busy } = useWorkspace();
  return (
    <div className="profile-selector">
      <Select
        aria-label="Active agent"
        className="profile-trigger"
        value={selected}
        onValueChange={select}
        disabled={busy}
        searchThreshold={5}
        options={profiles.map((item) => ({
          value: item.id,
          label: item.name,
          icon: <Avatar name={item.name} avatar={item.avatar} className="mini-avatar" />,
        }))}
        renderValue={() => (
          <>
            <Avatar name={profile?.name} avatar={profile?.avatar} className="mini-avatar" />
            <span className="profile-trigger-copy">
              <small>Active agent</small>
              <strong>{profile?.name ?? 'Select an agent'}</strong>
            </span>
          </>
        )}
        footer={(close) => (
          <button
            type="button"
            onClick={() => {
              close();
              onCreate();
            }}
          >
            <Plus size={16} />
            New agent
          </button>
        )}
      />
    </div>
  );
}
