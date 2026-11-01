/* Dawam 0.2.15 — non-invasive admin and personal attendance navigation.
   No access tokens, employee data, or passwords are stored by this script. */
(() => {
  'use strict';
  const targetUrl='/users-permissions.html';
  const label='إدارة المستخدمين والصلاحيات';
  let isAdmin=false, hasPersonal=false, checking=false, mounting=false;
  const style='display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:10px 14px;border-radius:10px;background:#167a4d;color:white;text-decoration:none;font:600 14px Tahoma,Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.12);max-width:100%;';
  const htmlLabel=label+' — 0.2.15';

  function makeLink() {
    const el=document.createElement('a');
    el.href=targetUrl;
    el.className='dawam-permissions-entry';
    el.setAttribute('aria-label',label);
    el.textContent=htmlLabel;
    el.setAttribute('style',style);
    return el;
  }
  function mountPersonal() {
    if(!hasPersonal || document.querySelector('.dawam-my-attendance-entry'))return;
    const link=document.createElement('a');
    link.href='/my-attendance.html';
    link.textContent='دوامي وتنبيهاتي';
    link.className='dawam-my-attendance-entry';
    link.style.cssText=style;
    const candidates=document.querySelectorAll('button,a,[role="button"]');
    let settings=null;
    for(const node of candidates) {
      if(node!==link && displayText(node)==='الإعدادات' && isVisible(node)){settings=node;break}
    }
    if(settings?.parentElement)settings.insertAdjacentElement('afterend',link);
    else{
      link.style.position='fixed';link.style.right='12px';link.style.bottom='16px';
      link.style.zIndex='999';link.style.fontSize='12px';link.style.padding='8px 11px';
      document.body.appendChild(link);
    }
  }
  // Keep the visible stage version consistent without rewriting the 2.9 MB application file.
  function mountVersion(){
    const version='0.2.15';
    if(document.title.includes('0.2.12'))document.title=document.title.replace('0.2.12',version);
    for(const el of [document.querySelector('.login-art small'),document.getElementById('appVersion'),document.querySelector('.side-footer small')]){
      if(el && el.textContent.includes('0.2.12'))el.textContent=el.textContent.replace('0.2.12',version);
    }
    const foot=document.querySelector('footer.footer');
    if(foot){
      for(const node of foot.childNodes){
        if(node.nodeType===Node.TEXT_NODE && node.textContent.includes('0.2.12')){
          node.textContent=node.textContent.replace('0.2.12',version);
        }
      }
    }
  }
  function displayText(el) {
    return (el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
  }
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect=el.getBoundingClientRect();
    return rect.width>0 && rect.height>0;
  }
  function hasNativePermissionsLink(){
    for(const el of document.querySelectorAll('a,button,[role="button"]')){
      const value=displayText(el);
      if((el.getAttribute('href')||'').includes('users-permissions.html') ||
         (value.includes('تعديل الصلاحيات')&&value.length<100))return true;
    }
    return false;
  }
  function mount() {
    if (!isAdmin || mounting || document.querySelector('.dawam-permissions-entry') || hasNativePermissionsLink()) return;
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
      hasPersonal=!!(data && data.user && data.user.employee_id);
      if(!isAdmin)document.querySelectorAll('.dawam-permissions-entry').forEach(el=>el.remove());
      else mount();
      if(!hasPersonal)document.querySelectorAll('.dawam-my-attendance-entry').forEach(el=>el.remove());
      else mountPersonal();
    } catch(_) {
      isAdmin=false;hasPersonal=false;
      document.querySelectorAll('.dawam-permissions-entry,.dawam-my-attendance-entry').forEach(el=>el.remove());
    } finally {checking=false;}
  }
  const observer=new MutationObserver(() => {
    mountVersion();
    if(isAdmin && !mounting && !document.querySelector('.dawam-permissions-entry')) {
      requestAnimationFrame(mount);
    }
    if(hasPersonal && !document.querySelector('.dawam-my-attendance-entry')) {
      requestAnimationFrame(mountPersonal);
    }
  });
  function start() {
    observer.observe(document.body,{childList:true,subtree:true});
    mountVersion();
    refreshIdentity();
    // Recheck after in-page login and whenever the tab becomes active.
    document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshIdentity()});
    document.addEventListener('focus',refreshIdentity);
    setInterval(refreshIdentity,20000);
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})();
