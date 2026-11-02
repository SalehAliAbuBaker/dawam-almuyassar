import test from 'node:test';
import assert from 'node:assert/strict';
import {monthlyBiometricScore,weightedPoints} from '../lib/monthly-attendance-evaluation.js';

test('all existing weighted criteria remain unchanged, input percentages become weighted points',()=>{
  assert.deepEqual(weightedPoints([100,50,100,80,70,100,0]),[2,4,25,12,14,20,0]);
  assert.equal(weightedPoints([100,100,100,100,100,100,100]).reduce((a,b)=>a+b,0),100);
  assert.throws(()=>weightedPoints([101,0,0,0,0,0,0]));
});
test('two regular shifts complete: full biometric score 25 points',()=>{
  const events=[
    {timestamp:'2026-10-26T07:20:00',kind:'in'},{timestamp:'2026-10-26T13:50:00',kind:'out'},
    {timestamp:'2026-10-27T07:15:00',kind:'in'},{timestamp:'2026-10-27T13:45:00',kind:'out'}
  ];
  const r=monthlyBiometricScore({from:'2026-10-26',to:'2026-10-27',today:'2026-11-02',events});
  assert.equal(r.percentage,100);assert.equal(r.points,25);assert.equal(r.unresolved_days,0);
});
test('late minutes and temporary exits reduce biometric attendance time, not financial payroll',()=>{
  const events=[
    {timestamp:'2026-10-26T07:40:00',kind:'in'},{timestamp:'2026-10-26T10:00:00',kind:'out'},
    {timestamp:'2026-10-26T10:20:00',kind:'in'},{timestamp:'2026-10-26T13:45:00',kind:'out'}
  ];
  const r=monthlyBiometricScore({from:'2026-10-26',to:'2026-10-26',today:'2026-11-02',events});
  assert.equal(r.scheduled_minutes,375);assert.equal(r.worked_minutes,345);
  assert.equal(r.points,23);assert.equal(r.unresolved_days,0);
});
test('unseen day is flagged, and Friday is not scheduled',()=>{
  const r=monthlyBiometricScore({from:'2026-10-29',to:'2026-10-31',today:'2026-11-02'});
  assert.equal(r.scheduled_minutes,345+375);assert.equal(r.missing_days,2);
  assert.equal(r.days.some(d=>d.date==='2026-10-30'),false);
});
test('unclear device punch cannot be accepted as completed',()=>{
  const r=monthlyBiometricScore({from:'2026-10-26',to:'2026-10-26',today:'2026-11-02',events:[{timestamp:'2026-10-26T07:30:00',kind:'other'}]});
  assert.equal(r.unresolved_days,1);assert.equal(r.state,'needs_punch_review');
});
test('approved full-day leave is excluded from denominator',()=>{
  const r=monthlyBiometricScore({from:'2026-10-26',to:'2026-10-26',today:'2026-11-02',leaves:[{starts_at:'2026-10-26',ends_at:'2026-10-26'}]});
  assert.equal(r.excluded_leave_days,1);assert.equal(r.scheduled_minutes,0);
});
