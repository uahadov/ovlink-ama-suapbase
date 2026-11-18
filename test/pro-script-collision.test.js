'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root=path.resolve(__dirname,'..');
const read=name=>fs.readFileSync(path.join(root,name),'utf8');

test('Pro activation page only loads home.js for its Monolith navbar, avoiding duplicate script.js lexical declarations',()=>{
  const pro=read('views/pro.ejs');
  assert.match(pro, /src="\/home\.js\?v=/);
  assert.doesNotMatch(pro, /src="\/script\.js\?v=/);
  const home=read('public/home.js'),legacy=read('public/script.js');
  assert.match(home,/const FLOATING_PRICING_BANNER_DISMISS_MS/);
  assert.match(legacy,/const FLOATING_PRICING_BANNER_DISMISS_MS/);
  assert.match(read('views/pricing.ejs'), /src="\/script\.js\?v=/);
});

test('Pro page keeps its route-independent enhancement script and accessibility shell',()=>{
 const pro=read('views/pro.ejs');
 assert.match(pro,/id="mainContent"/);
 assert.match(pro,/class="m-skip-link"/);
 assert.match(pro,/Auto-poll session to synchronize Pro status/);
});
