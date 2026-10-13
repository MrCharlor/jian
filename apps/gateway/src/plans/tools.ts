import { planReviewSchema, planWriteSchema, type Run } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { Plans } from './service.js';

/** Writing a plan before an action, reviewing it, and reading it back. */
export function planTools(plans: Pick<Plans, 'write' | 'review' | 'read'>, run: Run): ToolSet {
  return {
    write_plan: tool({
      description:
        'Write the plan you were asked for before an action (a prototype) and stop: what you will do, where each thing came from (topic, decision, rule, print), what you assumed and what you will deliver. Never invent: what is missing becomes a question to the owner inside the plan. The plan goes to the Reviewer; when it comes back with findings, fix them and write it again with the same planId.',
      inputSchema: planWriteSchema.extend({ planId: z.uuid() }),
      execute: async ({ planId, ...input }) => plans.write(planId, input, run),
    }),
    review_plan: tool({
      description:
        'Review a plan you were asked to review, against the owner’s rules, memories, preferences, screen standards and the topic’s decisions, and the owner’s recent corrections you were given. Answer with the plan rewritten shorter (revised) and every finding with its kind and source. Kinds: divergencia = the plan contradicts a rule, a decision or the request; regra_sensivel = it touches billing (faturamento), tax (fiscal: Tipos e Natureza), customer data (CPF, LGPD), price, permission or data in production; lacuna = information is missing to act without inventing. With any finding, do not approve. You never run the action.',
      inputSchema: planReviewSchema.extend({ planId: z.uuid() }),
      execute: async ({ planId, ...input }) => plans.review(planId, input, run),
    }),
    read_plan: tool({
      description:
        'Read a plan by its id or number: the original, the Reviewer’s shorter version, the findings, the rounds, its state and the owner’s last note.',
      inputSchema: z.object({
        planId: z.uuid().optional(),
        number: z.number().int().positive().optional(),
      }),
      execute: async ({ planId, number }) => {
        if (planId) return plans.read({ id: planId });
        if (number) return plans.read({ number });
        throw new Error('Give the planId or the number of the plan');
      },
    }),
  };
}
