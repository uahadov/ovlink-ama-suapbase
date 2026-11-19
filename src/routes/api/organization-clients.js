'use strict';
// P10 gated logical client portfolio; never mutates legacy workspace ownership.
const express=require('express'),crypto=require('node:crypto');
const {withTransaction}=require('../../db/helpers');
const {requireSignedIn}=require('../../middleware/auth');
const {mutationLimiter,generalLimiter}=require('../../middleware/rate-limiter');
const {organizationClientsEnabled}=require('../../db/organization-model');
const {checkAccess,loadContext}=require('../../lib/organization-access-context');
const {encryptAES256GCM,blindIndex}=require('../../../utils/crypto');
const router=express.Router();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WRITE_ROLES=new Set(['owner','admin','manager']);
function uid(req){const id=Number(req.session?.userId);return Number.isSafeInteger(id)&&id>0?id:null}
function gate(req,res,next){if(!organizationClientsEnabled())return res.status(404).json({error:'Not found'});return next()}
const audit=(tx,org,actor,kind,info={})=>tx.run('INSERT INTO organization_audit_log(organization_id,event_key,actor_user_id,metadata_json) VALUES(?,?,?,?::jsonb)',[org,kind+'.'+crypto.randomUUID(),actor,JSON.stringify({kind,...info})]);
function validName(v){return typeof v==='string'&&v.trim().length>=2&&v.trim().length<=100&&!/[\u0000-\u001f\u007f]/.test(v)}
function validLogo(v){return v===null || (typeof v==='string'&&v.length<=500&&/^https:\/\/[A-Za-z0-9.-]+(?:\:[0-9]+)?(?:\/[^\s]*)?$/.test(v)&&!v.includes('@'))}
function validSettings(x){return x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).every(k=>['timezone','locale','report_frequency'].includes(k))&&(!x.timezone||typeof x.timezone==='string'&&x.timezone.length<=64)&&(!x.locale||['az','tr','en'].includes(x.locale))&&(!x.report_frequency||['none','weekly','monthly'].includes(x.report_frequency))}
const ids=req=>UUID.test(req.params.id||'')&&(!req.params.clientId||UUID.test(req.params.clientId));
async function scoped(tx,req,action,{includeArchived=false}={}){
 const user=uid(req),org=req.params.id;
 const ctx=await loadContext({tx,organizationId:org,userId:user,mutation:true});
 if(!ctx||!await checkAccess({tx,organizationId:org,userId:user,mutation:true},action))return null;
 const o=await tx.get("SELECT owner_user_id,legacy_workspace_id FROM organizations WHERE id=? AND state='active'",[org]);
 if(!o||o.legacy_workspace_id!==null)return null;
 let client=null;
 if(req.params.clientId){
  client=await tx.get('SELECT * FROM organization_client_spaces WHERE id=? AND organization_id=?'+(includeArchived?'':" AND status='active'"),[req.params.clientId,org]);
  if(!client)return null;
  if(!WRITE_ROLES.has(ctx.role)){
   const assigned=await tx.get('SELECT user_id FROM organization_client_members WHERE client_id=? AND user_id=?',[client.id,user]);
   if(!assigned)return null;
  }
 }
 return {org:o,ctx,client,actor:user};
}
const fault=(res)=>res.status(500).json({error:'Client portfolio unavailable'});
router.get('/api/organizations/:id/clients',gate,generalLimiter,requireSignedIn,async(req,res)=>{
 if(!ids(req))return res.status(404).json({error:'Not found'});
 try{
  const payload=await withTransaction(async tx=>{
   const s=await scoped(tx,req,'workspace.read',{includeArchived:true});if(!s)return null;
   const archived=['1','true'].includes(String(req.query?.include_archived||''));
   return tx.all(`SELECT c.id,c.display_name,c.logo_url,c.status,c.report_settings,c.created_at,
      (SELECT COUNT(*)::int FROM organization_client_campaigns occ WHERE occ.client_id=c.id) AS campaign_count,
      (SELECT COUNT(*)::int FROM organization_client_campaigns occ JOIN urls u ON u.campaign_id=occ.campaign_id WHERE occ.client_id=c.id) AS link_count
     FROM organization_client_spaces c WHERE c.organization_id=? ${archived?'':"AND c.status='active'"}
     ${WRITE_ROLES.has(s.ctx.role)?'':'AND EXISTS(SELECT 1 FROM organization_client_members cm WHERE cm.client_id=c.id AND cm.user_id=?)'}
     ORDER BY c.created_at,c.id`,WRITE_ROLES.has(s.ctx.role)?[req.params.id]:[req.params.id,s.actor]);
  });
  if(!payload)return res.status(404).json({error:'Not found'});res.set('Cache-Control','no-store');return res.json({clients:payload});
 }catch(_e){return fault(res)}
});
router.post('/api/organizations/:id/clients',gate,mutationLimiter,requireSignedIn,async(req,res)=>{
 if(!ids(req))return res.status(404).json({error:'Not found'});
 const b=req.body;
 if(!b||typeof b!=='object'||Array.isArray(b)||Object.keys(b).some(k=>!['name','contact_email','logo_url','report_settings'].includes(k))||!validName(b.name)||!validLogo(b.logo_url??null)||!validSettings(b.report_settings??{})||
  (b.contact_email!==undefined&&(typeof b.contact_email!=='string'||b.contact_email.length>254||!/^\S+@\S+\.\S+$/.test(b.contact_email))))return res.status(400).json({error:'Invalid client'});
 try{
  const row=await withTransaction(async tx=>{
   const s=await scoped(tx,req,'workspace.create');if(!s)return null;
   const count=await tx.get('SELECT COUNT(*)::int AS c FROM organization_client_spaces WHERE organization_id=?',[req.params.id]);
   if(Number(count.c)>=100)return {limit:true};
   const email=b.contact_email?.trim().toLowerCase();
   const c=await tx.get('INSERT INTO organization_client_spaces(organization_id,display_name,contact_encrypted,contact_hash,logo_url,report_settings,created_by_user_id) VALUES(?,?,?,?,?,?::jsonb,?) RETURNING id,display_name,status',[req.params.id,b.name.trim(),email?encryptAES256GCM(email):null,email?blindIndex(email):null,b.logo_url??null,JSON.stringify(b.report_settings??{}),s.actor]);
   await tx.run('INSERT INTO organization_client_members(client_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING',[c.id,s.actor]);
   await audit(tx,req.params.id,s.actor,'organization.client.created',{client_id:c.id});return c;
  });
  if(!row)return res.status(404).json({error:'Not found'});if(row.limit)return res.status(409).json({error:'Client limit reached'});
  res.set('Cache-Control','no-store');return res.status(201).json({client:row});
 }catch(_e){return fault(res)}
});
router.patch('/api/organizations/:id/clients/:clientId',gate,mutationLimiter,requireSignedIn,async(req,res)=>{
 if(!ids(req))return res.status(404).json({error:'Not found'});
 const b=req.body;if(!b||Array.isArray(b)||typeof b!=='object'||Object.keys(b).length===0||Object.keys(b).some(k=>!['name','contact_email','logo_url','report_settings'].includes(k))||
  (b.name!==undefined&&!validName(b.name))||(b.logo_url!==undefined&&!validLogo(b.logo_url))||(b.report_settings!==undefined&&!validSettings(b.report_settings))||
  (b.contact_email!==undefined&&b.contact_email!==null&&(typeof b.contact_email!=='string'||b.contact_email.length>254||!/^\S+@\S+\.\S+$/.test(b.contact_email))))return res.status(400).json({error:'Invalid client'});
 try{
  const result=await withTransaction(async tx=>{
   const s=await scoped(tx,req,'workspace.update',{includeArchived:true});if(!s)return null;
   const c=await tx.get(`UPDATE organization_client_spaces SET display_name=?, contact_encrypted=?,contact_hash=?,logo_url=?,report_settings=?::jsonb, updated_at=now()
     WHERE id=? AND organization_id=? RETURNING id,display_name,status,report_settings,logo_url`,[
     b.name===undefined?s.client.display_name:b.name.trim(),b.contact_email===undefined?s.client.contact_encrypted:b.contact_email?encryptAES256GCM(b.contact_email.trim().toLowerCase()):null,
     b.contact_email===undefined?s.client.contact_hash:b.contact_email?blindIndex(b.contact_email.trim().toLowerCase()):null,
     b.logo_url===undefined?s.client.logo_url:b.logo_url,JSON.stringify(b.report_settings===undefined?s.client.report_settings:b.report_settings),s.client.id,req.params.id]);
   await audit(tx,req.params.id,s.actor,'organization.client.updated',{client_id:c.id});return c;
  });if(!result)return res.status(404).json({error:'Not found'});res.set('Cache-Control','no-store');return res.json({client:result});
 }catch(_e){return fault(res)}
});
for(const action of ['archive','restore'])router.post(`/api/organizations/:id/clients/:clientId/${action}`,gate,mutationLimiter,requireSignedIn,async(req,res)=>{
 if(!ids(req))return res.status(404).json({error:'Not found'});
 try{
  const c=await withTransaction(async tx=>{
   const s=await scoped(tx,req,'workspace.update',{includeArchived:true});if(!s)return null;
   const status=action==='archive'?'archived':'active';
   const row=await tx.get("UPDATE organization_client_spaces SET status=?,archived_at=CASE WHEN ?='archived' THEN now() ELSE NULL END,updated_at=now() WHERE id=? AND organization_id=? RETURNING id,status",[status,status,s.client.id,req.params.id]);
   await audit(tx,req.params.id,s.actor,'organization.client.'+action,{client_id:s.client.id});return row;
  });if(!c)return res.status(404).json({error:'Not found'});return res.json({client:c,links_preserved:true});
 }catch(_e){return fault(res)}
});
router.post('/api/organizations/:id/clients/:clientId/assign',gate,mutationLimiter,requireSignedIn,async(req,res)=>{
 if(!ids(req)||!Number.isSafeInteger(Number(req.body?.user_id))||Number(req.body.user_id)<1)return res.status(400).json({error:'Invalid assignment'});
 try{const ok=await withTransaction(async tx=>{
  const s=await scoped(tx,req,'workspace.update',{includeArchived:true});if(!s)return false;
  const user=Number(req.body.user_id),m=await tx.get('SELECT user_id FROM organization_members WHERE organization_id=? AND user_id=?',[req.params.id,user]);if(!m)return false;
  await tx.run('INSERT INTO organization_client_members(client_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING',[s.client.id,user]);await audit(tx,req.params.id,s.actor,'organization.client.member_assigned',{client_id:s.client.id,user_id:user});return true;
 });return ok?res.json({assigned:true}):res.status(404).json({error:'Not found'});}catch(_e){return fault(res)}
});
router.get('/api/organizations/:id/clients/:clientId/campaigns',gate,generalLimiter,requireSignedIn,async(req,res)=>{
 if(!ids(req))return res.status(404).json({error:'Not found'});
 try{const rows=await withTransaction(async tx=>{
  const s=await scoped(tx,req,'campaign.read',{includeArchived:true});if(!s)return null;
  return tx.all('SELECT c.id,c.name,c.archived_at,(SELECT COUNT(*)::int FROM urls u WHERE u.campaign_id=c.id) AS link_count FROM organization_client_campaigns occ JOIN campaigns c ON c.id=occ.campaign_id WHERE occ.client_id=? ORDER BY c.id',[s.client.id]);
 });if(!rows)return res.status(404).json({error:'Not found'});res.set('Cache-Control','no-store');return res.json({campaigns:rows});}catch(_e){return fault(res)}
});
router.post('/api/organizations/:id/clients/:clientId/campaigns',gate,mutationLimiter,requireSignedIn,async(req,res)=>{
 if(!ids(req))return res.status(404).json({error:'Not found'});
 if(!validName(req.body?.name)||Object.keys(req.body||{}).some(k=>k!=='name'))return res.status(400).json({error:'Invalid campaign'});
 try{
  const row=await withTransaction(async tx=>{
   const s=await scoped(tx,req,'campaign.create');if(!s)return null;
   // Existing owner-owned campaign schema requires a unique (user_id,slug).
   const suffix=crypto.randomBytes(6).toString('hex');const name=req.body.name.trim();
   const campaign=await tx.get('INSERT INTO campaigns(user_id,name,slug,created_at) VALUES(?,?,?,?) RETURNING id,name',[s.org.owner_user_id,name,'agency-'+suffix,new Date().toISOString()]);
   await tx.run('INSERT INTO organization_client_campaigns(client_id,campaign_id) VALUES(?,?)',[s.client.id,campaign.id]);
   await audit(tx,req.params.id,s.actor,'organization.client.campaign_created',{client_id:s.client.id,campaign_id:campaign.id});return campaign;
  });if(!row)return res.status(404).json({error:'Not found'});return res.status(201).json({campaign:row});
 }catch(_e){return fault(res)}
});
router.post('/api/organizations/:id/clients/:clientId/transfer',gate,mutationLimiter,requireSignedIn,async(req,res)=>{
 if(!ids(req)||!UUID.test(req.body?.target_organization_id||''))return res.status(400).json({error:'Invalid transfer'});
 try{
  const done=await withTransaction(async tx=>{
   const s=await scoped(tx,req,'workspace.update',{includeArchived:true});if(!s||req.body.target_organization_id===req.params.id)return false;
   const other=req.body.target_organization_id;
   if(!await checkAccess({tx,organizationId:other,userId:s.actor,mutation:true},'workspace.create'))return false;
   const target=await tx.get("SELECT owner_user_id,legacy_workspace_id FROM organizations WHERE id=? AND state='active' FOR SHARE",[other]);
   // Campaigns remain tied to the same account; refuse transfers across owners.
   if(!target||target.legacy_workspace_id!==null||target.owner_user_id!==s.org.owner_user_id)return false;
   await tx.run('UPDATE organization_client_spaces SET organization_id=?,updated_at=now() WHERE id=? AND organization_id=?',[other,s.client.id,req.params.id]);
   await tx.run('DELETE FROM organization_client_members WHERE client_id=? AND user_id NOT IN (SELECT user_id FROM organization_members WHERE organization_id=?)',[s.client.id,other]);
   await audit(tx,req.params.id,s.actor,'organization.client.transferred_out',{client_id:s.client.id,target_organization_id:other});
   await audit(tx,other,s.actor,'organization.client.transferred_in',{client_id:s.client.id,source_organization_id:req.params.id});return true;
  });return done?res.json({transferred:true,links_preserved:true}):res.status(404).json({error:'Not found'});
 }catch(_e){return fault(res)}
});
module.exports=router;
