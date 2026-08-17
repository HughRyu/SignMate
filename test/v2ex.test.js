import assert from "node:assert/strict";
import test from "node:test";
import {
  alreadyRedeemed,
  collectV2EXDailyRedeemCandidates,
  confirmedV2EXDailyReward,
  findV2EXDailyRedeemHref,
  hasTodayLoginReward,
  isV2EXDailyRedeemHref,
} from "../src/drivers/v2ex-utils.js";

test("accepts same-site V2EX redeem URLs from links, onclick, and HTML", () => {
  assert.equal(isV2EXDailyRedeemHref("https://www.v2ex.com/mission/daily/redeem?once=abc", "https://www.v2ex.com"), true);
  assert.equal(isV2EXDailyRedeemHref("/mission/daily/redeem?once=abc", "https://www.v2ex.com"), true);
  assert.equal(isV2EXDailyRedeemHref("location.href='/mission/daily/redeem?once=abc'", "https://www.v2ex.com"), true);
  assert.equal(isV2EXDailyRedeemHref("https://v2ex.com/mission/daily/redeem?once=abc", "https://www.v2ex.com"), true);
  assert.equal(isV2EXDailyRedeemHref("https://ylscode.com/mission/daily/redeem?once=abc", "https://www.v2ex.com"), false);
  assert.equal(isV2EXDailyRedeemHref("https://www.v2ex.com/mission/daily/redeem", "https://www.v2ex.com"), false);
});

test("extracts redeem candidates without trusting promotional links", () => {
  const values = collectV2EXDailyRedeemCandidates(`
    <a href="https://ylscode.com/">领取</a>
    <button onclick="location.href='/mission/daily/redeem?once=real-token'">领取每日奖励</button>
  `);
  assert.equal(findV2EXDailyRedeemHref(values), "/mission/daily/redeem?once=real-token");
});

test("does not infer success from generic page text or balance totals", () => {
  assert.equal(hasTodayLoginReward({ totalGold: 8, totalSilver: 52, totalCopper: 85 }), false);
  assert.equal(confirmedV2EXDailyReward("广告 领取试用", { totalGold: 8, totalCopper: 85 }), false);
  assert.equal(alreadyRedeemed("Daily login reward already redeemed"), true);
  assert.equal(confirmedV2EXDailyReward("余额记录", { rewardCopper: 2 }), true);
});
