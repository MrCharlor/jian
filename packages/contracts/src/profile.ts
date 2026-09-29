import { z } from 'zod';
import { MAX_MESSAGE_MEDIA } from './media.js';
import {
  modelSelectionSchema,
  providerCredentialSchema,
  reasoningEffortSchema,
} from './providers.js';
import { secretSchema } from './security.js';
import { skillOriginSchema } from './skills.js';

const endpointSchema = z.url().refine((value) => {
  const url = new URL(value);

  return (
    ['http:', 'https:'].includes(url.protocol) &&
    !url.username &&
    !url.password &&
    !value.includes('#')
  );
}, 'Use an HTTP(S) endpoint without embedded credentials or fragments');

export const modelSchema = z
  .strictObject({
    provider: z.enum([
      'openai',
      'anthropic',
      'google',
      'openrouter',
      'openai-compatible',
      'openai-codex',
    ]),
    modelId: z.string().trim().min(1).max(160),
    apiKeyEnv: z
      .string()
      .regex(
        /^(?:JIAN_PROVIDER_[A-Z0-9_]+|ANTHROPIC_API_KEY|ANTHROPIC_API_TOKEN|GEMINI_API_TOKEN|OPENAI_API_KEY)$/,
      )
      .optional(),
    providerId: z.uuid().optional(),
    // Frozen with the run so the request is built the same way the owner configured it, long
    // after the provider record may have been replaced.
    credential: providerCredentialSchema.optional(),
    baseURL: endpointSchema.optional(),
    // Frozen with the run: the effort chosen next to the model is what the request carries.
    reasoningEffort: reasoningEffortSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.apiKeyEnv && value.providerId) {
      ctx.addIssue({ code: 'custom', message: 'Configure at most one provider reference' });
    }

    if (value.provider === 'openai-compatible' && !value.baseURL) {
      ctx.addIssue({ code: 'custom', message: 'baseURL is required for compatible providers' });
    }

    if (value.baseURL && !/^https?:\/\//.test(value.baseURL)) {
      ctx.addIssue({ code: 'custom', message: 'baseURL must use HTTP(S)' });
    }
  });

export const skillNameSchema = z.string().regex(/^[a-z0-9_-]{1,64}$/);

/**
 * Built-in skills a new profile starts without: useful to some owners, noise to others, so each
 * owner decides. They still ship, and are switched on under Skills.
 */
export const OPT_IN_SKILLS = ['discernment-nudge'] as const;

export const skillSchema = z.strictObject({
  name: skillNameSchema,
  description: z.string().min(1).max(300),
  instructions: z.string().min(1).max(12_000),
  // Present only on a skill the owner imported.
  origin: skillOriginSchema.optional(),
  // Set on a skill the agent wrote for itself: the only skills it may change or remove. What
  // the owner wrote or imported stays theirs, so "who wrote this instruction" stays answerable.
  writtenBy: z.literal('agent').optional(),
});

/**
 * A skill shipped with the gateway. The owner cannot edit or remove one — only switch it off
 * for a profile — so the instructions travel with it: what an agent is told has to be readable.
 */
export const builtinSkillSchema = skillSchema.extend({
  enabled: z.boolean(),
});

/**
 * A value the gateway sends but never shows back: typed once and kept encrypted, or read from
 * the host environment. Sending `value` replaces what is stored; leaving it out keeps it.
 */
export const mcpValueSchema = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  value: secretSchema.optional(),
  fromEnv: z
    .string()
    .regex(/^JIAN_MCP_[A-Z0-9_]+$/)
    .optional(),
});

/**
 * How a server proves who is calling it.
 *
 * `headers` covers every scheme a server can want, because the owner writes the header itself:
 * `Authorization: Bearer …`, `Authorization: Basic …`, or something proprietary. `oauth` hands
 * the whole exchange to the server's own authorization server, and the owner signs in once.
 */
export const mcpAuthSchema = z.enum(['none', 'headers', 'oauth']);

export const mcpSchema = z
  .strictObject({
    name: z.string().regex(/^[a-z0-9_]{1,30}$/),
    /** `http` talks to a URL; `stdio` runs a command on this machine and speaks over its pipes. */
    transport: z.enum(['http', 'stdio']).default('http'),
    url: endpointSchema.optional(),
    auth: mcpAuthSchema.default('none'),
    headers: z.array(mcpValueSchema).max(10).default([]),
    command: z.string().trim().min(1).max(400).optional(),
    args: z.array(z.string().max(400)).max(30).default([]),
    env: z.array(mcpValueSchema).max(20).default([]),
    /** The server's own names of tools the owner switched off: the agent is never offered them. */
    disabledTools: z.array(z.string().min(1).max(200)).max(200).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.transport === 'http' && !value.url) {
      ctx.addIssue({ code: 'custom', message: 'An HTTP server needs a URL', path: ['url'] });
    }

    if (value.transport === 'stdio' && !value.command) {
      ctx.addIssue({
        code: 'custom',
        message: 'A command server needs a command',
        path: ['command'],
      });
    }

    // OAuth is the server's own exchange over HTTP; a command server has no browser to send
    // the owner to, and nothing to redirect back to.
    if (value.auth === 'oauth' && value.transport !== 'http') {
      ctx.addIssue({ code: 'custom', message: 'OAuth needs an HTTP server', path: ['auth'] });
    }
  });

