/** Chart colours come from the CSS tokens (styles.css), so there's one place to change them. */
export function token(name: `--${string}`): string {
  if (typeof document === 'undefined') return '#000';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000';
}

/** Tooltip colours from the tokens (ECharts' default is a white box, wrong in dark mode). */
export function tooltipStyle() {
  return {
    backgroundColor: token('--surface'),
    borderColor: token('--border-strong'),
    textStyle: { color: token('--text'), fontFamily: 'inherit', fontSize: 12 },
  };
}
