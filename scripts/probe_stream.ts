import { op } from "../src/operator.js";

(async () => {
  const cases: { streamId: string; holder: string }[] = [
    {
      streamId: "7d52c367ede10318fc9bbb491086e43b1c1d5ff5c96373bccdb48961e4fcf6d1",
      holder: "fJ9KSsCQSTHgF1yP1SnNprzHv4G6LCLvJKuA64taAWP",
    },
    {
      streamId: "8f43c79bf10b1cd18872fd5153ea20440363f0185e928b3f4b9d6ec376972980",
      holder: "B1Ay87xx2k7v4VB78V5gc2CuQsvWRZ4HEh12ubhLz2fx",
    },
  ];
  for (const c of cases) {
    console.log("\n=== entitlement", c.streamId.slice(0, 12), "===");
    try {
      console.log(JSON.stringify(await op.streams.entitlement(c.streamId, c.holder), null, 2).slice(0, 1500));
    } catch (e) {
      console.error("err:", e instanceof Error ? e.message : e);
    }
    console.log("\n=== claimStatus", c.streamId.slice(0, 12), "===");
    try {
      console.log(JSON.stringify(await op.streams.claimStatus(c.streamId, c.holder), null, 2));
    } catch (e) {
      console.error("err:", e instanceof Error ? e.message : e);
    }
  }
})();
