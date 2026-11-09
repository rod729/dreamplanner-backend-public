// DreamPlanner -> HighLevel relay.
//
// 1. Receives the lead + generated PDF (data URI) from the DreamPlanner page.
// 2. Uploads the PDF to the HighLevel Media Library (needs the Private Integration token,
//    which is why this can't run in the browser) and gets back a public URL.
// 3. POSTs the lead + that PDF URL to a HighLevel Inbound Webhook, which creates/updates the
//    contact and starts the Workflow that emails the design.
//
// Env vars (Netlify > Site configuration > Environment variables):
//   GHL_PRIVATE_TOKEN         Private Integration token (scope: medias.write)
//   GHL_INBOUND_WEBHOOK_URL   URL from the Workflow's "Inbound Webhook" trigger
//   GHL_LOCATION_ID           (optional) sub-account ID, passed through to the webhook
//   ALLOWED_ORIGINS           (optional) comma-separated origins allowed to call this, e.g.
//                             https://yourfunnel.com,https://go.yourdomain.com  (default: *)

const GHL_BASE = 'https://services.leadconnectorhq.com';
const MAX_PDF_BYTES = 20 * 1024 * 1024; // HighLevel media limit is 25 MB

function corsHeaders(event) {
  const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
  const origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  let allowOrigin = '*';
  if (!allowed.includes('*')) {
    allowOrigin = allowed.includes(origin) ? origin : allowed[0];
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin'
  };
}

function respond(event, statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(event) },
    body: JSON.stringify(body)
  };
}

// jsPDF's datauristring looks like "data:application/pdf;filename=generated.pdf;base64,JVBERi0..."
function dataUriToBuffer(dataUri) {
  const marker = 'base64,';
  const idx = dataUri.indexOf(marker);
  const b64 = idx === -1 ? dataUri : dataUri.slice(idx + marker.length);
  return Buffer.from(b64, 'base64');
}

function safeFileName(name) {
  const cleaned = String(name || 'DreamPlanner Design.pdf').replace(/[^\w .()-]+/g, '').trim() || 'DreamPlanner Design.pdf';
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned}.pdf`;
}

async function uploadPdfToHighLevel(buffer, fileName) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), fileName);
  form.append('name', fileName);

  const res = await fetch(`${GHL_BASE}/medias/upload-file`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GHL_PRIVATE_TOKEN}`,
      Version: '2023-02-21'
    },
    body: form,
    signal: AbortSignal.timeout(20000)
  });

  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch (_) { /* leave empty */ }

  if (!res.ok || !json.url) {
    throw new Error(`HighLevel media upload failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return { url: json.url, fileId: json.fileId };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(event), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return respond(event, 405, { success: false, error: 'Method not allowed' });
  }

  if (!process.env.GHL_INBOUND_WEBHOOK_URL) {
    console.error('GHL_INBOUND_WEBHOOK_URL is not set');
    return respond(event, 500, { success: false, error: 'Server is not configured' });
  }

  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch (_) {
    return respond(event, 400, { success: false, error: 'Invalid JSON' });
  }

  const name = String(data.name || '').trim();
  const email = String(data.email || '').trim();
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return respond(event, 400, { success: false, error: 'Name and a valid email are required' });
  }

  const [firstName, ...rest] = name.split(/\s+/);
  const fileName = safeFileName(data.fileName);

  // Upload the PDF. If this fails we still forward the lead so it is never lost;
  // the workflow can branch on an empty design_pdf_url.
  let pdfUrl = '';
  let pdfStatus = 'none';
  let warning;
  if (data.file && typeof data.file === 'string') {
    try {
      if (!process.env.GHL_PRIVATE_TOKEN) throw new Error('GHL_PRIVATE_TOKEN is not set');
      const buffer = dataUriToBuffer(data.file);
      if (buffer.length < 100 || buffer.slice(0, 4).toString() !== '%PDF') throw new Error('Payload is not a PDF');
      if (buffer.length > MAX_PDF_BYTES) throw new Error('PDF too large');
      const uploaded = await uploadPdfToHighLevel(buffer, fileName);
      pdfUrl = uploaded.url;
      pdfStatus = 'uploaded';
    } catch (err) {
      console.error('PDF upload failed:', err.message);
      pdfStatus = 'failed';
      warning = 'Design PDF could not be attached';
    }
  }

  const webhookPayload = {
    source: 'DreamPlanner',
    first_name: firstName,
    last_name: rest.join(' '),
    name,
    email,
    phone: String(data.phone || '').trim(),
    timeline: String(data.timeline || ''),
    design_pdf_url: pdfUrl,
    design_pdf_status: pdfStatus,
    design_file_name: fileName,
    submitted_at: data.submitted_at || new Date().toISOString(),
    contact_id: data.contact_id || '',
    location_id: data.location_id || process.env.GHL_LOCATION_ID || ''
  };

  try {
    const res = await fetch(process.env.GHL_INBOUND_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(webhookPayload),
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Webhook responded ${res.status}: ${text.slice(0, 300)}`);
    }
  } catch (err) {
    console.error('HighLevel webhook failed:', err.message);
    return respond(event, 502, { success: false, error: 'Could not deliver to HighLevel' });
  }

  return respond(event, 200, { success: true, pdf: pdfStatus, ...(warning ? { warning } : {}) });
};
