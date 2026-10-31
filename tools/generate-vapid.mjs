#!/usr/bin/env node
/* Generate a new VAPID P-256 key pair locally. Keep VAPID_PRIVATE_JWK secret.
 * Do NOT commit or paste secret values into the repository or chats. */
import {webcrypto} from 'node:crypto';
const {subtle}=webcrypto;
const keys=await subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
const full=await subtle.exportKey('jwk',keys.privateKey);
const publicJwk=await subtle.exportKey('jwk',keys.publicKey);
const pub=Buffer.concat([Buffer.from([4]),Buffer.from(publicJwk.x,'base64url'),Buffer.from(publicJwk.y,'base64url')]).toString('base64url');
const secret=JSON.stringify({kty:'EC',crv:'P-256',x:full.x,y:full.y,d:full.d});
process.stdout.write('VAPID_PUBLIC_KEY (Cloudflare Environment Variable):\n'+pub+'\n\n');
process.stdout.write('VAPID_PRIVATE_JWK (Cloudflare encrypted Secret, NEVER GitHub):\n'+secret+'\n\n');
process.stdout.write('VAPID_SUBJECT (Cloudflare Variable; use your real HTTPS site/contact URL or mailto:address):\n');
process.stdout.write('Set this separately in Cloudflare; do not invent an email address.\n');
