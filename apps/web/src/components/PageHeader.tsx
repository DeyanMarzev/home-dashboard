import type { ReactNode } from 'react';
import { NavLink } from 'react-router';
import { RANGES, type Range } from '../lib/range.js';
import { SECTIONS } from '../lib/sections.js';

/** Title, subtitle, section tabs and time range pills, on every page (docs/05 § Pages). */
export function PageHeader<T extends string = Range>({
  title,
  subtitle,
  range,
  ranges,
  onRange,
}: {
  title: string;
  subtitle: ReactNode;
  range?: T;
  /** Page-specific options (docs/05 § TimeRangePills); default 24h / 7d / 30d. */
  ranges?: readonly T[];
  onRange?: (r: T) => void;
}) {
  const options = ranges ?? (RANGES as readonly string[] as readonly T[]);
  return (
    <header className="header">
      <div className="header-title">
        <h1>{title}</h1>
        <p className="subtitle">{subtitle}</p>
      </div>
      <nav aria-label="Sections" className="tabs">
        {SECTIONS.map((s) => (
          <NavLink key={s.to} to={s.to} end className="tab">
            {s.label}
          </NavLink>
        ))}
      </nav>
      {range && onRange ? (
        <div role="group" aria-label="Time range" className="pills">
          {options.map((r) => (
            <button
              key={r}
              type="button"
              className="pill"
              aria-pressed={r === range}
              onClick={() => onRange(r)}
            >
              {r}
            </button>
          ))}
        </div>
      ) : (
        <div aria-hidden="true" />
      )}
    </header>
  );
}
