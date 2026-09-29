import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';
import { withWorkspace } from '../../stories/workspace';
import { ProfileSwitcher } from './profile-switcher';
import { Sidebar } from './sidebar';
import { Topbar } from './topbar';

const meta = {
  title: 'Shell',
  decorators: [withWorkspace],
  parameters: {
    layout: 'fullscreen',
    nextjs: { appDirectory: true, navigation: { pathname: '/sessions' } },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Navigation: Story = {
  render: () => (
    <div className="app-shell">
      <Sidebar open onNavigate={fn()} onCreateProfile={fn()} />
    </div>
  ),
};

export const TopBar: Story = {
  render: () => <Topbar onOpenNavigation={fn()} navigationOpen={false} />,
};

export const AgentSelector: Story = {
  parameters: { layout: 'padded' },
  render: () => <ProfileSwitcher onCreate={fn()} />,
};
