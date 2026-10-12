import { parse } from "parse5";
function* nodes(node) {
  if (!node || ["script", "style", "template"].includes(node.tagName)) return;
  yield node;
  for (const child of node.childNodes || []) yield* nodes(child);
}
const attr = (node, key) => node?.attrs?.find(item => item.name === key)?.value || "";
const text = node => [...nodes(node)].filter(item => item.nodeName === "#text").map(item => item.value).join("").replace(/\s+/g, " ").trim();
export function parseNaixiAccount(html, baseUrl = "https://forum.naixi.net") {
  const document = parse(String(html || ""));
  const title = [...nodes(document)].find(node => node.tagName === "title");
  if (/just a moment|安全验证|人机验证|登录|captcha/i.test(text(title))) return {};
  const menu = [...nodes(document)].find(node => attr(node, "id") === "comiis_user_menu");
  if (!menu) return {};
  const origin = new URL(baseUrl).origin;
  const links = [...nodes(menu)].filter(node => node.tagName === "a").map(node => {
    try { const url = new URL(attr(node, "href"), baseUrl); return url.origin === origin ? { node, url } : null; }
    catch { return null; }
  }).filter(Boolean);
  if (!links.some(({ url }) => url.pathname === "/member.php" && url.searchParams.get("mod") === "logging" && url.searchParams.get("action") === "logout")) return {};
  const field = ac => links.find(({ url }) => url.pathname === "/home.php" && url.searchParams.get("mod") === "spacecp" && url.searchParams.get("ac") === ac)?.node;
  const userGroup = text(field("usergroup"));
  const pointsText = text(field("credit")).match(/^积分\s*[:：]\s*((?:\d{1,3}(?:[,，]\d{3})+|\d+))$/)?.[1];
  const totalPoints = pointsText === undefined ? null : Number(pointsText.replace(/[,，]/g, ""));
  return { ...(userGroup && userGroup.length <= 80 ? { userGroup } : {}), ...(Number.isSafeInteger(totalPoints) ? { totalPoints } : {}) };
}
// A failed optional read must never retry an already successful sign-in.
export async function readNaixiAccount(loadHtml, baseUrl) {
  try { return parseNaixiAccount(await loadHtml(), baseUrl); } catch { return {}; }
}
export function naixiAccountStep(account) {
  const found = account.userGroup !== undefined || account.totalPoints !== undefined;
  return { label: "读取账户等级与积分", ok: found, detail: found ? [account.userGroup, account.totalPoints !== undefined ? `积分 ${account.totalPoints}` : ""].filter(Boolean).join("；") : "账户信息暂不可用，不影响已确认的签到结果" };
}
