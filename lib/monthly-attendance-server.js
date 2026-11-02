import {monthlyBiometricScore} from './monthly-attendance-evaluation.js';

/* Read-only monthly biometric preview. Device timestamps are the source of truth.
 * Never alters punch data or payroll. Approval is handled separately by finance module. */
export async function biometricMonthlyPreview(db,org,employeeId,cycleInfo){
  const c=cycleInfo;
  const settingsRow=await db.prepare('SELECT data_json FROM organization_settings WHERE organization_id=?').bind(org).first();
  let config={};try{config=JSON.parse(settingsRow?.data_json||'{}')}catch{}
  const from=c.from+'T00:00:00',to=c.to+'T23:59:59';
  const sql="SELECT COALESCE(c.occurred_at,r.occurred_at_device) AS timestamp,COALESCE(c.kind,CASE r.punch_code WHEN 0 THEN 'in' WHEN 1 THEN 'out' ELSE 'other' END) AS kind,r.event_fingerprint "+
    "FROM device_raw_punches r LEFT JOIN employees e ON e.organization_id=r.organization_id AND e.device_user_id=r.device_user_id "+
    "LEFT JOIN punch_events c ON c.organization_id=r.organization_id AND c.device_id=r.device_id AND c.device_event_id=r.event_fingerprint "+
    "WHERE r.organization_id=? AND r.device_id='mb10-main' AND COALESCE(c.employee_id,e.id)=? "+
    "AND ((r.occurred_at_device>=? AND r.occurred_at_device<=?) OR (c.occurred_at>=? AND c.occurred_at<=?)) "+
    "ORDER BY timestamp,r.event_fingerprint LIMIT 5001";
  const events=(await db.prepare(sql).bind(org,employeeId,from,to,from,to).all()).results||[];
  if(events.length>5000)throw Object.assign(new Error('حركات البصمة كثيرة؛ يلزم مراجعة فترة الحساب'),{status:409});
  const leaves=(await db.prepare("SELECT starts_at,ends_at FROM leave_requests WHERE organization_id=? AND employee_id=? AND status='approved' AND starts_at<=? AND ends_at>=?").bind(org,employeeId,to,c.from).all()).results||[];
  const today=new Date(Date.now()+3*3600000).toISOString().slice(0,10); // Asia/Aden
  const draft=monthlyBiometricScore({from:c.from,to:c.to,events,leaves,today,config});
  const syncRow=await db.prepare("SELECT MAX(received_at) AS last_import_at FROM device_raw_punches WHERE organization_id=? AND device_id='mb10-main'").bind(org).first();
  const syncAt=syncRow?.last_import_at||null;
  const endUtc=new Date(c.to+'T13:45:00+03:00').toISOString().slice(0,19).replace('T',' ');
  const synchronized=!!syncAt&&syncAt>=endUtc;
  const reviewToken=[events.length,events.at(-1)?.timestamp||'',draft.scheduled_minutes,draft.worked_minutes,draft.missing_days,draft.unresolved_days,leaves.length].join(':');
  const canApprove=draft.state==='manager_review_required'&&synchronized&&draft.percentage!==null;
  const message=!synchronized?'لم تثبت مزامنة الجهاز بعد نهاية الدورة':draft.unresolved_days?'توجد حركات أو إجازات تحتاج مراجعة وتصحيح':draft.state==='cycle_in_progress'?'لم تنته الدورة الشهرية':'تأكيد المدير مطلوب قبل اعتماد النتيجة';
  return {...draft,month:c.month,cycle:c,event_count:events.length,last_device_import:syncAt,import_after_cycle:synchronized,can_approve:canApprove,review_token:reviewToken,review_message:message};
}
