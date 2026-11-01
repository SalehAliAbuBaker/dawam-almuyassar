/* Web Push RFC 8291 (aes128gcm) + RFC 8292 (VAPID), WebCrypto only.
 * No third-party SDK or secret committed to GitHub.
 * Only generic attendance alerts are sent; no wages or attendance data in payload. */
const te=new TextEncoder();
const b64url=bytes=>{
 let binary='';for(const v of new Uint8Array(bytes))binary+=String.fromCharCode(v);
 return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
};
const from64=s=>{
 const clean=String(s||'').replace(/-/g,'+').replace(/_/g,'/');
 return Uint8Array.from(atob(clean.padEnd(Math.ceil(clean.length/4)*4,'=')),x=>x.charCodeAt(0));
};
const concat=(...parts)=>{
 const arrays=parts.map(p=>p instanceof Uint8Array?p:new Uint8Array(p));
 const output=new Uint8Array(arrays.reduce((n,p)=>n+p.length,0));let i=0;
 for(const p of arrays){output.set(p,i);i+=p.length}return output;
};
const hmac=async(key,data)=>{
 const cryptoKey=await crypto.subtle.importKey('raw',key,{name:'HMAC',hash:'SHA-256'},false,['sign']);
 return new Uint8Array(await crypto.subtle.sign('HMAC',cryptoKey,data));
};
const expand=async(prk,info,n)=>{
 let previous=new Uint8Array(0),result=new Uint8Array(0),index=1;
 while(result.length<n){previous=await hmac(prk,concat(previous,info,new Uint8Array([index++])));result=concat(result,previous)}
 return result.slice(0,n);
};
const urlAllowed=raw=>{
 try{
  const u=new URL(raw);
  if(u.protocol!=='https:'||u.username||u.password||u.port||raw.length>2048)return false;
  const h=u.hostname.toLowerCase();
  return h==='fcm.googleapis.com'||h==='updates.push.services.mozilla.com'||
         h==='web.push.apple.com'||h.endsWith('.push.apple.com')||
         h==='android.googleapis.com'||h.endsWith('.notify.windows.com');
 }catch{return false}
};
export function validatePushSubscription(s){
 if(!s||typeof s.endpoint!=='string'||!urlAllowed(s.endpoint)||
    !s.keys||typeof s.keys.p256dh!=='string'||typeof s.keys.auth!=='string')return false;
 try{
  const point=from64(s.keys.p256dh),auth=from64(s.keys.auth);
  return point.length===65&&point[0]===4&&auth.length===16;
 }catch{return false}
}
export function pushConfigured(env){
 return !!(env.VAPID_PUBLIC_KEY&&(env.VAPID_PRIVATE_JWK||env.VAPID_PRIVATE_KEY)&&env.VAPID_SUBJECT);
}
async function privateKey(env){
 // Supports existing Web Push VAPID pairs without generating new keys:
 // private scalar in base64url (standard tooling) OR complete private JWK.
 const publicBytes=from64(env.VAPID_PUBLIC_KEY);
 if(publicBytes.length!==65||publicBytes[0]!==4)throw new Error('VAPID public key must be an uncompressed P-256 point');
 const secret=String(env.VAPID_PRIVATE_JWK||env.VAPID_PRIVATE_KEY||'').trim();
 let jwk;
 if(secret.startsWith('{')){
  jwk=JSON.parse(secret);
  if(jwk.kty!=='EC'||jwk.crv!=='P-256'||!jwk.d||!jwk.x||!jwk.y)
   throw new Error('VAPID private JWK is incomplete');
  const encoded=concat(new Uint8Array([4]),from64(jwk.x),from64(jwk.y));
  if(b64url(encoded)!==env.VAPID_PUBLIC_KEY)throw new Error('VAPID public/private JWK mismatch');
 }else{
  const d=from64(secret);
  if(d.length!==32)throw new Error('VAPID scalar key must be 32 bytes in base64url');
  jwk={kty:'EC',crv:'P-256',x:b64url(publicBytes.slice(1,33)),y:b64url(publicBytes.slice(33,65)),d:b64url(d)};
 }
 return crypto.subtle.importKey('jwk',{kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y,d:jwk.d}, {name:'ECDSA',namedCurve:'P-256'},false,['sign']);
}
export async function makePushRequest(env,subscription,payload){
 if(!pushConfigured(env))throw new Error('Push service is not configured');
 if(!validatePushSubscription(subscription))throw new Error('Invalid push subscription');
 if(!/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$|^https:\/\//.test(env.VAPID_SUBJECT))
   throw new Error('Invalid VAPID subject');
 const endpoint=new URL(subscription.endpoint);
 const header=b64url(te.encode(JSON.stringify({typ:'JWT',alg:'ES256'})));
 const claims=b64url(te.encode(JSON.stringify({aud:endpoint.origin,exp:Math.floor(Date.now()/1000)+3600,sub:env.VAPID_SUBJECT})));
 const signature=b64url(await crypto.subtle.sign({name:'ECDSA',hash:'SHA-256'},await privateKey(env),te.encode(header+'.'+claims)));
 const jwt=header+'.'+claims+'.'+signature;
 const pair=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
 const serverPublic=new Uint8Array(await crypto.subtle.exportKey('raw',pair.publicKey));
 const userPublic=from64(subscription.keys.p256dh);
 const remote=await crypto.subtle.importKey('raw',userPublic,{name:'ECDH',namedCurve:'P-256'},false,[]);
 const secret=new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:remote},pair.privateKey,256));
 const auth=from64(subscription.keys.auth),salt=crypto.getRandomValues(new Uint8Array(16));
 const ikm=await expand(await hmac(auth,secret),concat(te.encode('WebPush: info'),new Uint8Array([0]),userPublic,serverPublic),32);
 const prk=await hmac(salt,ikm);
 const cek=await expand(prk,te.encode('Content-Encoding: aes128gcm\0'),16);
 const nonce=await expand(prk,te.encode('Content-Encoding: nonce\0'),12);
 const key=await crypto.subtle.importKey('raw',cek,{name:'AES-GCM'},false,['encrypt']);
 const plaintext=concat(te.encode(JSON.stringify(payload)),new Uint8Array([2]));
 if(plaintext.length>3900)throw new Error('Push message too long');
 const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,tagLength:128},key,plaintext));
 const prefix=new Uint8Array(5);new DataView(prefix.buffer).setUint32(0,4096);prefix[4]=65;
 const body=concat(salt,prefix,serverPublic,ciphertext);
 return {url:subscription.endpoint,init:{method:'POST',headers:{
   'TTL':'86400','Urgency':'normal','Content-Encoding':'aes128gcm',
   'Content-Type':'application/octet-stream','Authorization':'vapid t='+jwt+', k='+env.VAPID_PUBLIC_KEY
 },body}};
}
export async function sendWebPush(env,subscription,payload){
 const {url,init}=await makePushRequest(env,subscription,payload);
 const r=await fetch(url,init);
 return {ok:r.status===201||r.status===202||r.ok,expired:r.status===404||r.status===410,status:r.status};
}
