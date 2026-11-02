/* Monthly biometric-only adherence preview. No payroll posting or punch mutation. */
const toSeconds = value => {
  const m=/^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(String(value||''));
  return m ? Number(m[1])*3600+Number(m[2])*60+Number(m[3]||0) : null;
};
const dayAfter = day => {
  const d=new Date(day+'T12:00:00Z');
  d.setUTCDate(d.getUTCDate()+1);
  return d.toISOString().slice(0,10);
};
const rounded = x=>Math.round((x+Number.EPSILON)*100)/100;
const leaveCoversShift=(leave,day,start,end)=>{
  const norm=(v,begin)=>/^\d{4}-\d{2}-\d{2}$/.test(v)?v+(begin?'T00:00:00':'T23:59:59'):String(v||'').slice(0,19);
  return norm(leave.starts_at,true)<=day+'T'+start && norm(leave.ends_at,false)>=day+'T'+end;
};
function monthlyBiometricScore({from,to,events=[],leaves=[],today,config={}}){
  const start=config.start_time||'07:30',finish=config.end_time||'13:45',thursday=config.thursday_end_time||'13:15';
  if(!toSeconds(start)&&start!=='00:00')throw Error('Invalid shift start');
  if(toSeconds(finish)===null||toSeconds(thursday)===null)throw Error('Invalid shift end');
  const byDate=new Map();
  for(const e of events){
    const date=String(e.timestamp||'').slice(0,10);
    if(date<from||date>to)continue;
    if(!byDate.has(date))byDate.set(date,[]);
    byDate.get(date).push(e);
  }
  const detail=[];
  let scheduled=0,worked=0,missing=0,unresolved=0,excludedLeave=0;
  for(let date=from;date<=to;date=dayAfter(date)){
    const dow=new Date(date+'T12:00:00Z').getUTCDay();
    if(dow===5)continue;
    const end=dow===4?thursday:finish;
    const a=toSeconds(start),b=toSeconds(end);
    if(a===null||b===null||b<=a)throw Error('Invalid schedule');
    if(date>today){detail.push({date,status:'future',scheduled_minutes:0,worked_minutes:0});continue;}
    const dayLeaves=leaves.filter(l=>String(l.starts_at||'').slice(0,10)<=date&&String(l.ends_at||'').slice(0,10)>=date);
    if(dayLeaves.some(l=>leaveCoversShift(l,date,start,end))){
      detail.push({date,status:'approved_leave',scheduled_minutes:0,worked_minutes:0});
      excludedLeave++;continue;
    }
    const ev=(byDate.get(date)||[]).sort((x,y)=>String(x.timestamp).localeCompare(String(y.timestamp)));
    const minutes=b-a;
    scheduled+=minutes;
    if(!ev.length){
      missing++;
      detail.push({date,status:dayLeaves.length?'leave_needs_review':'no_scan',scheduled_minutes:minutes,worked_minutes:0});
      if(dayLeaves.length)unresolved++;
      continue;
    }
    let elapsed=0,open=null,problem=dayLeaves.length>0;
    for(const e of ev){
      const part=String(e.timestamp).slice(11,19),s=toSeconds(part);
      if(s===null||!['in','out'].includes(e.kind)){problem=true;continue;}
      if(e.kind==='in'){
        if(open!==null)problem=true;
        else open=s;
      }else{
        if(open===null||s<open)problem=true;
        else {elapsed+=Math.max(0,Math.min(s,b)-Math.max(open,a));open=null;}
      }
    }
    if(open!==null)problem=true;
    const got=Math.min(minutes,Math.max(0,elapsed/60));
    worked+=got;
    if(problem)unresolved++;
    detail.push({date,status:problem?'needs_review':'complete',scheduled_minutes:minutes,worked_minutes:rounded(got),punch_count:ev.length});
  }
  const percent=scheduled?rounded(100*worked/scheduled):null;
  return {from,to,percentage:percent,points:percent===null?null:rounded(percent*25/100),
    scheduled_minutes:scheduled,worked_minutes:rounded(worked),missing_days:missing,unresolved_days:unresolved,excluded_leave_days:excludedLeave,
    days:detail,calculation:'minutes_present_during_shift_divided_by_required_minutes',
    state:today<to?'cycle_in_progress':unresolved?'needs_punch_review':!scheduled?'no_scheduled_days':'manager_review_required'};
}
function weightedPoints(percentages,caps=[2,8,25,15,20,20,10]){
  if(!Array.isArray(percentages)||percentages.length!==caps.length||
     percentages.some(p=>typeof p!=='number'||!Number.isFinite(p)||p<0||p>100))
    throw Error('Invalid evaluation percentages');
  return caps.map((cap,i)=>rounded(cap*percentages[i]/100));
}
export {monthlyBiometricScore,weightedPoints};
