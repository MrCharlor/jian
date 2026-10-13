import { knowledgeProposalInputSchema, type Run } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { Knowledge } from './service.js';

/**
 * The knowledge base for agents: every one searches it, only the Curator proposes. The runtime
 * removes propose_knowledge from any other profile; the service refuses it as well.
 */
export function knowledgeTools(
  knowledge: Pick<Knowledge, 'lookup' | 'propose'>,
  run: Run,
): ToolSet {
  return {
    search_knowledge: tool({
      description:
        'Search the owner’s knowledge base BEFORE asking the owner (Moabe) anything: rules he already answered, each with where it holds (general, an application, a kind of screen such as every listing of the ERP, or one screen) and its source. Give a few words of the subject and, when you know them, the application and the screen. Use what you find and cite it as "regra #N"; ask only what the base does not answer. A sensitive rule touches billing, tax, customer data, price, permission or production data.',
      inputSchema: z.object({
        q: z.string().trim().max(200).optional(),
        application: z.string().trim().max(160).optional(),
        screen: z.string().trim().max(160).optional(),
      }),
      execute: async (input) => knowledge.lookup(input),
    }),
    propose_knowledge: tool({
      description:
        'As the Curator, propose a change to the knowledge base from what the owner answered: incluir (a new rule, with its scope), mudar (a new text for ruleNumber, which retires it) or aposentar (retire ruleNumber). Always give the reason and the source (kind, ref, date). Search first: a conflict with a rule is a mudar of that rule, never a second rule. Default scope: the kind of screen in the application (every listing of the ERP); one screen only when the answer is about it alone. Mark sensitive what touches billing, tax, customer data, price, permission or production data. The owner approves it unless the base is automatic; a sensitive one may wait anyway.',
      inputSchema: knowledgeProposalInputSchema,
      execute: async (input) => knowledge.propose(input, { profileId: run.profileId }),
    }),
  };
}
