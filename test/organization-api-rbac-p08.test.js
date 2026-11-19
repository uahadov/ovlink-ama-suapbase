'use strict';
/** P08 live HTTP organization read RBAC; synthetic isolated PostgreSQL only. */
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const express=require('express');
const {migrateOrganizationModel}=require('../src/db/organization-model');
const {pool}=require('../src/db/pool');
const target=process.env.DATABASE_URL||'';
const safe=/^postgresql:\/\/ovlinkqa:[^@]+@localhost:55491\/ovlink_p02_qa$/.test(target)
 && process.env.NODE_ENV==='test' && process.env.ENABLE_ORGANIZATION_MODEL==='1';

test('P08: live org API policy, role downgrade, revoke, and cross-tenant hiding',
  {skip: !safe && 'Only disposable PG with opt-in org feature',timeout:45000},async()=>{
    const {Client}=require('pg');
    const db=new Client({connectionString:target});
    const users=[],orgs=[];
    let server;
    await db.connect();
    try {
      await migrateOrganizationModel();
      const migration=fs.readFileSync(path.join(__dirname,'../src/db/organization-roles-p08.sql'),'utf8');
      await db.query(migration);
      const suffix=randomBytes(5).toString('hex');
      async function createUser(tag){
        const {rows}=await db.query("INSERT INTO users(email,email_verified,plan_tier,plan_status) VALUES($1,1,'pro','active') RETURNING id",[`p08-http-${tag}-${suffix}@example.invalid`]);
        users.push(rows[0].id);return rows[0].id;
      }
      const owner=await createUser('owner'),admin=await createUser('admin'),manager=await createUser('manager'),analyst=await createUser('analyst'),viewer=await createUser('viewer'),other=await createUser('other');
      const {rows:[org]}=await db.query('INSERT INTO organizations(display_name,owner_user_id) VALUES($1,$2) RETURNING id',['P08 HTTP Alpha',owner]);orgs.push(org.id);
      const {rows:[beta]}=await db.query('INSERT INTO organizations(display_name,owner_user_id) VALUES($1,$2) RETURNING id',['P08 HTTP Beta',other]);orgs.push(beta.id);
      for(const [user,role] of [[owner,'owner'],[admin,'admin'],[manager,'manager'],[analyst,'analyst'],[viewer,'client_viewer']]){
        await db.query('INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)',[org.id,user,role]);
      }
      await db.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",[beta.id,other]);
      for(const id of orgs)await db.query('INSERT INTO organization_billing(organization_id,billing_owner_user_id) VALUES($1,$2)',[id,id===org.id?owner:other]);
      const app=express();app.use(express.json());app.use((req,_res,next)=>{req.session={userId:Number(req.get('x-test-user')||0)};next();});app.use(require('../src/routes/api/organizations'));
      server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
      const base=`http://127.0.0.1:${server.address().port}`;
      async function get(user,endpoint){const res=await fetch(base+endpoint,{headers:{'x-test-user':String(user)}});return {status:res.status,body:await res.json(),cache:res.headers.get('cache-control')};}
      for(const user of [owner,admin,manager,analyst]){
        const detail=await get(user,`/api/organizations/${org.id}`);
        assert.equal(detail.status,200,`role user ${user}`);assert.equal(detail.body.organization.id,org.id);
        assert.match(detail.cache||'',/no-store/);
        const list=await get(user,'/api/organizations');
        assert.equal(list.status,200);assert.ok(list.body.organizations.some(x=>x.id===org.id));assert.ok(!list.body.organizations.some(x=>x.id===beta.id));
      }
      assert.equal((await get(viewer,`/api/organizations/${org.id}`)).status,404,'client viewer cannot read organization metadata');
      assert.ok(!(await get(viewer,'/api/organizations')).body.organizations.some(x=>x.id===org.id),'client viewer list hidden');
      assert.equal((await get(other,`/api/organizations/${org.id}`)).status,404,'cross org hidden');
      assert.equal((await get(owner,`/api/organizations/${beta.id}`)).status,404,'other org hidden');
      assert.equal((await get(owner,'/api/organizations/not-uuid')).status,404);
      await db.query("UPDATE organization_members SET role='client_viewer' WHERE organization_id=$1 AND user_id=$2",[org.id,manager]);
      assert.equal((await get(manager,`/api/organizations/${org.id}`)).status,404,'existing session role downgrade immediate');
      assert.ok(!(await get(manager,'/api/organizations')).body.organizations.some(x=>x.id===org.id));
      await db.query('DELETE FROM organization_members WHERE organization_id=$1 AND user_id=$2',[org.id,analyst]);
      assert.equal((await get(analyst,`/api/organizations/${org.id}`)).status,404,'revocation immediate');
      await db.query("UPDATE organizations SET state='suspended' WHERE id=$1",[org.id]);
      assert.equal((await get(owner,`/api/organizations/${org.id}`)).status,404,'suspended org hidden');
      process.env.ENABLE_ORGANIZATION_MODEL='0';
      assert.equal((await get(owner,'/api/organizations')).status,404,'opt-in flag off');
      process.env.ENABLE_ORGANIZATION_MODEL='1';
    }finally{
      process.env.ENABLE_ORGANIZATION_MODEL='1';
      if(server)await new Promise(resolve=>server.close(resolve));
      for(const id of orgs.reverse())await db.query('DELETE FROM organizations WHERE id=$1',[id]).catch(()=>{});
      for(const id of users.reverse())await db.query('DELETE FROM users WHERE id=$1',[id]).catch(()=>{});
      await db.end();await pool.end().catch(()=>{});
    }
  });
