import {
  type Run,
  roadmapLaneSchema,
  roadmapProposalInputSchema,
  roadmapStateSchema,
  roadmapSyncInputSchema,
} from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { Roadmap } from './service.js';

/**
 * The roadmap for agents: every one reads it, only the Estrategista proposes and sends its
 * reading of the boards. The runtime removes those two from any other profile; the service
 * refuses them as well.
 */
export function roadmapTools(
  roadmap: Pick<Roadmap, 'lookup' | 'propose' | 'sync'>,
  run: Run,
): ToolSet {
  return {
    read_roadmap: tool({
      description:
        'Read the products’ roadmap: the active items lane by lane (agora, proximo, depois) with their number, id, application, kind, theme, blocked mark and the request, topic and epics they point to; the proposals waiting for the owner; and the settings (automatic moves, suggestions per round, applications). Filter by application (slug or name), lane or state. Where a request or epic stands is still read on the Work and the topic.',
      inputSchema: z.object({
        application: z.string().trim().max(160).optional(),
        lane: roadmapLaneSchema.optional(),
        state: roadmapStateSchema.optional(),
      }),
      execute: async (input) => roadmap.lookup(input),
    }),
    sync_roadmap: tool({
      description:
        'As the Estrategista, send your reading of the boards and topics. One entry per item that changes (itemId with lane, state concluido or descartado, or blocked) and one per request or topic with no item yet (new, with origin pedido or pauta). Lane rules: request Em execução or epic out of A fazer = agora; request Priorizado or Aprovado, topic pronta-para-epico = proximo; topic descoberta = depois; request Concluído or every epic approved = state concluido; request Recusado or topic descartada = state descartado; blocked request or epic, or paused topic = blocked true, lane kept. Every entry has the reason and the evidence (links). Forward moves apply on their own only when the automatic switch is on; backward moves, discards and new items always wait for the owner. Never invent a signal.',
      inputSchema: roadmapSyncInputSchema,
      execute: async (input) => roadmap.sync(input, { profileId: run.profileId }),
    }),
    propose_roadmap: tool({
      description:
        'As the Estrategista, propose a change to the roadmap for the owner’s OK: incluir (a new item: application, title, summary saying why and for whom, kind feature, melhoria, divida or ideia, lane, theme), mover (itemId to lane), concluir or descartar (itemId). Always give the reason, a real counterpoint and at least one piece of evidence (request, topic, decision, validation, rule). Mark highImpact when it touches the high-impact list of the mentions. A suggestion the owner refused in the last 60 days is refused again; read the roadmap first so nothing is proposed twice.',
      inputSchema: roadmapProposalInputSchema,
      execute: async (input) => roadmap.propose(input, { profileId: run.profileId }),
    }),
  };
}
