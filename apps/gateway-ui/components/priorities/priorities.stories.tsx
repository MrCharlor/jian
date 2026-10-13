import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { sectionProps } from '../../stories/section';
import { Priorities } from '.';

const meta = {
  title: 'Sections/Priorização',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** An open proposal waiting for a plan, the criteria, and the past proposals. */
export const Proposal: Story = { render: () => <Priorities {...sectionProps()} /> };
