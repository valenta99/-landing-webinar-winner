// Acceso mínimo a Supabase (REST, service role). Sin SDK para no sumar dependencias.

// Último error de fetchAll (para mostrarlo en el panel al diagnosticar envs/schema).
var lastError = '';

function config() {
  var url = process.env.SUPABASE_URL;
  var key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url, headers: { apikey: key, Authorization: 'Bearer ' + key } };
}

// Inserta una fila. Devuelve true/false (no tira: el llamador decide qué hacer).
async function insert(table, row) {
  var c = config();
  if (!c) return false;
  try {
    var r = await fetch(c.url + '/rest/v1/' + table, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }, c.headers),
      body: JSON.stringify(row)
    });
    if (!r.ok) console.error('supabase insert ' + table + ' ' + r.status + ':', await r.text());
    return r.ok;
  } catch (err) {
    console.error('supabase insert ' + table + ':', err);
    return false;
  }
}

// PostgREST devuelve como máximo 1000 filas por request: paginamos con Range.
// Devuelve null si la primera página falla (tabla inexistente, envs mal, etc.).
async function fetchAll(path) {
  var c = config();
  if (!c) { lastError = 'faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en las envs'; return null; }
  var PAGE = 1000, MAX_PAGES = 60; // tope de seguridad: 60k filas
  var out = [], from = 0;
  for (var p = 0; p < MAX_PAGES; p++) {
    var r = await fetch(c.url + path, {
      headers: Object.assign({ Range: from + '-' + (from + PAGE - 1) }, c.headers)
    }).catch(function (err) { lastError = 'no se pudo conectar: ' + err.message; return null; });
    if (r && !r.ok) lastError = 'Supabase ' + r.status + ': ' + (await r.text()).slice(0, 200);
    if (!r || !r.ok) { console.error('supabase fetchAll ' + path.split('?')[0] + ' -> ' + lastError); return p === 0 ? null : out; }
    var chunk = await r.json();
    out = out.concat(chunk);
    if (chunk.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

module.exports = { insert: insert, fetchAll: fetchAll, lastError: function () { return lastError; } };
