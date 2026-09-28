// api/typeform.js
// Vercel Serverless Function — webhook del Typeform de agenda (nG2ETYi3, "Sesion de
// Admision - Winners Group"). Según el ending que vio la persona, crea o actualiza
// su oportunidad en el pipeline de GHL y la deja en la columna que corresponde.
//
// Configurar en Typeform → Connect → Webhooks con la URL:
//   https://clase.ahilenesteve.com/api/typeform?key=<TYPEFORM_WEBHOOK_KEY>
//
// Endings del form (ver "logic" del form en la API de Typeform):
//   agendo           FQfnMJyNRYA1  Calendly: "Ya reservaste tu Sesión 1-1" (presupuesto $1.000+)
//   whatsapp         o2kCLDVn13Ii  "Ya recibimos tu aplicación", sigue por WhatsApp (presupuesto $500 - $1000)
//   sin_presupuesto  ZdLw81kMFvCf  "Te vamos a contactar" (dijo que no tiene dinero para invertir)
//
// Variables de entorno (Vercel → Settings → Environment Variables):
//   TYPEFORM_WEBHOOK_KEY          Clave que va en ?key= de la URL del webhook (obligatoria)
//   GHL_API_TOKEN                 Token de la Private Integration de la subcuenta
//                                 (scopes: contacts.write, opportunities.write)
//   GHL_AGENDA_LOCATION_ID, GHL_AGENDA_PIPELINE_ID, GHL_AGENDA_STAGE_AGENDO,
//   GHL_AGENDA_STAGE_WHATSAPP, GHL_AGENDA_STAGE_SIN_PRESUPUESTO   (opcionales: pisan
//                                 los IDs por defecto de abajo)

var GHL_API = 'https://services.leadconnectorhq.com';
var CONTACT_SOURCE = 'Typeform agenda webinar';

// Location y pipeline de agenda en GHL, y la columna (stage) de cada ending. No son
// secretos: van como default y las envs GHL_AGENDA_* los pisan si hace falta.
var DEFAULT_LOCATION_ID = 'ZuV0ZXFQ6mCl6kpMUtos';
var DEFAULT_PIPELINE_ID = '99t8lQjZ9xdQFqc6wHNf';

var ENDINGS = {
  agendo: {
    id: 'FQfnMJyNRYA1', ref: '63ebb62b-4b91-4233-8bdc-d1178d8b356e',
    stageEnv: 'GHL_AGENDA_STAGE_AGENDO', defaultStage: '5aec1a4f-e3f1-4ae9-919f-b707ee31e643'
  },
  whatsapp: {
    id: 'o2kCLDVn13Ii', ref: 'b334e45b-e6f0-4698-92ac-09048e4dad22',
    stageEnv: 'GHL_AGENDA_STAGE_WHATSAPP', defaultStage: '61f051c5-5c4f-4036-b6ab-ddcead16f2bf'
  },
  sin_presupuesto: {
    id: 'ZdLw81kMFvCf', ref: '1dd4fa40-1abe-4c58-86f2-535bb52cd785',
    stageEnv: 'GHL_AGENDA_STAGE_SIN_PRESUPUESTO', defaultStage: '9e1392d0-5002-40db-9519-9cbc2425f86d'
  }
};

// Pregunta de presupuesto ("Si en la llamada te queda claro cómo llevar tu negocio a...").
// Sirve de respaldo para deducir el ending si el payload no lo trae.
var BUDGET_FIELD_ID = 'mkZq5cLW3D0r';
var BUDGET_CHOICE_NONE = 'HnB7etwtR3go';   // No tengo dinero para invertir
var BUDGET_CHOICE_LOW = 'e7RBiuvOtM62';    // $500 - $1000 usd
var NAME_FIELD_ID = 'kZinowNMYcNa';

