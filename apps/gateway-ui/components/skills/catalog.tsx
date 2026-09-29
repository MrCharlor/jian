'use client';

import { Check, Download, ExternalLink, LoaderCircle, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GatewayApi } from '../../lib/api';
import type { SectionProps } from '../props';
import { Button, Confirm, ProviderLogo } from '../ui';

const sources = [
  {
    id: 'claude',
    name: 'Claude',
    publisher: 'Anthropic',
    logo: 'anthropic',
    url: 'https://github.com/anthropics/skills/tree/main/skills',
  },
  {
    id: 'codex',
    name: 'Codex',
    publisher: 'OpenAI',
    logo: 'openai',
    url: 'https://github.com/openai/skills/tree/main/skills/.curated',
  },
] as const;
type Entry = Awaited<ReturnType<GatewayApi['skillCatalog']>>['entries'][number];

export function SkillCatalog({
  profile,
  api,
  mutate,
  busy,
}: Pick<SectionProps, 'profile' | 'api' | 'mutate' | 'busy'>) {
  const [source, setSource] = useState<(typeof sources)[number]>(sources[0]);
  const [catalogs, setCatalogs] = useState<Record<string, Entry[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [retry, setRetry] = useState(0);
  const [replacing, setReplacing] = useState<Entry>();
  const entries = catalogs[source.id];
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly restarts a failed read.
  useEffect(() => {
    if (entries) {
      setLoading(false);
      setError('');
      return;
    }
    let alive = true;
    setLoading(true);
    setError('');
    api
      .skillCatalog(profile.id, source.url)
      .then((catalog) => {
        if (alive) setCatalogs((current) => ({ ...current, [source.id]: catalog.entries }));
      })
      .catch((failure) => {
        if (alive)
          setError(failure instanceof Error ? failure.message : 'The catalog could not be loaded.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, profile.id, source, entries, retry]);
  const importEntry = async (entry: Entry) => {
    if (await mutate(() => api.importSkill(profile.id, entry.url), `Skill ${entry.name} imported.`))
      setReplacing(undefined);
  };
  const filtered = (entries ?? []).filter((entry) =>
    `${entry.name} ${entry.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  return (
    <section className="row-group" aria-labelledby="skills-browse">
      <h2 id="skills-browse">Browse</h2>
      <p>Official catalogs, ready to add to this agent. {profile.skills.length} of 20 installed.</p>
      <div className="catalog-toolbar">
        <fieldset className="catalog-sources">
          <legend className="sr-only">Where the skills come from</legend>
          {sources.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-pressed={source.id === item.id}
              onClick={() => {
                setSource(item);
                setQuery('');
              }}
            >
              <ProviderLogo kind={item.logo} size={18} />
              <strong>{item.name}</strong>
              <small>{item.publisher}</small>
            </button>
          ))}
        </fieldset>
        <div className="search-field">
          <Search size={16} />
          <input
            aria-label="Search the catalog"
            placeholder="Search skills…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>
      <p className="catalog-note">
        Imports the instructions in SKILL.md. Scripts and supporting files are not installed.
      </p>
      {loading ? (
        <div className="catalog-loading" role="status">
          <LoaderCircle size={20} className="spin" />
          Loading {source.name}…
        </div>
      ) : error ? (
        <div className="history-error" role="alert">
          <p>{error}</p>
          <Button variant="secondary" onClick={() => setRetry((value) => value + 1)}>
            Try again
          </Button>
        </div>
      ) : filtered.length ? (
        <div className="skill-catalog-grid">
          {filtered.map((entry) => {
            const existing = profile.skills.find((skill) => skill.name === entry.name);
            const installed =
              existing?.origin?.url.replace(/\/(?:SKILL\.md)?$/, '') ===
              entry.url.replace(/\/(?:SKILL\.md)?$/, '');
            return (
              <article className="skill-catalog-card" key={entry.url}>
                <div className="skill-catalog-title">
                  <h3>{entry.name}</h3>
                </div>
                {entry.description !== 'Skill in this repository' && <p>{entry.description}</p>}
                <footer>
                  <span className="catalog-publisher">
                    <ProviderLogo kind={source.logo} size={14} />
                    {source.publisher}
                  </span>
                  <span className="catalog-actions">
                    <a className="button quiet" href={entry.url} target="_blank" rel="noreferrer">
                      <ExternalLink size={14} />
                      View
                    </a>
                    <Button
                      variant="quiet"
                      disabled={busy || installed || (!existing && profile.skills.length >= 20)}
                      onClick={() => (existing ? setReplacing(entry) : void importEntry(entry))}
                    >
                      {installed ? <Check size={14} /> : <Download size={14} />}
                      {installed ? 'Installed' : existing ? 'Replace' : 'Add'}
                    </Button>
                  </span>
                </footer>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="catalog-loading">No skill found.</div>
      )}
      {replacing && (
        <Confirm
          title={`Replace ${replacing.name}?`}
          description="This agent already has a skill with that name. Its instructions will be replaced by the catalog's."
          busy={busy}
          close={() => setReplacing(undefined)}
          confirm={() => void importEntry(replacing)}
        />
      )}
    </section>
  );
}
