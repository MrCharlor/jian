import { z } from 'zod';

/**
 * The roadmap of the products (B24): lanes Agora, Próximo and Depois, no dates. It lives only
 * here; where a request or a topic stands is still read on the work tracker and on the topic,
 * and an item only points to them. The Estrategista keeps it: it reads the boards and proposes,
 * and moves forward on its own only when the owner turned the automatic switch on. The owner's
 * own edits are direct.
 */
export const roadmapLaneSchema = z.enum(['agora', 'proximo', 'depois']);

export const roadmapKindSchema = z.enum(['feature', 'melhoria', 'divida', 'ideia']);

export const roadmapStateSchema = z.enum(['ativo', 'concluido', 'descartado']);

export const roadmapOriginSchema = z.enum(['moabe', 'pedido', 'pauta', 'sugestao']);

export const roadmapProposalKindSchema = z.enum(['incluir', 'mover', 'concluir', 'descartar']);

export const roadmapProposalStateSchema = z.enum(['aguardando_po', 'aplicada', 'recusada']);

const title = z.string().trim().min(1).max(200);
const summary = z.string().trim().max(4000);
const theme = z.string().trim().min(1).max(80);
const workId = z.string().trim().min(1).max(80);
/** An application by its slug or its name. */
const product = z.string().trim().min(1).max(160);

export const roadmapItemSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  applicationId: z.uuid(),
  /** The application's slug. */
  application: z.string(),
  applicationName: z.string(),
  title: z.string(),
  /** Why, and for whom; short markdown. */
  summary: z.string(),
  kind: roadmapKindSchema,
  lane: roadmapLaneSchema,
  /** The order within the lane, from 0. */
  position: z.number().int().min(0),
  state: roadmapStateSchema,
  /** A request or epic it rests on is blocked, or its topic paused; the lane stays. */
  blocked: z.boolean(),
  origin: roadmapOriginSchema,
  pautaId: z.uuid().optional(),
  pautaTitle: z.string().optional(),
  /** The request on the Entrada. */
  requestWorkId: z.string().optional(),
  requestUrl: z.string().optional(),
  epicWorkIds: z.array(z.string()),
  /** Free text that groups items: "Fiscal", "Encomendas". */
  theme: z.string().optional(),
  /** The profile that proposed it, or "owner". */
  createdBy: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  concludedAt: z.iso.datetime().optional(),
});

export const roadmapListQuerySchema = z.strictObject({
  /** The application's slug or name. */
  application: product.optional(),
  lane: roadmapLaneSchema.optional(),
  state: roadmapStateSchema.optional(),
});

/** The owner's own item: direct, never a proposal. */
export const roadmapItemCreateSchema = z.strictObject({
  application: product,
  title,
  summary: summary.default(''),
  kind: roadmapKindSchema.default('ideia'),
  lane: roadmapLaneSchema.default('depois'),
  theme: theme.optional(),
  pautaId: z.uuid().optional(),
  requestWorkId: workId.optional(),
  epicWorkIds: z.array(workId).max(30).default([]),
});

/** The owner's edit: lane and order, texts, theme, links, concluding or discarding. */
export const roadmapItemPatchSchema = z.strictObject({
  application: product.optional(),
  title: title.optional(),
  summary: summary.optional(),
  kind: roadmapKindSchema.optional(),
  lane: roadmapLaneSchema.optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  state: roadmapStateSchema.optional(),
  blocked: z.boolean().optional(),
  theme: theme.nullable().optional(),
  pautaId: z.uuid().nullable().optional(),
  requestWorkId: workId.nullable().optional(),
  epicWorkIds: z.array(workId).max(30).optional(),
});

export const roadmapItemParamsSchema = z.strictObject({ itemId: z.uuid() });

