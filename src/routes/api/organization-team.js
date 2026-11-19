'use strict';
// P09 isolated opt-in team lifecycle. No changes to legacy workspaces.
const express=require('express');
const crypto=require('node:crypto');
const {withTransaction}=require('../../db/helpers');
const {requireSignedIn}=require('../../middleware/auth');
const {mutationLimiter,generalLimiter}=require('../../middleware/rate-limiter');
const {organizationTeamEnabled}=require('../../db/organization-model');
const {checkAccess}=require('../../lib/organization-access-context');
const {blindIndex,encryptAES256GCM,decryptAES256GCM}=require('../../../utils/crypto');
const {sendMail}=require('../../lib/email');
const {buildAbsoluteUrl}=require('../../lib/security');
const router=express.Router();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES=new Set(['admin','manager','analyst','client_viewer']);
const LIMIT=25;
function auth(req,res,next){if(!organizationTeamEnabled())return res.status(404).json({error:'Not found'});return next()}
function uid(req){const n=Number(req.session?.userId);return Number.isSafeInteger(n)&&n>0?n:null}
const audit=(tx,org,user,kind,details={})=>tx.run('INSERT INTO organization_audit_log(organization_id,event_key,actor_user_id,metadata_json) VALUES (?,?,?,?::jsonb)',[org,kind+'.'+crypto.randomUUID(),user,JSON.stringify({kind,...details})]);
const handle=(res,e)=>res.status(500).json({error:'Organization team request failed'});
async function gate(tx,org,user,action){
 const allowed=await checkAccess({tx,organizationId:org,userId:user,mutation:true},action);
 if(!allowed)return null;
 const row=await tx.get("SELECT legacy_workspace_id,display_name,owner_user_id FROM organizations WHERE id=? AND state='active' FOR SHARE",[org]);
 return row&&!row.legacy_workspace_id?row:null;
}
// View membership and pending invitations; no token or contact PII returned.
router.get('/api/organizations/:id/team',auth,generalLimiter,requireSignedIn,async(req,res)=>{
 if(!UUID.test(req.params.id))return res.status(404).json({error:'Not found'});
 try{
  const data=await withTransaction(async tx=>{
   if(!(await gate(tx,req.params.id,uid(req),'member.read')))return null;
   const members=await tx.all('SELECT user_id,role,created_at FROM organization_members WHERE organization_id=? ORDER BY created_at,user_id',[req.params.id]);
   const invites=await tx.all("SELECT id,role,expires_at,accepted_at,revoked_at,created_at FROM organization_invitations WHERE organization_id=? ORDER BY created_at DESC LIMIT 100",[req.params.id]);
   return {members,invites};
  });
  if(!data)return res.status(404).json({error:'Not found'});
  res.set('Cache-Control','no-store');return res.json(data);
 }catch(e){return handle(res,e)}
});
router.post('/api/organizations/:id/invitations',auth,mutationLimiter,requireSignedIn,async(req,res)=>{
 const org=req.params.id,role=req.body?.role,email=typeof req.body?.email==='string'?req.body.email.trim().toLowerCase():'';
 if(!UUID.test(org))return res.status(404).json({error:'Not found'});
 if(!req.body||Object.keys(req.body).length!==2||!ROLES.has(role)||!/^\S+@\S+\.\S+$/.test(email)||email.length>254)return res.status(400).json({error:'Invalid invitation'});
 try{
  const emailHash=blindIndex(email),raw=crypto.randomBytes(32).toString('base64url'),tokenHash=crypto.createHash('sha256').update(raw).digest('hex');
  const outcome=await withTransaction(async tx=>{
   const actor=uid(req),o=await gate(tx,org,actor,'member.invite');
   if(!o)return {status:404};
   if(role==='admin'&&o.owner_user_id!==actor)return {status:403};
   // Serialize invite counts and duplicate emails on the org row.
   await tx.get('SELECT id FROM organizations WHERE id=? FOR UPDATE',[org]);
   const member=await tx.get('SELECT id FROM users WHERE email_hash=? LIMIT 1',[emailHash]);
   if(member&&await tx.get('SELECT user_id FROM organization_members WHERE organization_id=? AND user_id=?',[org,member.id]))return {status:409};
   const exists=await tx.get('SELECT id FROM organization_invitations WHERE organization_id=? AND email_hash=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now() LIMIT 1',[org,emailHash]);
   if(exists)return {status:409};
   const count=await tx.get('SELECT (SELECT COUNT(*)::int FROM organization_members WHERE organization_id=?) + (SELECT COUNT(*)::int FROM organization_invitations WHERE organization_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>now()) AS c',[org,org]);
   if(Number(count.c)>=LIMIT)return {status:409};
   const invite=await tx.get("INSERT INTO organization_invitations(organization_id,email_hash,email_encrypted,token_hash,role,invited_by_user_id,expires_at) VALUES(?,?,?,?,?,?,now()+interval '7 days') RETURNING id,expires_at",[org,emailHash,encryptAES256GCM(email),tokenHash,role,actor]);
   await audit(tx,org,actor,'organization.invitation.created',{invite_id:invite.id,role});
   return {status:201,invite,orgName:o.display_name};
  });
  if(outcome.status!==201)return res.status(outcome.status).json({error:outcome.status===404?'Not found':'Invitation unavailable'});
  const url=buildAbsoluteUrl(req,'/workspaces/accept-organization?token='+encodeURIComponent(raw));
  // Delivery can fail; never claim sent without transport acknowledgement.
  let sent=false;
  try{await sendMail({to:email,subject:'Ovlink organization invitation: '+outcome.orgName,text:`You were invited to join ${outcome.orgName} as ${role}. Sign in using this exact email and open: ${url}\nThis invitation expires in 7 days.`,html:null});sent=true;}catch(_e){}
  res.set('Cache-Control','no-store');return res.status(sent?201:202).json({invitation:{id:outcome.invite.id,role,expires_at:outcome.invite.expires_at},email_sent:sent,delivery_confirmed:false});
 }catch(e){return handle(res,e)}
});
// A pending invitation is bound to the currently verified account's email_hash;
// future signups can accept after verifying that address. No self-selected role.
async function acceptTeamInvite(token,userId){
  const hash=crypto.createHash('sha256').update(token).digest('hex');
  return withTransaction(async tx=>{
   const invitation=await tx.get('SELECT * FROM organization_invitations WHERE token_hash=? FOR UPDATE',[hash]);
   if(!invitation||invitation.revoked_at||invitation.accepted_at||new Date(invitation.expires_at).getTime()<=Date.now())return null;
   const person=await tx.get('SELECT id,email_hash,email_verified FROM users WHERE id=? FOR SHARE',[userId]);
   if(!person||Number(person.email_verified)!==1||person.email_hash!==invitation.email_hash)return null;
   const organization=await tx.get("SELECT id,legacy_workspace_id FROM organizations WHERE id=? AND state='active' FOR SHARE",[invitation.organization_id]);
   if(!organization||organization.legacy_workspace_id!==null)return null;
   const already=await tx.get('SELECT user_id FROM organization_members WHERE organization_id=? AND user_id=?',[organization.id,person.id]);
   if(already)return null;
   const count=await tx.get('SELECT COUNT(*)::int AS c FROM organization_members WHERE organization_id=?',[organization.id]);
   if(Number(count.c)>=LIMIT)return null;
   await tx.run('INSERT INTO organization_members(organization_id,user_id,role) VALUES(?,?,?)',[organization.id,person.id,invitation.role]);
   await tx.run('UPDATE organization_invitations SET accepted_at=now() WHERE id=?',[invitation.id]);
   await audit(tx,organization.id,person.id,'organization.invitation.accepted',{invitation_id:invitation.id,role:invitation.role});
   return {organization_id:organization.id,role:invitation.role};
  });
}
router.post('/api/organizations/invitations/accept',auth,mutationLimiter,requireSignedIn,async(req,res)=>{
 const token=req.body?.token;
 if(typeof token!=='string'||token.length<20||token.length>200)return res.status(400).json({error:'Invalid invitation'});
 try{
  const state=await acceptTeamInvite(token,uid(req));
  if(!state)return res.status(404).json({error:'Not found'});
  res.set('Cache-Control','no-store');return res.status(200).json(state);
 }catch(e){return handle(res,e)}
});
router.post('/workspaces/accept-organization',auth,mutationLimiter,requireSignedIn,async(req,res)=>{
 const token=req.body?.token;
 if(typeof token!=='string'||token.length<20||token.length>200)return res.status(400).json({error:'Invalid invitation'});
 try{
  await acceptTeamInvite(token,uid(req));
  // A consumed token is only displayed as accepted to its verified recipient.
  res.set('Cache-Control','no-store');return res.redirect(303,'/workspaces/accept-organization?token='+encodeURIComponent(token));
 }catch(e){return handle(res,e)}
});
router.delete('/api/organizations/:id/invitations/:invite',auth,mutationLimiter,requireSignedIn,async(req,res)=>{
 if(!UUID.test(req.params.id)||!UUID.test(req.params.invite))return res.status(404).json({error:'Not found'});
 try{
  const yes=await withTransaction(async tx=>{
   if(!(await gate(tx,req.params.id,uid(req),'member.invite')))return false;
   const row=await tx.get('UPDATE organization_invitations SET revoked_at=now() WHERE id=? AND organization_id=? AND revoked_at IS NULL AND accepted_at IS NULL RETURNING id',[req.params.invite,req.params.id]);
   if(!row)return false;
   await audit(tx,req.params.id,uid(req),'organization.invitation.revoked',{invitation_id:row.id});return true;
  });
  return yes?res.json({revoked:true}):res.status(404).json({error:'Not found'});
 }catch(e){return handle(res,e)}
});
// Reissue replaces the old bearer token immediately; never email stale tokens.
router.post('/api/organizations/:id/invitations/:invite/reissue',auth,mutationLimiter,requireSignedIn,async(req,res)=>{
 const org=req.params.id,inv=req.params.invite;
 if(!UUID.test(org)||!UUID.test(inv))return res.status(404).json({error:'Not found'});
 try{
  const raw=crypto.randomBytes(32).toString('base64url'),hash=crypto.createHash('sha256').update(raw).digest('hex');
  const result=await withTransaction(async tx=>{
   const o=await gate(tx,org,uid(req),'member.invite');if(!o)return null;
   const row=await tx.get('SELECT id,email_encrypted,role,accepted_at,revoked_at FROM organization_invitations WHERE organization_id=? AND id=? FOR UPDATE',[org,inv]);
   if(!row||row.revoked_at||row.accepted_at)return null;
   if(row.role==='admin'&&uid(req)!==o.owner_user_id)return null;
   await tx.run("UPDATE organization_invitations SET token_hash=?, expires_at=now()+interval '7 days' WHERE id=?",[hash,inv]);
   await audit(tx,org,uid(req),'organization.invitation.reissued',{invitation_id:inv});
   return {email:decryptAES256GCM(row.email_encrypted),name:o.display_name,role:row.role};
  });
  if(!result)return res.status(404).json({error:'Not found'});
  const url=buildAbsoluteUrl(req,'/workspaces/accept-organization?token='+encodeURIComponent(raw));
  let sent=false;
  try{await sendMail({to:result.email,subject:'Ovlink renewed invitation: '+result.name,text:`Your invitation to ${result.name} as ${result.role} was renewed. Sign in with this email and open: ${url}
Expires in seven days.`,html:null});sent=true;}catch(_e){}
  res.set('Cache-Control','no-store');return res.status(sent?200:202).json({reissued:true,email_sent:sent,delivery_confirmed:false});
 }catch(e){return handle(res,e)}
});

