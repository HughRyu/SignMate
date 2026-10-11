import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForV2EXPage } from '../src/drivers/v2ex-page.js';

function fakePage(states) {
 let index = 0;
 return {
  evaluate: async () => states[Math.min(index, states.length - 1)],
  waitForTimeout: async () => { index++; },
 };
}
const challenge = { title: '请稍候…', text: '正在安全验证', challenge: true, authenticated: false, loginForm: false };
const loggedIn = { title: 'V2EX › 每日登录奖励', text: '设置 记事本 领取每日登录奖励', challenge: false, authenticated: true, loginForm: false };
test('hung evaluate has a real wall clock deadline', async () => {
 const started = performance.now();
 let guard;
 try {
  const result = await Promise.race([
   waitForV2EXPage({evaluate:()=>new Promise(()=>{})}, {timeout:25,pollMs:1}),
   new Promise((_,reject)=>{guard=setTimeout(()=>reject(new Error('hard timeout missing')),200);}),
  ]);
  assert.equal(result.state,'unknown');
  assert.ok(performance.now()-started < 180);
 } finally { clearTimeout(guard); }
});
test('persistent challenge remains distinct from expired credentials', async () => {
 const result = await waitForV2EXPage(fakePage([challenge]), { timeout: 2, pollMs: 1 });
 assert.equal(result.state, 'challenge');
});
test('Chinese logged-in navigation is accepted without English keywords', async () => {
 assert.equal((await waitForV2EXPage(fakePage([loggedIn]))).state, 'authenticated');
});
test('unknown page does not establish expired credentials', async () => {
 assert.equal((await waitForV2EXPage(fakePage([{...loggedIn, authenticated:false}]))).state, 'unknown');
});
test('an explicit login form establishes unauthenticated state', async () => {
 assert.equal((await waitForV2EXPage(fakePage([{...loggedIn, authenticated:false, loginForm:true}]))).state, 'unauthenticated');
});
test('waits for a transient challenge instead of rejecting the cookie', async () => {
 const result = await waitForV2EXPage(fakePage([challenge, loggedIn]), { timeout: 10, pollMs: 1 });
 assert.equal(result.state, 'authenticated');
});
