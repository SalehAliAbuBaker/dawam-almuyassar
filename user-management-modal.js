/* Dawam stage 0.2.25: secure in-modal user editor bridge.
 * Reuse the same-origin full editor rather than duplicating password forms.
 * Never read, log, or store credentials; /api sessions remain server-side.
 */
(() => {
 'use strict';
 const TITLE='إدارة المستخدمين والصلاحيات';
 const EDIT_LABEL='تعديل الحسابات وكلمات المرور';
 let observer,scheduled=false;
 const text=node=>(node?.textContent||'').replace(/\s+/g,' ').trim();
 function visible(el){
  if(!el?.isConnected)return false;
  const r=el.getBoundingClientRect();
  return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden';
 }
 function findPanel(){
  // The original page contains a separate create/list modal. Find the visible
  // heading and its closest enclosing card, never the application shell.
  // Try semantic headings first; some older builds use a plain div/span title.
  const candidates=Array.from(document.querySelectorAll('h1,h2,h3,h4,[role="heading"],strong,b,div,span'))
    .filter(x=>x.childElementCount<=2&&text(x)===TITLE&&visible(x));
  for(const head of candidates){
   let panel=head.parentElement;
   for(let i=0;panel&&i<12;i++,panel=panel.parentElement){
    if(panel===document.body)break;
    const t=text(panel);
    if(t.includes('إنشاء حساب')&&t.includes('الحسابات')&&panel.querySelector('button')){
     const r=panel.getBoundingClientRect();
     if(r.width>250&&r.width<window.innerWidth*0.98)return {head,panel};
    }
   }
  }
  return null;
 }
 function makeUrl(email){
  const url=new URL('/users-permissions.html',location.origin);
  url.searchParams.set('embedded','1');
  url.searchParams.set('v','0.2.25');
  if(email)url.searchParams.set('email',email);
  return url.pathname+url.search;
 }
 function mount(){
  const found=findPanel();
  if(!found)return;
  const {head,panel}=found;
  let manager=panel.querySelector('[data-dawam-account-editor="v25"]');
  if(!manager){
   const bar=document.createElement('div');
   bar.dataset.dawamAccountEditor='v25';
   bar.style.cssText='display:flex;gap:8px;flex-wrap:wrap;align-items:center;justify-content:flex-start;margin:12px 0;padding:10px;background:#eef7f0;border:1px solid #d2e8da;border-radius:12px;';
   const button=document.createElement('button');
   button.type='button';button.textContent=EDIT_LABEL;
   button.style.cssText='border:0;border-radius:9px;background:#087847;color:white;padding:11px 17px;font:600 14px Tahoma,Arial,sans-serif;cursor:pointer;';
   const hint=document.createElement('span');
   hint.textContent='الاسم · البريد · الدور · الحالة · ربط العامل · كلمة المرور';
   hint.style.cssText='font:12px Tahoma,Arial,sans-serif;color:#37644b;line-height:1.8;';
   bar.append(button,hint);
   const wrap=document.createElement('section');
   wrap.hidden=true;wrap.setAttribute('aria-label','تعديل حسابات المستخدمين وكلمات المرور');
   wrap.style.cssText='width:100%;margin:12px 0 16px;border:1px solid #d1e7d7;border-radius:12px;background:white;overflow:hidden;';
   const iframe=document.createElement('iframe');
   iframe.title='تحرير الحسابات وإعادة تعيين كلمات المرور';
   iframe.loading='lazy';
   iframe.style.cssText='display:block;width:100%;height:min(68vh,660px);min-height:440px;border:0;background:#fff;';
   iframe.referrerPolicy='same-origin';
   wrap.append(iframe);
   button.addEventListener('click',()=>{
    const opening=wrap.hidden;
    wrap.hidden=!opening;
    button.textContent=opening?'إغلاق أدوات التعديل':EDIT_LABEL;
    if(opening){
     if(!iframe.getAttribute('src'))iframe.src=makeUrl();
     wrap.scrollIntoView({block:'nearest',behavior:'smooth'});
    }
   });
   const parent=head.parentNode;
   parent.insertBefore(bar,head.nextSibling);
   parent.insertBefore(wrap,bar.nextSibling);
   manager=bar;
   manager._dawam={wrap,iframe,button};
  }
  const api=manager._dawam;
  if(!api)return;
  // Add an inline edit action in each original user table row. The email is
  // used ONLY as a selector for the editor's server-fetched record.
  const tables=Array.from(panel.querySelectorAll('table'));
  for(const table of tables){
   const headers=Array.from(table.querySelectorAll('thead th')).map(text);
   if(!headers.some(x=>x.includes('البريد'))||!headers.some(x=>x.includes('إجراء')))continue;
   const emailCol=headers.findIndex(x=>x.includes('البريد'));
   const actionCol=headers.findIndex(x=>x.includes('إجراء'));
   for(const row of table.querySelectorAll('tbody tr')){
    if(row.querySelector('[data-dawam-inline-edit]'))continue;
    const cells=Array.from(row.children).filter(x=>x.matches('td'));
    if(cells.length<=Math.max(emailCol,actionCol))continue;
    const email=text(cells[emailCol]);
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))continue;
    const edit=document.createElement('button');
    edit.type='button';edit.textContent='تعديل';
    edit.dataset.dawamInlineEdit='1';
    edit.title='تعديل هذا الحساب أو إعادة تعيين كلمة مروره';
    edit.style.cssText='margin:3px;padding:8px 12px;background:#e5f2e9;color:#075d3a;border:1px solid #9fccad;border-radius:8px;font:600 13px Tahoma,Arial,sans-serif;cursor:pointer;';
    edit.addEventListener('click',()=>{
     api.wrap.hidden=false;
     api.button.textContent='إغلاق أدوات التعديل';
     api.iframe.src=makeUrl(email);
     api.wrap.scrollIntoView({block:'nearest',behavior:'smooth'});
    });
    cells[actionCol].append(edit);
   }
  }
 }
 function queue(){
  if(scheduled)return;
  scheduled=true;
  requestAnimationFrame(()=>{scheduled=false;try{mount()}catch(err){console.error('User editor UI could not be mounted',err?.name||'Error')}});
 }
 function start(){
  observer=new MutationObserver(queue);
  observer.observe(document.body,{childList:true,subtree:true});
  document.addEventListener('click',queue,true);
  queue();
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});
 else start();
})();