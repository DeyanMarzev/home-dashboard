import type { ReactNode } from 'react';

/** Small stroke icons from the mockup (decorative: always next to text). */
const common = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export const ClockIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth={2.5} {...common}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const AlertIcon = ({ size = 12 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth={2.5} {...common}>
    <path d="M12 3 2 20h20L12 3z" />
    <path d="M12 10v4" />
    <path d="M12 17h.01" />
  </svg>
);

export const InfoIcon = ({ size = 20 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth={2} {...common}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v4" />
    <path d="M12 16h.01" />
  </svg>
);

/** Navigation icons (bottom bar and top bar): always next to a label or with aria-label. */
function NavSvg({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" strokeWidth={2} {...common}>
      {children}
    </svg>
  );
}

export const HomeIcon = ({ size = 22 }: { size?: number }) => (
  <NavSvg size={size}>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 9v11h14V9" />
    <path d="M10 20v-6h4v6" />
  </NavSvg>
);

export const RoomsIcon = ({ size = 22 }: { size?: number }) => (
  <NavSvg size={size}>
    <path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0z" />
    <path d="M12 17v-6" />
  </NavSvg>
);

export const EnergyIcon = ({ size = 22 }: { size?: number }) => (
  <NavSvg size={size}>
    <path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z" />
  </NavSvg>
);

export const HeatingIcon = ({ size = 22 }: { size?: number }) => (
  <NavSvg size={size}>
    <path d="M12 22c4 0 7-2.7 7-6.8 0-3.6-2.6-6-4.2-8.7-.4 2-1.6 3.4-2.8 3.9C12.6 7 11 4.3 8.6 2.5 8.4 6.8 5 9.3 5 14.4 5 19 8 22 12 22z" />
  </NavSvg>
);

export const MoreIcon = ({ size = 22 }: { size?: number }) => (
  <NavSvg size={size}>
    <circle cx="5" cy="12" r="1.2" />
    <circle cx="12" cy="12" r="1.2" />
    <circle cx="19" cy="12" r="1.2" />
  </NavSvg>
);

export const GearIcon = ({ size = 22 }: { size?: number }) => (
  <NavSvg size={size}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </NavSvg>
);
