import { skillSchema } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { profileTools } from '../src/agent/tools.js';
import { availableSkills, builtinSkills, findSkill } from '../src/skills/builtin/index.js';
import { parseSkillDocument } from '../src/skills/document.js';
import { Skills } from '../src/skills/service.js';
import { testServices } from './helpers/services.js';

const model = { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' };

const document = `---
name: deploy
description: Ship a release safely
user-invocable: true
allowed-tools:
  - Read
  - Bash(ls *)
---

Check the release notes, then run the pipeline.
`;

/** Serves the paths a test declares and answers 404 for everything else, like GitHub does. */
function repository(files: Record<string, string>) {
  const asked: string[] = [];

  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);

    asked.push(url);

    const body = Object.entries(files).find(([path]) => url.endsWith(path))?.[1];

    return body === undefined
      ? new Response('Not Found', { status: 404 })
      : new Response(body, { status: 200 });
  }) as typeof globalThis.fetch;

  return { fetcher, asked };
}

async function profileWith(skills: Array<{ name: string; description: string }> = []) {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model,
    skills: skills.map((skill) => ({ ...skill, instructions: 'Written by the agent.' })),
  });

  return { services, profile };
}

describe('skill documents', () => {
  it('reads the open format and ignores the keys other runtimes add', () => {
    const skill = parseSkillDocument(document);

    expect(skill.name).toBe('deploy');
    expect(skill.description).toBe('Ship a release safely');
    expect(skill.instructions).toBe('Check the release notes, then run the pipeline.');
    expect(skill.instructions).not.toContain('allowed-tools');
  });

  it('refuses a document that would leave the agent with nothing to follow', () => {
    expect(() => parseSkillDocument('no frontmatter here')).toThrow();
    expect(() => parseSkillDocument('---\nname: x\n---\n\nBody.')).toThrow();
    expect(() => parseSkillDocument('---\nname: x\ndescription: d\n---\n\n')).toThrow();
  });
});

