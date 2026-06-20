import { useState } from "react";

/**
 * Voluntary whole-match resign. Two-step (button → inline confirm) so a misclick
 * never forfeits a staked match. Render only while the match is actively in play
 * and the viewer is a participant; `onResign` should send `{ type: "forfeit" }`.
 */
export function ResignButton({ onResign }: { onResign: () => void }) {
  const [confirming, setConfirming] = useState(false);

  if (confirming) {
    return (
      <div className="resign-confirm">
        <span className="resign-confirm-text">Resign and forfeit the match?</span>
        <button
          type="button"
          className="resign-yes"
          onClick={() => {
            setConfirming(false);
            onResign();
          }}
        >
          Yes, resign
        </button>
        <button type="button" className="resign-cancel" onClick={() => setConfirming(false)}>
          Keep playing
        </button>
      </div>
    );
  }

  return (
    <button type="button" className="resign-btn" onClick={() => setConfirming(true)}>
      Resign
    </button>
  );
}
