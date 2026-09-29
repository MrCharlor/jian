import { describe, expect, it, vi } from 'vitest';
import { MediaProviders } from '../src/media/providers.js';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBz8AAAAASUVORK5CYII=';
const signal = AbortSignal.timeout(1000);

describe('media providers', () => {
  it('generates an image with the selected OpenAI model', async () => {
    const client = new MediaProviders(async (url, options) => {
      expect(String(url)).toBe('https://api.openai.com/v1/images/generations');
      expect(JSON.parse(String(options?.body))).toMatchObject({
        model: 'gpt-image-2',
        prompt: 'A blue square',
      });
      return Response.json({ data: [{ b64_json: png }] });
    });
    expect(
      await client.generate(
        'image',
        { provider: 'openai', modelId: 'gpt-image-2' },
        'synthetic-key',
        'A blue square',
        undefined,
        signal,
      ),
    ).toMatchObject({ mimeType: 'image/png', data: png });
  });

  it('wraps Gemini PCM speech in a playable WAV file', async () => {
    const client = new MediaProviders(async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      expect(body.generationConfig.responseModalities).toEqual(['AUDIO']);
      expect(body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
        'Leda',
      );
      expect(body.contents[0].parts[0].text).toContain('Speaking style: Meiga e alegre.');
      expect(body.contents[0].parts[0].text).toMatch(/text aloud.*Olá$/s);
      return Response.json({
        candidates: [
          {
            content: {
              parts: [
                {
                  inlineData: {
                    mimeType: 'audio/L16;codec=pcm;rate=24000',
                    data: Buffer.alloc(480).toString('base64'),
                  },
                },
              ],
            },
          },
        ],
      });
    });
    const audio = await client.generate(
      'speech',
      { provider: 'google', modelId: 'gemini-2.5-flash-preview-tts' },
      'synthetic-key',
      'Olá',
      'leda',
      signal,
      undefined,
      'Meiga e alegre.',
    );
    expect(audio.mimeType).toBe('audio/wav');
    expect(Buffer.from(audio.data, 'base64').subarray(0, 4).toString()).toBe('RIFF');
  });

  it('rejects voices from another provider with usable Gemini choices before sending text', async () => {
    let sent = false;
    const client = new MediaProviders(async () => {
      sent = true;
      return Response.json({});
    });
    await expect(
      client.generate(
        'speech',
        { provider: 'google', modelId: 'gemini-2.5-flash-preview-tts' },
        'synthetic-key',
        'Olá',
        'shimmer',
        signal,
      ),
    ).rejects.toThrow(/Gemini.*Kore.*Leda/);
    expect(sent).toBe(false);
  });

  it('keeps speaking instructions separate from the text with OpenAI speech', async () => {
    const client = new MediaProviders(async (_url, options) => {
      expect(JSON.parse(String(options?.body))).toMatchObject({
        input: 'Olá',
        voice: 'nova',
        instructions: 'Speak cheerfully.',
      });
      return new Response('OggS-test');
    });
    const result = await client.generate(
      'speech',
      { provider: 'openai', modelId: 'gpt-4o-mini-tts' },
      'synthetic-key',
      'Olá',
      'Nova',
      signal,
      undefined,
      'Speak cheerfully.',
    );
    expect(result.mimeType).toBe('audio/ogg');
  });

  it('refuses unsupported voices on legacy OpenAI speech models', async () => {
    const client = new MediaProviders(async () => Response.json({}));
    await expect(
      client.generate(
        'speech',
        { provider: 'openai', modelId: 'tts-1' },
        'synthetic-key',
        'Olá',
        'marin',
        signal,
      ),
    ).rejects.toThrow(/tts-1.*nova/);
  });

  it('explains when a legacy speech model cannot honor style instructions', async () => {
    const client = new MediaProviders(async () => Response.json({}));
    await expect(
      client.generate(
        'speech',
        { provider: 'openai', modelId: 'tts-1-hd' },
        'synthetic-key',
        'Olá',
        undefined,
        signal,
        undefined,
        'Speak cheerfully.',
      ),
    ).rejects.toThrow('does not support style instructions');
  });

  it('does not treat a blocked image response as successful generation', async () => {
    const client = new MediaProviders(async () =>
      Response.json({
        candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: 'Unavailable' }] } }],
      }),
    );
    await expect(
      client.generate(
        'image',
        { provider: 'google', modelId: 'gemini-2.5-flash-image' },
        'synthetic-key',
        'A picture',
        undefined,
        signal,
      ),
    ).rejects.toThrow('did not return');
  });

  it('refuses a ChatGPT login for the OpenAI Images API', async () => {
    let called = false;
    const client = new MediaProviders(async () => {
      called = true;
      return Response.json({});
    });
    await expect(
      client.generate(
        'image',
        { provider: 'openai-codex', modelId: 'gpt-image-2' },
        'synthetic-login',
        'A picture',
        undefined,
        signal,
      ),
    ).rejects.toThrow('API key');
    expect(called).toBe(false);
  });
});

