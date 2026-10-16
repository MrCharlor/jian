import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { sectionProps } from '../../stories/section';
import { Inbox } from '.';

const meta = {
  title: 'Sections/Esperando você',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** A high-impact mention first, then a plan and a rule, with the time to decide on top. */
export const List: Story = { render: () => <Inbox {...sectionProps()} /> };
