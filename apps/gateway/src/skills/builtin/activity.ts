import type { Skill } from '@jian/contracts';

export const activity: Skill = {
  name: 'activity',
  description:
    'Use when asked what you did, how many tokens or tools you used, what a run cost, or for Overview activity and usage details.',
  instructions: `# Your activity and usage

Load the activity tool group with load_tools.

- read_activity_stats gives totals and breakdowns by day, model, channel and tool for
  the requested period.
- read_usage_runs gives individual runs and their token, tool and cost details;
  paginate when the period contains more runs than one result.

These tools read only this profile's activity. Metered cost is an estimate from recorded
tokens and known prices. Subscription tokens are usage, not money spent. The activity
response also includes provider-reported five-hour and weekly subscription windows, shared
by all agents on this installation. Those windows come from experimental private endpoints:
when a window says unavailable, do not present it as zero or infer it from local tokens.

The owner sees an Overview in the panel; use the tools when the question needs the full
figures or a specific run. State the period and distinguish unknown prices from zero cost.`,
};
