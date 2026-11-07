import { useEffect, useState, type ReactNode } from 'react';
import { NowContext } from './now-context.js';

const TICK_MS = 30_000;

export function NowProvider({ children }: { children: ReactNode }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), TICK_MS);
    return () => clearInterval(timer);
  }, []);
  return <NowContext.Provider value={now}>{children}</NowContext.Provider>;
}
