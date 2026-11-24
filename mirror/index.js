const RELEASES = {
  '3.2.24': {sha256:'73a48ead26192384f20dd865105edd044da5273d040cddfabd11ae0131187879'},
  '3.2.25': {sha256:'5c402f4ac21cc728c6e366cdd33a75624bedd514283dfa371ed5f5b7a0515bf4'},
  '3.2.26': {sha256:'fe75e27fad796e0153aa185a4df7be41f1be48795a3da2cd854c2a113c1cf038'}
};
const LATEST = '3.2.26';

// Ignore malformed/unsupported ranges, as HTTP permits. Use BigInt so very
// large valid decimal offsets cannot overflow while checking satisfiability.
function parseRange(value) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec((value || '').trim());
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? BigInt(match[1]) : null;
  const end = match[2] ? BigInt(match[2]) : null;
  if (start !== null && end !== null && end < start) return null;
  return {start, end};
}

function resolveRange(range, size) {
  const total = BigInt(size);
  if (total === 0n) return null;
  if (range.start === null) {
    if (range.end === 0n) return null;
    const length = range.end > total ? total : range.end;
    return {offset:Number(total - length), length:Number(length)};
  }
  if (range.start >= total) return null;
  const end = range.end === null || range.end >= total ? total - 1n : range.end;
  return {offset:Number(range.start), length:Number(end - range.start + 1n)};
}

function ifRangeMatches(value, object) {
  if (!value) return true;
  if (value === object.httpEtag) return true;
  // Weak ETags cannot validate a partial representation. An HTTP date must
  // exactly match the Last-Modified value supplied with the representation.
  const modified = object.uploaded instanceof Date ? object.uploaded.toUTCString() : '';
  return !!modified && value === modified;
}

function unavailable() {
  return new Response('Release temporarily unavailable. Use the GitHub download on the download page.', {
    status:503, headers:{'Retry-After':'30', 'Cache-Control':'no-store'}
  });
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const version = Object.keys(RELEASES).find(v => path === `/V${v}/IX-Attendance-v${v}.zip` || path === `/IX-Attendance-v${v}.zip`) || LATEST;
    const NAME = `IX-Attendance-v${version}.zip`;
    const KEY = `V${version}/${NAME}`;
    const SHA256 = RELEASES[version].sha256;
    if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}});
    if (path === '/health') {
      try {
        const object = await env.RELEASES.head(KEY);
        const body = JSON.stringify({ok:!!object,version,bytes:object?.size||0,sha256:SHA256});
        return new Response(request.method === 'HEAD' ? null : body, {
          status:object?200:503, headers:{'Content-Type':'application/json', 'Cache-Control':'no-store'}
        });
      } catch { return unavailable(); }
    }
    if (!['/',`/${NAME}`,`/${KEY}`].includes(path)) return new Response('Not found',{status:404});
    let object;
    let selectedRange = null;
    try {
      // HEAD always describes the complete representation. Plain downloads and
      // ignored ranges need one get only; a valid range uses metadata first.
      const range = request.method === 'GET' ? parseRange(request.headers.get('Range')) : null;
      if (request.method === 'HEAD') {
        object = await env.RELEASES.head(KEY);
      } else if (range) {
        const metadata = await env.RELEASES.head(KEY);
        if (!metadata) return unavailable();
        if (ifRangeMatches(request.headers.get('If-Range'), metadata)) {
          selectedRange = resolveRange(range, metadata.size);
          if (!selectedRange) return new Response(null, {
            status:416, headers:{'Content-Range':`bytes */${metadata.size}`, 'Accept-Ranges':'bytes', 'Cache-Control':'no-store'}
          });
        }
        object = selectedRange
          ? await env.RELEASES.get(KEY, {range:selectedRange})
          : await env.RELEASES.get(KEY);
      } else {
        object = await env.RELEASES.get(KEY);
      }
    } catch { return unavailable(); }
    if (!object) return unavailable();
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Content-Type','application/zip');
    headers.set('Content-Disposition',`attachment; filename="${NAME}"`);
    headers.set('ETag',object.httpEtag);
    if (object.uploaded instanceof Date) headers.set('Last-Modified',object.uploaded.toUTCString());
    headers.set('Accept-Ranges','bytes');
    headers.set('X-Content-Type-Options','nosniff');
    headers.set('X-Checksum-SHA256',SHA256);
    headers.set('Cache-Control','public, max-age=86400, immutable');
    let status=200;
    // R2 may report a range even for a full get/head. The response is partial
    // only when this request selected and retrieved a valid byte range.
    if (selectedRange) {
      const {offset, length}=selectedRange;
      headers.set('Content-Range',`bytes ${offset}-${offset+length-1}/${object.size}`);
      headers.set('Content-Length',String(length));
      status=206;
    } else headers.set('Content-Length',String(object.size));
    return new Response(request.method==='HEAD'?null:object.body,{status,headers});
  }
};
