import { useSearchParams } from 'react-router';

export const RANGES = ['24h', '7d', '30d'] as const;
export type Range = (typeof RANGES)[number];

export const RANGE_SECONDS: Record<Range, number> = {
  '24h': 86400,
  '7d': 7 * 86400,
  '30d': 30 * 86400,
};
export const RANGE_LABEL: Record<Range, string> = {
  '24h': 'last 24 hours',
  '7d': 'last 7 days',
  '30d': 'last 30 days',
};

/** The page's time range, kept in the URL (`?range=7d`) so it survives reloads and links. */
export function useRange(): { range: Range; setRange: (r: Range) => void } {
  const [params, setParams] = useSearchParams();
  const value = params.get('range');
  const range = (RANGES as readonly string[]).includes(value ?? '') ? (value as Range) : '24h';
  const setRange = (r: Range) =>
    setParams(
      (p) => {
        if (r === '24h') p.delete('range');
        else p.set('range', r);
        return p;
      },
      { replace: true },
    );
  return { range, setRange };
}
