/* دوام الميسر — cache only the offline attendance shell.
   Never cache /api responses, session credentials, employee data or payroll. */
const CACHE='dawam-offline-shell-v3';
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
  // The normal app stays online-first. When navigation to the app root
  // fails, show the separately secured offline attendance screen instead.
  if(event.request.mode==='navigate'&&(u.pathname==='/'||u.pathname==='/index.html')){
    event.respondWith(fetch(event.request).catch(async()=>{
      const cached=await caches.match('/offline.html');
      return cached||Response.error();
    }));
    return;
  }
  if(!SHELL.includes(u.pathname))return;
  event.respondWith(fetch(event.request).then(async res=>{
    if(res.ok&&res.type==='basic'){const cache=await caches.open(CACHE);await cache.put(u.pathname,res.clone())}
    return res;
  }).catch(async()=>{
    const cache=await caches.open(CACHE);
    return await cache.match(u.pathname)||Response.error();
  }));
});

/* Browser push works while the attendance page is closed, provided the
 * device/browser permits background service-worker notifications.
 * Payload has generic attendance wording only; no personal/financial data. */
self.addEventListener('push',event=>{
  let data={};
  try{data=event.data?event.data.json():{}}catch{data={}}
  const title=typeof data.title==='string'?data.title.slice(0,60):'دوام الميسر';
  const body=typeof data.body==='string'?data.body.slice(0,300):'لديك تنبيه بخصوص سجل الدوام';
  const tag=typeof data.tag==='string'?data.tag.slice(0,100):'dawam-attendance';
  event.waitUntil(self.registration.showNotification(title,{
    body,tag,icon:'/offline-icon.svg',badge:'/offline-icon.svg',renotify:false,
    data:{url:'/my-attendance.html'}
  }));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const destination=new URL('/my-attendance.html',self.location.origin).href;
    const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of windows){
      try{
        if(new URL(client.url).origin===self.location.origin){
          await client.navigate(destination);
          return client.focus();
        }
      }catch{}
    }
    return self.clients.openWindow(destination);
  })());
});
