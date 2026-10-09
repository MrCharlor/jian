import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Generator } from '../src/prototypes/generator.js';
import { Prototypes } from '../src/prototypes/service.js';
import { testServices } from './helpers/services.js';

const text = (value: string) => Buffer.from(value, 'utf8');

const designSystem = [
  { path: 'project/README.md', data: text('# ERP\n\nListagem com filtro e grid.') },
  { path: 'project/preferencias-do-po.md', data: text('- Dados em toda tela.') },
  { path: 'project/components/Button/README.md', data: text('# Button') },
  { path: 'project/fonts/poppins.woff2', data: Buffer.from([1, 2, 3]) },
];

/** A stand-in for Claude Code: records what it was given and writes the screen it is asked for. */
function fakeClaude(behaviour: 'draw' | 'fail' | 'nothing' = 'draw') {
  const seen: Array<{ folder: string; pedido: string; claude: string; previous?: string }> = [];
  const generator: Generator = async (folder) => {
    seen.push({
      folder,
      pedido: await readFile(join(folder, 'pedido.md'), 'utf8'),
      claude: await readFile(join(folder, 'CLAUDE.md'), 'utf8'),
      previous: await readFile(join(folder, 'anterior.html'), 'utf8').catch(() => undefined),
    });

    if (behaviour === 'fail') return { ok: false, error: 'Not logged in · Please run /login' };
    if (behaviour === 'draw') {
      await writeFile(
        join(folder, 'prototipo.html'),
        `<!doctype html><p>versão ${seen.length}</p>`,
      );
    }

    return { ok: true };
  };

  return { generator, seen };
}

async function fixture(behaviour: 'draw' | 'fail' | 'nothing' = 'draw') {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Subaru',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });

  await services.applications.create({ slug: 'erp', name: 'VXCASE ERP' });
  await services.applications.put('erp', designSystem);

  const claude = fakeClaude(behaviour);
  const root = await mkdtemp(join(tmpdir(), 'jian-prototypes-'));
  const prototypes = new Prototypes(
    services.store,
    services.applications,
    services.quality,
    claude.generator,
    root,
  );

  return { services, profile, prototypes, claude };
}

const request = {
  application: 'erp',
  title: 'Cores de Aparelhos',
  requestUrl: 'https://work.vxcase.com.br/w/ws/b/board?activity=abc',
  brief: 'Listagem das cores com filtro por situação.',
};

describe('prototypes', () => {
  it('refuses an application with no design system', async () => {
    const { services, prototypes } = await fixture();
    await services.applications.create({ slug: 'app', name: 'App Gestores' });

    await expect(
      prototypes.create({ ...request, application: 'app' }, { kind: 'owner' }),
    ).rejects.toThrow('no design system yet');
  });

  it('draws the first version in a folder with the design system, the request and the rules', async () => {
    const { prototypes, claude, profile } = await fixture();
    const created = await prototypes.create(request, { kind: 'owner', profileId: profile.id });

    expect(created.versions).toMatchObject([{ number: 1, status: 'queued' }]);

    await prototypes.drain();

    const [given] = claude.seen;
    expect(given?.pedido).toContain('Listagem das cores com filtro por situação.');
    expect(given?.pedido).toContain(request.requestUrl);
    expect(given?.claude).toContain('preferencias-do-po.md');
    expect(given?.claude).toContain('window.React');
    expect(
      await readFile(
        join(given?.folder ?? '', 'design-system', 'project', 'README.md'),
        'utf8',
      ).catch(() => 'cleaned'),
    ).toBe('cleaned');

    const ready = await prototypes.get(created.id);
    expect(ready.versions).toMatchObject([{ number: 1, status: 'ready' }]);
    expect((await prototypes.html(created.id, 1)).html).toContain('versão 1');
  });

  it('makes the next version from the last one and the comments, and counts them as a correction', async () => {
    const { services, prototypes, claude, profile } = await fixture();
    const created = await prototypes.create(request, { kind: 'owner', profileId: profile.id });
    await prototypes.drain();

    await prototypes.redo(created.id, { comments: 'Falta a coluna Responsável.' });
    await prototypes.drain();

    expect(claude.seen[1]?.pedido).toContain('Falta a coluna Responsável.');
    expect(claude.seen[1]?.previous).toContain('versão 1');
    expect((await prototypes.get(created.id)).versions.map((version) => version.status)).toEqual([
      'ready',
      'ready',
    ]);

    const [row] = await services.quality.report(profile.id);
    expect(row).toMatchObject({ automation: 'prototipo:erp', rounds: 2, corrections: 1 });
  });

  it('keeps the error of a failed generation and approves only a ready version', async () => {
    const { prototypes } = await fixture('fail');
    const created = await prototypes.create(request, { kind: 'owner' });
    await prototypes.drain();

    const failed = await prototypes.get(created.id);
    expect(failed.versions[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('/login'),
    });
    await expect(prototypes.approve(created.id, 1)).rejects.toThrow('not ready');
  });

  it('fails a generation that writes nothing, and approves a ready one', async () => {
    const none = await fixture('nothing');
    const empty = await none.prototypes.create(request, { kind: 'owner' });
    await none.prototypes.drain();
    expect((await none.prototypes.get(empty.id)).versions[0]?.error).toContain('without writing');

    const { prototypes } = await fixture();
    const created = await prototypes.create(request, { kind: 'owner' });
    await prototypes.drain();
    expect((await prototypes.approve(created.id, 1)).approvedVersion).toBe(1);
  });

  it('tells the agent that asked when its screen is ready', async () => {
    const { services, prototypes, profile } = await fixture();
    const session = await services.sessions.createSession(profile.id, { title: 'Design' });
    const told: string[] = [];
    prototypes.useNotifier(async (_profile, _session, said) => told.push(said));

    await prototypes.create(request, {
      kind: 'agent',
      profileId: profile.id,
      sessionId: session.id,
    });
    await prototypes.drain();

    expect(told).toEqual([expect.stringContaining('"Cores de Aparelhos", versão 1: pronta')]);
  });
});
