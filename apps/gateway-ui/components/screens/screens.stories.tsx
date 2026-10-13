import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { screens } from '../../stories/atena';
import { sectionProps } from '../../stories/section';
import { Screens } from '.';

const meta = {
  title: 'Sections/Telas',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every screen listed, filtered by its state. */
export const List: Story = { render: () => <Screens {...sectionProps()} /> };

/** One screen's sheet, waiting for the owner's review. */
export const Sheet: Story = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: { pathname: '/screens/', query: { tela: screens[0]?.id ?? '' } },
    },
  },
  render: () => <Screens {...sectionProps()} />,
};
