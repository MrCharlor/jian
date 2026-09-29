import { LOCALE } from './format';
/** The browser's zone, for a profile that has not named its own. */
export const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** How far `zone` is from UTC at that instant, in minutes: -180 for São Paulo. */
function offsetMinutes(zone: string, at: number) {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
      .formatToParts(new Date(at))
      .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);

  return match ? (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
}

const pad = (value: number) => String(Math.abs(value)).padStart(2, '0');

/**
 * A wall-clock time typed as `2026-10-02T15:00`, read in `zone`, as an ISO time with its offset.
 * The offset is taken at that moment, so a time across a daylight-saving change still lands.
 */
export function zonedToIso(local: string, zone: string) {
  const [date, time = '00:00'] = local.split('T');
  const [year, month, day] = (date ?? '').split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const wall = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, hour ?? 0, minute ?? 0);
  // Twice: the first guess can sit on the wrong side of a change of offset.
  const offset = offsetMinutes(zone, wall - offsetMinutes(zone, wall) * 60_000);

  return `${date}T${pad(hour ?? 0)}:${pad(minute ?? 0)}:00${offset < 0 ? '-' : '+'}${pad(
    Math.trunc(offset / 60),
  )}:${pad(offset % 60)}`;
}

/** An instant as the `YYYY-MM-DDTHH:mm` a date-time field shows, in `zone`. */
export function isoToZonedLocal(iso: string, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(iso))
      .map((part) => [part.type, part.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

/** An instant for reading, in `zone`: "Thu 25 Sep, 08:00". */
export const inZone = (iso: string, zone: string) =>
  new Intl.DateTimeFormat(LOCALE, {
    timeZone: zone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * A repetition in words when it is one of the common shapes — every day, weekdays, one day of
 * the week, one day of the month — and the expression itself otherwise.
 */
export function describeCron(cron: string) {
  const [minute, hour, day, month, weekday] = cron.trim().split(/\s+/);
  const plain = (value?: string) => /^\d+$/.test(value ?? '');

  if (!plain(minute) || !plain(hour) || month !== '*') return `Cron ${cron}`;
  const at = `${pad(Number(hour))}:${pad(Number(minute))}`;

  if (day === '*' && weekday === '*') return `Every day at ${at}`;
  if (day === '*' && weekday === '1-5') return `Weekdays at ${at}`;
  if (day === '*' && (weekday === '0,6' || weekday === '6,0')) return `Weekends at ${at}`;
  if (day === '*' && plain(weekday)) return `Every ${weekdays[Number(weekday) % 7]} at ${at}`;
  if (plain(day) && weekday === '*') return `Every month on day ${day} at ${at}`;

  return `Cron ${cron}`;
}

export type Repeat = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

/** The expression for a common repetition, from its parts. */
export function cronFor(repeat: Exclude<Repeat, 'custom'>, time: string, weekday = 1, day = 1) {
  const [hour = '8', minute = '0'] = time.split(':');
  const at = `${Number(minute)} ${Number(hour)}`;

  return repeat === 'daily'
    ? `${at} * * *`
    : repeat === 'weekdays'
      ? `${at} * * 1-5`
      : repeat === 'weekly'
        ? `${at} * * ${weekday}`
        : `${at} ${day} * *`;
}

/** The common repetition an expression is, with its parts, or `custom`. */
export function readCron(cron: string): {
  repeat: Repeat;
  time: string;
  weekday: number;
  day: number;
} {
  const [minute, hour, day, month, weekday] = cron.trim().split(/\s+/);
  const plain = (value?: string) => /^\d+$/.test(value ?? '');
  const time =
    plain(hour) && plain(minute) ? `${pad(Number(hour))}:${pad(Number(minute))}` : '08:00';
  const base = { time, weekday: 1, day: 1 };

  if (!plain(minute) || !plain(hour) || month !== '*') return { ...base, repeat: 'custom' };
  if (day === '*' && weekday === '*') return { ...base, repeat: 'daily' };
  if (day === '*' && weekday === '1-5') return { ...base, repeat: 'weekdays' };
  if (day === '*' && plain(weekday))
    return { ...base, repeat: 'weekly', weekday: Number(weekday) % 7 };
  if (plain(day) && weekday === '*') return { ...base, repeat: 'monthly', day: Number(day) };

  return { ...base, repeat: 'custom' };
}

export { weekdays };
