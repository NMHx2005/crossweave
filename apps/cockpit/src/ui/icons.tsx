/**
 * The cockpit's icons: plain strokes on a 16-unit grid, drawn in `currentColor` so the
 * stylesheet decides their colour from tokens. Agent marks are simple original glyphs
 * in each CLI's hue — never a copy of a vendor's logo.
 */

type IconProps = { class?: string; title?: string }

function Svg({ children, class: cls, title }: IconProps & { children: preact.ComponentChildren }) {
  return (
    <svg class={`cockpit-icon ${cls ?? ''}`} viewBox="0 0 16 16" width="16" height="16" aria-hidden={title ? undefined : 'true'}
      role={title ? 'img' : undefined} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  )
}

export const FolderIcon = (p: IconProps) => <Svg {...p}><path d="M2 4.5h4l1.5 1.5H14v6.5H2z" /></Svg>
export const PlusIcon = (p: IconProps) => <Svg {...p}><path d="M8 3v10M3 8h10" /></Svg>
export const SidebarIcon = (p: IconProps) => <Svg {...p}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M6 3v10" /></Svg>
export const PanelRightIcon = (p: IconProps) => <Svg {...p}><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M10 3v10" /></Svg>
export const TerminalIcon = (p: IconProps) => <Svg {...p}><path d="M3 4.5l3.5 3.5L3 11.5M8 12h5" /></Svg>
export const FileIcon = (p: IconProps) => <Svg {...p}><path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3" /></Svg>
export const GlobeIcon = (p: IconProps) => <Svg {...p}><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.8 1.6 2.6 3.4 2.6 5.5S9.8 11.9 8 13.5M8 2.5C6.2 4.1 5.4 5.9 5.4 8s.8 3.9 2.6 5.5" /></Svg>
export const DiffIcon = (p: IconProps) => <Svg {...p}><path d="M5 3v6M2 6h6M8 12h6" /></Svg>
export const MoreIcon = (p: IconProps) => <Svg {...p}><path d="M4 8h.01M8 8h.01M12 8h.01" stroke-width="2.2" /></Svg>
export const GearIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="8" cy="8" r="2" /><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2" /></Svg>
)
export const ChevronIcon = (p: IconProps) => <Svg {...p}><path d="M6 4l4 4-4 4" /></Svg>
export const CloseIcon = (p: IconProps) => <Svg {...p}><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" /></Svg>
export const SearchIcon = (p: IconProps) => <Svg {...p}><circle cx="7" cy="7" r="4" /><path d="M10 10l3.5 3.5" /></Svg>

/** Each agent's mark. Unknown agents (and a bare shell) get the terminal glyph. */
export function AgentMark({ agent, class: cls }: { agent: string | null | undefined; class?: string }) {
  const c = `cockpit-agent cockpit-agent--${agent ?? 'shell'} ${cls ?? ''}`
  switch (agent) {
    case 'claude':
      return <Svg class={c}><path d="M8 2v12M2 8h12M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4" stroke-width="1.8" /></Svg>
    case 'codex':
      return <Svg class={c}><path d="M8 2l5.2 3v6L8 14l-5.2-3V5z" /><circle cx="8" cy="8" r="1.6" /></Svg>
    case 'gemini':
      return <Svg class={c}><path d="M8 1.5C8.6 5.6 10.4 7.4 14.5 8 10.4 8.6 8.6 10.4 8 14.5 7.4 10.4 5.6 8.6 1.5 8 5.6 7.4 7.4 5.6 8 1.5z" fill="currentColor" stroke="none" /></Svg>
    case 'opencode':
      return <Svg class={c}><rect x="3" y="3" width="10" height="10" rx="1" /><path d="M6 6.5h4v3H6z" fill="currentColor" stroke="none" /></Svg>
    case 'antigravity':
      return <Svg class={c}><path d="M3 13L8 3l5 10M5.5 9h5" /></Svg>
    case 'cursor':
      return <Svg class={c}><path d="M8 2l5.5 3.2v5.6L8 14l-5.5-3.2V5.2z" /><path d="M2.5 5.2L8 8.4l5.5-3.2M8 8.4V14" /></Svg>
    case 'copilot':
      return <Svg class={c}><rect x="2.5" y="4.5" width="11" height="8" rx="3" /><path d="M6 8.2v1.2M10 8.2v1.2" /></Svg>
    case 'aider':
      return <Svg class={c}><path d="M3 12.5l3.5-9h3l3.5 9M4.8 9h6.4" /></Svg>
    case 'amp':
      return <Svg class={c}><path d="M9.5 2L4 9h4l-1.5 5L12 7H8z" fill="currentColor" stroke="none" /></Svg>
    case 'qwen':
      return <Svg class={c}><circle cx="8" cy="8" r="5" /><path d="M10.5 10.5L13 13" /></Svg>
    default:
      return <TerminalIcon class={c} />
  }
}
