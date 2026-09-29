import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Plus } from 'lucide-react';
import { Button } from './button';
import { Badge, Empty, SectionHeading } from './layout';

const meta = {
  title: 'UI/Layout',
  parameters: { layout: 'padded' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Heading: Story = {
  render: () => (
    <SectionHeading
      title="Providers"
      description="Connect once, use from every agent. Each agent picks its own model under Model defaults."
      action={
        <Button>
          <Plus size={16} /> Add
        </Button>
      }
    />
  ),
};

export const Badges: Story = {
  render: () => (
    <div className="flex gap-3">
      <Badge>Not configured</Badge>
      <Badge tone="good">Connected</Badge>
      <Badge tone="warn">Pending</Badge>
      <Badge tone="bad">Failed</Badge>
    </div>
  ),
};

export const EmptyState: Story = {
  render: () => (
    <Empty title="No conversations yet" action={<Button>Start one</Button>}>
      Write to the agent here, or connect WhatsApp or Telegram under Channels.
    </Empty>
  ),
};
