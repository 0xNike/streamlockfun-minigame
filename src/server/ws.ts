/**
 * WebSocket route /ws/match/:id?as=a|b
 *
 * Looks up the live match, attaches the socket to the slot, and forwards
 * inbound frames to LiveMatch.receiveFrame. Handles ping/pong heartbeats here
 * to keep matches.ts focused on game logic.
 */

import fastifyWebsocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import { getLive } from "./matches.js";
import type { ServerFrame, Side } from "./types.js";

const HEARTBEAT_MS = 15_000;

export async function registerWs(app: FastifyInstance): Promise<void> {
  await app.register(fastifyWebsocket);

  app.get<{ Params: { id: string }; Querystring: { as?: string } }>(
    "/ws/match/:id",
    { websocket: true },
    (socket, req) => {
      const matchId = req.params.id;
      const as = req.query.as;
      const log = req.log.child({ matchId, as });

      if (as !== "a" && as !== "b") {
        socket.send(
          JSON.stringify({
            type: "error",
            ts: Math.floor(Date.now() / 1000),
            code: "BAD_FRAME",
            message: "Missing or invalid ?as=a|b",
            fatal: true,
          } satisfies ServerFrame),
        );
        socket.close(1008, "bad query");
        return;
      }
      const side = as as Side;

      const match = getLive(matchId);
      if (!match) {
        socket.send(
          JSON.stringify({
            type: "error",
            ts: Math.floor(Date.now() / 1000),
            code: "MATCH_NOT_FOUND",
            message: `no live match ${matchId}`,
            fatal: true,
          } satisfies ServerFrame),
        );
        socket.close(1008, "match not found");
        return;
      }

      const attached = match.attachSocket(side, socket);
      if (!attached) return;

      log.info("ws.connect");

      const pingInterval = setInterval(() => {
        if (socket.readyState !== socket.OPEN) return;
        socket.send(
          JSON.stringify({ type: "ping", ts: Math.floor(Date.now() / 1000) } satisfies ServerFrame),
        );
      }, HEARTBEAT_MS);

      socket.on("message", (raw: Buffer) => {
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          log.warn("ws.bad_json");
          return;
        }
        match.receiveFrame(side, msg);
      });

      socket.on("close", (code: number, reason: Buffer) => {
        clearInterval(pingInterval);
        match.detachSocket(side, code, reason.toString());
      });

      socket.on("error", (err: Error) => {
        log.error({ err }, "ws.error");
      });
    },
  );
}
