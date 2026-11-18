'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {loadContext,checkAccess}=require('../src/lib/organization-access-context');
const org='123e4567-e89b-42d3-a456-426614174000';
const orgB='123e4567-e89b-42d3-a456-426614174001';
function fake({legacy=false,role='owner',orgState='active',workspace=true,member=true}={}) {
  const calls=[];
  const tx={get:async(sql,params)=>{
    calls.push({sql,params});
    if(sql.includes('FROM organizations')) return {id:org,state:orgState,legacy_workspace_id:legacy?10:null};
    if(sql.includes('FROM organization_members')||sql.includes('FROM workspace_members WHERE')) return member?{role}:undefined;
    if(sql.includes('FROM organization_workspaces')) return workspace?{workspace_id:10}:undefined;
    throw new Error('unrecognized query');
  }};
  return {tx,calls};
}
const args=(tx, extra={})=>({tx,organizationId:org,userId:1,...extra});

test('P08 DB source: current organization membership controls role, not session role',async()=>{
  const {tx,calls}=fake({role:'analyst'});
  assert.equal(await checkAccess(args(tx),'campaign.read'),true);
  assert.equal(await checkAccess(args(tx),'campaign.delete'),false);
  assert.ok(calls.some(x=>x.sql.includes('organization_members')&&x.params[1]===1));
});

test('P08 DB source: legacy organization uses live workspace membership',async()=>{
  const f=fake({legacy:true,role:'member'});
  assert.equal(await checkAccess(args(f.tx),'link.read'),true);
  assert.equal(await checkAccess(args(f.tx),'link.delete'),false);
  assert.ok(f.calls.some(x=>x.sql.includes('workspace_members WHERE')));
  assert.ok(!f.calls.some(x=>x.sql.includes('organization_members')));
});

test('P08 DB source: revoked or suspended membership fails closed',async()=>{
  for(const p of [{member:false},{orgState:'suspended'},{legacy:true,member:false}]) {
    assert.equal(await loadContext(args(fake(p).tx)),null);
  }
});

test('P08 DB source: only in-org workspaces with active current user membership',async()=>{
  const valid=fake();
  assert.equal(await checkAccess(args(valid.tx,{workspaceId:10}),'report.read'),true);
  const denied=fake({workspace:false});
  assert.equal(await loadContext(args(denied.tx,{workspaceId:10})),null);
});

test('P08 DB source: invalid IDs reject before executing database query',async()=>{
  const f=fake();
  for(const opts of [{organizationId:'oops'},{userId:0},{userId:1.2},{workspaceId:'10'}, {organizationId:orgB+'no'}])
    assert.equal(await loadContext(args(f.tx,opts)),null);
  assert.equal(f.calls.length,0);
});

test('P08 DB source: mutation locks organization and membership and workspace',async()=>{
  const f=fake();
  const context=await loadContext(args(f.tx,{workspaceId:10,mutation:true}));
  assert.equal(context.active,true);
  assert.equal(f.calls.length,3);
  assert.ok(f.calls[0].sql.includes('FOR SHARE'));
  assert.ok(f.calls[1].sql.includes('FOR SHARE'));
  assert.ok(f.calls[2].sql.includes('FOR SHARE OF ow, wm'));
});

test('P08 DB source: normal read path does not lock member rows',async()=>{
  const f=fake();
  await loadContext(args(f.tx));
  assert.ok(f.calls.every(x=>!x.sql.includes('FOR SHARE')));
});

test('P08 DB source: invalid injected tx rejects',async()=>{
  assert.equal(await loadContext(args(null)),null);
  assert.equal(await loadContext(args({get:null})),null);
});
