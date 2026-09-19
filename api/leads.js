// Lista completa de contactos registrados para el panel /admin.
// Cada lead con: contacto + fuente/campaña/anuncio (UTMs) + estado de la sincronización con GHL
// y link directo al contacto en GHL. Protegido con la clave del panel (env DASH_KEY).
var db = require('../lib/supabase');
var auth = require('../lib/auth');

module.exports = async function handler(req, res) {
  if (!auth.isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

  var raw = await db.fetchAll(
    '/rest/v1/mc_leads?select=created_at,name,email,phone,tracking,ghl_contact_id,ghl_status&order=created_at.desc'
  );
  if (raw === null) {
    return res.status(500).json({ error: 'No se pudo leer mc_leads (revisá las envs de Supabase y que corriste supabase/schema.sql). Detalle: ' + db.lastError() });
  }

  // Dedup por email conservando el registro MÁS RECIENTE (raw viene desc: el primero es el nuevo).
  // Si el más nuevo no trae teléfono, lo completa con el de un registro viejo del mismo email.
  var byEmail = new Map();
  var noEmail = [];
  raw.forEach(function (l) {
    var em = (l.email || '').trim().toLowerCase();
    if (!em) { noEmail.push(l); return; }
    var prev = byEmail.get(em);
    if (!prev) { byEmail.set(em, l); return; }
    if (!prev.phone && l.phone) prev.phone = l.phone;
  });
  var uniq = Array.from(byEmail.values()).concat(noEmail)
    .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });

  var locationId = process.env.GHL_LOCATION_ID || '';
  var ghlErrors = 0;
  var bySource = {};

  var leads = uniq.map(function (l) {
    var t = l.tracking || {};
    var phone = (l.phone || '').trim();
    var source = t.utm_source || '(directo / sin utm)';
    var ghlOk = l.ghl_status === 'ok';
    if (!ghlOk) ghlErrors++;
    bySource[source] = (bySource[source] || 0) + 1;
    return {
      at: l.created_at,
      name: l.name || '',
      email: l.email || '',
      phone: phone,
      wa: phone ? 'https://wa.me/' + phone.replace(/[^0-9]/g, '') : '',
      source: source,
      medium: t.utm_medium || '',
      campaign: t.utm_campaign || '',
      content: t.utm_content || '',
      ghlOk: ghlOk,
      ghlStatus: l.ghl_status || '',
      ghlUrl: l.ghl_contact_id && locationId
        ? 'https://app.gohighlevel.com/v2/location/' + locationId + '/contacts/detail/' + l.ghl_contact_id
        : ''
    };
  });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    generatedAt: new Date().toISOString(),
    total: leads.length,
    counts: { ghlErrors: ghlErrors, bySource: bySource },
    leads: leads
  });
};
