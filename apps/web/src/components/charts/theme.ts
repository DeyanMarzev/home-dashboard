/** Chart colours come from the CSS tokens (styles.css), so there's one place to change them. */
export function token(name: `--${string}`): string {
  if (typeof document === 'undefined') return '#000';
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#000';
}
