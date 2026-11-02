/* دوام الميسر 0.2.29: financial groundwork. Draft previews only.
 * This module never changes punch records, payroll balances, or payment status.
 * Never approve an incomplete preview. Historical cycles will be snapshotted in a later release.
 */
const DEFAULTS=Object.freeze({
 salary:45000,transport:10000,living_base:50000,family_each:4000,
 experience_1_2:1000,experience_3_5:6000,experience_6_8:9000,experience_9_plus:13000,
 rank_supervisor:10000,rank_deputy:5000,
 duty_supervisor:10000,duty_deputy:5000,duty_acting:10000,duty_cashier:10000,
 evaluation_max:15000,allowed_minutes:375,period_divisor:30,workday_minutes:375,
 callout_first_hour:3000,callout_additional_hour:1000
});
const SCORE_CAPS=[2,8,25,15,20,20,10];
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
 "CREATE TABLE IF NOT EXISTS finance_evaluations (id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,employee_id TEXT NOT NULL,effective_month TEXT NOT NULL,scores_json TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',approved_by TEXT NOT NULL,approved_at TEXT NOT NULL DEFAULT (datetime('now')),UNIQUE(organization_id,employee_id,effective_month))",
 "CREATE TABLE IF NOT EXISTS finance_extras (id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,employee_id TEXT NOT NULL,work_date TEXT NOT NULL,task TEXT NOT NULL,amount REAL NOT NULL CHECK(amount>=3000 AND amount<=7000),status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),created_by TEXT NOT NULL,approved_by TEXT,approved_at TEXT,created_at TEXT NOT NULL DEFAULT (datetime('now')))",
 "CREATE INDEX IF NOT EXISTS finance_extras_emp_date ON finance_extras(organization_id,employee_id,work_date)",
 "CREATE INDEX IF NOT EXISTS finance_eval_emp_month ON finance_evaluations(organization_id,employee_id,effective_month)"
 ];
 for(const sql of statements)await db.prepare(sql).run();
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
function hhmmMinute(time){
 if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(time||'')))fail('وقت الاستدعاء غير صحيح');
 return Number(time.slice(0,2))*60+Number(time.slice(3,5));
}
function calloutMinutes(from,to){
 const start=hhmmMinute(from),end=hhmmMinute(to);
 const diff=(end-start+1440)%1440;
 if(!diff)fail('وقت النهاية يجب أن يختلف عن البداية');
 return diff;
}
function calloutPay(minutes,policy=DEFAULTS){
 if(!Number.isInteger(minutes)||minutes<1||minutes>=1440)fail('مدة الاستدعاء غير صحيحة');
 const first=Number(policy.callout_first_hour),additional=Number(policy.callout_additional_hour);
 if(!Number.isFinite(first)||first<0||!Number.isFinite(additional)||additional<0)fail('تعرفة الاستدعاء غير صالحة');
 // First hour is fixed. Subsequent part-hours are prorated by minute without round-up.
 return money(first+Math.max(0,minutes-60)*additional/60);
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
  if(path==='evaluations'&&method==='GET'){
   const id=str(url.searchParams.get('employee_id'),100);
   if(!id)fail('اختر العامل');
   await existsEmployee(db,org,id);
   const entries=(await db.prepare('SELECT effective_month,scores_json,note,approved_at FROM finance_evaluations WHERE organization_id=? AND employee_id=? ORDER BY effective_month DESC LIMIT 30').bind(org,id).all()).results||[];
   return result({items:entries.map(x=>({...x,scores:JSON.parse(x.scores_json)})),caps:SCORE_CAPS});
  }
  if(path==='evaluations'&&method==='POST'){
   if(user.role!=='admin')return error(403,'اعتماد التقييم لمدير النظام فقط مؤقتًا حتى تحديد صلاحية المدير الإداري');
   const b=await body(request),id=str(b.employee_id,100),month=str(b.effective_month,7);
   if(!monthValid(month))fail('شهر التقييم غير صحيح');
   await existsEmployee(db,org,id);
   const s=b.scores;
   if(!Array.isArray(s)||s.length!==7||s.some((n,i)=>typeof n!=='number'||!Number.isFinite(n)||n<0||n>SCORE_CAPS[i]))fail('درجات التقييم غير صحيحة');
   if(s.reduce((a,n)=>a+n,0)>100)fail('مجموع التقييم يتجاوز 100');
   const already=await db.prepare('SELECT id FROM finance_evaluations WHERE organization_id=? AND employee_id=? AND effective_month=?').bind(org,id,month).first();
   if(already)return error(409,'يوجد تقييم معتمد لهذا الشهر؛ يحتاج تعديل التقييم إلى إجراء تصحيح مستقل');
   await db.prepare("INSERT INTO finance_evaluations(id,organization_id,employee_id,effective_month,scores_json,note,approved_by) VALUES(?,?,?,?,?,?,?)")
   .bind(crypto.randomUUID(),org,id,month,JSON.stringify(s),str(b.note,500),user.id).run();
   await audit(db,org,user,'finance.evaluation.approved',id,{month,total:s.reduce((a,n)=>a+n,0)});
   return result({ok:true,total_points:s.reduce((a,n)=>a+n,0)},201);
  }
  if(path==='extras'&&method==='GET'){
   const month=str(url.searchParams.get('month'),7),c=cycle(month);
   const entries=(await db.prepare("SELECT x.*,e.name AS employee_name FROM finance_extras x JOIN employees e ON e.id=x.employee_id AND e.organization_id=x.organization_id WHERE x.organization_id=? AND x.work_date>=? AND x.work_date<=? ORDER BY x.work_date DESC LIMIT 500").bind(org,c.from,c.to).all()).results||[];
   return result({cycle:c,items:entries});
  }
  if(path==='extras'&&method==='POST'){
   const b=await body(request),id=str(b.employee_id,100),date=str(b.work_date,10),task=str(b.task,200);
   if(!dateValid(date)||!task||task.length<3)fail('أدخل تاريخ ومهمة العمل الإضافي');
   await existsEmployee(db,org,id);
   const value=number(b.amount,{min:3000,max:7000});
   await db.prepare("INSERT INTO finance_extras(id,organization_id,employee_id,work_date,task,amount,created_by) VALUES(?,?,?,?,?,?,?)")
   .bind(crypto.randomUUID(),org,id,date,task,value,user.id).run();
   await audit(db,org,user,'finance.extra.created',id,{date,amount:value});
   return result({ok:true,status:'pending'},201);
  }
  if(parts[0]==='extras'&&parts[1]&&parts[2]==='decision'&&method==='POST'){
   if(!canFinance)return error(403,'اعتماد الإضافي للإدارة المالية فقط');
   const b=await body(request),state=str(b.status,10);
   if(!['approved','rejected'].includes(state))fail('قرار غير صحيح');
   const changed=await db.prepare("UPDATE finance_extras SET status=?,approved_by=?,approved_at=datetime('now') WHERE organization_id=? AND id=? AND status='pending'")
   .bind(state,user.id,org,parts[1]).run();
   if(!changed.meta?.changes)return error(409,'المهمة غير موجودة أو سبق اتخاذ قرار بشأنها');
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
   const pBy=new Map(profiles.map(x=>[x.employee_id,x])),evalBy=new Map();
   for(const e of evals)if(!evalBy.has(e.employee_id))evalBy.set(e.employee_id,e);
   const all=active.map(e=>projection(e,pBy.get(e.id),evalBy.get(e.id),extras.filter(x=>x.employee_id===e.id),policy,c));
   return result({version:'0.2.29',cycle:c,mode:'draft',financial_posting:false,approval_available:false,attendance_posted:false,
    warning:'مسودة استحقاقات قبل تسوية البصمات. لا تعتمد للصرف حتى اكتمال مطابقة الدوام والمعلومات الناقصة.',
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
export {DEFAULTS,cycle,experienceYears,experiencePay,projection,calloutPay,calloutMinutes};
