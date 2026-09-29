import { randomBytes } from 'node:crypto';
import { GROUP_AGENT_TURN_LIMIT, messageRecordSchema } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { IncomingMessage } from '../src/channels/channel.js';
import { ChannelRegistry } from '../src/channels/registry.js';
import { Channels } from '../src/channels/service.js';
import { WhatsAppChannel } from '../src/channels/whatsapp/adapter.js';
import { WhatsAppConnections } from '../src/channels/whatsapp/connections.js';
import type { DeviceCallbacks, DeviceFactory } from '../src/channels/whatsapp/types.js';
import { Decisions } from '../src/decisions/service.js';
import { SecretBox } from '../src/security/crypto.js';
import { runRows } from './helpers/rows.js';
import { testServices } from './helpers/services.js';

const room = '120363000000000000@g.us';
const token = 'synthetic-groups-admin-token-32-characters';
const admin = { authorization: `Bearer ${token}` };

const owner = { address: '5511900000000@c.us', name: 'Lucas' };
const guest = { address: '5511911111111@c.us', name: 'Marina' };

/**
 * One installation, one WhatsApp room, one linked device per profile — which is how the owner
 * decided to build it: each agent has its own number, so the protocol itself carries what one
 * agent writes to the others.
 */
async function setup(jev?: (state: { message: string }) => number) {
  const services = await testServices();
  const asked: Array<{ message: string }> = [];
  // A synthetic Jev: it answers yes-or-no from the message it was shown, as the real one would.
  const decisions = new Decisions(
    services.store,
    services.gatewayVault,
    async (_url, init) => {
      const state = JSON.parse(JSON.parse(String(init?.body)).state);

      asked.push(state);

      return Response.json({ answers: { answer: { type: 'noul', noul: jev?.(state) ?? 0 } } });
    },
    () => {},
  );

  if (jev) {
    await decisions.configure({ provider: 'jev', apiKey: 'jev-synthetic' });
  }

  const store = services.store;
  const box = new SecretBox({ activeKeyId: 'v1', keys: { v1: randomBytes(32) } });
  const devices = new Map<string, DeviceCallbacks>();
  const sent: Array<{
    channelId: string;
    chatId: string;
    text: string;
    people?: Array<{ id: string; name: string }>;
  }> = [];

  const factory: DeviceFactory = async (channelId, _sessionStore, callbacks) => {
    devices.set(channelId, callbacks);

    return {
      start: async () => {},
      send: async (chatId, text, _signal, _media, people) => {
        sent.push({ channelId, chatId, text, ...(people ? { people } : {}) });

        return `wa-sent-${sent.length}`;
      },
      typing: async () => {},
      stop: async () => {},
    };
  };

  const whatsapp = new WhatsAppConnections(store, box, factory);
  const registry = new ChannelRegistry([new WhatsAppChannel(whatsapp)]);
  const channels = new Channels({ ...services, decisions }, fetch, registry);
  const receive = (id: string, input: IncomingMessage, generation: number) =>
    channels.receiveLinked(id, input, generation);
  const app = createApp({ ...services, channels, whatsapp, token, logger: false });

  const agents: Array<{ name: string; address: string; profileId: string; channelId: string }> = [];

  const join = async (name: string, address: string) => {
    const profile = await services.profiles.createProfile({
      name,
      instructions: 'Help.',
      model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    });

    const channel = await channels.connect(profile.id, { type: 'whatsapp' });

    await whatsapp.connect(profile.id, channel.id);
    await whatsapp.tick(receive);
    await devices.get(channel.id)?.ready(address);

    const agent = { name, address, profileId: profile.id, channelId: channel.id };

    agents.push(agent);

    return agent;
  };

  let messages = 0;

  /** What the protocol does: the message reaches every device in the room except its author's. */
  const say = async (
    author: { name: string; address: string },
    text: string,
    options: {
      requestKey?: string;
      mentions?: string[];
      replyTo?: string;
      media?: IncomingMessage['media'];
      quoted?: IncomingMessage['quoted'];
    } = {},
  ) => {
    const requestKey = options.requestKey ?? `wa-group-${++messages}`;

    for (const agent of agents) {
      if (agent.address === author.address) {
        continue;
      }

      await devices.get(agent.channelId)?.message({
        actorId: author.address,
        chatId: room,
        text,
        requestKey,
        displayName: author.name,
        groupName: 'Equipe',
        scope: 'group',
        mentions: options.mentions ?? [],
        ...(options.replyTo ? { replyTo: options.replyTo } : {}),
        ...(options.media ? { media: options.media } : {}),
        ...(options.quoted ? { quoted: options.quoted } : {}),
      });
    }

    await whatsapp.tick(receive);
  };

  return {
    services,
    store,
    asked,
    channels,
    whatsapp,
    app,
    sent,
    join,
    say,
    runs: (profileId: string) => runRows(store, profileId),
    approve: async (profileId: string) => {
      const contact = (await channels.contacts(profileId)).find((item) => item.scope === 'group');

      if (!contact) throw new Error('Group request missing');

      return channels.approveContact(profileId, contact.id);
    },
    /** The agent answered; the room is free for the next turn. */
    reply: async (profileId: string, output: string) => {
      const [run] = await services.runs.activities(profileId);

      if (!run) throw new Error('Run missing');

      await services.lifecycle.claim(run.id, profileId, 'worker');
      await services.lifecycle.finish(profileId, run.id, 'worker', 'completed', output);

      return run;
    },
    close: async () => {
      await whatsapp.stop();
      await app.close();
    },
  };
}

