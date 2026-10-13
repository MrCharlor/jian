import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { sectionProps } from '../../stories/section';
import { Routines } from '.';

const meta = {
  title: 'Sections/Rotinas',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Plans waiting, the actions with their clean rounds, questions per week and the schedules. */
export const Overview: Story = { render: () => <Routines {...sectionProps()} /> };