import { randomUUID } from 'node:crypto';
import type { InlineMedia } from '@jian/contracts';
import type { ModelMessage } from 'ai';
import { Channels } from '../src/channels/service.js';
import { readWhatsAppContent } from '../src/channels/whatsapp/media.js';
import { mediaIdsIn } from '../src/media/repository.js';
import { Media } from '../src/media/service.js';
import { ModelCatalog } from '../src/providers/catalog-source.js';
import { testServices } from './helpers/services.js';

it('recognizes a captionless WhatsApp photo inside an ephemeral message', async () => {
  const message = {
    key: { remoteJid: '5511999999999@s.whatsapp.net', id: 'photo' },
    message: {
      ephemeralMessage: { message: { imageMessage: { mimetype: 'image/jpeg', fileLength: 3 } } },
    },
  };
  const parsed = await readWhatsAppContent(message, async () => Buffer.from('photo'));
  expect(parsed.text).toBe('[Media attachment]');
  expect(parsed.media?.[0]?.mimeType).toBe('image/jpeg');
});

it('turns a failed attachment download into an actionable message', async () => {
  const parsed = await readWhatsAppContent(
    { key: { id: 'audio' }, message: { audioMessage: { mimetype: 'audio/ogg', ptt: true } } },
    async () => {
      throw new Error('synthetic network error');
    },
  );
  expect(parsed.text).toContain('could not be downloaded');
  expect(parsed.media).toBeUndefined();
});

