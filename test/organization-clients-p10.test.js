'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express');
const {pool}=require('../src/db/pool');
const {migrateOrganizationModel,migrateOrganizationRoles,migrateOrganizationTeam,migrateOrganizationClients,organizationClientsEnabled}=require('../src/db/organization-model');
const {encryptAES256GCM,blindIndex}=require('../utils/crypto');
const safe=/^postgresql:\/\/ovlinkqa:[^@]+@localhost:55491\/ovlink_p02_qa$/.test(process.env.DATABASE_URL||'')&&process.env.NODE_ENV==='test';
test('P10 quadruple opt-in default OFF and dependency gated',()=>{
 assert.equal(organizationClientsEnabled({}),false);
 assert.equal(organizationClientsEnabled({ENABLE_ORGANIZATION_MODEL:'1',ENABLE_ORGANIZATION_RBAC_V2:'1',ENABLE_ORGANIZATION_TEAM_V1:'1'}),false);
 assert.equal(organizationClientsEnabled({ENABLE_ORGANIZATION_MODEL:'1',ENABLE_ORGANIZATION_RBAC_V2:'1',ENABLE_ORGANIZATION_TEAM_V1:'1',ENABLE_ORGANIZATION_CLIENTS_V1:'1'}),true);
});
test('P10 real agency portfolio: cross-tenant isolation, 20 campaigns, archive safe for links',{skip:!safe&&'Requires disposable P10 QA PG',timeout:60000},async()=>{
 const {Client}=require('pg'),db=new Client({connectionString:process.env.DATABASE_URL});
 const before={...process.env},users=[],orgs=[],campaigns=[],urls=[],clients=[];let server;
 await db.connect();
 try{
  const env={ENABLE_ORGANIZATION_MODEL:'1',ENABLE_ORGANIZATION_RBAC_V2:'1',ENABLE_ORGANIZATION_TEAM_V1:'1',ENABLE_ORGANIZATION_CLIENTS_V1:'1'};
  await migrateOrganizationModel();await migrateOrganizationRoles({env});await migrateOrganizationTeam({env});await migrateOrganizationClients({env});await migrateOrganizationClients({env});
  Object.assign(process.env,env);
  const unique=crypto.randomBytes(6).toString('hex');
  async function user(name){const email=`p10-${name}-${unique}@example.invalid`,row=(await db.query("INSERT INTO users(email,email_hash,email_verified,plan_tier,plan_status) VALUES($1,$2,1,'pro','active') RETURNING id",[encryptAES256GCM(email),blindIndex(email)])).rows[0];users.push(row.id);return row.id}
  const owner=await user('owner'),manager=await user('manager'),analyst=await user('analyst'),viewer=await user('viewer'),outsider=await user('outsider');
  async function org(name,who){const o=(await db.query('INSERT INTO organizations(display_name,owner_user_id) VALUES($1,$2) RETURNING id',[name,who])).rows[0];orgs.push(o.id);await db.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",[o.id,who]);return o.id}
  const alpha=await org('P10 Agency A',owner),beta=await org('P10 Agency B',outsider);
  for(const [who,role] of [[manager,'manager'],[analyst,'analyst'],[viewer,'client_viewer']])await db.query('INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)',[alpha,who,role]);
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.session={userId:Number(req.get('x-test-user')||0)};next()});app.use(require('../src/routes/api/organization-clients'));
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base=`http://127.0.0.1:${server.address().port}`;
  async function call(who,method,url,body){const res=await fetch(base+url,{method,headers:{'x-test-user':String(who),'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return{status:res.status,body:await res.json()}}
  const path=`/api/organizations/${alpha}/clients`;
  const ids=[];
  for(const name of ['Acme One','Acme Two','Acme Three']){
   const c=await call(manager,'POST',path,{name,contact_email:`${name.replaceAll(' ','').toLowerCase()}@example.invalid`,logo_url:'https://example.invalid/logo.png',report_settings:{locale:'az',report_frequency:'weekly'}});
   assert.equal(c.status,201,`create ${name}`);ids.push(c.body.client.id);clients.push(c.body.client.id);
  }
  assert.equal((await call(analyst,'POST',path,{name:'Disallowed Client'})).status,404);
  assert.equal((await call(viewer,'POST',path,{name:'Disallowed Client'})).status,404);
  assert.equal((await call(outsider,'GET',path)).status,404,'cross-tenant list');
  assert.equal((await call(owner,'GET',path)).body.clients.length,3);
  assert.equal((await call(viewer,'GET',path)).body.clients.length,0,'viewer sees no unassigned client');
  assert.equal((await call(manager,'POST',path+'/'+ids[0]+'/assign',{user_id:viewer})).status,200);
  assert.equal((await call(viewer,'GET',path)).body.clients.length,1,'viewer only assigned client');
  assert.equal((await call(viewer,'POST',path+'/'+ids[0]+'/campaigns',{name:'Private'})).status,404,'viewer cannot create campaign');
  assert.equal((await call(manager,'POST',path,{name:'X',unknown:'massassign'})).status,400,'mass-assignment denied');
  const first=ids[0],second=ids[1];
  for(let i=1;i<=20;i++){
   const c=await call(manager,'POST',path+'/'+first+'/campaigns',{name:`Client 1 Campaign ${i}`});assert.equal(c.status,201,`first client campaign ${i}`);campaigns.push(c.body.campaign.id);
  }
  const other=await call(manager,'POST',path+'/'+second+'/campaigns',{name:'Second client campaign'});assert.equal(other.status,201);campaigns.push(other.body.campaign.id);
  assert.equal((await call(owner,'GET',path+'/'+first+'/campaigns')).body.campaigns.length,20,'all 20 campaigns belong to first client');
  assert.equal((await call(owner,'GET',path+'/'+second+'/campaigns')).body.campaigns.length,1,'second client only one');
  assert.equal((await call(viewer,'GET',path+'/'+second+'/campaigns')).status,404,'client viewer cannot inspect unassigned client');
  assert.equal((await call(viewer,'GET',path+'/'+first+'/campaigns')).body.campaigns.length,20,'assigned viewer read-only');
  assert.equal((await call(outsider,'GET',path+'/'+first+'/campaigns')).status,404);
  const urlShort=`p10-${unique}`;
  const link=(await db.query('INSERT INTO urls(original,short,created_at,user_id,campaign_id) VALUES($1,$2,$3,$4,$5) RETURNING id',[`https://example.invalid/${unique}`,urlShort,new Date().toISOString(),owner,campaigns[0]])).rows[0];urls.push(link.id);
  assert.equal((await call(manager,'POST',path+'/'+first+'/archive',{})).status,200,'archive without deletion');
  assert.equal((await call(owner,'GET',path)).body.clients.length,2,'archived client hidden by default');
  assert.equal((await call(owner,'GET',path+'?include_archived=1')).body.clients.length,3);
  assert.equal((await db.query('SELECT short,campaign_id FROM urls WHERE id=$1',[link.id])).rows[0].short,urlShort,'redirect link untouched');
  assert.equal((await call(manager,'POST',path+'/'+first+'/restore',{})).status,200);
  assert.equal((await call(manager,'PATCH',path+'/'+first,{name:'Restored Client',report_settings:{locale:'tr',report_frequency:'monthly'}})).status,200);
  assert.equal((await call(outsider,'PATCH',path+'/'+first,{name:'Wrong Tenant'})).status,404);
  assert.equal((await call(owner,'POST',path+'/'+first+'/transfer',{target_organization_id:beta})).status,404,'cross-owner transfer refused');
  assert.equal((await call(owner,'GET',path+'/'+first+'/campaigns')).body.campaigns.length,20,'transfer refusal preserves campaigns');
  const count=(await db.query("SELECT COUNT(*)::int AS c FROM organization_audit_log WHERE organization_id=$1 AND metadata_json->>'kind' LIKE 'organization.client.%'",[alpha])).rows[0].c;
  assert.ok(count>=27,'client modifications audited');
 }finally{
  if(server)await new Promise(r=>server.close(r));
  for(const id of urls.reverse())await db.query('DELETE FROM urls WHERE id=$1',[id]).catch(()=>{});
  for(const id of campaigns.reverse())await db.query('DELETE FROM campaigns WHERE id=$1',[id]).catch(()=>{});
  for(const id of orgs.reverse())await db.query('DELETE FROM organizations WHERE id=$1',[id]).catch(()=>{});
  for(const id of users.reverse())await db.query('DELETE FROM users WHERE id=$1',[id]).catch(()=>{});
  for(const key of ['ENABLE_ORGANIZATION_MODEL','ENABLE_ORGANIZATION_RBAC_V2','ENABLE_ORGANIZATION_TEAM_V1','ENABLE_ORGANIZATION_CLIENTS_V1']){
    if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];
  }
  await db.end();await pool.end().catch(()=>{});
 }
});
