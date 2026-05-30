export function alreadyRedeemed(body = "") {
  return /already redeemed|每日登录奖励\s*已领取|Daily login reward already redeemed/i.test(body);
}

function redeemCandidate(value = "") {
  const text = String(value).replace(/&amp;/g, "&");
  const match = text.match(/(?:https?:\/\/[^"'<>\s)]+)?\/mission\/daily\/redeem\?once=[^"'<>\s)]+/i);
  return match?.[0] || text;
}

export function isV2EXDailyRedeemHref(href = "", origin = "https://www.v2ex.com") {
  try {
    const base = new URL(origin);
    const url = new URL(redeemCandidate(href), base);
    return url.origin === base.origin
      && url.pathname.replace(/\/+$/, "") === "/mission/daily/redeem"
      && url.searchParams.has("once");
  } catch {
    return false;
  }
}

export function findV2EXDailyRedeemHref(hrefs = [], origin = "https://www.v2ex.com") {
  return hrefs.find(href => isV2EXDailyRedeemHref(href, origin)) || "";
}

export function hasTodayLoginReward(stats = {}) {
  return Number.isFinite(stats.rewardCopper);
}

export function confirmedV2EXDailyReward(body = "", stats = {}) {
  return alreadyRedeemed(body) || hasTodayLoginReward(stats);
}