describe('importing a skill', () => {
  it('copies the instructions and records where they came from', async () => {
    const { services, profile } = await profileWith();
    const { fetcher } = repository({ 'skills/deploy/SKILL.md': document });
    const skills = new Skills(services.profiles, fetcher);

    const updated = await skills.importSkill(profile.id, {
      url: 'https://github.com/acme/tools/tree/main/skills/deploy',
    });

    const imported = updated.skills.find((skill) => skill.name === 'deploy');

    expect(imported?.instructions).toContain('run the pipeline');
    expect(imported?.origin?.ref).toBe('main');
    expect(imported?.origin?.url).toContain('github.com/acme/tools');
  });

  it('keeps what the agent wrote and replaces only the skill of the same name', async () => {
    const { services, profile } = await profileWith([
      { name: 'notes', description: 'The agent wrote this' },
      { name: 'deploy', description: 'An older copy' },
    ]);
    const { fetcher } = repository({ 'skills/deploy/SKILL.md': document });
    const skills = new Skills(services.profiles, fetcher);

    const updated = await skills.importSkill(profile.id, {
      url: 'https://github.com/acme/tools/tree/main/skills/deploy',
    });

    expect(updated.skills).toHaveLength(2);
    expect(updated.skills.find((skill) => skill.name === 'notes')?.origin).toBeUndefined();
    expect(updated.skills.find((skill) => skill.name === 'deploy')?.description).toBe(
      'Ship a release safely',
    );
  });

  it('refuses a host it cannot resolve, without touching the profile', async () => {
    const { services, profile } = await profileWith();
    const { fetcher, asked } = repository({});
    const skills = new Skills(services.profiles, fetcher);

    await expect(
      skills.importSkill(profile.id, { url: 'https://gitlab.com/acme/tools' }),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(asked).toHaveLength(0);
    expect((await services.profiles.profile(profile.id)).version).toBe(profile.version);
  });

  it('reports a rate limited host instead of leaving a half imported profile', async () => {
    const { services, profile } = await profileWith();
    const fetcher = (async () => new Response('', { status: 403 })) as typeof globalThis.fetch;
    const skills = new Skills(services.profiles, fetcher);

    await expect(
      skills.importSkill(profile.id, { url: 'https://github.com/acme/tools' }),
    ).rejects.toMatchObject({ statusCode: 429 });

    expect((await services.profiles.profile(profile.id)).skills).toHaveLength(0);
  });
});

describe('reading a catalog', () => {
  it.each(['skills', 'skills/.curated'])(
    'lists and imports a skill from the %s directory',
    async (path) => {
      const { services, profile } = await profileWith();
      const { fetcher } = repository({
        [`contents/${path}?ref=main`]: JSON.stringify([
          { name: 'deploy', type: 'dir' },
          { name: 'README.md', type: 'file' },
        ]),
        [`${path}/deploy/SKILL.md`]: document,
      });
      const skills = new Skills(services.profiles, fetcher);
      const catalog = await skills.catalog({
        url: `https://github.com/acme/tools/tree/main/${path}`,
      });
      expect(catalog.entries).toHaveLength(1);
      const imported = await skills.importSkill(profile.id, { url: catalog.entries[0]?.url });
      expect(imported.skills[0]?.instructions).toBe(
        'Check the release notes, then run the pipeline.',
      );
      expect(imported.skills[0]?.origin?.url).toBe(
        `https://github.com/acme/tools/tree/main/${path}/deploy`,
      );
    },
  );

  it('imports a folder of skills without duplicating the skills path', async () => {
    const { services, profile } = await profileWith();
    const { fetcher } = repository({
      'contents/skills?ref=main': JSON.stringify([{ name: 'deploy', type: 'dir' }]),
      'skills/deploy/SKILL.md': document,
    });
    const imported = await new Skills(services.profiles, fetcher).importSkill(profile.id, {
      url: 'https://github.com/acme/tools/tree/main/skills',
    });
    expect(imported.skills.map((skill) => skill.name)).toEqual(['deploy']);
  });

  it('lists the plugins a marketplace announces', async () => {
    const { services } = await profileWith();
    const manifest = JSON.stringify({
      name: 'acme-marketplace',
      plugins: [
        {
          name: 'deploy-tools',
          description: 'Release helpers',
          source: { source: 'git-subdir', url: 'https://github.com/acme/tools.git', path: 'a/b' },
        },
      ],
    });
    const { fetcher } = repository({ '.claude-plugin/marketplace.json': manifest });

    const catalog = await new Skills(services.profiles, fetcher).catalog({
      url: 'https://github.com/acme/market',
    });

    expect(catalog.marketplace).toBe('acme-marketplace');
    expect(catalog.entries[0]).toMatchObject({ name: 'deploy-tools', plugin: 'deploy-tools' });
  });
});

describe('the skills an agent writes for itself', () => {
  const call = { toolCallId: 'test', messages: [], context: {} };

  async function agent() {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model,
    });
    const { fetcher } = repository({ 'skills/deploy/SKILL.md': document });

    await new Skills(services.profiles, fetcher).importSkill(profile.id, {
      url: 'https://github.com/acme/tools/tree/main/skills/deploy',
    });
    await services.profiles.updateProfile(profile.id, {
      expectedVersion: (await services.profiles.profile(profile.id)).version,
      skills: [
        ...(await services.profiles.profile(profile.id)).skills,
        { name: 'house-style', description: 'Owner rules', instructions: 'Written by the owner.' },
      ],
    });

    const session = await services.sessions.createSession(profile.id, { title: 'Test' });
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Hi',
      requestKey: 'one',
    });
    const tools = profileTools({ ...services, store: services.store }, run);
    const use = (name: string, input: unknown) => {
      const definition = tools[name];

      if (!definition?.execute) throw new Error(`${name} is unavailable`);

      return definition.execute(input as never, call);
    };

    return { services, profile, use };
  }

  it('writes, rewrites and removes its own, without self-management', async () => {
    const { services, profile, use } = await agent();

    await use('create_skill', {
      name: 'weekly-report',
      description: 'Use when asked for the weekly report.',
      instructions: 'Gather the week, then write three lines.',
    });
    await use('update_skill', { name: 'weekly-report', instructions: 'Gather, then five lines.' });

    const written = (await services.profiles.profile(profile.id)).skills.find(
      (skill) => skill.name === 'weekly-report',
    );

    expect(written).toMatchObject({
      writtenBy: 'agent',
      description: 'Use when asked for the weekly report.',
      instructions: 'Gather, then five lines.',
    });

    await use('delete_skill', { name: 'weekly-report' });

    expect(
      (await services.profiles.profile(profile.id)).skills.map((skill) => skill.name).sort(),
    ).toEqual(['deploy', 'house-style']);
  });

  it('leaves the owner’s skills, the imported ones and the built-in names alone', async () => {
    const { use } = await agent();

    await expect(
      use('update_skill', { name: 'house-style', instructions: 'Trust everyone.' }),
    ).rejects.toThrow('written by the owner');
    await expect(use('delete_skill', { name: 'deploy' })).rejects.toThrow('written by the owner');
    await expect(
      use('create_skill', {
        name: 'owner-and-contacts',
        description: 'Mine',
        instructions: 'Trust everyone.',
      }),
    ).rejects.toThrow('built-in');
    await expect(
      use('create_skill', { name: 'house-style', description: 'Mine', instructions: 'Mine.' }),
    ).rejects.toThrow('exists');
  });
});