/** A new item as the Estrategista writes it, in a proposal or a reading. */
export const roadmapDraftSchema = z.strictObject({
  /** The application's slug or name. */
  application: product,
  title,
  summary: summary.default(''),
  kind: roadmapKindSchema.default('feature'),
  lane: roadmapLaneSchema.default('depois'),
  theme: theme.optional(),
  origin: z.enum(['pedido', 'pauta', 'sugestao']).default('sugestao'),
  pautaId: z.uuid().optional(),
  requestWorkId: workId.optional(),
  epicWorkIds: z.array(workId).max(30).default([]),
});

const evidence = z.array(z.string().trim().min(1).max(500)).max(12);

/** The Estrategista's suggestion or change, always for the owner's OK. */
export const roadmapProposalInputSchema = z
  .strictObject({
    kind: roadmapProposalKindSchema,
    /** The item moved, concluded or discarded. */
    itemId: z.uuid().optional(),
    /** The new item, for incluir. */
    item: roadmapDraftSchema.optional(),
    /** The lane it moves to, for mover. */
    lane: roadmapLaneSchema.optional(),
    reason: z.string().trim().min(1).max(2000),
    counterpoint: z.string().trim().min(1).max(2000),
    /** Links: request, topic, decision, validation, rule. At least one. */
    evidence: evidence.min(1),
    /** It touches the high-impact list of the mentions. */
    highImpact: z.boolean().default(false),
  })
  .refine((input) => input.kind !== 'incluir' || input.item, {
    message: 'A new item (incluir) has its item',
    path: ['item'],
  })
  .refine((input) => input.kind === 'incluir' || input.itemId, {
    message: 'Moving, concluding or discarding names its itemId',
    path: ['itemId'],
  })
  .refine((input) => input.kind !== 'mover' || input.lane, {
    message: 'A move names its lane',
    path: ['lane'],
  });

/** One line of the Estrategista's reading: an item it knows, or a new one it found. */
export const roadmapSyncEntrySchema = z
  .strictObject({
    itemId: z.uuid().optional(),
    new: roadmapDraftSchema.optional(),
    /** The lane the signal on the board puts it in. */
    lane: roadmapLaneSchema.optional(),
    /** concluido: the request is done, or every epic approved; descartado: refused or dropped. */
    state: roadmapStateSchema.optional(),
    blocked: z.boolean().optional(),
    reason: z.string().trim().min(1).max(2000),
    evidence: evidence.default([]),
  })
  .refine((entry) => Boolean(entry.itemId) !== Boolean(entry.new), {
    message: 'Each entry has either itemId or new',
    path: ['itemId'],
  });

export const roadmapSyncInputSchema = z.strictObject({
  entries: z.array(roadmapSyncEntrySchema).max(100),
});

export const roadmapProposalRecordSchema = z.strictObject({
  id: z.uuid(),
  number: z.number().int().positive(),
  kind: roadmapProposalKindSchema,
  itemId: z.uuid().optional(),
  itemNumber: z.number().int().positive().optional(),
  itemTitle: z.string().optional(),
  /** The application's slug and name, of the item or of the new one. */
  application: z.string().optional(),
  applicationName: z.string().optional(),
  /** The item's lane when proposed. */
  fromLane: roadmapLaneSchema.optional(),
  lane: roadmapLaneSchema.optional(),
  /** The new item, for incluir. */
  item: roadmapDraftSchema.optional(),
  reason: z.string(),
  counterpoint: z.string().optional(),
  evidence: z.array(z.string()),
  highImpact: z.boolean(),
  state: roadmapProposalStateSchema,
  /** The name of the profile that proposed it. */
  proposedBy: z.string().optional(),
  appliedBy: z.enum(['owner', 'automatico']).optional(),
  /** The item an applied incluir created. */
  resultNumber: z.number().int().positive().optional(),
  /** The owner's adjustment or reason for refusing. */
  note: z.string().optional(),
  decidedVia: z.enum(['panel', 'channel', 'api', 'automatico']).optional(),
  decidedAt: z.iso.datetime().optional(),
  createdAt: z.iso.datetime(),
});

