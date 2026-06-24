import { useMemo, useState } from "react";
import { Chess, type Square } from "chess.js";
import type { Side } from "../../shared/types";
import { colorOf } from "./rules";
import { Piece } from "./Piece";

interface BoardProps {
  /** Full position as FEN — the board renders from this. */
  fen: string;
  /** Color the local player controls (orientation + move rights); null = spectator. */
  youSide: Side | null;
  /** True when it's the local player's turn (clicks enabled). */
  interactive: boolean;
  lastMove: { from: string; to: string } | null;
  /** Side-to-move is in check → highlight that king. */
  check: boolean;
  onMove: (from: string, to: string, promotion?: "q" | "r" | "b" | "n") => void;
}

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];

/**
 * Presentational + interactive chess board. Legal moves are computed locally
 * with chess.js for highlighting and click-guarding; the server re-validates
 * every move authoritatively. Board flips so the local player's pieces sit at
 * the bottom. Promotions open a small picker before the move is sent.
 */
export function Board({ fen, youSide, interactive, lastMove, check, onMove }: BoardProps) {
  const game = useMemo(() => new Chess(fen), [fen]);
  const [selected, setSelected] = useState<Square | null>(null);
  const [promo, setPromo] = useState<{ from: Square; to: Square } | null>(null);

  const myColor = youSide ? colorOf(youSide) : null;
  const flip = youSide === "b"; // Black views the board from its own side
  const ranks = flip ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const files = flip ? [...FILES].reverse() : FILES;

  // Legal destinations from the selected square → map of `to` → isPromotion.
  const targets = useMemo(() => {
    const m = new Map<string, boolean>();
    if (!selected) return m;
    for (const mv of game.moves({ square: selected, verbose: true })) {
      m.set(mv.to, (m.get(mv.to) ?? false) || !!mv.promotion);
    }
    return m;
  }, [game, selected]);

  // King square of the side to move, when in check.
  const checkedKing = useMemo(() => {
    if (!check) return null;
    const turn = game.turn();
    for (const r of [1, 2, 3, 4, 5, 6, 7, 8]) {
      for (const f of FILES) {
        const sq = `${f}${r}` as Square;
        const p = game.get(sq);
        if (p && p.type === "k" && p.color === turn) return sq;
      }
    }
    return null;
  }, [game, check]);

  function clickSquare(sq: Square) {
    if (!interactive || promo) return;
    const piece = game.get(sq);
    if (piece && myColor && piece.color === myColor) {
      setSelected(sq); // (re)select own piece
      return;
    }
    if (!selected) return;
    if (!targets.has(sq)) {
      setSelected(null); // clicked a non-target → deselect
      return;
    }
    if (targets.get(sq)) {
      setPromo({ from: selected, to: sq }); // needs a promotion choice
    } else {
      onMove(selected, sq);
      setSelected(null);
    }
  }

  function choosePromo(p: "q" | "r" | "b" | "n") {
    if (!promo) return;
    onMove(promo.from, promo.to, p);
    setPromo(null);
    setSelected(null);
  }

  return (
    <div className="chess-wrap">
      <div className="chess-board" role="grid" aria-label="Chess board">
        {ranks.map((rank) =>
          files.map((file) => {
            const sq = `${file}${rank}` as Square;
            const piece = game.get(sq);
            const light = (FILES.indexOf(file) + rank) % 2 === 0;
            const isTarget = targets.has(sq);
            const cls = [
              "chess-cell",
              light ? "chess-cell--light" : "chess-cell--dark",
              selected === sq ? "chess-cell--sel" : "",
              lastMove && (lastMove.from === sq || lastMove.to === sq) ? "chess-cell--last" : "",
              checkedKing === sq ? "chess-cell--check" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={sq}
                type="button"
                className={cls}
                role="gridcell"
                aria-label={`${sq}${piece ? `, ${piece.color === "w" ? "white" : "black"} ${piece.type}` : ", empty"}`}
                disabled={!interactive}
                onClick={() => clickSquare(sq)}
              >
                {piece && <Piece color={piece.color} type={piece.type} />}
                {isTarget && <span className={piece ? "chess-target-capture" : "chess-target-dot"} aria-hidden="true" />}
              </button>
            );
          }),
        )}
      </div>
      {promo && myColor && (
        <div className="chess-promo" role="dialog" aria-label="Choose promotion piece">
          <span className="dim small">Promote to:</span>
          {(["q", "r", "b", "n"] as const).map((p) => (
            <button key={p} type="button" className="chess-promo__btn" onClick={() => choosePromo(p)}>
              <Piece color={myColor} type={p} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
