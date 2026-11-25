/**
 * Ops alerts. Every alert is logged at error level with an `ALERT.<kind>`
 * event (grep-able in Fly logs) and, when TELEGRAM_BOT_TOKEN and
 * TELEGRAM_ALERT_CHAT_ID are set, sent to that Telegram chat.
 *
 * Alerts are de-duplicated per (kind, key) for the life of the process, so a
 * poller can call them every cycle. After a restart an open dispute alerts
 * once more, which is intended.
 */

import { config } from "./config.js";
import { logger } from "./log.js";

const sent = new Set<string>();

export type AlertKind = "dispute_opened" | "arbiter_sla_at_risk";

export async function alertOnce(kind: AlertKind, key: string, text: string, fields: Record<string, unknown> = {}): Promise<void> {
  const id = `${kind}:${key}`;
  if (sent.has(id)) return;
  sent.add(id);
  logger.error({ alert: kind, key, ...fields }, `ALERT.${kind} ${text}`);
  if (!config.TELEGRAM_BOT_TOKEN || !config.TELEGRAM_ALERT_CHAT_ID) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.TELEGRAM_ALERT_CHAT_ID, text: `[games] ${text}`, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) logger.warn({ kind, status: res.status }, "alert.telegram_failed");
  } catch (err) {
    logger.warn({ kind, err: err instanceof Error ? err.message : String(err) }, "alert.telegram_failed");
  }
}

export function alertDisputeOpened(args: {
  sessionId: string;
  pda: string;
  /** "a" / "b" when the server relayed it; "unknown" when seen on chain. */
  side: string;
  source: string;
  disputeEndTs?: number;
}): void {
  const end = args.disputeEndTs ? new Date(args.disputeEndTs * 1000).toISOString() : "unknown";
  void alertOnce(
    "dispute_opened",
    args.sessionId,
    `Dispute opened on match ${args.sessionId} by side ${args.side} (session ${args.pda}). ` +
      `Arbiter can resolve after dispute end ${end}; SLA is 48 h after that.`,
    { sessionId: args.sessionId, pda: args.pda, side: args.side, source: args.source, disputeEndTs: args.disputeEndTs },
  );
}

export function alertArbiterSla(args: { sessionId: string; pda: string; disputeEndTs: number }): void {
  const hours = Math.floor((Date.now() / 1000 - args.disputeEndTs) / 3600);
  void alertOnce(
    "arbiter_sla_at_risk",
    args.sessionId,
    `Dispute on match ${args.sessionId} (session ${args.pda}) still unresolved ${hours} h after dispute end (SLA 48 h).`,
    { sessionId: args.sessionId, pda: args.pda, disputeEndTs: args.disputeEndTs },
  );
}
