'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {ACTIONS,ROLE_GRANTS,resolveRole,can,authorize}=require('../src/lib/organization-permissions');
const roles=['owner','admin','manager','analyst','client_viewer'];
const baseline={organizationId:'org-a',requestedOrganizationId:'org-a',active:true,membershipActive:true,role:'owner'};

test('P08 proposal: defined actions, canonical roles and no unknown grants',()=>{
  assert.equal(new Set(ACTIONS).size,ACTIONS.length);
  for(const role of roles) {
    assert.ok(ROLE_GRANTS[role].every(a=>ACTIONS.includes(a)));
    assert.equal(resolveRole(role),role);
  }
  for(const action of ACTIONS) assert.equal(can('owner',action),true);
  for(const role of [null,undefined,'OWNER','member','__proto__','constructor','',0])
    assert.equal(can(role,'campaign.read'),false);
  assert.equal(can('owner','undefined.action'),false);
});

test('P08 proposal: sensitive actions restricted, view-only cannot mutate',()=>{
  assert.equal(can('owner','organization.delete'),true);
  assert.equal(can('admin','organization.delete'),false);
  assert.equal(can('admin','billing.manage'),false);
  assert.equal(can('manager','billing.manage'),false);
  assert.equal(can('analyst','campaign.create'),false);
  assert.equal(can('client_viewer','analytics.export'),false);
  assert.equal(can('client_viewer','link.delete'),false);
  assert.equal(can('client_viewer','report.read'),true);
  assert.equal(can('manager','campaign.create'),true);
  assert.equal(can('analyst','analytics.read'),true);
});

test('P08 proposal: legacy member never silently granted manager writes',()=>{
  assert.equal(resolveRole('member',{legacy:true}),'analyst');
  assert.equal(can('member','campaign.read',{legacy:true}),true);
  assert.equal(can('member','campaign.delete',{legacy:true}),false);
  assert.equal(can('owner','billing.manage',{legacy:true}),true);
  assert.equal(can('admin','billing.manage',{legacy:true}),false);
});

test('P08 proposal: missing, suspended or revoked membership fail closed',()=>{
  assert.equal(authorize(baseline,'campaign.read'),true);
  assert.equal(authorize({...baseline,active:false},'campaign.read'),false);
  assert.equal(authorize({...baseline,membershipActive:false},'campaign.read'),false);
  assert.equal(authorize({...baseline,requestedOrganizationId:'org-b'},'campaign.read'),false);
  assert.equal(authorize({...baseline,role:'alien'},'campaign.read'),false);
  assert.equal(authorize(null,'campaign.read'),false);
});

test('P08 proposal: cross-client workspace must not leak',()=>{
  const scoped={...baseline,workspaceBound:true,workspaceId:21,requestedWorkspaceId:21,workspaceMembershipActive:true};
  assert.equal(authorize(scoped,'report.read'),true);
  assert.equal(authorize({...scoped,requestedWorkspaceId:22},'report.read'),false);
  assert.equal(authorize({...scoped,workspaceMembershipActive:false},'report.read'),false);
  assert.equal(authorize({...scoped,role:'client_viewer'},'report.read'),true);
  assert.equal(authorize({...scoped,role:'client_viewer'},'report.schedule'),false);
});

test('P08 proposal: no more permission for lower privilege',()=>{
  for (const r of ['admin','manager','analyst','client_viewer'])
    for (const a of ACTIONS) if(can(r,a)) assert.equal(can('owner',a),true);
});
