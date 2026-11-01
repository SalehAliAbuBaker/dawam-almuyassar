/* MB10 phase-2 staging import. Dedicated bearer secret: MB10_IMPORT_TOKEN.
   Does not change payroll or punch_events; raw immutable device punches only. */
const ORG = 'org_main';
const DEVICE_ID = 'mb10-main';
const MAX_ITEMS = 100;
const te = new TextEncoder();
const json = (body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
function equal(a,b){
  const x=te.encode(a), y=te.encode(b);
  let n=x.length^y.length;
  for(let i=0;i<Math.max(x.length,y.length);i++)n|=(x[i]||0)^(y[i]||0);
  return n===0;
}
function validTimestamp(s) {
  if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(s))return false;
  const d=new Date(s+'Z');
  return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,19)===s;
}
export async function onRequestPost({request,env}) {
  if(!env.DB)return json({error:'D1 not configured'},503);
  const secret=env.MB10_IMPORT_TOKEN;
  const auth=request.headers.get('authorization')||'';
  if(typeof secret!=='string'||secret.length<32)return json({error:'Import not configured'},503);
  // The backup PC has a separately revocable credential. Both upload to the
  // SAME device_id using unchanged fingerprints, so re-import is idempotent.
  const backupSecret=env.MB10_BACKUP_TOKEN;
  const token=auth.startsWith('Bearer ')?auth.slice(7):'';
  const primaryOk=equal(token,secret);
  const backupOk=typeof backupSecret==='string'&&backupSecret.length>=32&&equal(token,backupSecret);
  if(!primaryOk&&!backupOk)return json({error:'Unauthorized'},401);
  if(!(request.headers.get('content-type')||'').toLowerCase().startsWith('application/json'))return json({error:'JSON required'},415);
  let data;
  try{
    const source=await request.text();
    if(source.length>60000)return json({error:'Batch too large'},413);
    data=JSON.parse(source);
  }catch{return json({error:'Invalid JSON'},400);}
  if(!data||!Array.isArray(data.items)||data.items.length<1||data.items.length>MAX_ITEMS)return json({error:'1-100 items required'},400);
  const prepared=[];
  for(const item of data.items) {
    if(!item||typeof item.device_user_id!=='string'||!/^.{1,80}$/.test(item.device_user_id)
      ||!validTimestamp(item.occurred_at_device)
      ||typeof item.event_fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(item.event_fingerprint)
      ||!(item.status_code===null||Number.isInteger(item.status_code)&&item.status_code>=0&&item.status_code<=255)
      ||!(item.punch_code===null||Number.isInteger(item.punch_code)&&item.punch_code>=0&&item.punch_code<=255))
      return json({error:'Invalid item fields'},400);
    prepared.push(item);
  }
  try {
    const db=env.DB;
    await db.prepare("INSERT OR IGNORE INTO biometric_devices (id,organization_id,label,device_ip_hint,timezone,time_authority) VALUES (?,?,'ZKTeco MB10',NULL,'Asia/Aden','device')").bind(DEVICE_ID,ORG).run();
    const stmts=prepared.map(item=>db.prepare(
      "INSERT OR IGNORE INTO device_raw_punches (id,organization_id,device_id,event_fingerprint,device_user_id,occurred_at_device,status_code,punch_code) VALUES (?,?,?,?,?,?,?,?)"
    ).bind(crypto.randomUUID(),ORG,DEVICE_ID,item.event_fingerprint,item.device_user_id,item.occurred_at_device,item.status_code,item.punch_code));
    const results=await db.batch(stmts);
    const inserted=results.reduce((sum,r)=>sum+(r.meta?.changes||0),0);
    return json({received:prepared.length,inserted,duplicates:prepared.length-inserted,device_id:DEVICE_ID,timezone:'Asia/Aden',time_authority:'device'});
  }catch(e) {
    console.error('device import failed',e?.message);
    return json({error:'Storage unavailable or migration missing'},503);
  }
}
