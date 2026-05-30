import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmedV2EXDailyReward,
  findV2EXDailyRedeemHref,
  hasTodayLoginReward,
  isV2EXDailyRedeemHref,
} from "../src/drivers/v2ex-utils.js";

test("only accepts same-origin V2EX daily redeem URLs", () => {
  assert.equal(isV2EXDailyRedeemHref("https://www.v2ex.com/mission/daily/redeem?once=abc", "https://www.v2ex.com"), true);
  assert.equal(isV2EXDailyRedeemHref("/mission/daily/redeem?once=abc", "https://www.v2ex.com"), true);
  assert.equal(isV2EXDailyRedeemHref("/mission/daily/redeem?once=abc&amp;foo=bar", "https://www.v2ex.com"), true);
  assert.equal(isV2EXDailyRedeemHref("location.href='/mission/daily/redeem?once=abc'", "https://www.v2ex.com"), true);
  assert.equal(isV2EXDailyRedeemHref("https://ylscode.com/", "https://www.v2ex.com"), false);
  assert.equal(isV2EXDailyRedeemHref("https://www.v2ex.com/mission/daily", "https://www.v2ex.com"), false);
  assert.equal(isV2EXDailyRedeemHref("https://www.v2ex.com/mission/daily/redeem", "https://www.v2ex.com"), false);
});

test("ignores promotional claim links when selecting redeem URL", () => {
  const href = findV2EXDailyRedeemHref([
    "https://ylscode.com/",
    "https://www.v2ex.com/balance",
    "https://www.v2ex.com/mission/daily/redeem?once=real-token",
  ], "https://www.v2ex.com");

  assert.equal(href, "https://www.v2ex.com/mission/daily/redeem?once=real-token");
});

test("does not infer V2EX success from generic HTTP success without reward confirmation", () => {
  assert.equal(hasTodayLoginReward({ totalGold: 8, totalSilver: 52, totalCopper: 85 }), false);
  assert.equal(confirmedV2EXDailyReward("ad landing page 领取试用", { totalGold: 8, totalSilver: 52, totalCopper: 85 }), false);
  assert.equal(confirmedV2EXDailyReward("每日登录奖励已领取", { totalGold: 8 }), true);
  assert.equal(confirmedV2EXDailyReward("balance page", { rewardCopper: 6, totalGold: 8 }), true);
});
