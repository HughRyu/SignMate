import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareNaixiPage } from '../src/utils/naixi-page.js';

test('Naixi blocks parser-blocking assets but preserves document navigation', async () => {
  let handler;
  await prepareNaixiPage({route:async (pattern, fn)=>{assert.equal(pattern,'**/*');handler=fn;}});
  assert.equal(typeof handler, 'function', 'resource filter must be installed before goto');
  for (const type of ['script','stylesheet','image','font','media','xhr','fetch','document']) {
    let action;
    await handler({request:()=>({resourceType:()=>type}),abort:async()=>{action='abort';},continue:async()=>{action='continue';}});
    assert.equal(action,type==='document'?'continue':'abort',type);
  }
});
