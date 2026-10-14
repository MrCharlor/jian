import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { userEvent } from 'storybook/test';
import { sectionProps } from '../../stories/section';
import { Mentions } from '.';

const meta = {
  title: 'Sections/Menções',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** A high-impact question waiting for the owner, one answered alone, one that was not the PO's. */
export const List: Story = { render: () => <Mentions {...sectionProps()} /> };

/** The settings opened at the end of the page, with the high-impact list. */
export const Settings: Story = {
  render: () => <Mentions {...sectionProps()} />,
  play: async ({ canvasElement }) => {
    const summary = canvasElement.querySelector<HTMLElement>('.disclosure > summary');

    if (summary) await userEvent.click(summary);
  },
};
