import type { Decorator } from '@storybook/nextjs-vite';
import { ThemeProvider } from '../components/shell/theme';
import { WorkspaceProvider } from '../lib/workspace';
import { profiles } from './fixtures';

/**
 * The workspace a component expects around it, loaded the way the panel loads it — over HTTP,
 * which the story's handlers answer. For a piece of the chrome shown on its own.
 */
export const withWorkspace: Decorator = (Story) => (
  <ThemeProvider>
    <WorkspaceProvider initialProfiles={profiles} onSignOut={() => {}}>
      <Story />
    </WorkspaceProvider>
  </ThemeProvider>
);
