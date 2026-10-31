/* Dawam 0.2.11-dev — non-invasive admin navigation enhancement.
   No access tokens, employee data, or passwords are stored by this script. */
(() => {
  'use strict';
  const targetUrl='/users-permissions.html';
  const label='إدارة المستخدمين والصلاحيات';
  let isAdmin=false, checking=false, mounting=false;
  const style='display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:10px 14px;border-radius:10px;background:#167a4d;color:white;text-decoration:none;font:600 14px Tahoma,Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.12);max-width:100%;';
  const htmlLabel=label+' — 0.2.11-dev';

  function makeLink() {
    const el=document.createElement('a');
    el.href=targetUrl;
    el.className='dawam-permissions-entry';
    el.setAttribute('aria-label',label);
    el.textContent=htmlLabel;
    el.setAttribute('style',style);
    return el;
  }
  function displayText(el) {
    return (el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
  }
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect=el.getBoundingClientRect();
    return rect.width>0 && rect.height>0;
  }
  function mount() {
    if (!isAdmin || mounting || document.querySelector('.dawam-permissions-entry')) return;
    mounting=true;
    try {
      // Prefer placing the link beside the existing Settings navigation control.
      const candidates=document.querySelectorAll('button,a,[role="button"]');
      let settings=null;
      for (const node of candidates) {
        const value=displayText(node);
        if ((value==='الإعدادات' || value==='⚙ الإعدادات' || value==='إعدادات') && isVisible(node)) {
          settings=node;
          break;
        }
      }
      const link=makeLink();
      if(settings && settings.parentElement) {
        settings.insertAdjacentElement('afterend',link);
      } else {
        // Safe fallback: a small in-app shortcut instead of rewriting the shell.
        link.style.position='fixed';
        link.style.left='12px';
        link.style.bottom='16px';
        link.style.zIndex='999';
        link.style.fontSize='12px';
        link.style.padding='8px 11px';
        link.style.maxWidth='calc(100vw - 24px)';
        document.body.appendChild(link);
      }
    } finally {mounting=false;}
  }
  // Fix any preexisting menu option that was visible but had no working action.
  document.addEventListener('click',ev => {
    if(!isAdmin || !ev.target || !ev.target.closest) return;
    let node=ev.target.closest('button,a,[role="button"],li,[class*="menu"],[class*="setting"]');
    if(!node) return;
    const value=displayText(node);
    if(value.includes(label) && value.length<175) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      window.location.assign(targetUrl);
    }
  },true);
  async function refreshIdentity() {
    if(checking) return;
    checking=true;
    try {
      const resp=await fetch('/api/me',{credentials:'same-origin',cache:'no-store'});
      const data=resp.ok?await resp.json():null;
      isAdmin=!!(data && data.user && data.user.role==='admin');
      if(!isAdmin)document.querySelectorAll('.dawam-permissions-entry').forEach(el=>el.remove());
      else mount();
    } catch(_) {
      isAdmin=false;
      document.querySelectorAll('.dawam-permissions-entry').forEach(el=>el.remove());
    } finally {checking=false;}
  }
  const observer=new MutationObserver(() => {
    if(isAdmin && !mounting && !document.querySelector('.dawam-permissions-entry')) {
      requestAnimationFrame(mount);
    }
  });
  function start() {
    observer.observe(document.body,{childList:true,subtree:true});
    refreshIdentity();
    // Recheck after in-page login and whenever the tab becomes active.
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshIdentity()});
    document.addEventListener('focus',refreshIdentity);
    setInterval(refreshIdentity,20000);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})();
