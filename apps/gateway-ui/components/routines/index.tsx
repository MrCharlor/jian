'use client';

import { AlarmClock, FileCheck, Workflow } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { Routines as RoutinesView } from '../../lib/api';
import { date } from '../../lib/format';
import { actionLabel, planStateLabel, planTitle } from '../plans/index';
import type { SectionProps } from '../props';
import { Badge, Empty, MoreText, ResourceRow, SectionHeading } from '../ui';

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
        description="O que roda sozinho: as agendas de todos os agentes, os planos esperando você, quantas rodadas cada ação foi sem correção e quantas perguntas cada plano fez."
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {view && (
        <>
          <section className="row-group" aria-labelledby="routines-waiting">
            <h2 id="routines-waiting">
              Planos esperando você <Badge dot={false}>{view.waiting.length}</Badge>
            </h2>
            {view.waiting.length ? (
              <div className="resource-list">
                {view.waiting.map((plan) => (
                  <ResourceRow
                    key={plan.id}
                    id={`routine-plan-${plan.id}`}
                    icon={<FileCheck size={20} strokeWidth={1.6} />}
                    name={`#${plan.number} · ${planTitle(plan)}`}
                    badges={<Badge tone="accent">{planStateLabel[plan.state]}</Badge>}
                    description={actionLabel[plan.action]}
                    facts={[
                      plan.findings.length
                        ? `${plan.findings.length} achado(s) do Revisor`
                        : plan.reviewerProfileId
                          ? 'Aprovado pelo Revisor'
                          : 'Sem Revisor',
                      date(plan.updatedAt),
                    ]}
                    actions={
                      <Link className="button secondary" href="/plans">
                        Abrir em Planos
                      </Link>
                    }
                  />
                ))}
              </div>
            ) : (
              <p className="note">Nenhum. Os planos ficam em Planos.</p>
            )}
          </section>

          <section className="row-group" aria-labelledby="routines-actions">
            <h2 id="routines-actions">Ações com plano</h2>
            <p>Quantas rodadas cada ação foi sem correção sua: o sinal para ligar o Automático.</p>
            <div className="resource-list">
              {view.actions.map((action) => (
                <ResourceRow
                  key={action.action}
                  id={`routine-action-${action.action}`}
                  icon={<Workflow size={20} strokeWidth={1.6} />}
                  name={actionLabel[action.action]}
                  badges={
                    <>
                      <Badge tone={action.automatic ? 'accent' : 'neutral'}>
                        {action.automatic ? 'Automático' : 'Espera seu OK'}
                      </Badge>
                      {!action.reviewer && (
                        <Badge tone="warn">
                          {action.action === 'entry_sync'
                            ? 'Sem Revisor: vem direto para você'
                            : 'Sem Revisor: sem plano'}
                        </Badge>
                      )}
                    </>
                  }
                  description={`${action.clean} seguido(s) sem correção, de ${action.executed} executado(s).`}
                  facts={
                    action.lastCorrectionAt
                      ? [`Última correção ${date(action.lastCorrectionAt)}`]
                      : ['Nenhuma correção ainda']
                  }
                />
              ))}
            </div>
          </section>

          <section className="row-group" aria-labelledby="routines-questions">
            <h2 id="routines-questions">Perguntas por plano</h2>
            <p>A média deve cair conforme a base de Conhecimento aprende.</p>
            {view.questionsPerWeek.length ? (
              <div className="owner-table">
                <table>
                  <thead>
                    <tr>
                      <th>Semana de</th>
                      <th>Planos</th>
                      <th>Perguntas</th>
                      <th>Média</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.questionsPerWeek.map((week) => (
                      <tr key={week.week}>
                        <td>{week.week.split('-').reverse().join('/')}</td>
                        <td className="number">{week.plans}</td>
                        <td className="number">{week.questions}</td>
                        <td className="number">
                          <Badge tone={week.average > 3 ? 'warn' : 'neutral'} dot={false}>
                            {week.average.toLocaleString('pt-BR')}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="note">Nenhum plano escrito nas últimas 8 semanas.</p>
            )}
          </section>

          <section className="row-group" aria-labelledby="routines-schedules">
            <h2 id="routines-schedules">
              Agendas <Badge dot={false}>{view.schedules.length}</Badge>
            </h2>
            {view.schedules.length ? (
              <div className="resource-list">
                {view.schedules.map((schedule) => (
                  <ResourceRow
                    key={schedule.id}
                    id={`routine-schedule-${schedule.id}`}
                    icon={<AlarmClock size={20} strokeWidth={1.6} />}
                    name={schedule.name}
                    badges={
                      <Badge tone={schedule.enabled ? 'good' : 'neutral'}>
                        {schedule.enabled ? 'Ligada' : 'Desligada'}
                      </Badge>
                    }
                    description={`${schedule.profileName} · ${
                      schedule.cron ?? (schedule.at ? date(schedule.at) : 'sem horário')
                    }`}
                    facts={[
                      `Última vez: ${schedule.lastRunAt ? date(schedule.lastRunAt) : 'nunca'}`,
                      `Próxima: ${schedule.nextRunAt ? date(schedule.nextRunAt) : 'nenhuma'}`,
                    ]}
                    extra={
                      schedule.lastError ? (
                        <div className="row-error">
                          <MoreText lines={2}>{`Último erro: ${schedule.lastError}`}</MoreText>
                        </div>
                      ) : undefined
                    }
                  />
                ))}
              </div>
            ) : (
              <Empty title="Nenhuma agenda">Os agentes ainda não têm rotina agendada.</Empty>
            )}
          </section>
        </>
      )}
    </>
  );
}
