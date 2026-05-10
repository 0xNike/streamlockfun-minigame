import { Route, Routes, Link } from "react-router-dom";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Home } from "./pages/Home";
import { Match } from "./pages/Match";
import { WorldIdProvider } from "./worldid";

export function App() {
  return (
    <WorldIdProvider>
      <div className="app">
        <header className="header">
          <Link to="/" className="brand">
            ✊ RPS — Streamlock devnet
          </Link>
          <WalletMultiButton />
        </header>
        <main>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/match/:id" element={<Match />} />
          </Routes>
        </main>
        <footer className="footer">
          <span className="dim">Stake 10% of the loser's stream per match · Best of 3</span>
        </footer>
      </div>
    </WorldIdProvider>
  );
}
