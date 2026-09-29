import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { HttpResponse, http } from 'msw';
import { statsFor } from '../../stories/fixtures';
import { handlers } from '../../stories/handlers';
import { sectionProps } from '../../stories/section';
import { Overview } from '.';
import { ActivityHeatmap } from './heatmap';

const meta = {
  title: 'Sections/Overview',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Dashboard: Story = {
  render: () => {
    const { profile, data, api } = sectionProps();

    return <Overview profile={profile} data={data} api={api} />;
  },
};

export const ManyModels: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get('*/v1/profiles/:profileId/stats', () => {
          const stats = statsFor(30);
          return HttpResponse.json({
            ...stats,
            models: Array.from({ length: 50 }, (_, index) => ({
              ...stats.models[0],
              modelId: `model-${index + 1}`,
            })),
          });
        }),
        ...handlers,
      ],
    },
  },
  render: Dashboard.render,
};

export const Heatmap: Story = {
  render: () => {
    const { profile, api } = sectionProps();

    return <ActivityHeatmap profile={profile} api={api} />;
  },
};

export const HeatmapFailed: Story = {
  parameters: {
    msw: {
      handlers: [
        http.get('*/v1/profiles/:profileId/activity', () =>
          HttpResponse.json({ error: 'Internal server error' }, { status: 500 }),
        ),
        ...handlers,
      ],
    },
  },
  render: () => {
    const { profile, api } = sectionProps();

    return <ActivityHeatmap profile={profile} api={api} />;
  },
};
