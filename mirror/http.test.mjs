import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('./index.js', import.meta.url), 'utf8');
const {default:worker} = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
const bytes = Uint8Array.from({length:10}, (_, i) => i);
const etag = '"release-etag"';
const uploaded = new Date('2026-11-25T01:02:03.456Z');
let calls = [];
const metadata = {
  size:bytes.length, httpEtag:etag, uploaded,
  // Reproduce R2 returning range metadata for a complete object/head too.
  range:{offset:0, length:bytes.length},
  writeHttpMetadata(headers) { headers.set('Content-Type','application/zip'); }
};
const env = {RELEASES:{
  async head(key) { calls.push(['head',key]); return {...metadata}; },
  async get(key, options) {
    calls.push(['get',key,options]);
    const range = options?.range;
    return {...metadata, body:range ? bytes.slice(range.offset,range.offset+range.length) : bytes};
  }
}};
const base = 'https://mirror.test/V3.2.25/IX-Attendance-v3.2.25.zip';
async function request(headers={}, method='GET', url=base, target=env) {
  calls=[];
  return worker.fetch(new Request(url,{headers,method}),target);
}
async function expectFull(headers={}, method='GET') {
  const response = await request(headers,method);
  assert.equal(response.status,200);
  assert.equal(response.headers.get('Content-Range'),null);
  assert.equal(response.headers.get('Content-Length'),'10');
  assert.equal(response.headers.get('ETag'),etag);
  assert.equal(response.headers.get('Last-Modified'),uploaded.toUTCString());
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),method==='HEAD'?new Uint8Array():bytes);
  return response;
}
await expectFull();
assert.deepEqual(calls.map(c=>c[0]),['get'],'A normal full download needs only one R2 get');
await expectFull({},'HEAD');
assert.deepEqual(calls.map(c=>c[0]),['head'],'HEAD must not retrieve an object body');
await expectFull({Range:'bytes=0-1'},'HEAD');
assert.deepEqual(calls.map(c=>c[0]),['head']);
for (const range of ['garbage','items=0-2','bytes=-','bytes=5-2','bytes=0-2,5-7']) {
  await expectFull({Range:range});
  assert.deepEqual(calls.map(c=>c[0]),['get']);
}
for (const [range,start,end] of [
  ['bytes=0-2',0,2],['bytes=7-',7,9],['bytes=-2',8,9],
  ['bytes=0-99999999999999999999999999',0,9],['bytes=-99',0,9],['bytes=0-0',0,0]
]) {
  const response = await request({Range:range});
  assert.equal(response.status,206);
  assert.equal(response.headers.get('Content-Range'),`bytes ${start}-${end}/10`);
  assert.equal(response.headers.get('Content-Length'),String(end-start+1));
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes.slice(start,end+1));
  assert.deepEqual(calls.map(c=>c[0]),['head','get']);
}
for (const range of ['bytes=10-','bytes=9999999999999999999999999-','bytes=-0']) {
  const response = await request({Range:range});
  assert.equal(response.status,416);
  assert.equal(response.headers.get('Content-Range'),'bytes */10');
  assert.deepEqual(calls.map(c=>c[0]),['head'],'An unsatisfiable range must not attempt R2 get');
}
for (const validator of ['"old-etag"','W/'+etag,'not-a-date','Wed, 25 Nov 2026 01:02:04 GMT']) {
  await expectFull({Range:'bytes=0-2','If-Range':validator});
  assert.equal(calls[1][2],undefined,'If-Range mismatch must request the full object');
}
for (const validator of [etag,uploaded.toUTCString()]) {
  const response=await request({Range:'bytes=0-2','If-Range':validator});
  assert.equal(response.status,206);
  assert.equal(response.headers.get('Content-Range'),'bytes 0-2/10');
}
const old = await request({Range:'bytes=0-1'},'GET',base.replaceAll('3.2.25','3.2.24'));
assert.equal(old.status,206);
assert.equal(calls[1][1],'V3.2.24/IX-Attendance-v3.2.24.zip');
assert.equal(old.headers.get('X-Checksum-SHA256'),'73a48ead26192384f20dd865105edd044da5273d040cddfabd11ae0131187879');
assert.equal((await request({},'GET','https://mirror.test/missing')).status,404);
assert.equal((await request({},'POST')).status,405);
assert.equal((await request({},'POST','https://mirror.test/health')).status,405);
const absent={RELEASES:{head:async()=>null,get:async()=>null}};
assert.equal((await request({},'GET',base,absent)).status,503);
const broken={RELEASES:{get:async()=>{throw new Error('R2 unavailable')}}};
const unavailable=await request({},'GET',base,broken);
assert.equal(unavailable.status,503);
assert.equal(unavailable.headers.get('Retry-After'),'30');
const empty={RELEASES:{head:async()=>({...metadata,size:0})}};
assert.equal((await request({Range:'bytes=0-'},'GET',base,empty)).status,416);
console.log('PASS: full GET/HEAD200, valid ranges206, invalid ranges ignored, unsatisfiable416, If-Range, old24 links, and R2 failures');
