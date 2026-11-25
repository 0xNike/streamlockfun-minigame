/**
 * Who pays a new HolderSale PDA's rent (~0.0021 SOL, refunded to the payer by
 * close_holder_sale after the stream's ledger settles).
 *
 * RESERVE_RENT_PAYER=operator funds it so players with 0 SOL can play, up to
 * RESERVE_RENT_DAILY_CAP new accounts per rolling 24 h and
 * RESERVE_RENT_PER_WALLET_CAP accounts per wallet. Past a cap the player pays,
 * and join is refused up front if they can't (RESERVE_RENT_NEEDS_SOL).
 * An existing HolderSale needs no rent, so caps never apply to it.
 */

import { config } from "./config.js";
import { rentFundingCounts } from "./db.js";

/** Rent for the 171-byte HolderSale plus fee headroom, in lamports. */
export const PLAYER_RENT_NEED_LAMPORTS = 3_000_000;

export function operatorFundsNewHolderSale(wallet: string): boolean {
  if (config.RESERVE_RENT_PAYER !== "operator") return false;
  const { recent, wallet: mine } = rentFundingCounts(wallet, Math.floor(Date.now() / 1000) - 24 * 3600);
  if (config.RESERVE_RENT_DAILY_CAP > 0 && recent >= config.RESERVE_RENT_DAILY_CAP) return false;
  if (config.RESERVE_RENT_PER_WALLET_CAP > 0 && mine >= config.RESERVE_RENT_PER_WALLET_CAP) return false;
  return true;
}
