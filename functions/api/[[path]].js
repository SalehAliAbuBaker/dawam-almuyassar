import { onRequestPost as importMb10Punches } from './device-import.js';
import {pushConfigured,validatePushSubscription} from '../../lib/push-web.js';
import {notifyWorkersAfterSuccessfulSync,sendPersonalTest,ensurePushStorage} from '../../lib/push-alerts.js';
/* دوام الميسر 0.2.0 — Phase 1 API (Cloudflare Pages Functions + D1).
   Deploy behind a separate staging Cloudflare Pages project; GitHub Pages cannot run Functions.
   Never put SETUP_TOKEN, passwords or D1 credentials in the Git repository. */
const COOKIE = 'dawam_session';
const ORG = 'org_main';
const SESSION_HOURS = 12;
// Cloudflare Workers WebCrypto rejects PBKDF2 iteration counts above 100,000.
// Keep the stored iteration count accurate and consistent with the D1 CHECK constraint.
const PBKDF2_ROUNDS = 100000;
const ROLES = new Set(['admin', 'hr', 'accountant', 'supervisor', 'viewer']);
const KINDS = new Set(['in', 'out', 'other']);
const USER_PUBLIC = 'id, organization_id, employee_id, name, email, role, department_scope, must_change_password, is_active, created_at';
const enc = new TextEncoder();

