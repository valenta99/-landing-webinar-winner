// Reenvía al webhook las respuestas ya completadas de un form de Typeform, para que
// entren al pipeline de GHL como si hubieran llegado por el webhook.
//
// Uso (PowerShell):
//   $env:TYPEFORM_TOKEN="..."; $env:TYPEFORM_WEBHOOK_KEY="..."
//   node scripts/backfill-typeform.js            # dry-run: solo lista
//   node scripts/backfill-typeform.js --send     # manda de verdad
//   node scripts/backfill-typeform.js --send --form nG2ETYi3
//   node scripts/backfill-typeform.js --send --only mail1@x.com,mail2@x.com
// Por defecto usa el form Replay Webinar (u19ta3Lb).

var args = process.argv.slice(2);
var send = args.indexOf('--send') !== -1;
var formIdx = args.indexOf('--form');
var formId = formIdx !== -1 ? args[formIdx + 1] : 'u19ta3Lb';
var onlyIdx = args.indexOf('--only');
var only = onlyIdx !== -1 ? args[onlyIdx + 1].toLowerCase().split(',') : null;
var base = process.env.WEBHOOK_BASE || 'https://clase.ahilenesteve.com/api/typeform';
var tfToken = process.env.TYPEFORM_TOKEN;
var key = process.env.TYPEFORM_WEBHOOK_KEY;

if (!tfToken || !key) {
  console.error('Faltan TYPEFORM_TOKEN y/o TYPEFORM_WEBHOOK_KEY en el entorno');
  process.exit(1);
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function fetchAll() {
  var items = [];
  var before = '';
  for (;;) {
    var url = 'https://api.typeform.com/forms/' + formId + '/responses?page_size=1000&completed=true' +
      (before ? '&before=' + before : '');
    var r = await fetch(url, { headers: { Authorization: 'Bearer ' + tfToken } });
    if (!r.ok) throw new Error('Typeform ' + r.status + ' ' + (await r.text()).slice(0, 200));
    var data = await r.json();
    if (!data.items || !data.items.length) break;
    items = items.concat(data.items);
    before = data.items[data.items.length - 1].token;
    if (data.items.length < 1000) break;
  }
  // de más viejo a más nuevo, así la última respuesta de cada persona es la que queda
  return items.sort(function (a, b) { return new Date(a.submitted_at) - new Date(b.submitted_at); });
}

(async function () {
  var items = await fetchAll();
  console.log('Respuestas completadas en ' + formId + ': ' + items.length + (send ? '' : ' (dry-run, no se manda nada)'));
  var ok = 0, ignored = 0, failed = 0;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var email = ((it.answers || []).filter(function (a) { return a.type === 'email'; })[0] || {}).email || '(sin mail)';
    var label = (i + 1) + '/' + items.length + ' ' + it.submitted_at + ' ' + email;
    if (only && only.indexOf(String(email).toLowerCase()) === -1) continue;
    if (!send) { console.log(label); continue; }
    try {
      var r = await fetch(base + '?key=' + encodeURIComponent(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: 'form_response', form_response: Object.assign({ form_id: formId }, it) })
      });
      var j = await r.json().catch(function () { return {}; });
      if (r.ok && j.ok && !j.ignored) { ok++; console.log(label + ' → ' + j.ending + ' ' + ((j.debug && j.debug.nombre) || '') + (j.ending === 'agendo' && j.debug ? ' | cita: ' + j.debug.citaCalendar + ' | calendly: ' + j.debug.calendlyHost : '')); }
      else if (r.ok) { ignored++; console.log(label + ' → ignorada: ' + j.ignored); }
      else { failed++; console.log(label + ' → ERROR ' + r.status + ' ' + JSON.stringify(j)); }
    } catch (err) {
      failed++; console.log(label + ' → ERROR ' + err.message);
    }
    await sleep(700);
  }
  if (send) console.log('\nListo. OK: ' + ok + ' | ignoradas: ' + ignored + ' | con error: ' + failed);
})().catch(function (e) { console.error(e.message); process.exit(1); });
