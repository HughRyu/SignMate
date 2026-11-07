import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import PiggoDriver, { piggoSignature, piggoAccount } from "../src/drivers/piggo.js";
import { parseSbCheckin } from "../src/drivers/sb-signin.js";
import sites from "../src/builtin-sites.js";

test("SB checkin state is scoped to account action area, not public board claims", () => {
  assert.equal(parseSbCheckin('<div class="signin-panel"><div class="signin-board">今日已签到 签到成功</div></div>').signed, false);
  assert.equal(parseSbCheckin('<div class="signin-board"><div class="signin-success">签到成功</div></div>').signed, false);
  assert.equal(parseSbCheckin('<div class="signin-hero-action">今日已签到</div>').signed, true);
  const form = '<form method="post" action="/checkin/"></form>';
  assert.equal(parseSbCheckin(form).ready, true);
  assert.equal(parseSbCheckin(form + '<div class="signin-hero-action">今日已签到</div>').signed, false);
  assert.deepEqual(parseSbCheckin('<div class="signin-stat"><span class="signin-stat-value">1,234</span><span class="signin-stat-label">累计签到</span></div>').stats, { totalDays: 1234 });
  assert.equal(sites['sb-sb'].kind, 'signin');
  assert.equal(sites['linux-sb'].kind, 'visit');
  assert.equal(sites['piggo-me'].driver, 'piggo');
});
test("Piggo signature matches SPA ASCII signing key and canonical path", () => {
  const key = 'a'.repeat(64), nonce = 'b'.repeat(32), ts = '1234567890';
  assert.equal(piggoSignature(key, '/v1/web/me?ignored=yes', ts, nonce), createHmac('sha256', key).update(`GET\nv1/web/me\n${ts}\n${nonce}`).digest('hex'));
});
test("Piggo only reports authenticated account evidence, never sign material", () => {
  for (const data of [{}, { user: { id: 0, username: 'x' } }, { user: { id: 1 } }]) assert.equal(piggoAccount(data), null);
  const details = piggoAccount({ user: { id: 1, username: 'fixture', bonus: 0, passkey: 'secret' }, sign: 'secret' });
  assert.equal(details.bonus, 0); assert.equal(details.passkey, undefined); assert.equal(details.sign, undefined);
});
test("Piggo Cookie-only flow signs a read-only account request and rejects 401/malformed data", async () => {
  const driver = new PiggoDriver({ key: 'piggo-me', base_url: 'https://piggo.me' }, { 'piggo-me': { cookie: 'session=fixture' } });
  const paths = [];
  driver.fetchJson = async (path, headers) => {
    paths.push(path); assert.equal(headers.Cookie, 'session=fixture'); assert.equal(headers.Authorization, undefined);
    if (path.endsWith('/auth/sign')) return { status: 200, code: 0, data: { sign: 'a'.repeat(64) } };
    assert.match(headers['X-Spa-Hmac'], /^[a-f0-9]{64}$/);
    return { status: 200, code: 0, data: { user: { id: 1, username: 'fixture' } } };
  };
  assert.equal((await driver.signIn()).success, true);
  assert.deepEqual(paths, ['/v1/web/auth/sign', '/v1/web/me']);
  for (const response of [{ status: 401, code: 401 }, { status: 200, invalid: true }, { status: 403 }, { status: 200, code: 1, data: {} }]) {
    driver.fetchJson = async () => response;
    assert.equal((await driver.signIn()).success, false);
  }
  driver.secrets = {}; driver.fetchJson = () => assert.fail('no credentials must not request');
  assert.equal((await driver.signIn()).success, false);
});
