import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import Driver from "../src/drivers/naixi.js";
import { signedPage, unsignedPage } from "../test/naixi-account-fixtures.js";
if (process.env.SIGNMATE_ISOLATED_TEST !== "true") throw new Error("Disposable test container required");
const launch = chromium.launch.bind(chromium);
try {
  for (const scenario of ["already", "fresh", "refresh-failed"]) {
    const paths = []; let signed = scenario === "already";
    chromium.launch = async options => {
      const browser = await launch(options);
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async options => {
        const context = await newContext(options);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const page = await newPage();
          const routePage = page.route.bind(page);
          page.route = async (pattern, handler) => routePage(pattern, async route => {
          if (route.request().resourceType() !== 'document') return handler(route);
          const url = new URL(route.request().url()); paths.push(url.pathname);
          let status = 200, body;
          if (url.searchParams.get('operation') === 'qiandao') { signed = true; body = '签到成功，奖励 5 经验'; }
          else if (signed && scenario === "refresh-failed") { status = 503; body = 'unavailable'; }
          else body = signed ? signedPage("580") : unsignedPage;
          await route.fulfill({ status, contentType: 'text/html; charset=utf-8', body });
          });
          return page;
        };
        return context;
      };
      return browser;
    };
    const driver = new Driver({ key: 'naixi', base_url: 'https://forum.naixi.net', signin_mode: 'playwright', playwright_wait_ms: 1, timeout: 5000 }, { naixi: { cookie: 'fixture=only' } });
    const result = await driver.signIn();
    assert.equal(result.success, true);
    assert.equal(result.details.totalPoints, scenario === 'refresh-failed' ? undefined : 580);
    assert.equal(result.details.userGroup, scenario === 'refresh-failed' ? undefined : '中级会员');
    assert.deepEqual(paths, scenario === 'already' ? ['/k_misign-sign.html'] : ['/k_misign-sign.html', '/plugin.php', '/k_misign-sign.html']);
  }
  console.log('[check:naixi-account] browser already-signed, fresh totals and optional failure passed');
} finally { chromium.launch = launch; }