/** What a server answered when the owner asked whether it works. */
export const mcpStatusSchema = z.strictObject({
  name: z.string(),
  reachable: z.boolean(),
  /** Everything the server offers. The agent still loads a tool before it can call it. */
  tools: z
    .array(z.strictObject({ name: z.string(), description: z.string().max(600).optional() }))
    .max(500)
    .default([]),
  error: z.string().max(300).optional(),
  /** Where the owner has to sign in, when the server asked for it and nobody has yet. */
  authorizationUrl: z.url().max(2000).optional(),
  checkedAt: z.iso.datetime(),
});

export const identitySchema = z.strictObject({
  role: z.string().max(1000).default(''),
  tone: z.string().max(1000).default(''),
  goals: z.array(z.string().max(500)).max(10).default([]),
  boundaries: z.array(z.string().max(500)).max(10).default([]),
});

export const contextPolicySchema = z
  .strictObject({
    // The ceilings follow the model's own window, so a million-token model is not run inside a
    // budget written for a small one. The defaults here are the floor a profile starts from
    // before a model is chosen; the run's own policy is derived from what that model holds.
    inputTokens: z.number().int().min(16000).max(900000).default(32000),
    outputTokens: z.number().int().min(256).max(64000).default(4096),
    memoryTokens: z.number().int().min(0).max(32000).default(1500),
    historyTokens: z.number().int().min(0).max(200000).default(6000),
    toolResultTokens: z.number().int().min(128).max(32000).default(1500),
    // A backstop, not the thing that should fire. What really ends a turn is its token budget;
    // a step ceiling low enough to be reached is a turn thrown away with the work already paid
    // for. There is no clock on a turn: only a call that stops answering is given up on.
    maxSteps: z.number().int().min(1).max(500).default(200),
    // A stop for a turn that has gone wrong, not a bound on a turn doing its job: reaching it
    // ends the loop with an answer rather than a failure.
    maxRunTokens: z.number().int().min(32000).max(20_000_000).default(500000),
  })
  .refine((policy) => policy.outputTokens < policy.inputTokens, {
    message: 'Output reservation must be smaller than the input budget',
    path: ['outputTokens'],
  });

/**
 * The profile picture travels inline so every client renders it from the profile it already
 * fetched. It stays out of `identity` because identity is serialized into the system prompt
 * and is writable by a self-managing agent; base64 belongs in neither. The cap keeps a
 * profile write inside the 256 KB request body limit — roughly a 256x256 JPEG.
 */
export const avatarSchema = z
  .string()
  .regex(
    /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/,
    'Use an inline PNG, JPEG or WebP image',
  )
  .max(100_000, 'The picture must stay under 100 kB encoded');

/**
 * The one line the other agents of this installation read about this one. Discovery shows the
 * name and this text, and nothing else ever crosses: instructions, identity, memories and
 * history stay inside the profile. Empty until the owner writes it.
 */
const summaryText = z.string().trim().max(280);

export const summarySchema = summaryText.default('');

export const profileSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  instructions: z.string().trim().min(1).max(8_000),
  summary: summarySchema,
  avatar: avatarSchema.nullable().default(null),
  // Retained for existing installations and old runs; new profiles choose models per run.
  model: modelSchema.default({ provider: 'openai', modelId: 'unconfigured' }),
  identity: identitySchema.default(() => identitySchema.parse({})),
  contextPolicy: contextPolicySchema.default(() => contextPolicySchema.parse({})),
  skills: z.array(skillSchema).max(20).default([]),
  // Built-in skills this profile should not carry. Imported skills are removed from `skills`;
  // a built-in one cannot be removed, only switched off here.
  // Built-in skills that start switched off, for the owner to turn on in Skills.
  disabledSkills: z
    .array(skillNameSchema)
    .max(20)
    .default([...OPT_IN_SKILLS]),
  mcpServers: z.array(mcpSchema).default([]),
  allowSelfManagement: z.boolean().default(false),
  /**
   * Reading files, writing files and running commands on the machine the gateway runs on,
   * with the privileges of whoever started it. Off by default and never implied by anything
   * else: it is the one setting that turns a conversation into access to a computer.
   */
  allowShell: z.boolean().default(false),
  /**
   * Searching the web and reading public pages, through the installation's search service.
   * What comes back is written by strangers, so it reaches the agent as data to weigh.
   */
  allowWebSearch: z.boolean().default(false),
  /**
   * After a turn worth looking back on — many tools, an error it recovered from, or enough
   * turns since the last look — the agent reviews it in the background and keeps what it
   * learned as a skill or a memory, in its Learning conversation.
   */
  learnFromWork: z.boolean().default(true),
  /** Deprecated compatibility field. Sticker analysis in model defaults controls this now. */
  useStickers: z.boolean().default(false),
  /**
   * Whether this profile takes part in conversations between agents. Off, the others no longer
   * see it or reach it, and it loses them too: the wall runs both ways.
   */
  reachableByAgents: z.boolean().default(true),
});

