import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { resolveChromiumExecutablePath } from '../src/utils/browser.js';
import SbSigninDriver from '../src/drivers/sb-signin.js';
if (process.env.SIGNMATE_ISOLATED_TEST !== 'true') throw new Error('Disposable test container only');
const logged = '<a href="/logout/">退出</a>';
const signed = logged + '<div class="signin-hero-action">今日已签到</div>';
for (const mode of ['success', 'already', 'rejected', 'verify', 'logout']) {
  let posts = 0;
  const driver = new SbSigninDriver({key:'sb-sb', verify_only:mode==='verify'}, {'sb-sb':{cookie:'session=fixture'}});
  driver.openBrowser = async () => {
    const browser = await chromium.launch({executablePath:await resolveChromiumExecutablePath(chromium),headless:true,args:['--no-sandbox']});
    const create = browser.newContext.bind(browser);
    browser.newContext = async options => {
      const context = await create(options);
      context.on('page', page => page.on('pageerror', error => console.error('fixture page error:', error.message)));
      await context.route('**/*', async route => {
        const req = route.request();
        assert.equal(new URL(req.url()).origin, 'https://sb.sb');
        if(req.method()==='POST') {
          posts++; const body = new URLSearchParams(req.postData());
          assert.equal(body.get('message'),''); assert.equal(body.get('cap-token'),'fixture');
          return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:signed});
        }
        const html = mode==='already'?signed:mode==='logout'?'<a href="/login/">登录</a>':logged+`<div class="signin-hero-action"><form action="/checkin/" method="post" class="signin-form"><input name="message" value="must remain blank"><button type="submit">立即签到</button><div data-signin-cap hidden><cap-widget></cap-widget></div></form></div><div class="signin-board">签到成功</div><script>
        const form=document.querySelector('form'), widget=document.querySelector('cap-widget');
        form.addEventListener('submit',e=>{e.preventDefault();document.querySelector('[data-signin-cap]').hidden=false;});
        setTimeout(()=>{const shadow=widget.attachShadow({mode:'open'});shadow.innerHTML='<button aria-label="点击验证你不是机器人">验证</button>';shadow.querySelector('button').onclick=()=>{
        if(${JSON.stringify(mode)}==='rejected') {widget.dataset.state='error';return;}
        const input=document.createElement('input');input.name='cap-token';input.value='fixture';form.appendChild(input);form.submit();};},500);
        </script>`;
        return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:html});
      });
      return context;
    };
    return browser;
  };
  const result = await driver.signIn();
  assert.equal(result.success, !['rejected','logout'].includes(mode), JSON.stringify({mode,result}));
  assert.equal(posts, mode==='success'?1:0, mode);
  if(mode==='rejected') assert.equal(result.details.failureType,'challenge');
  if(mode==='logout') assert.equal(result.details.failureType,'auth_expired');
  console.log(`SB browser fixture passed: ${mode}, posts=${posts}`);
}
