/**
 * Pre-launch check: send one test alert through the same path as dispute
 * alerts (error log line + Telegram), using the same env vars as the server:
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_ALERT_CHAT_ID=... npx tsx scripts/test-alert.ts
 * Exits 1 if Telegram isn't configured or the message wasn't delivered.
 */
import { alertOnce } from "../src/server/alerts.js";

void (async () => {
  const ok = await alertOnce("test", String(Date.now()), "Test alert: games dispute alerts are wired up.");
  console.log(ok ? "telegram: delivered" : "telegram: NOT delivered (check TELEGRAM_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID)");
  process.exit(ok ? 0 : 1);
})();