function response(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, private',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      ...headers
    }
  });
}
function reject(status, error) { return response({ error }, status); }
function uuid() { return crypto.randomUUID(); }
function iso() { return new Date().toISOString(); }
function shaBytes(arr) { return crypto.subtle.digest('SHA-256', arr); }
function toB64(bytes) {
  let str = '';
  for (const b of new Uint8Array(bytes)) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomB64(length = 32) { return toB64(crypto.getRandomValues(new Uint8Array(length))); }
async function hashText(value) { return toB64(await shaBytes(enc.encode(value))); }
function safeEquals(a, b) {
  const x = enc.encode(String(a || '')), y = enc.encode(String(b || ''));
  let difference = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) difference |= (x[i] || 0) ^ (y[i] || 0);
  return difference === 0;
}
async function passwordHash(password, salt, iterations = PBKDF2_ROUNDS) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return toB64(await crypto.subtle.deriveBits({
    name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations
  }, key, 256));
}
function emailVal(x) { return String(x || '').trim().toLowerCase(); }
function validEmail(x) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) && x.length <= 180; }
function validPassword(x) { return typeof x === 'string' && x.length >= 12 && x.length <= 128; }
function str(value, max = 160) { return String(value == null ? '' : value).trim().slice(0, max); }
function amount(value) {
  const n = Number(value == null || value === '' ? 0 : value);
  if (!Number.isFinite(n) || n < 0 || n > 1e12) throw new Error('قيمة مالية غير صالحة');
  return n;
}
async function bodyJson(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers.get('content-type') || '')) throw Object.assign(new Error('يلزم JSON'), { status: 415 });
  const body = await request.text();
  if (body.length > 50000) throw Object.assign(new Error('الطلب أكبر من المسموح'), { status: 413 });
  try { return JSON.parse(body); } catch { throw Object.assign(new Error('بيانات JSON غير صالحة'), { status: 400 }); }
}
function cookie(request) {
  const part = (request.headers.get('cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='));
  return part ? part.slice(COOKIE.length + 1) : null;
}
function setCookie(token, maxAge) {
  return COOKIE + '=' + token + '; Path=/api; HttpOnly; Secure; SameSite=Strict; Max-Age=' + maxAge;
}
function publicUser(user) {
  return {...Object.fromEntries(USER_PUBLIC.split(', ').map(k => [k, user[k]])),self_only:!!user.self_only};
}
async function allowedByPermission(db,user,key,defaultAllowed) {
  if(user.role==='admin') return true;
  const row=await db.prepare("SELECT allowed FROM user_permission_overrides WHERE organization_id=? AND user_id=? AND permission_key=?").bind(ORG,user.id,key).first();
  // Default-deny for custom grants not yet enforced by endpoint-level scope logic.
  if(!row) return defaultAllowed;
  return row.allowed===1;
}
function canEditPeople(user) { return !user.self_only && (user.role === 'admin' || user.role === 'hr'); }
function canReadAll(user) { return !user.self_only && ['admin', 'hr', 'accountant'].includes(user.role); }
function canWritePunch(user) { return !user.self_only && (canEditPeople(user) || user.role === 'supervisor'); }
function allowedEmployee(user, employee) {
  if (!employee) return false;
  if(user.self_only) return !!user.employee_id && employee.id === user.employee_id;
  if (canReadAll(user)) return true;
  if (user.role === 'supervisor') return !!user.department_scope && employee.department === user.department_scope;
  return user.role === 'viewer' && !!user.employee_id && employee.id === user.employee_id;
}
function employeePublic(row, user) {
  if (canReadAll(user)) return row;
  const { basic_salary, daily_incentive, transport_allowance, evening_amount, notes, ...safe } = row;
  return safe;
}
async function audit(db, user, type, entity = '', id = '', details = {}) {
  await db.prepare('INSERT INTO audit_events (id, organization_id, actor_user_id, event_type, entity_type, entity_id, details_json) VALUES (?,?,?,?,?,?,?)')
    .bind(uuid(), user?.organization_id || ORG, user?.id || null, type, entity, id, JSON.stringify(details)).run();
}
async function sessionUser(db, request) {
  const raw = cookie(request);
  if (!raw || raw.length < 30 || raw.length > 128) return null;
  const h = await hashText(raw);
  const user = await db.prepare('SELECT u.*,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.is_active=1')
    .bind(h, iso()).first();
  if(!user) return null;
  let selfOnly=user.role==='viewer';
  if(user.role!=='admin' && !selfOnly){
    const row=await db.prepare("SELECT allowed FROM user_permission_overrides WHERE organization_id=? AND user_id=? AND permission_key='data.self_only'").bind(user.organization_id,user.id).first();
    selfOnly=row?.allowed===1;
  }
  return {...user,self_only:selfOnly};
}
async function issueSession(db, user) {
  const raw = randomB64();
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  await db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)')
    .bind(await hashText(raw), user.id, expires).run();
  return setCookie(raw, SESSION_HOURS * 3600);
}
function settingsWhitelist(input) {
  const fields = ['org_name','start_time','end_time','thursday_end_time','work_days','weekly_off','grace_minutes','permission_minutes',
    'annual_leave_days','monthly_divisor','daily_minutes','cycle_start_day','cycle_end_day','payday',
    'incentive_threshold','incentive_penalty_percent','deduct_from','deductions_enabled',
    'closing_role','holiday_payday','currency'];
  const result = {};
  for (const k of fields) if (Object.prototype.hasOwnProperty.call(input, k)) {
    const v = input[k];
    if (!['string','number','boolean'].includes(typeof v)) throw Object.assign(new Error('قيمة إعداد غير صحيحة: ' + k), { status: 400 });
    result[k] = v;
  }
  if (result.currency && !['YER','SAR'].includes(result.currency)) throw Object.assign(new Error('العملة غير مدعومة'), { status: 400 });
  if (result.org_name && str(result.org_name,160).length < 2) throw Object.assign(new Error('اسم جهة غير صالح'), { status: 400 });
  const ranges = {grace_minutes:[0,180],permission_minutes:[0,10000],annual_leave_days:[0,365],monthly_divisor:[1,31],daily_minutes:[1,1440],cycle_start_day:[1,31],cycle_end_day:[1,31],payday:[1,31],incentive_penalty_percent:[0,100]};
  for (const [key,[min,max]] of Object.entries(ranges)) if (Object.prototype.hasOwnProperty.call(result,key)) {
    const value=Number(result[key]);
    if (!Number.isFinite(value)||value<min||value>max) throw Object.assign(new Error('قيمة خارج النطاق: '+key),{status:400});
    result[key]=value;
  }
  for (const key of ['start_time','end_time','thursday_end_time','incentive_threshold']) if (result[key]!==undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(result[key]))) {
    throw Object.assign(new Error('الوقت غير صحيح: '+key),{status:400});
  }
  // Stage 1 has no validated legal payroll rules; financial deductions stay disabled.
  result.deductions_enabled = false;
  return result;
}
async function setupRequired(db) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
  return !row || !row.n;
}
async function initialSetup(db, env, request) {
  if (!env.SETUP_TOKEN || env.SETUP_TOKEN.length < 24) return reject(503, 'إعداد سر التأسيس مطلوب في بيئة Cloudflare');
  if (!(await setupRequired(db))) return reject(409, 'تم إعداد المدير سابقًا');
  const body = await bodyJson(request);
  if (!safeEquals(body.setupToken || body.token, env.SETUP_TOKEN)) return reject(403, 'رمز التأسيس غير صالح');
  const email = emailVal(body.email), password = body.password, name = str(body.name || 'مدير النظام', 120);
  if (!validEmail(email) || !validPassword(password)) return reject(400, 'أدخل بريدًا صحيحًا وكلمة مرور لا تقل عن 12 حرفًا');
  const salt = randomB64(18), hash = await passwordHash(password, salt), uid = uuid();
  const result = await db.batch([
    db.prepare("INSERT INTO organizations(id,name) VALUES (?,?) ON CONFLICT(id) DO NOTHING").bind(ORG,str(body.org_name || 'جهة تجريبية',160)),
    db.prepare("INSERT INTO users(id,organization_id,name,email,role,password_hash,password_salt,password_iterations,must_change_password) SELECT ?,?,?,?,?,?,?,?,0 WHERE NOT EXISTS(SELECT 1 FROM users)")
      .bind(uid,ORG,name,email,'admin',hash,salt,PBKDF2_ROUNDS),
    db.prepare("INSERT INTO organization_settings(organization_id,data_json) VALUES (?,?) ON CONFLICT(organization_id) DO NOTHING").bind(ORG,'{}')
  ]);
  if (!result[1].meta?.changes) return reject(409, 'المدير موجود؛ لم تُنشأ بيانات أخرى');
  const user = await db.prepare('SELECT * FROM users WHERE id=?').bind(uid).first();
  await audit(db,user,'setup.admin_created','user',uid);
  return response({ user: publicUser(user) },201,{ 'set-cookie': await issueSession(db,user) });
}
async function login(db, request) {
  const body = await bodyJson(request);
  const email = emailVal(body.email), password = String(body.password || '');
  if (!validEmail(email) || password.length > 128) return reject(401, 'بيانات الدخول غير صحيحة');
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const bucket = await hashText('login|' + email + '|' + ip);
  const attempt = await db.prepare('SELECT attempts,locked_until,updated_at FROM login_attempts WHERE bucket=?').bind(bucket).first();
  if (attempt?.locked_until && attempt.locked_until > iso()) return reject(429,'محاولات كثيرة؛ أعد المحاولة بعد مدة');
  const user = await db.prepare('SELECT * FROM users WHERE email=? AND organization_id=? AND is_active=1').bind(email,ORG).first();
  const ok = user ? safeEquals(await passwordHash(password,user.password_salt,user.password_iterations),user.password_hash) : false;
  if (!ok) {
    const stale = !attempt?.updated_at || Date.now()-Date.parse(attempt.updated_at)>15*60000;
    const n = stale ? 1 : (attempt?.attempts || 0)+1;
    const expires = n >= 5 ? new Date(Date.now()+15*60000).toISOString() : null;
    await db.prepare('INSERT INTO login_attempts(bucket,attempts,locked_until,updated_at) VALUES (?,?,?,?) ON CONFLICT(bucket) DO UPDATE SET attempts=excluded.attempts,locked_until=excluded.locked_until,updated_at=excluded.updated_at')
      .bind(bucket,n,expires,iso()).run();
    return reject(401, 'بيانات الدخول غير صحيحة');
  }
  await db.prepare('DELETE FROM login_attempts WHERE bucket=?').bind(bucket).run();
  await audit(db,user,'auth.login','user',user.id);
  return response({ user:publicUser(user) },200,{ 'set-cookie':await issueSession(db,user) });
}
async function logout(db, request, user) {
  const raw = cookie(request);
  if (raw) await db.prepare('DELETE FROM sessions WHERE token_hash=?').bind(await hashText(raw)).run();
  if (user) await audit(db,user,'auth.logout','user',user.id);
  return response({ ok:true },200,{ 'set-cookie':setCookie('',0) });
}
async function createUser(db, actor, request) {
  const b = await bodyJson(request), email = emailVal(b.email), name = str(b.name,120), password = b.password;
  if (!validEmail(email) || name.length < 2 || !ROLES.has(b.role) || !validPassword(password)) return reject(400,'راجع اسم المستخدم وبريده ودوره وكلمة المرور');
  const employeeId = b.employee_id ? str(b.employee_id,80) : null;
  if (employeeId && !(await db.prepare('SELECT id FROM employees WHERE id=? AND organization_id=?').bind(employeeId,ORG).first())) return reject(400,'العامل غير موجود');
  if (['viewer'].includes(b.role) && !employeeId) return reject(400,'حساب الاطلاع الشخصي يتطلب ربط عامل');
  if (b.role==='supervisor'&&!str(b.department_scope)) return reject(400,'حدد قسم المشرف');
  const id=uuid(),salt=randomB64(18),hash=await passwordHash(password,salt);
  try {
    await db.prepare('INSERT INTO users(id,organization_id,employee_id,name,email,role,department_scope,password_hash,password_salt,password_iterations) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .bind(id,ORG,employeeId,name,email,b.role,str(b.department_scope,100)||null,hash,salt,PBKDF2_ROUNDS).run();
  } catch(e) { if (/UNIQUE/i.test(e.message)) return reject(409,'هذا البريد موجود');throw e; }
  await audit(db,actor,'user.created','user',id,{role:b.role});
  return response({ user:{id,name,email,role:b.role,employee_id:employeeId,must_change_password:1} },201);
}
async function updateUser(db, actor, id, request) {
  const b=await bodyJson(request), target=await db.prepare('SELECT * FROM users WHERE id=? AND organization_id=?').bind(id,ORG).first();
  if (!target) return reject(404,'المستخدم غير موجود');
  const role=b.role===undefined?target.role:b.role;
  if (!ROLES.has(role)) return reject(400,'دور غير صالح');
  const active=b.is_active===undefined?target.is_active:(b.is_active?1:0);
  if (target.id===actor.id && (!active||role!=='admin')) return reject(400,'لا يمكن تعطيل أو تخفيض صلاحيات حسابك');
  const employeeId=b.employee_id===undefined?target.employee_id:(b.employee_id||null);
  if (employeeId && !(await db.prepare('SELECT id FROM employees WHERE id=? AND organization_id=?').bind(employeeId,ORG).first())) return reject(400,'العامل غير موجود');
  const department=b.department_scope===undefined?target.department_scope:(str(b.department_scope,100)||null);
  if (role==='viewer'&&!employeeId) return reject(400,'المستخدم المقيد يحتاج ربطًا بعامل');
  if (role==='supervisor'&&!department) return reject(400,'المشرف يحتاج قسمًا');
  await db.prepare("UPDATE users SET role=?,is_active=?,employee_id=?,department_scope=?,updated_at=datetime('now') WHERE id=? AND organization_id=?")
    .bind(role,active,employeeId,department,id,ORG).run();
  if (!active || role!==target.role || employeeId!==target.employee_id || department!==target.department_scope) {
    await db.prepare('DELETE FROM sessions WHERE user_id=?').bind(id).run();
    if(!active || employeeId!==target.employee_id){
      await ensurePushStorage(db);
      await db.prepare('DELETE FROM push_subscriptions WHERE organization_id=? AND user_id=?').bind(ORG,id).run();
    }
  }
  await audit(db,actor,'user.updated','user',id,{role,active});
  return response({ok:true});
}
async function changePassword(db,user,request) {
  const b=await bodyJson(request);
  if (!validPassword(b.new_password)) return reject(400,'كلمة المرور الجديدة يجب أن تكون 12 حرفًا على الأقل');
  const check=await passwordHash(String(b.current_password || ''),user.password_salt,user.password_iterations);
  if (!safeEquals(check,user.password_hash)) return reject(403,'كلمة المرور الحالية غير صحيحة');
  const salt=randomB64(18),hash=await passwordHash(b.new_password,salt);
  await db.prepare("UPDATE users SET password_hash=?,password_salt=?,password_iterations=?,must_change_password=0,updated_at=datetime('now') WHERE id=?")
    .bind(hash,salt,PBKDF2_ROUNDS,user.id).run();
  await db.prepare('DELETE FROM sessions WHERE user_id=?').bind(user.id).run();
  await audit(db,user,'auth.password_changed','user',user.id);
  return response({ok:true,reauth_required:true},200,{ 'set-cookie':setCookie('',0) });
}
function employeePayload(b, current={}) {
  const candidate={...current,...b};
  const idCode=str(candidate.code,40),name=str(candidate.name,140);
  if (!idCode || !name) throw Object.assign(new Error('رقم العامل واسمه مطلوبان'),{status:400});
  const type=['regular','trial','task'].includes(candidate.type)?candidate.type:'regular';
  const status=['active','inactive'].includes(candidate.status)?candidate.status:'active';
  return {
    code:idCode,device_user_id:str(candidate.device_user_id,40)||null,name,
    department:str(candidate.department,90),position:str(candidate.position,90),type,
    status,notes:str(candidate.notes,1000),
    basic_salary:amount(candidate.basic_salary),transport_allowance:amount(candidate.transport_allowance),
    daily_incentive:amount(candidate.daily_incentive),evening_amount:amount(candidate.evening_amount)
  };
}
async function people(db,user,method,id,request){
  if (method==='GET' && !id){
    let sql='SELECT * FROM employees WHERE organization_id=?',params=[ORG];
    if (user.self_only) {sql+=' AND id=?';params.push(user.employee_id||'');}
    else if (user.role==='supervisor') {sql+=' AND department=?';params.push(user.department_scope||'');}
    sql+=' ORDER BY name LIMIT 2000';
    const rows=await db.prepare(sql).bind(...params).all();
    return response({items:rows.results.map(e=>employeePublic(e,user))});
  }
  if (!canEditPeople(user)) return reject(403,'ليس لديك صلاحية لتعديل العاملين');
  const b=await bodyJson(request);
  let row, data, eid=id;
  if (method==='PUT'){
    row=await db.prepare('SELECT * FROM employees WHERE id=? AND organization_id=?').bind(id,ORG).first();
    if (!row) return reject(404,'العامل غير موجود');
    data=employeePayload(b,row);
    await db.prepare("UPDATE employees SET code=?,device_user_id=?,name=?,department=?,position=?,type=?,status=?,notes=?,basic_salary=?,transport_allowance=?,daily_incentive=?,evening_amount=?,updated_at=datetime('now') WHERE id=? AND organization_id=?")
      .bind(data.code,data.device_user_id,data.name,data.department,data.position,data.type,data.status,data.notes,data.basic_salary,data.transport_allowance,data.daily_incentive,data.evening_amount,id,ORG).run();
    await audit(db,user,'employee.updated','employee',id);
  }else if(method==='POST'&&!id){
    data=employeePayload(b);eid=uuid();
    await db.prepare('INSERT INTO employees (id,organization_id,code,device_user_id,name,department,position,type,status,notes,basic_salary,transport_allowance,daily_incentive,evening_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .bind(eid,ORG,data.code,data.device_user_id,data.name,data.department,data.position,data.type,data.status,data.notes,data.basic_salary,data.transport_allowance,data.daily_incentive,data.evening_amount).run();
    await audit(db,user,'employee.created','employee',eid);
  }else return reject(405,'إجراء غير مدعوم');
  return response({item:{id:eid,...data}},method==='POST'?201:200);
}
async function punches(db,user,method,request){
  if (method==='GET'){
    let sql='SELECT p.id,p.employee_id,p.occurred_at AS timestamp,p.kind,p.source,p.created_at FROM punch_events p JOIN employees e ON e.id=p.employee_id WHERE p.organization_id=?',args=[ORG];
    if (user.self_only){sql+=' AND p.employee_id=?';args.push(user.employee_id||'');}
    if (user.role==='supervisor'&&!user.self_only){sql+=' AND e.department=?';args.push(user.department_scope||'');}
    sql+=' ORDER BY p.occurred_at DESC LIMIT 2000';
    const rows=await db.prepare(sql).bind(...args).all();
    // MB10 punches remain immutable in device_raw_punches. Expose matched, unambiguous
    // device events alongside manual entries without copying or double-posting data.
    let deviceSql="SELECT r.event_fingerprint,r.occurred_at_device AS timestamp,r.punch_code,e.id AS employee_id FROM device_raw_punches r JOIN employees e ON e.organization_id=r.organization_id AND e.device_user_id=r.device_user_id WHERE r.organization_id=? AND r.device_id='mb10-main' AND r.punch_code IN (0,1) AND NOT EXISTS (SELECT 1 FROM punch_events p WHERE p.organization_id=r.organization_id AND p.device_id=r.device_id AND p.device_event_id=r.event_fingerprint)";
    const deviceArgs=[ORG];
    if(user.self_only){deviceSql+=' AND e.id=?';deviceArgs.push(user.employee_id||'');}
    if(user.role==='supervisor'&&!user.self_only){deviceSql+=' AND e.department=?';deviceArgs.push(user.department_scope||'');}
    deviceSql+=' ORDER BY r.occurred_at_device DESC LIMIT 2000';
    const deviceRows=(await db.prepare(deviceSql).bind(...deviceArgs).all()).results||[];
    const deviceItems=deviceRows.map(r=>({id:'device:'+r.event_fingerprint,employee_id:r.employee_id,
      timestamp:r.timestamp,kind:r.punch_code===0?'in':'out',source:'device',
      device_id:'mb10-main',device_event_id:r.event_fingerprint,read_only:true}));
    const items=[...(rows.results||[]),...deviceItems].sort((a,b)=>b.timestamp.localeCompare(a.timestamp)).slice(0,2000);
    return response({items,device_count:deviceItems.length});
  }
  if (method!=='POST'||!canWritePunch(user)) return reject(403,'ليس لديك صلاحية تسجيل حركة حضور');
  const b=await bodyJson(request),employee=await db.prepare('SELECT * FROM employees WHERE id=? AND organization_id=?').bind(str(b.employee_id,80),ORG).first();
  if (!employee || !allowedEmployee(user,employee)) return reject(403,'هذا العامل ليس ضمن نطاق صلاحيتك');
  const timestamp=str(b.timestamp,35),kind=str(b.kind,10);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(timestamp)||!KINDS.has(kind)) return reject(400,'تاريخ أو نوع حركة غير صالح');
  // Client-generated UUID makes offline retries idempotent even if the response is lost.
  const clientEventId=b.client_event_id===undefined?null:str(b.client_event_id,80);
  if(clientEventId!==null&&!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(clientEventId))
    return reject(400,'معرف مزامنة الحركة غير صالح');
  const deviceId=clientEventId?'offline-manual':null;
  if(clientEventId){
    const existing=await db.prepare('SELECT id,employee_id,occurred_at,kind,source FROM punch_events WHERE organization_id=? AND device_id=? AND device_event_id=?')
      .bind(ORG,deviceId,clientEventId).first();
    if(existing){
      if(existing.employee_id!==employee.id||existing.occurred_at!==timestamp||existing.kind!==kind||existing.source!=='manual')
        return reject(409,'معرف الحركة مستخدم لبيانات مختلفة؛ يلزم مراجعة المزامنة');
      return response({item:{id:existing.id,employee_id:employee.id,timestamp,kind,source:'manual'},duplicate:true,synced:true});
    }
  }
  const id=uuid();
  try{
    await db.batch([
      db.prepare("INSERT INTO punch_events(id,organization_id,employee_id,occurred_at,kind,source,device_id,device_event_id,entered_by) VALUES(?,?,?,?,?,'manual',?,?,?)")
        .bind(id,ORG,employee.id,timestamp,kind,deviceId,clientEventId,user.id),
      db.prepare('INSERT INTO audit_events(id,organization_id,actor_user_id,event_type,entity_type,entity_id,details_json) VALUES (?,?,?,?,?,?,?)')
        .bind(uuid(),ORG,user.id,'punch.manual_created','punch',id,JSON.stringify({employee_id:employee.id,offline:!!clientEventId}))
    ]);
  }catch(error){
    if(clientEventId&&/UNIQUE/i.test(String(error?.message||''))){
      const saved=await db.prepare('SELECT id,employee_id,occurred_at,kind,source FROM punch_events WHERE organization_id=? AND device_id=? AND device_event_id=?')
        .bind(ORG,deviceId,clientEventId).first();
      if(saved&&saved.employee_id===employee.id&&saved.occurred_at===timestamp&&saved.kind===kind&&saved.source==='manual')
        return response({item:{id:saved.id,employee_id:employee.id,timestamp,kind,source:'manual'},duplicate:true,synced:true});
    }
    throw error;
  }
  return response({item:{id,employee_id:employee.id,timestamp,kind,source:'manual'},synced:true},201);
}

/* Allow auditable corrections only for manual punch rows. */
async function correctManualPunch(db,user,id,request){
  if(!canEditPeople(user))return reject(403,'تعديل البصمات اليدوية للمدير وشؤون العاملين فقط');
  const prior=await db.prepare("SELECT id,employee_id,occurred_at,kind,source FROM punch_events WHERE id=? AND organization_id=?").bind(id,ORG).first();
  if(!prior)return reject(404,'البصمة غير موجودة');
  if(prior.source!=='manual')return reject(403,'لا يمكن تعديل بصمات الجهاز من هذه الشاشة');
  const b=await bodyJson(request),reason=str(b.reason,500),original=b.original;
  if(reason.length<5)return reject(400,'اكتب سبب التصحيح بخمسة أحرف على الأقل');
  if(!original||typeof original!=='object'||original.employee_id!==prior.employee_id||original.timestamp!==prior.occurred_at||original.kind!==prior.kind)
    return reject(409,'تغيرت الحركة؛ حدّث القائمة وحاول مجددًا');
  const timestamp=str(b.timestamp,35),kind=str(b.kind,10),employeeId=str(b.employee_id,80);
  if(!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(timestamp)||!KINDS.has(kind))
    return reject(400,'التاريخ أو نوع الحركة غير صالح');
  const parsed=timestamp.length===16?timestamp+':00':timestamp;
  const date=new Date(parsed+'Z');
  if(Number.isNaN(date.getTime())||date.toISOString().slice(0,19)!==parsed)return reject(400,'التاريخ غير صحيح');
  const employee=await db.prepare('SELECT * FROM employees WHERE id=? AND organization_id=?').bind(employeeId,ORG).first();
  if(!employee)return reject(404,'العامل غير موجود');
  if(prior.employee_id===employeeId&&prior.occurred_at===timestamp&&prior.kind===kind)return reject(400,'لم يتم تعديل أي بيانات');
  const update=await db.prepare("UPDATE punch_events SET employee_id=?,occurred_at=?,kind=? WHERE id=? AND organization_id=? AND source='manual' AND employee_id=? AND occurred_at=? AND kind=?")
    .bind(employeeId,timestamp,kind,id,ORG,prior.employee_id,prior.occurred_at,prior.kind).run();
  if(update.meta?.changes!==1)return reject(409,'تغير السجل أثناء التعديل؛ لم يتم حفظ التصحيح');
  await audit(db,user,'punch.manual_corrected','punch',id,{before:{employee_id:prior.employee_id,timestamp:prior.occurred_at,kind:prior.kind},after:{employee_id:employeeId,timestamp,kind},reason});
  return response({corrected:true,item:{id,employee_id:employeeId,timestamp,kind,source:'manual'}});
}

/* Administrator-only selective removal of manual test punches.
   Never touches MB10 raw logs, imported/device events, or nonselected records. */

/* Correct MB10 device records without mutating immutable raw data.
   Corrected records live in punch_events and override the matching raw fingerprint. */
async function correctDevicePunch(db,user,request){
 if(!canEditPeople(user))return reject(403,'تصحيح بصمات الجهاز للمدير وشؤون العاملين فقط');
 const b=await bodyJson(request);
 const fingerprint=str(b.event_fingerprint,64);
 if(!/^[a-f0-9]{64}$/.test(fingerprint))return reject(400,'معرف البصمة غير صالح');
 const reason=str(b.reason,500);
 if(reason.length<5)return reject(400,'اكتب سبب التصحيح بخمسة أحرف على الأقل');
 const employeeId=str(b.employee_id,80),timestamp=str(b.timestamp,35),kind=str(b.kind,10);
 if(!/^[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9])?$/.test(timestamp)||!KINDS.has(kind))
   return reject(400,'التاريخ أو نوع الحركة غير صالح');
 const parsed=timestamp.length===16?timestamp+':00':timestamp, check=new Date(parsed+'Z');
 if(Number.isNaN(check.getTime())||check.toISOString().slice(0,19)!==parsed)return reject(400,'تاريخ غير صحيح');
 const raw=await db.prepare("SELECT event_fingerprint,device_user_id,occurred_at_device,punch_code FROM device_raw_punches WHERE organization_id=? AND device_id='mb10-main' AND event_fingerprint=?")
   .bind(ORG,fingerprint).first();
 if(!raw)return reject(404,'البصمة الأصلية غير موجودة');
 const employee=await db.prepare('SELECT id,name FROM employees WHERE organization_id=? AND id=?').bind(ORG,employeeId).first();
 if(!employee)return reject(404,'العامل غير موجود');
 const existing=await db.prepare("SELECT id,employee_id,occurred_at,kind FROM punch_events WHERE organization_id=? AND device_id='mb10-main' AND device_event_id=?")
   .bind(ORG,fingerprint).first();
 const old=existing?{employee_id:existing.employee_id,timestamp:existing.occurred_at,kind:existing.kind}:
   {device_user_id:raw.device_user_id,timestamp:raw.occurred_at_device,punch_code:raw.punch_code};
 // The underlying raw event never changes; reject no-op corrections and require
 // confirmation of the snapshot the administrator actually reviewed.
 const originalEmployee=await db.prepare('SELECT id FROM employees WHERE organization_id=? AND device_user_id=?').bind(ORG,raw.device_user_id).first();
 const currentEmployee=existing?.employee_id||originalEmployee?.id||null;
 const currentTimestamp=existing?.occurred_at||raw.occurred_at_device;
 const currentKind=existing?.kind||(raw.punch_code===0?'in':raw.punch_code===1?'out':'other');
 if(currentEmployee===employeeId&&currentTimestamp===timestamp&&currentKind===kind)return reject(400,'لم تتغير بيانات الحركة');
 if(!b.original||b.original.employee_id!==currentEmployee||b.original.timestamp!==currentTimestamp||b.original.kind!==currentKind)
   return reject(409,'تغيرت الحركة أو بيانات العامل؛ حدّث القائمة وراجع التصحيح');
 const auditStmt=db.prepare('INSERT INTO audit_events(id,organization_id,actor_user_id,event_type,entity_type,entity_id,details_json) VALUES (?,?,?,?,?,?,?)')
   .bind(uuid(),ORG,user.id,'punch.device_corrected','punch',fingerprint,JSON.stringify({before:old,after:{employee_id:employeeId,timestamp,kind},reason}));
 if(existing){
   const updated=db.prepare("UPDATE punch_events SET employee_id=?,occurred_at=?,kind=?,correction_reason=? WHERE id=? AND organization_id=? AND device_id='mb10-main' AND device_event_id=? AND employee_id=? AND occurred_at=? AND kind=?")
     .bind(employeeId,timestamp,kind,reason,existing.id,ORG,fingerprint,existing.employee_id,existing.occurred_at,existing.kind);
   const result=await db.batch([updated,auditStmt]);
   if(result[0].meta?.changes!==1)return reject(409,'تغيرت الحركة، حدث البيانات وأعد المحاولة');
 }else{
   const created=db.prepare("INSERT INTO punch_events(id,organization_id,employee_id,occurred_at,kind,source,device_id,device_event_id,correction_reason,entered_by) VALUES (?,?,?,?,?,'device','mb10-main',?,?,?)")
     .bind(uuid(),ORG,employeeId,timestamp,kind,fingerprint,reason,user.id);
   await db.batch([created,auditStmt]);
 }
 return response({corrected:true,event_fingerprint:fingerprint,source:'device',original_preserved:true});
}

