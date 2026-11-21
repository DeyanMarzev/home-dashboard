import { useEffect, useRef, useState, type ComponentType } from 'react';
import { NavLink, useLocation } from 'react-router';
import { BOTTOM_NAV, isMorePage, MORE_SECTIONS, SECTIONS } from '../lib/sections.js';
import { EnergyIcon, HeatingIcon, HomeIcon, MoreIcon, RoomsIcon } from './icons.js';

const ICONS: Record<(typeof BOTTOM_NAV)[number], ComponentType> = {
  '/': HomeIcon,
  '/rooms': RoomsIcon,
  '/energy': EnergyIcon,
  '/heating': HeatingIcon,
};

/**
 * Phone navigation at ≤ 640 px (docs/09 § Mobile navigation): four sections and More, which
 * opens a sheet with the rest and Settings. Hidden by CSS on wider screens.
 */
export function BottomNav() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false);
  const sheet = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = sheet.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <>
      <nav aria-label="Sections" className="bottom-nav">
        {BOTTOM_NAV.map((to) => {
          const Icon = ICONS[to];
          const label = SECTIONS.find((s) => s.to === to)!.label;
          return (
            <NavLink key={to} to={to} end className="bottom-nav-item">
              <Icon />
              <span>{label}</span>
            </NavLink>
          );
        })}
        <button
          type="button"
          className="bottom-nav-item"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-current={isMorePage(pathname) ? 'page' : undefined}
          onClick={() => setOpen(true)}
        >
          <MoreIcon />
          <span>More</span>
        </button>
      </nav>
      <dialog
        ref={sheet}
        className="sheet"
        aria-label="More sections"
        onClose={() => setOpen(false)}
        // A tap on the backdrop (the dialog itself, outside its content) closes it.
        onClick={(e) => e.target === e.currentTarget && setOpen(false)}
      >
        <ul className="sheet-list">
          {MORE_SECTIONS.map((s) => (
            <li key={s.to}>
              <NavLink to={s.to} end className="sheet-item" onClick={() => setOpen(false)}>
                {s.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <button type="button" className="sheet-close" onClick={() => setOpen(false)}>
          Close
        </button>
      </dialog>
    </>
  );
}
