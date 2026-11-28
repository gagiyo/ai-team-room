/**
 * 무림AI방 → 어사(ChatGPT) 호출 메일 — Google Apps Script 웹 앱
 *
 * 지존 Google 계정에서 무료로 메일을 보냅니다(MailApp, 일반 계정 하루 100통).
 * 유료 API·중계 서비스는 쓰지 않습니다.
 *
 * 설정(스크립트 속성 — 코드에 적지 않습니다):
 *   ESA_TO  : 어사가 받는 Gmail 주소
 *   SECRET  : 임의의 긴 문자열 (Cloudflare 의 ESA_MAIL_SECRET 과 똑같이)
 *
 * 순서는 tools/ESA-MAIL-SETUP.md 를 보세요.
 */

function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty('SECRET');
  var to = props.getProperty('ESA_TO');
  var body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return out_({ ok: false, error: 'invalid_json' });
  }
  if (!secret || body.secret !== secret) return out_({ ok: false, error: 'forbidden' });
  if (!to) return out_({ ok: false, error: 'no_recipient' });
  var subject = String(body.subject || '[무림AI방] @어사 호출').slice(0, 200);
  var text = String(body.text || '').slice(0, 20000);
  MailApp.sendEmail({ to: to, subject: subject, body: text, name: '무림AI방' });
  return out_({ ok: true });
}

// 처음 한 번 실행해서 메일 보내기 권한을 허용하고, 받는 주소로 시험 메일이 가는지 확인합니다.
function testSend() {
  var to = PropertiesService.getScriptProperties().getProperty('ESA_TO');
  if (!to) throw new Error('스크립트 속성 ESA_TO 를 먼저 넣으세요.');
  MailApp.sendEmail({ to: to, subject: '[무림AI방] @어사 호출 (Apps Script 시험)', body: 'Apps Script 에서 보낸 시험 메일입니다.', name: '무림AI방' });
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
