'use client';

import { Brain, Link2, Pencil, Search, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { Memory } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Confirm, Empty, ResourceRow, SectionHeading } from '../ui';
import { MemoryEditor } from './editor';

/**
 * What the agent kept across this profile's conversations. Each entry shows the others it is
 * recalled with; a link opens the memory it points to, so a topic can be followed by hand.
 */
export function Memories({ profile, data, api, mutate, busy }: SectionProps) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<string>();
  const [removing, setRemoving] = useState<Memory>();
  const [focused, setFocused] = useState<string>();
  const terms = query.trim().toLowerCase();

  const found = data.memories.filter((item) =>
    terms ? `${item.key} ${item.content}`.toLowerCase().includes(terms) : true,
  );
  const memory = data.memories.find((item) => item.key === editing);

  const follow = (key: string) => {
    setQuery('');
    setFocused(key);
    // After the list has drawn it again without the filter.
    requestAnimationFrame(() =>
      document
        .getElementById(`memory-${key}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
    );
  };

  return (
    <>
      <SectionHeading
        title="Memories"
        description="What the agent kept across its conversations. Linked memories are recalled together."
      />
      <div className="memory-toolbar">
        <div className="search-field">
          <Search size={16} />
          <input
            type="search"
            aria-label="Search memories"
            value={query}
            placeholder="Search"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>
      {found.length ? (
        <div className="resource-list">
          {found.map((item) => (
            <div
              key={item.key}
              id={`memory-${item.key}`}
              className="memory-row"
              data-focused={focused === item.key}
              onAnimationEnd={() => setFocused(undefined)}
            >
              <ResourceRow
                id={`memory-row-${item.key}`}
                icon={<Brain size={20} strokeWidth={1.6} />}
                name={item.key}
                badges={<Badge dot={false}>v{item.version}</Badge>}
                description={item.content}
                facts={[
                  `Updated ${date(item.updatedAt)}`,
                  item.sourceSessionId ? 'Written in a conversation' : 'Edited by you',
                ]}
                extra={
                  item.links?.length ? (
                    <ul className="memory-links" aria-label={`Recalled with ${item.key}`}>
                      {item.links.map((key) => (
                        <li key={key}>
                          <button type="button" onClick={() => follow(key)}>
                            <Link2 size={12} />
                            {key}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : undefined
                }
                actions={
                  <>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Edit ${item.key}`}
                      onClick={() => setEditing(item.key)}
                    >
                      <Pencil size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Delete ${item.key}`}
                      onClick={() => setRemoving(item)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </>
                }
              />
            </div>
          ))}
        </div>
      ) : data.memories.length ? (
        <Empty title="Nothing found">No memory matches that search.</Empty>
      ) : (
        <Empty title="A place for what matters">
          The agent has kept nothing yet. What it records during conversations shows up here.
        </Empty>
      )}
      {memory && (
        <MemoryEditor
          key={memory.key}
          memory={memory}
          all={data.memories}
          busy={busy}
          close={() => setEditing(undefined)}
          save={(content) =>
            mutate(
              () => api.editMemory(profile.id, memory.key, content, memory.version),
              'Memory saved.',
            )
          }
          link={(key) =>
            mutate(() => api.linkMemories(profile.id, memory.key, key), `Linked to ${key}.`)
          }
          unlink={(key) =>
            mutate(() => api.unlinkMemories(profile.id, memory.key, key), `Unlinked from ${key}.`)
          }
        />
      )}
      {removing && (
        <Confirm
          title={`Delete ${removing.key}?`}
          description={`The agent stops reading this entry on its next runs${
            removing.links?.length ? ', and its links go with it' : ''
          }. This cannot be undone.`}
          busy={busy}
          close={() => setRemoving(undefined)}
          confirm={async () => {
            if (await mutate(() => api.forget(profile.id, removing.key), 'Memory deleted.')) {
              setRemoving(undefined);
            }
          }}
        />
      )}
    </>
  );
}
