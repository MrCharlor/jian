'use client';

import { AppWindow, ArrowLeft, Plus, Save } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Application, ApplicationFile } from '../../lib/api';
import { date } from '../../lib/format';
import type { SectionProps } from '../props';
import { Badge, Button, Empty, Field, Modal, ResourceRow, SectionHeading } from '../ui';
import { Markdown } from '../ui/markdown';
import { Prototypes } from './prototypes';

const PREFERENCES = 'project/preferencias-do-po.md';
const README = 'project/README.md';
const TOKENS = 'project/tokens.json';

const platforms: Record<Application['platform'], string> = {
  web: 'Web',
  mobile: 'Celular',
  desktop: 'Desktop',
  other: 'Outra',
};

type Tab = 'guide' | 'prototypes' | 'preferences' | 'components' | 'tokens';

const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'guide', label: 'Guia' },
  { id: 'preferences', label: 'Preferências do PO' },
  { id: 'components', label: 'Componentes' },
  { id: 'tokens', label: 'Tokens' },
  { id: 'prototypes', label: 'Protótipos' },
];

/** The products the owner designs for; a new one is a form, never code. */
export function Applications({ api, mutate, busy, profile }: SectionProps) {
  const [list, setList] = useState<Application[]>();
  const [error, setError] = useState('');
  // Kept in the address, so a refresh of the workspace or a reload lands on the same screen.
  const router = useRouter();
  const query = useSearchParams();
  const open = query.get('app') ?? undefined;
  const setOpen = (slug: string | undefined) =>
    router.replace(slug ? `/applications/?app=${encodeURIComponent(slug)}` : '/applications/');
  const [creating, setCreating] = useState(false);

  const load = useCallback(
    () =>
      api
        .applications()
        .then((items) => {
          setList(items);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'As aplicações não carregaram.'),
        ),
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const current = list?.find((item) => item.slug === open);

  if (current) {
    return (
      <ApplicationDetail
        application={current}
        api={api}
        profileId={profile.id}
        back={() => setOpen(undefined)}
      />
    );
  }

  return (
    <>
      <SectionHeading
        title="Aplicações"
        description="Os produtos para os quais os agentes desenham telas, cada um com o seu design system."
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} />
            Nova aplicação
          </Button>
        }
      />
      {error && <p className="error">{error}</p>}
      {list && !list.length ? (
        <Empty title="Nenhuma aplicação ainda">
          Crie uma aplicação e traga o design system dela. Os agentes leem daqui antes de desenhar.
        </Empty>
      ) : (
        (list ?? []).map((item) => (
          <ResourceRow
            key={item.slug}
            id={`application-${item.slug}`}
            icon={<AppWindow size={20} strokeWidth={1.6} />}
            name={item.name}
            badges={
              <>
                <Badge dot={false}>{platforms[item.platform]}</Badge>
                {item.files ? (
                  <Badge tone="good">{item.files} arquivos</Badge>
                ) : (
                  <Badge tone="warn">Sem design system</Badge>
                )}
              </>
            }
            description={item.audience ?? item.url ?? item.slug}
            facts={[
              `Versão ${item.version}`,
              `Atualizada em ${date(item.updatedAt)}`,
              ...(item.source ? ['Vem do Claude Design'] : []),
            ]}
            action="Abrir"
            onToggle={() => setOpen(item.slug)}
          />
        ))
      )}
      {creating && (
        <NewApplication
          busy={busy}
          close={() => setCreating(false)}
          create={async (input) => {
            const ok = await mutate(() => api.createApplication(input), `${input.name} criada.`);

            if (ok) {
              setCreating(false);
              await load();
            }
          }}
        />
      )}
    </>
  );
}

