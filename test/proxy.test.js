import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { testDirect } from "../src/utils/proxy.js";
test("real HTTP probes reject denied/error pages and retry HEAD using GET", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/fallback") res.statusCode = req.method === "HEAD" ? 405 : 200;
    else res.statusCode = Number(req.url.slice(1));
    res.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await testDirect(`${base}/200`)).diagnosis, "http_reachable_auth_unverified");
    assert.equal((await testDirect(`${base}/403`)).ok, false);
    assert.equal((await testDirect(`${base}/500`)).ok, false);
    assert.equal((await testDirect(`${base}/fallback`)).ok, true);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
