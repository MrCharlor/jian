import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { userEvent } from 'storybook/test';
import { sectionProps } from '../../stories/section';
import { Plans } from '.';

const meta = {
  title: 'Sections/Planos',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** A prototype plan with questions and findings, an entry sync with long links, then the rest. */
export const List: Story = { render: () => <Plans {...sectionProps()} /> };

/** The settings opened at the end of the page: one card per action. */
export const Settings: Story = {
  render: () => <Plans {...sectionProps()} />,
  play: async ({ canvasElement }) => {
    const summary = canvasElement.querySelector<HTMLElement>('.disclosure > summary');

    if (summary) await userEvent.click(summary);
  },
};
