// Little Light API Worker — Cloudflare KV Storage
const ALLOWED_ORIGINS = [
  'https://littlelightstorybooks.github.io',
  'https://littlelightstorybooks-bookofpsalms.netlify.app',
  'https://littlelightstorybooks.com',
  'https://www.littlelightstorybooks.com',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

const KV_KEY = 'bookofpsalms_state';

function getCors(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,X-App-Token,X-Bin-Versioning',
    'Vary': 'Origin',
  };
}

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const origin = request.headers.get('Origin') || '';
    const cors   = getCors(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    function requireToken() {
      const token = request.headers.get('X-App-Token');
      if (!token || token !== env.APP_TOKEN) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401,
          headers: { ...cors, 'Content-Type': 'application/json' },
        });
      }
      return null;
    }

    // ── /samples/public — read KV without token (public display data) ─
    if (path === '/samples/public') {
      const data = await env.KV.get(KV_KEY);
      if (!data) {
        return new Response(JSON.stringify({}), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      // Only return samplesPage data — nothing sensitive
      const parsed = JSON.parse(data);
      const pub = { samplesPage: parsed.samplesPage || {} };
      return new Response(JSON.stringify(pub), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // ── /db/get — read from KV ────────────────────────────────────
    if (path === '/db/get') {
      const deny = requireToken(); if (deny) return deny;
      const data = await env.KV.get(KV_KEY);
      if (!data) {
        const empty = JSON.stringify({boy:{},girl:{},activeGender:'boy',config:{},pageSettings:{},orders:[]});
        return new Response(empty, { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
      }
      return new Response(data, { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // ── /db/put — write to KV ─────────────────────────────────────
    if (path === '/db/put' && request.method === 'PUT') {
      const deny = requireToken(); if (deny) return deny;
      const body = await request.text();
      await env.KV.put(KV_KEY, body);
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    // ── /upload — Cloudinary image upload ────────────────────────
    if (path === '/upload' && request.method === 'POST') {
      const deny = requireToken(); if (deny) return deny;
      const formData = await request.formData();
      const file       = formData.get('file');
      const uploadType = formData.get('uploadType') || 'template';
      const FOLDERS = {
        'customer-photo':      'bookofpsalms_uploads/customers',
        'customer-screenshot': 'bookofpsalms_uploads/customers',
      };
      const isCustomer = uploadType === 'customer-photo' || uploadType === 'customer-screenshot';
      const preset  = isCustomer ? 'bookofpsalms_customer' : env.CL_PRESET;
      const folder  = FOLDERS[uploadType] || formData.get('folder') || 'bookofpsalms_uploads/templates';
      const fd = new FormData();
      fd.append('file', file);
      fd.append('upload_preset', preset);
      fd.append('folder', folder);
      const res = await fetch(`https://api.cloudinary.com/v1_1/${env.CL_CLOUD}/image/upload`, { method: 'POST', body: fd });
      const data = await res.text();
      return new Response(data, { status: res.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // ── /capi — Meta Conversions API ─────────────────────────────
    if (path === '/capi' && request.method === 'POST') {
      const deny = requireToken(); if (deny) return deny;
      const body = await request.json();
      const eventData = {
        data: [{
          event_name:  'Purchase',
          event_time:  Math.floor(Date.now() / 1000),
          event_id:    body.ref || ('ev_' + Date.now()),
          action_source: 'website',
          event_source_url: body.url || '',
          user_data: {
            client_ip_address: request.headers.get('CF-Connecting-IP') || '',
            client_user_agent: request.headers.get('User-Agent') || '',
            fbc: body.fbc || '',
            fbp: body.fbp || '',
          },
          custom_data: { currency: 'PHP', value: body.value || 0, order_id: body.ref || '' },
        }],
      };
      if (body.testCode) eventData.test_event_code = body.testCode;
      const res = await fetch(
        `https://graph.facebook.com/v19.0/${env.META_PIXEL_ID}/events?access_token=${env.META_ACCESS_TOKEN}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(eventData) }
      );
      const data = await res.text();
      return new Response(data, { status: res.status, headers: { ...cors, 'Content-Type': 'application/json' } });
    }

    // ── /config — public config ───────────────────────────────────
    if (path === '/config') {
      return new Response(JSON.stringify({ cl_cloud: env.CL_CLOUD }), {
        status: 200, headers: { ...cors, 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404, headers: cors });
  },
};
