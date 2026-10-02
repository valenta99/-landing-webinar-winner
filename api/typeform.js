// api/typeform.js
// Vercel Serverless Function — webhook del Typeform de agenda (nG2ETYi3, "Sesion de
// Admision - Winners Group"). Según el ending que vio la persona, crea o actualiza
// su oportunidad en el pipeline de GHL y la deja en la columna que corresponde.
//
// Configurar en Typeform → Connect → Webhooks con la URL:
//   https://clase.ahilenesteve.com/api/typeform?key=<TYPEFORM_WEBHOOK_KEY>
//
// Forms: ver FORMS (agenda nG2ETYi3 y post webinar u19ta3Lb).
// Endings del form (ver "logic" del form en la API de Typeform):
//   agendo           FQfnMJyNRYA1  Calendly: "Ya reservaste tu Sesión 1-1" (presupuesto $1.000+)
//   whatsapp         o2kCLDVn13Ii  "Ya recibimos tu aplicación", sigue por WhatsApp (presupuesto $500 - $1000)
//   sin_presupuesto  ZdLw81kMFvCf  "Te vamos a contactar" (dijo que no tiene dinero para invertir)
//
// Variables de entorno (Vercel → Settings → Environment Variables):
//   TYPEFORM_WEBHOOK_KEY          Clave que va en ?key= de la URL del webhook (obligatoria)
//   GHL_API_TOKEN                 Token de la Private Integration de la subcuenta
//                                 (scopes: contacts.write, opportunities.write,
//                                 calendars/events.write, calendars.readonly)
//   CALENDLY_TOKEN                Personal Access Token de Calendly (opcional): sin él, el
//                                 nombre de la oportunidad no lleva el host de la agenda
//   GHL_AGENDA_LOCATION_ID, GHL_AGENDA_PIPELINE_ID, GHL_AGENDA_STAGE_AGENDO,
//   GHL_AGENDA_STAGE_WHATSAPP, GHL_AGENDA_STAGE_SIN_PRESUPUESTO   (opcionales: pisan
//                                 los IDs por defecto de abajo)

var GHL_API = 'https://services.leadconnectorhq.com';
var CONTACT_SOURCE = 'Typeform agenda webinar';

// Location y pipeline de agenda en GHL, y la columna (stage) de cada ending. No son
// secretos: van como default y las envs GHL_AGENDA_* los pisan si hace falta.
var DEFAULT_LOCATION_ID = 'ZuV0ZXFQ6mCl6kpMUtos';
var DEFAULT_PIPELINE_ID = '99t8lQjZ9xdQFqc6wHNf';
// Calendario "Sesión de admisión (Calendly)": solo contenedor de citas del ending agendó.
var DEFAULT_CALENDAR_ID = 'pNLTdb7VGfqXKrURgCIq';
// GHL exige un usuario en la cita: el team member del calendario contenedor.
var DEFAULT_CALENDAR_USER_ID = 'j2aAYpJ5iGpSpRoXHWsB';

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

// Forms que atiende el webhook, por form_id. "agenda" es el original; "postwebinar"
// (Replay Webinar) es un clon con los mismos 3 endings (mismos ref) pero otros ids de
// pregunta. Si un form tiene stageName, TODOS sus endings caen en esa columna del pipeline
// (se busca por nombre con la API de GHL) y el ending queda como tag del contacto.
var FORMS = {
  nG2ETYi3: {
    key: 'agenda', source: CONTACT_SOURCE, nameName: 'Admisión',
    fields: { name: NAME_FIELD_ID, budget: BUDGET_FIELD_ID, plazo: PLAZO_FIELD_ID },
    answerFields: ANSWER_FIELDS, plazoPrioridad: PLAZO_PRIORIDAD
  },
  u19ta3Lb: {
    key: 'postwebinar', source: 'Typeform post webinar', nameName: 'Post Webinar',
    stageName: 'Typeform Post Webinar',
    fields: { name: 'qukEkGPznK4d', budget: 'QbZAcPANvMii', plazo: 'Y5d7eD3aQ0Yd' },
    // mismas 9 preguntas, mismo orden → mismos custom fields de GHL
    answerFields: {
      AL5cYtwNv2EX: '8T2W57lbcxH9NPNHtura', '58JfIZmLCh3y': 'isyFueTyyECCi6R99XR1',
      Iz8zd0fI1oru: 'udfA9zSmvrrfCqOrTyzD', U3ybjwbQ0YpH: 'IqlDZdIka7peKR8n4OaO',
      Bsyg37KtkZ5w: 'TkN4gxzfsmgvsy8c8RVs', lWwRkepfxgMP: 'WpVrMcL08Hc1q6IXXny5',
      AdARJWFCnr6j: 'Ppxe1l0lrW5s9AwWPU9m', QbZAcPANvMii: '7aWvdB2lYiKpvyzTjWr0',
      Y5d7eD3aQ0Yd: 'hq48A1mD6UWt3twB4g48'
    },
    budgetNone: '3obIuiYCPbU2', budgetLow: 'emwSTdYy2uQj',
    plazoPrioridad: { '7ZmXpdAHAOC1': 4, US5ud39A0J3o: 3, jI1otBJSX0Us: 2, uw60XWuQjwsB: 1 }
  }
};

