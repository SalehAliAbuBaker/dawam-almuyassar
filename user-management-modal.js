/* Dawam Muyassar 0.2.34 — clean navigation from the legacy users window.
 * No nested iframe, competing scrollbar, credential caching, or duplicate form.
 */
(() => {
 'use strict';
 const TITLE='إدارة المستخدمين والصلاحيات';
 const text=node=>(node?.textContent||'').replace(/\s+/g,' ').trim();
 let queued=false;
 function visible(el){
  if(!el?.isConnected)return false;
  const r=el.getBoundingClientRect();
  return r.width>0&&r.height>0;
 }
 function legacyModal(){
  const headings=[...document.querySelectorAll('h1,h2,h3,h4,[role="heading"],strong,b,div,span')]
   .filter(el=>el.childElementCount<=2&&text(el)===TITLE&&visible(el));
  for(const head of headings){
   for(let panel=head.parentElement,depth=0;panel&&panel!==document.body&&depth<12;panel=panel.parentElement,depth++){
    const value=text(panel);
    if(value.includes('إنشاء حساب')&&value.includes('الحسابات')&&panel.querySelector('button')){
     const r=panel.getBoundingClientRect();
     if(r.width>=260&&r.width<innerWidth*.99)return {head,panel};
    }
   }
  }
  return null;
 }
 function editorLink(email){
  const u=new URL('/users-permissions.html',location.origin);
  u.searchParams.set('v','0.2.34');
  if(email)u.searchParams.set('email',email);
  return u.pathname+u.search;
 }
 function mount(){
  const found=legacyModal();
  if(!found)return;
  const {head,panel}=found;
  if(!panel.querySelector('[data-dawam-user-edit="v26"]')){
   const link=document.createElement('a');
   link.dataset.dawamUserEdit='v26';
   link.href=editorLink();
   link.textContent='تعديل الحسابات وكلمات المرور';
   link.setAttribute('aria-label','فتح شاشة تعديل الحسابات وكلمات المرور');
   link.style.cssText='display:inline-flex;align-items:center;justify-content:center;min-height:42px;background:#087847;color:white;padding:9px 16px;border-radius:10px;font:600 14px Tahoma,Arial,sans-serif;text-decoration:none;margin:12px 0 8px;max-width:100%;';
   head.insertAdjacentElement('afterend',link);
  }
  for(const table of panel.querySelectorAll('table')){
   const labels=[...table.querySelectorAll('thead th')].map(text);
   const emailIndex=labels.findIndex(x=>x.includes('البريد'));
   const actionIndex=labels.findIndex(x=>x.includes('إجراء'));
   if(emailIndex<0||actionIndex<0)continue;
   for(const row of table.querySelectorAll('tbody tr')){
    if(row.querySelector('[data-dawam-row-edit="v26"]'))continue;
    const cells=[...row.children].filter(c=>c.matches('td'));
    if(cells.length<=Math.max(emailIndex,actionIndex))continue;
    const email=text(cells[emailIndex]);
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))continue;
    const link=document.createElement('a');
    link.dataset.dawamRowEdit='v26';link.href=editorLink(email);
    link.textContent='تعديل';link.title='فتح حساب هذا المستخدم وتغيير بياناته أو كلمة مروره';
    link.style.cssText='display:inline-block;margin:3px;padding:8px 12px;border-radius:8px;background:#e8f4eb;color:#075d3a;text-decoration:none;font:600 13px Tahoma,Arial,sans-serif;';
    cells[actionIndex].append(link);
   }
  }
 }
 function queue(){
  if(queued)return;
  queued=true;requestAnimationFrame(()=>{queued=false;mount()});
 }
 function start(){
  new MutationObserver(queue).observe(document.body,{childList:true,subtree:true});
  queue();
 }
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});
 else start();
})();