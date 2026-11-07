import { createContext, useContext } from 'react';

/** One shared clock for the whole app: badges re-tick and "30 s ago" labels update with it. */
export const NowContext = createContext<Date>(new Date());

export function useNow(): Date {
  return useContext(NowContext);
}
