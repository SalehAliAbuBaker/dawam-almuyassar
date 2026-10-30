/* دوام الميسر 0.2.0 — Phase 1 API (Cloudflare Pages Functions + D1).
   Deploy behind a separate staging Cloudflare Pages project; GitHub Pages cannot run Functions.
   Never put SETUP_TOKEN, passwords or D1 credentials in the Git repository. */
const COOKIE = 'dawam_session';
const ORG = 'org_main';
const SESSION_HOURS = 12;
const PBKDF2_ROUNDS = 240000;
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
  return Object.fromEntries(USER_PUBLIC.split(', ').map(k => [k, user[k]]));
}
function canEditPeople(user) { return user.role === 'admin' || user.role === 'hr'; }
function canReadAll(user) { return ['admin', 'hr', 'accountant'].includes(user.role); }
function canWritePunch(user) { return canEditPeople(user) || user.role === 'supervisor'; }
function allowedEmployee(user, employee) {
  if (!employee) return false;
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
  return user || null;
}
async function issueSession(db, user) {
  const raw = randomB64();
  const expires = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
  await db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)')
    .bind(await hashText(raw), user.id, expires).run();
  return setCookie(raw, SESSION_HOURS * 3600);
}
function settingsWhitelist(input) {
  const fields = ['org_name','start_time','end_time','work_days','weekly_off','grace_minutes','permission_minutes',
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
  if (!safeEquals(body.setupToken, env.SETUP_TOKEN)) return reject(403, 'رمز التأسيس غير صالح');
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
  const attempt = await db.prepare('SELECT attempts,locked_until FROM login_attempts WHERE bucket=?').bind(bucket).first();
  if (attempt?.locked_until && attempt.locked_until > iso()) return reject(429,'محاولات كثيرة؛ أعد المحاولة بعد مدة');
  const user = await db.prepare('SELECT * FROM users WHERE email=? AND organization_id=? AND is_active=1').bind(email,ORG).first();
  const ok = user ? safeEquals(await passwordHash(password,user.password_salt,user.password_iterations),user.password_hash) : false;
  if (!ok) {
    const n = attempt?.updated_at && false ? 1 : (attempt?.attempts || 0)+1;
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
  return response({ok:true,reauth_required:true},{valueOf:()=>200}.valueOf(),{ 'set-cookie':setCookie('',0) });
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
    if (user.role==='viewer') {sql+=' AND id=?';params.push(user.employee_id||'');}
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
    if (user.role==='viewer'){sql+=' AND p.employee_id=?';args.push(user.employee_id||'');}
    if (user.role==='supervisor'){sql+=' AND e.department=?';args.push(user.department_scope||'');}
    sql+=' ORDER BY p.occurred_at DESC LIMIT 2000';
    const rows=await db.prepare(sql).bind(...args).all();
    return response({items:rows.results});
  }
  if (method!=='POST'||!canWritePunch(user)) return reject(403,'ليس لديك صلاحية تسجيل حركة حضور');
  const b=await bodyJson(request),employee=await db.prepare('SELECT * FROM employees WHERE id=? AND organization_id=?').bind(str(b.employee_id,80),ORG).first();
  if (!employee || !allowedEmployee(user,employee)) return reject(403,'هذا العامل ليس ضمن نطاق صلاحيتك');
  const timestamp=str(b.timestamp,35),kind=str(b.kind,10);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(timestamp)||!KINDS.has(kind)) return reject(400,'تاريخ أو نوع حركة غير صالح');
  const id=uuid();
  await db.prepare("INSERT INTO punch_events(id,organization_id,employee_id,occurred_at,kind,source,entered_by) VALUES(?,?,?,?,?,'manual',?)")
    .bind(id,ORG,employee.id,timestamp,kind,user.id).run();
  await audit(db,user,'punch.manual_created','punch',id,{employee_id:employee.id});
  return response({item:{id,employee_id:employee.id,timestamp,kind,source:'manual'}},201);
}
async function settings(db,user,method,request){
  if (method==='GET'){
    const row=await db.prepare('SELECT data_json FROM organization_settings WHERE organization_id=?').bind(ORG).first();
    return response({settings:JSON.parse(row?.data_json||'{}')});
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

export async function onRequest(context) {
  const {request,env} = context;
  const db=env.DB;
  if (!db) return reject(503,'لم يتم ربط قاعدة D1؛ التشغيل الآمن غير متاح');
  const path=new URL(request.url).pathname.replace(/^\/api\/?/,'').replace(/\/+$/,'');
  const method=request.method.toUpperCase();
  if (!['GET','POST','PUT','PATCH'].includes(method)) return reject(405,'طريقة غير مدعومة');
  if (method!=='GET'){
    const origin=request.headers.get('origin'),site=request.headers.get('sec-fetch-site');
    if (origin && origin!==new URL(request.url).origin) return reject(403,'طلب من مصدر غير مصرح به');
    if (site && !['same-origin','none'].includes(site)) return reject(403,'طلب من موقع آخر');
  }
  try {
    if (path==='status' && method==='GET') return response({setupRequired:await setupRequired(db),version:'0.2.0-foundation'});
    if (path==='setup' && method==='POST') return initialSetup(db,env,request);
    if (path==='login' && method==='POST') return login(db,request);
    const user=await sessionUser(db,request);
    if (path==='logout' && method==='POST') return logout(db,request,user);
    if (!user) return reject(401,'يرجى تسجيل الدخول');
    if (path==='me' && method==='GET') return response({user:publicUser(user)});
    if (path==='change-password' && method==='POST') return changePassword(db,user,request);
    if (user.must_change_password) return reject(403,'يجب تغيير كلمة المرور قبل متابعة العمل');
    if (path==='employees' && ['GET','POST'].includes(method)) return people(db,user,method,null,request);
    if (path.startsWith('employees/') && method==='PUT') return people(db,user,method,path.slice('employees/'.length),request);
    if (path==='punches' && ['GET','POST'].includes(method)) return punches(db,user,method,request);
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
