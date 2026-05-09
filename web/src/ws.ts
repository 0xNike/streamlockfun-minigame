/**
 * Typed WebSocket client.
 * Auto-reconnects on close (unless closed with `manualClose=true`),
 * with exponential backoff capped at 5s.
 */

import type { ClientFrame, ServerFrame } from "./types";

export type WsHandler = (frame: ServerFrame) => void;

export interface WsClient {
  send(frame: ClientFrame): void;
  close(): void;
  url: string;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5_000;

export function openWs(absoluteOrPath: string, onFrame: WsHandler, onStatus?: (s: "open" | "close" | "error", info?: unknown) => void): WsClient {
  const wsUrl = absoluteOrPath.startsWith("ws")
    ? absoluteOrPath
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${absoluteOrPath}`;

  let ws: WebSocket | null = null;
  let manualClose = false;
  let attempt = 0;

  function connect() {
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      attempt = 0;
      onStatus?.("open");
    };
    ws.onmessage = (e) => {
      let frame: ServerFrame;
      try {
        frame = JSON.parse(e.data) as ServerFrame;
      } catch {
        return;
      }
      if (frame.type === "ping") {
        ws?.send(JSON.stringify({ type: "pong" } satisfies ClientFrame));
        return;
      }
      onFrame(frame);
    };
    ws.onerror = (e) => onStatus?.("error", e);
    ws.onclose = (e) => {
      onStatus?.("close", { code: e.code, reason: e.reason });
      if (manualClose) return;
      if (e.code === 1008) return; // policy violation: don't reconnect
      attempt += 1;
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
      setTimeout(connect, delay);
    };
  }

  connect();

  return {
    url: wsUrl,
    send(frame) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(frame));
    },
    close() {
      manualClose = true;
      ws?.close(1000, "client done");
    },
  };
}
