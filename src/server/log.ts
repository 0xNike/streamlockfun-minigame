import { pino } from "pino";
import { config } from "./config.js";

const isDev = config.NODE_ENV !== "production";

/** Strip bearer material from a logged URL (the match WS carries ?token=). */
export function redactUrl(url: string | undefined): string | undefined {
  return url?.replace(/([?&](?:token|access_token)=)[^&#]*/gi, "$1[redacted]");
}

// Fastify merges these over its defaults, so request logs never carry tokens.
const serializers = {
  req(req: { method?: string; url?: string; hostname?: string; ip?: string; socket?: { remotePort?: number } }) {
    return {
      method: req.method,
      url: redactUrl(req.url),
      hostname: req.hostname,
      remoteAddress: req.ip,
      remotePort: req.socket?.remotePort,
    };
  },
};

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { svc: "minigame-operator" },
  serializers,
  redact: { paths: ["req.headers.authorization", "headers.authorization", "token"], censor: "[redacted]" },
  ...(isDev
    ? {
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "HH:MM:ss.l",
            ignore: "pid,hostname,svc",
            singleLine: false,
          },
        },
      }
    : {}),
});

export type Logger = typeof logger;
