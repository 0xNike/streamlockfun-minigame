import { op, GAME_TOKEN_MINT } from "../src/operator.js";

(async () => {
  const r = await op.tokens.streams(GAME_TOKEN_MINT);
  console.log(JSON.stringify(r, null, 2));
})();
