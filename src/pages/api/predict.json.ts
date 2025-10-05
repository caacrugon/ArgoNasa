import type { APIRoute } from 'astro';
export const prerender = false;

const FEATURE_ORDER = [
  'orbital_period_days','transit_duration_hrs','transit_depth_pct',
  'stellar_temp_k','stellar_radius_solar','flux_variability','signal_to_noise',
];

function parseCsv(text: string) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [] as any[];
  const headers = lines[0].split(',').map((h) => h.trim());
  const rows: Record<string, any>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const obj: Record<string, any> = {};
    headers.forEach((h, idx) => {
      const v = (cols[idx] ?? '').trim();
      const n = Number(v);
      obj[h] = Number.isFinite(n) ? n : v;
    });
    rows.push(obj);
  }
  return rows.map((r) => FEATURE_ORDER.reduce((a,k)=>({ ...a, [k]: r[k] ?? null}), {} as any));
}

export const POST: APIRoute = async ({ request }) => {
  const ct = request.headers.get('content-type') || '';
  let rows: any[] = [];

  if (ct.includes('multipart/form-data')) {
    const form = await request.formData();
    const f = form.get('candidate-file');
    if (f && typeof f !== 'string') rows = parseCsv(await (f as File).text());
  } else {
    const body = await request.json().catch(() => ({}));
    if (Array.isArray(body.rows)) rows = body.rows;
    else if (body.input && typeof body.input === 'object') rows = [body.input];
  }

  if (!rows.length) {
    return new Response(JSON.stringify({ error: 'No data rows received' }), { status: 400, headers: { 'Content-Type': 'application/json' }});
  }

  const resp = await fetch(`${import.meta.env.EXO_API_URL}/predict`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': import.meta.env.EXO_API_KEY
    },
    body: JSON.stringify({ rows })
  });

  const text = await resp.text();
  return new Response(text, { status: resp.status, headers: { 'Content-Type': 'application/json' }});
};
