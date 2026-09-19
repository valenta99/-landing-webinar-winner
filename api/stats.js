// Métricas de la landing para el panel /admin, con rango (today / 7d / 30d / total).
// Protegido con la clave del panel (env DASH_KEY, ver lib/auth.js).
// Junta visitas (mc_hits) + registros (mc_leads).
var db = require('../lib/supabase');
var auth = require('../lib/auth');

var ART_OFFSET_MS = -3 * 60 * 60 * 1000; // hora Argentina

function startOfTodayARTms(now) {
  var art = new Date(now.getTime() + ART_OFFSET_MS);
  var dayUTC = Date.UTC(art.getUTCFullYear(), art.getUTCMonth(), art.getUTCDate());
  return dayUTC - ART_OFFSET_MS; // ms UTC correspondientes a la medianoche ARG
}
function dayLabel(ms) {
  var art = new Date(ms + ART_OFFSET_MS);
  return String(art.getUTCDate()).padStart(2, '0') + '/' + String(art.getUTCMonth() + 1).padStart(2, '0');
}
function hourLabel(ms) {
  var art = new Date(ms + ART_OFFSET_MS);
  return String(art.getUTCHours()).padStart(2, '0') + 'h';
}
function count(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

module.exports = async function handler(req, res) {
  if (!auth.isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

  var now = new Date();
  var range = ['7d', '30d', 'total'].indexOf(req.query.range) !== -1 ? req.query.range : 'today';
  var todayStart = startOfTodayARTms(now);
  var days = range === '7d' ? 7 : range === '30d' ? 30 : 1;
  var startMs = range === 'total' ? 0 : todayStart - (days - 1) * 86400000;
  var startISO = new Date(startMs).toISOString();

  var results = await Promise.all([
    db.fetchAll('/rest/v1/mc_leads?select=created_at,name,email,tracking,ghl_status&order=created_at.desc'),
    db.fetchAll('/rest/v1/mc_hits?select=created_at,vid,path&created_at=gte.' + encodeURIComponent(startISO) + '&order=created_at.desc')
  ]);
  var leads = results[0];
  var hits = results[1];

  if (leads === null) {
    return res.status(500).json({ error: 'No se pudo leer mc_leads (revisá las envs de Supabase y que corriste supabase/schema.sql). Detalle: ' + db.lastError() });
  }

  // Dedup por email: un registro = una persona. Nos quedamos con el PRIMERO
  // (created_at más antiguo) de cada email.
  var byEmail = new Map();
  var noEmail = [];
  leads.forEach(function (l) {
    var em = (l.email || '').trim().toLowerCase();
    if (!em) { noEmail.push(l); return; }
    var prev = byEmail.get(em);
    if (!prev || l.created_at < prev.created_at) byEmail.set(em, l);
  });
  var leadsUniq = Array.from(byEmail.values()).concat(noEmail)
    .sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; });
  var inRange = leadsUniq.filter(function (l) { return l.created_at >= startISO; });

  var sources = {}, campaigns = {};
  inRange.forEach(function (l) {
    var t = l.tracking || {};
    count(sources, t.utm_source || '(directo / sin utm)');
    if (t.utm_campaign) count(campaigns, t.utm_campaign);
  });

  // Visitas: la landing manda path "/", la de gracias "/gracias".
  var hitsInRange = null, uniquesInRange = null, landingUniques = null, graciasUniques = null;
  if (hits) {
    var uniq = function (arr) {
      return new Set(arr.map(function (h) { return h.vid; }).filter(Boolean)).size;
    };
    hitsInRange = hits.length;
    uniquesInRange = uniq(hits);
    landingUniques = uniq(hits.filter(function (h) { return h.path === '/' || h.path === '/index.html'; }));
    graciasUniques = uniq(hits.filter(function (h) { return h.path === '/gracias'; }));
  }

  // Serie temporal: por hora si es hoy, por día si es 7d/30d (registros + visitas por bucket)
  var mode = range === 'today' ? 'hour' : 'day';
  var buckets = {}, visitBuckets = {};
  var bucketOf = function (iso) {
    var ms = new Date(iso).getTime();
    return mode === 'hour' ? hourLabel(ms) : dayLabel(ms);
  };
  inRange.forEach(function (l) { count(buckets, bucketOf(l.created_at)); });
  (hits || []).forEach(function (h) { count(visitBuckets, bucketOf(h.created_at)); });

  var series = [];
  if (mode === 'hour') {
    var nowArtH = new Date(now.getTime() + ART_OFFSET_MS).getUTCHours();
    for (var h = 0; h <= nowArtH; h++) {
      var hl = String(h).padStart(2, '0') + 'h';
      series.push({ label: hl, value: buckets[hl] || 0, visits: hits ? (visitBuckets[hl] || 0) : null });
    }
  } else if (range !== 'total') {
    for (var i = 0; i < days; i++) {
      var dl = dayLabel(startMs + i * 86400000);
      series.push({ label: dl, value: buckets[dl] || 0, visits: hits ? (visitBuckets[dl] || 0) : null });
    }
  }

  var ghlErrors = leads.filter(function (l) { return (l.ghl_status || '').indexOf('error') === 0; }).length;

  var recent = leadsUniq.slice(0, 10).map(function (l) {
    var t = l.tracking || {};
    return { at: l.created_at, name: l.name, email: l.email, source: t.utm_source || null };
  });

  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).json({
    generatedAt: now.toISOString(),
    range: range,
    leadsTotal: leadsUniq.length,
    leadsInRange: inRange.length,
    dupesRemoved: leads.length - leadsUniq.length,
    ghlErrors: ghlErrors,
    hitsInRange: hitsInRange,
    uniquesInRange: uniquesInRange,
    landingUniques: landingUniques,
    graciasUniques: graciasUniques,
    conversionInRange:
      landingUniques && inRange.length <= landingUniques
        ? Math.round((inRange.length / landingUniques) * 1000) / 10
        : null,
    sources: sources,
    campaigns: campaigns,
    series: series,
    seriesMode: mode,
    recent: recent
  });
};
