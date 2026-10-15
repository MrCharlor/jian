import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { userEvent } from 'storybook/test';
import { sectionProps } from '../../stories/section';
import { Roadmap } from '.';

const meta = {
  title: 'Sections/Roadmap',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two proposals of the Estrategista waiting, the three lanes with a blocked item, one concluded. */
export const Lanes: Story = { render: () => <Roadmap {...sectionProps()} /> };

/** The settings opened at the end of the page. */
export const Settings: Story = {
  render: () => <Roadmap {...sectionProps()} />,
  play: async ({ canvasElement }) => {
    const summaries = canvasElement.querySelectorAll<HTMLElement>('.disclosure > summary');
    const last = summaries[summaries.length - 1];

    if (last) await userEvent.click(last);
  },
};
