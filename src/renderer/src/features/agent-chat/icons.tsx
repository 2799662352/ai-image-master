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
