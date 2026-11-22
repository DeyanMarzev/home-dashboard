import { Fragment, useEffect } from 'react';
import { Outlet, ScrollRestoration, useLocation } from 'react-router';
import { useAccessDisabled, useSessionExpired } from '../api/session.js';
import { useColorScheme } from '../lib/color-scheme.js';
import { BottomNav } from './BottomNav.js';
import { UpdateToast } from './UpdateToast.js';

export function Layout() {
  const expired = useSessionExpired();
  const disabled = useAccessDisabled();
  // Charts read their colours from the tokens when drawn: redraw the page when the system
  // switches between light and dark (the query cache keeps the data, so it's instant).
  const scheme = useColorScheme();
  useScrollToHash();
  return (
    <>
      {expired && (
        <div className="page" style={{ paddingBottom: 0 }}>
          <p className="banner" role="alert">
            Your sign-in has expired. <a href={window.location.href}>Reload the page</a> to sign in
            again.
          </p>
        </div>
      )}
      {disabled && (
        <div className="page" style={{ paddingBottom: 0 }}>
          <p className="banner" role="alert">
            Your access to the dashboard has been turned off. Ask an admin to turn it back on.
          </p>
        </div>
      )}
      <Fragment key={scheme}>
        <Outlet />
      </Fragment>
      <BottomNav />
      <UpdateToast />
      <ScrollRestoration />
    </>
  );
}

/**
 * `/rooms#kitchen` (a notification's deep link) scrolls to that card once it has loaded:
 * cards appear after their data (on a slow phone connection, a while), so keep looking for
 * up to 10 seconds.
 */
function useScrollToHash() {
  const { hash, pathname } = useLocation();
  useEffect(() => {
    const id = decodeURIComponent(hash.slice(1));
    if (!id) return;
    let tries = 0;
    const timer = setInterval(() => {
      const el = document.getElementById(id);
      if (el || ++tries > 40) clearInterval(timer);
      el?.scrollIntoView({ block: 'start' });
    }, 250);
    return () => clearInterval(timer);
  }, [hash, pathname]);
}
