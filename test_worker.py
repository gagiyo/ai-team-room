#!/usr/bin/env python3
"""_worker.js 를 V8 로 실제 실행해 보는 테스트 하네스(공개 템플릿).

Cloudflare 없이도 인증·MCP·sender 강제·rate limit 경로를 검증한다.
D1 은 SQL 패턴을 흉내내는 메모리 구현으로 대체한다.
"""
import json
import os
import sys

from py_mini_racer import MiniRacer

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER_PATH = os.environ.get("WORKER_PATH") or os.path.join(HERE, "_worker.js")

WORKER = open(WORKER_PATH, encoding="utf-8").read()
WORKER = WORKER.replace("export default {", "var __handler = {")

PRELUDE = r"""
// ---- 최소 웹 API 스텁 ----
function Headers(obj){ this._h = {}; for (var k in (obj||{})) this._h[k.toLowerCase()] = String(obj[k]); }
Headers.prototype.get = function(k){ var v = this._h[String(k).toLowerCase()]; return v === undefined ? null : v; };

function Response(body, init){
  init = init || {};
  this.body = body === undefined ? null : body;
  this.status = init.status || 200;
  this.headers = init.headers || {};
}
Response.prototype.json = function(){ return Promise.resolve(JSON.parse(this.body)); };
Response.prototype.text = function(){ return Promise.resolve(String(this.body)); };

function URL_(u){
  this.href = String(u);
  var m = String(u).match(/^(\w+:\/\/[^\/]+)([^?#]*)(\?[^#]*)?/);
  this.origin = m ? m[1] : '';
  this.pathname = m ? (m[2] || '/') : '/';
  var q = m && m[3] ? m[3].slice(1) : '';
  this.searchParams = { _q: q, get: function(k){
    var parts = this._q.split('&');
    for (var i=0;i<parts.length;i++){ var kv=parts[i].split('='); if (decodeURIComponent(kv[0])===k) return decodeURIComponent((kv[1]||'').replace(/\+/g,' ')); }
    return null;
  }};
}
globalThis.URL = URL_;
globalThis.Response = Response;
globalThis.Headers = Headers;
globalThis.atob = function(s){ return s; };  // 첨부 테스트에서는 쓰지 않음
globalThis.TextEncoder = function(){};
TextEncoder.prototype.encode = function(s){ return String(s); };
globalThis.crypto = {
  getRandomValues: function(arr){ for (var i=0;i<arr.length;i++) arr[i] = Math.floor(Math.random()*256); return arr; },
  subtle: { digest: function(alg, data){
    var s = String(data), h = 5381, out = [];
    for (var i=0;i<32;i++){ for (var j=0;j<s.length;j++) h = ((h*33) ^ s.charCodeAt(j)) >>> 0; out.push(h & 255); h = (h*31+i) >>> 0; }
    return Promise.resolve(new Uint8Array(out));
  }}
};

// ---- 메모리 D1 ----
function makeEnv(){
  var db = {
    messages: [], nextId: 1, tokens: [], nextTokenId: 1, limits: {}, rooms: [
      {slug:'general', name:'종합 회의실', description:'모두 함께', position:1},
      {slug:'insurance', name:'보험·마케팅', description:'보험', position:2}
    ]
  };
  function norm(sql){ return String(sql).replace(/\s+/g, ' ').trim(); }
  function stmt(sql){
    var params = [];
    var api = {
      bind: function(){ params = Array.prototype.slice.call(arguments); return api; },
      first: function(){
        var s = norm(sql);
        if (s.indexOf('select 1 as ok') === 0) return Promise.resolve({ok:1});
        if (s.indexOf('select slug, name, description from rooms where slug = ?') === 0)
          return Promise.resolve(db.rooms.filter(function(r){return r.slug===params[0];})[0] || null);
        if (s.indexOf('select id, agent, label from agent_tokens') === 0)
          return Promise.resolve(db.tokens.filter(function(t){return t.token_hash===params[0] && !t.revoked;})[0] || null);
        if (s.indexOf('select count, window_start from rate_limits') === 0)
          return Promise.resolve(db.limits[params[0]] || null);
        if (s.indexOf('select id from messages where room_slug = ? and id = ?') === 0)
          return Promise.resolve(db.messages.filter(function(m){return m.room_slug===params[0] && m.id===params[1];})[0] || null);
        if (s.indexOf('select count(*) as n from messages where room_slug = ? and reply_to_id = ?') === 0)
          return Promise.resolve({n: db.messages.filter(function(m){return m.room_slug===params[0] && m.reply_to_id===params[1];}).length});
        if (s.indexOf('select m.*, a.filename') === 0)
          return Promise.resolve(db.messages.filter(function(m){return m.id===params[0];})[0] || null);
        return Promise.resolve(null);
      },
      all: function(){
        var s = norm(sql);
        if (s.indexOf('select sender,') === 0 && s.indexOf('group by sender') !== -1) {
          var agg = {};
          db.messages.forEach(function(m){
            var a = agg[m.sender] || (agg[m.sender] = {sender:m.sender, n:0, last_at:m.created_at, last_room:m.room_slug});
            a.n++; if (m.created_at > a.last_at){ a.last_at = m.created_at; a.last_room = m.room_slug; }
          });
          return Promise.resolve({results: Object.keys(agg).map(function(k){return agg[k];})});
        }
        if (s.indexOf('from rooms r') !== -1)
          return Promise.resolve({results: db.rooms.map(function(r){ return {slug:r.slug, name:r.name, description:r.description, position:r.position, message_count: db.messages.filter(function(m){return m.room_slug===r.slug;}).length, last_id: 0, last_message_at: null}; })});
        if (s.indexOf('where m.room_slug = ? and m.id < ?') !== -1)
          return Promise.resolve({results: db.messages.filter(function(m){return m.room_slug===params[0] && m.id<params[1];}).sort(function(a,b){return b.id-a.id;}).slice(0, params[2] || 50)});
        if (s.indexOf('where m.room_slug = ? and m.id > ?') !== -1)
          return Promise.resolve({results: db.messages.filter(function(m){return m.room_slug===params[0] && m.id>params[1];}).sort(function(a,b){return a.id-b.id;}).slice(0, params[2] || 50)});
        if (s.indexOf('where m.room_slug = ? order by m.id desc') !== -1)
          return Promise.resolve({results: db.messages.filter(function(m){return m.room_slug===params[0];}).sort(function(a,b){return b.id-a.id;}).slice(0, params[1] || 50)});
        if (s.indexOf('from messages where room_slug = ? and id in') !== -1)
          return Promise.resolve({results: db.messages.filter(function(m){return m.room_slug===params[0] && params.slice(1).indexOf(m.id)!==-1;})});
        if (s.indexOf('select id, agent, label, created_at') === 0)
          return Promise.resolve({results: db.tokens});
        return Promise.resolve({results: []});
      },
      run: function(){
        var s = norm(sql);
        if (s.indexOf('create table') === 0) return Promise.resolve({meta:{}});
        if (s.indexOf('insert into rate_limits') === 0) {
          var b = params[0], win = params[1], cur = db.limits[b];
          var now = Math.floor(Date.now()/1000);
          if (cur && cur.window_start === win) cur.count++;
          else db.limits[b] = {bucket:b, window_start:win, count:1};
          return Promise.resolve({meta:{}});
        }
        if (s.indexOf('insert into messages') === 0) {
          var row = {id: db.nextId++, room_slug: params[0], sender: params[1], content: params[2], reply_to_id: params[3], attachment_id: params[4], created_at: new Date().toISOString()};
          db.messages.push(row);
          return Promise.resolve({meta:{last_row_id: row.id}});
        }
        if (s.indexOf('insert into agent_tokens') === 0) {
          var t = {id: db.nextTokenId++, agent: params[0], label: params[1], token_hash: params[2], created_at: new Date().toISOString(), revoked: 0};
          db.tokens.push(t);
          return Promise.resolve({meta:{last_row_id: t.id}});
        }
        if (s.indexOf('update agent_tokens set last_used_at') === 0) return Promise.resolve({meta:{}});
        if (s.indexOf('update agent_tokens set revoked') === 0) return Promise.resolve({meta:{}});
        if (s.indexOf('update messages set content') === 0) {
          var id2 = params[params.length - 1];
          var t = db.messages.filter(function(m){ return m.id === id2; })[0];
          if (t) {
            t.content = params[0];
            if (s.indexOf('attachment_id = null') !== -1) t.attachment_id = null;
          }
          return Promise.resolve({meta:{}});
        }
        if (s.indexOf('delete from attachments') === 0) return Promise.resolve({meta:{}});
        if (s.indexOf('delete from messages where id = ?') === 0) {
          db.messages = db.messages.filter(function(m){ return m.id !== params[0]; });
          return Promise.resolve({meta:{}});
        }
        if (s.indexOf('delete from rate_limits') === 0) return Promise.resolve({meta:{}});
        return Promise.resolve({meta:{}});
      }
    };
    return api;
  }
  var env = {
    API_KEY: 'legacy-shared-key', ROOM_KEY: 'room-pass',
    ASSETS: { fetch: function(){ return new Response('asset', {status:200}); } },
    DB: { prepare: stmt, _raw: db }
  };
  return env;
}

function makeReq(url, opts){
  opts = opts || {};
  return {
    url: url, method: opts.method || 'GET',
    headers: new Headers(opts.headers || {}),
    json: function(){ return Promise.resolve(opts.body || {}); }
  };
}
"""