function NewApplication({
  busy,
  close,
  create,
}: {
  busy: boolean;
  close: () => void;
  create: (input: {
    slug: string;
    name: string;
    url?: string;
    audience?: string;
    platform: Application['platform'];
  }) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [audience, setAudience] = useState('');
  const [platform, setPlatform] = useState<Application['platform']>('web');
  const slug = name
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return (
    <Modal
      title="Nova aplicação"
      description="Ela nasce com o design system em branco. Depois você traz um do Claude Design ou gera a partir de prints."
      close={close}
      footer={
        <>
          <Button variant="quiet" onClick={close}>
            Cancelar
          </Button>
          <Button
            disabled={busy || !slug}
            onClick={() =>
              void create({
                slug,
                name: name.trim(),
                ...(url.trim() ? { url: url.trim() } : {}),
                ...(audience.trim() ? { audience: audience.trim() } : {}),
                platform,
              })
            }
          >
            Criar aplicação
          </Button>
        </>
      }
    >
      <div className="settings-fields">
        <Field label="Nome" hint={slug ? `Identificador: ${slug}` : undefined}>
          <input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Endereço" hint="Onde ela roda, se já existir.">
          <input value={url} type="url" onChange={(event) => setUrl(event.target.value)} />
        </Field>
        <Field label="Quem usa">
          <input
            value={audience}
            maxLength={500}
            onChange={(event) => setAudience(event.target.value)}
          />
        </Field>
        <Field label="Plataforma">
          <select
            value={platform}
            onChange={(event) => setPlatform(event.target.value as Application['platform'])}
          >
            {Object.entries(platforms).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

function ApplicationDetail({
  application,
  api,
  profileId,
  back,
}: {
  application: Application;
  api: SectionProps['api'];
  profileId: string;
  back: () => void;
}) {
  const [tab, setTab] = useState<Tab>('guide');
  const [files, setFiles] = useState<ApplicationFile[]>();
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [draft, setDraft] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [component, setComponent] = useState<string>();
  const [preview, setPreview] = useState<string>();

  const read = useCallback(
    async (path: string) => {
      if (texts[path] !== undefined) return texts[path];

      const file = await api.applicationFile(application.slug, path).catch(() => undefined);
      const text = file?.text ?? '';

      setTexts((current) => ({ ...current, [path]: text }));
      return text;
    },
    [api, application.slug, texts],
  );

  useEffect(() => {
    void api
      .applicationFiles(application.slug)
      .then(setFiles)
      .catch(() => setFiles([]));
  }, [api, application.slug]);

  useEffect(() => {
    if (tab === 'guide') void read(README);
    if (tab === 'tokens') void read(TOKENS);
    if (tab === 'preferences')
      void read(PREFERENCES).then((text) => setDraft((current) => current ?? text));
  }, [tab, read]);

  const components = useMemo(
    () =>
      (files ?? [])
        .map((file) => /^project\/components\/([^/]+)\/preview\.html$/.exec(file.path)?.[1])
        .filter((name): name is string => Boolean(name) && name !== 'Cover'),
    [files],
  );

  const showComponent = async (name: string) => {
    setComponent(name);
    setPreview(undefined);
    void read(`project/components/${name}/README.md`);

    const link = await api
      .applicationPreview(application.slug, `project/components/${name}/preview.html`)
      .catch(() => undefined);

    setPreview(link?.url);
  };

  const save = async () => {
    if (draft === undefined) return;
    setSaving(true);

    try {
      await api.writeApplicationFile(application.slug, PREFERENCES, draft);
      setTexts((current) => ({ ...current, [PREFERENCES]: draft }));
      setNotice('Preferências salvas. Os agentes leem a versão nova na próxima tela.');
    } catch (failure) {
      setNotice(failure instanceof Error ? failure.message : 'Não foi possível salvar.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <SectionHeading
        title={application.name}
        description={[platforms[application.platform], application.audience, application.url]
          .filter(Boolean)
          .join(' · ')}
        action={
          <Button variant="quiet" onClick={back}>
            <ArrowLeft size={16} />
            Aplicações
          </Button>
        }
      />
      <div className="application-tabs" role="tablist">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'active' : ''}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'guide' && (
        <article className="application-doc">
          {texts[README] ? (
            <Markdown text={texts[README]} />
          ) : (
            <p className="note">Sem guia ainda.</p>
          )}
        </article>
      )}

      {tab === 'preferences' && (
        <div className="settings-fields">
          <p className="note">
            Regras suas, que valem por cima do guia. Uma por linha, com a data. Os agentes leem isto
            primeiro.
          </p>
          <textarea
            className="application-preferences"
            rows={16}
            value={draft ?? ''}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div>
            <Button disabled={saving || draft === texts[PREFERENCES]} onClick={() => void save()}>
              <Save size={16} />
              Salvar preferências
            </Button>
          </div>
          {notice && <p className="note">{notice}</p>}
        </div>
      )}

      {tab === 'components' && (
        <div className="application-components">
          <nav aria-label="Componentes">
            {components.length ? (
              components.map((name) => (
                <button
                  key={name}
                  type="button"
                  className={component === name ? 'active' : ''}
                  onClick={() => void showComponent(name)}
                >
                  {name}
                </button>
              ))
            ) : (
              <p className="note">Nenhum componente ainda.</p>
            )}
          </nav>
          <section>
            {component ? (
              <>
                {preview ? (
                  <iframe
                    title={`Prévia de ${component}`}
                    src={preview}
                    sandbox="allow-scripts"
                    className="application-preview"
                  />
                ) : (
                  <p className="note">Carregando a prévia…</p>
                )}
                {texts[`project/components/${component}/README.md`] && (
                  <article className="application-doc">
                    <Markdown text={texts[`project/components/${component}/README.md`] ?? ''} />
                  </article>
                )}
              </>
            ) : (
              <p className="note">Escolha um componente para ver a prévia e as notas de uso.</p>
            )}
          </section>
        </div>
      )}

      {tab === 'tokens' && (
        <pre className="application-tokens">{texts[TOKENS] || 'Sem tokens ainda.'}</pre>
      )}

      {tab === 'prototypes' && (
        <Prototypes application={application} api={api} profileId={profileId} />
      )}
    </>
  );
}
