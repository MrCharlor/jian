import { z } from 'zod';

/**
 * The owner's knowledge base (B19): rules every agent reads before asking the owner anything,
 * each with where it holds and where it came from. Only the Curator proposes changes to it;
 * the owner approves them, unless the base is automatic and the rule is not sensitive.
 */

/**
 * Where a rule holds. `tipo_de_tela` names a kind of screen in `screen` ("listagem") within an
 * application, or in every application when none is given; `tela` names one screen.
 */
export const knowledgeScopeKindSchema = z.enum(['geral', 'aplicacao', 'tipo_de_tela', 'tela']);

const scopeName = z.string().trim().min(1).max(160);

export const knowledgeScopeSchema = z
  .strictObject({
    kind: knowledgeScopeKindSchema,
    application: scopeName.optional(),
    /** The screen, or the kind of screen for `tipo_de_tela`. */
    screen: scopeName.optional(),
  })
  .refine((scope) => scope.kind !== 'aplicacao' || scope.application, {
    message: 'An application scope names the application',
    path: ['application'],
  })
  .refine((scope) => !['tela', 'tipo_de_tela'].includes(scope.kind) || scope.screen, {
    message: 'A screen scope names the screen, or the kind of screen',
    path: ['screen'],
  });

export const knowledgeSourceKindSchema = z.enum([
  'inventario',
  'plano',
  'correcao',
  'decisao',
  'validacao',
  'manual',
]);

export const knowledgeSourceSchema = z.strictObject({
  kind: knowledgeSourceKindSchema,
  /** What it rests on: a memory, a file, "Plano #3", "Decisão #4". */
  ref: z.string().trim().max(500).default(''),
  /** The day the owner said it, which can be older than the rule. */
  date: z.iso.date().optional(),
});

/** `pendente` waits for the owner before any agent reads it; `aposentada` no longer holds. */
export const knowledgeStateSchema = z.enum(['ativa', 'pendente', 'aposentada']);

export const knowledgeRecordSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  /** The inventory's own name for it ("G01", "FI30"), kept so a load is not repeated. */
  code: z.string().optional(),
  text: z.string(),
  scope: knowledgeScopeSchema,
  source: knowledgeSourceSchema,
  /** Touches billing, tax, customer data, price, permission or production data. */
  sensitive: z.boolean(),
  state: knowledgeStateSchema,
  /** The number of the rule this one took the place of. */
  replaces: z.number().int().positive().optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const knowledgeListQuerySchema = z.strictObject({
  /** Words of the subject; every one must appear in the rule, its scope or its code. */
  q: z.string().trim().max(200).optional(),
  application: z.string().trim().max(160).optional(),
  screen: z.string().trim().max(160).optional(),
  state: knowledgeStateSchema.optional(),
});

export const knowledgePatchSchema = z.strictObject({
  text: z.string().trim().min(1).max(2000).optional(),
  scope: knowledgeScopeSchema.optional(),
  sensitive: z.boolean().optional(),
  state: knowledgeStateSchema.optional(),
});

export const knowledgeImportRuleSchema = z.strictObject({
  code: z.string().trim().min(1).max(20).optional(),
  text: z.string().trim().min(1).max(2000),
  scope: knowledgeScopeSchema,
  source: knowledgeSourceSchema,
  sensitive: z.boolean().default(false),
  state: knowledgeStateSchema.default('ativa'),
  /** The code of the rule this one replaces, in this load or an earlier one; it retires. */
  replaces: z.string().trim().min(1).max(20).optional(),
});

/** A load of rules, such as the inventory. A code already in the base is skipped, not changed. */
export const knowledgeImportSchema = z.strictObject({
  rules: z.array(knowledgeImportRuleSchema).min(1).max(500),
});

export const knowledgeImportResultSchema = z.strictObject({
  created: z.array(knowledgeRecordSchema),
  /** Codes already in the base, left as they are. */
  skipped: z.array(z.string()),
});

export const knowledgeProposalKindSchema = z.enum(['incluir', 'mudar', 'aposentar']);

export const knowledgeProposalStateSchema = z.enum(['aguardando_po', 'aplicada', 'recusada']);