export const profilePatchSchema = profileSchema.partial().extend({
  expectedVersion: z.number().int().positive(),
  // Without the default: a patch that does not mention the summary was filling one in, and
  // every edit made elsewhere — a skill switched off, an MCP server added — erased it.
  summary: summaryText.optional(),
  // Absent keeps the current picture; an explicit null removes it.
  avatar: avatarSchema.nullable().optional(),
  model: modelSchema.optional(),
  identity: identitySchema.optional(),
  contextPolicy: contextPolicySchema.optional(),
  skills: z.array(skillSchema).max(20).optional(),
  disabledSkills: z.array(skillNameSchema).max(20).optional(),
  mcpServers: z.array(mcpSchema).optional(),
  allowSelfManagement: z.boolean().optional(),
  allowShell: z.boolean().optional(),
  allowWebSearch: z.boolean().optional(),
  learnFromWork: z.boolean().optional(),
  useStickers: z.boolean().optional(),
  reachableByAgents: z.boolean().optional(),
});

/**
 * The channel of the one conversation the owner holds with a profile through the panel. The
 * gateway opens it on its own, exactly one per profile, so no caller may create another.
 */
export const GATEWAY_SESSION_CHANNEL = 'gateway';
/** Where an agent reviews its own turns and says what it kept: one per profile. */
export const LEARNING_SESSION_CHANNEL = 'learning';
export const TASK_SESSION_CHANNEL = 'task';

export const sessionSchema = z.strictObject({
  // Absent on purpose: the agent names the conversation from its first message, and the owner
  // renames it whenever they like. Asking for a name before there is anything to name is not
  // a decision anyone can make well.
  title: z.string().trim().min(1).max(160).optional(),
  channel: z
    .string()
    .regex(/^[a-z0-9_-]{1,40}$/)
    .refine(
      (channel) =>
        channel !== GATEWAY_SESSION_CHANNEL &&
        channel !== LEARNING_SESSION_CHANNEL &&
        channel !== TASK_SESSION_CHANNEL,
      {
        message: 'Internal conversations are opened by the gateway itself',
      },
    )
    .default('api'),
});

export const sessionRenameSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
});

/** The model this conversation runs on, over the profile's defaults. Null goes back to them. */
export const sessionModelSchema = z.strictObject({
  model: modelSelectionSchema.nullable(),
});

export const submitSchema = z
  .strictObject({
    mediaIds: z.array(z.uuid()).max(MAX_MESSAGE_MEDIA).optional(),
    // May be empty when attachments are the message, as a voice note is.
    text: z.string().trim().max(8_000),
    requestKey: z.string().min(1).max(120),
    model: modelSelectionSchema.optional(),
  })
  .refine((input) => input.text.length > 0 || Boolean(input.mediaIds?.length), {
    message: 'A message needs text or an attachment',
    path: ['text'],
  });

export const memoryKeySchema = z.string().regex(/^[a-z0-9_-]{1,100}$/);

export const memorySchema = z.strictObject({
  key: memoryKeySchema,
  content: z.string().trim().min(1).max(4_000),
  expectedVersion: z.number().int().nonnegative(),
});

/** How many memories one can be linked to: enough for a topic, few enough to stay a topic. */
export const MEMORY_LINK_LIMIT = 12;

/** The owner rewriting a memory from the panel, against the version they read. */
export const memoryEditSchema = z.strictObject({
  content: z.string().trim().min(1).max(4_000),
  expectedVersion: z.number().int().positive(),
});

export type McpStatus = z.infer<typeof mcpStatusSchema>;
export type Skill = z.infer<typeof skillSchema>;
export type McpServer = z.infer<typeof mcpSchema>;
/**
 * Copies servers from another profile: each becomes this profile's own, with its own copy of
 * the typed values, and changing one never changes the other. Absent `servers` copies them all.
 */
export const mcpImportSchema = z.strictObject({
  fromProfileId: z.uuid(),
  servers: z.array(z.string().regex(/^[a-z0-9_]{1,30}$/)).optional(),
});

export const mcpImportResultSchema = z.strictObject({
  imported: z.array(z.string()),
  // A server this profile already has under that name is left as it is.
  skipped: z.array(z.strictObject({ name: z.string(), reason: z.string() })),
  // A sign-in belongs to the profile that made it; these servers need one here too.
  signIn: z.array(z.string()),
});

export type McpValue = z.infer<typeof mcpValueSchema>;
export type Identity = z.infer<typeof identitySchema>;
export type ContextPolicy = z.infer<typeof contextPolicySchema>;
