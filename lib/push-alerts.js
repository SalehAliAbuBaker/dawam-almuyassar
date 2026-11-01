/* Notification dispatcher for successful, recent MB10 synchronizations.
 * It never attributes a failed finger scan: MB10 only exports recorded events. */
import {sendWebPush,pushConfigured,validatePushSubscription} from './push-web.js';
const org='org_main';
let pushStorageReady=false;
/* Stage-only idempotent schema provisioning prevents missing migrations when
 * Cloudflare deploys code before a manual D1 migration run. */
export async function ensurePushStorage(db){
 if(pushStorageReady)return;
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS push_subscriptions (id TEXT PRIMARY KEY,organization_id TEXT NOT NULL REFERENCES organizations(id),user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,employee_id TEXT NOT NULL REFERENCES employees(id),endpoint TEXT NOT NULL,p256dh TEXT NOT NULL,auth_secret TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT NOT NULL DEFAULT (datetime('now')),UNIQUE(organization_id,user_id,endpoint))"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_push_active_worker ON push_subscriptions(organization_id,employee_id)"),
  db.prepare("CREATE TABLE IF NOT EXISTS push_notification_deliveries (organization_id TEXT NOT NULL,subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,attendance_day TEXT NOT NULL,alert_code TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('sending','sent','failed')),attempts INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL DEFAULT (datetime('now')),updated_at TEXT NOT NULL DEFAULT (datetime('now')),PRIMARY KEY(organization_id,subscription_id,attendance_day,alert_code))"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_push_deliveries_recent ON push_notification_deliveries(organization_id,attendance_day)")
 ]);
 pushStorageReady=true;
}