describe('group conversations', () => {
  it('answers in a room with several agents only the message that mentions it', async () => {
    const f = await setup();

    try {
      const ada = await f.join('Ada', '5511800000001@c.us');
      const bia = await f.join('Bia', '5511800000002@c.us');

      await f.say(owner, 'bom dia');
      await f.approve(ada.profileId);
      await f.approve(bia.profileId);

      await f.say(owner, 'alguem pode olhar o relatorio?');

      expect(await f.runs(ada.profileId)).toEqual([]);
      expect(await f.runs(bia.profileId)).toEqual([]);

      await f.say(owner, 'Ada, você consegue olhar o relatório?', { mentions: [ada.address] });

      const answering = await f.runs(ada.profileId);

      expect(answering).toHaveLength(1);
      expect(answering[0]?.input).toBe('Lucas: Ada, você consegue olhar o relatório?');
      expect(answering[0]?.group).toMatchObject({ chatId: room, fromAgent: false, turns: 1 });
      expect(await f.runs(bia.profileId)).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('never answers, nor warns, in a room the owner has not approved', async () => {
    const f = await setup();

    try {
      const ada = await f.join('Ada', '5511800000001@c.us');
      const bia = await f.join('Bia', '5511800000002@c.us');

      await f.say(owner, 'Ada, começou sem aprovação');

      expect(await f.runs(ada.profileId)).toEqual([]);
      expect(await f.channels.deliveries(ada.profileId)).toEqual([]);
      expect(await f.sent).toEqual([]);
      expect(await f.services.sessions.sessions(ada.profileId)).toEqual([]);

      // Each profile sees the room through its own connection, so each one asks its owner.
      for (const profileId of [ada.profileId, bia.profileId]) {
        const contacts = await f.channels.contacts(profileId);

        expect(contacts).toHaveLength(1);
        expect(contacts[0]).toMatchObject({ scope: 'group', chatId: room, status: 'pending' });
        expect(contacts[0]?.message).toBeUndefined();
      }

      await f.approve(ada.profileId);
      await f.say(owner, 'e agora?', { mentions: [ada.address] });

      expect(await f.runs(ada.profileId)).toHaveLength(1);
      expect(await f.runs(bia.profileId)).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it('reads the whole room but answers only a mention or a reply, even when alone', async () => {
    const f = await setup();

    try {
      const ada = await f.join('Ada', '5511800000001@c.us');

      await f.say(owner, 'oi');
      await f.approve(ada.profileId);

      await f.say(owner, 'o fornecedor atrasou a entrega para sexta');
      await f.say(guest, 'a Ada sabe disso?');
      // A redelivery of something only heard is still heard once.
      await f.say(guest, 'vou avisar o cliente', { requestKey: 'wa-heard' });
      await f.say(guest, 'vou avisar o cliente', { requestKey: 'wa-heard' });

      // Being talked about is not being called.
      expect(await f.runs(ada.profileId)).toEqual([]);

      await f.say(owner, 'o que você acha?', { mentions: [ada.address] });

      const [run] = await f.services.runs.activities(ada.profileId);

      if (!run) throw new Error('Run missing');

      const context = await f.services.contexts.context(run);
      const transcript = context.messages.map((message) => message.content).join('\n\n');

      expect(context.messages).toHaveLength(2);

      // What the agent only heard is read back through the same contract as anything else.
      const history = await f.app.inject({
        url: `/v1/profiles/${ada.profileId}/sessions/${run.sessionId}/messages`,
        headers: admin,
      });

      expect(history.statusCode).toBe(200);
      expect(messageRecordSchema.array().parse(history.json())).toHaveLength(4);
      expect(transcript).toBe(
        [
          'Lucas: o fornecedor atrasou a entrega para sexta',
          'Marina: a Ada sabe disso?',
          'Marina: vou avisar o cliente',
          'Lucas: o que você acha?',
        ].join('\n\n'),
      );

      await f.reply(ada.profileId, 'Sexta, então.');
      await f.say(guest, 'pode ser sábado?', { replyTo: ada.address });

      expect(await f.runs(ada.profileId)).toHaveLength(2);
    } finally {
      await f.close();
    }
  });

  it('keeps a file posted in the room for the agent to open when it is called', async () => {
    const f = await setup();

    try {
      const ada = await f.join('Ada', '5511800000001@c.us');

      await f.say(owner, 'oi');
      await f.approve(ada.profileId);
      await f.say(guest, '[File: prices.csv]', {
        media: [
          {
            mimeType: 'text/csv',
            data: Buffer.from('item,price\ncoffee,12\n').toString('base64'),
            name: 'prices.csv',
          },
        ],
      });
      await f.say(owner, 'Ada, what does coffee cost?', { mentions: [ada.address] });

      const [run] = await f.services.runs.activities(ada.profileId);

      if (!run) throw new Error('Run missing');

      const context = await f.services.contexts.context(run);
      const heard = context.messages.map((message) => message.content).join('\n');
      const mediaId = heard.match(/prices\.csv, media ID ([0-9a-f-]{36})/)?.[1];

      if (!mediaId) throw new Error(`File not kept: ${heard}`);

      const open = f.services.media.tools(run).analyze_media;
      const read = await open?.execute?.(
        { mediaId, question: 'What does coffee cost?' },
        { toolCallId: 'open', messages: [], context: {} },
      );

      expect(JSON.stringify(read)).toContain('coffee,12');
    } finally {
      await f.close();
    }
  });

  it('names who wrote the message a reply quotes, from the people of the room', async () => {
    const f = await setup();

    try {
      const ada = await f.join('Ada', '5511800000001@c.us');

      await f.say(owner, 'oi');
      await f.approve(ada.profileId);
      await f.say(guest, 'o fornecedor atrasou');
      await f.say(owner, 'Ada, e agora?', {
        mentions: [ada.address],
        replyTo: guest.address,
        quoted: { text: 'o fornecedor atrasou' },
      });

      const [run] = await f.services.runs.activities(ada.profileId);

      expect(run?.input).toBe(
        'Lucas: [Replying to Marina\'s message: "o fornecedor atrasou"]\nAda, e agora?',
      );

      // The conversation itself says it is a group, so it stays one without its contact.
      const room = await f.services.sessions.session(ada.profileId, run?.sessionId as string);

      expect(room).toMatchObject({ scope: 'group', title: 'WhatsApp · Equipe' });
    } finally {
      await f.close();
    }
  });

  it('answers a person who speaks to it by name when Jev says so, and not one who talks about it', async () => {
    const f = await setup((state) => (state.message.startsWith('Ada,') ? 0.9 : 0.1));

    try {
      const ada = await f.join('Ada', '5511800000001@c.us');

      await f.say(owner, 'Ada, está aí?');

      // An unapproved room's messages never leave the gateway.
      expect(f.asked).toEqual([]);

      await f.approve(ada.profileId);
      await f.say(guest, 'a Ada sabe disso?');

      expect(await f.runs(ada.profileId)).toEqual([]);

      await f.say(guest, 'Ada, pode confirmar a entrega?');

      const runs = await f.runs(ada.profileId);

      expect(runs).toHaveLength(1);
      expect(runs[0]?.input).toContain('Marina: Ada, pode confirmar a entrega?');
      expect(f.asked.at(-1)).toMatchObject({ agent: 'Ada', from: 'Marina' });

      // A message without the name is not worth a question.
      const before = f.asked.length;

      await f.say(guest, 'obrigada');

      expect(f.asked).toHaveLength(before);
    } finally {
      await f.close();
    }
  });

  it('keeps an agent quiet when another agent only talks about it', async () => {
    const f = await setup((state) => (state.message.includes('como a Bia disse') ? 0 : 1));

    try {
      const ada = await f.join('Ada', '5511800000001@c.us');
      const bia = await f.join('Bia', '5511800000002@c.us');

      await f.say(owner, 'oi');
      await f.approve(ada.profileId);
      await f.approve(bia.profileId);

      await f.say(ada, 'como a Bia disse, a entrega fica para sexta');

      expect(await f.services.runs.activities(bia.profileId)).toEqual([]);

      await f.say(ada, 'Bia, você confirma?');

      expect(await f.services.runs.activities(bia.profileId)).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it('asks the owner once for the whole room, whoever writes in it', async () => {
    const f = await setup();

    try {
      const ada = await f.join('Ada', '5511800000001@c.us');

      await f.say(owner, 'primeiro');
      await f.say(guest, 'segundo');

      expect(await f.channels.contacts(ada.profileId)).toHaveLength(1);

      await f.approve(ada.profileId);
      await f.say(guest, 'terceiro', { mentions: [ada.address] });

      const runs = await f.runs(ada.profileId);

      expect(runs).toHaveLength(1);
      expect(runs[0]?.input).toBe('Marina: terceiro');
    } finally {
      await f.close();
    }
  });

  it('ends a conversation between agents at the shared budget and reopens it for a person', async () => {
    const f = await setup();

    try {
      const ada = await f.join('Ada', '5511800000001@c.us');
      const bia = await f.join('Bia', '5511800000002@c.us');

      await f.say(owner, 'oi');
      await f.approve(ada.profileId);
      await f.approve(bia.profileId);

      await f.say(owner, 'Ada, combine o prazo com a equipe', { mentions: [ada.address] });

      expect(await f.services.runs.activities(bia.profileId)).toEqual([]);
      await f.reply(ada.profileId, 'Bia, qual prazo consegue?');

      // Agents cannot mention or quote, so between them the name in the text is the call.
      const spoken = ['Ada'];

      for (const turn of [
        { from: ada, to: bia },
        { from: bia, to: ada },
        { from: ada, to: bia },
      ]) {
        await f.say(turn.from, `${turn.to.name}, e você?`);

        const [queued] = await f.services.runs.activities(turn.to.profileId);

        if (!queued) {
          break;
        }

        expect(queued.group).toMatchObject({ fromAgent: true, fromName: turn.from.name });
        spoken.push(turn.to.name);
        await f.reply(turn.to.profileId, `${turn.from.name}, ok`);
      }

      // The budget belongs to the room: it counts what every agent wrote, not what each one did.
      expect(spoken).toEqual(['Ada', 'Bia', 'Ada']);
      expect(spoken).toHaveLength(GROUP_AGENT_TURN_LIMIT);
      expect(await f.services.runs.activities(bia.profileId)).toEqual([]);

      // A person writing returns the budget to the room.
      await f.say(owner, 'Ada, resume para mim', { mentions: [ada.address] });

      const resumed = await f.services.runs.activities(ada.profileId);

      expect(resumed).toHaveLength(1);
      expect(resumed[0]?.group).toMatchObject({ fromAgent: false, turns: 1 });
    } finally {
      await f.close();
    }
  });

  it('treats a redelivered room message as the same turn and the same answer', async () => {
    const f = await setup();

    try {
      const ada = await f.join('Ada', '5511800000001@c.us');
      await f.join('Bia', '5511800000002@c.us');

      await f.say(owner, 'oi');
      await f.approve(ada.profileId);

      const call = { requestKey: 'wa-repeated', mentions: [ada.address] };

      await f.say(owner, 'Ada, confirma?', call);
      await f.say(owner, 'Ada, confirma?', call);

      const runs = await f.runs(ada.profileId);

      expect(runs).toHaveLength(1);

      const run = runs[0];

      if (!run) throw new Error('Run missing');

      await f.reply(ada.profileId, 'Confirmo');
      await f.channels.dispatch();
      await f.channels.dispatch();

      expect(f.sent.filter((item) => item.chatId === room)).toHaveLength(1);
      expect(
        (await f.channels.deliveries(ada.profileId)).filter((item) => item.runId === run.id),
      ).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it('hands the device the people of the room, so a name the agent writes can mention them', async () => {
    const f = await setup();

    try {
      const ada = await f.join('Ada', '5511800000001@c.us');

      await f.say(owner, 'hi');
      await f.approve(ada.profileId);
      await f.say(guest, 'the supplier moved the delivery to Friday');
      await f.say(owner, 'Ada, can you tell Marina it is fine?', { mentions: [ada.address] });
      await f.reply(ada.profileId, '@Marina Friday works.');
      await f.channels.dispatch();

      const [answer] = f.sent.filter((item) => item.chatId === room);

      expect(answer?.text).toBe('@Marina Friday works.');
      expect(answer?.people).toEqual(
        expect.arrayContaining([
          { id: owner.address, name: owner.name },
          { id: guest.address, name: guest.name },
        ]),
      );
    } finally {
      await f.close();
    }
  });

  it('shows the owner each room with the profiles that sit in it', async () => {
    const f = await setup();

    try {
      const ada = await f.join('Ada', '5511800000001@c.us');
      const bia = await f.join('Bia', '5511800000002@c.us');

      await f.say(owner, 'oi');
      await f.approve(ada.profileId);

      expect((await f.app.inject({ url: '/v1/groups' })).statusCode).toBe(401);

      const response = await f.app.inject({ url: '/v1/groups', headers: admin });

      expect(response.statusCode).toBe(200);

      const [group] = response.json();

      expect(group).toMatchObject({ type: 'whatsapp', chatId: room, name: 'Equipe' });
      expect(group.profiles).toEqual([
        {
          profileId: ada.profileId,
          name: 'Ada',
          contactId: expect.any(String),
          status: 'approved',
        },
        { profileId: bia.profileId, name: 'Bia', contactId: expect.any(String), status: 'pending' },
      ]);
    } finally {
      await f.close();
    }
  });
});
