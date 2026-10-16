import {
  Activity,
  AlarmClock,
  AppWindow,
  AtSign,
  BookOpen,
  ClipboardCheck,
  ClipboardList,
  Columns3,
  Cpu,
  FileCheck,
  Fingerprint,
  Gauge,
  Inbox,
  KeyRound,
  LayoutDashboard,
  LayoutTemplate,
  Library,
  ListOrdered,
  ListTodo,
  type LucideIcon,
  MapIcon,
  MessageSquare,
  PenTool,
  Plug,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Workflow,
} from 'lucide-react';

export type NavigationItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  group: 'global' | 'agent';
};

/**
 * The sections of the panel, in the order the sidebar shows them. A section is a route. The
 * Global holds what belongs to the installation; Agent holds the open agent's own sections.
 */
export const navigation: NavigationItem[] = [
  { href: '/inbox', label: 'Esperando você', icon: Inbox, group: 'global' },
  { href: '/requests', label: 'Pedidos → épico', icon: Workflow, group: 'global' },
  { href: '/providers', label: 'Providers', icon: Plug, group: 'global' },
  { href: '/pautas', label: 'Pautas', icon: ClipboardList, group: 'global' },
  { href: '/roadmap', label: 'Roadmap', icon: MapIcon, group: 'global' },
  { href: '/board', label: 'Quadro', icon: Columns3, group: 'global' },
  { href: '/validations', label: 'Validações', icon: ClipboardCheck, group: 'global' },
  { href: '/mentions', label: 'Menções', icon: AtSign, group: 'global' },
  { href: '/plans', label: 'Planos', icon: FileCheck, group: 'global' },
  { href: '/routines', label: 'Rotinas', icon: Activity, group: 'global' },
  { href: '/knowledge', label: 'Conhecimento', icon: Library, group: 'global' },
  { href: '/screens', label: 'Telas', icon: LayoutTemplate, group: 'global' },
  { href: '/priorities', label: 'Priorização', icon: ListOrdered, group: 'global' },
  { href: '/applications', label: 'Aplicações', icon: AppWindow, group: 'global' },
  { href: '/draw', label: 'Desenhos', icon: PenTool, group: 'global' },
  { href: '/', label: 'Overview', icon: LayoutDashboard, group: 'agent' },
  { href: '/identity', label: 'Identity', icon: Fingerprint, group: 'agent' },
  { href: '/ssh-keys', label: 'SSH keys', icon: KeyRound, group: 'agent' },
  { href: '/sessions', label: 'Chats', icon: MessageSquare, group: 'agent' },
  { href: '/models', label: 'Model defaults', icon: Cpu, group: 'agent' },
  { href: '/channels', label: 'Channels', icon: Smartphone, group: 'agent' },
  { href: '/schedules', label: 'Schedules', icon: AlarmClock, group: 'agent' },
  { href: '/approvals', label: 'Approvals', icon: ShieldCheck, group: 'agent' },
  { href: '/quality', label: 'Quality', icon: Gauge, group: 'agent' },
  { href: '/tasks', label: 'Work', icon: ListTodo, group: 'agent' },
  { href: '/memories', label: 'Memories', icon: BookOpen, group: 'agent' },
  { href: '/skills', label: 'Skills', icon: Sparkles, group: 'agent' },
  { href: '/mcp', label: 'MCP servers', icon: Plug, group: 'agent' },
];

export const groupLabels = {
  global: 'Global',
  agent: 'Agent',
} as const;

/** The deepest section whose route prefixes the current one, so a child route stays marked. */
export function currentSection(pathname: string): NavigationItem | undefined {
  const path = pathname.replace(/\/$/, '') || '/';

  return [...navigation]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => path === item.href || path.startsWith(`${item.href}/`));
}
