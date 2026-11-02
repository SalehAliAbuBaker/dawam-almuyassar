/* دوام الميسر 0.2.30: financial groundwork. Draft previews only.
 * This module never changes punch records, payroll balances, or payment status.
 * Never approve an incomplete preview. Historical cycles will be snapshotted in a later release.
 */
import {weightedPoints} from './monthly-attendance-evaluation.js';
import {biometricMonthlyPreview} from './monthly-attendance-server.js';
const DEFAULTS=Object.freeze({
 salary:45000,transport:10000,living_base:50000,family_each:4000,
 experience_1_2:1000,experience_3_5:6000,experience_6_8:9000,experience_9_plus:13000,
 rank_supervisor:10000,rank_deputy:5000,
 duty_supervisor:10000,duty_deputy:5000,duty_acting:10000,duty_cashier:10000,
 evaluation_max:15000,allowed_minutes:375,period_divisor:30,workday_minutes:375,
 callout_first_hour:3000,callout_additional_hour:1000
});
const SCORE_CAPS=[2,8,25,15,20,20,10];
// Only six committee criteria persist across months; monthly biometric points are separate.
export function periodicEvaluationPoints(input){
 if(!Array.isArray(input)||input.length!==7||input[2]!==null)fail('أدخل نسب المعايير الستة فقط، واترك الالتزام للقراءة الآلية');
 const values=input.map((v,i)=>i===2?0:v);
 if(values.some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>100))fail('النسب يجب أن تكون بين صفر و100');
 const points=weightedPoints(values,SCORE_CAPS);
 points[2]=0;
 return points;
}
const DAILY_OVERTIME_CAP=8000; // Absolute daily ceiling across both overtime types.
const FINANCE_ROLES=['admin','accountant'];
const PROFILE_ROLES=['admin','accountant','hr'];
const RANKS=['none','supervisor','deputy'];
const DUTIES=['none','supervisor','deputy','acting','cashier'];
function result(value,status=200){
 return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store, private','x-content-type-options':'nosniff'}});
}
function error(status,message){return result({error:message},status)}
function fail(message,status=400){throw Object.assign(new Error(message),{status})}
function dateValid(str){if(!/^\d{4}-\d{2}-\d{2}$/.test(str))return false; const d=new Date(str+'T12:00:00Z');return !Number.isNaN(d.getTime())&&d.toISOString().slice(0,10)===str}
function monthValid(str){return /^\d{4}-(0[1-9]|1[0-2])$/.test(str||'')}
function number(value,{min=0,max=1e9,nullable=false,integer=false}={}){
 if(nullable&&(value===null||value===''||value===undefined))return null;
 const n=Number(value);
 if(!Number.isFinite(n)||n<min||n>max||(integer&&!Number.isInteger(n)))fail('قيمة رقمية غير صالحة');
 return n;
}
function money(n){return Math.round((n+Number.EPSILON)*100)/100}
function str(s,max=200){return String(s==null?'':s).trim().slice(0,max)}
async function body(request){
 if(!/^application\/json(?:;|$)/i.test(request.headers.get('content-type')||''))fail('البيانات يجب أن تكون JSON',415);
 const t=await request.text();if(t.length>15000)fail('طلب كبير جدًا',413);
 try{return JSON.parse(t)}catch{fail('تنسيق الطلب غير صحيح')}
}
async function ensure(db){
 const statements=[
 "CREATE TABLE IF NOT EXISTS finance_policies (organization_id TEXT PRIMARY KEY, policy_json TEXT NOT NULL, updated_by TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')))",
 "CREATE TABLE IF NOT EXISTS finance_profiles (organization_id TEXT NOT NULL,employee_id TEXT NOT NULL,hire_date TEXT,family_count INTEGER,salary_override REAL,transport_override REAL,company_insurance REAL,total_insurance REAL,income_tax REAL,rank TEXT NOT NULL DEFAULT 'none',duty TEXT NOT NULL DEFAULT 'none',achievement_bonus REAL NOT NULL DEFAULT 0,updated_by TEXT,updated_at TEXT NOT NULL DEFAULT (datetime('now')),PRIMARY KEY(organization_id,employee_id),FOREIGN KEY(employee_id) REFERENCES employees(id))",
 "CREATE TABLE IF NOT EXISTS finance_evaluations (id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,employee_id TEXT NOT NULL,effective_month TEXT NOT NULL,scores_json TEXT NOT NULL,percentages_json TEXT,note TEXT NOT NULL DEFAULT '',approved_by TEXT NOT NULL,approved_at TEXT NOT NULL DEFAULT (datetime('now')),UNIQUE(organization_id,employee_id,effective_month))",
 "CREATE TABLE IF NOT EXISTS finance_attendance_ratings (organization_id TEXT NOT NULL,employee_id TEXT NOT NULL,effective_month TEXT NOT NULL,percentage REAL NOT NULL CHECK(percentage>=0 AND percentage<=100),points REAL NOT NULL CHECK(points>=0 AND points<=25),reviewed_by TEXT NOT NULL,review_note TEXT NOT NULL,source_event_count INTEGER NOT NULL,approved_at TEXT NOT NULL DEFAULT (datetime('now')),PRIMARY KEY(organization_id,employee_id,effective_month))",
 "CREATE TABLE IF NOT EXISTS finance_extras (id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,employee_id TEXT NOT NULL,work_date TEXT NOT NULL,task TEXT NOT NULL,amount REAL NOT NULL CHECK(amount>=3000 AND amount<=7000),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),created_by TEXT NOT NULL,approved_by TEXT,approved_at TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now')))",
 "CREATE INDEX IF NOT EXISTS finance_extras_emp_date ON finance_extras(organization_id,employee_id,work_date)",
 "CREATE TABLE IF NOT EXISTS finance_callouts (id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,employee_id TEXT NOT NULL,work_date TEXT NOT NULL,start_time TEXT NOT NULL,end_time TEXT NOT NULL,duration_minutes INTEGER NOT NULL CHECK(duration_minutes BETWEEN 1 AND 1439),task TEXT NOT NULL,amount REAL NOT NULL CHECK(amount>=0),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),created_by TEXT NOT NULL,approved_by TEXT,approved_at TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now')))",
 "CREATE INDEX IF NOT EXISTS finance_callouts_emp_date ON finance_callouts(organization_id,employee_id,work_date)",
 "CREATE INDEX IF NOT EXISTS finance_eval_emp_month ON finance_evaluations(organization_id,employee_id,effective_month)"
 ];
 for(const sql of statements)await db.prepare(sql).run();
 // Older evaluation records did not retain the exact typed percentages.
 const columns=(await db.prepare('PRAGMA table_info(finance_evaluations)').all()).results||[];
 if(!columns.some(column=>column.name==='percentages_json')){
  try{await db.prepare('ALTER TABLE finance_evaluations ADD COLUMN percentages_json TEXT').run();}
  catch(e){if(!/duplicate column name/i.test(String(e)))throw e;}
 }
}
function cycle(month){
 if(!monthValid(month))fail('شهر مالي غير صالح');
 const [y,m]=month.split('-').map(Number),a=new Date(Date.UTC(y,m-2,26,12)),b=new Date(Date.UTC(y,m-1,25,12));
 return {month,from:a.toISOString().slice(0,10),to:b.toISOString().slice(0,10)};
}
async function audit(db,org,user,what,entity,details){
 await db.prepare("INSERT INTO audit_events(id,organization_id,actor_user_id,event_type,entity_type,entity_id,details_json) VALUES(?,?,?,?,?,?,?)")
 .bind(crypto.randomUUID(),org,user.id,what,'finance',entity,JSON.stringify(details)).run();
}
async function getPolicy(db,org){
 const r=await db.prepare('SELECT policy_json FROM finance_policies WHERE organization_id=?').bind(org).first();
 let parsed={};try{parsed=JSON.parse(r?.policy_json||'{}')}catch{}
 return {...DEFAULTS,...Object.fromEntries(Object.entries(parsed).filter(([k,v])=>Object.hasOwn(DEFAULTS,k)&&typeof v==='number'&&Number.isFinite(v)))};
}
async function getEmployees(db,org){
 return (await db.prepare("SELECT id,code,name,department,position,status,basic_salary,transport_allowance FROM employees WHERE organization_id=? ORDER BY name LIMIT 2000").bind(org).all()).results||[];
}
async function existsEmployee(db,org,id){
 const r=await db.prepare("SELECT id FROM employees WHERE id=? AND organization_id=?").bind(id,org).first();
 if(!r)fail('العامل غير موجود',404);
}
function experienceYears(hire,reference){
 if(!hire||!dateValid(hire)||hire>reference)return null;
 let years=Number(reference.slice(0,4))-Number(hire.slice(0,4));
 if(reference.slice(5)<hire.slice(5))years--;
 return Math.max(0,years);
}
function experiencePay(years,p){
 if(years===null)return null;
 if(years<1)return 0;
 if(years<=2)return p.experience_1_2;
 if(years<=5)return p.experience_3_5;
 if(years<=8)return p.experience_6_8;
 return p.experience_9_plus;
}
function calloutPay(hours,policy=DEFAULTS){
 if(!Number.isInteger(hours)||hours<1||hours>23)fail('عدد ساعات الاستدعاء يجب أن يكون عددًا صحيحًا من 1 إلى 23');
 const first=Number(policy.callout_first_hour),additional=Number(policy.callout_additional_hour);
 if(!Number.isFinite(first)||first<0||!Number.isFinite(additional)||additional<0)fail('تعرفة الاستدعاء غير صالحة');
 const total=money(first+(hours-1)*additional);
 // Entered hours remain factual even when their theoretical value exceeds the daily allowance.
 return Math.min(DAILY_OVERTIME_CAP,total);
}
function projection(e,profile,evaluation,extras,p,cycleInfo,callouts=[]){
 const f=profile||{};
 const absent=[];
 if(f.family_count===null||f.family_count===undefined)absent.push('عدد أفراد الأسرة');
 const years=experienceYears(f.hire_date,cycleInfo.to);
 if(years===null)absent.push('تاريخ التحاق صحيح');
 if(f.income_tax===null||f.income_tax===undefined)absent.push('ضريبة الكسب');
 if(f.company_insurance===null||f.company_insurance===undefined)absent.push('تأمين المؤسسة');
 if(f.total_insurance===null||f.total_insurance===undefined)absent.push('التأمين الكلي');
 const salary=f.salary_override??(Number(e.basic_salary)>0?Number(e.basic_salary):p.salary);
 const transport=f.transport_override??(Number(e.transport_allowance)>0?Number(e.transport_allowance):p.transport);
 const companyInsurance=f.company_insurance??0,insurance=f.total_insurance??0,tax=f.income_tax??0;
 const salaryDue=money(salary+transport+companyInsurance-insurance-tax);
 const family=f.family_count===null||f.family_count===undefined?null:money(p.living_base+p.family_each*f.family_count);
 const experience=experiencePay(years,p);
 const rank=f.rank==='supervisor'?p.rank_supervisor:f.rank==='deputy'?p.rank_deputy:0;
 const duty=f.duty==='supervisor'?p.duty_supervisor:f.duty==='deputy'?p.duty_deputy:f.duty==='acting'?p.duty_acting:f.duty==='cashier'?p.duty_cashier:0;
 const scores=evaluation?JSON.parse(evaluation.scores_json):null;
 const evalPay=scores?money(scores.reduce((a,n)=>a+n,0)*p.evaluation_max/100):0;
 const extraPay=money(extras.filter(x=>x.status==='approved').reduce((a,x)=>a+x.amount,0));
 const calloutPayTotal=money(callouts.filter(x=>x.status==='approved').reduce((a,x)=>a+x.amount,0));
 const incentive=money((family||0)+(experience||0)+rank+duty+evalPay+Number(f.achievement_bonus||0)+tax+extraPay+calloutPayTotal);
 return {employee_id:e.id,code:e.code,name:e.name,department:e.department,position:e.position,
  incomplete_fields:absent,safe_to_finalize:false,
  salary:{base:salary,transport,company_insurance:companyInsurance,total_insurance:insurance,tax,net:salaryDue,complete:!absent.some(s=>['ضريبة الكسب','تأمين المؤسسة','التأمين الكلي'].includes(s))},
  incentive:{living:family,experience_years:years,experience:experience,rank,duty,evaluation:evalPay,achievement:Number(f.achievement_bonus||0),tax_compensation:tax,approved_extra:extraPay,approved_callouts:calloutPayTotal,subtotal_before_attendance:incentive,attendance_settlement:null,late_penalties:null,net:null},
  evaluation:{scores:scores||[],total:scores?scores.reduce((a,b)=>a+b,0):0,effective_month:evaluation?.effective_month||null},
  attendance_state:'pending_verified_attendance',extras_pending:extras.filter(x=>x.status==='pending').length,callouts_pending:callouts.filter(x=>x.status==='pending').length,
  report_sources:{profile_updated_at:f.updated_at||null,applied_evaluation_month:evaluation?.effective_month||null,approved_extras:extras.filter(x=>x.status==='approved').map(x=>({date:x.work_date,task:x.task,amount:x.amount})),approved_callouts:callouts.filter(x=>x.status==='approved').map(x=>({date:x.work_date,task:x.task,duration_minutes:x.duration_minutes,amount:x.amount})),pending_extras:extras.filter(x=>x.status==='pending').length,pending_callouts:callouts.filter(x=>x.status==='pending').length}};
}
export async function financeEndpoint(db,user,request,path,org){
 try{
  if(!PROFILE_ROLES.includes(user.role)||user.self_only)return error(403,'ليس لديك صلاحية للوحدة المالية');
  const method=request.method.toUpperCase(),url=new URL(request.url),parts=path.split('/');
  await ensure(db);
  const canFinance=FINANCE_ROLES.includes(user.role);
  if(path==='policy'&&method==='GET')return result({policy:await getPolicy(db,org),defaults:DEFAULTS});
  if(path==='policy'&&method==='PUT'){
   if(user.role!=='admin')return error(403,'تعديل سياسة الاستحقاقات لمدير النظام فقط');
   const b=await body(request),p=await getPolicy(db,org);
   if(!b||typeof b!=='object'||!b.policy||typeof b.policy!=='object')fail('لا توجد سياسة');
   const updated={...p};
   for(const [key,value] of Object.entries(b.policy)){
    if(!Object.hasOwn(DEFAULTS,key))fail('حقل سياسة غير معروف: '+key);
    updated[key]=number(value,{max:1e7,integer:key==='allowed_minutes'||key==='period_divisor'||key==='workday_minutes'});
   }
   if(updated.period_divisor<1||updated.workday_minutes<1)fail('مقسوم الدوام غير صحيح');
   await db.prepare("INSERT INTO finance_policies(organization_id,policy_json,updated_by) VALUES(?,?,?) ON CONFLICT(organization_id) DO UPDATE SET policy_json=excluded.policy_json,updated_by=excluded.updated_by,updated_at=datetime('now')").bind(org,JSON.stringify(updated),user.id).run();
   await audit(db,org,user,'finance.policy.updated',org,{changed:Object.keys(b.policy)});
   return result({ok:true,policy:updated});
  }
  if(path==='profiles'&&method==='GET'){
   const employees=await getEmployees(db,org),profiles=(await db.prepare('SELECT * FROM finance_profiles WHERE organization_id=?').bind(org).all()).results||[];
   const byId=new Map(profiles.map(x=>[x.employee_id,x]));
   return result({items:employees.map(e=>({...e,profile:byId.get(e.id)||null}))});
  }
  if(parts[0]==='profiles'&&parts[1]&&parts.length===2&&method==='PUT'){
   if(!canFinance)return error(403,'تعديل الاستحقاقات للمدير والمحاسبة فقط');
   const id=parts[1];await existsEmployee(db,org,id);
   const b=await body(request),f=b.profile;
   if(!f||typeof f!=='object'||Array.isArray(f))fail('بيانات العامل غير صحيحة');
   const hire=f.hire_date===null||f.hire_date===''?null:str(f.hire_date,10);
   if(hire&&!dateValid(hire))fail('تاريخ الالتحاق غير صحيح');
   const rank=str(f.rank||'none',30),duty=str(f.duty||'none',30);
   if(!RANKS.includes(rank)||!DUTIES.includes(duty))fail('رتبة أو ثقل مهمة غير صالح');
   const family=number(f.family_count,{nullable:true,max:100,integer:true});
   const sal=number(f.salary_override,{nullable:true}),trans=number(f.transport_override,{nullable:true});
   const comp=number(f.company_insurance,{nullable:true}),total=number(f.total_insurance,{nullable:true}),tax=number(f.income_tax,{nullable:true});
   const ach=number(f.achievement_bonus);
   await db.prepare("INSERT INTO finance_profiles(organization_id,employee_id,hire_date,family_count,salary_override,transport_override,company_insurance,total_insurance,income_tax,rank,duty,achievement_bonus,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id,employee_id) DO UPDATE SET hire_date=excluded.hire_date,family_count=excluded.family_count,salary_override=excluded.salary_override,transport_override=excluded.transport_override,company_insurance=excluded.company_insurance,total_insurance=excluded.total_insurance,income_tax=excluded.income_tax,rank=excluded.rank,duty=excluded.duty,achievement_bonus=excluded.achievement_bonus,updated_by=excluded.updated_by,updated_at=datetime('now')")
   .bind(org,id,hire,family,sal,trans,comp,total,tax,rank,duty,ach,user.id).run();
   await audit(db,org,user,'finance.profile.updated',id,{changed:['hire_date','family_count','salary_override','transport_override','company_insurance','total_insurance','income_tax','rank','duty','achievement_bonus']});
   return result({ok:true});
  }
  if(path==='attendance-rating'&&method==='GET'){
   const id=str(url.searchParams.get('employee_id'),100),month=str(url.searchParams.get('month'),7);
   if(!id||!monthValid(month))fail('اختر العامل وشهر الدورة');
   await existsEmployee(db,org,id);
   const preview=await biometricMonthlyPreview(db,org,id,cycle(month));
   const approved=await db.prepare('SELECT effective_month,percentage,points,reviewed_by,review_note,approved_at,source_event_count FROM finance_attendance_ratings WHERE organization_id=? AND employee_id=? AND effective_month=?').bind(org,id,month).first();
   return result({preview,approved:approved||null});
  }
  if(path==='attendance-rating'&&method==='POST'){
   if(user.role!=='admin')return error(403,'اعتماد الالتزام في الدوام للمدير فقط');
   const b=await body(request),id=str(b.employee_id,100),month=str(b.month,7),note=str(b.note,500);
   if(!id||!monthValid(month))fail('اختر العامل وشهر الدورة');
   if(b.confirmed!==true||note.length<8)fail('يلزم تأكيد مراجعة البصمات وكتابة ملاحظة واضحة');
   await existsEmployee(db,org,id);
   const preview=await biometricMonthlyPreview(db,org,id,cycle(month));
   if(!preview.can_approve)return error(409,preview.review_message);
   if(b.review_token!==preview.review_token)return error(409,'تغيرت البيانات منذ عرض المعاينة؛ حدّث القراءة وراجعها مجددًا');
   const saved=await db.prepare("INSERT OR IGNORE INTO finance_attendance_ratings(organization_id,employee_id,effective_month,percentage,points,reviewed_by,review_note,source_event_count) VALUES(?,?,?,?,?,?,?,?)")
    .bind(org,id,month,preview.percentage,preview.points,user.id,note,preview.event_count).run();
   if(saved.meta?.changes!==1)return error(409,'سبق اعتماد درجة الالتزام لهذا الشهر؛ يلزم إجراء تصحيح موثق');
   await audit(db,org,user,'finance.attendance_rating.approved',id,{month,percentage:preview.percentage,points:preview.points,events:preview.event_count,missing_days:preview.missing_days});
   return result({ok:true,percentage:preview.percentage,points:preview.points,month},201);
  }
  if(path==='evaluations'&&method==='GET'){
   const id=str(url.searchParams.get('employee_id'),100);
   if(!id)fail('اختر العامل');
   await existsEmployee(db,org,id);
   const entries=(await db.prepare('SELECT effective_month,scores_json,percentages_json,note,approved_at FROM finance_evaluations WHERE organization_id=? AND employee_id=? ORDER BY effective_month DESC LIMIT 30').bind(org,id).all()).results||[];
   return result({items:entries.map(x=>({...x,scores:JSON.parse(x.scores_json),percentages:x.percentages_json?JSON.parse(x.percentages_json):null})),caps:SCORE_CAPS});
  }
  if(path==='evaluations'&&method==='POST'){
   if(user.role!=='admin')return error(403,'حفظ تقييم اللجنة لمدير النظام فقط');
   const b=await body(request),id=str(b.employee_id,100),month=str(b.effective_month,7);
   if(!monthValid(month))fail('شهر سريان التقييم غير صحيح');
   await existsEmployee(db,org,id);
   // Committee evaluation is saved when edited; biometric attendance is approved separately each month.
   const scores=periodicEvaluationPoints(b.percentages),note=str(b.note,500),exactPercentages=JSON.stringify(b.percentages);
   const previous=await db.prepare('SELECT id,scores_json,percentages_json,note FROM finance_evaluations WHERE organization_id=? AND employee_id=? AND effective_month=?').bind(org,id,month).first();
   const total=scores.reduce((a,n)=>a+n,0);
   if(previous){
    const oldScores=JSON.parse(previous.scores_json);
    const unchanged=(previous.percentages_json?previous.percentages_json===exactPercentages:scores.every((n,i)=>i===2||n===Number(oldScores[i])))&&previous.note===note;
    if(unchanged)return result({ok:true,changed:false,total_points:total,effective_month:month});
    const updated=await db.prepare("UPDATE finance_evaluations SET scores_json=?,percentages_json=?,note=?,approved_by=?,approved_at=datetime('now') WHERE id=? AND organization_id=?")
     .bind(JSON.stringify(scores),exactPercentages,note,user.id,previous.id,org).run();
    if(updated.meta?.changes!==1)return error(409,'تعذر حفظ التقييم؛ أعد تحميل البيانات');
    await audit(db,org,user,'finance.evaluation.updated',id,{month,before:oldScores,after:scores});
    return result({ok:true,changed:true,total_points:total,effective_month:month});
   }
   await db.prepare("INSERT INTO finance_evaluations(id,organization_id,employee_id,effective_month,scores_json,percentages_json,note,approved_by) VALUES(?,?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(),org,id,month,JSON.stringify(scores),exactPercentages,note,user.id).run();
   await audit(db,org,user,'finance.evaluation.saved',id,{month,total});
   return result({ok:true,changed:true,total_points:total,effective_month:month},201);
  }
  if(path==='extras'&&method==='GET'){
   const month=str(url.searchParams.get('month'),7),c=cycle(month);
   const entries=(await db.prepare("SELECT x.*,e.name AS employee_name FROM finance_extras x JOIN employees e ON e.id=x.employee_id AND e.organization_id=x.organization_id WHERE x.organization_id=? AND x.work_date>=? AND x.work_date<=? ORDER BY x.work_date DESC LIMIT 500").bind(org,c.from,c.to).all()).results||[];
   return result({cycle:c,items:entries,daily_cap:DAILY_OVERTIME_CAP});
  }
  if(path==='extras'&&method==='POST'){
   const b=await body(request),id=str(b.employee_id,100),date=str(b.work_date,10),task=str(b.task,200);
   if(!dateValid(date)||!task||task.length<3)fail('أدخل تاريخ ومهمة العمل الإضافي');
   await existsEmployee(db,org,id);
   const value=number(b.amount,{min:3000,max:7000});
   const added=await db.prepare("INSERT INTO finance_extras(id,organization_id,employee_id,work_date,task,amount,created_by) SELECT ?,?,?,?,?,?,? WHERE (SELECT COALESCE(SUM(amount),0) FROM finance_extras WHERE organization_id=? AND employee_id=? AND work_date=? AND status IN ('pending','approved'))+(SELECT COALESCE(SUM(amount),0) FROM finance_callouts WHERE organization_id=? AND employee_id=? AND work_date=? AND status IN ('pending','approved'))+?<=?")
   .bind(crypto.randomUUID(),org,id,date,task,value,user.id,org,id,date,org,id,date,value,DAILY_OVERTIME_CAP).run();
   if(added.meta?.changes!==1)return error(409,'تجاوز إجمالي عمل العامل الإضافي لهذا اليوم سقف 8,000 ريال');
   await audit(db,org,user,'finance.extra.created',id,{date,amount:value});
   return result({ok:true,status:'pending'},201);
  }
  if(path==='callouts'&&method==='GET'){
   const month=str(url.searchParams.get('month'),7),c=cycle(month);
   const items=(await db.prepare("SELECT x.*,e.name AS employee_name,e.code AS employee_code FROM finance_callouts x JOIN employees e ON e.id=x.employee_id AND e.organization_id=x.organization_id WHERE x.organization_id=? AND x.work_date>=? AND x.work_date<=? ORDER BY x.work_date DESC,x.created_at DESC LIMIT 1000").bind(org,c.from,c.to).all()).results||[];
   return result({cycle:c,items:items.map(x=>({...x,hours:x.duration_minutes/60})),daily_cap:DAILY_OVERTIME_CAP,calculation:'manual_whole_hours_first_3000_then_1000'});
  }
  if(path==='callouts'&&method==='POST'){
   const b=await body(request),id=str(b.employee_id,100),date=str(b.work_date,10),task=str(b.task,200);
   if(!dateValid(date)||task.length<3)fail('أدخل تاريخ الاستدعاء ووصف المهمة');
   await existsEmployee(db,org,id);
   // Hours are entered manually by the manager, never inferred from punches or clock times.
   const hours=number(b.hours,{min:1,max:23,integer:true});
   const minutes=hours*60,p=await getPolicy(db,org),value=calloutPay(hours,p);
   // Legacy start/end columns are required on existing staging D1 tables;
   // empty values explicitly indicate "manual hours", not a time-of-day claim.
   const added=await db.prepare("INSERT INTO finance_callouts(id,organization_id,employee_id,work_date,start_time,end_time,duration_minutes,task,amount,created_by) SELECT ?,?,?,?,?,?,?,?,?,? WHERE (SELECT COALESCE(SUM(amount),0) FROM finance_extras WHERE organization_id=? AND employee_id=? AND work_date=? AND status IN ('pending','approved'))+(SELECT COALESCE(SUM(amount),0) FROM finance_callouts WHERE organization_id=? AND employee_id=? AND work_date=? AND status IN ('pending','approved'))+?<=?")
   .bind(crypto.randomUUID(),org,id,date,'','',minutes,task,value,user.id,org,id,date,org,id,date,value,DAILY_OVERTIME_CAP).run();
   if(added.meta?.changes!==1)return error(409,'تجاوز إجمالي عمل العامل الإضافي لهذا اليوم سقف 8,000 ريال');
   await audit(db,org,user,'finance.callout.created',id,{date,hours,amount:value,entry_mode:'manual_hours'});
   return result({ok:true,status:'pending',hours,amount:value},201);
  }
  if(parts[0]==='callouts'&&parts[1]&&parts[2]==='decision'&&parts.length===3&&method==='POST'){
   if(!canFinance)return error(403,'اعتماد الاستدعاء للإدارة المالية فقط');
   const b=await body(request),state=str(b.status,10);
   if(!['approved','rejected'].includes(state))fail('قرار غير صحيح');
   const changed=await db.prepare("UPDATE finance_callouts SET status=?,approved_by=?,approved_at=datetime('now') WHERE organization_id=? AND id=? AND status='pending' AND (?='rejected' OR finance_callouts.amount+(SELECT COALESCE(SUM(e.amount),0) FROM finance_extras e WHERE e.organization_id=finance_callouts.organization_id AND e.employee_id=finance_callouts.employee_id AND e.work_date=finance_callouts.work_date AND e.status='approved')+(SELECT COALESCE(SUM(c.amount),0) FROM finance_callouts c WHERE c.organization_id=finance_callouts.organization_id AND c.employee_id=finance_callouts.employee_id AND c.work_date=finance_callouts.work_date AND c.status='approved')<=?)")
    .bind(state,user.id,org,parts[1],state,DAILY_OVERTIME_CAP).run();
   if(!changed.meta?.changes)return error(409,'الاستدعاء غير موجود أو سبق البت فيه أو يتجاوز السقف اليومي');
   await audit(db,org,user,'finance.callout.decided',parts[1],{status:state});
   return result({ok:true,status:state});
  }
  if(parts[0]==='extras'&&parts[1]&&parts[2]==='decision'&&method==='POST'){
   if(!canFinance)return error(403,'اعتماد الإضافي للإدارة المالية فقط');
   const b=await body(request),state=str(b.status,10);
   if(!['approved','rejected'].includes(state))fail('قرار غير صحيح');
   const changed=await db.prepare("UPDATE finance_extras SET status=?,approved_by=?,approved_at=datetime('now') WHERE organization_id=? AND id=? AND status='pending' AND (?='rejected' OR finance_extras.amount+(SELECT COALESCE(SUM(e.amount),0) FROM finance_extras e WHERE e.organization_id=finance_extras.organization_id AND e.employee_id=finance_extras.employee_id AND e.work_date=finance_extras.work_date AND e.status='approved')+(SELECT COALESCE(SUM(c.amount),0) FROM finance_callouts c WHERE c.organization_id=finance_extras.organization_id AND c.employee_id=finance_extras.employee_id AND c.work_date=finance_extras.work_date AND c.status='approved')<=?)")
   .bind(state,user.id,org,parts[1],state,DAILY_OVERTIME_CAP).run();
   if(!changed.meta?.changes)return error(409,'المهمة غير موجودة أو سبق البت فيها أو تتجاوز السقف اليومي');
   await audit(db,org,user,'finance.extra.decided',parts[1],{status:state});
   return result({ok:true,status:state});
  }
  if(path==='preview'&&method==='GET'){
   if(!canFinance)return error(403,'عرض الكشوف المالية للمدير والمحاسبة فقط');
   const month=str(url.searchParams.get('month'),7),c=cycle(month),policy=await getPolicy(db,org);
   const employees=await getEmployees(db,org);
   const active=employees.filter(e=>e.status==='active');
   const profiles=(await db.prepare('SELECT * FROM finance_profiles WHERE organization_id=?').bind(org).all()).results||[];
   const evals=(await db.prepare('SELECT * FROM finance_evaluations WHERE organization_id=? AND effective_month<=? ORDER BY effective_month DESC LIMIT 5000').bind(org,month).all()).results||[];
   const extras=(await db.prepare('SELECT * FROM finance_extras WHERE organization_id=? AND work_date>=? AND work_date<=?').bind(org,c.from,c.to).all()).results||[];
   const callouts=(await db.prepare('SELECT * FROM finance_callouts WHERE organization_id=? AND work_date>=? AND work_date<=?').bind(org,c.from,c.to).all()).results||[];
   const pBy=new Map(profiles.map(x=>[x.employee_id,x])),evalBy=new Map();
   for(const e of evals)if(!evalBy.has(e.employee_id))evalBy.set(e.employee_id,e);
   const monthly=(await db.prepare('SELECT employee_id,percentage,points,approved_at FROM finance_attendance_ratings WHERE organization_id=? AND effective_month=?').bind(org,month).all()).results||[];
   const attendanceBy=new Map(monthly.map(r=>[r.employee_id,r]));
   const all=active.map(e=>{
    const prior=evalBy.get(e.id),attendance=attendanceBy.get(e.id);
    // Old scores of other criteria may carry forward; attendance never does.
    const current=prior?{...prior,scores_json:JSON.stringify(JSON.parse(prior.scores_json).map((n,i)=>i===2?(attendance?Number(attendance.points):0):n))}:null;
    const item=projection(e,pBy.get(e.id),current,extras.filter(x=>x.employee_id===e.id),policy,c,callouts.filter(x=>x.employee_id===e.id));
    if(!attendance)item.incomplete_fields.push('درجة الالتزام في الدوام لهذا الشهر غير معتمدة');
    if(!prior)item.incomplete_fields.push('تقييم المعايير الأخرى غير معتمد');
    item.attendance_rating={status:attendance?'manager_approved':'pending',percentage:attendance?.percentage??null,points:attendance?.points??null,month};
    item.report_sources.attendance_rating_month=attendance?month:null;
    return item;
   });
   return result({version:'0.2.31',cycle:c,mode:'draft',financial_posting:false,approval_available:false,attendance_posted:false,
    warning:'مسودة استحقاقات قبل تسوية البصمات. لا تعتمد للصرف حتى اكتمال مطابقة الدوام والمعلومات الناقصة.',daily_overtime_cap:DAILY_OVERTIME_CAP,
    policy,items:all,counts:{workers:all.length,profiles_missing:all.filter(x=>x.incomplete_fields.length).length,attendance_unreviewed:all.length}});
  }
  return error(404,'مسار مالي غير موجود');
 }catch(e){
  if(e?.status)return error(e.status,e.message);
  console.error('finance module',String(e?.message||'error').slice(0,200));
  return error(500,'تعذر إتمام العملية المالية');
 }
}

// Export deterministic calculation helpers for regression tests; no database side effects.
export {DEFAULTS,cycle,experienceYears,experiencePay,projection,calloutPay,DAILY_OVERTIME_CAP};
