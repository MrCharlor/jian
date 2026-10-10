import { describe, expect, it } from 'vitest';
import { flowReport, type Timeline, workingDays } from '../src/flow/service.js';

const at = (iso: string) => Date.parse(iso);

describe('working days', () => {
  it('skips the weekend in Brasília time', () => {
    // Friday 12:00 to Monday 12:00 in Brasília.
    expect(workingDays(at('2026-10-02T15:00:00Z'), at('2026-10-05T15:00:00Z'))).toBeCloseTo(1);
  });
});

describe('the flow report', () => {
  it('counts what was accepted, how long epics took, rework and what stands still', () => {
    const epic: Timeline = {
      id: 'e1',
      title: 'Épico de cores',
      kind: 'epic',
      column: 'Aceito',
      archived: false,
      createdAt: at('2026-10-05T12:00:00Z'),
      moves: [
        { at: at('2026-10-06T12:00:00Z'), from: 'A fazer', to: 'Em andamento' },
        { at: at('2026-10-07T12:00:00Z'), from: 'Em andamento', to: 'Em revisão' },
        { at: at('2026-10-08T12:00:00Z'), from: 'Em revisão', to: 'Aceito' },
      ],
    };
    const task: Timeline = {
      id: 't1',
      title: 'Listagem de cores',
      kind: 'task',
      column: 'Em andamento',
      assignee: 'diego',
      archived: false,
      createdAt: at('2026-10-05T12:00:00Z'),
      moves: [
        { at: at('2026-10-06T12:00:00Z'), from: 'Em andamento', to: 'Em revisão' },
        { at: at('2026-10-07T12:00:00Z'), from: 'Em revisão', to: 'Em andamento' },
      ],
    };

    const report = flowReport([epic, task], at('2026-10-09T12:00:00Z'), 2, { diego: 'Diego' });

    expect(report).toContain('| 05/10 | 0 | 1 | 1 |');
    expect(report).toContain('- Criado até Aceito: mediana 3,0 · máx 3,0 (1)');
    expect(report).toContain('- Diego: 1 voltas em 1 tasks.');
    expect(report).toContain('- Task em Em andamento há 2,0 (Diego): Listagem de cores');
    expect(report).not.toContain('Épico em');
  });
});
