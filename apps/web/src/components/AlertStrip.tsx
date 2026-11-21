import type { EventItem } from '@home/shared';
import { AlertIcon, InfoIcon } from './icons.js';

/** Open warnings and alerts from `events`; info events show in neutral (docs/05). */
export function AlertStrip({ events }: { events: EventItem[] }) {
  if (events.length === 0) return null;
  return (
    <section aria-label="Alerts" className="row" style={{ gap: 12 }}>
      {events.map((e) => {
        const [head, ...rest] = e.message.split(' · ');
        return (
          <div key={e.id} className={`alert alert--${e.level}`}>
            {e.level === 'info' ? <InfoIcon /> : <AlertIcon size={20} />}
            <p>
              <strong>{head}</strong>
              {rest.length > 0 && ` · ${rest.join(' · ')}`}
              {metOfficeLink(e) && (
                <>
                  {' · '}
                  <a href={metOfficeLink(e)!} target="_blank" rel="noreferrer">
                    Details on Met Office
                  </a>
                </>
              )}
            </p>
          </div>
        );
      })}
    </section>
  );
}

/** Weather warnings must link to the Met Office page wherever their text is shown (docs/10 §4). */
function metOfficeLink(e: EventItem): string | null {
  if (e.kind !== 'weather_warning') return null;
  const url = (e.data as { url?: unknown } | null)?.url;
  return typeof url === 'string' && url.startsWith('https://www.metoffice.gov.uk/') ? url : null;
}
