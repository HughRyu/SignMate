import test from "node:test";
import assert from "node:assert/strict";
import { cardMetricLimit, cardMetricOptions, defaultCardMetrics, selectedCardMetrics, validCardMetricSelection } from "../src/utils/card-metrics.js";

test("all site kinds get selectable metrics; personal and unknown fields stay off by default", () => {
  for (const key of ["linux-sb", "sb-sb", "v2ex", "audiences-me", "custom-site"]) {
    const options = cardMetricOptions({ username: "PrivateName", email: "private@example.invalid", userId: 12, totalPoints: 0, totalDays: 7, bonus: "12.5", customMetric: 9, cookie: "secret", csrfToken: "secret", nested: { count: 1 }, rawStatsText: "raw", proxyReason: "internal", runId: "internal" }, key);
    assert.ok(options.some(item => item.key === "username"));
    assert.ok(options.some(item => item.key === "customMetric"));
    assert.ok(!options.some(item => ["cookie", "csrfToken", "nested", "rawStatsText", "proxyReason", "runId"].includes(item.key)));
    const defaults = defaultCardMetrics(options, key);
    assert.ok(defaults.includes("totalPoints"));
    assert.ok(!defaults.some(item => ["username", "email", "userId", "customMetric"].includes(item)));
    assert.ok(defaults.length <= 4);
    assert.equal(validCardMetricSelection(["username", "customMetric"], options), true);
  }
});
test("preferences permit four unique available fields, zero fields and omitted values without losing choices", () => {
  const options = cardMetricOptions({ totalCoins: 0, levelTitle: "Lv.1", totalExp: 28, joinDays: 52, username: "private" }, "sb-sb");
  assert.deepEqual(defaultCardMetrics(options, "sb-sb"), ["totalCoins", "levelTitle", "totalExp", "joinDays"]);
  for (const invalid of [["username", "username"], ["cookie"], ["missing"], options.map(item => item.key), null, "username"])
    assert.equal(validCardMetricSelection(invalid, options), false);
  assert.equal(validCardMetricSelection([], options), true);
  assert.deepEqual(selectedCardMetrics([], options), []);
  assert.deepEqual(selectedCardMetrics(["username", "totalCoins"], [], "sb-sb"), ["username", "totalCoins"]);
  assert.deepEqual(selectedCardMetrics(["cookie", "username"], options), ["username"]);
  assert.deepEqual(defaultCardMetrics(cardMetricOptions({ username: "private", totalPoints: 900, totalCoins: 0 }, "linux-sb"), "linux-sb"), ["totalPoints", "totalCoins"]);
});

test("signin limits defaults, legacy selections and writes to two; keepalive retains four", () => {
  const options = cardMetricOptions({ totalPoints: 580, userGroup: "中级会员", totalDays: 8, streakDays: 2 }, "naixi");
  assert.equal(cardMetricLimit({ kind: "signin", category: "pt" }), 2);
  assert.equal(cardMetricLimit({ kind: "visit" }), 4);
  assert.deepEqual(defaultCardMetrics(options, "naixi", 2), ["userGroup", "totalPoints"]);
  assert.deepEqual(selectedCardMetrics(["userGroup", "totalPoints", "totalDays", "streakDays"], options, "naixi", 2), ["userGroup", "totalPoints"]);
  assert.equal(validCardMetricSelection(["userGroup", "totalPoints", "totalDays"], options, 2), false);
  assert.equal(validCardMetricSelection(options.map(item => item.key), options, 4), true);
});
