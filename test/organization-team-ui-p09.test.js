'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),ejs=require('ejs'),vm=require('node:vm');
const view=path.join(__dirname,'../views/organization-team.ejs');
for(const lang of ['az','tr','en'])test('P09 management UI renders accessible '+lang+' with compiled JS',async()=>{
 const html=await ejs.renderFile(view,{orgId:'3c90fa09-30cc-4779-8dfb-5ab4f98b843e',lang,nonce:'qa-nonce',csrfToken:'qa-csrf'});
 assert.match(html,/id="mainContent"/);assert.match(html,/class="m-skip-link"/);assert.match(html,/dir="ltr"/);
 assert.match(html,/name="csrf-token" content="qa-csrf"/);
 assert.match(html,/nonce="qa-nonce"/);
 for(const name of ['inviteForm','inviteEmail','inviteRole','membersList','invitesList','transferForm','transferTarget','notice'])assert.match(html,new RegExp('id="'+name+'"'));
 const scripts=[...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];assert.equal(scripts.length,1);assert.doesNotThrow(()=>new vm.Script(scripts[0][1]));
 const expected={az:'Komanda idarəetməsi',tr:'Takım yönetimi',en:'Team management'};
 assert.match(html,new RegExp(expected[lang]));
 assert.doesNotMatch(html,/invitation\.email_encrypted|token_hash/);
 assert.match(html,/prefers-reduced-motion/);assert.match(html,/@media\(max-width:760px\)/);
});
test('P09 management UI uses server-side current-role privileges and no DOM injection',()=>{
 const source=fs.readFileSync(view,'utf8'),route=fs.readFileSync(path.join(__dirname,'../src/routes/api/organization-team.js'),'utf8');
 assert.match(source,/data\.capabilities/);assert.match(source,/caps\.change_role/);assert.match(source,/caps\.remove/);assert.match(source,/caps\.transfer_owner/);
 assert.match(source,/textContent/);assert.doesNotMatch(source,/\.innerHTML\s*=/);
 assert.match(source,/x-csrf-token/);assert.match(route,/capabilities:\{invite:/);
});
