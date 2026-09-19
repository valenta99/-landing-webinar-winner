// Acceso al panel: clave compartida (env DASH_KEY), por header x-dash-key
// (o ?key= como respaldo). Comparación en tiempo constante.
var crypto = require('crypto');

function isAuthorized(req) {
  var expected = process.env.DASH_KEY;
  if (!expected) return false;
  var given = String(req.headers['x-dash-key'] || (req.query && req.query.key) || '');
  var a = Buffer.from(given);
  var b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { isAuthorized: isAuthorized };
