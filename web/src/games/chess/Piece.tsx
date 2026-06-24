/**
 * Chess piece, rendered as a crisp two-tone SVG figurine. We draw the solid
 * chess glyph (U+265A–265F) inside an <svg><text> with the U+FE0E text-
 * presentation selector + an explicit symbol font, so it renders as a vector
 * piece shape — never an OS emoji — and is themeable via fill/stroke.
 *
 * Isolated here so the art can be swapped for a hand-drawn figurine set later
 * without touching the board.
 */
const SOLID: Record<string, string> = {
  k: "♚",
  q: "♛",
  r: "♜",
  b: "♝",
  n: "♞",
  p: "♟",
};

export function Piece({ color, type }: { color: "w" | "b"; type: string }) {
  const white = color === "w";
  // Append U+FE0E (text presentation selector) so the glyph never renders as an emoji.
  const glyph = (SOLID[type] ?? "") + String.fromCharCode(0xfe0e);

  return (
    <svg viewBox="0 0 100 100" className="chess-piece" aria-hidden="true">
      <text
        x="50"
        y="52"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="74"
        style={{ fontFamily: '"Segoe UI Symbol", "Noto Sans Symbols 2", "DejaVu Sans", serif' }}
        fill={white ? "#f6f7f9" : "#16161a"}
        stroke={white ? "#3f3f46" : "#cbd5e1"}
        strokeWidth={1.5}
        paintOrder="stroke"
      >
        {glyph}
      </text>
    </svg>
  );
}
