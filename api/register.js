// api/register.js
// Vercel Serverless Function — recibe el submit del formulario de registro
// (index.html), crea (o actualiza, si ya existe el email) el contacto en
// GoHighLevel vía API v2 (POST /contacts/upsert) y lo mete al pipeline como
// oportunidad (POST /opportunities/upsert).
// Sin dependencias externas: usa el runtime de Node de Vercel tal cual.
//
// Variables de entorno (Vercel → Settings → Environment Variables):
//   GHL_API_TOKEN          Token de una Private Integration de la subcuenta
//                          (scopes: contacts.write, opportunities.write)
//   GHL_LOCATION_ID        ID de la subcuenta (location) de GHL
//   GHL_PIPELINE_ID        ID del pipeline donde entra el registro
//   GHL_PIPELINE_STAGE_ID  ID de la etapa inicial de ese pipeline

var GHL_API = 'https://services.leadconnectorhq.com';
var CONTACT_SOURCE = 'Landing registro masterclass';
var CONTACT_TAGS = ['masterclass-registro'];

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

  if (!body || !body.email) {
    return res.status(400).json({ error: 'Falta el email' });
  }

  var token = process.env.GHL_API_TOKEN;
  var locationId = process.env.GHL_LOCATION_ID;
  var pipelineId = process.env.GHL_PIPELINE_ID;
  var pipelineStageId = process.env.GHL_PIPELINE_STAGE_ID;

  if (!token || !locationId || !pipelineId || !pipelineStageId) {
    return res.status(500).json({
      error: 'Falta GHL_API_TOKEN, GHL_LOCATION_ID, GHL_PIPELINE_ID o GHL_PIPELINE_STAGE_ID'
    });
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
  var nameParts = String(body.nombre || '').trim().split(/\s+/).filter(Boolean);
  var contact = {
    locationId: locationId,
    email: String(body.email).trim(),
    source: CONTACT_SOURCE,
    tags: CONTACT_TAGS
  };
  if (nameParts.length) contact.firstName = nameParts[0];
  if (nameParts.length > 1) contact.lastName = nameParts.slice(1).join(' ');
  if (body.telefono) contact.phone = String(body.telefono).replace(/[^\d+]/g, '');

  // 1) Contacto
  var contactId;
  try {
    var contactRes = await ghlPost('/contacts/upsert', contact);
    if (!contactRes.ok) {
      console.error('GHL rechazó el contacto (' + contactRes.status + '):', await contactRes.text());
      return res.status(502).json({ error: 'GHL rechazó el contacto', status: contactRes.status });
    }
    var contactData = await contactRes.json();
    contactId = contactData && contactData.contact && contactData.contact.id;
  } catch (err) {
    console.error('No se pudo contactar a GHL (contacto):', err);
    return res.status(502).json({ error: 'No se pudo contactar a GHL' });
  }

  if (!contactId) {
    console.error('GHL no devolvió el id del contacto');
    return res.status(502).json({ error: 'GHL no devolvió el id del contacto' });
  }

  // 2) Oportunidad en el pipeline (upsert: si el contacto ya tiene una en
  //    este pipeline la reutiliza en vez de duplicarla)
  try {
    var oppRes = await ghlPost('/opportunities/upsert', {
      locationId: locationId,
      pipelineId: pipelineId,
      pipelineStageId: pipelineStageId,
      contactId: contactId,
      name: contact.firstName
        ? contact.firstName + (contact.lastName ? ' ' + contact.lastName : '') + ' — Masterclass'
        : contact.email + ' — Masterclass',
      status: 'open',
      source: CONTACT_SOURCE
    });
    if (!oppRes.ok) {
      console.error('GHL rechazó la oportunidad (' + oppRes.status + '):', await oppRes.text());
      return res.status(502).json({ error: 'GHL rechazó la oportunidad', status: oppRes.status });
    }
  } catch (err) {
    console.error('No se pudo contactar a GHL (oportunidad):', err);
    return res.status(502).json({ error: 'No se pudo contactar a GHL' });
  }

  return res.status(200).json({ ok: true });
};
