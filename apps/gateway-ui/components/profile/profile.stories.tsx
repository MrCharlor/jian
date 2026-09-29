import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import * as fixtures from '../../stories/fixtures';
import { sectionProps } from '../../stories/section';
import { withWorkspace } from '../../stories/workspace';
import { Avatar } from './avatar-field';
import { NewProfileDialog, ProfileEditor } from './editor';

const meta = {
  title: 'Sections/Agent',
  // The editor reads the workspace for deleting a profile, as it does inside the panel.
  decorators: [withWorkspace],
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Editor: Story = {
  render: () => {
    const { profile, api, busy } = sectionProps();

    return <ProfileEditor profile={profile} api={api} busy={busy} />;
  },
};

/** Resetting asks first, and says what is kept. */
export const ResetConfirm: Story = {
  render: () => {
    const { profile, api, busy } = sectionProps();

    return <ProfileEditor profile={profile} api={api} busy={busy} />;
  },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Reset agent/ }));
    await expect(await within(document.body).findByText('Reset Zero Two?')).toBeInTheDocument();

    const dialog = within(document.body);
    const confirm = dialog.getByRole('button', { name: 'Confirm' });

    // Nothing irreversible happens until the profile's name is typed.
    await expect(confirm).toBeDisabled();
    await userEvent.type(dialog.getByLabelText('Type Zero Two to confirm'), 'Zero Two');
    await expect(confirm).toBeEnabled();
  },
};

/** Deleting asks first, and names what goes with the profile. */
export const DeleteConfirm: Story = {
  render: () => {
    const { profile, api, busy } = sectionProps();

    return <ProfileEditor profile={profile} api={api} busy={busy} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(canvas.getByRole('button', { name: /Delete agent/ }));
    await expect(await within(document.body).findByText('Delete Zero Two?')).toBeInTheDocument();

    const dialog = within(document.body);
    const confirm = dialog.getByRole('button', { name: 'Confirm' });

    // Nothing irreversible happens until the profile's name is typed.
    await expect(confirm).toBeDisabled();
    await userEvent.type(dialog.getByLabelText('Type Zero Two to confirm'), 'Zero Two');
    await expect(confirm).toBeEnabled();
  },
};

/** A profile with nothing filled in yet, every switch off. */
export const EditorBlank: Story = {
  render: () => {
    const { api, busy } = sectionProps();
    const blank = fixtures.profiles[2];

    if (!blank) throw new Error('No blank profile in the fixtures');

    return <ProfileEditor profile={blank} api={api} busy={busy} />;
  },
};

export const NewAgent: Story = {
  parameters: { layout: 'fullscreen' },
  render: () => <NewProfileDialog api={sectionProps().api} done={fn()} close={fn()} />,
};

/** Without a picture an agent is its initials, in the theme's colours. */
export const Avatars: Story = {
  render: () => (
    <div className="flex items-center gap-4">
      {fixtures.profiles.map((profile) => (
        <Avatar
          key={profile.id}
          name={profile.name}
          avatar={profile.avatar}
          className="mini-avatar"
        />
      ))}
    </div>
  ),
};
