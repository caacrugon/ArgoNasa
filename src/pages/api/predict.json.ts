import type { APIRoute } from 'astro';
export const prerender = false;

const FEATURE_ORDER = [
  'orbital_period_days','transit_duration_hrs','transit_depth_pct',
  'stellar_temp_k','stellar_radius_solar','flux_variability','signal_to_noise',
];

const DEFAULT_MODEL = 'exoplanet_xgb_pipeline';
const SUPPORTED_MODELS = new Set([DEFAULT_MODEL, 'kepler_disposition_model']);
const CSV_ONLY_MODELS = new Set(['kepler_disposition_model']);
const MODEL_COLUMNS: Record<string, string[]> = {
  [DEFAULT_MODEL]: FEATURE_ORDER,
  kepler_disposition_model: ['time', 'lightcurves'],
};
const REQUIRED_COLUMNS: Record<string, string[]> = {
  kepler_disposition_model: ['time', 'lightcurves'],
};

type ParsedRows = { rows: any[]; missing: string[] };

function normalizeModel(input: unknown) {
  if (typeof input !== 'string') return DEFAULT_MODEL;
  const trimmed = input.trim();
  return SUPPORTED_MODELS.has(trimmed) ? trimmed : DEFAULT_MODEL;
}
function requiresCsv(model: string) { return CSV_ONLY_MODELS.has(model); }
function normalizeScalar(value: any): any {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map((v) => normalizeScalar(v));
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    const num = Number(s);
    if (Number.isFinite(num)) return num;
    if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
      try { return normalizeScalar(JSON.parse(s)); } catch { return s; }
    }
    return s;
  }
  return value;
}
function normalizeRowKeys(row: any): Record<string, any> {
  if (!row || typeof row !== 'object') return {};
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(row)) out[k.trim().toLowerCase()] = v;
  return out;
}
function shapeRows(rawRows: Record<string, any>[], model: string) {
  if (model === 'kepler_disposition_model') {
    return rawRows.map((row) => ({
      time: normalizeScalar(row.time),
      lightcurves: normalizeScalar(row.lightcurves),
    }));
  }
  const order = MODEL_COLUMNS[model] ?? FEATURE_ORDER;
  return rawRows.map((row) =>
    order.reduce((acc, key) => { acc[key] = normalizeScalar(row[key]); return acc; }, {} as Record<string, any>)
  );
}
function prepareRows(rawRows: Record<string, any>[], model: string): ParsedRows {
  const shaped = shapeRows(rawRows, model);
  const required = REQUIRED_COLUMNS[model] ?? [];
  const missing = required.filter((key) => shaped.some((row) => row[key] === undefined || row[key] === null));
  return { rows: shaped, missing };
}
function parseCsv(text: string, model: string): ParsedRows {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return { rows: [], missing: [] };
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const rawRows: Record<string, any>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const obj: Record<string, any> = {};
    headers.forEach((h, idx) => { obj[h] = (cols[idx] ?? '').trim(); });
    if (Object.values(obj).some((v) => v !== '')) rawRows.push(obj);
  }
  return prepareRows(rawRows, model);
}

// ---- Normaliza la respuesta del modelo a { predictions: [{label, prob}] }
function normalizeForUI(up: any) {
  if (Array.isArray(up?.predictions) && typeof up.predictions[0] === 'object') {
    return { predictions: up.predictions };
  }
  const toArr = (x: any) => Array.isArray(x) ? x : (x == null ? [] : [x]);
  const preds = toArr(up?.prediction);
  const probs = toArr(up?.probability);
  if (preds.length) {
    const LABELS = ['No exoplanet', 'Exoplanet'];
    const items = preds.map((p: any, i: number) => {
      const pn = typeof p === 'string' ? Number(p) : p;
      const label = pn === 0 || pn === 1 ? LABELS[pn] : (pn ?? '').toString();
      const prob = probs[i] != null ? Number(probs[i]) : null;
      return { label, prob };
    });
    return { predictions: items };
  }
  if (Array.isArray(up)) return { predictions: up.map((v: any) => ({ label: String(v), prob: null })) };
  return { predictions: [] };
}

export const POST: APIRoute = async ({ request }) => {
  const ct = request.headers.get('content-type') || '';
  let rows: any[] = [];
  let model = DEFAULT_MODEL;
  let origin: 'csv' | 'json' = 'json';
  let missingColumns: string[] = [];

  if (ct.includes('multipart/form-data')) {
    origin = 'csv';
    const form = await request.formData();
    model = normalizeModel(form.get('model'));
    const f = form.get('candidate-file');
    if (f && typeof f !== 'string') {
      const parsed = parseCsv(await (f as File).text(), model);
      rows = parsed.rows;
      missingColumns = parsed.missing;
    }
  } else {
    const body = await request.json().catch(() => ({}));
    model = normalizeModel((body as any)?.model);
    let rawRows: Record<string, any>[] = [];
    if (Array.isArray((body as any)?.rows)) {
      rawRows = (body as any).rows.map(normalizeRowKeys);
    } else if ((body as any)?.input && typeof (body as any).input === 'object') {
      rawRows = [normalizeRowKeys((body as any).input)];
    }
    if (rawRows.length) {
      const prepared = prepareRows(rawRows, model);
      rows = prepared.rows;
      missingColumns = prepared.missing;
    }
  }

  if (requiresCsv(model) && origin !== 'csv') {
    return new Response(JSON.stringify({ error: `${model} only accepts CSV uploads` }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (!rows.length) {
    return new Response(JSON.stringify({ error: 'No data rows received' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }
  if (missingColumns.length) {
    return new Response(JSON.stringify({ error: `Missing columns: ${missingColumns.join(', ')}` }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  // ── AQUÍ ESTÁ EL CAMBIO: elegir endpoint según el modelo ──
  const endpoint = model === 'kepler_disposition_model'
    ? `${import.meta.env.EXO_API_URL}/predict/kepler`
    : `${import.meta.env.EXO_API_URL}/predict`;

  // El backend solo necesita rows (no hace falta mandar "model")
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': import.meta.env.EXO_API_KEY,
    },
    body: JSON.stringify({ rows }),
  });

  const text = await upstream.text();

  if (!upstream.ok) {
    return new Response(text, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
  }

  let payload: any;
  try { payload = JSON.parse(text); }
  catch { return new Response(JSON.stringify({ error: 'Bad JSON from model service', raw: text }),
            { status: 502, headers: { 'Content-Type': 'application/json' } }); }

  const normalized = normalizeForUI(payload);
  return new Response(JSON.stringify(normalized), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};
