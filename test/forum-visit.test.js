import test from "node:test";
import assert from "node:assert/strict";
import ForumVisitDriver, { classifyForumPage } from "../src/drivers/forum-visit.js";
import sites from "../src/builtin-sites.js";

test("LINUX SB requires logged-in identity plus account navigation without login links", () => {
  const html = '<div data-home-keyword-filter-user-id="42"></div><a href="/profile">设置</a><a href="/direct_messages">私信</a>';
  assert.equal(classifyForumPage(html, 'https://linux.sb/'), 'authenticated');
  assert.equal(classifyForumPage(html, 'https://sb.sb/'), 'unknown');
  assert.equal(classifyForumPage(html.replace('"42"', '"0"'), 'https://linux.sb/'), 'unknown');
  assert.equal(classifyForumPage(html.replace('/profile', '/topic/42'), 'https://linux.sb/'), 'unknown');
  assert.equal(classifyForumPage(html + '<a href="/login">登录</a>', 'https://linux.sb/'), 'logged_out');
  assert.equal(classifyForumPage('<script>' + html + '</script>', 'https://linux.sb/'), 'unknown');
  assert.equal(classifyForumPage('<title>Just a moment...</title>' + html, 'https://linux.sb/'), 'challenge');
  // Cloudflare also injects background detection into normal authenticated pages.
  assert.equal(classifyForumPage(html + '<script src="/cdn-cgi/challenge-platform/h/b/scripts/jsd/main.js"></script>', 'https://linux.sb/'), 'authenticated');
  assert.equal(classifyForumPage(html + '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>', 'https://linux.sb/'), 'challenge');
  assert.equal(classifyForumPage(html + '<script>window._cf_chl_opt = {};</script>', 'https://linux.sb/'), 'challenge');
});

test("both catalogs enforce visit semantics and require account evidence", () => {
  for (const key of ["linux-sb", "sb-sb"]) {
    const site = sites[key];
    assert.equal(site.kind, "visit");
    assert.equal(site.enforced_kind, "visit");
    const url = site.base_url;
    assert.equal(classifyForumPage('<a href="/logout/">退出</a>', url), "authenticated");
    assert.equal(classifyForumPage('<form action="/user/logout"></form>', url), "authenticated");
    assert.equal(classifyForumPage('<a href="/login/">登录</a>', url), "logged_out");
    assert.equal(classifyForumPage('<p>公开内容</p>', url), "unknown");
    assert.equal(classifyForumPage('<a href="https://evil.example/logout">退出</a>', url), "unknown");
    assert.equal(classifyForumPage('<script>const s = `<a href="/logout">退出</a>`</script>', url), "unknown");
    assert.equal(classifyForumPage('<title>Just a moment...</title><a href="/logout">退出</a>', url), "challenge");
  }
});

test("missing credentials never visits the site", async () => {
  const d = new ForumVisitDriver({ ...sites['linux-sb'], key: 'linux-sb' }, {});
  d.fetchPage = () => assert.fail("missing Cookie must not make a request");
  assert.equal((await d.signIn()).success, false);
});

test("public HTTP 200, errors, challenges and redirects cannot produce false success", async () => {
  for (const response of [
    new Response('<a href="/login">登录</a>'), new Response('public page'),
    new Response('<title>安全验证</title>'), new Response('<a href="/logout">退出</a>', { status: 503 }),
    new Response('', { status: 302, headers: { location: 'https://evil.example/' } }),
    new Response('', { status: 302, headers: { location: '/login/' } }),
  ]) {
    const d = new ForumVisitDriver({ ...sites['sb-sb'], key: 'sb-sb' }, { 'sb-sb': { cookie: 'session=test' } });
    let calls = 0;
    d.fetchPage = async () => { calls++; return response; };
    assert.equal((await d.signIn()).success, false);
    assert.equal(calls, 1);
  }
});

test("authenticated page yields keepalive success after a same-origin redirect", async () => {
  const d = new ForumVisitDriver({ ...sites['linux-sb'], key: 'linux-sb' }, { 'linux-sb': { cookie: 'session=test' } });
  const urls = [];
  d.fetchPage = async url => {
    urls.push(url);
    return urls.length === 1 ? new Response('', { status: 302, headers: { location: '/home' } }) : new Response('<a href="/logout">退出</a>');
  };
  assert.equal((await d.signIn()).success, true);
  assert.deepEqual(urls, ['https://linux.sb/', 'https://linux.sb/home']);
});
