import { pipelineReportSchema, type Run } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { PipelineChain } from './service.js';

/** The author's report on a request walking to an epic (B23). */
export function pipelineTools(pipeline: Pick<PipelineChain, 'report'>, run: Run): ToolSet {
  return {
    report_request: tool({
      description:
        'Report on a request of the Entrada walking to an epic: the pauta you found or opened for it, whether the screen needs a prototype (a new screen or a visible change does; a rule, a bug with no screen change or backend work does not) and, when it does, the application slug and what to draw. When the origin or the screen is unknown, say what is missing in `missing` instead and open a decision for the owner; never presume it.',
      inputSchema: pipelineReportSchema.extend({ pipelineId: z.uuid() }),
      execute: async ({ pipelineId, ...input }) =>
        pipeline.report(pipelineId, input, { profileId: run.profileId, sessionId: run.sessionId }),
    }),
  };
}