// Devuelve la clave de ENDINGS a la que llegó la persona, o null si no terminó el form.
function detectEnding(fr, form) {
  var e = fr.ending;
  if (e && (e.id || e.ref)) {
    var keys = Object.keys(ENDINGS);
    for (var i = 0; i < keys.length; i++) {
      if (ENDINGS[keys[i]].id === e.id || ENDINGS[keys[i]].ref === e.ref) return keys[i];
    }
    return null; // ending que no está mapeado (ej. el de Typeform por defecto)
  }
  // Sin "ending" en el payload: se deduce de la respuesta de presupuesto.
  var budget = (fr.answers || []).filter(function (a) { return a.field && a.field.id === form.fields.budget; })[0];
  if (!budget || !budget.choice) return null;
  if (budget.choice.id === (form.budgetNone || BUDGET_CHOICE_NONE)) return 'sin_presupuesto';
  if (budget.choice.id === (form.budgetLow || BUDGET_CHOICE_LOW)) return 'whatsapp';
  return 'agendo';
}

function parseResponse(fr, form) {
  var out = { name: '', email: '', phone: '', prioridad: 0, customFields: [], calendlyEventUuid: '', calendlyInviteeUuid: '', hidden: fr.hidden || {} };
  (fr.answers || []).forEach(function (a) {
    var f = a.field || {};
    if (a.type === 'email' || f.type === 'email') out.email = String(a.email || '').trim().toLowerCase();
    else if (a.type === 'phone_number' || f.type === 'phone_number') out.phone = String(a.phone_number || '').trim();
    else if (f.id === form.fields.name) out.name = String(a.text || '').trim();
    else if (f.id === form.fields.plazo && a.choice) out.prioridad = form.plazoPrioridad[a.choice.id] || 0;

    // La respuesta del bloque Calendly trae el link del evento; no dependemos de la forma
    // exacta del payload, buscamos el uuid en cualquier parte de la respuesta.
    // Con links de equipo (calendly.com/d/…/invitees/<uuid>) solo viene el uuid del invitado.
    if (f.type === 'calendly' || a.type === 'calendly') {
      var raw = JSON.stringify(a);
      var mEv = /scheduled_events\/([0-9a-f-]{36})/i.exec(raw);
      var mInv = /invitees\/([0-9a-f-]{36})/i.exec(raw);
      if (mEv) out.calendlyEventUuid = mEv[1];
      if (mInv) out.calendlyInviteeUuid = mInv[1];
    }

    // Además del if/else de arriba: el plazo y el presupuesto también van a su campo.
    var ghlFieldId = form.answerFields[f.id];
    var text = a.choice && (a.choice.label || a.choice.other);
    if (ghlFieldId && text) out.customFields.push({ id: ghlFieldId, field_value: String(text).trim() });
  });
  return out;
}

