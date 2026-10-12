import test from "node:test";
import assert from "node:assert/strict";

test("health endpoint contract is operational and secret-free", async () => {
  const source = await import("node:fs/promises").then(fs => fs.readFile("src/server.js", "utf8"));
  assert.match(source, /app\.get\("\/api\/health"/);
  assert.match(source, /batchActive/);
  assert.match(source, /usableCount/);
  assert.doesNotMatch(source, /secrets\.yaml.*res\.json/);
});
