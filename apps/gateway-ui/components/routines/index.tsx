'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { Routines as RoutinesView } from '../../lib/api';
import { date } from '../../lib/format';
import { actionLabel, planStateLabel } from '../plans/index';
import type { SectionProps } from '../props';
import { Badge, Empty, SectionHeading } from '../ui';

/**
 * Everything that runs on its own: every agent's schedules, the plans waiting for the owner,
 * and how many rounds each action went without a correction, which is what tells the owner
 * when to switch an action to automatic.
 */
export function Routines({ api }: SectionProps) {
  const [view, setView] = useState<RoutinesView>();
  const [error, setError] = useState('');

  const load = useCallback(
    () =>
      api
        .routines()
        .then((loaded) => {
          setView(loaded);
          setError('');
        })
        .catch((failure) =>
          setError(failure instanceof Error ? failure.message : 'As rotinas não carregaram.'),
        ),
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <SectionHeading
        title="Rotinas"
        description="O que roda sozinho: as agendas de todos os agentes, os planos esperando você e quantas rodadas cada ação foi sem correção."
      />
      {error && <p className="error">{error}</p>}

      <h3>Ações com plano</h3>
      <div className="request-list">
        {view?.actions.map((action) => (
          <article className="request-card" key={action.action}>
            <header>
              <div className="grow">
                <h4>
                  {actionLabel[action.action]}{' '}
                  <Badge tone={action.automatic ? 'accent' : 'neutral'}>
                    {action.automatic ? 'Automático' : 'Espera seu OK'}
                  </Badge>{' '}
                  {!action.reviewer && <Badge tone="warn">Sem Revisor: sem plano</Badge>}
                </h4>
                <small>
                  {action.executed} plano(s) executado(s) · {action.clean} seguido(s) sem correção
                  {action.lastCorrectionAt
                    ? ` · última correção ${date(action.lastCorrectionAt)}`
                    : ''}
                </small>
              </div>
            </header>
          </article>
        ))}
      </div>

      <h3>Planos esperando você ({view?.waiting.length ?? 0})</h3>
      {view && !view.waiting.length ? (
        <p className="note">Nenhum. Os planos ficam em Planos.</p>
      ) : (
        <ul>
          {view?.waiting.map((plan) => (
            <li key={plan.id}>
              <Link href="/plans">
                #{plan.number} ·{' '}
                {plan.action === 'priority' ? plan.title : `Protótipo "${plan.title}"`}
              </Link>{' '}
              <Badge tone="accent">{planStateLabel[plan.state]}</Badge>{' '}
              <small>
                {plan.findings.length
                  ? `${plan.findings.length} achado(s)`
                  : 'aprovado pelo Revisor'}
              </small>
            </li>
          ))}
        </ul>
      )}

      <h3>Agendas</h3>
      {view && !view.schedules.length ? (
        <Empty title="Nenhuma agenda">Os agentes ainda não têm rotina agendada.</Empty>
      ) : (
        <div className="table-scroll">
          <table className="quality-table">
            <thead>
              <tr>
                <th>Nome</th>
                <th>Perfil</th>
                <th>Quando</th>
                <th>Ligada</th>
                <th>Última vez</th>
                <th>Último erro</th>
                <th>Próxima</th>
              </tr>
            </thead>
            <tbody>
              {view?.schedules.map((schedule) => (
                <tr key={schedule.id}>
                  <td>{schedule.name}</td>
                  <td>{schedule.profileName}</td>
                  <td>
                    <code>{schedule.cron ?? (schedule.at ? date(schedule.at) : '')}</code>
                  </td>
                  <td>
                    <Badge tone={schedule.enabled ? 'good' : 'neutral'}>
                      {schedule.enabled ? 'Sim' : 'Não'}
                    </Badge>
                  </td>
                  <td>{schedule.lastRunAt ? date(schedule.lastRunAt) : '-'}</td>
                  <td>
                    {schedule.lastError ? <span className="error">{schedule.lastError}</span> : '-'}
                  </td>
                  <td>{schedule.nextRunAt ? date(schedule.nextRunAt) : '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
