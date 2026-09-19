// Contador de visitas propio: la landing y la página de gracias mandan un beacon acá.
// Guarda en Supabase (mc_hits). Si faltan las envs o la tabla, no rompe nada (204 igual).
var db = require('../lib/supabase');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (err) { body = {}; }
  }
  body = body || {};

  await db.insert('mc_hits', {
    path: body.path ? String(body.path).slice(0, 200) : '/',
    vid: body.vid ? String(body.vid).slice(0, 64) : null,
    source: body.source ? String(body.source).slice(0, 100) : null
  });

  return res.status(204).end();
};
