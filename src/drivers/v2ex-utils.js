export function alreadyRedeemed(body = "") {
  return /already redeemed|每日登录奖励\s*已领取|Daily login reward already redeemed/i.test(body);
}

function decodeHtmlEntities(value = "") {
  return String(value)
    .replace(/&amp;/gi, "&")
    .replace(/&#38;?/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function redeemCandidate(value = "") {
  const text = decodeHtmlEntities(value);
  const match = text.match(/(?:https?:\/\/[^"'<>\s)]+)?\/mission\/daily\/redeem\?once=[^"'<>\s)]+/i);
  return match?.[0] || text;
}

export function isV2EXDailyRedeemHref(href = "", origin = "https://www.v2ex.com") {
  try {
    const base = new URL(origin);
    const url = new URL(redeemCandidate(href), base);
    const sameV2EXHost = ["www.v2ex.com", "v2ex.com"].includes(url.hostname)
      && ["www.v2ex.com", "v2ex.com"].includes(base.hostname);
    return sameV2EXHost
      && url.pathname.replace(/\/+$/, "") === "/mission/daily/redeem"
      && url.searchParams.has("once");
  } catch {
    return false;
  }
}

export function findV2EXDailyRedeemHref(values = [], origin = "https://www.v2ex.com") {
  for (const value of values) {
    const candidate = redeemCandidate(value);
    if (isV2EXDailyRedeemHref(candidate, origin)) return candidate;
  }
  return "";
}

export function collectV2EXDailyRedeemCandidates(html = "") {
  const source = String(html || "");
  const values = [];
  for (const match of source.matchAll(/\b(?:href|action|data-href|data-url)\s*=\s*["']([^"']+)["']/gi)) values.push(match[1]);
  for (const match of source.matchAll(/\bonclick\s*=\s*["']([^"']+)["']/gi)) values.push(match[1]);
  values.push(...(source.match(/\/?mission\/daily\/redeem\?once=[^"' <>)]*/gi) || []));
  return values;
}

export function hasTodayLoginReward(stats = {}) {
  return Number.isFinite(stats.rewardCopper);
}

export function confirmedV2EXDailyReward(body = "", stats = {}) {
  return alreadyRedeemed(body) || hasTodayLoginReward(stats);
}
