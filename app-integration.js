/* Dawam 0.2.25 — non-invasive admin and personal attendance navigation.
   No access tokens, employee data, or passwords are stored by this script. */
(() => {
  'use strict';
  const targetUrl='/users-permissions.html';
  const label='إدارة المستخدمين والصلاحيات';
  const deviceSyncUrl='/mb10-sync.html';
  let isAdmin=false, canSync=false, hasPersonal=false, checking=false, mounting=false;
  const style='display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:10px 14px;border-radius:10px;background:#167a4d;color:white;text-decoration:none;font:600 14px Tahoma,Arial,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.12);max-width:100%;';
  const htmlLabel=label+' — 0.2.25';

  function makeLink() {
    const el=document.createElement('a');
    el.href=targetUrl;
    el.className='dawam-permissions-entry';
    el.setAttribute('aria-label',label);
    el.textContent=htmlLabel;
    el.setAttribute('style',style);
    return el;
  }
  function mountDeviceSync() {
    if(!canSync || document.querySelector('.dawam-device-sync-entry'))return;
    if([...document.querySelectorAll('a[href]')].some(a=>(a.getAttribute('href')||'').includes('mb10-sync.html')))return;
    const link=document.createElement('a');
    link.href=deviceSyncUrl;
    link.textContent='جلب بصمات MB10';
    link.className='dawam-device-sync-entry';
    link.setAttribute('style',style);
    const attendance=findMenuNode(['الحضور والبصمة']);
    if(!attendance)return;
    link.style.display='flex';
    link.style.width='fit-content';
    link.style.margin='6px 18px 10px 0';
    link.style.background='#e9f4eb';
    link.style.color='#075c38';
    link.style.boxShadow='none';
    attendance.insertAdjacentElement('afterend',link);
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
    const version='0.2.25';
    const outdated=/0\.2\.(?:12|15|16|17|18|19|20|21|22|23|24)/g;
    const title=document.title.replace(outdated,version);
    if(title!==document.title)document.title=title;
    for(const el of [document.querySelector('.login-art small'),document.getElementById('appVersion'),document.querySelector('.side-footer small')]){
      if(!el)continue;
      const next=el.textContent.replace(outdated,version);
      if(next!==el.textContent)el.textContent=next;
    }
    const foot=document.querySelector('footer.footer');
    if(foot){
      for(const node of foot.childNodes){
        if(node.nodeType!==Node.TEXT_NODE)continue;
        const next=node.textContent.replace(outdated,version);
        if(next!==node.textContent)node.textContent=next;
      }
    }
  }
  function displayText(el) {
    return (el.innerText||el.textContent||'').replace(/\s+/g,' ').trim();
  }
  function findMenuNode(labels) {
    const candidates=document.querySelectorAll('aside a,aside button,nav a,nav button,[class*="sidebar"] a,[class*="sidebar"] button,[class*="side-nav"] a,[class*="side-nav"] button');
    for(const el of candidates) {
      if(labels.includes(displayText(el))&&isVisible(el))return el;
    }
    return null;
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
      // Permissions belong to Settings; never add a floating shortcut over attendance.
      const settings=findMenuNode(['الإعدادات واللوائح','الإعدادات','⚙ الإعدادات','إعدادات']);
      if(!settings)return;
      const link=makeLink();
      link.textContent='المستخدمون والصلاحيات';
      link.style.display='flex';
      link.style.width='fit-content';
      link.style.margin='6px 18px 10px 0';
      link.style.background='#e9f4eb';
      link.style.color='#075c38';
      link.style.boxShadow='none';
      settings.insertAdjacentElement('afterend',link);
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
      canSync=!!(data && data.user && (data.user.role==='admin'||data.user.role==='hr') && !data.user.self_only);
      hasPersonal=!!(data && data.user && data.user.employee_id);
      if(!isAdmin)document.querySelectorAll('.dawam-permissions-entry').forEach(el=>el.remove());
      else mount();
      if(!canSync)document.querySelectorAll('.dawam-device-sync-entry').forEach(el=>el.remove());
      else mountDeviceSync();
      if(!hasPersonal)document.querySelectorAll('.dawam-my-attendance-entry').forEach(el=>el.remove());
      else mountPersonal();
    } catch(_) {
      isAdmin=false;canSync=false;hasPersonal=false;
      document.querySelectorAll('.dawam-permissions-entry,.dawam-my-attendance-entry,.dawam-device-sync-entry').forEach(el=>el.remove());
    } finally {checking=false;}
  }
  const observer=new MutationObserver(() => {
    mountVersion();
    if(isAdmin && !mounting && !document.querySelector('.dawam-permissions-entry')) {
      requestAnimationFrame(mount);
    }
    if(canSync && !document.querySelector('.dawam-device-sync-entry')) {
      requestAnimationFrame(mountDeviceSync);
    }
    if(hasPersonal && !document.querySelector('.dawam-my-attendance-entry')) {
      requestAnimationFrame(mountPersonal);
    }
  });
  function loadEmbeddedUserEditor(){
    if(document.querySelector('script[data-dawam-user-modal]'))return;
    const script=document.createElement('script');
    script.src='/user-management-modal.js?v=0.2.25';
    script.defer=true;
    script.dataset.dawamUserModal='1';
    document.head.append(script);
  }
  function start() {
    loadEmbeddedUserEditor();
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
