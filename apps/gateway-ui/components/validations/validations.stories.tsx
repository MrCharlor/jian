import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { sectionProps } from '../../stories/section';
import { Validations } from '.';

const meta = {
  title: 'Sections/Validações',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** One epic to answer with long tester notes, a refusal with its comment draft, one approved. */
export const List: Story = { render: () => <Validations {...sectionProps()} /> };
