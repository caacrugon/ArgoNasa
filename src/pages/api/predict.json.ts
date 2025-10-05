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
  return rows.map((r) =>
    FEATURE_ORDER.reduce((a, k) => ({ ...a, [k]: r[k] ?? null }), {} as any)
  );
}

// ---- Normaliza la respuesta del modelo a { predictions: [{label, prob}] }
function normalizeForUI(up: any) {
  // Si ya viene en el formato esperado, pasa directo
  if (Array.isArray(up?.predictions) && typeof up.predictions[0] === 'object') {
    return { predictions: up.predictions };
  }

  // Caso típico: { prediction: [0,1,...], probability: [0.12, 0.87, ...] }
  const toArr = (x: any) =>
    Array.isArray(x) ? x : (x === undefined || x === null ? [] : [x]);

  const preds = toArr(up?.prediction);
  const probs = toArr(up?.probability);

  if (preds.length) {
    const LABELS = ['No exoplanet', 'Exoplanet'];
    const items = preds.map((p: any, i: number) => {
      const pn = typeof p === 'string' ? Number(p) : p;
      const label =
        pn === 0 || pn === 1 ? LABELS[pn] : (pn ?? '').toString();
      const prob = probs[i] !== undefined && probs[i] !== null
        ? Number(probs[i])
        : null;
      return { label, prob };
    });
    return { predictions: items };
  }

  // Último recurso: si es array plano, envuélvelo
  if (Array.isArray(up)) {
    return {
      predictions: up.map((v: any) => ({ label: String(v), prob: null })),
    };
  }

  return { predictions: [] };
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
    return new Response(
      JSON.stringify({ error: 'No data rows received' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const resp = await fetch(
    `${import.meta.env.EXO_API_URL}/predict`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': import.meta.env.EXO_API_KEY,
      },
      body: JSON.stringify({ rows }),
    }
  );

  const text = await resp.text();

  // Propaga errores de upstream tal cual
  if (!resp.ok) {
    return new Response(text, {
      status: resp.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Intenta parsear y normaliza
  let upstream: any;
  try {
    upstream = JSON.parse(text);
  } catch {
    return new Response(
      JSON.stringify({ error: 'Bad JSON from model service', raw: text }),
      { status: 502, headers: { 'Content-Type': 'application/json' } }
    );
  }

  const normalized = normalizeForUI(upstream);
  return new Response(JSON.stringify(normalized), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
