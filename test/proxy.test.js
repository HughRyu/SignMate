import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { testDirect, chooseProbeRoute } from "../src/utils/proxy.js";
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

test("homepage HTTP denial does not block a working authenticated API route", () => {
  const denied = { ok: false, reachable: true, status: 403 };
  assert.equal(chooseProbeRoute(denied, denied), "direct");
  assert.equal(chooseProbeRoute(denied, denied, "proxy"), "proxy");
  assert.equal(chooseProbeRoute(denied, { ok: true }), "proxy");
  assert.equal(chooseProbeRoute({ ok: false }, denied), "proxy");
  assert.equal(chooseProbeRoute({ ok: false }, { ok: false }), "offline");
});
