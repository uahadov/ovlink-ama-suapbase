'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ACTIONS, ROLE_GRANTS, can, resolveRole } = require('../src/lib/organization-permissions');
const migration=fs.readFileSync(path.join(__dirname,'../src/db/organization-roles-p08.sql'),'utf8');
const {organizationRbacV2Enabled,migrateOrganizationRoles}=require('../src/db/organization-model');

test('P08: five canonical roles have a non-empty distinct allow matrix',()=>{
  assert.deepEqual(Object.keys(ROLE_GRANTS).sort(),['admin','analyst','client_viewer','manager','owner']);
  for(const role of Object.keys(ROLE_GRANTS)) {
    assert.ok(ROLE_GRANTS[role].length>0);
    for(const action of ACTIONS) assert.equal(can(role,action),ROLE_GRANTS[role].includes(action),`${role} ${action}`);
    assert.equal(can(role,'other.action'),false);
  }
  assert.equal(can('member','workspace.read'),false,'new-org member is not canonical');
  assert.equal(resolveRole('member',{legacy:true}),'analyst');
  assert.equal(can('member','link.delete',{legacy:true}),false);
  assert.equal(can('client_viewer','analytics.export'),false);
  assert.equal(can('owner','billing.manage'),true);
  assert.equal(can('admin','billing.manage'),false);
});

test('P08: staged migration retains legacy member without expanding policy grants',()=>{
  assert.match(migration,/BEGIN;/);
  assert.match(migration,/COMMIT;/);
  assert.match(migration,/role IN \('owner','admin','manager','analyst','client_viewer','member'\)/);
  assert.match(migration,/organization_members_role_check/);
  assert.match(migration,/RAISE EXCEPTION 'P08 unexpected role constraint/);
  assert.doesNotMatch(migration,/UPDATE\s+(users|workspaces|workspace_members|campaigns|urls)\b/i);
});


test('P08: five-role upgrade opt-in is independently gated, default OFF',async()=>{
  assert.equal(organizationRbacV2Enabled({}),false);
  assert.equal(organizationRbacV2Enabled({ENABLE_ORGANIZATION_MODEL:'1'}),false);
  assert.equal(organizationRbacV2Enabled({ENABLE_ORGANIZATION_RBAC_V2:'1'}),false);
  assert.equal(organizationRbacV2Enabled({ENABLE_ORGANIZATION_MODEL:'1',ENABLE_ORGANIZATION_RBAC_V2:'1'}),true);
  let connected=false;
  const clientPool={connect:async()=>{connected=true;throw Error('unexpected DB connection')}};
  await assert.rejects(migrateOrganizationRoles({clientPool,env:{ENABLE_ORGANIZATION_MODEL:'1'}}),/requires both/);
  assert.equal(connected,false,'disabled v2 must never open DB connection');
});
