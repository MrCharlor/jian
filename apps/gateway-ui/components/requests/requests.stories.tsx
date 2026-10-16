import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { sectionProps } from '../../stories/section';
import { Requests } from '.';

const meta = {
  title: 'Sections/Pedidos → épico',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** One request on its prototype, one that was already in Priorizado and waits to be let in. */
export const List: Story = { render: () => <Requests {...sectionProps()} /> };
