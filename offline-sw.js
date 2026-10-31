/* دوام الميسر — cache only the offline attendance shell.
   Never cache /api responses, session credentials, employee data or payroll. */
const CACHE='dawam-offline-shell-v1';
const SHELL=['/offline.html','/offline.webmanifest','/offline-icon.svg'];
self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',event=>{
  event.waitUntil(Promise.all([
    caches.keys().then(names=>Promise.all(names.filter(n=>n.startsWith('dawam-offline-shell-')&&n!==CACHE).map(n=>caches.delete(n)))),
    self.clients.claim()
  ]));
});
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;
  const u=new URL(event.request.url);
  if(u.origin!==self.location.origin||u.pathname.startsWith('/api/'))return;
  if(!SHELL.includes(u.pathname))return;
  event.respondWith(fetch(event.request).then(async res=>{
    if(res.ok&&res.type==='basic'){const cache=await caches.open(CACHE);await cache.put(u.pathname,res.clone())}
    return res;
  }).catch(async()=>{
    const cache=await caches.open(CACHE);
    return await cache.match(u.pathname)||Response.error();
  }));
});
