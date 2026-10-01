import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { sectionProps } from '../../stories/section';
import { withWorkspace } from '../../stories/workspace';
import { SshKeys } from './index';

const meta = {
  title: 'Sections/Agent/SSH keys',
  decorators: [withWorkspace],
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Manage: Story = {
  render: () => <SshKeys {...sectionProps()} />,
};
