import { createContext, useContext } from 'react';

export interface LiveState {
  /** True while the SSE stream is open; hooks poll faster when it isn't. */
  connected: boolean;
  /** When the last streamed message arrived. */
  lastMessageAt: Date | null;
}

export const LiveContext = createContext<LiveState>({ connected: false, lastMessageAt: null });

export function useLive(): LiveState {
  return useContext(LiveContext);
}