// Pregunta del Typeform (field id) → custom field de la oportunidad en GHL (id).
// Cada uno guarda el texto de la opción elegida. Los ids salen de
// GET /locations/{locationId}/customFields?model=opportunity.
var ANSWER_FIELDS = {
  tHd0z1wBiLnG: '8T2W57lbcxH9NPNHtura', // situacion_actual
  '1ZQIrgTqJAhM': 'isyFueTyyECCi6R99XR1', // ocupacion
  Hb5eJ3cwe49k: 'udfA9zSmvrrfCqOrTyzD', // facturacion_mensual
  PHbJrjYPxLeZ: 'IqlDZdIka7peKR8n4OaO', // mayor_problema
  YH8vsqPYVqKy: 'TkN4gxzfsmgvsy8c8RVs', // intentos_previos
  iJ2n18bqcv1L: 'WpVrMcL08Hc1q6IXXny5', // decision_inversion
  Pju5YRDvEFVj: 'Ppxe1l0lrW5s9AwWPU9m', // edad
  mkZq5cLW3D0r: '7aWvdB2lYiKpvyzTjWr0', // presupuesto
  e3hxbcp5Hnzb: 'hq48A1mD6UWt3twB4g48' // plazo_presupuesto
};

// Prioridad de los que no tienen presupuesto: la pregunta "¿en cuántos días podés
// conseguirlo?" (solo la ven ellos). Se guarda como valor de la oportunidad, así el
// tablero de GHL los ordena con "Lead value" de mayor a menor. Cuanto antes, más alto.
var PLAZO_FIELD_ID = 'e3hxbcp5Hnzb';
var PLAZO_PRIORIDAD = {
  raYG7rloSlob: 4, // 1-3 Dias
  '2gOdBlY3uBJB': 3, // 3-7 Dias
  FqdDnWrlcdHv: 2, // 7-14 Dias
  AAooHhbAsPvG: 1 // +14 Dias
};

// Devuelve la clave de ENDINGS a la que llegó la persona, o null si no terminó el form.
function detectEnding(fr) {
  var e = fr.ending;
  if (e && (e.id || e.ref)) {
    var keys = Object.keys(ENDINGS);
    for (var i = 0; i < keys.length; i++) {
      if (ENDINGS[keys[i]].id === e.id || ENDINGS[keys[i]].ref === e.ref) return keys[i];
    }
    return null; // ending que no está mapeado (ej. el de Typeform por defecto)
  }
  // Sin "ending" en el payload: se deduce de la respuesta de presupuesto.
  var budget = (fr.answers || []).filter(function (a) { return a.field && a.field.id === BUDGET_FIELD_ID; })[0];
  if (!budget || !budget.choice) return null;
  if (budget.choice.id === BUDGET_CHOICE_NONE) return 'sin_presupuesto';
  if (budget.choice.id === BUDGET_CHOICE_LOW) return 'whatsapp';
  return 'agendo';
}

function parseResponse(fr) {
  var out = { name: '', email: '', phone: '', prioridad: 0, customFields: [], hidden: fr.hidden || {} };
  (fr.answers || []).forEach(function (a) {
    var f = a.field || {};
    if (a.type === 'email' || f.type === 'email') out.email = String(a.email || '').trim().toLowerCase();
    else if (a.type === 'phone_number' || f.type === 'phone_number') out.phone = String(a.phone_number || '').trim();
    else if (f.id === NAME_FIELD_ID) out.name = String(a.text || '').trim();
    else if (f.id === PLAZO_FIELD_ID && a.choice) out.prioridad = PLAZO_PRIORIDAD[a.choice.id] || 0;

    // Además del if/else de arriba: el plazo y el presupuesto también van a su campo.
    var ghlFieldId = ANSWER_FIELDS[f.id];
    var text = a.choice && (a.choice.label || a.choice.other);
    if (ghlFieldId && text) out.customFields.push({ id: ghlFieldId, field_value: String(text).trim() });
  });
  return out;
}

