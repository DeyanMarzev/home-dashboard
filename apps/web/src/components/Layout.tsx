import { Outlet, ScrollRestoration } from 'react-router';
import { useSessionExpired } from '../api/session.js';

export function Layout() {
  const expired = useSessionExpired();
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
      <Outlet />
      <ScrollRestoration />
    </>
  );
}