async function manualPunchCleanup(db,user,method,request){
  if(user.self_only||user.role!=='admin')return reject(403,'هذه العملية لمدير النظام فقط');
  const u=new URL(request.url);
  const body=method==='POST'?await bodyJson(request):null;
  const date=str(method==='POST'?body?.date:u.searchParams.get('date'),10);
  weekdayOf(date);
  const start=date+' 00:00:00';
  const next=new Date(date+'T12:00:00Z');
  next.setUTCDate(next.getUTCDate()+1);
  const end=next.toISOString().slice(0,10)+' 00:00:00';
  // SQLite created_at is UTC; compare Yemen local creation day (+03:00).
  const predicate="p.organization_id=? AND p.source='manual' AND datetime(p.created_at,'+3 hours')>=? AND datetime(p.created_at,'+3 hours')<?";
  const args=[ORG,start,end];
  const select="SELECT p.id,p.employee_id,e.name AS employee_name,p.occurred_at AS timestamp,p.kind,p.source,p.created_at FROM punch_events p JOIN employees e ON e.id=p.employee_id WHERE "+predicate;
  if(method==='GET'){
    const records=(await db.prepare(select+' ORDER BY p.created_at ASC LIMIT 1001').bind(...args).all()).results||[];
    if(records.length>1000)return reject(409,'عدد الحركات كبير؛ يرجى مراجعتها إداريًا');
    return response({date,items:records,timezone:'Asia/Aden',count:records.length,deleted:false});
  }
  if(method!=='POST')return reject(405,'إجراء غير مدعوم');
  const ids=body?.ids;
  if(body?.confirm!==true||!Array.isArray(ids)||ids.length<1||ids.length>100||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(id)))
    return reject(400,'حدد الحركات المراد حذفها وأكد الطلب');
  const selected=(await db.prepare(select+' AND p.id IN ('+ids.map(()=>'?').join(',')+')').bind(...args,...ids).all()).results||[];
  if(selected.length!==ids.length)return reject(409,'تغيرت القائمة؛ حدثها وراجع الاختيار');
  const statements=selected.map(row=>db.prepare("DELETE FROM punch_events WHERE id=? AND organization_id=? AND source='manual' AND datetime(created_at,'+3 hours')>=? AND datetime(created_at,'+3 hours')<?")
    .bind(row.id,ORG,start,end));
  statements.push(db.prepare('INSERT INTO audit_events(id,organization_id,actor_user_id,event_type,entity_type,entity_id,details_json) VALUES (?,?,?,?,?,?,?)')
    .bind(uuid(),ORG,user.id,'punch.manual_test_deleted','punch','batch',JSON.stringify({date,timezone:'Asia/Aden',deleted:selected})));
  // D1 batch executes atomically; inspect affected rows before reporting success.
  const result=await db.batch(statements);
  const deleted=result.slice(0,-1).reduce((sum,item)=>sum+(item.meta?.changes||0),0);
  return response({deleted,requested:ids.length,date,refresh_required:true});
}