// Nombre de quien atiende el evento de Calendly (round robin: el host lo asigna Calendly
// al agendar). Necesita CALENDLY_TOKEN (Personal Access Token). Si falta o Calendly falla,
// devuelve '' y la oportunidad se crea igual, sin host en el nombre.
async function getCalendlyHost(app) {
  var token = process.env.CALENDLY_TOKEN;
  if (!token) return { host: '', note: 'sin CALENDLY_TOKEN en Vercel' };
  if (!app.calendlyEventUuid && !app.calendlyInviteeUuid) return { host: '', note: 'no vino el link de Calendly en la respuesta' };

  async function cget(path) {
    var r = await fetch(path.indexOf('http') === 0 ? path : 'https://api.calendly.com' + path, {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!r.ok) throw new Error(path.split('?')[0] + ' ' + r.status + ' ' + (await r.text()).slice(0, 200));
    return r.json();
  }

  try {
    var picked = null;
    if (app.calendlyEventUuid) {
      picked = (await cget('/scheduled_events/' + app.calendlyEventUuid)).resource;
    } else {
      // Link de equipo: solo tenemos el uuid del invitado. Se listan los eventos activos de
      // ese email en la organización y se confirma cuál es por el uuid del invitado.
      var org = (await cget('/users/me')).resource.current_organization;
      var events = (await cget('/scheduled_events?organization=' + encodeURIComponent(org) +
        '&invitee_email=' + encodeURIComponent(app.email) + '&status=active&count=10')).collection || [];
      if (events.length === 1) {
        picked = events[0];
      } else {
        for (var i = 0; i < events.length && i < 5 && !picked; i++) {
          var inv = (await cget(events[i].uri + '/invitees?count=100')).collection || [];
          var hit = inv.some(function (x) { return String(x.uri).indexOf(app.calendlyInviteeUuid) !== -1; });
          if (hit) picked = events[i];
        }
      }
      if (!picked) return { host: '', note: 'no encontré el evento en Calendly (' + events.length + ' eventos activos con ese email)' };
    }
    var members = picked.event_memberships || [];
    var host = members.map(function (mb) { return mb.user_name || mb.user_email; }).filter(Boolean).join(', ');
    return { host: host, note: host ? 'ok' : 'el evento no trae host', start: picked.start_time || '', end: picked.end_time || '' };
  } catch (err) {
    console.error('Calendly host:', err.message);
    return { host: '', note: 'error: ' + err.message.slice(0, 200) };
  }
}

// Id de la columna por nombre dentro del pipeline (GET /opportunities/pipelines).
async function findStageByName(token, locationId, pipelineId, name) {
  var r = await fetch(GHL_API + '/opportunities/pipelines?locationId=' + locationId, {
    headers: { Authorization: 'Bearer ' + token, Version: '2021-07-28', Accept: 'application/json' }
  });
  if (!r.ok) throw new Error('pipelines ' + r.status + ' ' + (await r.text()).slice(0, 200));
  var pls = (await r.json()).pipelines || [];
  var pl = pls.filter(function (p) { return p.id === pipelineId; })[0];
  var st = pl && (pl.stages || []).filter(function (x) { return String(x.name).trim().toLowerCase() === name.toLowerCase(); })[0];
  if (!st) throw new Error('no existe la columna "' + name + '" en el pipeline');
  return st.id;
}

async function syncToGhl(app, endingKey, form) {
  var token = process.env.GHL_API_TOKEN;
  var locationId = process.env.GHL_AGENDA_LOCATION_ID || DEFAULT_LOCATION_ID;
  var pipelineId = process.env.GHL_AGENDA_PIPELINE_ID || DEFAULT_PIPELINE_ID;
  if (!token) throw new Error('falta la env GHL_API_TOKEN');
  var stageId = form.stageName
    ? await findStageByName(token, locationId, pipelineId, form.stageName)
    : (process.env[ENDINGS[endingKey].stageEnv] || ENDINGS[endingKey].defaultStage);

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
    source: form.source,
    tags: ['typeform-' + form.key, form.key + '-' + endingKey.replace(/_/g, '-')]
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

  var hostInfo = endingKey === 'agendo' ? await getCalendlyHost(app) : { host: '', note: 'no aplica' };
  var host = hostInfo.host;

  // Fecha y hora de la llamada (hora de Argentina) para el nombre de la oportunidad.
  var whenLabel = '';
  if (hostInfo.start) {
    var d = new Date(hostInfo.start);
    var p = {};
    new Intl.DateTimeFormat('es-AR', {
      timeZone: 'America/Argentina/Buenos_Aires', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false
    }).formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
    whenLabel = p.day + '/' + p.month + ' ' + p.hour + ':' + p.minute;
  }

  // Upsert: si el contacto ya tiene una oportunidad en este pipeline la reutiliza y
  // la mueve a la columna del ending, en vez de duplicarla.
  var oppRes = await ghlPost('/opportunities/upsert', {
    locationId: locationId,
    pipelineId: pipelineId,
    pipelineStageId: stageId,
    contactId: contactId,
    name: (nameParts.join(' ') || app.email) + ' — ' + form.nameName + (host ? ' — ' + host : '') + (whenLabel ? ' — ' + whenLabel : ''),
    status: 'open',
    // Solo el ending sin presupuesto lleva prioridad; en los otros se pisa con 0 para
    // no arrastrar el puntaje si la persona ya tenía una oportunidad de antes.
    monetaryValue: endingKey === 'sin_presupuesto' ? app.prioridad : 0,
    customFields: app.customFields,
    source: form.source
  });
  if (!oppRes.ok) {
    throw new Error('oportunidad ' + oppRes.status + ' ' + (await oppRes.text()).slice(0, 300));
  }
  var oppData = await oppRes.json().catch(function () { return null; });

  // Cita en el calendario de GHL con el horario del evento de Calendly. No corta el flujo
  // si falla (la oportunidad ya está creada); el resultado queda en debug.
  var citaNote = 'no aplica';
  if (endingKey === 'agendo') {
    if (!hostInfo.start || !hostInfo.end) {
      citaNote = 'sin horario de Calendly';
    } else {
      try {
        var calRes = await ghlPost('/calendars/events/appointments', {
          calendarId: process.env.GHL_AGENDA_CALENDAR_ID || DEFAULT_CALENDAR_ID,
          assignedUserId: process.env.GHL_AGENDA_CALENDAR_USER_ID || DEFAULT_CALENDAR_USER_ID,
          locationId: locationId,
          contactId: contactId,
          startTime: hostInfo.start,
          endTime: hostInfo.end,
          title: 'Sesión de admisión — ' + (nameParts.join(' ') || app.email) + (host ? ' — ' + host : ''),
          appointmentStatus: 'confirmed',
          ignoreFreeSlotValidation: true,
          toNotify: false
        });
        citaNote = calRes.ok ? 'ok' : 'error ' + calRes.status + ' ' + (await calRes.text()).slice(0, 200);
        if (!calRes.ok) console.error('GHL cita:', citaNote);
      } catch (err) {
        citaNote = 'error: ' + err.message.slice(0, 200);
        console.error('GHL cita:', err.message);
      }
    }
  }

  return {
    contactId: contactId,
    opportunityId: (oppData && oppData.opportunity && oppData.opportunity.id) || null,
    // Diagnóstico: se ve en Typeform → Webhooks → View deliveries (la respuesta solo la lee Typeform).
    debug: {
      calendlyHost: hostInfo.note,
      citaCalendar: citaNote,
      customFieldsEnviados: app.customFields.length,
      customFieldsGuardados: (oppData && oppData.opportunity && oppData.opportunity.customFields || []).length,
      oportunidadNueva: oppData && oppData.new,
      nombre: oppData && oppData.opportunity && oppData.opportunity.name
    }
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

  var form = FORMS[fr.form_id];
  if (!form) return res.status(200).json({ ok: true, ignored: 'form_desconocido' });

  var app = parseResponse(fr, form);
  if (!app.email) return res.status(200).json({ ok: true, ignored: 'sin_email' });

  var endingKey = detectEnding(fr, form);
  if (!endingKey) return res.status(200).json({ ok: true, ignored: 'sin_ending' });

  // Si GHL falla devolvemos 500 para que Typeform reintente el webhook.
  try {
    var ghl = await syncToGhl(app, endingKey, form);
    return res.status(200).json({ ok: true, ending: endingKey, contactId: ghl.contactId, opportunityId: ghl.opportunityId, debug: ghl.debug });
  } catch (err) {
    console.error('GHL typeform (' + endingKey + '):', err.message);
    return res.status(500).json({ error: 'ghl_failed', ending: endingKey });
  }
};
