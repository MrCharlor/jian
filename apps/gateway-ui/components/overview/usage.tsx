'use client';

import {
  Bot,
  CalendarDays,
  Coins,
  Database,
  GraduationCap,
  MessageCircle,
  Server,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { ProfileStats } from '../../lib/api';
import { LOCALE } from '../../lib/format';
import { CountUp, ProviderLogo, TelegramLogo, WhatsAppLogo } from '../ui';
import { compact, money, percent } from './format';

export const periods = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '3660', label: 'All time' },
];

const tokensOf = (mix: ProfileStats['period']['tokens']) => mix.input + mix.cached + mix.output;

/** A number with its label and a mark, as the tiles across the top of each section show it. */
export function Tile({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="stat-tile">
      <span className="stat-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="stat-copy">
        <small>{label}</small>
        <strong>{children}</strong>
      </span>
    </div>
  );
}

/** Where the tokens went: read fresh, read from the provider's cache, and written. */
function Mix({ stats }: { stats: ProfileStats }) {
  const { tokens } = stats.period;
  const all = tokensOf(tokens);
  const parts = [
    { key: 'input', label: 'New input', value: tokens.input },
    { key: 'cached', label: 'From cache', value: tokens.cached },
    { key: 'output', label: 'Output', value: tokens.output },
  ];

  return (
    <section className="stat-card">
      <header>
        <div>
          <h3>Token mix</h3>
          <p>The context sent fresh, the part a provider served from its cache, and the answers.</p>
        </div>
      </header>
      <div className="mix-bar" aria-hidden="true">
        {parts.map((part) => (
          <span
            key={part.key}
            className={`mix-${part.key}`}
            style={{ width: `${all ? (part.value / all) * 100 : 0}%` }}
          />
        ))}
      </div>
      <dl className="mix-legend">
        {parts.map((part) => (
          <div key={part.key}>
            <dt>
              <span className={`mix-dot mix-${part.key}`} />
              {part.label}
            </dt>
            <dd>
              <CountUp value={part.value} format={compact} />
              <small>{percent(part.value, all)}</small>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function SubscriptionLimits({ subscriptions }: { subscriptions: ProfileStats['subscriptions'] }) {
  const available = subscriptions.filter(
    (subscription) =>
      subscription.status === 'available' && (subscription.fiveHour || subscription.weekly),
  );
  if (available.length === 0) return null;

  return (
    <section className="stat-subscriptions" aria-labelledby="subscription-heading">
      <h3 id="subscription-heading">Subscription limits</h3>
      <div className="stat-grid">
        {available.map((subscription) => (
          <article className="stat-row-card" key={subscription.provider}>
            <header>
              <span className="stat-icon" aria-hidden="true">
                <ProviderLogo
                  kind={subscription.provider === 'codex' ? 'openai' : 'anthropic'}
                  size={18}
                />
              </span>
              <strong>{subscription.provider === 'codex' ? 'Codex' : 'Claude'}</strong>
            </header>
            <dl
              className={`subscription-windows${subscription.provider === 'codex' ? ' single' : ''}`}
            >
              {(subscription.provider === 'codex'
                ? ([['Weekly window', subscription.weekly]] as const)
                : ([
                    ['5-hour window', subscription.fiveHour],
                    ['Weekly window', subscription.weekly],
                  ] as const)
              ).map(([label, window]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  {window ? (
                    <dd className="subscription-meter">
                      <strong>{window.usedPercent.toFixed(0)}% used</strong>
                      <span className="share-bar" aria-hidden="true">
                        <span style={{ width: `${Math.min(100, window.usedPercent)}%` }} />
                      </span>
                    </dd>
                  ) : (
                    <dd>Unavailable</dd>
                  )}
                  {window?.resetsAt && (
                    <small>Resets {new Date(window.resetsAt).toLocaleString(LOCALE)}</small>
                  )}
                </div>
              ))}
            </dl>
          </article>
        ))}
      </div>
    </section>
  );
}

/** The headline numbers of the period, token mix, and what the cost leaves out. */
export function UsageSummary({ stats }: { stats: ProfileStats }) {
  const { period } = stats;
  const all = tokensOf(period.tokens);
  const input = period.tokens.input + period.tokens.cached;

  return (
    <>
      <div className="stat-tiles">
        <Tile icon={<Sparkles size={18} />} label="Total tokens">
          <CountUp value={all} format={compact} />
        </Tile>
        <Tile icon={<Coins size={18} />} label="Est. cost">
          {period.cost === null ? '—' : <CountUp value={period.cost} format={money} />}
        </Tile>
        <Tile icon={<CalendarDays size={18} />} label="Active days">
          <CountUp value={period.activeDays} />
        </Tile>
        <Tile icon={<Database size={18} />} label="Cache share">
          {percent(period.tokens.cached, input)}
        </Tile>
      </div>
      <div className="stat-cards">
        <Mix stats={stats} />
        {stats.models.length > 0 && (
          <section className="stat-models" aria-labelledby="models-heading">
            <header>
              <h3 id="models-heading">Models</h3>
              <span className="stat-chip">
                {period.turns} {period.turns === 1 ? 'turn' : 'turns'}
              </span>
            </header>
            <ModelCards stats={stats} />
          </section>
        )}
      </div>
      <SubscriptionLimits subscriptions={stats.subscriptions} />
      <p className="stat-note">
        Cost is estimated from list prices in the models.dev catalog, not from a provider's bill.
        {period.unpricedTokens > 0 &&
          ` ${compact(period.unpricedTokens)} tokens used a subscription or a model without a known price and are not in it.`}
      </p>
    </>
  );
}

const providerLogo = (provider: string) =>
  provider === 'openai-codex' ? 'openai' : provider === 'openai-compatible' ? undefined : provider;

const billingLabels = {
  metered: 'API key',
  subscription: 'Subscription',
  unknown: 'No list price',
} as const;

/** One card per model used in the period, with the share of the period's tokens it took. */
export function ModelCards({ stats }: { stats: ProfileStats }) {
  const all = tokensOf(stats.period.tokens);
  const [expanded, setExpanded] = useState(false);
  const models = expanded ? stats.models : stats.models.slice(0, 4);

  return (
    <>
      <section
        className={`stat-grid${expanded ? ' expanded' : ''}`}
        aria-label="Model usage"
        tabIndex={expanded ? 0 : undefined}
      >
        {models.map((model) => {
          const tokens = tokensOf(model.tokens);
          const logo = providerLogo(model.provider);

          return (
            <article
              className="stat-row-card"
              key={`${model.provider}:${model.modelId}:${model.billing}`}
            >
              <header>
                <span className="stat-icon" aria-hidden="true">
                  {logo ? <ProviderLogo kind={logo} size={18} /> : <Server size={18} />}
                </span>
                <strong>{model.modelId}</strong>
                <span className={`stat-chip ${model.billing}`}>{billingLabels[model.billing]}</span>
              </header>
              <dl>
                <div>
                  <dt>Tokens</dt>
                  <dd>
                    <CountUp value={tokens} format={compact} />
                  </dd>
                </div>
                <div>
                  <dt>Turns</dt>
                  <dd>
                    <CountUp value={model.turns} />
                  </dd>
                </div>
                <div>
                  <dt>Cost</dt>
                  <dd>
                    {model.cost !== null ? (
                      <CountUp value={model.cost} format={money} />
                    ) : model.billing === 'subscription' ? (
                      'Included'
                    ) : (
                      '—'
                    )}
                  </dd>
                </div>
              </dl>
              <div className="share-row">
                <div className="share-bar" aria-hidden="true">
                  <span style={{ width: `${all ? (tokens / all) * 100 : 0}%` }} />
                </div>
                <small className="share-note">{percent(tokens, all)} of tokens</small>
              </div>
            </article>
          );
        })}
      </section>
      {stats.models.length > 4 && (
        <button
          type="button"
          className="text-button stat-models-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? 'Show fewer models' : `Show all ${stats.models.length} models`}
        </button>
      )}
    </>
  );
}

const channels: Record<string, { label: string; icon: ReactNode }> = {
  whatsapp: { label: 'WhatsApp', icon: <WhatsAppLogo size={18} /> },
  telegram: { label: 'Telegram', icon: <TelegramLogo size={18} /> },
  gateway: { label: 'Gateway', icon: <MessageCircle size={18} /> },
  agent: { label: 'Agents', icon: <Bot size={18} /> },
  learning: { label: 'Learning', icon: <GraduationCap size={18} /> },
  api: { label: 'API Server', icon: <Terminal size={18} /> },
};

/** Where the work came from: each channel's conversations, turns and tokens in the period. */
export function ChannelCards({ stats }: { stats: ProfileStats }) {
  return (
    <div className="stat-grid four">
      {stats.channels.map((channel) => {
        const kind = channels[channel.channel] ?? channels.api;

        return (
          <article className="stat-row-card compact" key={channel.channel}>
            <header>
              <span className="stat-icon" aria-hidden="true">
                {kind?.icon}
              </span>
              <strong>{kind?.label}</strong>
            </header>
            <p>
              <CountUp value={channel.turns} /> {channel.turns === 1 ? 'turn' : 'turns'} ·{' '}
              {channel.conversations}{' '}
              {channel.conversations === 1 ? 'conversation' : 'conversations'}
            </p>
            <small>
              <CountUp value={channel.tokens} format={compact} /> tokens
            </small>
          </article>
        );
      })}
    </div>
  );
}
