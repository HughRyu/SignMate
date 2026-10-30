import test from "node:test";
import assert from "node:assert/strict";
import TiebaDriver from "../src/drivers/tieba.js";

function driver(payload, status = 200) {
  const d = new TiebaDriver({ key: "baidu-tieba" }, { "baidu-tieba": { cookie: "BDUSS=test" } });
  d.apiGet = async url => {
    assert.equal(url, "https://tieba.baidu.com/mo/q/newmoindex");
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });
  };
  return d;
}

test("only explicit logged-out identity confirms expired credentials", async () => {
  assert.equal((await driver({ no: 1, data: { is_login: 0, tbs: "test" } }).validateLogin("test")).failureType, "auth_expired");
  assert.equal((await driver({ no: 1 }).validateLogin("test")).failureType, "unconfirmed");
  assert.equal((await driver({ no: 0, data: { uid: 123 } }).validateLogin("test")).failureType, "unconfirmed");
  assert.equal((await driver("<title>安全验证</title>").validateLogin("test")).failureType, "challenge");
});

test("mobile account identity and tbs establish login without legacy tbs endpoint", async () => {
  const d = driver({ no: 0, data: { uid: 123, tbs: "test", like_forum: [] } });
  assert.equal((await d.validateLogin("test")).ok, true);
  for (const payload of [{ no: 0, data: { uid: 0, tbs: "test" } }, { no: 0, data: { uid: 123 } }, { no: 1 }, "<title>安全验证</title>"]) {
    assert.equal((await driver(payload).validateLogin("test")).ok, false);
  }
});

test("uses authenticated mobile list, preserves Unicode, deduplicates forums", async () => {
  const d = driver({ no: 0, data: { like_forum: [{ forum_name: "测试吧" }, { forum_name: "开发 & 技术" }, { forum_name: "测试吧" }] } });
  assert.deepEqual(await d.getForumList("test"), ["测试吧", "开发 & 技术"]);
});

test("does not sign when the mobile list is blocked, malformed or logged out", async () => {
  for (const payload of ["<title>百度安全验证</title>", { no: 1 }, { no: null, data: { like_forum: [] } }, { no: 0, data: {} }, { no: 0, data: { like_forum: [{ forum_name: "" }] } }]) {
    const d = driver(payload);
    d.validateLogin = async () => ({ ok: true, tbs: "test" });
    d.signForum = async () => assert.fail("must not sign without a validated list");
    await assert.rejects(d.signIn());
  }
});

test("HTTP list failure and empty followed list cannot report success", async () => {
  await assert.rejects(driver({}, 503).getForumList("test"), /503/);
  const d = driver({ no: 0, data: { like_forum: [] } });
  d.validateLogin = async () => ({ ok: true, tbs: "test" });
  assert.equal((await d.signIn()).success, false);
});

test("signs every returned forum and accounts for already signed responses", async () => {
  const d = driver({ no: 0, data: { like_forum: [{ forum_name: "一" }, { forum_name: "二" }] } });
  d.validateLogin = async () => ({ ok: true, tbs: "test" });
  const names = [];
  d.signForum = async (_cookie, name) => { names.push(name); return { code: name === "一" ? "0" : "160002" }; };
  const result = await d.signIn();
  assert.equal(result.success, true);
  assert.deepEqual(names, ["一", "二"]);
  assert.equal(result.details.totalForums, 2);
});
