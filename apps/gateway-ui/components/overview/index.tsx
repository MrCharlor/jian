'use client';

import { Clock, GraduationCap, MessageSquareText, MessagesSquare, Settings2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { GatewayApi, Profile, ProfileData, ProfileStats } from '../../lib/api';
import { LOCALE } from '../../lib/format';
import { useEvents } from '../../lib/workspace';
import { Avatar } from '../profile/avatar-field';
import { Button, CountUp, Orb, SectionHeading } from '../ui';
import { Select } from '../ui/select';
import { duration } from './format';
import { ActivityHeatmap } from './heatmap';
import { ChannelCards, periods, Tile, UsageSummary } from './usage';

/**
 * The stats of the open profile, read again when a turn moves: a run's usage is written at the
 * end of each step, so the numbers climb while the agent works. Reads are spaced, since several
 * events arrive together.
 */
function useStats(api: GatewayApi, profileId: string, days: number) {
  const subscribe = useEvents();
  const [stats, setStats] = useState<ProfileStats>();
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let active = true;
    if (retry > 0) setFailed(false);
    const read = () =>
      api
        .stats(profileId, days)
        .then((value) => {
          if (active) {
            setStats(value);
            setFailed(false);
          }
        })
        .catch(() => {
          if (active) setFailed(true);
        });

    void read();

    const stop = subscribe((event) => {
      if (!event.type.startsWith('run.') && !event.type.startsWith('memory.')) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void read(), 1500);
    });

    return () => {
      active = false;
      stop();
      clearTimeout(timer.current);
    };
  }, [api, profileId, days, subscribe, retry]);

  return { stats, failed, retry: () => setRetry((value) => value + 1) };
}

export function Overview({
  profile,
  api,
}: {
  profile: Profile;
  data: ProfileData;
  api: GatewayApi;
}) {
  const [days, setDays] = useState(30);
  const { stats, failed, retry } = useStats(api, profile.id, days);

  if (!stats) {
    return (
      <div className="loading-state" role="status" aria-label="Loading overview">
        {failed ? (
          <>
            <span>Could not load overview.</span>
            <Button variant="secondary" onClick={retry}>
              Try loading again
            </Button>
          </>
        ) : (
          <Orb size={64} />
        )}
      </div>
    );
  }

  return (
    <>
      <SectionHeading title="Overview" />
      <section className="overview-profile" aria-label="Agent in use">
        <div className="flex min-w-0 items-center gap-5">
          <Avatar name={profile.name} avatar={profile.avatar} className="profile-avatar" />
          <h2>{profile.name}</h2>
        </div>
        <Link href="/identity" className="button quiet">
          <Settings2 size={16} />
          Edit agent
        </Link>
      </section>

      <div className="lifetime-stats">
        <div className="stat-tiles">
          <Tile icon={<MessageSquareText size={18} />} label="Turns answered">
            <CountUp value={stats.totals.turns} />
          </Tile>
          <Tile icon={<Clock size={18} />} label="Time worked">
            <CountUp value={stats.totals.workedMs} format={duration} />
          </Tile>
          <Tile icon={<MessagesSquare size={18} />} label="Conversations">
            <CountUp value={stats.totals.conversations} />
          </Tile>
          <Tile icon={<GraduationCap size={18} />} label="Skills and memories kept">
            <CountUp value={stats.totals.skillsWritten + stats.totals.memories} />
          </Tile>
        </div>
        <p className="stat-since">
          Since{' '}
          {new Date(stats.since).toLocaleDateString(LOCALE, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
        </p>
      </div>

      <section className="stat-section" aria-labelledby="usage-heading">
        <header>
          <h2 id="usage-heading">Usage</h2>
          <Select
            value={String(days)}
            onValueChange={(value) => setDays(Number(value))}
            options={periods}
            aria-label="Period"
            className="stat-period"
          />
        </header>
        <UsageSummary stats={stats} />
      </section>

      {stats.channels.length > 0 && (
        <section className="stat-section" aria-labelledby="channels-heading">
          <header>
            <h2 id="channels-heading">Channels</h2>
          </header>
          <ChannelCards stats={stats} />
        </section>
      )}

      <section className="stat-section" aria-label="Activity over the year">
        <ActivityHeatmap profile={profile} api={api} />
      </section>
    </>
  );
}
