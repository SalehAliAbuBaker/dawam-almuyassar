import test from 'node:test';
import assert from 'node:assert/strict';
import {DEFAULTS,cycle,experienceYears,experiencePay,projection,calloutPay,DAILY_OVERTIME_CAP,periodicEvaluationPoints} from '../lib/finance-module.js';

test('finance cycle is inclusive 26 prior month through 25 named month',()=>{
 assert.deepEqual(cycle('2026-11'),{month:'2026-11',from:'2026-10-26',to:'2026-11-25'});
 assert.deepEqual(cycle('2026-01'),{month:'2026-01',from:'2025-12-26',to:'2026-01-25'});
 assert.throws(()=>cycle('2026-13'));
});
test('service completed years and configured tiers',()=>{
 const ref='2026-11-25';
 assert.equal(experienceYears('2026-06-01',ref),0);
 assert.equal(experienceYears('2025-11-25',ref),1);
 assert.equal(experienceYears('2024-11-26',ref),1);
 assert.equal(experienceYears('2023-11-25',ref),3);
 assert.equal(experienceYears('2020-11-25',ref),6);
 assert.equal(experienceYears('2017-11-25',ref),9);
 assert.equal(experiencePay(0,DEFAULTS),0);
 assert.equal(experiencePay(1,DEFAULTS),1000);
 assert.equal(experiencePay(2,DEFAULTS),1000);
 assert.equal(experiencePay(3,DEFAULTS),6000);
 assert.equal(experiencePay(5,DEFAULTS),6000);
 assert.equal(experiencePay(6,DEFAULTS),9000);
 assert.equal(experiencePay(8,DEFAULTS),9000);
 assert.equal(experiencePay(9,DEFAULTS),13000);
 assert.equal(experiencePay(null,DEFAULTS),null);
});
const worker={id:'worker1',code:'002',name:'عامل اختباري',department:'التنمية',position:'النائب',
 status:'active',basic_salary:45000,transport_allowance:10000};
const profile={
 hire_date:'2015-01-01',family_count:5,rank:'deputy',duty:'acting',
 company_insurance:4950,total_insurance:8250,income_tax:5012,
 salary_override:null,transport_override:null,achievement_bonus:0
};
const completeScores=[2,8,25,15,20,20,10];
test('salary sample, household, experience, deputy acting pay without double duty',()=>{
 const x=projection(worker,profile,{scores_json:JSON.stringify(completeScores),effective_month:'2026-05'},[],DEFAULTS,cycle('2026-11'));
 assert.equal(x.salary.net,46688);
 assert.equal(x.incentive.living,70000);
 assert.equal(x.incentive.experience,13000);
 assert.equal(x.incentive.rank,5000);
 assert.equal(x.incentive.duty,10000);
 assert.equal(x.incentive.evaluation,15000);
 assert.equal(x.incentive.tax_compensation,5012);
 assert.equal(x.incentive.subtotal_before_attendance,118012);
 assert.equal(x.incentive.net,null);
 assert.equal(x.safe_to_finalize,false);
 assert.deepEqual(x.incomplete_fields,[]);
});
test('approved extras only, missing salary fields block readiness',()=>{
 const list=[{status:'approved',amount:3000},{status:'pending',amount:7000},{status:'rejected',amount:7000}];
 const x=projection(worker,{hire_date:'2026-10-01',family_count:null,rank:'none',duty:'none'},null,list,DEFAULTS,cycle('2026-11'));
 assert.equal(x.incentive.approved_extra,3000);
 assert.equal(x.incentive.experience,0);
 assert.equal(x.incentive.living,null);
 assert.equal(x.incomplete_fields.includes('عدد أفراد الأسرة'),true);
 assert.equal(x.incomplete_fields.includes('ضريبة الكسب'),true);
 assert.equal(x.salary.complete,false);
 assert.equal(x.attendance_state,'pending_verified_attendance');
 assert.equal(x.extras_pending,1);
});

test('manually entered whole callout hours are priced first 3000, then 1000 each and capped',()=>{
 assert.equal(DAILY_OVERTIME_CAP,8000);
 assert.equal(calloutPay(1,DEFAULTS),3000);
 assert.equal(calloutPay(2,DEFAULTS),4000);
 assert.equal(calloutPay(4,DEFAULTS),6000);
 assert.equal(calloutPay(5,DEFAULTS),7000);
 assert.equal(calloutPay(6,DEFAULTS),8000);
 assert.equal(calloutPay(7,DEFAULTS),8000);
 assert.equal(calloutPay(10,DEFAULTS),8000);
 assert.throws(()=>calloutPay(0,DEFAULTS));
 assert.throws(()=>calloutPay(1.5,DEFAULTS));
});
test('only approved callouts contribute to the monthly report',()=>{
 const calls=[
  {status:'approved',amount:4000,work_date:'2026-11-01',task:'استدعاء أول',duration_minutes:120},
  {status:'pending',amount:3000,work_date:'2026-11-01',task:'استدعاء آخر',duration_minutes:60}
 ];
 const r=projection(worker,profile,null,[],DEFAULTS,cycle('2026-11'),calls);
 assert.equal(r.incentive.approved_callouts,4000);
 assert.equal(r.callouts_pending,1);
 assert.equal(r.report_sources.approved_callouts.length,1);
 assert.equal(r.report_sources.pending_callouts,1);
 assert.equal(r.safe_to_finalize,false);
});

test('committee evaluation saves 75 non-biometric points and never requires a monthly scan',()=>{
 const full=[100,100,null,100,100,100,100];
 assert.deepEqual(periodicEvaluationPoints(full),[2,8,0,15,20,20,10]);
 assert.equal(periodicEvaluationPoints(full).reduce((sum,n)=>sum+n,0),75);
 assert.deepEqual(periodicEvaluationPoints([50,50,null,50,50,50,50]),[1,4,0,7.5,10,10,5]);
 assert.throws(()=>periodicEvaluationPoints([100,100,100,100,100,100,100]));
 assert.throws(()=>periodicEvaluationPoints([101,100,null,100,100,100,100]));
});