async function mediaFixture(catalog?: ModelCatalog) {
  const services = await testServices(undefined, catalog);
  const profile = await services.profiles.createProfile({
    name: 'Media',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test-vision', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const channels = new Channels(services, fetch);
  const channel = await channels.connect(profile.id, { type: 'api' });
  const incoming = (text: string, requestKey: string, media?: InlineMedia[]) =>
    channels.receive(channel.id, {
      type: 'api',
      headers: { 'x-jian-channel-token': channel.webhookToken },
      payload: { actorId: 'owner', chatId: 'owner', text, requestKey, ...(media ? { media } : {}) },
    });
  return { services, profile, channels, incoming };
}

it('holds an incoming image until approval and keeps it isolated to its profile', async () => {
  const f = await mediaFixture();
  await f.incoming('[Media attachment]', 'image', [{ mimeType: 'image/png', data: png }]);
  expect(await f.services.runs.recent(f.profile.id)).toHaveLength(0);
  const [contact] = await f.channels.contacts(f.profile.id);
  if (!contact) throw new Error('Missing contact');
  await f.channels.approveContact(f.profile.id, contact.id);
  const [run] = await f.services.runs.recent(f.profile.id);
  const id = mediaIdsIn(run?.input ?? '')[0];
  if (!id) throw new Error('Missing media');
  expect((await f.services.media.read(f.profile.id, id)).data).toBe(png);
  await expect(f.services.media.read(randomUUID(), id)).rejects.toThrow('Media not found');
});

it('delivers image pixels to the conversation model after a cold catalog start', async () => {
  const catalog = new ModelCatalog(async () =>
    Response.json({
      openai: {
        models: {
          'test-vision': {
            limit: { context: 128000, output: 8192 },
            modalities: { input: ['text', 'image'], output: ['text'] },
          },
        },
      },
    }),
  );
  const f = await mediaFixture(catalog);
  await f.services.providers.setModelDefaults(f.profile.id, { vision: null });
  await f.incoming('What color?', 'native', [{ mimeType: 'image/png', data: png }]);
  const [contact] = await f.channels.contacts(f.profile.id);
  if (!contact) throw new Error('Missing contact');
  await f.channels.approveContact(f.profile.id, contact.id);
  const [run] = await f.services.runs.recent(f.profile.id);
  if (!run) throw new Error('Missing run');
  const messages: ModelMessage[] = [{ role: 'user', content: run.input }];
  await f.services.media.prepare(messages, run, AbortSignal.timeout(1000));
  expect(messages[0]?.content).toContainEqual({
    type: 'file',
    data: png,
    mediaType: 'image/png',
  });
});

it('transcribes an incoming voice note once and reuses the transcript on later steps', async () => {
  const f = await mediaFixture();
  await f.services.providers.setModelDefaults(f.profile.id, { audio: null });
  await f.services.providers.createProvider({
    name: 'Gemini',
    kind: 'google',
    secret: 'synthetic-google-key-1234567890',
  });
  await f.incoming('[Voice message]', 'voice', [
    { mimeType: 'audio/ogg', data: Buffer.from('OggS-test').toString('base64'), voice: true },
  ]);
  const [contact] = await f.channels.contacts(f.profile.id);
  if (!contact) throw new Error('Missing contact');
  await f.channels.approveContact(f.profile.id, contact.id);
  const [run] = await f.services.runs.recent(f.profile.id);
  if (!run) throw new Error('Missing run');
  let calls = 0;
  const media = new Media(
    f.services.store,
    f.services.providers,
    f.services.gatewayVault,
    async () => {
      calls++;
      return Response.json({ candidates: [{ content: { parts: [{ text: 'Que horas são?' }] } }] });
    },
  );
  for (let index = 0; index < 2; index++) {
    const messages: ModelMessage[] = [{ role: 'user', content: run.input }];
    await media.prepare(messages, run, AbortSignal.timeout(1000));
    expect(JSON.stringify(messages)).toContain('Que horas são?');
  }
  expect(calls).toBe(1);
});

it('keeps ChatGPT connected when an OpenAI API key is configured for image generation', async () => {
  const services = await testServices();
  const login = await services.providers.configureCodexProvider('synthetic-codex-login-1234567890');
  const api = await services.providers.createProvider({
    name: 'OpenAI',
    kind: 'openai',
    secret: 'synthetic-openai-api-key-1234567890',
  });
  const active = (await services.providers.providers()).filter((provider) => !provider.revokedAt);
  expect(active.map((provider) => provider.id)).toEqual(expect.arrayContaining([login.id, api.id]));
});

it('preserves held attachment IDs when approval submission is retried', async () => {
  const f = await mediaFixture();
  await f.incoming('Look', 'retry-photo', [{ mimeType: 'image/png', data: png }]);
  const [contact] = await f.channels.contacts(f.profile.id);
  if (!contact) throw new Error('Missing contact');
  const failure = vi
    .spyOn(f.services.runs, 'submit')
    .mockRejectedValueOnce(new Error('Temporary submission failure'));
  await expect(f.channels.approveContact(f.profile.id, contact.id)).rejects.toThrow(
    'Temporary submission failure',
  );
  failure.mockRestore();
  await f.channels.approveContact(f.profile.id, contact.id);
  const [run] = await f.services.runs.recent(f.profile.id);
  expect(mediaIdsIn(run?.input ?? '')).toHaveLength(1);
});

it('retries approval after its run is created without changing the request', async () => {
  const f = await mediaFixture();
  await f.incoming('Look', 'retry-release', [{ mimeType: 'image/png', data: png }]);
  const [contact] = await f.channels.contacts(f.profile.id);
  if (!contact) throw new Error('Missing contact');
  const { Contacts } = await import('../src/channels/contacts.js');
  const failure = vi
    .spyOn(Contacts.prototype, 'release')
    .mockRejectedValueOnce(new Error('Temporary release failure'));
  await expect(f.channels.approveContact(f.profile.id, contact.id)).rejects.toThrow(
    'Temporary release failure',
  );
  failure.mockRestore();
  await f.channels.approveContact(f.profile.id, contact.id);
  const runs = await f.services.runs.recent(f.profile.id);
  expect(runs).toHaveLength(1);
  expect(mediaIdsIn(runs[0]?.input ?? '')).toHaveLength(1);
});

it('carries an attachment reply into the conversation that asked the contact', async () => {
  const f = await mediaFixture();
  await f.incoming('Hello', 'hello');
  const [contact] = await f.channels.contacts(f.profile.id);
  if (!contact) throw new Error('Missing contact');
  const approved = await f.channels.approveContact(f.profile.id, contact.id);
  for (const run of await f.services.runs.recent(f.profile.id)) {
    await f.services.lifecycle.claim(run.id, f.profile.id, 'worker');
    await f.services.lifecycle.finish(f.profile.id, run.id, 'worker', 'completed', 'Hello');
  }
  const owner = await f.services.sessions.createSession(f.profile.id, { title: 'Owner' });
  const { Errands } = await import('../src/errands/service.js');
  const errands = new Errands(f.services.store);
  await f.services.store.transaction(f.profile.id, (tx) =>
    errands.open(tx, f.profile.id, approved, owner.id, 'Send me a photo'),
  );
  const response = await f.incoming('[Media attachment]', 'answer-photo', [
    { mimeType: 'image/png', data: png },
  ]);
  if (!('runId' in response) || !response.runId) throw new Error('Missing relayed run');
  const run = (await f.services.runs.recent(f.profile.id)).find(
    (item) => item.id === response.runId,
  );
  expect(run?.sessionId).toBe(owner.id);
  const [id] = mediaIdsIn(run?.input ?? '');
  if (!id) throw new Error('Missing media');
  expect((await f.services.media.read(f.profile.id, id)).data).toBe(png);
  const replay = await f.incoming('[Media attachment]', 'answer-photo', [
    { mimeType: 'image/png', data: png },
  ]);
  expect(replay).toEqual(response);
  expect(await f.services.runs.recent(f.profile.id)).toHaveLength(2);
});

it('accounts for audio input and reasoning reported by Gemini', async () => {
  const client = new MediaProviders(async () =>
    Response.json({
      candidates: [{ content: { parts: [{ text: 'A reunião começa às três.' }] } }],
      usageMetadata: {
        promptTokenCount: 88,
        candidatesTokenCount: 8,
        thoughtsTokenCount: 197,
        cachedContentTokenCount: 12,
      },
    }),
  );
  const usage: unknown[] = [];
  await client.analyze(
    { provider: 'google', modelId: 'gemini-flash-latest' },
    'synthetic-key',
    { mimeType: 'audio/wav', data: Buffer.from('test').toString('base64') },
    'Transcribe',
    AbortSignal.timeout(1000),
    async (value) => {
      usage.push(value);
    },
  );
  expect(usage).toEqual([{ inputTokens: 88, outputTokens: 205, cachedInputTokens: 12 }]);
});

it('uses the incoming audio model for both voice notes and attached audio files', async () => {
  const f = await mediaFixture();
  const provider = await f.services.providers.createProvider({
    name: 'Gemini',
    kind: 'google',
    secret: 'synthetic-google-key-1234567890',
  });
  await f.services.providers.setModelDefaults(f.profile.id, {
    conversation: { providerId: provider.id, modelId: 'gemini-flash-latest' },
    audio: { providerId: provider.id, modelId: 'gemini-incoming-test' },
    transcription: { providerId: provider.id, modelId: 'gemini-legacy-test' },
  });
  await f.incoming(
    'Ouça os dois',
    'two-audios',
    [true, false].map((voice) => ({
      mimeType: 'audio/ogg' as const,
      data: Buffer.from('OggS-test').toString('base64'),
      voice,
    })),
  );
  const [contact] = await f.channels.contacts(f.profile.id);
  if (!contact) throw new Error('Missing contact');
  await f.channels.approveContact(f.profile.id, contact.id);
  const [run] = await f.services.runs.recent(f.profile.id);
  if (!run) throw new Error('Missing run');
  const media = new Media(
    f.services.store,
    f.services.providers,
    f.services.gatewayVault,
    async (url, options) => {
      expect(String(url)).toContain('/gemini-incoming-test:generateContent');
      const prompt = JSON.parse(String(options?.body)).contents[0].parts[0].text;
      expect(prompt).toContain('verbatim');
      expect(prompt).toContain('Do not summarize');
      expect(prompt).toContain('sounds');
      return Response.json({
        candidates: [{ content: { parts: [{ text: 'Que horas são? [Campainha ao fundo.]' }] } }],
      });
    },
  );
  const messages: ModelMessage[] = [{ role: 'user', content: run.input }];
  await media.prepare(messages, run, AbortSignal.timeout(1000));
  expect(JSON.stringify(messages).match(/Que horas são/g)).toHaveLength(2);
});

it('preserves a legacy transcription selection as the incoming audio default', async () => {
  const f = await mediaFixture();
  const provider = await f.services.providers.createProvider({
    name: 'OpenAI',
    kind: 'openai',
    secret: 'synthetic-openai-key-1234567890',
  });
  const selection = { providerId: provider.id, modelId: 'gpt-4o-mini-transcribe' };
  await f.services.providers.setModelDefaults(f.profile.id, { transcription: selection });
  const defaults = await f.services.providers.modelDefaults(f.profile.id);
  expect(defaults.audio).toEqual(selection);
  await f.services.providers.setModelDefaults(f.profile.id, {
    audio: null,
    transcription: selection,
  });
  expect((await f.services.providers.modelDefaults(f.profile.id)).audio).toEqual(selection);
  await f.services.providers.setModelDefaults(f.profile.id, { audio: null });
  expect((await f.services.providers.modelDefaults(f.profile.id)).audio).toBeNull();
});

it('discovers voices for the profile speech provider instead of its conversation provider', async () => {
  const f = await mediaFixture();
  const provider = await f.services.providers.createProvider({
    name: 'Gemini',
    kind: 'google',
    secret: 'synthetic-google-key-1234567890',
  });
  await f.services.providers.setModelDefaults(f.profile.id, {
    speech: { providerId: provider.id, modelId: 'gemini-2.5-flash-preview-tts' },
  });
  await f.incoming('Choose a voice', 'voices');
  const [contact] = await f.channels.contacts(f.profile.id);
  if (!contact) throw new Error('Missing contact');
  await f.channels.approveContact(f.profile.id, contact.id);
  const [run] = await f.services.runs.recent(f.profile.id);
  if (!run) throw new Error('Missing run');
  const tool = f.services.media.tools(run).list_speech_voices;
  if (!tool?.execute) throw new Error('Missing voice discovery');
  const result = await tool.execute({}, { toolCallId: 'voices', messages: [], context: {} });
  expect(result).toMatchObject({
    provider: 'Gemini',
    defaultVoice: 'Kore',
    supportsInstructions: true,
    voices: expect.arrayContaining([{ name: 'Leda', character: 'Youthful' }]),
  });
  expect(JSON.stringify(result)).not.toContain('shimmer');
});

it('recovers an auxiliary image analysis after temporary provider overload', async () => {
  const f = await mediaFixture();
  const provider = await f.services.providers.createProvider({
    name: 'Gemini',
    kind: 'google',
    secret: 'synthetic-google-key-1234567890',
  });
  await f.services.providers.setModelDefaults(f.profile.id, {
    vision: { providerId: provider.id, modelId: 'gemini-flash-latest' },
  });
  await f.incoming('What color?', 'overload', [{ mimeType: 'image/png', data: png }]);
  const [contact] = await f.channels.contacts(f.profile.id);
  if (!contact) throw new Error('Missing contact');
  await f.channels.approveContact(f.profile.id, contact.id);
  const [run] = await f.services.runs.recent(f.profile.id);
  if (!run) throw new Error('Missing run');
  let overloaded = true;
  const media = new Media(
    f.services.store,
    f.services.providers,
    f.services.gatewayVault,
    async (_url, options) => {
      const body = JSON.parse(String(options?.body));
      expect(body.contents[0].parts).toContainEqual({
        inlineData: { mimeType: 'image/png', data: png },
      });
      if (overloaded) {
        overloaded = false;
        return Response.json(
          { error: { code: 503, message: 'High demand', status: 'UNAVAILABLE' } },
          { status: 503 },
        );
      }
      return Response.json({
        candidates: [
          { content: { role: 'model', parts: [{ text: 'A blue square.' }] }, finishReason: 'STOP' },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14 },
      });
    },
  );
  const messages: ModelMessage[] = [{ role: 'user', content: run.input }];
  await media.prepare(messages, run, AbortSignal.timeout(10000));
  expect(JSON.stringify(messages)).toContain('A blue square.');
  expect(JSON.stringify(messages)).not.toContain('could not be read');
});
