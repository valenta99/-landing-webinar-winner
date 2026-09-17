// api/register.js
// Vercel Serverless Function — recibe el submit del formulario de registro
// (landing-registro.html) y lo reenvía al webhook de GoHighLevel.
// Sin dependencias externas: usa el runtime de Node de Vercel tal cual.

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

  var webhookUrl = process.env.GHL_WEBHOOK_URL;

  if (!webhookUrl) {
    return res.status(500).json({ error: 'Falta GHL_WEBHOOK_URL' });
  }

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    return res.status(502).json({ error: 'No se pudo contactar al webhook de GHL' });
  }

  return res.status(200).json({ ok: true });
};
