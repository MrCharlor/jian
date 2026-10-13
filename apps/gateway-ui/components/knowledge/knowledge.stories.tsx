import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { userEvent } from 'storybook/test';
import { sectionProps } from '../../stories/section';
import { Knowledge } from '.';

const meta = {
  title: 'Sections/Conhecimento',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** A proposal waiting, the rules with a long one, the decided ones, and the settings closed. */
export const Base: Story = { render: () => <Knowledge {...sectionProps()} /> };

/** The curation settings opened. */
export const Settings: Story = {
  render: () => <Knowledge {...sectionProps()} />,
  play: async ({ canvasElement }) => {
    const summary = canvasElement.querySelector<HTMLElement>('.disclosure > summary');

    if (summary) await userEvent.click(summary);
  },
};
