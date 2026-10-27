import type { JSX, SVGProps } from 'react'

/**
 * Tiny inline SVG icon set for the agent chat panel + sidebar.
 *
 * Why inline instead of importing from a package: this feature lives behind a
 * hot path (the chat panel re-renders on every event) and we want zero extra
 * bundles. All icons share a 24x24 viewBox / `1.75` stroke / `currentColor`
 * fill so size + theming are controlled by Tailwind classes on the wrapper.
 *
 * Replace the emoji glyphs ( ⋯ / + / ⇥ / ⇤ / ▶ / x ) used previously — the
 * UI/UX rules for this project disallow emoji as UI icons.
 */

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children' | 'viewBox' | 'fill'>

function Svg({ children, ...rest }: IconProps & { children: React.ReactNode }): JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export function PlusIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

export function CloseIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M6 6l12 12M18 6L6 18" />
    </Svg>
  )
}

export function MoreIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </Svg>
  )
}

/** Sidebar collapse arrow — points right (sidebar is open and will collapse). */
export function PanelCollapseRightIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
      <path d="M9 9l3 3-3 3" />
    </Svg>
  )
}

/** Sidebar expand arrow — points left (sidebar is collapsed and will expand). */
export function PanelExpandLeftIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
      <path d="M12 9l-3 3 3 3" />
    </Svg>
  )
}

/** Settings gear — opens the in-chat Codex settings popover. */
export function GearIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Svg>
  )
}

export function PencilIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
    </Svg>
  )
}

export function TrashIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </Svg>
  )
}

export function ChatBubbleIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M21 12a8 8 0 0 1-11.5 7.18L4 21l1.82-5.5A8 8 0 1 1 21 12z" />
    </Svg>
  )
}

/** Generic file glyph (with folded corner) — used by attachment chips. */
export function FileIcon(props: IconProps): JSX.Element {
  return (
    <Svg width={12} height={12} {...props}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </Svg>
  )
}

/** Brain-ish glyph — marks the per-thread cross-session memory toggle. */
export function BrainIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 5.5a3 3 0 0 0-5.9-.7A2.8 2.8 0 0 0 4 7.5c0 .7.2 1.3.6 1.8A3 3 0 0 0 4 11.5c0 1 .5 1.9 1.3 2.4A3 3 0 0 0 9 18.5c1.6 0 3-1.1 3-2.6z" />
      <path d="M12 5.5a3 3 0 0 1 5.9-.7A2.8 2.8 0 0 1 20 7.5c0 .7-.2 1.3-.6 1.8A3 3 0 0 1 20 11.5c0 1-.5 1.9-1.3 2.4A3 3 0 0 1 15 18.5c-1.6 0-3-1.1-3-2.6z" />
      <path d="M12 5.5v10.4" />
    </Svg>
  )
}

/** Arrow-out-of-square — affordance hint for "open in side panel". */
export function OpenInPanelIcon(props: IconProps): JSX.Element {
  return (
    <Svg width={10} height={10} {...props}>
      <path d="M15 3h6v6" />
      <path d="M10 14L21 3" />
      <path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5" />
    </Svg>
  )
}

/** Push-pin (lucide `pin` shape) — sidebar pin / unpin. */
export function PinIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </Svg>
  )
}

/** Magnifier — sidebar thread search. */
export function SearchIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Svg>
  )
}

/** Four-pane grid — "Agent 工作台" entry. */
export function LayoutDashboardIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </Svg>
  )
}

/** Small ↗ — "opens elsewhere" hint on a row. */
export function ArrowUpRightIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M7 17L17 7" />
      <path d="M8 7h9v9" />
    </Svg>
  )
}

/** Circle + check — finished thread status. */
export function CircleCheckIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </Svg>
  )
}

/** Open ring — running thread status; wrap in `animate-spin`. */
export function LoaderIcon(props: IconProps): JSX.Element {
  return (
    <Svg {...props}>
      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
    </Svg>
  )
}
