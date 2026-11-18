'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { Client } = require('pg');
const { randomBytes } = require('crypto');
const { migrateOrganizationModel, organizationFeatureEnabled } = require('../src/db/organization-model');

const target = process.env.DATABASE_URL || '';
const safeDb = /^postgresql:\/\/ovlinkqa:[^@]+@localhost:55491\/ovlink_p02_qa$/.test(target);
test('P07: opt-in organization CRUD shell, membership isolation, legacy-Pro ownership', {
  skip: !safeDb && 'Requires isolated P03/P04 localhost QA credentials',
  timeout: 45000,
}, async () => {
  assert.equal(organizationFeatureEnabled(), true, 'QA must enable feature explicitly');
  const db = new Client({ connectionString: target });
  await db.connect();
  const suffix = randomBytes(6).toString('hex');
  const users = [];
  const created = [];
  let server;
  try {
    await migrateOrganizationModel();
    const newUser = async (tag,plan) => {
      const row = await db.query(
        "INSERT INTO users(email,email_verified,plan_tier,plan_status,created_at) VALUES($1,1,$2,'active',$3) RETURNING id",
        [`p07-${tag}-${suffix}@example.invalid`, plan, new Date().toISOString()]
      );
      users.push(row.rows[0].id);
      return row.rows[0].id;
    };
    const alice=await newUser('alice','pro'), bob=await newUser('bob','pro'), outsider=await newUser('outsider','free');
    const app=express();
    app.use(express.json());
    app.use((req,_res,next)=>{req.session={userId:Number(req.get('x-test-user')||0)};next();});
    app.use(require('../src/routes/api/organizations'));
    server=app.listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    const url=`http://127.0.0.1:${server.address().port}`;
    async function api(uid,method,path,body) {
      const response=await fetch(url+path,{method,headers:{'x-test-user':String(uid),'content-type':'application/json'},
        body:body?JSON.stringify(body):undefined});
      const b=await response.json();
      return {status:response.status,body:b,headers:response.headers};
    }

    assert.equal((await api(outsider,'POST','/api/organizations',{name:'Should Deny'})).status,403,'Free user cannot own new organization');
    assert.equal((await api(alice,'POST','/api/organizations',{name:'  a  '})).status,400,'Name constraint');
    const a=await api(alice,'POST','/api/organizations',{name:'Alpha Agency'});
    assert.equal(a.status,201,JSON.stringify(a));
    created.push(a.body.organization.id);
    assert.equal(a.body.organization.role,'owner');
    const b=await api(bob,'POST','/api/organizations',{name:'Bravo Agency'});
    assert.equal(b.status,201,JSON.stringify(b));
    created.push(b.body.organization.id);
    assert.notEqual(created[0],created[1]);
    assert.equal((await api(outsider,'GET','/api/organizations')).body.organizations.length,0);
    const alist=await api(alice,'GET','/api/organizations');
    assert.equal(alist.status,200);
    assert.ok(alist.body.organizations.some(x=>x.id===created[0]));
    assert.ok(!alist.body.organizations.some(x=>x.id===created[1]));
    assert.equal((await api(alice,'GET',`/api/organizations/${created[0]}`)).status,200);
    assert.equal((await api(alice,'GET',`/api/organizations/${created[1]}`)).status,404);
    assert.equal((await api(outsider,'GET',`/api/organizations/${created[0]}`)).status,404);
    assert.equal((await api(alice,'GET','/api/organizations/not-a-uuid')).status,404);

    const billing=await db.query('SELECT organization_id,billing_owner_user_id,billing_mode,provider_customer_id FROM organization_billing WHERE organization_id=ANY($1::uuid[])',[created]);
    assert.equal(billing.rowCount,2);
    assert.ok(billing.rows.every(x=>x.billing_mode==='legacy_user_pro' && x.provider_customer_id===null));
    const events=await db.query("SELECT organization_id FROM organization_audit_log WHERE organization_id=ANY($1::uuid[]) AND event_key='organization.created'",[created]);
    assert.equal(events.rowCount,2);
    const personal=await db.query('SELECT COUNT(*)::int AS n FROM urls WHERE workspace_id IS NULL');
    assert.ok(personal.rows[0].n >= 0);

    // Repeat additive migration; newly created organization IDs must be stable.
    await migrateOrganizationModel();
    const check=await db.query('SELECT id FROM organizations WHERE id=ANY($1::uuid[])',[created]);
    assert.equal(check.rowCount,2);

    // Feature flag OFF must not disclose existing private organization.
    process.env.ENABLE_ORGANIZATION_MODEL='0';
    assert.equal((await api(alice,'GET','/api/organizations')).status,404);
    process.env.ENABLE_ORGANIZATION_MODEL='1';
  } finally {
    process.env.ENABLE_ORGANIZATION_MODEL='1';
    if(server)await new Promise(resolve=>server.close(resolve));
    for (const id of created) {
      for (const table of ['organization_audit_log','organization_billing','organization_settings','organization_members']) {
        await db.query(`DELETE FROM ${table} WHERE organization_id=$1`,[id]).catch(()=>{});
      }
      await db.query('DELETE FROM organizations WHERE id=$1',[id]).catch(()=>{});
    }
    for (const id of users) await db.query('DELETE FROM users WHERE id=$1',[id]).catch(()=>{});
    await db.end();
    await require('../src/db/pool').pool.end().catch(()=>{});
  }
});