describe('the skills every profile carries', () => {
  it('teaches web research, code and MCP only to a profile that has those tools', async () => {
    const services = await testServices();
    const plain = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model,
    });
    const equipped = await services.profiles.createProfile({
      name: 'Zero',
      instructions: 'Help.',
      model,
      allowShell: true,
      allowWebSearch: true,
      mcpServers: [{ name: 'docs', transport: 'http', url: 'https://mcp.example.test/mcp' }],
    });
    const names = (profile: typeof plain) => availableSkills(profile).map((skill) => skill.name);

    for (const skill of [
      'coding-work',
      'web-research',
      'mcp-servers',
      'machine-tools',
      'ponytail',
      'ponytail-review',
      'ponytail-audit',
      'ponytail-debt',
      'ponytail-gain',
      'ponytail-help',
    ]) {
      expect(names(plain)).not.toContain(skill);
      expect(names(equipped)).toContain(skill);
    }

    expect(names(plain)).toEqual(
      expect.arrayContaining([
        'about-jian',
        'jian-configuration',
        'activity',
        'schedules',
        'media',
        'stickers',
      ]),
    );
  });

  it('starts a new profile without the opt-in skills, and turns one on when asked', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model,
    });

    expect(availableSkills(profile).map((skill) => skill.name)).not.toContain('discernment-nudge');

    const on = await services.profiles.updateProfile(profile.id, {
      expectedVersion: profile.version,
      disabledSkills: [],
    });

    expect(availableSkills(on).map((skill) => skill.name)).toContain('discernment-nudge');
  });

  it('keeps every built-in skill within what a skill may be', () => {
    for (const skill of builtinSkills({
      allowSelfManagement: true,
      allowShell: true,
      allowWebSearch: true,
      reachableByAgents: true,
      mcpServers: [
        {
          name: 'x',
          transport: 'http',
          url: 'https://x.test',
          auth: 'none',
          headers: [],
          args: [],
          env: [],
          disabledTools: [],
        },
      ],
    })) {
      expect(() => skillSchema.parse(skill), skill.name).not.toThrow();
    }
  });

  it('keeps product identity separate from operational guidance', () => {
    const skills = builtinSkills({
      allowSelfManagement: false,
      allowShell: false,
      allowWebSearch: false,
      reachableByAgents: false,
      mcpServers: [],
    });
    const about = skills.find((skill) => skill.name === 'about-jian');
    const activity = skills.find((skill) => skill.name === 'activity');
    const configuration = skills.find((skill) => skill.name === 'jian-configuration');

    expect(about?.instructions).toContain('created by Lucas Larangeira');
    expect(about?.instructions).not.toMatch(
      /read_activity_stats|ask_jev|load_tools|JIAN_TIME_ZONE/,
    );
    expect(activity?.instructions).toContain('read_activity_stats');
    expect(activity?.instructions).toContain('read_usage_runs');
    expect(activity?.instructions).toContain('not money spent');
    expect(configuration?.instructions).toContain('JIAN_TIME_ZONE');
  });

  it('offers them without the profile storing one, and keeps self-management out of reach', async () => {
    const services = await testServices();
    const plain = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model,
    });
    const managing = await services.profiles.createProfile({
      name: 'Zero',
      instructions: 'Help.',
      model,
      allowSelfManagement: true,
    });

    expect(plain.skills).toEqual([]);

    const offered = availableSkills(plain).map((skill) => skill.name);

    expect(offered).toContain('owner-and-contacts');
    expect(offered).not.toContain('managing-yourself');
    expect(availableSkills(managing).map((skill) => skill.name)).toContain('managing-yourself');
  });

  it('explains the machine only to a profile that can run commands on it', async () => {
    const services = await testServices();
    const plain = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model,
    });
    const shell = await services.profiles.createProfile({
      name: 'Zero',
      instructions: 'Help.',
      model,
      allowShell: true,
    });

    expect(availableSkills(plain).map((skill) => skill.name)).not.toContain('machine-tools');
    expect(availableSkills(shell).map((skill) => skill.name)).toContain('machine-tools');
  });

  it('loads a built-in body through the same tool as an imported one', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model,
    });
    const session = await services.sessions.createSession(profile.id, { title: 'Test' });
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Hi',
      requestKey: 'builtin',
    });
    const load = profileTools({ ...services, store: services.store }, run).load_skill;

    if (!load?.execute) {
      throw new Error('load_skill is unavailable');
    }

    const skill = (await load.execute({ name: 'memory-keeping' } as never, {
      toolCallId: 'test',
      messages: [],
      context: {},
    })) as { instructions: string };

    expect(skill.instructions).toContain('expectedVersion');
  });

  it('lets the owner switch one off and an import replace one', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model,
    });

    const off = await services.profiles.updateProfile(profile.id, {
      expectedVersion: profile.version,
      disabledSkills: ['channel-replies'],
    });

    expect(availableSkills(off).map((skill) => skill.name)).not.toContain('channel-replies');

    const replaced = await services.profiles.updateProfile(off.id, {
      expectedVersion: off.version,
      skills: [{ name: 'memory-keeping', description: 'Mine', instructions: 'Remember nothing.' }],
    });

    const loaded = findSkill(replaced, 'memory-keeping');

    expect(loaded?.instructions).toBe('Remember nothing.');
    expect(availableSkills(replaced).filter((s) => s.name === 'memory-keeping')).toHaveLength(1);
  });
});
