import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { BadgeCheck } from "lucide-react";

type GameStatus = "live" | "beta" | "coming-soon";

type Game = {
  slug: string;
  name: string;
  tagline: string;
  description: string;
  operator: string;
  href?: string; // internal route ("/rps") or external URL ("https://...")
  image?: string;
  tags: string[];
  status: GameStatus;
  // Reviewed by Streamlock. Third-party submissions default to unverified.
  verified?: boolean;
};

// Add new games here. Keep the array as the single source of truth for the grid.
const GAMES: Game[] = [
  {
    slug: "rock-paper-scissors",
    name: "Rock Paper Scissors",
    tagline: "Face off 1v1 against another holder",
    description:
      "Pick rock, paper, or scissors and go head to head with another holder. Win to grow your share of the unlock payout.",
    operator: "Streamlock Labs",
    href: "/rps",
    tags: ["1v1", "Quick"],
    status: "live",
    verified: true,
  },
  {
    slug: "reversi",
    name: "Reversi",
    tagline: "Outflank to flip — most discs wins",
    description:
      "Take turns placing discs and trap your opponent's between two of yours to flip them. Whoever holds the most discs when the board fills grows their share of the unlock payout.",
    operator: "Streamlock Labs",
    href: "/reversi",
    tags: ["1v1", "Strategy"],
    status: "live",
    verified: true,
  },
];

// Only surface games people can actually play right now.
const PLAYABLE_GAMES = GAMES.filter((g) => g.status !== "coming-soon" && !!g.href);

function GameCard({ game }: { game: Game }) {
  const isExternal = !!game.href && game.href.startsWith("http");
  const cardClass =
    "group block overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40 transition-colors hover:border-orange-500/40 hover:bg-zinc-900/70";

  const inner = (
    <>
      <div className="relative aspect-[16/9] border-b border-zinc-800/80 bg-gradient-to-br from-zinc-800 to-zinc-900">
        {game.image ? (
          <img
            src={game.image}
            alt={game.name}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-4xl font-semibold tracking-tight text-zinc-700">
              {game.name.charAt(0)}
            </div>
          </div>
        )}
      </div>
      <div className="p-5">
        <div className="mb-1 flex items-start justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight text-zinc-100">
            {game.name}
          </h3>
          {game.verified ? (
            <span
              title="Reviewed by Streamlock"
              className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300"
            >
              <BadgeCheck className="h-3 w-3" />
              Verified
            </span>
          ) : null}
        </div>
        <p className="mb-2 text-xs text-zinc-500">by {game.operator}</p>
        <p className="mb-4 text-sm text-zinc-400">{game.tagline}</p>
        <p className="mb-4 text-xs leading-relaxed text-zinc-500">
          {game.description}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {game.tags.map((tag) => (
            <span
              key={tag}
              className="rounded border border-zinc-800 bg-zinc-900/60 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500"
            >
              {tag}
            </span>
          ))}
        </div>
        <div className="mt-4 text-xs font-medium text-orange-400 group-hover:text-orange-300">
          Play →
        </div>
      </div>
    </>
  );

  if (isExternal) {
    return (
      <a href={game.href} target="_blank" rel="noopener noreferrer" className={cardClass}>
        {inner}
      </a>
    );
  }
  return (
    <Link to={game.href ?? "/"} className={cardClass}>
      {inner}
    </Link>
  );
}

function Section({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={className}>{children}</section>;
}

export function Explore() {
  return (
    <div className="games-hub px-5 py-10 md:px-8 md:py-12">
      <h1 className="text-3xl font-semibold tracking-tight text-zinc-100 md:text-4xl">
        Games
      </h1>

      <div className="mt-8 space-y-12 md:space-y-16">
        <Section>
          <div className="mb-6 flex items-baseline justify-between">
            <h2 className="text-lg font-semibold tracking-tight text-zinc-100">
              Explore games
            </h2>
            <span className="text-xs text-zinc-500">
              {PLAYABLE_GAMES.length}{" "}
              {PLAYABLE_GAMES.length === 1 ? "game" : "games"}
            </span>
          </div>

          {PLAYABLE_GAMES.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-900/30 p-10 text-center">
              <p className="text-sm text-zinc-400">No games yet. Check back soon.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
              {PLAYABLE_GAMES.map((game) => (
                <GameCard key={game.slug} game={game} />
              ))}
            </div>
          )}
        </Section>

        <Section className="rounded-xl border border-orange-500/20 bg-gradient-to-br from-orange-500/5 to-zinc-900/40 p-6 md:p-8">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-orange-400">
            For builders
          </div>
          <h2 className="mb-3 text-xl font-semibold tracking-tight text-zinc-100 md:text-2xl">
            Build a game on Streamlock
          </h2>
          <p className="mb-5 max-w-2xl text-sm leading-relaxed text-zinc-400">
            Any operator can run a game on top of a Streamlock token. The protocol
            handles the wagering, settlement, and disputes. You bring the gameplay.
          </p>
          <div className="flex flex-wrap gap-3">
            <a
              href="https://app.streamlock.fun/how-it-works"
              className="rounded-xl bg-orange-500 px-4 py-2 text-sm font-medium text-zinc-950 transition-colors hover:bg-orange-400"
            >
              How it works
            </a>
            <a
              href="mailto:streamlockfun@gmail.com?subject=Building%20a%20game%20on%20Streamlock"
              className="rounded-xl px-4 py-2 text-sm font-medium text-zinc-300 ring-1 ring-white/10 transition-colors hover:bg-zinc-800"
            >
              Get in touch
            </a>
          </div>
        </Section>
      </div>
    </div>
  );
}
