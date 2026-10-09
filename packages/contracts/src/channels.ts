import { z } from 'zod';
import { inlineMediaSchema } from './media.js';
import { secretSchema } from './security.js';

/** One channel of each type per profile: the panel connects a type, it does not name a binding. */
export const channelTypeSchema = z.enum(['whatsapp', 'telegram', 'api']);

/**
 * How many replies the agents of this installation may write in a group before a person
 * speaks again. Each agent counts the same traffic — the messages it sees from the other
 * agents plus the ones it sends — so the budget is shared by the whole room instead of
 * being reset by each participant. Every turn is a real model run on a real key, and three
 * agents answering each other in a circle spends money forever, so the circle ends here.
 */
export const GROUP_AGENT_TURN_LIMIT = 3;

/** A conversation is one person writing privately, or a room where several participants write. */
export const conversationScopeSchema = z.enum(['direct', 'group']);

export const channelInputSchema = z
  .strictObject({
    type: channelTypeSchema,
    // The Telegram bot token. It goes to the vault under `channel:<id>` and is never read back.
    botToken: secretSchema.optional(),
  })
  .refine((value) => (value.type === 'telegram') === (value.botToken !== undefined), {
    message: 'Telegram connects with a bot token; the other channels connect without one',
    path: ['botToken'],
  });

export const channelSchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  type: channelTypeSchema,
  createdAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().optional(),
});

/**
 * Approval is per sender, so a stranger cannot reach the agent by knowing the channel. A group
 * is approved as one conversation instead: `actorId` holds the room, and everyone who writes
 * in it is covered by the single decision the owner took about the room.
 */
export const contactSchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  channelId: z.uuid(),
  type: channelTypeSchema,
  scope: conversationScopeSchema.default('direct'),
  actorId: z.string().min(1).max(100),
  chatId: z.string().min(1).max(100),
  displayName: z.string().max(100).optional(),
  status: z.enum(['pending', 'approved', 'blocked']),
  /**
   * Whether this contact speaks for the owner. Only an owner's reply in a chat decides an
   * approval the agent is waiting on; everyone else's "ok" is just a word in the conversation.
   */
  owner: z.boolean().default(false),
  sessionId: z.uuid().optional(),
  message: z.string().max(8000).optional().describe('The message held until the owner decides.'),
  avatar: z
    .string()
    .max(200_000)
    .optional()
    .describe('The picture the contact or group uses on its channel, as a data URL.'),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const contactOwnerSchema = z.strictObject({ owner: z.boolean() });

export const ingressSchema = z.strictObject({
  actorId: z.string().min(1).max(100),
  chatId: z.string().min(1).max(100),
  text: z.string().trim().min(1).max(8000),
  requestKey: z.string().min(1).max(120),
  media: z.array(inlineMediaSchema).max(4).optional(),
  displayName: z.string().trim().min(1).max(100).optional(),
  scope: conversationScopeSchema.default('direct'),
  groupName: z.string().trim().min(1).max(100).optional(),
  // Addresses the protocol itself marks as addressed by this message, when it carries them.
  mentions: z.array(z.string().min(1).max(100)).max(32).default([]),
  // The address of whoever wrote the message this one answers, when it quotes one.
  replyTo: z.string().min(1).max(100).optional(),
  // What the quoted message said, and who wrote it, so the agent reads what is being answered.
  quoted: z
    .strictObject({
      text: z.string().max(1000),
      name: z.string().trim().min(1).max(100).optional(),
    })
    .optional(),
  // A reaction to a message: `text` is the emoji. It is kept in the conversation, not answered.
  reaction: z.boolean().optional(),
  // The protocol's id of the message a reaction or a reply points to.
  target: z.string().min(1).max(200).optional(),
});

const telegramEntitiesSchema = z
  .array(
    z.object({
      type: z.string().max(40),
      offset: z.number().int().nonnegative().optional(),
      length: z.number().int().nonnegative().optional(),
      user: z.object({ id: z.number().int() }).optional(),
    }),
  )
  .max(64)
  .optional();

/**
 * Only what the gateway reads. Everything else a Telegram message may carry — a photo, a
 * sticker, the notice that someone joined — is optional here: refusing an update makes Telegram
 * deliver it again and again, and the messages behind it wait.
 */
const telegramFileSchema = z.object({
  file_id: z.string().min(1).max(200),
  file_name: z.string().max(255).optional(),
  mime_type: z.string().max(120).optional(),
  file_size: z.number().int().nonnegative().optional(),
});