/** What the Curator sends: a new rule, a new text for one, or one to retire, always with the source. */
export const knowledgeProposalInputSchema = z
  .strictObject({
    kind: knowledgeProposalKindSchema,
    /** The rule changed or retired. */
    ruleNumber: z.number().int().positive().optional(),
    text: z.string().trim().min(1).max(2000).optional(),
    /** Required for a new rule; a changed one keeps its scope unless one is given. */
    scope: knowledgeScopeSchema.optional(),
    sensitive: z.boolean().default(false),
    reason: z.string().trim().min(1).max(2000),
    source: knowledgeSourceSchema,
  })
  .refine((input) => input.kind === 'incluir' || input.ruleNumber, {
    message: 'Changing or retiring a rule names its ruleNumber',
    path: ['ruleNumber'],
  })
  .refine((input) => input.kind === 'aposentar' || input.text, {
    message: 'A new or changed rule has its text',
    path: ['text'],
  })
  .refine((input) => input.kind !== 'incluir' || input.scope, {
    message: 'A new rule has its scope',
    path: ['scope'],
  });

export const knowledgeProposalRecordSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  kind: knowledgeProposalKindSchema,
  ruleNumber: z.number().int().positive().optional(),
  /** The target rule's text when the proposal was made, to read beside the new one. */
  ruleText: z.string().optional(),
  text: z.string().optional(),
  scope: knowledgeScopeSchema.optional(),
  sensitive: z.boolean(),
  reason: z.string(),
  source: knowledgeSourceSchema,
  state: knowledgeProposalStateSchema,
  proposedBy: z.string().optional(),
  appliedBy: z.enum(['owner', 'automatico']).optional(),
  /** The rule the proposal created, once applied. */
  resultNumber: z.number().int().positive().optional(),
  note: z.string().optional(),
  decidedVia: z.enum(['panel', 'channel', 'api', 'automatico']).optional(),
  decidedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
});

export const knowledgeProposalListQuerySchema = z.strictObject({
  state: knowledgeProposalStateSchema.optional(),
});

export const knowledgeProposalRejectSchema = z.strictObject({
  reason: z.string().trim().max(2000).optional(),
});

export const knowledgeSettingsSchema = z.strictObject({
  /** On: the Curator's proposals apply without the owner's OK. */
  automatic: z.boolean(),
  /** On: a sensitive proposal waits for the owner even when the base is automatic. */
  sensitiveAlwaysAsks: z.boolean(),
  /** The only agent that proposes changes. Absent: nobody keeps the base. */
  curatorProfileId: z.uuid().optional(),
});

export const knowledgeSettingsPatchSchema = z.strictObject({
  automatic: z.boolean().optional(),
  sensitiveAlwaysAsks: z.boolean().optional(),
  curatorProfileId: z.uuid().nullable().optional(),
});

export type KnowledgeScope = z.infer<typeof knowledgeScopeSchema>;
export type KnowledgeSource = z.infer<typeof knowledgeSourceSchema>;
export type KnowledgeState = z.infer<typeof knowledgeStateSchema>;
export type KnowledgeRule = z.infer<typeof knowledgeRecordSchema>;
export type KnowledgeProposal = z.infer<typeof knowledgeProposalRecordSchema>;
export type KnowledgeSettings = z.infer<typeof knowledgeSettingsSchema>;

export type KnowledgeReply = { number: number; approve: boolean; reason?: string };

const RULE_OK = [
  /^(?:ok|aprovar|aprovado|aprova)\s+regra\s+#?(\d{1,6})\.?$/i,
  /^regra\s+#?(\d{1,6})\s*[:,-]?\s*(?:ok|aprovada|aprovar|aprova)\.?$/i,
];

const RULE_NO =
  /^(?:recusa|recusar|recusada|rejeita)\s+regra\s+#?(\d{1,6})(?:\s*[:,-]\s*([\s\S]{1,2000}))?$/i;

/**
 * The owner's answer to a proposed rule in a chat: "ok regra 4" or "recusa regra 4: motivo".
 * The number is the proposal's, as the message that asked says it.
 */
export function parseKnowledgeReply(text: string): KnowledgeReply | undefined {
  const words = text.trim();

  for (const pattern of RULE_OK) {
    const match = pattern.exec(words);
    if (match) return { number: Number(match[1]), approve: true };
  }

  const match = RULE_NO.exec(words);
  if (!match) return undefined;

  const reason = match[2]?.trim();

  return { number: Number(match[1]), approve: false, ...(reason ? { reason } : {}) };
}
