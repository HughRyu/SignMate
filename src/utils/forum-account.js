import { parse } from "parse5";

function* nodes(node) {
  if (!node || ["script", "style", "template"].includes(node.tagName)) return;
  yield node;
  for (const child of node.childNodes || []) yield* nodes(child);
}
const attr = (node, name) => node?.attrs?.find(item => item.name === name)?.value || "";
const hasClass = (node, name) => attr(node, "class").split(/\s+/).includes(name);
const findClass = (node, name) => [...nodes(node)].find(item => hasClass(item, name));
const text = node => [...nodes(node)].filter(item => item.nodeName === "#text").map(item => item.value).join("").replace(/\s+/g, " ").trim();
function number(value) {
  const source = String(value).trim().replace(/，/g, ",");
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(source)) return null;
  const parsed = Number(source.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

// Only the authenticated sidebar account card is eligible. Never infer an
// account balance from topic text, public user lists or community totals.
export function parseForumAccount(html, baseUrl) {
  const base = new URL(baseUrl);
  const empty = { details: {}, walletUrl: null };
  if (!["linux.sb", "sb.sb"].includes(base.hostname)) return empty;
  const document = parse(html);
  const aside = [...nodes(document)].filter(node => node.tagName === "aside");
  const card = aside.flatMap(node => [...nodes(node)]).find(node => hasClass(node, "user-card") && hasClass(node, "sidebar-card"));
  if (!card) return empty;
  const name = findClass(card, "user-name");
  let profile;
  try { profile = new URL(attr(name, "href"), base); } catch { return empty; }
  if (profile.origin !== base.origin || !/^\/(?:user|u)\/[1-9]\d*\/?$/.test(profile.pathname)) return empty;
  const username = text(name).slice(0, 80);
  if (!username) return empty;
  if (base.hostname === "linux.sb") {
    const identity = [...nodes(document)].map(node => attr(node, "data-home-keyword-filter-user-id")).find(Boolean);
    if (identity && profile.pathname.split("/")[2] !== identity) return empty;
  }
  const details = { username };
  const rank = findClass(card, "user-rank");
  const levelTitle = text(findClass(rank, "post-user-level"));
  if (levelTitle) details.levelTitle = levelTitle.slice(0, 80);
  const fields = { "烧饼": "totalCoins", "成长值": "totalExp", "存款": "bankBalance", "游戏币": "gameCoins", "帖子": "postCount", "精华": "featuredCount", "关注": "followingCount", "粉丝": "followersCount", "注册天数": "joinDays" };
  for (const item of nodes(card)) {
    if (!hasClass(item, "user-stat")) continue;
    const key = fields[text(findClass(item, "user-stat-label"))];
    const value = number(text(findClass(item, "user-stat-value")));
    if (key && value !== null) details[key] = value;
  }
  if (base.hostname === "linux.sb") {
    const points = text(rank).match(/(?:^|\s)积分\s+([\d,，]+(?:\.\d+)?)(?:\s|$)/)?.[1];
    if (points && number(points) !== null) details.totalPoints = number(points);
  }
  const wallet = [...nodes(card)].find(node => node.tagName === "a" && attr(node, "href") === "/community_wallet");
  return { details, walletUrl: base.hostname === "linux.sb" && wallet ? new URL("/community_wallet", base).href : null };
}

export function parseLinuxWallet(html) {
  const balance = findClass(parse(html), "community-wallet-balance");
  if (!balance || !text(balance).includes("可用余额")) return null;
  const amount = [...nodes(balance)].find(node => node.tagName === "strong");
  return number(text(amount).replace(/^🧇\s*/, ""));
}
