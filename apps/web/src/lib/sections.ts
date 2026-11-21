/** The section tabs, in order (docs/05 § Pages). */
export const SECTIONS = [
  { to: '/', label: 'Overview' },
  { to: '/rooms', label: 'Rooms' },
  { to: '/weather', label: 'Weather' },
  { to: '/energy', label: 'Energy' },
  { to: '/heating', label: 'Heating' },
  { to: '/water', label: 'Water' },
  { to: '/wifi', label: 'Wi-Fi' },
  { to: '/misc', label: 'Misc' },
  { to: '/system', label: 'System' },
] as const;

/** Phone bottom bar (docs/09 § Mobile navigation): these four, then More. */
export const BOTTOM_NAV = ['/', '/rooms', '/energy', '/heating'] as const;

/** Everything else, in tab order, plus Settings: the More sheet. */
export const MORE_SECTIONS = [
  ...SECTIONS.filter((s) => !(BOTTOM_NAV as readonly string[]).includes(s.to)),
  { to: '/settings', label: 'Settings' },
] as const;

/** More is the active item when the page is one of its sections. */
export function isMorePage(pathname: string): boolean {
  return MORE_SECTIONS.some((s) => s.to === pathname);
}
