import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { parseNaixiAccount, readNaixiAccount } from "../src/utils/naixi-account.js";
import { runDiscuzHttp } from "../src/utils/discuz-http.js";
import { accountHtml, signedPage, unsignedPage } from "./naixi-account-fixtures.js";

test("Naixi parses only authenticated same-origin account menu fields", async () => {
  assert.deepEqual(parseNaixiAccount('<article>高级会员 积分: 999999</article>' + accountHtml()), { userGroup: "中级会员", totalPoints: 571 });
  assert.equal(parseNaixiAccount(accountHtml("0")).totalPoints, 0);
  assert.equal(parseNaixiAccount(accountHtml("1,234")).totalPoints, 1234);
  assert.equal(parseNaixiAccount(accountHtml("unknown")).totalPoints, undefined);
  assert.equal(parseNaixiAccount(accountHtml("571", "中级 &amp; 会员")).userGroup, "中级 & 会员");
  for (const html of [accountHtml().replace('action=logout', 'action=login'), accountHtml().replace('id="comiis_user_menu"', 'id="public"'), '<title>Just a moment...</title>' + accountHtml(), `<script>${accountHtml()}</script>`]) assert.deepEqual(parseNaixiAccount(html), {});
  assert.equal(parseNaixiAccount(accountHtml().replace('/home.php?mod=spacecp&amp;ac=credit', 'https://other.invalid/home.php?mod=spacecp&amp;ac=credit')).totalPoints, undefined);
  assert.deepEqual(await readNaixiAccount(async () => { throw new Error("network"); }), {});
});

test("Naixi HTTP paths refresh post-sign totals and preserve success if account refresh fails", async () => {
  for (const scenario of ["already", "fresh", "refresh-failed"]) {
    const paths = []; let signed = scenario === "already";
    const server = createServer((req, res) => {
      paths.push(new URL(req.url, 'http://fixture.invalid').pathname);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      if (req.url.includes('operation=qiandao')) { signed = true; res.end('签到成功，奖励 5 经验'); }
      else if (signed && scenario === "refresh-failed") { res.statusCode = 503; res.end('unavailable'); }
      else res.end(signed ? signedPage("580") : unsignedPage);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const result = await runDiscuzHttp({ key: "naixi", driver: "naixi", base_url: `http://127.0.0.1:${server.address().port}`, timeout: 3000 }, { naixi: { cookie: "fixture=only" } }, "naixi");
      assert.equal(result.success, true);
      assert.equal(result.details.userGroup, scenario === "refresh-failed" ? undefined : "中级会员");
      assert.equal(result.details.totalPoints, scenario === "refresh-failed" ? undefined : 580);
      assert.deepEqual(paths, scenario === "already" ? ['/k_misign-sign.html'] : ['/k_misign-sign.html', '/plugin.php', '/k_misign-sign.html']);
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});
