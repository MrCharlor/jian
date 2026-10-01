import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { releases } from '../../stories/fixtures';
import { outdatedHandlers, updatedHandlers } from '../../stories/handlers';
import { Markdown } from '../ui/markdown';
import { ReleaseNotes, useReleaseNotes } from './dialog';

const meta = {
  title: 'Releases',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** What opens once after an update. */
export const WhatsNew: Story = {
  parameters: { msw: { handlers: updatedHandlers } },
  render: () => <ReleaseNotes />,
};

function OpenHistory() {
  const open = useReleaseNotes();

  return (
    <button type="button" className="button secondary m-6" onClick={open}>
      Release notes
    </button>
  );
}

/** Every release up to the running one, opened from the sidebar at any time. */
export const History: Story = {
  render: () => (
    <ReleaseNotes>
      <OpenHistory />
    </ReleaseNotes>
  ),
};

/** An older installation: the sidebar shows a glowing count and the click opens pending notes. */
export const Outdated: Story = {
  parameters: { msw: { handlers: outdatedHandlers } },
  render: () => (
    <ReleaseNotes>
      <OpenHistory />
    </ReleaseNotes>
  ),
};

/** The Markdown a note may use, rendered as the dialog renders it. */
export const NoteText: Story = {
  parameters: { layout: 'padded' },
  render: () => (
    <div className="release-notes max-w-xl">
      <Markdown text={releases.unseen[0]?.body ?? ''} />
    </div>
  ),
};
