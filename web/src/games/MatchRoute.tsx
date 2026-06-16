import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../shared/api";
import { Match as RpsMatch } from "./rps/Match";
import { Match as GomokuMatch } from "./gomoku/Match";

/**
 * Dispatcher for `/match/:id`. Fetches the match once to read its `gameId`, then
 * hands off to the matching game's <Match/>. Each game's Match opens its own WS
 * and refetches the snapshot itself, so we deliberately don't pass anything down
 * beyond the route param. On fetch error we fall back to the RPS Match, which
 * surfaces its own error UI.
 */
export function MatchRoute() {
  const { id: matchId } = useParams<{ id: string }>();
  const [gameId, setGameId] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    if (!matchId) {
      setResolved(true);
      return;
    }
    let cancelled = false;
    void api
      .getMatch(matchId)
      .then((snap) => {
        if (!cancelled) setGameId(snap.gameId);
      })
      .catch(() => {
        // Leave gameId null — fall through to the RPS fallback below.
      })
      .finally(() => {
        if (!cancelled) setResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [matchId]);

  if (!resolved) return <div className="card">Loading match…</div>;

  return gameId === "gomoku" ? <GomokuMatch /> : <RpsMatch />;
}