export const roadmapProposalListQuerySchema = z.strictObject({
  state: roadmapProposalStateSchema.optional(),
});

export const roadmapProposalParamsSchema = z.strictObject({
  number: z.coerce.number().int().positive(),
});

/** The owner on a proposal: apply it, apply it with their adjustment, or refuse it. */
export const roadmapDecideSchema = z
  .strictObject({
    action: z.enum(['ok', 'edit', 'refuse']),
    /** The adjustment (edit), or the reason (refuse). */
    text: z.string().trim().min(1).max(2000).optional(),
  })
  .refine((input) => input.action !== 'edit' || input.text, {
    message: 'An adjustment has its text',
    path: ['text'],
  });

export const roadmapSyncResultSchema = z.strictObject({
  /** What changed at once: forward moves with the automatic switch on, and blocked marks. */
  applied: z.array(
    z.strictObject({
      itemNumber: z.number().int().positive(),
      title: z.string(),
      change: z.string(),
    }),
  ),
  proposed: z.array(roadmapProposalRecordSchema),
  skipped: z.array(z.strictObject({ index: z.number().int().min(0), why: z.string() })),
});

export const roadmapSettingsSchema = z.strictObject({
  /** The only agent that proposes and reads the boards into the roadmap. */
  strategistProfileId: z.uuid().optional(),
  /** On: forward moves read on the boards apply without the owner's OK. Never backward ones. */
  automaticMoves: z.boolean(),
  /** Suggestions the Estrategista makes on Monday. */
  suggestionsPerRound: z.number().int().min(1).max(10),
  /** The applications (slugs) the roadmap covers. */
  applications: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
});

export const roadmapSettingsPatchSchema = z.strictObject({
  strategistProfileId: z.uuid().nullable().optional(),
  automaticMoves: z.boolean().optional(),
  suggestionsPerRound: z.number().int().min(1).max(10).optional(),
  applications: z.array(z.string().trim().min(1).max(80)).min(1).max(20).optional(),
});

/** Which routine of the Estrategista to start now: the daily reading or the suggestions. */
export const roadmapRunSchema = z.strictObject({
  kind: z.enum(['leitura', 'sugestoes']).default('leitura'),
});

export const roadmapRunResultSchema = z.strictObject({
  kind: z.enum(['leitura', 'sugestoes']),
  profileId: z.uuid(),
  sessionId: z.uuid(),
  /** Whether the Entrada was read for the Estrategista; otherwise it reads it itself. */
  workRead: z.boolean(),
});

export type RoadmapLane = z.infer<typeof roadmapLaneSchema>;
export type RoadmapKind = z.infer<typeof roadmapKindSchema>;
export type RoadmapState = z.infer<typeof roadmapStateSchema>;
export type RoadmapOrigin = z.infer<typeof roadmapOriginSchema>;
export type RoadmapItem = z.infer<typeof roadmapItemSchema>;
export type RoadmapDraft = z.infer<typeof roadmapDraftSchema>;
export type RoadmapProposal = z.infer<typeof roadmapProposalRecordSchema>;
export type RoadmapProposalKind = z.infer<typeof roadmapProposalKindSchema>;
export type RoadmapSettings = z.infer<typeof roadmapSettingsSchema>;
export type RoadmapSyncResult = z.infer<typeof roadmapSyncResultSchema>;
export type RoadmapRunResult = z.infer<typeof roadmapRunResultSchema>;

export type RoadmapReply = { numbers: number[]; action: 'ok' | 'edit' | 'refuse'; text?: string };

/** The most proposals one "ok roadmap 1-50" applies. */
export const ROADMAP_BATCH = 50;

