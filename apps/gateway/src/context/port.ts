import type { Run } from '@jian/contracts';

export interface ContextSource {
  context(run: Run): Promise<{
    system: string;
    messages: Array<{ role: 'user' | 'assistant'; content: string }>;
    currentStartIndex?: number;
    historyCursor?: { id: string; createdAt: string };
    /** The turn was judged plainly light, so it may be answered with less reasoning. */
    light?: true;
  }>;
}
