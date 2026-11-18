'use strict';
/** P08 REAL PG authorization checks; refuses every database except disposable P07 localhost QA. */
const test=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const {loadContext,checkAccess}=require('../src/lib/organization-access-context');
const target=process.env.DATABASE_URL || '';
const safe=/^postgresql:\/\/ovlinkqa:[^@]+@localhost:55491\/ovlink_p02_qa$/.test(target)
  && process.env.NODE_ENV==='test' && process.env.ENABLE_ORGANIZATION_MODEL==='1';

test('P08: PostgreSQL tenant isolation, current membership, revocation and transaction lock',
  {skip: !safe && 'Requires explicit isolated P07 PostgreSQL QA and ENABLE_ORGANIZATION_MODEL=1',timeout:45000},
  async()=>{
    const {Client}=require('pg');
    const db=new Client({connectionString:target});
    const locker=new Client({connectionString:target});
    const outsider=new Client({connectionString:target});
    const suffix=randomBytes(6).toString('hex');
    const ids=[]; const orgIds=[]; const wsIds=[];
    await db.connect(); await locker.connect(); await outsider.connect();
    const get=client=>({get:async(sql,params=[])=>{
      let n=0;
      const pgsql=sql.replace(/\?/g,()=>`$${++n}`);
      const result=await client.query(pgsql,params);
      return result.rows[0];
    }});
    const user=async tag=>{
      const {rows}=await db.query(
        "INSERT INTO users(email,email_verified,plan_tier,plan_status) VALUES($1,1,'pro','active') RETURNING id",
        [`p08-db-${tag}-${suffix}@example.invalid`]
      ); ids.push(rows[0].id); return rows[0].id;
    };
    let inTx=false;
    try{
      const alice=await user('alice');const bob=await user('bob');const carol=await user('carol');
      const createOrg=async (name,owner)=>{
        const {rows}=await db.query('INSERT INTO organizations(display_name,owner_user_id) VALUES($1,$2) RETURNING id',[name,owner]);
        orgIds.push(rows[0].id);
        await db.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'owner')",[rows[0].id,owner]);
        return rows[0].id;
      };
      const a=await createOrg('P08 Alpha',alice);
      const b=await createOrg('P08 Beta',bob);
      const access=(organizationId,userId,action,extra={})=>checkAccess({tx:get(db),organizationId,userId,...extra},action);
      assert.equal(await access(a,alice,'billing.manage'),true,'owner should pass');
      assert.equal(await access(b,alice,'organization.read'),false,'cross-org read must fail');
      assert.equal(await access(a,bob,'organization.read'),false,'outsider must fail');
      assert.equal(await access(b,bob,'organization.read'),true);
      await db.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,'admin')",[a,carol]);
      assert.equal(await access(a,carol,'campaign.create'),true);
      assert.equal(await access(a,carol,'billing.manage'),false);
      await db.query('DELETE FROM organization_members WHERE organization_id=$1 AND user_id=$2',[a,carol]);
      assert.equal(await access(a,carol,'campaign.read'),false,'revoked member must immediately fail');
      await db.query('UPDATE organizations SET state=$2 WHERE id=$1',[b,'suspended']);
      assert.equal(await access(b,bob,'organization.read'),false,'suspended org must fail');
      await db.query('UPDATE organizations SET state=$2 WHERE id=$1',[b,'active']);

      // Legacy workspace membership remains authoritative over stale shadow members.
      const {rows:[w]}=await db.query('INSERT INTO workspaces(name,owner_user_id,created_at) VALUES($1,$2,CURRENT_TIMESTAMP) RETURNING id',['P08 Legacy',alice]);
      wsIds.push(w.id);
      const {rows:[o]}=await db.query('INSERT INTO organizations(display_name,owner_user_id,legacy_workspace_id) VALUES($1,$2,$3) RETURNING id',['P08 Shadow',alice,w.id]);
      orgIds.push(o.id);
      await db.query("INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES($1,$2,'owner',CURRENT_TIMESTAMP)",[w.id,alice]);
      await db.query("INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES($1,$2,'member',CURRENT_TIMESTAMP)",[w.id,carol]);
      await db.query('INSERT INTO organization_workspaces(organization_id,workspace_id) VALUES($1,$2)',[o.id,w.id]);
      assert.equal(await access(o.id,carol,'link.read',{workspaceId:w.id}),true);
      assert.equal(await access(o.id,carol,'link.delete',{workspaceId:w.id}),false);
      assert.equal(await access(a,carol,'link.read',{workspaceId:w.id}),false,'other org cannot claim workspace');
      assert.equal(await access(o.id,bob,'link.read',{workspaceId:w.id}),false,'other org owner cannot see workspace');
      await db.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[w.id,carol]);
      assert.equal(await access(o.id,carol,'link.read',{workspaceId:w.id}),false,'legacy revoke is immediate');

      // The authorizer locks the member row during a write transaction.
      await locker.query('BEGIN');inTx=true;
      const locked=await loadContext({tx:get(locker),organizationId:a,userId:alice,mutation:true});
      assert.equal(locked?.role,'owner');
      await outsider.query('BEGIN');
      await outsider.query("SET LOCAL lock_timeout = '200ms'");
      await assert.rejects(
        outsider.query('DELETE FROM organization_members WHERE organization_id=$1 AND user_id=$2',[a,alice]),
        e=>e.code==='55P03'
      );
      await outsider.query('ROLLBACK');
      await locker.query('ROLLBACK');inTx=false;
      assert.equal(await access(a,alice,'organization.read'),true);
    }finally{
      if(inTx) await locker.query('ROLLBACK').catch(()=>{});
      for(const id of wsIds.reverse())await db.query('DELETE FROM workspaces WHERE id=$1',[id]).catch(()=>{});
      for(const id of orgIds.reverse())await db.query('DELETE FROM organizations WHERE id=$1',[id]).catch(()=>{});
      for(const id of ids.reverse())await db.query('DELETE FROM users WHERE id=$1',[id]).catch(()=>{});
      await outsider.end();await locker.end();await db.end();
    }
  });
