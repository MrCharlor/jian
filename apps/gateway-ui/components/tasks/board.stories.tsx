import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import type { GatewayApi, WorkItem } from '../../lib/api';
import { sectionProps } from '../../stories/section';
import { WorkBoard } from './board';

const meta = { title: 'Sections/Work' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Dashboard: Story = {
  render: () => {
    const props = sectionProps();
    const now = new Date().toISOString();
    const work = [
      ['todo', 'Plan release', 'Confirm the remaining acceptance checks.'],
      ['in_progress', 'Verify gateway', 'Run the relevant tests and inspect failures.'],
      ['review', 'Review changes', 'Compare the implementation with the request.'],
      ['blocked', 'Wait for credentials', 'Owner input is needed before continuing.'],
      ['done', 'Prepare migration', 'Add the reversible schema change.'],
    ].map(
      ([status, title, description], index): WorkItem => ({
        id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        profileId: props.profile.id,
        sourceSessionId: null,
        title: title ?? '',
        description: description ?? '',
        mediaIds: [],
        repositories: [],
        status: status as WorkItem['status'],
        note: '',
        version: 1,
        updatedBy: 'agent',
        createdAt: now,
        updatedAt: now,
      }),
    );
    const api = { ...props.api, work: async () => work, workHistory: async () => [] } as GatewayApi;
    return <WorkBoard {...props} api={api} />;
  },
};
