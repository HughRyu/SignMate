import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher } from 'undici';
import { runSiteHttp } from '../src/utils/site-http.js';
const nav = '<a href="/settings">Settings</a>';
const done = 'Daily login reward already redeemed';
async function run(pages) {
 const previous = getGlobalDispatcher(); const mock = new MockAgent(); mock.disableNetConnect(); setGlobalDispatcher(mock);
 const pool = mock.get('https://www.v2ex.com');
 for (const [path,status,body] of pages) pool.intercept({path,method:'GET'}).reply(status,body);
 try { return await runSiteHttp({key:'v2ex',base_url:'https://www.v2ex.com',redeem_retry_delay_ms:1},{v2ex:{cookie:'session=test'}},'v2ex'); }
 finally { setGlobalDispatcher(previous); await mock.close(); }
}
for (const status of [199,300,403,500]) {
 // Fetch rejects informational responses itself; the other statuses reach the parser.
 test(`daily HTTP ${status} cannot report already signed`, async()=> {
  assert.equal((await run([['/mission/daily',status,nav+done],['/balance',200,nav]])).success,false);
 });
}
test('plain Settings text is not authentication',async()=>{
 assert.equal((await run([['/mission/daily',200,'Settings '+done],['/balance',200,nav]])).success,false);
});
test('unrelated already claimed text is not a daily reward',async()=>{
 assert.equal((await run([['/mission/daily',200,nav+'广告已领取'],['/mission/daily',200,nav+'广告已领取'],['/balance',200,nav]])).success,false);
});
test('Chinese navigation and daily reward message establish success',async()=>{
 assert.equal((await run([['/mission/daily',200,'<a href="/settings">设置</a>每日登录奖励 已领取'],['/balance',200,nav]])).success,true);
});
const date = new Date().toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).replaceAll('/','');
for(const [label,balance] of [['error',[500,nav+date+' 每日登录奖励 8']],['unauthenticated',[200,date+' 每日登录奖励 8']],['unrelated date',[200,nav+date+' 通知 20000101 每日登录奖励 8']]]) {
 test(`balance ${label} cannot confirm reward`,async()=>{
  assert.equal((await run([['/mission/daily',200,nav],['/mission/daily',200,nav],['/balance',...balance]])).success,false);
 });
}
for (const stamp of [date, `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6)}`]) test(`balance exact today ${stamp} confirms reward`,async()=>{
 assert.equal((await run([['/mission/daily',200,nav],['/mission/daily',200,nav],['/balance',200,nav+stamp+' 每日登录奖励 8']])).success,true);
});
test('embedded numeric today is not a dated balance row',async()=>{
 assert.equal((await run([['/mission/daily',200,nav],['/mission/daily',200,nav],['/balance',200,nav+'999'+date+'111 每日登录奖励 8']])).success,false);
});
for (const failing of ['retry','redeem','verify']) test(`${failing} HTTP 500 cannot confirm reward`,async()=>{
 const link = '<a href="/mission/daily/redeem?once=test">领取</a>';
 const pages = failing==='retry' ? [['/mission/daily',200,nav],['/mission/daily',500,nav+done],['/balance',200,nav]] : [['/mission/daily',200,nav+link],['/mission/daily/redeem?once=test',failing==='redeem'?500:200,nav],['/mission/daily',failing==='verify'?500:200,nav+done],['/balance',200,nav]];
 assert.equal((await run(pages)).success,false);
});
