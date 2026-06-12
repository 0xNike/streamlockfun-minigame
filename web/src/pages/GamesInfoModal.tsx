import { useEffect, useState } from "react";
import { HelpCircle, X } from "lucide-react";

const POINTS = [
  {
    title: "Your tokens stay put",
    body: "Playing never moves your tokens. They stay locked the whole time. Only your share of the final payout changes.",
  },
  {
    title: "Every win is someone's loss",
    body: "Games don't create or destroy value. Whatever you win comes from another player, and whatever you lose goes to them.",
  },
  {
    title: "Time to dispute",
    body: "After a game ends, you have 1 hour to flag a wrong result before it's final.",
  },
];

export function GamesInfoModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="How Streamlock games work"
        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-300"
      >
        <HelpCircle className="h-5 w-5" />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative max-h-[90vh] w-full max-w-md overflow-y-auto rounded-xl border border-white/10 bg-zinc-900 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close"
              className="absolute right-4 top-4 text-zinc-400 transition-colors hover:text-white"
            >
              <X className="h-5 w-5" />
            </button>

            <div className="p-6">
              <h2 className="mb-3 text-lg font-semibold tracking-tight text-white">
                How Streamlock games work
              </h2>
              <p className="mb-5 text-sm leading-relaxed text-zinc-400">
                Your tokens stay locked until they unlock. Instead of just
                waiting, you can wager that locked position in games against
                other holders. Win a game and your share of the unlock payout
                grows. Lose and it shrinks.
              </p>

              <div className="space-y-3">
                {POINTS.map((point) => (
                  <div
                    key={point.title}
                    className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4"
                  >
                    <h3 className="mb-1 text-sm font-semibold text-zinc-200">
                      {point.title}
                    </h3>
                    <p className="text-xs leading-relaxed text-zinc-500">
                      {point.body}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
