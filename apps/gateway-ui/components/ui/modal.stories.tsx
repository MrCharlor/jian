import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';
import { Button } from './button';
import { Confirm, Modal } from './modal';
import { Secret } from './secret';

const meta = {
  title: 'UI/Dialogs',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Dialog: Story = {
  render: () => (
    <Modal
      title="New agent"
      description="A name now; everything else can wait."
      close={fn()}
      footer={
        <>
          <Button variant="secondary">Cancel</Button>
          <Button>Create</Button>
        </>
      }
    >
      <p>Anything a screen puts in a dialog goes here.</p>
    </Modal>
  ),
};

export const ConfirmDanger: Story = {
  render: () => (
    <Confirm
      title="Disconnect WhatsApp?"
      description="The linked device is removed and queued replies are dropped."
      confirm={fn()}
      close={fn()}
    />
  ),
};

export const ShownOnce: Story = {
  render: () => (
    <Secret title="Webhook secret" value="synthetic-webhook-secret-7f3a9c2e" close={fn()} />
  ),
};