// Ownership transfer is owner-only; preserve previous owner as admin and
// keep customer campaigns/workspace links intact. Billing owner remains unchanged.
router.post('/api/organizations/:id/transfer-owner',auth,mutationLimiter,requireSignedIn,async(req,res)=>{
 const org=req.params.id,target=Number(req.body?.target_user_id);
 if(!UUID.test(org))return res.status(404).json({error:'Not found'});
 if(!req.body||Object.keys(req.body).length!==1||!Number.isSafeInteger(target)||target<1)return res.status(400).json({error:'Invalid target'});
 try{
  const status=await withTransaction(async tx=>{
   const actor=uid(req);
   if(!(await checkAccess({tx,organizationId:org,userId:actor,mutation:true},'member.change_role')))return 404;
   const o=await tx.get("SELECT owner_user_id,legacy_workspace_id FROM organizations WHERE id=? AND state='active' FOR UPDATE",[org]);
   if(!o||o.legacy_workspace_id!==null||o.owner_user_id!==actor||target===actor)return 404;
   const verified=await tx.get('SELECT id,email_verified FROM users WHERE id=? FOR SHARE',[target]);
   const member=await tx.get('SELECT role FROM organization_members WHERE organization_id=? AND user_id=? FOR UPDATE',[org,target]);
   if(!verified||Number(verified.email_verified)!==1||!member)return 404;
   await tx.run("UPDATE organization_members SET role='admin' WHERE organization_id=? AND user_id=?",[org,actor]);
   await tx.run("UPDATE organization_members SET role='owner' WHERE organization_id=? AND user_id=?",[org,target]);
   await tx.run('UPDATE organizations SET owner_user_id=? WHERE id=?',[target,org]);
   await audit(tx,org,actor,'organization.owner.transferred',{old_owner_user_id:actor,new_owner_user_id:target,billing_owner_unchanged:true});
   return 200;
  });
  return status===200?res.json({transferred:true,new_owner_user_id:target,billing_owner_unchanged:true}):res.status(404).json({error:'Not found'});
 }catch(e){return handle(res,e)}
});

