import { pipelineReportSchema, type Run, requestProposalSchema } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { PipelineChain } from './service.js';

/** The author's report on a request walking to an epic (B23). */
export function pipelineTools(
  pipeline: Pick<PipelineChain, 'report' | 'proposeRequest'>,
  run: Run,
): ToolSet {
  return {
    propose_request: tool({
      description:
        'At the end of a talk with the owner about a pauta, propose the request card for the Entrada: the title and a description with Origem (the pauta), the screens, what was decided and the prototype link, as the developers will read it. Nothing reaches the board before the owner answers it in the inbox. Never with an open question in it.',
      inputSchema: requestProposalSchema,
      execute: async (input) => pipeline.proposeRequest(input, { profileId: run.profileId }),
    }),
    report_request: tool({
      description:
        'Report on a request of the Entrada walking to an epic: the pauta you found or opened for it, whether the screen needs a prototype (a new screen or a visible change does; a rule, a bug with no screen change or backend work does not) and, when it does, the application slug and what to draw. When the origin or the screen is unknown, say what is missing in `missing` instead and open a decision for the owner; never presume it.',
      inputSchema: pipelineReportSchema.extend({ pipelineId: z.uuid() }),
      execute: async ({ pipelineId, ...input }) =>
        pipeline.report(pipelineId, input, { profileId: run.profileId, sessionId: run.sessionId }),
    }),
  };
}
