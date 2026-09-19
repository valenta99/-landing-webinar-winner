// api/register.js
// Vercel Serverless Function — recibe el submit del formulario de registro
// (index.html) y:
//   1) crea (o actualiza, si ya existe el email) el contacto en GoHighLevel vía
//      API v2 (POST /contacts/upsert) y lo mete al pipeline como oportunidad
//      (POST /opportunities/upsert);
//   2) guarda el lead en Supabase (mc_leads) para el panel /admin, con el
//      resultado de GHL. Se guarda SIEMPRE, aunque GHL falle.
// Sin dependencias externas: usa el runtime de Node de Vercel tal cual.
//
// Variables de entorno (Vercel → Settings → Environment Variables):
//   GHL_API_TOKEN          Token de una Private Integration de la subcuenta
//                          (scopes: contacts.write, opportunities.write)
//   GHL_LOCATION_ID        ID de la subcuenta (location) de GHL
//   GHL_PIPELINE_ID        ID del pipeline donde entra el registro
//   GHL_PIPELINE_STAGE_ID  ID de la etapa inicial de ese pipeline
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   Base del panel /admin
//   DASH_KEY               Clave de acceso a /admin (la usan api/stats y api/leads)

var db = require('../lib/supabase');

var GHL_API = 'https://services.leadconnectorhq.com';
var CONTACT_SOURCE = 'Landing registro masterclass';
var CONTACT_TAGS = ['masterclass-registro'];

// Sube el lead a GHL. Devuelve { contactId, opportunityId }; tira Error con el
// detalle si algo falla (el llamador lo registra en ghl_status).
async function syncToGhl(lead) {
  var token = process.env.GHL_API_TOKEN;
  var locationId = process.env.GHL_LOCATION_ID;
  var pipelineId = process.env.GHL_PIPELINE_ID;
  var pipelineStageId = process.env.GHL_PIPELINE_STAGE_ID;

  if (!token || !locationId || !pipelineId || !pipelineStageId) {
    throw new Error('faltan envs de GHL (GHL_API_TOKEN, GHL_LOCATION_ID, GHL_PIPELINE_ID, GHL_PIPELINE_STAGE_ID)');
  }

  function ghlPost(path, payload) {
    return fetch(GHL_API + path, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Version': '2021-07-28',
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  }

  // "Nombre" viene en un solo campo: primera palabra → firstName, resto → lastName
  var nameParts = lead.name.split(/\s+/).filter(Boolean);
  var contact = {
    locationId: locationId,
    email: lead.email,
    source: CONTACT_SOURCE,
    tags: CONTACT_TAGS
  };
  if (nameParts.length) contact.firstName = nameParts[0];
  if (nameParts.length > 1) contact.lastName = nameParts.slice(1).join(' ');
  if (lead.phone) contact.phone = lead.phone.replace(/[^\d+]/g, '');

  // 1) Contacto
  var contactRes = await ghlPost('/contacts/upsert', contact);
  if (!contactRes.ok) {
    throw new Error('contacto ' + contactRes.status + ' ' + (await contactRes.text()).slice(0, 300));
  }
  var contactData = await contactRes.json();
  var contactId = contactData && contactData.contact && contactData.contact.id;
  if (!contactId) throw new Error('GHL no devolvió el id del contacto');

  // 2) Oportunidad en el pipeline (upsert: si el contacto ya tiene una en
  //    este pipeline la reutiliza en vez de duplicarla)
  var fullName = nameParts.join(' ');
  var oppRes = await ghlPost('/opportunities/upsert', {
    locationId: locationId,
    pipelineId: pipelineId,
    pipelineStageId: pipelineStageId,
    contactId: contactId,
    name: (fullName || lead.email) + ' — Masterclass',
    status: 'open',
    source: CONTACT_SOURCE
  });
  if (!oppRes.ok) {
    // el contacto ya quedó creado: lo devolvemos junto al error para no perderlo
    var err = new Error('oportunidad ' + oppRes.status + ' ' + (await oppRes.text()).slice(0, 300));
    err.contactId = contactId;
    throw err;
  }
  var oppData = await oppRes.json().catch(function () { return null; });
  return {
    contactId: contactId,
    opportunityId: (oppData && oppData.opportunity && oppData.opportunity.id) || null
  };
}

// Solo valores string, acotados: el objeto viene de la URL y lo controla quien visita.
function cleanTracking(t) {
  var out = {};
  if (!t || typeof t !== 'object') return out;
  Object.keys(t).slice(0, 30).forEach(function (k) {
    if (typeof t[k] === 'string') out[String(k).slice(0, 60)] = t[k].slice(0, 300);
  });
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var body = req.body;

  // Vercel parsea el JSON automáticamente cuando el Content-Type es
  // application/json, pero por las dudas soportamos también que llegue
  // como string sin parsear.
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (err) {
      return res.status(400).json({ error: 'Body inválido: no es JSON' });
    }
  }

  if (!body || !body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(body.email).trim())) {
    return res.status(400).json({ error: 'Falta el email o no es válido' });
  }

  var lead = {
    name: String(body.nombre || '').trim().slice(0, 120),
    email: String(body.email).trim().toLowerCase().slice(0, 160),
    phone: body.telefono ? String(body.telefono).trim().slice(0, 40) : ''
  };

  // 1) GHL
  var ghl = { contactId: null, opportunityId: null };
  var ghlStatus = 'ok';
  try {
    ghl = await syncToGhl(lead);
  } catch (err) {
    console.error('GHL:', err.message);
    ghlStatus = 'error: ' + err.message.slice(0, 300);
    if (err.contactId) ghl.contactId = err.contactId;
  }

  // 2) Supabase (panel /admin) — se guarda igual si GHL falló
  var saved = await db.insert('mc_leads', {
    name: lead.name || null,
    email: lead.email,
    phone: lead.phone || null,
    vid: body.vid ? String(body.vid).slice(0, 64) : null,
    tracking: cleanTracking(body.tracking),
    page: req.headers.referer ? String(req.headers.referer).slice(0, 500) : null,
    ghl_contact_id: ghl.contactId,
    ghl_opportunity_id: ghl.opportunityId,
    ghl_status: ghlStatus
  });

  // Solo es un error si el lead no quedó en ningún lado.
  if (ghlStatus !== 'ok' && !saved) {
    return res.status(502).json({ error: 'No se pudo guardar el registro' });
  }
  return res.status(200).json({ ok: true });
};