router.patch('/api/organizations/:id/members/:userId',auth,mutationLimiter,requireSignedIn,async(req,res)=>{
 const org=req.params.id,target=Number(req.params.userId),role=req.body?.role;
 if(!UUID.test(org)||!Number.isSafeInteger(target)||target<1)return res.status(404).json({error:'Not found'});
 if(!req.body||Object.keys(req.body).length!==1||!ROLES.has(role))return res.status(400).json({error:'Invalid role'});
 try{
  const outcome=await withTransaction(async tx=>{
   const o=await gate(tx,org,uid(req),'member.change_role');if(!o)return 404;
   const row=await tx.get('SELECT role FROM organization_members WHERE organization_id=? AND user_id=? FOR UPDATE',[org,target]);
   if(!row||row.role==='owner'||target===o.owner_user_id)return 404;
   if(row.role===role)return 200;
   await tx.run('UPDATE organization_members SET role=? WHERE organization_id=? AND user_id=?',[role,org,target]);
   await audit(tx,org,uid(req),'organization.member.role_changed',{target_user_id:target,old_role:row.role,new_role:role});return 200;
  });
  return outcome===200?res.json({updated:true,role}):res.status(404).json({error:'Not found'});
 }catch(e){return handle(res,e)}
});
router.delete('/api/organizations/:id/members/:userId',auth,mutationLimiter,requireSignedIn,async(req,res)=>{
 const org=req.params.id,target=req.params.userId==='me'?uid(req):Number(req.params.userId);
 if(!UUID.test(org)||!Number.isSafeInteger(target)||target<1)return res.status(404).json({error:'Not found'});
 try{
  const outcome=await withTransaction(async tx=>{
   const actor=uid(req),self=actor===target;
   const o=await gate(tx,org,actor,self?'member.read':'member.remove');if(!o)return 404;
   if(target===o.owner_user_id)return 403;
   const row=await tx.get('SELECT role FROM organization_members WHERE organization_id=? AND user_id=? FOR UPDATE',[org,target]);
   if(!row||row.role==='owner')return 404;
   if(!self&&row.role==='admin'&&actor!==o.owner_user_id)return 403;
   await tx.run('DELETE FROM organization_members WHERE organization_id=? AND user_id=?',[org,target]);
   await audit(tx,org,actor,'organization.member.removed',{target_user_id:target});return 200;
  });
  return outcome===200?res.json({removed:true}):res.status(outcome).json({error:outcome===403?'Owner cannot be removed':'Not found'});
 }catch(e){return handle(res,e)}
});
module.exports=router;
