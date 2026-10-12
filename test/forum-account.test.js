import test from "node:test";
import assert from "node:assert/strict";
import { parseForumAccount, parseLinuxWallet } from "../src/utils/forum-account.js";
import Driver from "../src/drivers/forum-visit.js";

const linux = `<div data-home-keyword-filter-user-id="42"></div><a href="/logout">退出</a>
<aside><div class="sidebar-card user-card"><a class="user-name" href="/user/42">Demo &amp; User</a>
<div class="user-rank">积分 1,234</div><a href="/community_wallet">我的烧饼</a></div></aside>`;
const stat = (label, value) => `<a class="user-stat"><span class="user-stat-label">${label}</span><span class="user-stat-value">${value}</span></a>`;
test("account extraction excludes community totals and preserves zero balances", () => {
  const html = `<main>${stat("烧饼", "999999")}</main><aside><div class="sidebar-card user-card">
  <a class="user-name" href="/u/42/">Demo</a><div class="user-rank"><span class="post-user-level">Lv.1 初来乍到</span> 会员</div>
  ${stat("烧饼", "1,056")}${stat("成长值", "28")}${stat("存款", "0")}${stat("游戏币", "0")}${stat("注册天数", "52")}${stat("帖子", "0")}</div>
  <div class="stats-card">${stat("烧饼", "999999")}</div></aside>`;
  const { details, walletUrl } = parseForumAccount(html, "https://sb.sb/");
  assert.deepEqual(details, { username: "Demo", levelTitle: "Lv.1 初来乍到", totalCoins: 1056, totalExp: 28, bankBalance: 0, gameCoins: 0, joinDays: 52, postCount: 0 });
  assert.equal(walletUrl, null);
});
test("Linux account identity, entity decoding and wallet path are scoped", () => {
  assert.deepEqual(parseForumAccount(linux, "https://linux.sb/"), { details: { username: "Demo & User", totalPoints: 1234 }, walletUrl: "https://linux.sb/community_wallet" });
  for (const html of [linux.replace('/user/42', '/user/43'), linux.replace('/user/42', 'https://evil.invalid/user/42'), `<script>${linux}</script>`]) {
    assert.deepEqual(parseForumAccount(html, "https://linux.sb/").details, {});
  }
  assert.equal(parseForumAccount(linux.replace('1,234', 'unknown'), "https://linux.sb/").details.totalPoints, undefined);
});
test("wallet parser ignores unrelated totals and does not invent missing values", () => {
  assert.equal(parseLinuxWallet('<p>烧饼 999999</p><div class="community-wallet-balance"><small>可用余额</small><strong>&#129479;0</strong><span>烧饼</span></div>'), 0);
  assert.equal(parseLinuxWallet('<p>可用余额 999</p>'), null);
  assert.equal(parseLinuxWallet('<div class="community-wallet-balance">可用余额<strong>unknown</strong></div>'), null);
});
function driver(verifyOnly = false) {
  return new Driver({ key: "linux-sb", base_url: "https://linux.sb/", verify_only: verifyOnly }, { "linux-sb": { cookie: "fixture=only" } });
}
test("wallet collection is optional, same-origin and cannot invalidate a successful visit", async () => {
  for (const wallet of [new Response("", { status: 503 }), new Response("", { status: 302, headers: { location: "https://evil.invalid" } }), new Response('<title>Just a moment...</title>'), new Error("network")]) {
    const d = driver(); const urls = [];
    d.fetchPage = async url => { urls.push(url); if (urls.length === 1) return new Response(linux); if (wallet instanceof Error) throw wallet; return wallet; };
    const result = await d.signIn();
    assert.equal(result.success, true);
    assert.equal(result.details.totalPoints, 1234);
    assert.equal(result.details.totalCoins, undefined);
    assert.deepEqual(urls, ['https://linux.sb/', 'https://linux.sb/community_wallet']);
  }
});
test("authenticated wallet fills balance; session-only verification skips extra requests", async () => {
  for (const verifyOnly of [false, true]) {
    const d = driver(verifyOnly); let calls = 0;
    d.fetchPage = async () => new Response(++calls === 1 ? linux : '<a href="/logout">退出</a><div class="community-wallet-balance">可用余额<strong>🧇12.5</strong></div>');
    const result = await d.signIn();
    assert.equal(result.details.totalCoins, verifyOnly ? undefined : 12.5);
    assert.equal(calls, verifyOnly ? 1 : 2);
  }
});
