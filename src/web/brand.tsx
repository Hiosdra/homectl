// The homectl mark: a house with a hub in it, the point where the workspace is controlled.
// Drawn in the panel's own colours (the tile takes the primary colour, the glyph its
// foreground), so it follows the light and dark themes. Decorative: the wordmark sits next
// to it.
export function BrandMark({ size = 30 }: { size?: number }) {
  const glyph = Math.round(size * 0.66);
  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-[22%] bg-primary text-primary-foreground"
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 32 32"
        width={glyph}
        height={glyph}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M5.5 15.2 16 6.5l10.5 8.7" />
        <path d="M9 14v11.5h14V14" />
        <circle cx="16" cy="19.4" r="2.3" fill="currentColor" stroke="none" />
      </svg>
    </span>
  );
}
