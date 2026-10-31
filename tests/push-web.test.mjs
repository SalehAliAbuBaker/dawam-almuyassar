import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto,createHmac,randomBytes} from 'node:crypto';
import {makePushRequest,validatePushSubscription} from '../functions/api/push-web.js';
const crypto=webcrypto, subtle=crypto.subtle;
const b64=x=>Buffer.from(x).toString('base64url');
const raw=s=>new Uint8Array(Buffer.from(s,'base64url'));
const H=(key,data)=>new Uint8Array(createHmac('sha256',key).update(data).digest());
const concat=(...items)=>Buffer.concat(items.map(x=>Buffer.from(x)));
const enc=x=>new TextEncoder().encode(x);
const expand=(key,info,n)=>H(key,concat(info,new Uint8Array([1]))).slice(0,n);
test('RFC8291 aes128gcm encrypted message can be decrypted by browser receiver', async()=>{
 const vapid=await subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
 const priv=await subtle.exportKey('jwk',vapid.privateKey);
 const publicRaw=new Uint8Array(await subtle.exportKey('raw',vapid.publicKey));
 const recipient=await subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
 const uaPublic=new Uint8Array(await subtle.exportKey('raw',recipient.publicKey));
 const auth=randomBytes(16);
 const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/TEST-PUSH-TOKEN',
   keys:{p256dh:b64(uaPublic),auth:b64(auth)}};
 assert.equal(validatePushSubscription(subscription),true);
 const env={VAPID_PUBLIC_KEY:b64(publicRaw),VAPID_PRIVATE_JWK:JSON.stringify(priv),VAPID_SUBJECT:'https://example.org'};
 const message={title:'دوام الميسر',body:'اختبار إشعار مشفّر',url:'/my-attendance.html'};
 const {url,init}=await makePushRequest(env,subscription,message);
 assert.equal(url,subscription.endpoint);
 assert.equal(init.headers['Content-Encoding'],'aes128gcm');
 const token=init.headers.Authorization.split(' t=')[1].split(', k=')[0];
 const [header,claims,signature]=token.split('.');
 assert.equal(JSON.parse(Buffer.from(header,'base64url').toString()).alg,'ES256');
 assert.equal(JSON.parse(Buffer.from(claims,'base64url').toString()).aud,'https://fcm.googleapis.com');
 assert.equal(await subtle.verify({name:'ECDSA',hash:'SHA-256'},vapid.publicKey,raw(signature),enc(header+'.'+claims)),true);
 const payload=new Uint8Array(init.body),salt=payload.slice(0,16),rs=new DataView(payload.buffer,payload.byteOffset+16,4).getUint32(0);
 assert.equal(rs,4096);assert.equal(payload[20],65);
 const ephem=payload.slice(21,86);
 const peer=await subtle.importKey('raw',ephem,{name:'ECDH',namedCurve:'P-256'},false,[]);
 const shared=new Uint8Array(await subtle.deriveBits({name:'ECDH',public:peer},recipient.privateKey,256));
 const info=concat(enc('WebPush: info'),new Uint8Array([0]),uaPublic,ephem);
 const ikm=expand(H(auth,shared),info,32);
 const prk=H(salt,ikm),cek=expand(prk,enc('Content-Encoding: aes128gcm\0'),16),nonce=expand(prk,enc('Content-Encoding: nonce\0'),12);
 const aes=await subtle.importKey('raw',cek,{name:'AES-GCM'},false,['decrypt']);
 const clear=new Uint8Array(await subtle.decrypt({name:'AES-GCM',iv:nonce,tagLength:128},aes,payload.slice(86)));
 assert.equal(clear.at(-1),2);
 assert.deepEqual(JSON.parse(new TextDecoder().decode(clear.slice(0,-1))),message);
});
test('rejects local/private/HTTP endpoints before fetch',()=>{
 for(const endpoint of [
  'http://fcm.googleapis.com/fcm/send/unsafe','https://127.0.0.1/',
  'https://localhost/','https://evil.invalid/push','https://fcm.googleapis.com.evil.invalid/',
  'https://user:pass@fcm.googleapis.com/fcm/send/unsafe'
 ]){
  assert.equal(validatePushSubscription({endpoint,keys:{p256dh:b64(Buffer.concat([Buffer.from([4]),Buffer.alloc(64)])),auth:b64(Buffer.alloc(16))}}),false,endpoint);
 }
});