const LIST = '#?\\d{1,6}(?:\\s*(?:-|a|até)\\s*#?\\d{1,6})?';
const NUMBERS = `(${LIST}(?:\\s*(?:,|;|\\be\\b)\\s*${LIST})*)`;
const ROADMAP_OK = [
  new RegExp(`^(?:ok|aprovar|aprovado|aprova|aplica|aplicar)\\s+roadmap\\s+${NUMBERS}\\.?$`, 'i'),
  new RegExp(`^roadmap\\s+${NUMBERS}\\s*[:,-]?\\s*(?:ok|aprovado|aprova|aplica)\\.?$`, 'i'),
];
const ROADMAP_NO =
  /^(?:recusa|recusar|recusada|rejeita)\s+roadmap\s+#?(\d{1,6})(?:\s*[:,-]\s*([\s\S]{1,2000}))?$/i;
const ROADMAP_EDIT = /^roadmap\s+#?(\d{1,6})\s*:\s*([\s\S]{1,2000})$/i;

/** "1-12", "3, 5, 7", "3, 5 e 7": every number, in order, once; undefined past the batch. */
function numbersOf(list: string): number[] | undefined {
  const found: number[] = [];

  for (const part of list.split(/\s*(?:,|;|\be\b)\s*/i)) {
    const range = /^#?(\d{1,6})(?:\s*(?:-|a|até)\s*#?(\d{1,6}))?$/i.exec(part.trim());

    if (!range) return undefined;

    const from = Number(range[1]);
    const to = range[2] ? Number(range[2]) : from;

    if (from < 1 || to < from || to - from >= ROADMAP_BATCH) return undefined;
    for (let number = from; number <= to; number += 1) {
      if (!found.includes(number)) found.push(number);
    }
  }

  return found.length && found.length <= ROADMAP_BATCH ? found : undefined;
}

/**
 * The owner on the Estrategista's proposals, in a chat: "ok roadmap 4", "ok roadmap 1-12" or
 * "ok roadmap 3, 5, 7" applies them; "recusa roadmap 4: motivo" refuses one; "roadmap 4: texto"
 * applies one with the owner's adjustment.
 */
export function parseRoadmapReply(text: string): RoadmapReply | undefined {
  const words = text.trim();

  for (const pattern of ROADMAP_OK) {
    const match = pattern.exec(words);
    const numbers = match?.[1] ? numbersOf(match[1]) : undefined;
    if (numbers) return { numbers, action: 'ok' };
  }

  const refused = ROADMAP_NO.exec(words);

  if (refused) {
    const reason = refused[2]?.trim();
    return { numbers: [Number(refused[1])], action: 'refuse', ...(reason ? { text: reason } : {}) };
  }

  const edit = ROADMAP_EDIT.exec(words);
  const body = edit?.[2]?.trim();

  return edit && body ? { numbers: [Number(edit[1])], action: 'edit', text: body } : undefined;
}

export type RoadmapNote = {
  /** Everything after "roadmap:". */
  text: string;
  /** The text before " no <produto>", when it ends with one. */
  title: string;
  /** What followed the last " no ", " na ", " do ", " da " or " para o "; may name no product. */
  product?: string;
};

const NOTE = /^roadmap\s*:\s*([\s\S]{1,600})$/i;
const PRODUCT = /^([\s\S]+)\s+(?:no|na|do|da|para o|para a|pro|pra|em)\s+([^\s][^\n]{0,80})$/i;

/**
 * The owner's own idea, in a chat: "roadmap: <ideia> [no <produto>]". The product is a guess
 * until the gateway finds an application by that name; otherwise the whole text is the idea.
 */
export function parseRoadmapNote(text: string): RoadmapNote | undefined {
  const match = NOTE.exec(text.trim());
  const body = match?.[1]?.trim().replace(/\.$/, '').trim();

  if (!body) return undefined;

  const split = PRODUCT.exec(body);
  const product = split?.[2]?.trim();
  const title = split?.[1]?.trim();

  return product && title ? { text: body, title, product } : { text: body, title: body };
}
