import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import type { ComponentType } from 'react';
import ChannelsPage from '../../app/(workspace)/channels/page';
import IdentityPage from '../../app/(workspace)/identity/page';
import WorkspaceLayout from '../../app/(workspace)/layout';
import McpPage from '../../app/(workspace)/mcp/page';
import MemoriesPage from '../../app/(workspace)/memories/page';
import ModelsPage from '../../app/(workspace)/models/page';
import OverviewPage from '../../app/(workspace)/page';
import ProvidersPage from '../../app/(workspace)/providers/page';
import SessionsPage from '../../app/(workspace)/sessions/page';
import SkillsPage from '../../app/(workspace)/skills/page';
import SshKeysPage from '../../app/(workspace)/ssh-keys/page';
import WorkPage from '../../app/(workspace)/tasks/page';
import { emptyHandlers, outdatedHandlers, updatedHandlers } from '../handlers';

/**
 * Every screen of the panel as it really renders: the workspace layout, the sidebar, and the
 * page, loading an installation from the story's handlers. Nothing here talks to a gateway.
 */
const meta = {
  title: 'Pages/Workspace',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const page = (Page: ComponentType, pathname: string): Story => ({
  parameters: { nextjs: { appDirectory: true, navigation: { pathname } } },
  render: () => (
    <WorkspaceLayout>
      <Page />
    </WorkspaceLayout>
  ),
});

export const Overview = page(OverviewPage, '/');
export const Chats = page(SessionsPage, '/sessions');
export const Work = page(WorkPage, '/tasks');
export const Identity = page(IdentityPage, '/identity');
export const Models = page(ModelsPage, '/models');
export const Providers = page(ProvidersPage, '/providers');
export const Channels = page(ChannelsPage, '/channels');
export const Memories = page(MemoriesPage, '/memories');
export const Skills = page(SkillsPage, '/skills');
export const Mcp = page(McpPage, '/mcp');
export const SshKeys = page(SshKeysPage, '/ssh-keys');

/** A gateway on its first day: no providers, no channels, no conversations. */
export const FirstRun: Story = {
  ...page(OverviewPage, '/'),
  parameters: {
    ...page(OverviewPage, '/').parameters,
    msw: { handlers: emptyHandlers },
  },
};

/** Right after an update: the release dialog opens over the page, once. */
export const AfterAnUpdate: Story = {
  ...page(OverviewPage, '/'),
  parameters: {
    ...page(OverviewPage, '/').parameters,
    msw: { handlers: updatedHandlers },
  },
};

/** An older installation: the Release notes action shows the number of pending releases. */
export const Outdated: Story = {
  ...page(OverviewPage, '/'),
  parameters: {
    ...page(OverviewPage, '/').parameters,
    msw: { handlers: outdatedHandlers },
  },
};

/** On a phone: the sidebar folds into the menu button. */
export const Mobile: Story = {
  ...page(SessionsPage, '/sessions'),
  globals: { viewport: { value: 'mobile2', isRotated: false } },
};
