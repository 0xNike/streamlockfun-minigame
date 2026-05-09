const WebSocket = require("ws");
const http = require("http");

const HOST = "127.0.0.1:8787";

function post(path, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: 8787, path, method: "POST", headers: { "content-type": "application/json" } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data && JSON.parse(data) }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

(async () => {
  const create = await post("/api/matches", {
    wallet: "FakeProbeWalletA111111111111111111111111111",
    streamId: "FakeProbeStreamA111111111111111111111111111",
  });
  console.log("[create]", create.status, create.body.matchId);

  const matchId = create.body.matchId;
  const wsA = new WebSocket(`ws://${HOST}/ws/match/${matchId}?as=a`);
  const wsB = new WebSocket(`ws://${HOST}/ws/match/${matchId}?as=b`);

  const collected = { a: [], b: [] };
  wsA.on("message", (m) => {
    const f = JSON.parse(m.toString());
    if (f.type === "ping") return;
    collected.a.push(f);
    console.log("[A]", f.type, f.state || f.code || f.kind || "");
  });
  wsB.on("message", (m) => {
    const f = JSON.parse(m.toString());
    if (f.type === "ping") return;
    collected.b.push(f);
    console.log("[B]", f.type, f.state || f.code || f.kind || "");
  });
  wsA.on("error", (e) => console.error("[A.err]", e.message));
  wsB.on("error", (e) => console.error("[B.err]", e.message));

  await new Promise((r) => setTimeout(r, 500));

  // B joins via HTTP — this should kick off on-chain create which will fail
  // because FakeProbe streams don't exist. We expect: state=creating,
  // tx kind=create attempt=1 status=failed → state=failed → frame failed.
  const join = await post(`/api/matches/${matchId}/join`, {
    wallet: "FakeProbeWalletB111111111111111111111111111",
    streamId: "FakeProbeStreamB111111111111111111111111111",
  });
  console.log("[join]", join.status, join.body);

  // Wait long enough for the create attempt + retry to finish
  await new Promise((r) => setTimeout(r, 8000));

  console.log("\n=== summary ===");
  console.log(
    "A states observed:",
    collected.a
      .filter((f) => f.type === "state" || f.type === "tx" || f.type === "failed" || f.type === "hello")
      .map((f) => `${f.type}(${f.state || f.kind || f.reason || ""})${f.status ? "/" + f.status : ""}`),
  );

  wsA.close();
  wsB.close();
  process.exit(0);
})();
