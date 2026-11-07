// Termwork "Span" mark: the T's crossbar is a dimension line (the fixed term),
// the stem drops to a cursor block (the agent at work). Ink follows the text
// colour; the cursor uses the theme's accent.
export function Logo({ size = 48 }: { size?: number }) {
  return (
    <svg className="logo" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false">
      <g transform="translate(0 -2)">
        <path d="M10.5 14 V26 M53.5 14 V26 M10.5 20 H53.5 M32 20 V41" fill="none" stroke="currentColor" strokeWidth="5" />
        <rect className="logo-cursor" x="26" y="44" width="12" height="14" />
      </g>
    </svg>
  );
}
