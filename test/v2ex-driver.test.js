import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
const data = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const root = new URL('../', import.meta.url);
let serial = 0;
async function setup({state = 'challenge', http = 'already', config = {}} = {}) {
  const calls = { http: [], browser: [], closed: 0, claims: 0 };
  const site = Object.freeze({ key:'v2ex', driver:'v2ex', signin_mode:'playwright', base_url:'https://www.v2ex.com', proxy_url:'http://proxy.invalid:1999', timeout:1, ...config });
  const secrets = Object.freeze({v2ex:Object.freeze({cookie:'session=test'})});
  const page = {
    goto: async url => { calls.browser.push(url); if(url.includes('/redeem')) calls.claims++; return {status:()=>200}; },
    waitForTimeout: async()=>{}, title:async()=> 'V2EX',
    locator:()=>({innerText:async()=> 'Daily login reward already redeemed'}),
    evaluate: async fn => {
      if(String(fn).includes('challenge:')) return {title:'V2EX',text:state === 'authenticated' ? (http === 'browser-claim' ? 'Daily Login Bonus' : 'Daily login reward already redeemed') : '', challenge:state==='challenge',authenticated:state==='authenticated',loginForm:state==='unauthenticated'};
      if(String(fn).includes('htmlMatches')) return ['/mission/daily/redeem?once=test'];
      return {};
    },
  };
  const id = `__v2exTest${serial++}`;
  globalThis[id] = {
    launchBrowser:async opts=> {assert.equal(opts.launchOptions.proxy.server,site.proxy_url);return {newContext:async()=>({addCookies:async()=>{},newPage:async()=>page}),close:async()=>{calls.closed++;}};},
    createHttpSession:opts=> {assert.equal(opts.proxyUrl,site.proxy_url);assert.equal(opts.cookie,'session=test');return {get:async url=>{
      calls.http.push(url);
      if(http==='error') throw new Error('network unavailable');
      if(url.includes('/redeem')) calls.claims++;
      let text = http==='challenge' ? '<title>Just a moment</title>Checking your browser' : http==='login' ? '<form>Sign in</form>' : '<a href="/settings">Settings</a> Daily login reward already redeemed';
      if(http==='claim' && calls.claims===0) text='<a href="/settings">Settings</a> <a href="/mission/daily/redeem?once=test">Daily Login Bonus</a>';
      return new Response(text,{status:http==='challenge'?403:200});
    }};},
  };
  const sessionSource = (await readFile(new URL('src/utils/http-session.js',root),'utf8')).replace('export function createHttpSession(', 'function unusedCreateHttpSession(').replace(/from "\.\/proxy.js"/g,`from "${new URL('src/utils/proxy.js',root)}"`).replace('from "undici"',`from "${new URL('node_modules/undici/index.js',root)}"`) + `\nexport const createHttpSession = globalThis.${id}.createHttpSession;`;
  let httpSource = await readFile(new URL('src/utils/site-http.js',root),'utf8');
  httpSource = httpSource.replace('"./http-session.js"',JSON.stringify(data(sessionSource))).replace(/from "(\.[^"]+)"/g,(_,p)=>`from "${new URL(p,new URL('src/utils/site-http.js',root))}"`);
  let source = await readFile(new URL('src/drivers/v2ex.js',root),'utf8');
  source = source.replace('"../utils/site-http.js"',JSON.stringify(data(httpSource))).replace('"../utils/browser.js"',JSON.stringify(data(`export const launchBrowser = globalThis.${id}.launchBrowser; export const resolveChromiumExecutablePath = async()=>'/not-used';`))).replace(/from "(\.[^"]+)"/g,(_,p)=>`from "${new URL(p,new URL('src/drivers/v2ex.js',root))}"`).replace('import("playwright-core")',`import("${new URL('node_modules/playwright-core/index.mjs',root)}")`);
  const Driver = (await import(data(source))).default;
  return {driver:new Driver(site,secrets),calls,site,secrets};
}

for (const [http,action] of [['challenge','api_challenge'],['login','api_login_failed'],['error','api_error']]) {
  test(`HTTP fallback preserves ${action} and does not loop`,async()=>{
    const {driver,calls}=await setup({http});const result=await driver.signIn();
    assert.equal(result.success,false);assert.equal(result.details.checkinAction,action);
    assert.equal(result.details.browserPageState,'challenge');assert.equal(calls.http.length,1);assert.equal(calls.browser.length,1);assert.equal(calls.closed,1);
  });
}
for(const config of [{api_fallback_playwright:false},{protocol_fallback_playwright:'off'}]) {
  test(`explicit fallback disabled ${JSON.stringify(config)}`,async()=>{
    const {driver,calls}=await setup({config});const result=await driver.signIn();
    assert.equal(result.success,false);assert.equal(result.details.pageState,'challenge');assert.equal(calls.http.length,0);
  });
}
for(const state of ['authenticated','unauthenticated','unknown']) {
  test(`normal browser ${state} never falls back`,async()=>{
    const {driver,calls}=await setup({state});const result=await driver.signIn();
    assert.equal(result.success,state==='authenticated');assert.equal(calls.http.length,0);assert.equal(calls.claims,0);
  });
}
test('browser challenge fallback redeems once through real HTTP flow',async()=>{
 const {driver,calls}=await setup({http:'claim'});const result=await driver.signIn();
 assert.equal(result.success,true);assert.equal(result.details.checkinAction,'api_signed');assert.equal(calls.claims,1);assert.equal(calls.browser.length,1);
});
test('normal browser redeems once without HTTP fallback',async()=>{
 const {driver,calls}=await setup({state:'authenticated',http:'browser-claim'});const result=await driver.signIn();
 assert.equal(result.success,true);assert.equal(result.details.checkinAction,'browser_signed');assert.equal(calls.claims,1);assert.equal(calls.http.length,0);
});
test('HTTP-first failure then browser challenge does not retry HTTP',async()=>{
 const {driver,calls}=await setup({http:'challenge',config:{signin_mode:'api-first'}});const result=await driver.signIn();
 assert.equal(result.success,false);assert.equal(result.details.pageState,'challenge');assert.equal(calls.http.length,1);
});

test('browser challenge reaches same-proxy real HTTP flow without claiming twice',async()=>{
  const {driver,calls,site,secrets}=await setup();
  const result=await driver.signIn();
  assert.equal(result.success,true);
  assert.equal(result.details.checkinAction,'api_already_signed');
  assert.equal(result.details.browserPageState,'challenge');
  assert.equal(calls.http.length,2);
  assert.equal(calls.claims,0);
  assert.equal(calls.closed,1);
  assert.equal(driver.siteConfig,site);assert.equal(driver.secrets,secrets);
});