export const telegramUpdateSchema = z.object({
  update_id: z.number().int(),
  // Sent only for chats where the bot may see reactions: private chats, and groups as an admin.
  message_reaction: z
    .object({
      chat: z.object({
        id: z.number().int(),
        type: z.string().max(40).optional(),
        title: z.string().max(200).optional(),
      }),
      message_id: z.number().int(),
      user: z
        .object({
          id: z.number().int(),
          first_name: z.string().max(100).optional(),
          username: z.string().max(100).optional(),
        })
        .optional(),
      new_reaction: z
        .array(z.object({ type: z.string().max(40), emoji: z.string().max(20).optional() }))
        .max(20),
    })
    .optional(),
  message: z
    .object({
      from: z
        .object({
          id: z.number().int(),
          first_name: z.string().max(100).optional(),
          username: z.string().max(100).optional(),
        })
        .optional(),
      chat: z.object({
        id: z.number().int(),
        type: z.string().max(40).optional(),
        title: z.string().max(200).optional(),
      }),
      text: z.string().max(8000).optional(),
      caption: z.string().max(8000).optional(),
      // Sizes smallest first; the gateway downloads the largest.
      photo: z.array(telegramFileSchema).max(10).optional(),
      document: telegramFileSchema.optional(),
      voice: telegramFileSchema.optional(),
      audio: telegramFileSchema.optional(),
      video: telegramFileSchema.optional(),
      video_note: telegramFileSchema.optional(),
      // Only a still sticker is WebP; an animated or video one is kept out of the collection.
      sticker: telegramFileSchema
        .extend({
          emoji: z.string().max(20).optional(),
          is_animated: z.boolean().optional(),
          is_video: z.boolean().optional(),
        })
        .optional(),
      entities: telegramEntitiesSchema,
      caption_entities: telegramEntitiesSchema,
      reply_to_message: z
        .object({
          message_id: z.number().int().optional(),
          from: z
            .object({
              id: z.number().int(),
              first_name: z.string().max(100).optional(),
              username: z.string().max(100).optional(),
            })
            .optional(),
          text: z.string().max(8000).optional(),
          caption: z.string().max(8000).optional(),
        })
        .optional(),
    })
    .optional(),
});

export const ingressResultSchema = z.strictObject({
  accepted: z.boolean(),
  runId: z.uuid().optional(),
  contact: z
    .enum(['approved', 'pending', 'blocked'])
    .optional()
    .describe('Absent when the payload carried no message to route.'),
  silence: z
    .enum(['unaddressed', 'budget', 'reaction', 'no-model'])
    .optional()
    .describe('Why an approved message produced no run.'),
});

/**
 * What a group message carries into the run it starts: who wrote it, whether that author is
 * another agent of this installation, which agents share the room, and how much of the shared
 * turn budget this reply spends.
 */
export const groupTurnSchema = z.strictObject({
  chatId: z.string().min(1).max(100),
  name: z.string().max(100).optional(),
  fromName: z.string().max(100),
  fromAgent: z.boolean(),
  turns: z.number().int().min(1).max(GROUP_AGENT_TURN_LIMIT),
  agents: z.array(z.string().max(100)).max(20).default([]),
});

/** The owner's view of a room: one group, and which of this installation's profiles are in it. */
export const groupSchema = z.strictObject({
  type: channelTypeSchema,
  chatId: z.string(),
  name: z.string().optional(),
  profiles: z.array(
    z.strictObject({
      profileId: z.uuid(),
      name: z.string(),
      contactId: z.uuid(),
      status: z.enum(['pending', 'approved', 'blocked']),
    }),
  ),
});

export const deliverySchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  channelId: z.uuid(),
  runId: z.uuid().optional(),
  chatId: z.string(),
  status: z.enum(['pending', 'sending', 'sent', 'failed', 'unknown']),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  remoteMessageIds: z.array(z.union([z.number(), z.string()])).default([]),
  /** How much of the run's commentary this chat has already received. */
  saidCount: z.number().int().nonnegative().default(0),
  mediaId: z.uuid().optional(),
  notice: z
    .string()
    .optional()
    .describe('Text sent without a delivery run, such as an approval notice or a contact message.'),
});

/** Linking a device grants account access, so these endpoints are administrator-only. */
export const channelConnectionSchema = z.strictObject({
  channelId: z.uuid(),
  status: z.enum(['disconnected', 'connecting', 'qr', 'connected', 'error']),
  accountId: z.string().optional(),
  sessionSavedAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime(),
  error: z.string().optional(),
});

export const channelQrSchema = z.strictObject({
  qr: z.string().describe('Sensitive QR payload. Render locally and never log or cache it.'),
  expiresAt: z.iso.datetime(),
});

export type ConversationScope = z.infer<typeof conversationScopeSchema>;

export type GroupTurn = z.infer<typeof groupTurnSchema>;

export type Group = z.infer<typeof groupSchema>;
