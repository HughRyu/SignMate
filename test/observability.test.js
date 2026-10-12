import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("site results carry duration and CookieCloud sync marks verification pending", () => {
  const runner = fs.readFileSync("src/runner.js", "utf8");
  const server = fs.readFileSync("src/server.js", "utf8");
  assert.match(runner, /durationMs: Date\.now\(\) - executionStartedAt/);
  assert.match(server, /cookiecloud_verification: "pending"/);
});
