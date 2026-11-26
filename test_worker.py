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
    messages: [], nextId: 1, tokens: [], nextTokenId: 1, limits: {}, cols: {}, rooms: [
      {slug:'general', name:'종합 회의실', description:'모두 함께', position:1},
      {slug:'insurance', name:'보험·마케팅', description:'보험', position:2}
    ]
  };
  function norm(sql){ return String(sql).replace(/\s+/g, ' ').trim(); }

  // where 절의 and 조건을 순서대로 해석한다(? 자리 값을 순서대로 소비). order by / limit / offset 도 처리.
  function filterMessages(rows, s, params){
    var i = 0;
    var wi = s.indexOf(' where ');
    if (wi !== -1) {
      var tail = s.slice(wi + 7);
      var cut = tail.search(/ (order by|group by|limit|offset) /);
      var whereStr = cut === -1 ? tail : tail.slice(0, cut);
      var preds = whereStr.split(/ and /i);
      for (var p = 0; p < preds.length; p++) {
        var pr = preds[p].replace(/\s+/g, ' ').trim();
        var v;
        if (/^(m\.)?room_slug = \?$/.test(pr)) { v = params[i++]; rows = rows.filter(function(r){ return r.room_slug === v; }); }
        else if (/^(m\.)?id = \?$/.test(pr)) { v = params[i++]; rows = rows.filter(function(r){ return r.id === v; }); }
        else if (/^(m\.)?id > \?$/.test(pr)) { v = params[i++]; rows = rows.filter(function(r){ return r.id > v; }); }
        else if (/^(m\.)?id < \?$/.test(pr)) { v = params[i++]; rows = rows.filter(function(r){ return r.id < v; }); }
        else if (/^(m\.)?id >= \?$/.test(pr)) { v = params[i++]; rows = rows.filter(function(r){ return r.id >= v; }); }
        else if (/^(m\.)?id in \(/.test(pr)) {
          var n = (pr.match(/\?/g) || []).length;
          var vals = params.slice(i, i + n); i += n;
          rows = rows.filter(function(r){ return vals.indexOf(r.id) !== -1; });
        }
        else if (/^(m\.)?hidden_at is null$/.test(pr)) rows = rows.filter(function(r){ return !r.hidden_at; });
        else if (/^(m\.)?hidden_at is not null$/.test(pr)) rows = rows.filter(function(r){ return !!r.hidden_at; });
        else if (/^(m\.)?hidden_at < \?$/.test(pr)) { v = params[i++]; rows = rows.filter(function(r){ return !!r.hidden_at && String(r.hidden_at) < String(v); }); }
        else if (/^coalesce\(pinned, \d+\) = 0$/.test(pr)) rows = rows.filter(function(r){ return !r.pinned; });
        else if (/^coalesce\(retention_kind, 'normal'\) = \?$/.test(pr)) { v = params[i++]; rows = rows.filter(function(r){ return (r.retention_kind || 'normal') === v; }); }
        else if (/^(m\.)?retention_kind = \?$/.test(pr)) { v = params[i++]; rows = rows.filter(function(r){ return (r.retention_kind || 'normal') === v; }); }
        else if (/^(m\.)?pinned = \?$/.test(pr)) { v = params[i++]; rows = rows.filter(function(r){ return (r.pinned ? 1 : 0) === (v ? 1 : 0); }); }
        else if (/^(m\.)?reply_to_id = \?$/.test(pr)) { v = params[i++]; rows = rows.filter(function(r){ return r.reply_to_id === v; }); }
        else if (/^(m\.)?created_at < \?$/.test(pr)) { v = params[i++]; rows = rows.filter(function(r){ return String(r.created_at) < String(v); }); }
        /* 2026-11-26 안건·결정 열 — 실제 SQLite 와 같은 뜻으로 거른다(모르는 조건을 건너뛰면 삭제 대상을 잘못 넓힌다). */
        else if (/^(?:m\.)?agenda = \?$/.test(pr)) { v = params[i++]; rows = rows.filter(function(r){ return r.agenda != null && Number(r.agenda) === Number(v); }); }
        else if (/^(?:m\.)?agenda = -?\d+$/.test(pr)) { v = Number(pr.replace(/^.*agenda = /, '')); rows = rows.filter(function(r){ return r.agenda != null && Number(r.agenda) === v; }); }
        else if (/^(?:m\.)?agenda is null$/.test(pr)) rows = rows.filter(function(r){ return r.agenda == null; });
        else if (/^(?:m\.)?agenda is not null$/.test(pr)) rows = rows.filter(function(r){ return r.agenda != null; });
        else if (/^(?:m\.)?agenda <> -?\d+$/.test(pr)) { v = Number(pr.replace(/^.*agenda <> /, '')); rows = rows.filter(function(r){ return r.agenda == null || Number(r.agenda) !== v; }); }
        else if (/^(?:m\.)?approved_at is null$/.test(pr)) rows = rows.filter(function(r){ return !r.approved_at; });
        else if (/^(?:m\.)?approved_at is not null$/.test(pr)) rows = rows.filter(function(r){ return !!r.approved_at; });
        else if (/^(?:m\.)?rejected_at is null$/.test(pr)) rows = rows.filter(function(r){ return !r.rejected_at; });
        else if (/^(?:m\.)?rejected_at is not null$/.test(pr)) rows = rows.filter(function(r){ return !!r.rejected_at; });
        else if (/^(?:m\.)?held_at is null$/.test(pr)) rows = rows.filter(function(r){ return !r.held_at; });
        else if (/^(?:m\.)?held_at is not null$/.test(pr)) rows = rows.filter(function(r){ return !!r.held_at; });
        else if (/^(?:m\.)?hold_notified_at is null$/.test(pr)) rows = rows.filter(function(r){ return !r.hold_notified_at; });
        else if (/^(?:m\.)?hold_notified_at is not null$/.test(pr)) rows = rows.filter(function(r){ return !!r.hold_notified_at; });
        /* 승인된 안건은 보관 정리에서 뺀다 — (approved_at is null or agenda is null or agenda <> 1) */
        else if (/^\(.*approved_at is null or .*agenda is null or .*agenda <> 1.*\)$/.test(pr)) rows = rows.filter(function(r){ return !r.approved_at || r.agenda == null || Number(r.agenda) !== 1; });
        /* 안건 요약 — (m.agenda = 1 or approved_at is not null or rejected_at is not null or held_at is not null) */
        else if (/^\(.*agenda = 1 or .*\)$/.test(pr)) rows = rows.filter(function(r){ return Number(r.agenda) === 1 || !!r.approved_at || !!r.rejected_at || !!r.held_at; });
        else if (/^1 = 1$/.test(pr)) { /* 항상 참 */ }
      }
    }
    var om = s.match(/order by\s+(?:m\.)?id\s+(asc|desc)/);
    if (om) rows = rows.slice().sort(function(a,b){ return om[1] === 'desc' ? b.id - a.id : a.id - b.id; });
    var lm = s.match(/limit\s+(\?|\d+)/);
    if (lm) {
      var lim = lm[1] === '?' ? params[i++] : parseInt(lm[1], 10);
      var off = 0;
      var ofm = s.match(/offset\s+(\?|\d+)/);
      if (ofm) off = ofm[1] === '?' ? params[i++] : parseInt(ofm[1], 10);
      rows = rows.slice(off, off + lim);
    }
    return rows;
  }

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
        if (s.indexOf('select count(*) as n from messages') === 0)
          return Promise.resolve({ n: filterMessages(db.messages.slice(), s, params).length });
        if (s.indexOf('from messages') !== -1)
          return Promise.resolve(filterMessages(db.messages.slice(), s, params)[0] || null);
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
        if (s.indexOf('from messages') !== -1)
          return Promise.resolve({results: filterMessages(db.messages.slice(), s, params)});
        if (s.indexOf('select id, agent, label, created_at') === 0)
          return Promise.resolve({results: db.tokens});
        return Promise.resolve({results: []});
      },
      run: function(){
        var s = norm(sql);
        if (s.indexOf('create table') === 0) return Promise.resolve({meta:{}});
        if (s.indexOf('alter table messages add column') === 0) {
          var cm = s.match(/add column (\w+)/);
          var col = cm ? cm[1] : '?';
          if (db.cols[col]) return Promise.reject(new Error('duplicate column name: ' + col));
          db.cols[col] = true;
          return Promise.resolve({meta:{}});
        }
        if (s.indexOf('insert into rate_limits') === 0) {
          var b = params[0], win = params[1], cur = db.limits[b];
          if (cur && cur.window_start === win) cur.count++;
          else db.limits[b] = {bucket:b, window_start:win, count:1};
          return Promise.resolve({meta:{}});
        }
        if (s.indexOf('insert into messages') === 0) {
          var colm = s.match(/insert into messages \(([^)]*)\)/);
          var cols = colm ? colm[1].split(',').map(function(c){ return c.trim(); }) : [];
          var row = {id: db.nextId++, pinned: 0, retention_kind: 'normal', hidden_at: null, deleted_at: null, attachment_id: null};
          var ci = 0;
          cols.forEach(function(c){
            if (c === 'created_at') { row.created_at = new Date().toISOString(); return; }
            row[c] = params[ci++];
          });
          if (!row.created_at) row.created_at = new Date().toISOString();
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
        if (s.indexOf('update messages set ') === 0) {
          var mm = s.match(/set (.*?) where id = \?$/);
          var assigns = mm ? mm[1].split(',').map(function(x){ return x.trim(); }) : [];
          var idVal = params[params.length - 1];
          var row2 = db.messages.filter(function(m){ return m.id === idVal; })[0];
          var pi = 0;
          assigns.forEach(function(a){
            var q1 = a.match(/^(\w+) = \?$/);
            var n1 = a.match(/^(\w+) = (\d+)$/);
            var z1 = a.match(/^(\w+) = null$/i);
            if (q1) { if (row2) row2[q1[1]] = params[pi]; pi++; }
            else if (n1) { if (row2) row2[n1[1]] = parseInt(n1[2], 10); }
            else if (z1) { if (row2) row2[z1[1]] = null; }
          });
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

  /* ---------- 2026-11-26: 보관 표시(고정·잡담) ---------- */
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages', {method:'POST', headers:{authorization:'Bearer ' + selboyToken}, body:{content:'평범한 보고'}}), env);
  var plain = JSON.parse(r.body).message;
  ok('default retention', plain.pinned === false && plain.retention === 'normal' && plain.retention_days === 90 && !!plain.expires_at,
     JSON.stringify({p:plain.pinned, r:plain.retention, d:plain.retention_days}));

  // 고정은 누구나(보호 방향) — 남의 글도 가능
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + plain.id, {method:'PATCH', headers:{authorization:'Bearer ' + pallyToken}, body:{pinned:true}}), env);
  var pinRes = JSON.parse(r.body);
  ok('any agent can pin', r.status===200 && pinRes.message.pinned === true && pinRes.message.retention_days === null, r.status + ' ' + r.body.slice(0,160));
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + plain.id, {method:'PATCH', headers:{authorization:'Bearer ' + pallyToken}, body:{pinned:false}}), env);
  ok('unpin other 403', r.status === 403, r.status + ' ' + r.body.slice(0,120));
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + plain.id, {method:'PATCH', headers:{authorization:'Bearer ' + selboyToken}, body:{pinned:false}}), env);
  ok('owner unpin', r.status===200 && JSON.parse(r.body).message.pinned === false, r.status);

  // 잡담(10일) — 그 글을 쓴 사람 또는 지존
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + plain.id, {method:'PATCH', headers:{authorization:'Bearer ' + pallyToken}, body:{retention:'casual'}}), env);
  ok('casual other 403', r.status === 403, r.status);
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + plain.id, {method:'PATCH', headers:{authorization:'Bearer ' + selboyToken}, body:{retention:'casual'}}), env);
  var casualMsg = JSON.parse(r.body).message;
  ok('owner casual', r.status===200 && casualMsg.retention === 'casual' && casualMsg.retention_days === 10, r.status + ' ' + r.body.slice(0,160));
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + plain.id, {method:'PATCH', headers:{'x-room-key':'room-pass'}, body:{retention:'normal'}}), env);
  ok('human sets normal', r.status===200 && JSON.parse(r.body).message.retention === 'normal', r.status);
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages', {method:'POST', headers:{authorization:'Bearer ' + selboyToken}, body:{content:'테스트 사진', retention:'chat'}}), env);
  var casualNew = JSON.parse(r.body).message;
  ok('post as casual', r.status===201 && casualNew.retention === 'casual' && casualNew.retention_days === 10, r.body.slice(0,160));
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/999999', {method:'PATCH', headers:{authorization:'Bearer ' + selboyToken}, body:{pinned:true}}), env);
  ok('flag missing 404', r.status === 404, r.status);
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + plain.id, {method:'PATCH', headers:{authorization:'Bearer ' + selboyToken}, body:{}}), env);
  ok('flag empty 400', r.status === 400, r.status);

  /* ---------- 2026-11-26: 정리(dry-run · 숨김 · 복원 · 삭제) ---------- */
  var db = env.DB._raw;
  function addAged(days, content, extra){
    var row = {
      id: db.nextId++, room_slug: (extra && extra.room) || 'general', sender: (extra && extra.sender) || '외문집사',
      content: content, reply_to_id: null, attachment_id: null,
      created_at: new Date(Date.now() - days*86400000).toISOString(),
      pinned: (extra && extra.pinned) ? 1 : 0,
      retention_kind: (extra && extra.retention) || 'normal',
      hidden_at: null, deleted_at: null
    };
    db.messages.push(row);
    return row;
  }
  var raw95 = addAged(95, '석 달 전 확정 사항: 순천 경매 완납 완료 https://example.com/a');
  var rawCasual = addAged(12, 'ㅋㅋ 잡담');
  rawCasual.retention_kind = 'casual';
  var rawPinned = addAged(95, '석 달 전 중요 결정', {pinned:true});
  var rawCasualOld = addAged(95, '오래된 잡담', {retention:'casual'});
  var rawRecent = addAged(5, '최근 정상 글');

  r = await __handler.fetch(makeReq('https://x.pages.dev/api/admin/cleanup', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  var dry = JSON.parse(r.body);
  ok('cleanup dry-run', r.status===200 && dry.dry_run === true && dry.targets.total === 3 && dry.targets.casual === 2 && dry.targets.normal === 1,
     r.status + ' ' + JSON.stringify({total:dry.targets && dry.targets.total, c:dry.targets && dry.targets.casual, n:dry.targets && dry.targets.normal}));
  ok('cleanup dry-run hid nothing', db.messages.filter(function(m){ return !!m.hidden_at; }).length === 0);
  ok('cleanup backup', !!dry.backup && dry.backup.summary.total === 3 && dry.backup.messages.length === 3 && dry.backup.summary.links.length >= 1,
     JSON.stringify(dry.backup && dry.backup.summary && {t:dry.backup.summary.total, l:dry.backup.summary.links.length}));

  r = await __handler.fetch(makeReq('https://x.pages.dev/api/admin/cleanup', {headers:{authorization:'Bearer ' + pallyToken}}), env);
  ok('cleanup agent 403', r.status === 403, r.status);

  r = await __handler.fetch(makeReq('https://x.pages.dev/api/admin/cleanup', {method:'POST', headers:{authorization:'Bearer legacy-shared-key'}, body:{dry_run:false}}), env);
  var ran = JSON.parse(r.body);
  ok('cleanup hides', r.status===200 && ran.hidden === 3 && ran.purged.count === 0, r.status + ' ' + r.body.slice(0,200));

  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages?limit=200', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  var visibleIds = (JSON.parse(r.body).messages || []).map(function(m){ return m.id; });
  ok('hidden gone from list', visibleIds.indexOf(raw95.id) === -1 && visibleIds.indexOf(rawCasualOld.id) === -1 && visibleIds.indexOf(rawPinned.id) !== -1 && visibleIds.indexOf(rawRecent.id) !== -1,
     JSON.stringify({h95: visibleIds.indexOf(raw95.id), hop: visibleIds.indexOf(rawPinned.id), recent: visibleIds.indexOf(rawRecent.id)}));

  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages?limit=200&include_hidden=1', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  var withHidden = (JSON.parse(r.body).messages || []).filter(function(m){ return m.hidden; });
  ok('include_hidden shows', withHidden.length === 3, withHidden.length);

  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages?limit=200&include_hidden=1', {headers:{authorization:'Bearer ' + pallyToken}}), env);
  ok('agent no include_hidden', (JSON.parse(r.body).messages || []).some(function(m){ return m.hidden; }) === false);

  r = await __handler.fetch(makeReq('https://x.pages.dev/api/admin/hidden', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  var hid = JSON.parse(r.body);
  ok('hidden list', r.status===200 && hid.hidden === 3 && hid.messages.length === 3 && hid.messages[0].hidden === true, r.status + ' ' + r.body.slice(0,160));

  r = await __handler.fetch(makeReq('https://x.pages.dev/api/admin/restore', {method:'POST', headers:{authorization:'Bearer legacy-shared-key'}, body:{ids:[raw95.id]}}), env);
  var rest = JSON.parse(r.body);
  ok('restore', r.status===200 && rest.restored === 1 && rest.rows[0].pinned === true, r.body.slice(0,160));
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages?after=' + (raw95.id-1) + '&limit=5', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  var back = (JSON.parse(r.body).messages || []).filter(function(m){ return m.id === raw95.id; })[0];
  ok('restore visible pinned', !!back && back.pinned === true && !back.hidden, back ? JSON.stringify({p:back.pinned, h:back.hidden}) : 'missing');

  // 숨긴 지 유예(30일)가 지난 글만 실제로 지운다 — 답글이 있으면 자리표시로 남긴다
  var oldHidden = addAged(120, '아주 오래된 잡담');
  oldHidden.hidden_at = new Date(Date.now() - 40*86400000).toISOString();
  var oldParent = addAged(120, '답글 달린 오래된 글');
  oldParent.hidden_at = new Date(Date.now() - 40*86400000).toISOString();
  db.messages.push({id: db.nextId++, room_slug:'general', sender:'연금술사', content:'그 오래된 글에 단 답글', reply_to_id: oldParent.id, attachment_id:null, created_at:new Date().toISOString(), pinned:0, retention_kind:'normal', hidden_at:null, deleted_at:null});

  r = await __handler.fetch(makeReq('https://x.pages.dev/api/admin/cleanup', {method:'POST', headers:{authorization:'Bearer legacy-shared-key'}, body:{purge:true}}), env);
  var purged = JSON.parse(r.body);
  var oldLeft = db.messages.filter(function(m){ return m.id === oldHidden.id; }).length;
  var parentRow = db.messages.filter(function(m){ return m.id === oldParent.id; })[0];
  ok('purge deletes', purged.purged.count === 2 && purged.purged.deleted === 1 && purged.purged.placeholder === 1 && oldLeft === 0, JSON.stringify(purged.purged));
  ok('purge keeps quote placeholder', !!parentRow && parentRow.content === '삭제된 메시지입니다.' && !!parentRow.deleted_at, parentRow ? parentRow.content : 'missing');

  r = await __handler.fetch(makeReq('https://x.pages.dev/api/admin/cleanup', {method:'POST', headers:{authorization:'Bearer legacy-shared-key'}, body:{purge:false}}), env);
  ok('cleanup purge=0 skips', JSON.parse(r.body).purged.count === 0, r.body.slice(0,140));

  /* ---------- 2026-11-26: 아카이브 내보내기 ---------- */
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/admin/archive?room=general&limit=1000', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  var arc = JSON.parse(r.body);
  ok('archive json', r.status===200 && arc.ok === true && arc.messages.length > 0 && arc.summary.total === arc.messages.length, r.status + ' ' + r.body.slice(0,160));
  ok('archive includes hidden', arc.messages.some(function(m){ return m.id === rawCasualOld.id && !!m.hidden_at; }), 'hidden flag');
  ok('archive link summary', (arc.summary.links || []).some(function(l){ return l.indexOf('example.com') !== -1; }), JSON.stringify(arc.summary.links));
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/admin/archive?room=general&format=markdown', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  ok('archive markdown', r.status===200 && String(r.body).indexOf('# 무림AI방 아카이브') === 0, String(r.body).slice(0,80));
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/admin/archive', {headers:{authorization:'Bearer ' + pallyToken}}), env);
  ok('archive agent 403', r.status === 403, r.status);

  // 이미 열이 있는 DB(중복 ALTER 실패)에서도 목록이 계속 동작한다
  var env3 = makeEnv();
  env3.DB._raw.cols = {pinned:true, retention_kind:true, hidden_at:true, deleted_at:true};
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages', {headers:{authorization:'Bearer legacy-shared-key'}}), env3);
  ok('schema re-entry safe', r.status === 200, r.status);

  /* ---------- 2026-11-26: 그 밖의 확인 ---------- */
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/' + myMsg.id, {method:'GET', headers:{authorization:'Bearer legacy-shared-key'}}), env);
  ok('GET item 405', r.status === 405, r.status);
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/health', {method:'OPTIONS'}), env);
  ok('CORS allows PATCH', (r.headers['Access-Control-Allow-Methods']||'').indexOf('PATCH') !== -1, r.headers['Access-Control-Allow-Methods']);
  r = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages?limit=1', {headers:{authorization:'Bearer legacy-shared-key'}}), env);
  ok('list returns oldest_id', JSON.parse(r.body).oldest_id > 0, r.body.slice(0,120));

  /* ================= 2026-11-26 추가: 안건 · 승인/미승인/보류 · 왼쪽 요약 · 수명 주기 ================= */
  var env2 = makeEnv();
  var db2 = env2.DB._raw;
  function isoAgo(days){ return new Date(Date.now() - days * 86400000).toISOString(); }
  function put2(room, sender, content, extra){
    var row = {id: db2.nextId++, room_slug: room || 'general', sender: sender || '외문집사', content: content,
      reply_to_id: null, attachment_id: null, created_at: new Date().toISOString(), pinned: 0, retention_kind: 'normal',
      hidden_at: null, deleted_at: null, agenda: null, approved_at: null, approved_by: null, rejected_at: null,
      rejected_by: null, held_at: null, held_by: null, hold_notified_at: null};
    for (var k in (extra || {})) row[k] = extra[k];
    db2.messages.push(row);
    return row;
  }
  function call2(path, opts){ return __handler.fetch(makeReq('https://x.pages.dev' + path, opts), env2); }

  // 1) 토큰 — 개인 토큰(연금술사 · CEO=지존)은 공용 키로만 발급
  var tkRes = await call2('/api/admin/tokens', {method:'POST', headers:{authorization:'Bearer legacy-shared-key'}, body:{agents:['연금술사','CEO']}});
  var tks = JSON.parse(tkRes.body).tokens || [];
  var allyTok = tks[0] && tks[0].token, ceoTok = tks[1] && tks[1].token;
  ok('agenda: mint two tokens', tkRes.status === 201 && tks.length === 2, tkRes.status + ' ' + tkRes.body.slice(0,120));

  // 2) /api/me 의 can_approve — 지존(웹 입장 키 · CEO 토큰)만 true
  var meAlly = JSON.parse((await call2('/api/me', {headers:{authorization:'Bearer ' + allyTok}})).body);
  var meCeo = JSON.parse((await call2('/api/me', {headers:{authorization:'Bearer ' + ceoTok}})).body);
  var meApi = JSON.parse((await call2('/api/me', {headers:{authorization:'Bearer legacy-shared-key'}})).body);
  var meRoom = JSON.parse((await call2('/api/me', {headers:{'x-room-key':'room-pass'}})).body);
  ok('agenda: can_approve is sovereign only',
    meAlly.can_approve === false && meCeo.can_approve === true && meApi.can_approve === false && meRoom.can_approve === true,
    JSON.stringify({ally: meAlly.can_approve, ceo: meCeo.can_approve, api: meApi.can_approve, room: meRoom.can_approve}));
  ok('agenda: approver_name', meCeo.approver_name === '지존' && meAlly.approver_name === null && meCeo.agent === '지존', meCeo.approver_name + ' / ' + meAlly.approver_name);

  // 3) 안건 판별 — [안건] 자동 · 안건: 줄 · agenda:true/false
  var postAgenda = await call2('/api/rooms/general/messages', {method:'POST', headers:{authorization:'Bearer ' + allyTok}, body:{content:'[안건] 서버 교체 예산 승인 요청'}});
  var msgAgenda = JSON.parse(postAgenda.body).message;
  ok('agenda: body tag detected', postAgenda.status === 201 && msgAgenda.agenda === true && msgAgenda.decision === 'rejected', postAgenda.status + ' ' + postAgenda.body.slice(0,180));
  ok('agenda: default rejected + 7 days', msgAgenda.days_left === 7 && msgAgenda.deadline_at && msgAgenda.lifecycle && msgAgenda.lifecycle.stage === 'rejected', JSON.stringify({d: msgAgenda.days_left, st: msgAgenda.lifecycle && msgAgenda.lifecycle.stage}));
  ok('agenda: stored as agenda=1', db2.messages.filter(function(m){ return m.id === msgAgenda.id; })[0].agenda === 1, db2.messages.filter(function(m){ return m.id === msgAgenda.id; })[0].agenda);

  var postPlain = await call2('/api/rooms/general/messages', {method:'POST', headers:{authorization:'Bearer ' + allyTok}, body:{content:'오늘 점심 메뉴 정하실 분'}});
  var msgPlain = JSON.parse(postPlain.body).message;
  ok('agenda: plain is not agenda', postPlain.status === 201 && msgPlain.agenda === false && msgPlain.decision === null && msgPlain.deadline_at == null, postPlain.body.slice(0,160));

  var postLine = await call2('/api/rooms/general/messages', {method:'POST', headers:{authorization:'Bearer ' + allyTok}, body:{content:'안건: 새 방 하나 만들어 주세요'}});
  var msgLine = JSON.parse(postLine.body).message;
  ok('agenda: line prefix detected', msgLine.agenda === true, postLine.body.slice(0,160));

  var postOff = await call2('/api/rooms/general/messages', {method:'POST', headers:{authorization:'Bearer ' + allyTok}, body:{content:'[안건] 이건 그냥 공지입니다', agenda:false}});
  var msgOff = JSON.parse(postOff.body).message;
  ok('agenda: agenda=false overrides tag', msgOff.agenda === false && msgOff.decision === null, postOff.body.slice(0,160));

  var postOn = await call2('/api/rooms/general/messages', {method:'POST', headers:{authorization:'Bearer ' + allyTok}, body:{content:'표시 없이 보내는 안건', agenda:true}});
  var msgOn = JSON.parse(postOn.body).message;
  ok('agenda: agenda=true without tag', msgOn.agenda === true && msgOn.decision === 'rejected', postOn.body.slice(0,160));

  // 4) 안건 표시 PATCH — 쓴 사람 또는 지존만
  var patchOwn = await call2('/api/rooms/general/messages/' + msgPlain.id, {method:'PATCH', headers:{authorization:'Bearer ' + allyTok}, body:{agenda:true}});
  ok('agenda: author can mark', patchOwn.status === 200 && JSON.parse(patchOwn.body).message.agenda === true, patchOwn.status + ' ' + patchOwn.body.slice(0,140));
  var patchOther = await call2('/api/rooms/general/messages/' + msgAgenda.id, {method:'PATCH', headers:{authorization:'Bearer ' + ceoTok}, body:{agenda:false}});
  ok('agenda: sovereign can unmark other', patchOther.status === 200 && JSON.parse(patchOther.body).message.agenda === false, patchOther.status + ' ' + patchOther.body.slice(0,140));
  var patchBack = await call2('/api/rooms/general/messages/' + msgAgenda.id, {method:'PATCH', headers:{authorization:'Bearer ' + ceoTok}, body:{agenda:true}});
  ok('agenda: re-mark', patchBack.status === 200 && JSON.parse(patchBack.body).message.agenda === true, patchBack.status);

  // 5) 결정 권한 — 다른 참여자 토큰·공용 키는 403
  var decAlly = await call2('/api/rooms/general/messages/' + msgAgenda.id + '/decision', {method:'POST', headers:{authorization:'Bearer ' + allyTok}, body:{decision:'approved'}});
  ok('agenda: agent decision 403', decAlly.status === 403 && JSON.parse(decAlly.body).error === 'forbidden', decAlly.status + ' ' + decAlly.body.slice(0,160));
  var decApi = await call2('/api/rooms/general/messages/' + msgAgenda.id + '/decision', {method:'POST', headers:{authorization:'Bearer legacy-shared-key'}, body:{decision:'approved'}});
  ok('agenda: api key decision 403', decApi.status === 403, decApi.status + ' ' + decApi.body.slice(0,160));

  // 6) 지존 결정 — 웹 입장 키 · CEO 토큰 모두 가능, 기록·기한이 함께 바뀐다
  var decOk = await call2('/api/rooms/general/messages/' + msgAgenda.id + '/decision', {method:'POST', headers:{'x-room-key':'room-pass'}, body:{decision:'approved'}});
  var decMsg = JSON.parse(decOk.body).message;
  ok('agenda: sovereign approve', decOk.status === 200 && decMsg.decision === 'approved' && decMsg.approved === true && decMsg.approved_by === '지존' && !!decMsg.approved_at, decOk.status + ' ' + decOk.body.slice(0,200));
  ok('agenda: approved has no deadline', decMsg.days_left === null && decMsg.deadline_at === null, JSON.stringify({d: decMsg.days_left, dl: decMsg.deadline_at}));
  var decHeld = await call2('/api/rooms/general/messages/' + msgOn.id + '/decision', {method:'POST', headers:{authorization:'Bearer ' + ceoTok}, body:{decision:'보류'}});
  var heldMsg = JSON.parse(decHeld.body).message;
  ok('agenda: sovereign hold (korean)', decHeld.status === 200 && heldMsg.decision === 'held' && heldMsg.held === true && heldMsg.held_by === '지존', decHeld.status + ' ' + decHeld.body.slice(0,200));
  ok('agenda: held deadline 30+7', heldMsg.lifecycle && heldMsg.lifecycle.alarm_days_left === 30 && heldMsg.days_left === 37 && !heldMsg.alarm_due, JSON.stringify({alarm: heldMsg.lifecycle && heldMsg.lifecycle.alarm_days_left, d: heldMsg.days_left}));
  // 상태는 서로 배타적 — 보류에서 승인으로 바꾸면 보류 기록이 지워진다
  var decFlip = await call2('/api/rooms/general/messages/' + msgOn.id + '/decision', {method:'POST', headers:{authorization:'Bearer ' + ceoTok}, body:{decision:'approved'}});
  var flipMsg = JSON.parse(decFlip.body).message;
  ok('agenda: decisions exclusive', flipMsg.decision === 'approved' && flipMsg.held_at === null && flipMsg.held_by === null && !!flipMsg.approved_at, JSON.stringify({d: flipMsg.decision, h: flipMsg.held_at, a: flipMsg.approved_at}));

  // 7) 잘못된 요청 — 안건 아님 400 · 값 오류 400 · 없는 글 404 · 삭제된 글 400
  var decNotAgenda = await call2('/api/rooms/general/messages/' + msgOff.id + '/decision', {method:'POST', headers:{'x-room-key':'room-pass'}, body:{decision:'approved'}});
  ok('agenda: not_agenda 400', decNotAgenda.status === 400 && JSON.parse(decNotAgenda.body).error === 'not_agenda', decNotAgenda.status + ' ' + decNotAgenda.body.slice(0,140));
  var decBad = await call2('/api/rooms/general/messages/' + msgAgenda.id + '/decision', {method:'POST', headers:{'x-room-key':'room-pass'}, body:{decision:'아무거나'}});
  ok('agenda: bad decision 400', decBad.status === 400 && JSON.parse(decBad.body).error === 'invalid_request', decBad.status);
  var decMissing = await call2('/api/rooms/general/messages/999999/decision', {method:'POST', headers:{'x-room-key':'room-pass'}, body:{decision:'approved'}});
  ok('agenda: missing message 404', decMissing.status === 404, decMissing.status);
  var decNoRoom = await call2('/api/rooms/nope/messages/1/decision', {method:'POST', headers:{'x-room-key':'room-pass'}, body:{decision:'approved'}});
  ok('agenda: missing room 404', decNoRoom.status === 404, decNoRoom.status);

  // 8) 숏컷 /approve — POST=승인, DELETE=미승인
  var apShort = await call2('/api/rooms/general/messages/' + msgOn.id + '/approve', {method:'POST', headers:{'x-room-key':'room-pass'}});
  ok('agenda: /approve POST', apShort.status === 200 && JSON.parse(apShort.body).message.decision === 'approved', apShort.status + ' ' + apShort.body.slice(0,140));
  var apUndo = await call2('/api/rooms/general/messages/' + msgOn.id + '/approve', {method:'DELETE', headers:{'x-room-key':'room-pass'}});
  ok('agenda: /approve DELETE', apUndo.status === 200 && JSON.parse(apUndo.body).message.decision === 'rejected' && JSON.parse(apUndo.body).message.approved_at === null, apUndo.status + ' ' + apUndo.body.slice(0,140));

  // 9) MCP send_room_message 의 agenda 인자
  var mcpAgenda = await call2('/mcp', {method:'POST', headers:{authorization:'Bearer ' + allyTok}, body:{jsonrpc:'2.0', id:91, method:'tools/call', params:{name:'send_room_message', arguments:{room:'general', content:'표시 없는 MCP 안건', agenda:true}}}});
  var mcpText = JSON.parse(mcpAgenda.body).result.content[0].text;
  ok('agenda: mcp agenda arg', JSON.parse(mcpText).message.agenda === true, mcpText.slice(0,160));

  // 10) /api/agendas — 모든 참여자 읽기, 건수·필터·기한
  var agAll = await call2('/api/agendas?decision=all', {headers:{authorization:'Bearer ' + allyTok}});
  var agJson = JSON.parse(agAll.body);
  var realAgendas = db2.messages.filter(function(m){ return m.agenda === 1 && m.content !== '삭제된 메시지입니다.'; });
  var handCount = {approved:0, rejected:0, held:0};
  realAgendas.forEach(function(m){
    if (m.approved_at) handCount.approved++; else if (m.held_at) handCount.held++; else handCount.rejected++;
  });
  ok('agenda: list readable by agent', agAll.status === 200 && agJson.ok === true, agAll.status);
  ok('agenda: counts match db', agJson.counts.approved === handCount.approved && agJson.counts.rejected === handCount.rejected && agJson.counts.held === handCount.held,
    JSON.stringify({got: agJson.counts, want: handCount}));
  ok('agenda: list rows carry deadline', agJson.agendas.length === realAgendas.length && agJson.agendas.every(function(a){ return a.decision === 'approved' ? a.deadline_at === null : !!a.deadline_at; }), JSON.stringify({n: agJson.agendas.length, want: realAgendas.length}));
  ok('agenda: policy in response', agJson.policy.reject_days === 7 && agJson.policy.hold_days === 30 && agJson.policy.hold_alarm_after_days === 7, JSON.stringify(agJson.policy));
  var agRej = JSON.parse((await call2('/api/agendas?decision=rejected', {headers:{authorization:'Bearer ' + allyTok}})).body);
  ok('agenda: decision filter', agRej.agendas.every(function(a){ return a.decision === 'rejected'; }) && agRej.agendas.length === handCount.rejected, agRej.agendas.length + ' / ' + handCount.rejected);
  var agRoom = JSON.parse((await call2('/api/rooms/general/agendas', {headers:{authorization:'Bearer ' + allyTok}})).body);
  ok('agenda: per-room list', agRoom.ok === true && agRoom.room === 'general' && agRoom.agendas.length === realAgendas.length, agRoom.ok + ' ' + (agRoom.agendas || []).length);
  var agNoRoom = await call2('/api/rooms/nope/agendas', {headers:{authorization:'Bearer ' + allyTok}});
  ok('agenda: per-room 404', agNoRoom.status === 404, agNoRoom.status);
  ok('agenda: list not part of after-cursor', JSON.parse((await call2('/api/rooms/general/messages?after=' + (msgAgenda.id - 1), {headers:{authorization:'Bearer ' + allyTok}})).body).messages.some(function(m){ return m.agenda === true; }), 'after list carries agenda flag');

  // 11) 예전 DB(승인 열 없음) — 예전 기능은 그대로, 승인 기능만 503
  var envOld = makeEnv();
  var origPrepare = envOld.DB.prepare;
  envOld.DB.prepare = function(sql){
    if (String(sql).indexOf('select agenda, approved_at') === 0) throw new Error('no such column: agenda');
    return origPrepare(sql);
  };
  var oldPost = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages', {method:'POST', headers:{authorization:'Bearer legacy-shared-key'}, body:{sender:'지존', content:'예전 DB 글 [안건] 표시'}}), envOld);
  ok('agenda: legacy db still posts', oldPost.status === 201 || oldPost.status === 403, oldPost.status + ' ' + oldPost.body.slice(0,140));
  var oldPost2 = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages', {method:'POST', headers:{'x-room-key':'room-pass'}, body:{sender:'지존', content:'예전 DB 글 [안건] 표시'}}), envOld);
  var oldMsg2 = JSON.parse(oldPost2.body).message;
  ok('agenda: legacy db web post ok', oldPost2.status === 201 && oldMsg2.agenda === true && oldMsg2.decision === 'rejected' && oldMsg2.days_left === 7, oldPost2.status + ' ' + JSON.stringify({a: oldMsg2.agenda, d: oldMsg2.decision}));
  var oldList = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages', {headers:{authorization:'Bearer legacy-shared-key'}}), envOld);
  ok('agenda: legacy db list ok', oldList.status === 200 && JSON.parse(oldList.body).messages.length === 1, oldList.status);
  var oldClean = await __handler.fetch(makeReq('https://x.pages.dev/api/admin/cleanup', {headers:{authorization:'Bearer legacy-shared-key'}}), envOld);
  var oldCleanJson = JSON.parse(oldClean.body);
  ok('agenda: legacy db cleanup ok', oldClean.status === 200 && oldCleanJson.agenda && oldCleanJson.agenda.to_delete.count === 0, oldClean.status + ' ' + oldClean.body.slice(0,160));
  var oldDecide = await __handler.fetch(makeReq('https://x.pages.dev/api/rooms/general/messages/1/decision', {method:'POST', headers:{'x-room-key':'room-pass'}, body:{decision:'approved'}}), envOld);
  ok('agenda: legacy db decision 503', oldDecide.status === 503 && JSON.parse(oldDecide.body).error === 'unavailable', oldDecide.status);
  var oldAgendas = await __handler.fetch(makeReq('https://x.pages.dev/api/agendas', {headers:{authorization:'Bearer legacy-shared-key'}}), envOld);
  ok('agenda: legacy db agendas 503', oldAgendas.status === 503, oldAgendas.status);

  // 12) ALTER TABLE — 첫 요청에서 8개 열만 더한다
  var envCols = makeEnv();
  await __handler.fetch(makeReq('https://x.pages.dev/api/health'), envCols);
  await __handler.fetch(makeReq('https://x.pages.dev/api/rooms', {headers:{authorization:'Bearer legacy-shared-key'}}), envCols);
  var addedCols = Object.keys(envCols.DB._raw.cols).filter(function(c){ return ['agenda','approved_at','approved_by','rejected_at','rejected_by','held_at','held_by','hold_notified_at'].indexOf(c) !== -1; });
  ok('agenda: alters 8 columns', addedCols.length === 8, JSON.stringify(Object.keys(envCols.DB._raw.cols)));

  // 13) 수명 주기 — 미승인 7일 삭제 · 보류 30일 알람 + 7일 삭제 · 승인/자동인식 예전 글 보존
  var env3 = makeEnv();
  var db3 = env3.DB._raw;
  function put3(id, daysAgo, content, extra){
    var row = {id: id, room_slug:'general', sender:'외문집사', content: content, reply_to_id: null, attachment_id: null,
      created_at: isoAgo(daysAgo), pinned: 0, retention_kind: 'normal', hidden_at: null, deleted_at: null,
      agenda: null, approved_at: null, approved_by: null, rejected_at: null, rejected_by: null, held_at: null, held_by: null, hold_notified_at: null};
    for (var k in (extra || {})) row[k] = extra[k];
    db3.messages.push(row);
    db3.nextId = Math.max(db3.nextId, id + 1);
    return row;
  }
  function call3(path, opts){ return __handler.fetch(makeReq('https://x.pages.dev' + path, opts), env3); }
  var lcRejected = put3(101, 8, '[안건] 8일 지난 미승인 안건', {agenda:1});
  var lcRejectedOld = put3(102, 20, '[안건] 미승인 기록이 8일 전인 안건', {agenda:1, rejected_at: isoAgo(8), rejected_by:'지존'});
  put3(103, 8, '위 안건에 달린 답글', {reply_to_id: 102});
  var lcHeldAlarm = put3(104, 31, '[안건] 보류 31일 — 알람 차례', {agenda:1, held_at: isoAgo(31), held_by:'지존'});
  var lcHeldExpired = put3(105, 40, '[안건] 보류 알람 뒤 9일 — 삭제 차례', {agenda:1, held_at: isoAgo(40), held_by:'지존', hold_notified_at: isoAgo(9)});
  var lcApproved = put3(106, 100, '[안건] 오래전 승인된 안건', {agenda:1, approved_at: isoAgo(95), approved_by:'지존'});
  var lcAutoOld = put3(107, 20, '[안건] 예전 자동 인식 글(열 없던 시절)', {agenda: null});
  var lcPlainOld = put3(108, 95, '그냥 오래된 일반 글');

  var lcPrev = await call3('/api/admin/cleanup', {headers:{authorization:'Bearer legacy-shared-key'}});
  var lcPrevJson = JSON.parse(lcPrev.body);
  var prevIds = lcPrevJson.agenda.to_delete.preview.map(function(x){ return x.id; }).sort(function(a,b){ return a-b; });
  ok('agenda: cleanup preview is dry-run', lcPrev.status === 200 && lcPrevJson.dry_run === true, lcPrev.status + ' ' + lcPrev.body.slice(0,120));
  ok('agenda: preview to_delete exact', prevIds.join(',') === '101,102,105', prevIds.join(','));
  ok('agenda: preview holds alarm', lcPrevJson.agenda.held.alarms.length === 1 && lcPrevJson.agenda.held.alarms[0].id === 104, JSON.stringify(lcPrevJson.agenda.held.alarms));
  ok('agenda: preview keeps approved/auto/plain', lcPrevJson.agenda.to_delete.preview.every(function(x){ return [106,107,108].indexOf(x.id) === -1; }), 'ok');
  ok('agenda: preview touched nothing', db3.messages.length === 8 && db3.messages.filter(function(m){ return m.hold_notified_at; }).length === 1 && !db3.messages.filter(function(m){ return m.hidden_at; }).length, 'rows ' + db3.messages.length);
  var lcTokRes = await call3('/api/admin/tokens', {method:'POST', headers:{authorization:'Bearer legacy-shared-key'}, body:{agents:['연금술사']}});
  var lcAllyTok = JSON.parse(lcTokRes.body).tokens[0].token;
  var lcAgent = await call3('/api/admin/cleanup', {headers:{authorization:'Bearer ' + lcAllyTok}});
  ok('agenda: cleanup agent 403', lcAgent.status === 403, lcAgent.status);

  var lcRun = await call3('/api/admin/cleanup', {method:'POST', headers:{authorization:'Bearer legacy-shared-key'}, body:{purge:true}});
  var lcRunJson = JSON.parse(lcRun.body);
  var left = db3.messages.map(function(m){ return m.id; });
  ok('agenda: cleanup alarmed held', lcRunJson.agenda.alarmed === 1 && !!db3.messages.filter(function(m){ return m.id === 104; })[0].hold_notified_at, JSON.stringify({alarmed: lcRunJson.agenda.alarmed}));
  ok('agenda: cleanup deleted 3', lcRunJson.agenda.deleted.count === 3 && left.indexOf(101) === -1 && left.indexOf(105) === -1 && left.indexOf(102) !== -1, JSON.stringify({deleted: lcRunJson.agenda.deleted.rows, left: left}));
  ok('agenda: reply kept as placeholder', db3.messages.filter(function(m){ return m.id === 102; })[0].content === '삭제된 메시지입니다.', db3.messages.filter(function(m){ return m.id === 102; })[0].content);
  ok('agenda: approved kept out of retention', left.indexOf(106) !== -1 && !db3.messages.filter(function(m){ return m.id === 106; })[0].hidden_at, JSON.stringify({has: left.indexOf(106), hidden: db3.messages.filter(function(m){ return m.id === 106; })[0].hidden_at}));
  ok('agenda: auto-detected old kept', left.indexOf(107) !== -1 && !db3.messages.filter(function(m){ return m.id === 107; })[0].hidden_at, 'auto old kept');
  ok('agenda: plain old still hidden', !!db3.messages.filter(function(m){ return m.id === 108; })[0].hidden_at, 'plain hidden');

  var lcAgain = await call3('/api/admin/cleanup', {method:'POST', headers:{authorization:'Bearer legacy-shared-key'}, body:{purge:true}});
  ok('agenda: cleanup idempotent', JSON.parse(lcAgain.body).agenda.deleted.count === 0 && JSON.parse(lcAgain.body).agenda.alarmed === 0, lcAgain.body.slice(0,120));

  // 알람 뒤 7일이 지난 보류 건은 다음 정리에서 지워진다
  var heldRow = db3.messages.filter(function(m){ return m.id === 104; })[0];
  heldRow.hold_notified_at = isoAgo(8);
  var lcAfter = await call3('/api/admin/cleanup', {method:'POST', headers:{authorization:'Bearer legacy-shared-key'}, body:{purge:true}});
  ok('agenda: held deleted after alarm+7', JSON.parse(lcAfter.body).agenda.deleted.count === 1 && db3.messages.map(function(m){ return m.id; }).indexOf(104) === -1, lcAfter.body.slice(0,140));

  var lcOff = await call3('/api/admin/cleanup?agenda_lifecycle=false', {headers:{authorization:'Bearer legacy-shared-key'}});
  ok('agenda: lifecycle can be off', JSON.parse(lcOff.body).agenda.to_delete.count === 0, lcOff.body.slice(0,140));

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
