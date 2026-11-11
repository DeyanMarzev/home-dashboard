/** Wind blows FROM `degrees`: the arrow points where it's going. */
export function WindArrow({ degrees }: { degrees: number }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      aria-hidden="true"
      style={{ transform: `rotate(${degrees + 180}deg)`, verticalAlign: '-2px' }}
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 20V4M6 10l6-6 6 6" />
    </svg>
  );
}