async function syncToGhl(app, endingKey) {
  var token = process.env.GHL_API_TOKEN;
  var locationId = process.env.GHL_AGENDA_LOCATION_ID || DEFAULT_LOCATION_ID;
  var pipelineId = process.env.GHL_AGENDA_PIPELINE_ID || DEFAULT_PIPELINE_ID;
  var stageId = process.env[ENDINGS[endingKey].stageEnv] || ENDINGS[endingKey].defaultStage;

  if (!token || !locationId || !pipelineId || !stageId) {
    throw new Error('falta la env GHL_API_TOKEN');
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

  var nameParts = app.name.split(/\s+/).filter(Boolean);
  var contact = {
    locationId: locationId,
    email: app.email,
    source: CONTACT_SOURCE,
    tags: ['typeform-agenda', 'agenda-' + endingKey.replace(/_/g, '-')]
  };
  if (nameParts.length) contact.firstName = nameParts[0];
  if (nameParts.length > 1) contact.lastName = nameParts.slice(1).join(' ');
  if (app.phone) contact.phone = app.phone.replace(/[^\d+]/g, '');

  var contactRes = await ghlPost('/contacts/upsert', contact);
  if (!contactRes.ok) {
    throw new Error('contacto ' + contactRes.status + ' ' + (await contactRes.text()).slice(0, 300));
  }
  var contactData = await contactRes.json();
  var contactId = contactData && contactData.contact && contactData.contact.id;
  if (!contactId) throw new Error('GHL no devolvió el id del contacto');

  // Upsert: si el contacto ya tiene una oportunidad en este pipeline la reutiliza y
  // la mueve a la columna del ending, en vez de duplicarla.
  var oppRes = await ghlPost('/opportunities/upsert', {
    locationId: locationId,
    pipelineId: pipelineId,
    pipelineStageId: stageId,
    contactId: contactId,
    name: (nameParts.join(' ') || app.email) + ' — Admisión',
    status: 'open',
    // Solo el ending sin presupuesto lleva prioridad; en los otros se pisa con 0 para
    // no arrastrar el puntaje si la persona ya tenía una oportunidad de antes.
    monetaryValue: endingKey === 'sin_presupuesto' ? app.prioridad : 0,
    customFields: app.customFields,
    source: CONTACT_SOURCE
  });
  if (!oppRes.ok) {
    throw new Error('oportunidad ' + oppRes.status + ' ' + (await oppRes.text()).slice(0, 300));
  }
  var oppData = await oppRes.json().catch(function () { return null; });
  return {
    contactId: contactId,
    opportunityId: (oppData && oppData.opportunity && oppData.opportunity.id) || null
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  var key = process.env.TYPEFORM_WEBHOOK_KEY;
  if (!key) return res.status(500).json({ error: 'config' });
  if (!req.query || req.query.key !== key) return res.status(401).json({ error: 'bad_key' });

  var body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (err) { body = {}; }
  }
  body = body || {};
  if (body.event_type && body.event_type !== 'form_response') {
    return res.status(200).json({ ok: true, ignored: body.event_type });
  }

  var fr = body.form_response;
  if (!fr) return res.status(400).json({ error: 'invalid_payload' });

  var app = parseResponse(fr);
  if (!app.email) return res.status(200).json({ ok: true, ignored: 'sin_email' });

  var endingKey = detectEnding(fr);
  if (!endingKey) return res.status(200).json({ ok: true, ignored: 'sin_ending' });

  // Si GHL falla devolvemos 500 para que Typeform reintente el webhook.
  try {
    var ghl = await syncToGhl(app, endingKey);
    return res.status(200).json({ ok: true, ending: endingKey, contactId: ghl.contactId, opportunityId: ghl.opportunityId });
  } catch (err) {
    console.error('GHL typeform (' + endingKey + '):', err.message);
    return res.status(500).json({ error: 'ghl_failed', ending: endingKey });
  }
};