async function settings(db,user,method,request){
  if (method==='GET'){
    const row=await db.prepare('SELECT data_json FROM organization_settings WHERE organization_id=?').bind(ORG).first();
    const cfg=JSON.parse(row?.data_json||'{}');
    return response({settings:user.self_only?Object.fromEntries(['start_time','end_time','thursday_end_time','weekly_off','work_days'].filter(k=>cfg[k]!==undefined).map(k=>[k,cfg[k]])):cfg});
  }
  if (method!=='PUT'||user.role!=='admin') return reject(403,'الإعدادات للمدير فقط');
  const b=await bodyJson(request);
  const input=b.settings&&typeof b.settings==='object'&&!Array.isArray(b.settings)?b.settings:{};
  const clean=settingsWhitelist(input);
  await db.prepare("INSERT INTO organization_settings (organization_id,data_json,updated_by) VALUES (?,?,?) ON CONFLICT(organization_id) DO UPDATE SET data_json=excluded.data_json,updated_by=excluded.updated_by,updated_at=datetime('now')")
    .bind(ORG,JSON.stringify(clean),user.id).run();
  if (clean.org_name) await db.prepare("UPDATE organizations SET name=?,updated_at=datetime('now') WHERE id=?").bind(clean.org_name,ORG).run();
  await audit(db,user,'settings.updated','organization',ORG,{keys:Object.keys(clean)});
  return response({settings:clean});
}


/* Attendance schedule v0.2.6: local Yemen time (Asia/Aden), Friday weekly rest.
   This endpoint reports observed elapsed time, not payroll deductions or approved overtime. */
