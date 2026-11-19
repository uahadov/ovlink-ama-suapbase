'use strict';
/** Real PostgreSQL 2 org x 5 role matrix; only opt-in, disposable loopback QA. */
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const {ACTIONS,can}=require('../src/lib/organization-permissions');
const {checkAccess}=require('../src/lib/organization-access-context');
const target=process.env.DATABASE_URL || '';
const safe=/^postgresql:\/\/ovlinkqa:[^@]+@localhost:55491\/ovlink_p02_qa$/.test(target)
  && process.env.NODE_ENV==='test' && process.env.ENABLE_ORGANIZATION_MODEL==='1';

test('P08: live PG migration twice and 2-tenant x 5-role permission matrix',
  {skip:!safe && 'Only supported on disposable loopback P07 QA PostgreSQL',timeout:60000},async()=>{
    const {Client}=require('pg');
    const db=new Client({connectionString:target});
    const ids=[],orgs=[];
    const suffix=randomBytes(7).toString('hex');
    const roles=['owner','admin','manager','analyst','client_viewer'];
    const get={get:async(sql,params=[])=>{
      let i=0; const query=sql.replace(/\?/g,()=>`$${++i}`);
      return (await db.query(query,params)).rows[0];
    }};
    await db.connect();
    try{
      const existing=await db.query("SELECT count(*)::int AS n FROM organization_members WHERE role='member'");
      const migration=fs.readFileSync(path.join(__dirname,'../src/db/organization-roles-p08.sql'),'utf8');
      await db.query(migration);
      await db.query(migration);
      const after=await db.query("SELECT count(*)::int AS n FROM organization_members WHERE role='member'");
      assert.equal(after.rows[0].n,existing.rows[0].n,'legacy member backfill must be preserved');
      for(let tenant=0;tenant<2;tenant++){
        const users=[];
        for(const role of roles){
          const {rows}=await db.query("INSERT INTO users(email,email_verified,plan_tier,plan_status) VALUES($1,1,'pro','active') RETURNING id",[`p08-role-${tenant}-${role}-${suffix}@example.invalid`]);
          users.push(rows[0].id);ids.push(rows[0].id);
        }
        const {rows:[org]}=await db.query('INSERT INTO organizations(display_name,owner_user_id) VALUES($1,$2) RETURNING id',[`P08 Role Matrix ${tenant}`,users[0]]);
        orgs.push(org.id);
        for(let j=0;j<roles.length;j++)await db.query('INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)',[org.id,users[j],roles[j]]);
      }
      const all=await db.query('SELECT organization_id,user_id,role FROM organization_members WHERE organization_id=ANY($1::uuid[]) ORDER BY organization_id,role',[orgs]);
      assert.equal(all.rows.length,10,'2 tenants each require exactly 5 roles');
      for(const row of all.rows)for(const action of ACTIONS){
        const dbAllowed=await checkAccess({tx:get,organizationId:row.organization_id,userId:row.user_id},action);
        assert.equal(dbAllowed,can(row.role,action),`${row.organization_id} ${row.role} ${action}`);
        const otherOrg=orgs.find(id=>id!==row.organization_id);
        assert.equal(await checkAccess({tx:get,organizationId:otherOrg,userId:row.user_id},action),false,`IDOR ${row.role} ${action}`);
      }
      const manager=all.rows.find(x=>x.organization_id===orgs[0] && x.role==='manager');
      assert.equal(await checkAccess({tx:get,organizationId:orgs[0],userId:manager.user_id},'campaign.create'),true);
      await db.query("UPDATE organization_members SET role='client_viewer' WHERE organization_id=$1 AND user_id=$2",[orgs[0],manager.user_id]);
      assert.equal(await checkAccess({tx:get,organizationId:orgs[0],userId:manager.user_id},'campaign.create'),false,'role downgrade applies to existing session immediately');
      await db.query('DELETE FROM organization_members WHERE organization_id=$1 AND user_id=$2',[orgs[0],manager.user_id]);
      assert.equal(await checkAccess({tx:get,organizationId:orgs[0],userId:manager.user_id},'campaign.read'),false,'revocation applies immediately');
      await assert.rejects(db.query("UPDATE organization_members SET role='superadmin' WHERE organization_id=$1 AND role='owner'",[orgs[0]]),e=>e.code==='23514','invalid role refused at DB');
      const check=await db.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='organization_members'::regclass AND conname='organization_members_role_check'");
      assert.equal(check.rows.length,1,'exactly one enforced DB role constraint');
      for(const role of roles)assert.ok(check.rows[0].def.includes(role),`DB missing ${role}`);
    } finally{
      for(const id of orgs.reverse())await db.query('DELETE FROM organizations WHERE id=$1',[id]).catch(()=>{});
      for(const id of ids.reverse())await db.query('DELETE FROM users WHERE id=$1',[id]).catch(()=>{});
      await db.end();
    }
  });
