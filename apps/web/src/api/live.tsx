import {
  StreamFreshnessSchema,
  StreamReadingSchema,
  type LatestResponse,
  type SourceInfo,
} from '@home/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { applyReading, applySourceFreshness } from '../model/live-updates.js';
import { API_BASE } from './client.js';
import { LiveContext, type LiveState } from './live-context.js';

/** Keeps the query cache current from GET /api/stream (docs/04). EventSource reconnects by itself. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<LiveState>({ connected: false, lastMessageAt: null });

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    const source = new EventSource(`${API_BASE}/api/stream`, { withCredentials: true });
    const touched = () => setState({ connected: true, lastMessageAt: new Date() });

    source.onopen = () => setState((s) => ({ ...s, connected: true }));
    source.onerror = () => setState((s) => ({ ...s, connected: false }));

    source.addEventListener('reading', (e: MessageEvent<string>) => {
      const r = StreamReadingSchema.safeParse(JSON.parse(e.data));
      if (!r.success) return;
      queryClient.setQueriesData<LatestResponse>({ queryKey: ['latest'] }, (old) =>
        applyReading(old, r.data),
      );
      touched();
    });
    source.addEventListener('freshness', (e: MessageEvent<string>) => {
      const f = StreamFreshnessSchema.safeParse(JSON.parse(e.data));
      if (!f.success) return;
      queryClient.setQueryData<SourceInfo[]>(['sources'], (old) =>
        applySourceFreshness(old, f.data),
      );
      touched();
    });
    source.addEventListener('event', () => {
      void queryClient.invalidateQueries({ queryKey: ['events'] });
      touched();
    });
    return () => source.close();
  }, [queryClient]);

  return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}
