const NAME = 'IX-Attendance-v3.2.24.zip';
const KEY = `V3.2.24/${NAME}`;
const SHA256 = '73a48ead26192384f20dd865105edd044da5273d040cddfabd11ae0131187879';
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/health') {
      const object = await env.RELEASES.head(KEY);
      return Response.json({ok:!!object,version:'3.2.24',bytes:object?.size||0,sha256:SHA256},{status:object?200:503});
    }
    if (!['/',`/${NAME}`,`/${KEY}`].includes(path)) return new Response('Not found',{status:404});
    if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}});
    const object = request.method === 'HEAD'
      ? await env.RELEASES.head(KEY)
      : await env.RELEASES.get(KEY,{range:request.headers});
    if (!object) return new Response('Release temporarily unavailable. Use the GitHub download on the download page.',{status:503});
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('Content-Type','application/zip');
    headers.set('Content-Disposition',`attachment; filename="${NAME}"`);
    headers.set('ETag',object.httpEtag);
    headers.set('Accept-Ranges','bytes');
    headers.set('X-Content-Type-Options','nosniff');
    headers.set('X-Checksum-SHA256',SHA256);
    headers.set('Cache-Control','public, max-age=86400, immutable');
    let status=200;
    if (object.range) {
      const offset=object.range.offset ?? Math.max(0,object.size-object.range.suffix);
      const length=object.range.length ?? Math.min(object.range.suffix,object.size);
      headers.set('Content-Range',`bytes ${offset}-${offset+length-1}/${object.size}`);
      headers.set('Content-Length',String(length));
      status=206;
    } else headers.set('Content-Length',String(object.size));
    return new Response(request.method==='HEAD'?null:object.body,{status,headers});
  }
};
