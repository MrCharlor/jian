'use client';

import { Save } from 'lucide-react';
import { useState } from 'react';
import type { Schedule, ScheduleInput, Session } from '../../lib/api';
import {
  cronFor,
  isoToZonedLocal,
  type Repeat,
  readCron,
  weekdays,
  zonedToIso,
} from '../../lib/time';
import { Button, DateTimePicker, Field, Modal, TimePicker } from '../ui';
import { Select } from '../ui/select';

const repeats: Array<{ value: Repeat; label: string }> = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
  { value: 'custom', label: 'Custom (cron)' },
];

/**
 * A schedule, written or changed by the owner: what the agent is asked, where it answers, and
 * when — once, at a date and time, or on a repetition, in the gateway's time zone.
 */
export function ScheduleEditor({
  schedule,
  sessions,
  defaultSession,
  zone,
  busy,
  close,
  save,
}: {
  schedule?: Schedule | undefined;
  sessions: Array<{ session: Session; name: string; where: string }>;
  defaultSession: string;
  zone: string;
  busy: boolean;
  close: () => void;
  save: (input: ScheduleInput) => Promise<boolean>;
}) {
  const timeZone = schedule?.timeZone ?? zone;
  const read = schedule?.cron ? readCron(schedule.cron) : undefined;
  const [name, setName] = useState(schedule?.name ?? '');
  const [instruction, setInstruction] = useState(schedule?.instruction ?? '');
  const [sessionId, setSessionId] = useState(schedule?.sessionId ?? defaultSession);
  const [kind, setKind] = useState<'once' | 'repeat'>(schedule?.cron ? 'repeat' : 'once');
  const [at, setAt] = useState(
    schedule?.at
      ? isoToZonedLocal(schedule.at, timeZone)
      : // An hour from now, on the five-minute grid the picker offers.
        isoToZonedLocal(
          new Date(Math.ceil((Date.now() + 60 * 60_000) / 300_000) * 300_000).toISOString(),
          timeZone,
        ),
  );
  const [repeat, setRepeat] = useState<Repeat>(read?.repeat ?? 'daily');
  const [time, setTime] = useState(read?.time ?? '08:00');
  const [weekday, setWeekday] = useState(read?.weekday ?? 1);
  const [day, setDay] = useState(read?.day ?? 1);
  const [custom, setCustom] = useState(schedule?.cron ?? '0 8 * * *');
  // A schedule keeps the zone it was written in; a new one takes the gateway's configured zone.
  const zoneChoice = timeZone;
  const cron = repeat === 'custom' ? custom : cronFor(repeat, time, weekday, day);

  return (
    <Modal
      title={schedule ? schedule.name : 'New schedule'}
      description="At the time, the agent receives the instruction in the conversation you choose, and answers there."
      close={close}
      wide
      footer={
        <>
          <Button type="button" variant="quiet" onClick={close}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="schedule-form"
            busy={busy}
            disabled={!name.trim() || !instruction.trim()}
          >
            <Save size={16} />
            {schedule ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <form
        id="schedule-form"
        className="grid gap-5"
        onSubmit={async (event) => {
          event.preventDefault();
          const input: ScheduleInput = {
            name: name.trim(),
            instruction: instruction.trim(),
            sessionId,
            timeZone: zoneChoice,
            enabled: schedule?.enabled ?? true,
            ...(kind === 'once' ? { at: zonedToIso(at, zoneChoice) } : { cron }),
          };

          if (await save(input)) close();
        }}
      >
        <Field label="Name" hint="Short, for this list.">
          <input
            value={name}
            maxLength={80}
            required
            placeholder="Morning summary"
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field
          label="Instruction"
          hint="What the agent is asked at the time, with everything it needs."
        >
          <textarea
            value={instruction}
            maxLength={4000}
            rows={4}
            required
            placeholder="Send me a summary of yesterday's conversations and what is due today."
            onChange={(event) => setInstruction(event.target.value)}
          />
        </Field>
        <Field
          label="Conversation"
          hint="Where the agent answers. In a chat, the answer goes out on it."
        >
          <Select
            value={sessionId}
            onValueChange={setSessionId}
            options={sessions.map((item) => ({
              value: item.session.id,
              label: item.name,
              detail: item.where,
            }))}
            aria-label="Conversation"
          />
        </Field>
        <fieldset className="schedule-when">
          <legend>When</legend>
          <div className="segmented">
            {(['once', 'repeat'] as const).map((value) => (
              <button
                type="button"
                key={value}
                aria-pressed={kind === value}
                onClick={() => setKind(value)}
              >
                {value === 'once' ? 'Once' : 'Repeat'}
              </button>
            ))}
          </div>
          {kind === 'once' ? (
            <Field label="Date and time">
              <DateTimePicker
                value={at}
                onChange={setAt}
                min={isoToZonedLocal(new Date().toISOString(), zoneChoice).slice(0, 10)}
                label="Date and time"
              />
            </Field>
          ) : (
            <div className="schedule-repeat">
              <Field label="Repeat">
                <Select
                  value={repeat}
                  onValueChange={(value) => setRepeat(value as Repeat)}
                  options={repeats}
                  aria-label="Repeat"
                />
              </Field>
              {repeat === 'weekly' && (
                <Field label="On">
                  <Select
                    value={String(weekday)}
                    onValueChange={(value) => setWeekday(Number(value))}
                    options={weekdays.map((label, index) => ({ value: String(index), label }))}
                    aria-label="Weekday"
                  />
                </Field>
              )}
              {repeat === 'monthly' && (
                <Field label="Day">
                  <input
                    type="number"
                    min={1}
                    max={31}
                    value={day}
                    onChange={(event) => setDay(Number(event.target.value))}
                  />
                </Field>
              )}
              {repeat === 'custom' ? (
                <Field label="Cron" hint="minute hour day month weekday · at most every 5 minutes">
                  <input
                    value={custom}
                    spellCheck={false}
                    className="font-mono"
                    onChange={(event) => setCustom(event.target.value)}
                  />
                </Field>
              ) : (
                <Field label="At">
                  <TimePicker value={time} onChange={setTime} label="Time" />
                </Field>
              )}
            </div>
          )}
        </fieldset>
      </form>
    </Modal>
  );
}