TESTS = r"""
(async function(){
  var out = [];
  function ok(name, cond, extra){ out.push({name:name, ok:!!cond, extra: extra === undefined ? '' : String(extra)}); }
  var env = makeEnv();

  // 1. health
  var r = await __handler.fetch(makeReq('https://x.pages.dev/api/health'), env);
  ok('health 200', r.status === 200, r.status);

  // 2. 인증 없음
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms'), env);
  ok('no auth 401', r.status === 401, r.status);

  // 3. 공용 API_KEY → api
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/me', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  var me = JSON.parse(r.body);
  ok('api_key /api/me', r.status === 200 && me.kind === 'api' && me.agent === null, r.body);

  // 4. 토큰 발급(공용 키)
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/admin/tokens', {method:'POST', headers:{authorization:'Bearer legacy-shared-key'}, body:{agents:['연금술사','외문집사']}}), env);
  var made = JSON.parse(r.body);
  ok('mint tokens', r.status === 201 && made.tokens.length === 2 && /^pk_[0-9a-f]{40}$/.test(made.tokens[0].token), r.body.slice(0,120));
  var pallyToken = made.tokens[0].token, selboyToken = made.tokens[1].token;

  // 5. 개인 토큰 → /api/me
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/me', {headers:{authorization:'Bearer ' + pallyToken}}), env);
  me = JSON.parse(r.body);
  ok('agent /api/me', me.kind === 'agent' && me.agent === '연금술사' && me.sender_enforced === true, r.body);

  // 6. 개인 토큰으로 sender 사칭 시도 → 람쥐로 강제
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages', {method:'POST', headers:{authorization:'Bearer ' + selboyToken}, body:{sender:'CEO', content:'사칭 시도'}}), env);
  var posted = JSON.parse(r.body);
  ok('sender enforced', r.status === 201 && posted.message.sender === '외문집사', r.body.slice(0,160));

  // 7. 공용 API_KEY 로 임의 sender 발송 → 403 token_required
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages', {method:'POST', headers:{authorization:'Bearer legacy-shared-key'}, body:{sender:'핑크', content:'임의 발송 시도'}}), env);
  var blocked = JSON.parse(r.body);
  ok('api_key POST 403', r.status === 403 && blocked.error === 'token_required', r.status + ' ' + r.body.slice(0,160));

  // 7b. 웹 입장 키(X-Room-Key)로 발송 → 201, 화면에서 고른 sender 그대로
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages', {method:'POST', headers:{'x-room-key':'room-pass'}, body:{sender:'지존', content:'웹에서 보낸 인사'}}), env);
  posted = JSON.parse(r.body);
  ok('room_key web POST', r.status === 201 && posted.message.sender === '지존', r.status + ' ' + r.body.slice(0,160));

  // 7c. 공용 API_KEY 조회(GET)는 그대로 동작
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  ok('api_key GET rooms', r.status === 200 && JSON.parse(r.body).ok === true, r.status);
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages?limit=5', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  ok('api_key GET messages', r.status === 200 && JSON.parse(r.body).ok === true, r.status);

  // 7d. 공용 API_KEY 로는 토큰 관리(발급) 가능, 웹 입장 키로는 불가
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/admin/tokens', {headers:{'x-room-key':'room-pass'}}), env);
  ok('room_key admin 403', r.status === 403, r.status);

  // 7e. /api/docs 에 실제 API_KEY 미노출
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/docs?format=json', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  ok('docs json no key', r.body.indexOf('legacy-shared-key') === -1 && r.body.indexOf('<발급받은_개인_토큰>') !== -1, r.body.slice(0,140));
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/docs', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  ok('docs text no key', r.body.indexOf('legacy-shared-key') === -1 && r.body.indexOf('<발급받은_개인_토큰>') !== -1, r.body.slice(0,140));
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/docs?key=legacy-shared-key', {}), env);
  ok('docs via ?key no key', r.body.indexOf('legacy-shared-key') === -1, r.body.slice(0,140));

  // 8. /api/agents 활동
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/agents', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  var ag = JSON.parse(r.body);
  var sel = ag.agents.filter(function(a){return a.name==='외문집사';})[0];
  ok('agents activity', r.status===200 && ag.agents.length >= 9 && sel && sel.message_count >= 1 && !!sel.last_activity, r.body.slice(0,200));

  // 9. MCP 인증 없음
  r = await __handler.fetch(makeReq('https://x.pages.dev/mcp', {method:'POST'}), env);
  ok('mcp 401', r.status === 401, r.status);

  // 10. MCP 공용 키 거부
  r = await __handler.fetch(makeReq('https://x.pages.dev/mcp', {method:'POST', headers:{authorization:'Bearer legacy-shared-key'}, body:{jsonrpc:'2.0', id:1, method:'initialize'}}), env);
  ok('mcp rejects legacy', r.status === 401, r.status);

  // 11. MCP initialize
  r = await __handler.fetch(makeReq('https://x.pages.dev/mcp', {method:'POST', headers:{authorization:'Bearer ' + pallyToken, 'content-type':'application/json'}, body:{jsonrpc:'2.0', id:1, method:'initialize', params:{protocolVersion:'2025-06-18', capabilities:{}, clientInfo:{name:'pally'}}}}), env);
  var init = JSON.parse(r.body);
  ok('mcp initialize', r.status===200 && init.result && init.result.protocolVersion === '2025-06-18' && init.result.serverInfo.name === 'ai-team-room', r.body.slice(0,200));

  // 12. MCP notification → 202
  r = await __handler.fetch(makeReq('https://x.pages.dev/mcp', {method:'POST', headers:{authorization:'Bearer ' + pallyToken}, body:{jsonrpc:'2.0', method:'notifications/initialized'}}), env);
  ok('mcp notification 202', r.status === 202, r.status);

  // 13. tools/list
  r = await __handler.fetch(makeReq('https://x.pages.dev/mcp', {method:'POST', headers:{authorization:'Bearer ' + pallyToken}, body:{jsonrpc:'2.0', id:2, method:'tools/list'}}), env);
  var tl = JSON.parse(r.body);
  var names = (tl.result.tools||[]).map(function(t){return t.name;}).sort().join(',');
  ok('mcp tools/list', names === 'read_room_messages,send_room_message', names);

  // 14. tools/call send → sender 람쥐
  r = await __handler.fetch(makeReq('https://x.pages.dev/mcp', {method:'POST', headers:{authorization:'Bearer ' + pallyToken}, body:{jsonrpc:'2.0', id:3, method:'tools/call', params:{name:'send_room_message', arguments:{room:'general', content:'팰리 인사', sender:'CEO'}}}}), env);
  var call = JSON.parse(r.body);
  var txt = call.result && call.result.content[0].text;
  var payload = JSON.parse(txt);
  ok('mcp send sender forced', payload.message.sender === '연금술사', txt.slice(0,150));

  // 15. tools/call read
  r = await __handler.fetch(makeReq('https://x.pages.dev/mcp', {method:'POST', headers:{authorization:'Bearer ' + pallyToken}, body:{jsonrpc:'2.0', id:4, method:'tools/call', params:{name:'read_room_messages', arguments:{room:'general', limit:10}}}}), env);
  call = JSON.parse(r.body);
  payload = JSON.parse(call.result.content[0].text);
  ok('mcp read', payload.ok === true && payload.messages.length >= 3 && payload.latest_id > 0, payload.latest_id);

  // 16. 알 수 없는 도구
  r = await __handler.fetch(makeReq('https://x.pages.dev/mcp', {method:'POST', headers:{authorization:'Bearer ' + pallyToken}, body:{jsonrpc:'2.0', id:5, method:'tools/call', params:{name:'nope'}}}), env);
  var err = JSON.parse(r.body);
  ok('mcp unknown tool', err.error && err.error.code === -32602, r.body.slice(0,120));

  // 17. GET /mcp → 405
  r = await __handler.fetch(makeReq('https://x.pages.dev/mcp', {method:'GET', headers:{authorization:'Bearer ' + pallyToken}}), env);
  ok('mcp GET 405', r.status === 405, r.status);

  // 18. rate limit (MCP 121회)
  var last = 0;
  for (var i=0;i<125;i++){
    r = await __handler.fetch(makeReq('https://x.pages.dev/mcp', {method:'POST', headers:{authorization:'Bearer ' + pallyToken}, body:{jsonrpc:'2.0', id:9, method:'ping'}}), env);
    last = r.status;
  }
  ok('mcp rate limited', last === 429, last);

  // 19. API_KEY 와 ROOM_KEY 가 같은 값으로 설정된 경우에도 화면 로그인은 발송 가능
  var env2 = makeEnv();
  env2.API_KEY = 'same-key'; env2.ROOM_KEY = 'same-key';
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages', {method:'POST', headers:{'x-room-key':'same-key'}, body:{sender:'지존', content:'같은 키 웹 발송'}}), env2);
  ok('same key web POST 201', r.status === 201, r.status);
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages', {method:'POST', headers:{authorization:'Bearer same-key'}, body:{sender:'지존', content:'같은 키 스크립트 발송'}}), env2);
  ok('same key bearer POST 403', r.status === 403, r.status);

  /* ---------- 2026-11-26: 지난 대화 더 보기(?before=) ---------- */
  for (var p=0;p<5;p++){
    await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages', {method:'POST', headers:{authorization:'Bearer ' + selboyToken}, body:{sender:'외문집사', content:'페이지 테스트 ' + p}}), env);
  }
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages?limit=3', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  var page1 = JSON.parse(r.body);
  ok('list limit=3 has_more', r.status===200 && page1.messages.length===3 && page1.has_more===true,
     JSON.stringify({n:(page1.messages||[]).length, more:page1.has_more, ids:(page1.messages||[]).map(function(m){return m.id;})}));
  var oldest1 = page1.messages[0].id;
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages?before=' + oldest1 + '&limit=2', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  var page2 = JSON.parse(r.body);
  var beforeOk = r.status===200 && page2.ok === true && page2.messages.length > 0;
  for (var q=0;q<(page2.messages||[]).length;q++){ if (page2.messages[q].id >= oldest1) beforeOk = false; }
  var ascOk = true;
  for (var q2=1;q2<(page2.messages||[]).length;q2++){ if (page2.messages[q2].id <= page2.messages[q2-1].id) ascOk = false; }
  ok('before older page', beforeOk && ascOk && page2.has_more === true,
     JSON.stringify({ids:(page2.messages||[]).map(function(m){return m.id;}), more:page2.has_more}));
  // 가장 앞까지 거슬러 올라가면 has_more=false
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages?before=1&limit=5', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  ok('before first has_more false', JSON.parse(r.body).has_more === false, r.body.slice(0,120));

  /* ---------- 2026-11-26: 메시지 수정(PATCH) ---------- */
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages', {method:'POST', headers:{authorization:'Bearer ' + selboyToken}, body:{content:'고치기 전 글'}}), env);
  var myMsg = JSON.parse(r.body).message;
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + myMsg.id, {method:'PATCH', headers:{authorization:'Bearer ' + selboyToken}, body:{content:'고친 글'}}), env);
  var patched = JSON.parse(r.body);
  ok('PATCH own message', r.status===200 && patched.ok===true && patched.message.content==='고친 글' && patched.message.id===myMsg.id, r.status + ' ' + r.body.slice(0,140));
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages?after=' + (myMsg.id-1) + '&limit=5', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  var afterList = JSON.parse(r.body).messages || [];
  var saved = afterList.filter(function(m){ return m.id === myMsg.id; })[0];
  ok('PATCH persisted', !!saved && saved.content === '고친 글', saved ? saved.content : 'missing');

  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + myMsg.id, {method:'PATCH', headers:{authorization:'Bearer ' + pallyToken}, body:{content:'남의 글 고치기'}}), env);
  ok('PATCH other 403', r.status === 403 && JSON.parse(r.body).error === 'forbidden', r.status + ' ' + r.body.slice(0,120));

  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + myMsg.id, {method:'PATCH', headers:{authorization:'Bearer legacy-shared-key'}, body:{content:'공용 키 수정'}}), env);
  ok('PATCH api_key 403', r.status === 403 && JSON.parse(r.body).error === 'token_required', r.status + ' ' + r.body.slice(0,120));

  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + myMsg.id, {method:'PATCH', headers:{authorization:'Bearer ' + selboyToken}, body:{content:'   '}}), env);
  ok('PATCH empty 400', r.status === 400, r.status);

  /* ---------- 2026-11-26: 웹 입장 키 = 지존 글만 ---------- */
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages', {method:'POST', headers:{'x-room-key':'room-pass'}, body:{sender:'지존', content:'지존이 웹에서 쓴 글'}}), env);
  var humanMsg = JSON.parse(r.body).message;
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + humanMsg.id, {method:'PATCH', headers:{'x-room-key':'room-pass'}, body:{content:'지존이 고친 글'}}), env);
  ok('room_key PATCH human', r.status===200 && JSON.parse(r.body).message.content === '지존이 고친 글', r.status + ' ' + r.body.slice(0,120));
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + myMsg.id, {method:'PATCH', headers:{'x-room-key':'room-pass'}, body:{content:'남의 글'}}), env);
  ok('room_key PATCH other 403', r.status === 403, r.status);

  /* ---------- 2026-11-26: 메시지 삭제(DELETE) · 답글 인용 보존 ---------- */
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages', {method:'POST', headers:{authorization:'Bearer ' + selboyToken}, body:{content:'삭제될 원글'}}), env);
  var parentMsg = JSON.parse(r.body).message;
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages', {method:'POST', headers:{authorization:'Bearer ' + pallyToken}, body:{content:'원글에 단 답글', reply_to_id: parentMsg.id}}), env);
  var replyMsg = JSON.parse(r.body).message;
  ok('reply quotes parent', !!replyMsg.reply_to && replyMsg.reply_to.content === '삭제될 원글', JSON.stringify(replyMsg.reply_to));

  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + parentMsg.id, {method:'DELETE', headers:{authorization:'Bearer ' + selboyToken}}), env);
  var del = JSON.parse(r.body);
  ok('DELETE own message', r.status===200 && del.ok===true && del.deleted===true && del.message.content === '삭제된 메시지입니다.' && del.message.deleted === true, r.status + ' ' + r.body.slice(0,160));

  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages?after=' + (parentMsg.id-1) + '&limit=5', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  var afterDel = JSON.parse(r.body).messages || [];
  var goneParent = afterDel.filter(function(m){ return m.id === parentMsg.id; })[0];
  var keepReply = afterDel.filter(function(m){ return m.id === replyMsg.id; })[0];
  ok('DELETE keeps row as placeholder', !!goneParent && goneParent.content === '삭제된 메시지입니다.' && goneParent.deleted === true, goneParent ? goneParent.content : 'missing');
  ok('reply quote not broken', !!keepReply && !!keepReply.reply_to && keepReply.reply_to.content === '삭제된 메시지입니다.', keepReply ? JSON.stringify(keepReply.reply_to) : 'missing');

  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + myMsg.id, {method:'DELETE', headers:{authorization:'Bearer ' + pallyToken}}), env);
  ok('DELETE other 403', r.status === 403, r.status);

  // 답글이 없는 글은 행을 지우고 방에 자리표시를 남기지 않는다
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages', {method:'POST', headers:{authorization:'Bearer ' + selboyToken}, body:{content:'혼자 있는 검증 글'}}), env);
  var lone = JSON.parse(r.body).message;
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + lone.id, {method:'DELETE', headers:{authorization:'Bearer ' + selboyToken}}), env);
  var hard = JSON.parse(r.body);
  ok('DELETE no reply -> hard', r.status===200 && hard.hard_deleted === true && hard.message === null, r.body.slice(0,140));
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages?after=' + (lone.id-1) + '&limit=10', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  var afterHard = JSON.parse(r.body).messages || [];
  ok('hard deleted gone', !afterHard.some(function(m){ return m.id === lone.id; }), afterHard.length);
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/999999', {method:'DELETE', headers:{authorization:'Bearer ' + selboyToken}}), env);
  ok('DELETE missing 404', r.status === 404, r.status);
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/abc', {method:'DELETE', headers:{authorization:'Bearer ' + selboyToken}}), env);
  ok('DELETE bad id 400', r.status === 400, r.status);
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/nope/messages/' + myMsg.id, {method:'DELETE', headers:{authorization:'Bearer ' + selboyToken}}), env);
  ok('DELETE wrong room 404', r.status === 404, r.status);

  /* ---------- 2026-11-26: 그 밖의 확인 ---------- */
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + myMsg.id, {method:'GET', headers:{authorization:'Bearer legacy-shared-key'}}), env);
  ok('GET item 405', r.status === 405, r.status);
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/health', {method:'OPTIONS'}), env);
  ok('CORS allows PATCH', (r.headers['Access-Control-Allow-Methods']||'').indexOf('PATCH') !== -1, r.headers['Access-Control-Allow-Methods']);
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages?limit=1', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  ok('list returns oldest_id', JSON.parse(r.body).oldest_id > 0, r.body.slice(0,120));

  globalThis.__out = out;
})().catch(function(e){ globalThis.__out = [{name:'EXCEPTION', ok:false, extra:String((e && e.stack) || e)}]; });
"""

SRC = PRELUDE + "\n" + WORKER + "\n" + TESTS
ctx = MiniRacer()
ctx.eval(SRC)
out = json.loads(ctx.eval("JSON.stringify(globalThis.__out || [])"))
fail = 0
for t in out:
    mark = "PASS" if t["ok"] else "FAIL"
    if not t["ok"]:
        fail += 1
    print(f'{mark}  {t["name"]:<24} {t["extra"]}')
print(f"\n{len(out)-fail}/{len(out)} passed")
sys.exit(1 if fail else 0)