const DEFAULT_ATTENDANCE_SCHEDULE = Object.freeze({
  start_time:'07:30', end_time:'13:45', thursday_end_time:'13:15', weekly_off:'friday'
});
function weekdayOf(dateText) {
  const d = new Date(dateText+'T12:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateText)||Number.isNaN(d.getTime())||d.toISOString().slice(0,10)!==dateText)
    throw Object.assign(new Error('التاريخ غير صحيح'),{status:400});
  return d.getUTCDay(); // 0 Sunday, 4 Thursday, 5 Friday
}
function minutesOf(hhmm){const a=String(hhmm).split(':').map(Number);return a[0]*60+a[1];}
function punchSeconds(s){const m=/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(String(s));return m?Number(m[1])*3600+Number(m[2])*60+Number(m[3]||0):null}

function clippedSeconds(a,b,x,y){return Math.max(0,Math.min(b,y)-Math.max(a,x))}

function moneyRound(n){return Math.round((n+Number.EPSILON)*100)/100}

function attendanceDay(events,dateText,config,employee=null,canSeeFinancial=false){
 const weekday=weekdayOf(dateText),off=weekday===5;
 const start=config.start_time||DEFAULT_ATTENDANCE_SCHEDULE.start_time;
 const end=weekday===4?(config.thursday_end_time||DEFAULT_ATTENDANCE_SCHEDULE.thursday_end_time):(config.end_time||DEFAULT_ATTENDANCE_SCHEDULE.end_time);
 const startSecond=punchSeconds(dateText+'T'+start),endSecond=punchSeconds(dateText+'T'+end);
 if(startSecond===null||endSecond===null||endSecond<=startSecond)throw Object.assign(new Error('ساعات الدوام في الإعدادات غير صالحة'),{status:400});
 const ordered=events.filter(e=>e.timestamp.slice(0,10)===dateText).sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
 let firstIn=null,firstSecond=null,activeIn=null,lastOut=null,workSeconds=0,dutySeconds=0,absenceSeconds=0;
 const absencePeriods=[],issues=[];
 if(ordered.some(e=>e.source==='device'))issues.push('device_classification_requires_review');
 for(const event of ordered){
   const second=punchSeconds(event.timestamp);
   if(second===null){issues.push('invalid_timestamp');continue}
   if(event.kind==='in'){
     if(activeIn!==null){
       if(second-activeIn.second>120)issues.push('unmatched_extra_checkin');
       continue
     }
     if(lastOut!==null){
       const gap=second-lastOut.second;
       if(gap<0){issues.push('out_of_order_return');continue}
       const overlap=clippedSeconds(lastOut.second,second,startSecond,endSecond);
       absenceSeconds+=overlap;
       absencePeriods.push({out_at:lastOut.timestamp,return_at:event.timestamp,duration_minutes:Math.round(gap/60),during_duty_minutes:off?0:Math.round(overlap/60)});
       if(gap<=120)issues.push('rapid_exit_and_return');
       lastOut=null;
     }else if(firstIn===null){firstIn=event.timestamp;firstSecond=second}
     activeIn={timestamp:event.timestamp,second};
   }else if(event.kind==='out'){
     if(activeIn!==null){
       if(second<activeIn.second){issues.push('checkout_before_checkin');continue}
       workSeconds+=second-activeIn.second;
       dutySeconds+=clippedSeconds(activeIn.second,second,startSecond,endSecond);
       activeIn=null;lastOut={timestamp:event.timestamp,second};
     }else if(lastOut!==null){
       if(second-lastOut.second>120)issues.push('unmatched_extra_checkout');
     }else issues.push('checkout_without_checkin');
   }else issues.push('unknown_punch_kind');
 }
 const finalOut=lastOut?.timestamp||null;
 const span=firstIn&&finalOut?Math.round((lastOut.second-firstSecond)/60):null;
 const late=off||firstIn===null?0:Math.max(0,Math.round((Math.min(firstSecond,endSecond)-startSecond)/60));
 const early=off||finalOut===null?0:Math.max(0,Math.round((endSecond-Math.max(lastOut.second,startSecond))/60));
 const absence=off?0:Math.round(absenceSeconds/60);
 const status=off?'weekly_off':!firstIn?'no_checkin':activeIn?'missing_checkout':'completed';
 const requiresReview=issues.length>0||(!off&&status!=='completed');
 const totalMinutes=off?0:late+absence+early;
 const result={date:dateText,weekly_off:off,scheduled_start:off?null:start,scheduled_end:off?null:end,
   first_in:firstIn,last_out:finalOut,span_minutes:span,elapsed_minutes:Math.round(workSeconds/60),
   worked_minutes:Math.round(workSeconds/60),worked_during_duty_minutes:Math.round(dutySeconds/60),
   late_minutes:late,absence_minutes:absence,absence_periods:absencePeriods,early_exit_minutes:early,
   total_deductible_minutes:totalMinutes,status,requires_review:requiresReview,review_issues:issues,punch_count:ordered.length};
 // Read-only preliminary calculation. No payroll changes or approval action.
 if(canSeeFinancial){
   let preview=null;
   if(!requiresReview&&employee){
     const divisor=Number(config.monthly_divisor||30)*Number(config.daily_minutes||375);
     const monthly=Number(employee.basic_salary||0)+Number(employee.transport_allowance||0);
     if(divisor>0&&Number.isFinite(monthly)){
       const rate=monthly/divisor;
       const lateMoney=moneyRound(rate*late),absenceMoney=moneyRound(rate*absence),earlyMoney=moneyRound(rate*early);
       const threshold=punchSeconds(dateText+'T'+(config.incentive_threshold||'08:00'));
       const bonusRate=Number(config.incentive_penalty_percent??50)/100;
       const incentive=off||firstSecond===null||threshold===null||firstSecond<=threshold?0:moneyRound(Number(employee.daily_incentive||0)*bonusRate);
       preview={late_deduction:lateMoney,intermediate_absence_deduction:absenceMoney,early_exit_deduction:earlyMoney,
         base_and_transport_deduction:moneyRound(lateMoney+absenceMoney+earlyMoney),
         incentive_deduction:incentive,total_deduction_estimate:moneyRound(lateMoney+absenceMoney+earlyMoney+incentive),
         currency:config.currency||'YER',draft:true,approved:false};
     }
   }
   result.deduction_preview=preview;
 }
 return result;
}

async function attendanceSummary(db,user,request){
  const u=new URL(request.url),date=u.searchParams.get('date')||'';
  weekdayOf(date);
  const requested=str(u.searchParams.get('employee_id')||'',80);
  let sql="SELECT p.employee_id,p.occurred_at AS timestamp,p.kind,e.basic_salary,e.transport_allowance,e.daily_incentive FROM punch_events p JOIN employees e ON e.id=p.employee_id WHERE p.organization_id=? AND p.occurred_at>=? AND p.occurred_at<?";
  const args=[ORG,date+'T00:00',date+'T23:59:59.999'];
  if(requested){sql+=' AND p.employee_id=?';args.push(requested);}
  if(user.self_only){sql+=' AND p.employee_id=?';args.push(user.employee_id||'');}
  if(user.role==='supervisor'){sql+=' AND e.department=?';args.push(user.department_scope||'');}
  sql+=' ORDER BY p.occurred_at ASC LIMIT 10001';
  const manualEvents=(await db.prepare(sql).bind(...args).all()).results||[];
  if(manualEvents.length>10000)return reject(409,'عدد الحركات كبير؛ يلزم تضييق نطاق الاستعلام');
  let deviceSql="SELECT e.id AS employee_id,r.occurred_at_device AS timestamp,r.punch_code,e.basic_salary,e.transport_allowance,e.daily_incentive FROM device_raw_punches r JOIN employees e ON e.organization_id=r.organization_id AND e.device_user_id=r.device_user_id WHERE r.organization_id=? AND r.device_id='mb10-main' AND r.occurred_at_device>=? AND r.occurred_at_device<? AND r.punch_code IN (0,1) AND NOT EXISTS (SELECT 1 FROM punch_events p WHERE p.organization_id=r.organization_id AND p.device_id=r.device_id AND p.device_event_id=r.event_fingerprint)";
  const deviceArgs=[ORG,date+'T00:00',date+'T23:59:59.999'];
  if(requested){deviceSql+=' AND e.id=?';deviceArgs.push(requested);}
  if(user.self_only){deviceSql+=' AND e.id=?';deviceArgs.push(user.employee_id||'');}
  if(user.role==='supervisor'&&!user.self_only){deviceSql+=' AND e.department=?';deviceArgs.push(user.department_scope||'');}
  deviceSql+=' ORDER BY r.occurred_at_device ASC LIMIT 10001';
  const deviceRaw=(await db.prepare(deviceSql).bind(...deviceArgs).all()).results||[];
  if(deviceRaw.length>10000)return reject(409,'عدد الحركات كبير؛ يلزم تضييق نطاق الاستعلام');
  const events=[...manualEvents,...deviceRaw.map(r=>({...r,kind:r.punch_code===0?'in':'out',source:'device'}))];
  // Punch classification from device codes is provisional; deduction preview needs
  // explicit manager review before any financial approval or posting.
  const row=await db.prepare('SELECT data_json FROM organization_settings WHERE organization_id=?').bind(ORG).first();
  const config={...DEFAULT_ATTENDANCE_SCHEDULE,...JSON.parse(row?.data_json||'{}')};
  const employeeRows=new Map(events.map(e=>[e.employee_id,e]));
  const ids=[...new Set(events.map(e=>e.employee_id))];
  if(requested&&!ids.includes(requested)){
    const employee=await db.prepare('SELECT * FROM employees WHERE id=? AND organization_id=?').bind(requested,ORG).first();
    if(!allowedEmployee(user,employee))return reject(403,'هذا العامل ليس ضمن نطاق صلاحيتك');
    ids.push(requested);employeeRows.set(requested,employee);
  }
  const showFinancial=canReadAll(user);
  return response({date,items:ids.map(id=>({employee_id:id,
    ...attendanceDay(events.filter(e=>e.employee_id===id),date,config,employeeRows.get(id),showFinancial)})),
    schedule:{start_time:config.start_time,end_time:config.end_time,thursday_end_time:config.thursday_end_time,weekly_off:'friday'},
    financial_mode:'draft_preview_only',device_events_included:deviceRaw.length,device_classification_provisional:true});
}


/* Self-service attendance, not a direct MB10 scan-status feed. */
function todayAden(){
 const f=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Aden',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(x=>[x.type,x.value]));
 return f.year+'-'+f.month+'-'+f.day;
}
async function myAttendance(db,user,request){
 if(!user.employee_id)return response({linked:false,alerts:[{code:'unlinked',level:'warning',title:'حسابك غير مربوط بعامل',message:'اطلب من المدير ربط حسابك بسجل العامل الصحيح.'}]});
 const employee=await db.prepare('SELECT id,name,code,status FROM employees WHERE organization_id=? AND id=?').bind(user.organization_id,user.employee_id).first();
 if(!employee)return response({linked:false,alerts:[{code:'invalid_link',level:'warning',title:'ربط العامل يحتاج تصحيحًا',message:'يرجى التواصل مع الإدارة.'}]});
 const today=todayAden(),p=new URL(request.url).searchParams,date=str(p.get('date')||today,10);
 weekdayOf(date);
 if(date>today)return reject(400,'تاريخ مستقبلي غير متاح');
 // Unlike payroll previews, the worker's personal record MUST include every MB10
 // biometric event, including unknown punch_code such as 255. Corrected events
 // are included once, and immutable raw events are never changed.
 const startDay=date+'T00:00:00',endDay=date+'T23:59:59.999';
 const personSql=[
  "SELECT timestamp,kind,source,raw_code FROM (",
  "SELECT p.occurred_at AS timestamp,p.kind,p.source,r.punch_code AS raw_code FROM punch_events p",
  "LEFT JOIN device_raw_punches r ON r.organization_id=p.organization_id AND r.device_id=p.device_id AND r.event_fingerprint=p.device_event_id",
  "WHERE p.organization_id=? AND p.employee_id=? AND p.occurred_at>=? AND p.occurred_at<=?",
  "UNION ALL",
  "SELECT r.occurred_at_device AS timestamp,CASE r.punch_code WHEN 0 THEN 'in' WHEN 1 THEN 'out' ELSE 'other' END AS kind, 'device' AS source,r.punch_code AS raw_code",
  "FROM device_raw_punches r JOIN employees e ON e.organization_id=r.organization_id AND e.device_user_id=r.device_user_id",
  "WHERE r.organization_id=? AND e.id=? AND r.device_id='mb10-main' AND r.occurred_at_device>=? AND r.occurred_at_device<=?",
  "AND NOT EXISTS (SELECT 1 FROM punch_events p WHERE p.organization_id=r.organization_id AND p.device_id=r.device_id AND p.device_event_id=r.event_fingerprint)",
  ") ORDER BY timestamp ASC LIMIT 501"
 ].join(' ');
 const personalRows=(await db.prepare(personSql)
   .bind(user.organization_id,user.employee_id,startDay,endDay,user.organization_id,user.employee_id,startDay,endDay).all()).results||[];
 const grouped=[],keys=new Map();
 for(const r of personalRows.slice(0,500)){
  const key=r.source==='device'?r.timestamp+'|'+r.kind+'|'+String(r.raw_code):null;
  const existing=key?keys.get(key):null;
  if(existing){existing.record_count++;continue;}
  const entry={timestamp:r.timestamp,kind:r.kind,source:r.source,raw_code:r.raw_code,record_count:1};
  grouped.push(entry);
  if(key)keys.set(key,entry);
 }
 const rawCount=personalRows.filter(r=>r.source==='device').length;
 const hasUnclassified=personalRows.some(r=>r.kind==='other');
 const deviceRows=personalRows.filter(r=>r.source==='device');
 const biometric={total_movements:personalRows.length,device_movements:rawCount,
  first_recorded:personalRows[0]?.timestamp||null,last_recorded:personalRows[personalRows.length-1]?.timestamp||null,
  first_device_recorded:deviceRows[0]?.timestamp||null,last_device_recorded:deviceRows[deviceRows.length-1]?.timestamp||null,
  has_unclassified:hasUnclassified,truncated:personalRows.length>500};
 const url=new URL(request.url);url.pathname='/api/attendance-summary';url.searchParams.set('date',date);url.searchParams.set('employee_id',user.employee_id);
 const res=await attendanceSummary(db,{...user,self_only:true},new Request(url.toString(),request));
 if(!res.ok)return res;
 const report=await res.json(),day=report.items?.[0];
 if(!day)return reject(404,'لا توجد بيانات للعامل المرتبط');
 const row=await db.prepare('SELECT state,finished_at FROM mb10_sync_jobs WHERE organization_id=? ORDER BY requested_at DESC LIMIT 1').bind(user.organization_id).first();
 const successfulSync=await db.prepare("SELECT finished_at FROM mb10_sync_jobs WHERE organization_id=? AND state='done' AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1").bind(user.organization_id).first();
 const shiftEnd=day.scheduled_end,shiftStart=day.scheduled_start;
 const minuteDelay=15*60000,now=Date.now();
 const deadline=time=>Date.parse(date+'T'+time+':00+03:00')+minuteDelay;
 const syncAt=successfulSync?.finished_at?Date.parse(successfulSync.finished_at.replace(' ','T')+'Z'):NaN;
 const afterStart=!!shiftStart&&now>=deadline(shiftStart),afterEnd=!!shiftEnd&&now>=deadline(shiftEnd);
 const syncedStart=Number.isFinite(syncAt)&&!!shiftStart&&syncAt>=deadline(shiftStart);
 const syncedEnd=Number.isFinite(syncAt)&&!!shiftEnd&&syncAt>=deadline(shiftEnd);
 const alerts=[],add=(code,level,title,message)=>alerts.push({code,level,title,message});
 if(employee.status!=='active')add('inactive','info','حساب العامل غير نشط','راجع الإدارة بشأن نظام دوامك.');
 else if(day.weekly_off)add('weekly_off','info','اليوم إجازة أسبوعية','لا يلزم تبصيم حضور اعتيادي يوم الجمعة.');
 else {
  if((day.review_issues||[]).some(x=>x!=='device_classification_requires_review'))
    add('review','warning','حركة بصمة تحتاج مراجعة','هناك تسلسل غير مكتمل؛ راجع الإدارة ولا تُعدل البصمة الأصلية.');
  if(!day.first_in&&afterStart){
   if(biometric.total_movements>0)
     add('recorded_unclassified','info','بصمتك مسجلة ونوعها غير مؤكد','يظهر لك وقت البصمة في سجل حركاتك أدناه. لا يعني غياب تصنيف الحضور أنك لم تبصم، ولا يُحتسب غياب أو خصم من هذه الحركة غير المحددة.');
   else if(syncedStart)add('checkin_not_recorded','warning','لم تظهر أي حركة بصمة','لم تظهر بصمة في سجلك حتى آخر مزامنة ناجحة؛ يمكنك إرسال بلاغ للإدارة.');
   else add('checkin_pending','info','بانتظار مزامنة بصمة الحضور','لا يمكن الجزم بعدم تسجيل البصمة قبل مزامنة حديثة للجهاز.');
  }else if(day.first_in&&!day.last_out&&afterEnd){
   if(biometric.has_unclassified)
     add('checkout_unclassified','info','حركة انصراف غير محسومة','توجد بصمات مسجلة برمز غير محدد؛ تحتاج الإدارة إلى تأكيد نوع الانصراف دون تغيير البصمة الأصلية.');
   else if(syncedEnd)add('checkout_not_recorded','warning','بصمة انصراف غير ظاهرة','لم تظهر بصمة انصراف مؤكدة بعد مزامنة الجهاز؛ يمكنك إرسال بلاغ للإدارة.');
   else add('checkout_pending','info','بانتظار مزامنة الانصراف','لا يمكن الجزم بعدم تسجيل البصمة قبل اكتمال المزامنة.');
  }
  if(day.first_in && day.late_minutes>0)
    add('late_arrival','info','حضور بعد بدء الدوام','حضورك متأخر وفق السجل الحالي بمقدار '+day.late_minutes+' دقيقة، وتظل البيانات قابلة للمراجعة.');
  if(day.last_out && day.early_exit_minutes>0)
    add('early_exit','warning','انصراف مبكر أو عودة غير مسجلة','آخر حركة خروج قبل نهاية الدوام بنحو '+day.early_exit_minutes+' دقيقة؛ تحقق من تسجيل العودة أو قدم بلاغًا.');
  if(day.absence_minutes>0)
    add('midday_absence','info','خروج وعودة أثناء الدوام','مدة الانقطاع المسجلة بين الخروج والعودة '+day.absence_minutes+' دقيقة، وتحتاج إلى مراجعة الاعتماد.');
  if(row?.state==='error')add('sync_error','info','تعذرت مزامنة الجهاز','البيانات قد تكون متأخرة؛ تحقق مع الإدارة.');
 }
 if(!alerts.length){
  if(biometric.total_movements)add('clear','success','حركات البصمة ظاهرة','تم العثور على حركات مسجلة في سجلك. يبقى نوع الحركة غير المحدد بحاجة إلى اعتماد مسؤول دون خصم تلقائي.');
  else add('no_movements','info','لا توجد حركات ظاهرة لهذا التاريخ','تحقق من وقت آخر مزامنة أو قدّم بلاغًا للإدارة إن كنت قد بصمت.');
 }
 return response({linked:true,employee:{name:employee.name,code:employee.code},date,today,summary:day,alerts,
   biometric,movements:grouped,last_sync:row||null,last_success:successfulSync||null,
   verified_scan_failure:false,notification_mode:'in_app_after_sync',payroll_changed:false,timezone:'Asia/Aden'});
}
async function myPunchReport(db,user,request){
 if(!user.employee_id)return reject(403,'حسابك غير مرتبط بسجل عامل');
 const b=await bodyJson(request),date=str(b.date,10),kind=str(b.kind,30),detail=str(b.detail,500);
 weekdayOf(date);
 if(date>todayAden()||!['checkin','checkout','scan_failed','other'].includes(kind)||detail.length<8)
   return reject(400,'أدخل التاريخ ونوع المشكلة ووصفًا من 8 أحرف على الأقل');
 const n=await db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE organization_id=? AND actor_user_id=? AND event_type='attendance.punch_issue_reported' AND occurred_at>=datetime('now','-1 day')").bind(user.organization_id,user.id).first();
 if(Number(n?.n||0)>=5)return reject(429,'تجاوزت عدد البلاغات اليومية المسموح، تواصل مع الإدارة');
 await audit(db,user,'attendance.punch_issue_reported','employee',user.employee_id,{date,kind,detail});
 return response({ok:true,review_required:true,attendance_unchanged:true,message:'تم تسجيل البلاغ لمراجعة الإدارة، دون تغيير البصمة أو المستحقات.'},201);
}

/* Phase 2: manager-reviewed mapping. No raw punch conversion or payroll writes. */
async function deviceMappings(db,user,method,request){
  if(user.self_only||user.role!=='admin')return reject(403,'المطابقة لمدير النظام فقط');
  if(method==='GET'){
    const raw=await db.prepare("SELECT device_user_id,COUNT(*) AS punch_count,MIN(occurred_at_device) AS first_punch,MAX(occurred_at_device) AS last_punch FROM device_raw_punches WHERE organization_id=? AND device_id='mb10-main' GROUP BY device_user_id ORDER BY CAST(device_user_id AS INTEGER)").bind(ORG).all();
    const employees=await db.prepare('SELECT id,code,name,device_user_id FROM employees WHERE organization_id=? ORDER BY name').bind(ORG).all();
    return response({device_id:'mb10-main',raw_users:raw.results||[],employees:employees.results||[],note:'المطابقة يدوية بعد تأكيد الهوية؛ لا تأثير على الرواتب'});
  }
  if(method!=='POST')return reject(405,'طريقة غير مدعومة');
  const b=await bodyJson(request);
  const employeeId=str(b.employee_id,80),deviceUserId=str(b.device_user_id,80);
  if(b.confirm!==true||!employeeId||!/^[0-9]{1,10}$/.test(deviceUserId))
    return reject(400,'يلزم تأكيد رقم العامل ورقم البصمة الصحيحين');
  const employee=await db.prepare('SELECT id,name,device_user_id FROM employees WHERE id=? AND organization_id=?').bind(employeeId,ORG).first();
  if(!employee)return reject(404,'العامل غير موجود');
  if(employee.device_user_id&&employee.device_user_id!==deviceUserId)
    return reject(409,'العامل مرتبط مسبقًا برقم آخر؛ يلزم مراجعة إدارية');
  const used=await db.prepare('SELECT id FROM employees WHERE organization_id=? AND device_user_id=? AND id<>?').bind(ORG,deviceUserId,employeeId).first();
  if(used)return reject(409,'رقم البصمة مرتبط بعامل آخر');
  const record=await db.prepare('SELECT COUNT(*) AS n FROM device_raw_punches WHERE organization_id=? AND device_id=? AND device_user_id=?').bind(ORG,'mb10-main',deviceUserId).first();
  if(!record?.n)return reject(404,'رقم البصمة غير موجود ضمن الحركات المستوردة؛ يلزم مراجعته');
  if(employee.device_user_id===deviceUserId)return response({matched:true,unchanged:true,employee_id:employeeId,device_user_id:deviceUserId});
  const updated=await db.prepare("UPDATE employees SET device_user_id=?,updated_at=datetime('now') WHERE id=? AND organization_id=? AND (device_user_id IS NULL OR device_user_id='')")
    .bind(deviceUserId,employeeId,ORG).run();
  if(updated.meta?.changes!==1)return reject(409,'تغيرت بيانات العامل؛ أعد المحاولة بعد تحديث الصفحة');
  await db.prepare("UPDATE device_raw_punches SET matched_employee_id=?,review_state='matched' WHERE organization_id=? AND device_id=? AND device_user_id=? AND review_state='pending'")
    .bind(employeeId,ORG,'mb10-main',deviceUserId).run();
  await audit(db,user,'device_user.matched','employee',employeeId,{device_id:'mb10-main',device_user_id:deviceUserId});
  return response({matched:true,employee_id:employeeId,device_user_id:deviceUserId,raw_count:record.n,attendance_posted:false,payroll_changed:false});
}


/* Read-only device attendance review: never writes to punch_events or payroll. */

/* Presentation-only movement status: no changes to raw MB10 or payroll. */
function safeSchedule(cfg) {
 const v=(x,f)=>/^([01]\d|2[0-3]):[0-5]\d$/.test(String(x||''))?String(x):f;
 return {start:v(cfg.start_time,'07:30'),end:v(cfg.end_time,'13:45'),thursday:v(cfg.thursday_end_time,'13:15')};
}
function durationDuringShift(from,to,date,sch){
 const a=punchSeconds(from),b=punchSeconds(to);
 const start=punchSeconds(date+'T'+sch.start),end=punchSeconds(date+'T'+(weekdayOf(date)===4?sch.thursday:sch.end));
 return a===null||b===null||weekdayOf(date)===5?0:Math.max(0,Math.round(clippedSeconds(a,b,start,end)/60));
}
function classifyDayMovements(items,sch){
 const groups=new Map();
 for(const item of items){
   item.movement_type='review';item.permission_minutes=0;
   item.review_reason=!item.employee_id?'رقم البصمة غير مربوط بعامل':!['in','out'].includes(item.kind)?'رمز حركة غير محدد من جهاز MB10 ('+(item.punch_code==null?'غير متوفر':item.punch_code)+')':null;
   if(!item.employee_id)continue;
   const time=item.effective_timestamp||item.timestamp||item.occurred_at_device;
   const key=item.employee_id+'|'+String(time).slice(0,10);
   if(!groups.has(key))groups.set(key,[]);
   groups.get(key).push({...item,_time:time,_original:item});
 }
 for(const group of groups.values()){
   group.sort((a,b)=>a._time.localeCompare(b._time)||String(a.event_fingerprint||a.id||'').localeCompare(String(b.event_fingerprint||b.id||'')));
   for(let i=0;i<group.length;i++){
     const x=group[i],p=group[i-1],pp=group[i-2],n=group[i+1],date=x._time.slice(0,10);
     const end=weekdayOf(date)===4?sch.thursday:sch.end;
     const during=t=>t&&t.slice(11,16)>=sch.start&&t.slice(11,16)<end;
     const exit=weekdayOf(date)!==5&&x.kind==='out'&&p?.kind==='in'&&n?.kind==='in'&&during(x._time)&&n._time>x._time;
     const back=weekdayOf(date)!==5&&x.kind==='in'&&p?.kind==='out'&&pp?.kind==='in'&&during(p._time)&&x._time>p._time;
     x._original.movement_type=exit?'permission_exit':back?'permission_return':x.kind==='in'&&!p?'attendance':x.kind==='out'&&p?.kind==='in'?'departure':'review';
     if(x._original.movement_type==='review')x._original.review_reason=x.kind==='in'&&p?.kind==='in'?'دخول مكرر دون خروج مسجل':x.kind==='out'&&p?.kind==='out'?'خروج مكرر دون عودة مسجلة':x.kind==='out'&&!p?'خروج دون حضور سابق':x.kind==='in'&&p?.kind==='out'?'عودة تحتاج إلى تأكيد تسلسل الحركات':x._original.review_reason||'تسلسل الحركة غير مكتمل';
     if(back)x._original.permission_minutes=durationDuringShift(p._time,x._time,date,sch);
   }
 }
}
/* Unified read-only attendance register for searching and printing.
   An MB10 raw event is omitted once its corrected/posted event exists. */
async function attendanceRegister(db,user,request){
 const p=new URL(request.url).searchParams;
 const dateFrom=str(p.get('from'),10),dateTo=str(p.get('to'),10);
 if(dateFrom)weekdayOf(dateFrom);
 if(dateTo)weekdayOf(dateTo);
 if(dateFrom&&dateTo&&dateFrom>dateTo)return reject(400,'تاريخ البداية بعد تاريخ النهاية');
 const kind=str(p.get('kind'),10),source=str(p.get('source'),12);
 if(kind&&!KINDS.has(kind)&&kind!=='permission')return reject(400,'نوع الحركة غير صالح');
 if(source&&!['manual','device','import','demo'].includes(source))return reject(400,'مصدر الحركة غير صالح');
 const search=str(p.get('search'),100),employeeId=str(p.get('employee_id'),80);
 const page=Number(p.get('page')||1),pageSize=Number(p.get('page_size')||100);
 if(!Number.isInteger(page)||page<1||page>1000||!Number.isInteger(pageSize)||pageSize<1||pageSize>250)
   return reject(400,'إعدادات التصفح غير صالحة');
 const combined=[
  "SELECT p.id,p.employee_id,e.name AS employee_name,e.code AS employee_code,e.department,",
  "p.occurred_at AS timestamp,p.kind,p.source,r.device_user_id,p.device_event_id,",
  "CASE WHEN p.source='device' AND r.event_fingerprint IS NOT NULL THEN 1 ELSE 0 END AS corrected,r.punch_code AS punch_code",
  "FROM punch_events p JOIN employees e ON e.organization_id=p.organization_id AND e.id=p.employee_id",
  "LEFT JOIN device_raw_punches r ON r.organization_id=p.organization_id AND r.device_id=p.device_id AND r.event_fingerprint=p.device_event_id",
  "WHERE p.organization_id=? UNION ALL",
  "SELECT 'device:'||r.event_fingerprint AS id,e.id AS employee_id,e.name AS employee_name,",
  "e.code AS employee_code,e.department,r.occurred_at_device AS timestamp,",
  "CASE r.punch_code WHEN 0 THEN 'in' WHEN 1 THEN 'out' ELSE 'other' END AS kind,",
  "'device' AS source,r.device_user_id,r.event_fingerprint AS device_event_id,0 AS corrected,r.punch_code AS punch_code",
  "FROM device_raw_punches r LEFT JOIN employees e ON e.organization_id=r.organization_id AND e.device_user_id=r.device_user_id",
  "WHERE r.organization_id=? AND r.device_id='mb10-main'",
  "AND NOT EXISTS(SELECT 1 FROM punch_events p WHERE p.organization_id=r.organization_id AND p.device_id=r.device_id AND p.device_event_id=r.event_fingerprint)"
 ].join(' ');
 const configRow=await db.prepare('SELECT data_json FROM organization_settings WHERE organization_id=?').bind(ORG).first();
 let config={};try{config=JSON.parse(configRow?.data_json||'{}')}catch{}
 const sch=safeSchedule(config);
 const w='PARTITION BY q.employee_id, substr(q.timestamp,1,10) ORDER BY q.timestamp,q.id';
 const sequence="SELECT q.*,LAG(q.kind) OVER ("+w+") AS previous_kind,LAG(q.kind,2) OVER ("+w+") AS second_previous_kind,"+
   "LAG(q.timestamp) OVER ("+w+") AS previous_timestamp,LEAD(q.kind) OVER ("+w+") AS next_kind,LEAD(q.timestamp) OVER ("+w+") AS next_timestamp FROM ("+combined+") q";
 const close="(CASE WHEN strftime('%w',substr(z.timestamp,1,10))='4' THEN '"+sch.thursday+"' ELSE '"+sch.end+"' END)";
 const exit="z.kind='out' AND z.previous_kind='in' AND z.next_kind='in' AND substr(z.timestamp,12,5)>='"+sch.start+"' AND substr(z.timestamp,12,5)<"+close+" AND z.next_timestamp>z.timestamp";
 const back="z.kind='in' AND z.previous_kind='out' AND z.second_previous_kind='in' AND substr(z.previous_timestamp,12,5)>='"+sch.start+"' AND substr(z.previous_timestamp,12,5)<"+close+" AND z.timestamp>z.previous_timestamp";
 const classified="SELECT z.*,CASE WHEN z.employee_id IS NULL THEN 'رقم البصمة غير مربوط بعامل' WHEN z.kind NOT IN ('in','out') THEN 'رمز حركة غير محدد من جهاز MB10 ('||COALESCE(CAST(z.punch_code AS TEXT),'غير معروف')||')' WHEN z.kind='in' AND z.previous_kind='in' THEN 'دخول مكرر دون خروج مسجل' WHEN z.kind='out' AND z.previous_kind='out' THEN 'خروج مكرر دون عودة مسجلة' WHEN z.kind='out' AND z.previous_kind IS NULL THEN 'خروج دون حضور سابق' ELSE 'تسلسل الحركة غير مكتمل' END AS review_reason,CASE WHEN z.employee_id IS NULL OR z.kind NOT IN ('in','out') THEN 'review' "+
   "WHEN strftime('%w',substr(z.timestamp,1,10))!='5' AND ("+exit+") THEN 'permission_exit' "+
   "WHEN strftime('%w',substr(z.timestamp,1,10))!='5' AND ("+back+") THEN 'permission_return' "+
   "WHEN z.kind='in' AND z.previous_kind IS NULL THEN 'attendance' "+
   "WHEN z.kind='out' AND z.previous_kind='in' THEN 'departure' ELSE 'review' END AS movement_type FROM ("+sequence+") z";
 const filters=[],args=[ORG,ORG];
 if(user.self_only){filters.push('q.employee_id=?');args.push(user.employee_id||'');}
 if(user.role==='supervisor'&&!user.self_only){filters.push('q.department=? AND q.employee_id IS NOT NULL');args.push(user.department_scope||'');}
 if(user.role==='accountant')filters.push('q.employee_id IS NOT NULL');
 if(employeeId){filters.push('q.employee_id=?');args.push(employeeId);}
 if(dateFrom){filters.push('q.timestamp>=?');args.push(dateFrom+'T00:00:00');}
 if(dateTo){
   const next=new Date(dateTo+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);
   filters.push('q.timestamp<?');args.push(next.toISOString().slice(0,10)+'T00:00:00');
 }
 if(kind==='permission')filters.push("q.movement_type IN ('permission_exit','permission_return')");
 else if(kind){filters.push('q.kind=?');args.push(kind);}
 if(source){filters.push('q.source=?');args.push(source);}
 if(search){
   const like='%'+search.replace(/[\\%_]/g, m=>'\\'+m)+'%';
   filters.push("(q.employee_name LIKE ? ESCAPE '\\' OR q.employee_code LIKE ? ESCAPE '\\' OR q.device_user_id LIKE ? ESCAPE '\\')");
   args.push(like,like,like);
 }
 const base='FROM ('+classified+') q'+(filters.length?' WHERE '+filters.join(' AND '):'');
 const countRow=await db.prepare('SELECT COUNT(*) AS n '+base).bind(...args).first();
 const rows=await db.prepare('SELECT q.id,q.employee_id,q.employee_name,q.employee_code,q.timestamp,q.kind,q.source,q.device_user_id,q.device_event_id,q.corrected,q.movement_type,q.previous_timestamp,q.review_reason,q.punch_code '+base+
   ' ORDER BY q.timestamp DESC,q.id DESC LIMIT ? OFFSET ?').bind(...args,pageSize,(page-1)*pageSize).all();
 const items=(rows.results||[]).map(r=>({...r,permission_minutes:r.movement_type==='permission_return'&&r.previous_timestamp?durationDuringShift(r.previous_timestamp,r.timestamp,r.timestamp.slice(0,10),sch):0}));
 return response({items,total:Number(countRow?.n||0),page,page_size:pageSize,
   filters:{from:dateFrom,to:dateTo,source,kind,search,employee_id:employeeId},
   timezone:'Asia/Aden',read_only:true,financial_impact:false});
}

async function deviceAttendance(db,user,request){
  if(user.self_only||!['admin','hr','supervisor'].includes(user.role))return reject(403,'ليس لديك صلاحية لعرض بصمات العاملين');
  const u=new URL(request.url);
  const date=str(u.searchParams.get('date'),10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return reject(400,'حدد تاريخًا صحيحًا');
  weekdayOf(date);
  const employeeId=str(u.searchParams.get('employee_id'),80);
  const sql=["SELECT r.event_fingerprint,r.device_user_id,r.occurred_at_device,r.status_code,r.punch_code,",
   "COALESCE(c.employee_id,e.id) AS employee_id,COALESCE(ec.name,e.name) AS employee_name,COALESCE(ec.code,e.code) AS employee_code,",
    "c.occurred_at AS effective_timestamp,c.kind AS effective_kind,",
   "c.id AS correction_id",
   "FROM device_raw_punches r LEFT JOIN employees e ON e.organization_id=r.organization_id AND e.device_user_id=r.device_user_id",
   "LEFT JOIN punch_events c ON c.organization_id=r.organization_id AND c.device_id=r.device_id AND c.device_event_id=r.event_fingerprint",
   "LEFT JOIN employees ec ON ec.organization_id=r.organization_id AND ec.id=c.employee_id",
   "WHERE r.organization_id=? AND r.device_id=? AND r.occurred_at_device>=? AND r.occurred_at_device<?"];
  const args=[ORG,'mb10-main',date+'T00:00:00',date+'T23:59:59'];
  if(employeeId){sql.push('AND e.id=?');args.push(employeeId)}
  if(user.role==='supervisor'){sql.push('AND e.department=?');args.push(user.department_scope||'')}
  sql.push('ORDER BY r.occurred_at_device ASC LIMIT 2001');
  const rows=(await db.prepare(sql.join(' ')).bind(...args).all()).results||[];
  if(rows.length>2000)return reject(409,'عدد الحركات كبير؛ يرجى تضييق البحث');
  const result=rows.map(r=>({
    ...r,kind:r.effective_kind||(r.punch_code===0?'in':r.punch_code===1?'out':'other'),
    matched:!!r.employee_id,
    requires_review:!r.employee_id||(!r.correction_id&&![0,1].includes(r.punch_code))
  }));
  const cfgRow=await db.prepare('SELECT data_json FROM organization_settings WHERE organization_id=?').bind(ORG).first();
  let cfg={};try{cfg=JSON.parse(cfgRow?.data_json||'{}')}catch{}
  classifyDayMovements(result,safeSchedule(cfg));
  return response({date,items:result,matched_count:result.filter(r=>r.matched).length,
    unmatched_count:result.filter(r=>!r.matched).length,
    review_count:result.filter(r=>r.requires_review||r.movement_type==='review').length,
    time_authority:'device',timezone:'Asia/Aden',
    read_only:true,posted_to_attendance:false,payroll_changed:false});
}

async function expireAbandonedMb10Jobs(db) {
  // Recover from power loss or crashed agents without deleting or changing raw punches.
  // This runs only when a new synchronization is requested, not on every status poll.
  await db.prepare("UPDATE mb10_sync_jobs SET state='error',finished_at=datetime('now'),error_text='انقطع الربط قبل اكتمال الجلب؛ ستُعاد المحاولة.' WHERE organization_id=? AND ((state='pending' AND requested_at<datetime('now','-30 minutes')) OR (state='running' AND COALESCE(started_at,requested_at)<datetime('now','-30 minutes')))")
    .bind(ORG).run();
}

export async function onRequest(context) {
  const {request,env} = context;
  const db=env.DB;
  if (!db) return reject(503,'لم يتم ربط قاعدة D1؛ التشغيل الآمن غير متاح');
  const path=new URL(request.url).pathname.replace(/^\/api\/?/,'').replace(/\/+$/,'');
  const method=request.method.toUpperCase();
  if (!['GET','POST','PUT','PATCH','DELETE'].includes(method)) return reject(405,'طريقة غير مدعومة');
  if (method!=='GET'){
    const origin=request.headers.get('origin'),site=request.headers.get('sec-fetch-site');
    if (origin && origin!==new URL(request.url).origin) return reject(403,'طلب من مصدر غير مصرح به');
    if (site && !['same-origin','none'].includes(site)) return reject(403,'طلب من موقع آخر');
  }
  try {
    if (path==='permissions' && method==='GET') {
      const user=await sessionUser(db,request);
      if(!user) return reject(401,'يرجى تسجيل الدخول');
      if(user.role!=='admin') return reject(403,'صلاحيات المدير فقط');
      const rows=await db.prepare("SELECT user_id,permission_key,allowed FROM user_permission_overrides WHERE organization_id=? ORDER BY user_id,permission_key").bind(ORG).all();
      return response({items:rows.results||[],keys:['data.self_only','device.sync','device.attendance.view','device.correction','employees.view','employees.edit','attendance.manual','reports.view','users.manage']});
    }
    if (path==='permissions' && method==='PUT') {
      const user=await sessionUser(db,request);
      if(!user) return reject(401,'يرجى تسجيل الدخول');
      if(user.role!=='admin') return reject(403,'صلاحيات المدير فقط');
      const b=await bodyJson(request);
      const valid=new Set(['data.self_only','device.sync','device.attendance.view','device.correction','employees.view','employees.edit','attendance.manual','reports.view','users.manage']);
      if(typeof b.user_id!=='string'||!valid.has(b.permission_key)||![true,false,null].includes(b.allowed))return reject(400,'بيانات الصلاحية غير صالحة');
      const target=await db.prepare("SELECT id,role FROM users WHERE id=? AND organization_id=?").bind(b.user_id,ORG).first();
      if(!target) return reject(404,'المستخدم غير موجود');
      if(b.permission_key==='data.self_only' && (target.role==='admin'||b.allowed===false))return reject(400,'النطاق الشخصي يتطلب حسابًا غير إداري ويقبل التفعيل أو الافتراضي');
      if(target.id===user.id && b.permission_key==='users.manage' && b.allowed===false)return reject(400,'لا يمكن سحب صلاحية إدارة المستخدمين من نفسك');
      if(b.allowed===null) await db.prepare("DELETE FROM user_permission_overrides WHERE organization_id=? AND user_id=? AND permission_key=?").bind(ORG,target.id,b.permission_key).run();
      else await db.prepare("INSERT INTO user_permission_overrides(organization_id,user_id,permission_key,allowed) VALUES(?,?,?,?) ON CONFLICT(organization_id,user_id,permission_key) DO UPDATE SET allowed=excluded.allowed,updated_at=datetime('now')").bind(ORG,target.id,b.permission_key,b.allowed?1:0).run();
      await db.prepare('DELETE FROM sessions WHERE user_id=? AND user_id<>?').bind(target.id,user.id).run();
      await audit(db,user,'permission.changed','user',target.id,{permission_key:b.permission_key,allowed:b.allowed});
      return response({ok:true});
    }
    if (path==='mb10-sync' && method==='GET') {
      const user=await sessionUser(db,request);
      if(!user) return reject(401,'يرجى تسجيل الدخول');
      if(user.self_only||!(await allowedByPermission(db,user,'device.sync',user.role==='hr'))) return reject(403,'ليس لديك صلاحية');
      const last=await db.prepare("SELECT id,state,requested_at,started_at,finished_at,new_count,duplicate_count,error_text FROM mb10_sync_jobs WHERE organization_id=? ORDER BY requested_at DESC LIMIT 1").bind(ORG).first();
      const completed=await db.prepare("SELECT finished_at,new_count,duplicate_count FROM mb10_sync_jobs WHERE organization_id=? AND state='done' ORDER BY finished_at DESC LIMIT 1").bind(ORG).first();
      return response({job:last||null,last_success:completed||null,automatic_sync_requires_office_agent:true,expected_interval_minutes:10});
    }
    if (path==='mb10-sync' && method==='POST') {
      const user=await sessionUser(db,request);
      if(!user) return reject(401,'يرجى تسجيل الدخول');
      if(user.self_only||!(await allowedByPermission(db,user,'device.sync',user.role==='hr'))) return reject(403,'ليس لديك صلاحية');
      if(user.must_change_password) return reject(403,'يجب تغيير كلمة المرور');
      await expireAbandonedMb10Jobs(db);
      const existing=await db.prepare("SELECT id,state FROM mb10_sync_jobs WHERE organization_id=? AND state IN ('pending','running') ORDER BY requested_at DESC LIMIT 1").bind(ORG).first();
      if(existing) return response({id:existing.id,state:existing.state,already_pending:true});
      const id=uuid();
      await db.prepare("INSERT INTO mb10_sync_jobs(id,organization_id,requested_by,state) VALUES (?,?,?,'pending')").bind(id,ORG,user.id).run();
      return response({id,state:'pending'},202);
    }
    if (path==='mb10-agent' && ['GET','POST'].includes(method)) {
      const secret=env.MB10_IMPORT_TOKEN;
      const token=(request.headers.get('authorization')||'').replace(/^Bearer /,'');
      if(typeof secret!=='string'||secret.length<32||!safeEquals(token,secret)) return reject(401,'غير مصرح');
      if(method==='GET') {
        const job=await db.prepare("SELECT id,state FROM mb10_sync_jobs WHERE organization_id=? AND state='pending' ORDER BY requested_at ASC LIMIT 1").bind(ORG).first();
        if(!job) return response({job:null});
        const changed=await db.prepare("UPDATE mb10_sync_jobs SET state='running',started_at=datetime('now') WHERE id=? AND state='pending'").bind(job.id).run();
        return response({job:changed.meta?.changes?{id:job.id}:null});
      }
      const data=await bodyJson(request);
      // Local computer may schedule automatic synchronization (never a remote device read).
      if(data.action==='schedule'){
        await expireAbandonedMb10Jobs(db);
        const running=await db.prepare("SELECT id,state FROM mb10_sync_jobs WHERE organization_id=? AND state IN ('pending','running') ORDER BY requested_at DESC LIMIT 1").bind(ORG).first();
        if(running)return response({job:running,already_pending:true});
        const id=uuid();
        await db.prepare("INSERT INTO mb10_sync_jobs(id,organization_id,requested_by,state) VALUES (?,?,'local-agent','pending')").bind(id,ORG).run();
        return response({job:{id,state:'pending'},scheduled:true},202);
      }
      if(typeof data.id!=='string'||!['success','error'].includes(data.status)) return reject(400,'بيانات غير صالحة');
      const state=data.status==='success'?'done':'error';
      const count=(x)=>Number.isSafeInteger(x)&&x>=0&&x<=1000000?x:0;
      const changed=await db.prepare("UPDATE mb10_sync_jobs SET state=?,finished_at=datetime('now'),new_count=?,duplicate_count=?,error_text=? WHERE id=? AND organization_id=? AND state='running'").bind(state,count(data.inserted),count(data.duplicates),state==='error'?str(data.error,300):null,data.id,ORG).run();
      if(!changed.meta?.changes) return reject(409,'المهمة غير متاحة');
      if(state==='done' && pushConfigured(env)){
        context.waitUntil(notifyWorkersAfterSuccessfulSync(db,env).catch(error=>{
          console.error('worker notification dispatch failed',String(error?.message||'unknown').slice(0,140));
        }));
      }
      return response({ok:true,notifications_queued:state==='done'&&pushConfigured(env)});
    }
    if (path==='device-import') {
      if (method!=='POST') return reject(405,'طريقة غير مدعومة؛ استخدم POST');
      return importMb10Punches(context);
    }
    if (path==='status' && method==='GET') return response({setupRequired:await setupRequired(db),version:'0.2.22',pushConfigured:pushConfigured(env)});
    if (path==='setup' && method==='POST') return initialSetup(db,env,request);
    if (path==='login' && method==='POST') return login(db,request);
    const user=await sessionUser(db,request);
    if (path==='logout' && method==='POST') return logout(db,request,user);
    if (!user) return reject(401,'يرجى تسجيل الدخول');
    if (path==='me' && method==='GET') return response({user:publicUser(user)});
    if (path==='change-password' && method==='POST') return changePassword(db,user,request);
    if (user.must_change_password) return reject(403,'يجب تغيير كلمة المرور قبل متابعة العمل');
    if (path==='push-config' && method==='GET'){
      await ensurePushStorage(db);
      return response({
      enabled:pushConfigured(env),public_key:pushConfigured(env)?env.VAPID_PUBLIC_KEY:null,
      requires_secure_context:true,mode:'background_push_after_successful_sync'
    });
    }
    if(path==='push-subscription' && ['GET','POST','DELETE'].includes(method)){
      await ensurePushStorage(db);
      if(!user.employee_id)return reject(403,'لا بد من ربط حسابك بسجل العامل قبل تفعيل الإشعارات');
      if(method==='GET'){
        const row=await db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE organization_id=? AND user_id=? AND employee_id=?')
          .bind(user.organization_id,user.id,user.employee_id).first();
        return response({enabled:Number(row?.count||0)>0,devices:Number(row?.count||0)});
      }
      if(method==='DELETE'){
        const b=await bodyJson(request);
        if(typeof b.endpoint!=='string'||b.endpoint.length>2048)return reject(400,'عنوان الاشتراك غير صحيح');
        const id=await hashText(b.endpoint);
        await db.prepare('DELETE FROM push_subscriptions WHERE id=? AND organization_id=? AND user_id=?')
          .bind(id,user.organization_id,user.id).run();
        return response({ok:true,removed:true});
      }
      if(!pushConfigured(env))return reject(503,'يجب إعداد مفاتيح إشعارات Web Push في Cloudflare');
      const b=await bodyJson(request),sub=b.subscription;
      if(!validatePushSubscription(sub))return reject(400,'اشتراك إشعارات غير صالح');
      const employee=await db.prepare('SELECT id FROM employees WHERE organization_id=? AND id=? AND status=?')
        .bind(user.organization_id,user.employee_id,'active').first();
      if(!employee)return reject(403,'سجل العامل المرتبط غير نشط أو غير موجود');
      const id=await hashText(sub.endpoint);
      const existing=await db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE organization_id=? AND user_id=? AND id<>?')
        .bind(user.organization_id,user.id,id).first();
      if(Number(existing?.n||0)>=3)return reject(409,'تم بلوغ ثلاثة أجهزة للإشعارات؛ أوقف الاشتراك من أحدها أولًا');
      await db.prepare("INSERT INTO push_subscriptions(id,organization_id,user_id,employee_id,endpoint,p256dh,auth_secret) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET organization_id=excluded.organization_id,user_id=excluded.user_id,employee_id=excluded.employee_id,endpoint=excluded.endpoint,p256dh=excluded.p256dh,auth_secret=excluded.auth_secret,updated_at=datetime('now')")
        .bind(id,user.organization_id,user.id,user.employee_id,sub.endpoint,sub.keys.p256dh,sub.keys.auth).run();
      return response({ok:true,subscribed:true,employee_scoped:true},201);
    }
    if(path==='push-test' && method==='POST'){
      if(!user.employee_id)return reject(403,'لا يوجد عامل مرتبط بحسابك');
      const result=await sendPersonalTest(db,env,user);
      return result.error?reject(result.status||503,result.error):response(result);
    }
    if (path==='my-attendance' && method==='GET') return myAttendance(db,user,request);
    if (path==='my-punch-report' && method==='POST') return myPunchReport(db,user,request);
    if (path==='attendance-register' && method==='GET') return attendanceRegister(db,user,request);
    if (path==='device-attendance' && method==='GET') return deviceAttendance(db,user,request);
    if (path==='device-mappings' && ['GET','POST'].includes(method)) return deviceMappings(db,user,method,request);
    if (path==='employees' && ['GET','POST'].includes(method)) return people(db,user,method,null,request);
    if (path.startsWith('employees/') && method==='PUT') return people(db,user,method,path.slice('employees/'.length),request);
    if (path==='device-punch-correction' && method==='POST') return correctDevicePunch(db,user,request);
    if (path==='manual-punch-cleanup' && ['GET','POST'].includes(method)) return manualPunchCleanup(db,user,method,request);
    if (path==='punches' && ['GET','POST'].includes(method)) return punches(db,user,method,request);
    if (path.startsWith('punches/') && method==='PUT') return correctManualPunch(db,user,path.slice('punches/'.length),request);
    if (path==='attendance-summary' && method==='GET') return attendanceSummary(db,user,request);
    if (path==='settings' && ['GET','PUT'].includes(method)) return settings(db,user,method,request);
    if (user.role!=='admin') return reject(403,'ليس لديك صلاحية');
    if (path==='users' && method==='GET'){
      const rows=await db.prepare('SELECT '+USER_PUBLIC+' FROM users WHERE organization_id=? ORDER BY created_at DESC LIMIT 500').bind(ORG).all();
      return response({items:rows.results});
    }
    if (path==='users' && method==='POST') return createUser(db,user,request);
    if (path.startsWith('users/') && method==='PATCH') return updateUser(db,user,path.slice(6),request);
    if (path==='audit' && method==='GET'){
      const rows=await db.prepare('SELECT id,actor_user_id,event_type,entity_type,entity_id,details_json,occurred_at FROM audit_events WHERE organization_id=? ORDER BY occurred_at DESC LIMIT 200').bind(ORG).all();
      return response({items:rows.results});
    }
    return reject(404,'المسار غير موجود');
  }catch(err){
    if (err?.status) return reject(err.status,err.message);
    if (/UNIQUE constraint failed/i.test(String(err?.message||''))) return reject(409,'البيانات موجودة مسبقًا');
    console.error('dawam api error',err?.name,err?.message);
    return reject(500,'تعذر إتمام العملية');
  }
}
