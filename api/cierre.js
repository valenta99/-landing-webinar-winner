// api/cierre.js
// Vercel Serverless Function — form "Registro de cierre" (registro-de-cierre.html).
// Los closers cargan cada cierre y el dato viaja a un Inbound Webhook de un workflow de
// GHL, que escribe la fila en Google Sheets (acción "Google Sheets → Create Row").
//
//   GET  /api/cierre   → opciones del form (lib/cierre-config.js); sirve también para validar la contraseña
//   POST /api/cierre   → valida y reenvía al webhook de GHL
//
// Las dos llamadas exigen la contraseña del form en el header x-cierre-key.
//
// Variables de entorno (Vercel → Settings → Environment Variables):
//   GHL_CIERRE_WEBHOOK_URL   URL del trigger "Inbound Webhook" del workflow de GHL (obligatoria)
//   CIERRE_KEY               Contraseña del form (obligatoria: sin ella el endpoint responde 500)

var crypto = require('crypto');
var config = require('../lib/cierre-config');

var TZ = 'America/Argentina/Buenos_Aires';

// Comparación en tiempo constante (mismo criterio que lib/auth.js).
function keyOk(req) {
  var expected = process.env.CIERRE_KEY;
  if (!expected) return false;
  var given = String(req.headers['x-cierre-key'] || '');
  var a = Buffer.from(given);
  var b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Contraseña mala: pequeña demora para frenar el tanteo automático.
async function badKey(res) {
  await new Promise(function (r) { setTimeout(r, 600); });
  return res.status(401).json({ error: 'bad_key' });
}

function str(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 200);
}

function isoDate(v) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str(v, 10));
  if (!m) return null;
  var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return null;
  return { y: +m[1], m: +m[2], d: +m[3] };
}

function pad(n) { return (n < 10 ? '0' : '') + n; }

// dd/mm/yyyy, como el Sheet de ejemplo.
function fmtDate(p) { return pad(p.d) + '/' + pad(p.m) + '/' + p.y; }

// Fecha de ingreso + N meses; si el día no existe en el mes destino (31 → feb) cae al último día.
function addMonths(p, n) {
  var idx = p.y * 12 + (p.m - 1) + n;
  var y = Math.floor(idx / 12);
  var m = (idx % 12) + 1;
  var last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { y: y, m: m, d: Math.min(p.d, last) };
}

// Google Sheets interpreta como fórmula lo que empieza con = + - @ (un celular "+54 9 ..." da
// #ERROR!). Con un apóstrofe adelante lo guarda como texto y no muestra el apóstrofe.
function cell(v, force) {
  return force || /^[=+\-@]/.test(v) ? "'" + v : v;
}

function money(v) {
  var n = Number(v);
  return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
}

// Devuelve { error } o { row } con las claves planas que después se mapean en GHL.
function buildRow(b) {
  var email = str(b.email, 200).toLowerCase();
  var ingreso = isoDate(b.fecha_ingreso);
  var meses = parseInt(b.meses, 10);
  var entrada = money(b.monto_entrada);

  if (!str(b.nombre)) return { error: 'Falta el nombre' };
  if (!str(b.apellido)) return { error: 'Falta el apellido' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Email inválido' };
  if (!str(b.celular, 40)) return { error: 'Falta el celular' };
  if (!ingreso) return { error: 'Fecha de ingreso inválida' };
  if (!(meses >= 1 && meses <= config.mesesMax)) return { error: 'Meses de asesoría inválidos' };
  if (config.programas.indexOf(b.programa) < 0) return { error: 'Programa inválido' };
  if (config.closers.indexOf(b.closer) < 0) return { error: 'Closer inválido' };
  if (config.modalidades.indexOf(b.modalidad) < 0) return { error: 'Modalidad de pago inválida' };
  if (entrada === null) return { error: 'Monto de entrada inválido' };

  var row = {
    fecha_registro: new Date().toLocaleString('en-GB', { timeZone: TZ, hour12: false }),
    nombre: cell(str(b.nombre)),
    apellido: cell(str(b.apellido)),
    email: cell(email),
    celular: cell(str(b.celular, 40), true),
    fecha_ingreso: fmtDate(ingreso),
    meses_asesoria: meses + (meses === 1 ? ' mes' : ' meses'),
    programa: b.programa,
    closer: b.closer,
    modalidad_pago: b.modalidad,
    monto_entrada: entrada,
    monto_restante: '',
    numero_cuotas: '',
    fecha_limite_saldo: '',
    fecha_fin_asesoria: fmtDate(addMonths(ingreso, meses))
  };
  for (var i = 1; i <= config.cuotasMax; i++) {
    row['c' + i + '_vencimiento'] = '';
    row['c' + i + '_monto'] = '';
    row['c' + i + '_estado'] = '';
  }

  if (b.modalidad === 'Cuotas') {
    var n = parseInt(b.numero_cuotas, 10);
    if (!(n >= 1 && n <= config.cuotasMax)) return { error: 'Número de cuotas inválido' };
    var total = 0;
    for (var c = 1; c <= n; c++) {
      var venc = isoDate(b['c' + c + '_vencimiento']);
      var monto = money(b['c' + c + '_monto']);
      if (!venc) return { error: 'Falta el vencimiento de la cuota ' + c };
      if (monto === null) return { error: 'Falta el monto de la cuota ' + c };
      row['c' + c + '_vencimiento'] = fmtDate(venc);
      row['c' + c + '_monto'] = monto;
      row['c' + c + '_estado'] = 'Pendiente';
      total += monto;
    }
    row.numero_cuotas = n;
    row.monto_restante = Math.round(total * 100) / 100;
  } else if (b.modalidad === 'Seña') {
    var restante = money(b.monto_restante);
    var limite = isoDate(b.fecha_limite_saldo);
    if (restante === null) return { error: 'Falta el monto restante' };
    if (!limite) return { error: 'Falta la fecha límite del saldo' };
    row.monto_restante = restante;
    row.fecha_limite_saldo = fmtDate(limite);
  }

  return { row: row };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.CIERRE_KEY) return res.status(500).json({ error: 'config' });
  if (!keyOk(req)) return badKey(res);

  if (req.method === 'GET') return res.status(200).json(config);

  var url = process.env.GHL_CIERRE_WEBHOOK_URL;
  if (!url) return res.status(500).json({ error: 'config' });

  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (err) { body = {}; }
  }

  var built = buildRow(body || {});
  if (built.error) return res.status(400).json({ error: 'invalid', message: built.error });

  // Si GHL no responde devolvemos error para que el closer reintente: un cierre no se pierde en silencio.
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 15000);
  try {
    var r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(built.row),
      signal: ctrl.signal
    });
    if (!r.ok) throw new Error('GHL webhook ' + r.status);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('cierre → GHL:', err.message);
    return res.status(502).json({ error: 'ghl_failed', message: 'No se pudo guardar. Reintentá en un minuto.' });
  } finally {
    clearTimeout(timer);
  }
};
