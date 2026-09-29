import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import type { Run } from '../../lib/api';
import { useWorkspace } from '../../lib/workspace';
import * as fixtures from '../../stories/fixtures';
import { ids } from '../../stories/fixtures';
import { sectionProps } from '../../stories/section';
import { withWorkspace } from '../../stories/workspace';
import { Sessions } from '.';
import { History } from './history';
import { RunProgress } from './progress';

const meta = {
  title: 'Sections/Chats',
  // The list names another agent by its profile, which the workspace holds.
  decorators: [withWorkspace],
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The screen as the page renders it: on the workspace's data, which the live stream keeps
 * current, and on the fixtures until the workspace has loaded.
 */
function Live({ sessionId }: { sessionId?: string | undefined }) {
  const { data } = useWorkspace();

  return (
    <Sessions
      {...sectionProps(data ? { data } : {})}
      {...(sessionId ? { initialSession: sessionId } : {})}
    />
  );
}

/** The messenger fills the height it is given, as it does beside the app's sidebar. */
const open = (sessionId?: string): Story => ({
  parameters: { layout: 'fullscreen' },
  render: () => (
    <div style={{ height: '100dvh' }}>
      <Live sessionId={sessionId} />
    </div>
  ),
});

/** The gateway conversation: images, documents, voice notes both ways, and many tool calls. */
export const List = open();
/** WhatsApp, one person: her voice note, a photo, a PDF, and a voice reply from the agent. */
export const WhatsAppContact = open(ids.mayaChat);
/** WhatsApp group: members with and without names or pictures, one known only by an internal id. */
export const WhatsAppGroup = open(ids.launchGroup);
/** Telegram, one person, with the agent working on the answer right now. */
export const Working = open(ids.theoChat);
/** A group read over the agent's shoulder: each member with their face, the agent on the right. */
export const Group = open(ids.designGroup);
/** Another agent of this installation asking for a review. */
export const Agent = open(ids.peerChat);
/** API Server: a report in Markdown behind 33 tools, one of them failed. */
export const ApiReport = open(ids.reportChat);
/** API Server: a request that failed before the agent could answer. */
export const Failed = open(ids.planningChat);
/** API Server: a conversation opened and never written in. */
export const Empty = open(ids.emptyChat);

export const Conversation: Story = {
  render: () => <History api={sectionProps().api} profileId={ids.zero} sessionId={ids.theoChat} />,
};

const live = fixtures.runs[0] as Run;
const progress = (
  patch: Partial<NonNullable<Run['progress']>>,
  status: Run['status'] = 'running',
) => ({
  ...live,
  status,
  progress: { phase: 'thinking' as const, text: '', steps: 1, updatedAt: live.updatedAt, ...patch },
});

/** What the chat shows while the agent works, one state at a time. */
export const Progress: Story = {
  render: () => (
    <div className="grid gap-4">
      <RunProgress run={progress({}, 'queued')} />
      <RunProgress run={progress({ phase: 'thinking' })} />
      <RunProgress run={progress({ phase: 'tool', tool: 'web_search', steps: 2 })} />
      <RunProgress
        run={progress({ phase: 'writing', text: 'Sent it. Maya has both links', steps: 3 })}
      />
    </div>
  ),
};