function adenClock(){
 const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Aden',
   year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
   .formatToParts(new Date()).map(x=>[x.type,x.value]));
 return {day:p.year+'-'+p.month+'-'+p.day,minutes:Number(p.hour)*60+Number(p.minute)};
}
function checkScheduled(day){
 return new Date(day+'T12:00:00Z').getUTCDay()!==5;
}
const pack=s=>({endpoint:s.endpoint,keys:{p256dh:s.p256dh,auth:s.auth_secret}});
async function mark(db,s,day,code){
 const insert=await db.prepare("INSERT OR IGNORE INTO push_notification_deliveries (organization_id,subscription_id,attendance_day,alert_code,state) VALUES (?,?,?,?,'sending')")
   .bind(org,s.id,day,code).run();
 if(insert.meta?.changes)return true;
 const r=await db.prepare("UPDATE push_notification_deliveries SET state='sending',attempts=attempts+1,updated_at=datetime('now') WHERE organization_id=? AND subscription_id=? AND attendance_day=? AND alert_code=? AND state='failed' AND attempts<3")
   .bind(org,s.id,day,code).run();
 return !!r.meta?.changes;
}
async function recordResult(db,s,day,code,status){
 await db.prepare("UPDATE push_notification_deliveries SET state=?,updated_at=datetime('now') WHERE organization_id=? AND subscription_id=? AND attendance_day=? AND alert_code=?")
   .bind(status?'sent':'failed',org,s.id,day,code).run();
}
async function pushMarked(db,env,s,day,code,body){
 if(!await mark(db,s,day,code))return;
 try{
  const result=await sendWebPush(env,pack(s),{
   title:'دوام الميسر',body,tag:'dawam-'+code+'-'+day,url:'/my-attendance.html'
  });
  if(result.expired){
   await db.prepare("DELETE FROM push_subscriptions WHERE organization_id=? AND id=?").bind(org,s.id).run();
   return;
  }
  await recordResult(db,s,day,code,result.ok);
 }catch(error){
  console.error('push delivery failed',String(error?.message||'error').slice(0,120));
  await recordResult(db,s,day,code,false);
 }
}
async function dailyEvents(db,employeeId,day){
 const start=day+'T00:00:00',end=day+'T23:59:59.999';
 const sql="SELECT e.kind,e.timestamp FROM ("+
   "SELECT p.kind,p.occurred_at AS timestamp FROM punch_events p WHERE p.organization_id=? AND p.employee_id=? AND p.occurred_at>=? AND p.occurred_at<=? AND p.kind IN ('in','out','other')"+
   " UNION ALL SELECT CASE r.punch_code WHEN 0 THEN 'in' WHEN 1 THEN 'out' ELSE 'other' END AS kind,r.occurred_at_device AS timestamp FROM device_raw_punches r"+
   " JOIN employees x ON x.organization_id=r.organization_id AND x.device_user_id=r.device_user_id"+
   " WHERE r.organization_id=? AND x.id=? AND r.device_id='mb10-main' AND r.occurred_at_device>=? AND r.occurred_at_device<=?"+
   " AND NOT EXISTS(SELECT 1 FROM punch_events p WHERE p.organization_id=r.organization_id AND p.device_id=r.device_id AND p.device_event_id=r.event_fingerprint)"+
   ") e ORDER BY e.timestamp";
 const rows=await db.prepare(sql).bind(org,employeeId,start,end,org,employeeId,start,end).all();
 return rows.results||[];
}
export async function notifyWorkersAfterSuccessfulSync(db,env){
 if(!pushConfigured(env))return {configured:false};
 await ensurePushStorage(db);
 const clock=adenClock();
 if(!checkScheduled(clock.day))return {skipped:'weekly_off'};
 const thursday=new Date(clock.day+'T12:00:00Z').getUTCDay()===4;
 const close=thursday?13*60+15:13*60+45;
 if(clock.minutes<7*60+45)return {skipped:'before_reminder_window'};
 // Small batch per sync: bounds outbound fetches and D1 queries in a Worker invocation.
 const eligible="FROM push_subscriptions s JOIN users u ON u.id=s.user_id AND u.organization_id=s.organization_id JOIN employees e ON e.id=s.employee_id AND e.organization_id=s.organization_id WHERE s.organization_id=? AND u.is_active=1 AND u.employee_id=s.employee_id AND e.status='active' AND e.type='regular'";
 const total=await db.prepare("SELECT COUNT(*) AS n "+eligible).bind(org).first();
 const chunks=Math.max(1,Math.ceil(Number(total?.n||0)/20));
 // Rotate batches so a growing team never leaves later subscriptions unprocessed.
 const offset=(Math.floor(Date.now()/600000)%chunks)*20;
 const subs=await db.prepare("SELECT s.id,s.employee_id,s.endpoint,s.p256dh,s.auth_secret "+eligible+" ORDER BY s.created_at,s.id LIMIT 20 OFFSET ?")
   .bind(org,offset).all();
 const subscriptions=subs.results||[],cache=new Map();
 for(const s of subscriptions){
  if(!validatePushSubscription(pack(s)))continue;
  // Approved full-day leave is not an attendance failure; skip reminders.
  const leave=await db.prepare("SELECT 1 FROM leave_requests WHERE organization_id=? AND employee_id=? AND status='approved' AND leave_type IN ('annual','sick','emergency','other') AND substr(starts_at,1,10)<=? AND substr(ends_at,1,10)>=? AND (minutes IS NULL OR minutes>=360) LIMIT 1")
    .bind(org,s.employee_id,clock.day,clock.day).first();
  if(leave)continue;
  if(!cache.has(s.employee_id))cache.set(s.employee_id,await dailyEvents(db,s.employee_id,clock.day));
  const events=cache.get(s.employee_id),firstIn=events.find(x=>x.kind==='in');
  const hasUnclassified=events.some(x=>x.kind==='other');
  if(!firstIn){
   if(events.length){
    // A registered biometric event with an ambiguous direction must never
    // produce an inaccurate "you did not scan" notification.
    await pushMarked(db,env,s,clock.day,'checkin_needs_review',
      'سُجلت حركة بصمة، لكن نوع الحضور أو الانصراف يحتاج مراجعة. تحقق من سجلك أو أرسل بلاغًا للإدارة.');
   }else{
    await pushMarked(db,env,s,clock.day,'checkin_missing',
      'لم تُسجل أي بصمة حضور حتى آخر مزامنة ناجحة. إذا كنت قد بصمت، يمكنك تقديم بلاغ للمراجعة.');
   }
   continue;
  }
  if(clock.minutes>=close+15){
   const outs=events.filter(x=>x.kind==='out');
   if(!outs.length){
    if(hasUnclassified){
     await pushMarked(db,env,s,clock.day,'checkout_needs_review',
       'توجد بصمة غير محددة النوع في سجلك. يرجى التحقق من الانصراف قبل اعتبار الحركة ناقصة.');
    }else{
     await pushMarked(db,env,s,clock.day,'checkout_missing',
       'لم تظهر بصمة انصراف مؤكدة حتى آخر مزامنة ناجحة. يرجى التحقق من دوامك.');
    }
   }else if(outs[outs.length-1].timestamp<events[events.length-1].timestamp && events[events.length-1].kind==='in'){
    await pushMarked(db,env,s,clock.day,'checkout_review',
      'توجد عودة مسجلة دون انصراف لاحق في آخر البيانات؛ تحقق من سجل دوامك.');
   }
  }
 }
 return {processed:subscriptions.length,day:clock.day};
}
export async function sendPersonalTest(db,env,user){
 if(!pushConfigured(env))return {error:'خدمة إشعارات الجوال غير مُهيّأة على Cloudflare',status:503};
 await ensurePushStorage(db);
 const s=await db.prepare("SELECT id,employee_id,endpoint,p256dh,auth_secret FROM push_subscriptions WHERE organization_id=? AND user_id=? AND employee_id=? ORDER BY updated_at DESC LIMIT 1")
   .bind(user.organization_id,user.id,user.employee_id).first();
 if(!s)return {error:'فعّل إشعارات الجهاز أولًا',status:409};
 const day=adenClock().day;
 const eligible=await mark(db,s,day,'test');
 if(!eligible)return {error:'أُرسل إشعار تجريبي بالفعل لهذا الجهاز اليوم، أو المحاولة السابقة قيد المعالجة',status:429};
 try{
  const result=await sendWebPush(env,pack(s),{title:'دوام الميسر',body:'اختبار الإشعارات: تم استلام رسالة اختبار من نظام الدوام.',tag:'dawam-test-'+day,url:'/my-attendance.html'});
  if(result.expired){
   await db.prepare('DELETE FROM push_subscriptions WHERE organization_id=? AND id=?').bind(org,s.id).run();
   return {error:'انتهى اشتراك الجهاز؛ أعد تفعيل الإشعارات',status:410};
  }
  await recordResult(db,s,day,'test',result.ok);
  return result.ok?{ok:true,accepted_by_push_service:true}:{error:'خدمة الإشعارات لم تقبل الرسالة ('+result.status+')',status:502};
 }catch(e){
  await recordResult(db,s,day,'test',false);
  return {error:'تعذر إرسال الاختبار؛ راجع إعدادات الخدمة',status:503};
 }
}
