'use client';

import type { OrbState } from 'thinking-orbs';
import type { Run } from '../../lib/api';
import { Orb } from '../ui';
import { Markdown } from '../ui/markdown';

/** What the panel calls each tool, so the owner reads an action instead of a function name. */
export const toolLabels: Record<string, string> = {
  analyze_media: 'looking at an attachment',
  send_file: 'sending a file',
  save_attachment: 'saving an attachment',
  find_stickers: 'looking for a sticker',
  send_sticker: 'sending a sticker',
  tag_sticker: 'tagging a sticker',
  compact_context: 'compacting its context',
  load_tools: 'loading tools',
  generate_image: 'drawing an image',
  generate_speech: 'recording a voice reply',
  list_speech_voices: 'choosing a voice',
  create_checkpoint: 'saving its progress',
  read_memories: 'reading its memories',
  remember: 'saving a memory',
  forget_memory: 'deleting a memory',
  list_schedules: 'checking its schedules',
  create_schedule: 'scheduling something',
  update_schedule: 'changing a schedule',
  delete_schedule: 'deleting a schedule',
  link_memories: 'linking memories',
  unlink_memories: 'unlinking memories',
  list_sessions: 'looking through its conversations',
  read_session: 'reading another conversation',
  load_skill: 'loading a skill',
  search_history: 'searching the history',
  read_artifact: 'reading a large result',
  list_activities: 'checking what is under way',
  read_run_checkpoints: 'reviewing the steps of a run',
  send_session_message: 'writing to another conversation',
  list_agents: 'looking up the other agents',
  ask_agent: 'asking another agent',
  read_inbox: 'reading its inbox',
  acquire_resource: 'reserving a resource',
  release_resource: 'releasing a resource',
  message_contact: 'writing to a contact',
  list_contacts: 'looking up its contacts',
  run_command: 'running a command',
  read_file: 'reading a file',
  edit_file: 'editing a file',
  write_file: 'writing a file',
  find_files: 'finding files',
  search_files: 'searching files',
  list_directory: 'listing a directory',
  web_search: 'searching the web',
  fetch_url: 'reading a page',
  create_skill: 'writing a skill',
  update_skill: 'rewriting a skill',
  delete_skill: 'removing a skill',
  update_identity: 'adjusting its own identity',
  read_identity: 'rereading its own identity',
  create_profile: 'creating an agent',
};

/** The orb's animation for each tool: looking things up, working with its hands, or asking. */
export const toolOrbs: Record<string, OrbState> = {
  web_search: 'searching',
  fetch_url: 'searching',
  search_history: 'searching',
  search_files: 'searching',
  find_files: 'searching',
  ask_agent: 'connecting',
  list_agents: 'connecting',
  send_session_message: 'connecting',
  message_contact: 'connecting',
};

/**
 * What the agent is on, in a few words, and the orb that goes with it: the same in the list of
 * conversations and in the open one, since both read the same run.
 */
export function statusOf(run: Run): { label: string; state: OrbState; tool: boolean } {
  const progress = run.progress;
  const tool =
    progress?.phase === 'tool'
      ? (toolLabels[progress.tool ?? ''] ?? progress.tool ?? 'using a tool')
      : undefined;

  return {
    label:
      run.status === 'queued'
        ? 'Starting'
        : tool
          ? `${tool[0]?.toUpperCase()}${tool.slice(1)}`
          : progress?.text
            ? 'Writing'
            : 'Thinking',
    state:
      run.status === 'queued'
        ? 'breathing'
        : tool
          ? (toolOrbs[progress?.tool ?? ''] ?? 'working')
          : 'composing',
    tool: Boolean(tool),
  };
}

/**
 * What the agent is doing, while it does it, where its answer will appear: the thinking orb
 * and a line saying what it is on, then the answer as it is written. The panel is the only
 * surface that names tools; a chat channel gets the answer and nothing else.
 */
export function RunProgress({
  run,
  children,
  toolShown = false,
}: {
  run: Run;
  /** The timeline above already shows the tool at work, with its own orb. */
  toolShown?: boolean;
  /** The tools used so far, shown above the status line. */
  children?: React.ReactNode;
}) {
  const progress = run.progress;
  const { label, state, tool } = statusOf(run);
  // Writing is shown by the words themselves: the orb gives way to them, and they are drawn as
  // the finished answer will be, so nothing reflows when the run ends.
  const writing = !tool && Boolean(progress?.text);

  return (
    <article className="chat-line pending theirs" aria-live="polite">
      {children}
      {!writing && !(tool && toolShown) && (
        <span className="run-phase">
          <Orb state={state} />
          {label}
        </span>
      )}
      {writing && (
        <div className="chat-text markdown streaming">
          <Markdown text={progress?.text ?? ''} breaks />
        </div>
      )}
    </article>
  );
}
