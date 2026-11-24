import express from 'express';
import multer from 'multer';
import cors from 'cors';
import { fal } from '@fal-ai/client';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.FAL_MODEL || 'fal-ai/ovi/image-to-video';
const COMFY_URL = (process.env.COMFYUI_URL || '').replace(/\/$/, '');
const WORKFLOW_PATH = path.resolve(__dirname, process.env.COMFYUI_WORKFLOW || 'workflow.json');
const paidEnabled = process.env.ENABLE_PAID_PROVIDER === 'true';

if (process.env.FAL_KEY) fal.config({ credentials: process.env.FAL_KEY });
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function hasComfyWorkflow() {
  if (!COMFY_URL) return false;
  try {
    await fs.access(WORKFLOW_PATH);
    const ping = await fetch(`${COMFY_URL}/system_stats`, { signal: AbortSignal.timeout(2500) });
    return ping.ok;
  } catch { return false; }
}
function chosenProvider(comfyReady) {
  if (comfyReady) return 'comfyui';
  if (paidEnabled && process.env.FAL_KEY) return 'fal';
  return 'unavailable';
}

app.get('/api/health', async (_req, res) => {
  const comfyReady = await hasComfyWorkflow();
  const provider = chosenProvider(comfyReady);
  res.json({
    ok: true,
    provider,
    selection: 'automatic-free-first',
    freeProvider: { name: 'ComfyUI local', configured: comfyReady, requiresOwnGPU: true },
    paidFallback: { name: 'fal', enabled: paidEnabled && Boolean(process.env.FAL_KEY), configured: Boolean(process.env.FAL_KEY) },
    message: provider === 'comfyui' ? 'Using your local ComfyUI engine first.' : provider === 'fal' ? 'No local free engine found. Using the paid fal fallback because the owner enabled it.' : 'No free engine is configured. Paid providers are disabled by default.'
  });
});
app.get('/api/providers', async (_req, res) => {
  const comfyReady = await hasComfyWorkflow();
  res.json({ selection: 'automatic-free-first', selected: chosenProvider(comfyReady), providers: [
    { id: 'comfyui', name: 'ComfyUI (self-hosted)', cost: 'No per-video API fee; uses your own GPU/electricity', ready: comfyReady, priority: 1 },
    { id: 'fal', name: 'fal', cost: 'Paid usage; owner must explicitly enable', ready: paidEnabled && Boolean(process.env.FAL_KEY), priority: 2 }
  ] });
});

async function submitComfyJob(file, prompt) {
  const workflow = JSON.parse(await fs.readFile(WORKFLOW_PATH, 'utf8'));
  const form = new FormData();
  form.append('image', new Blob([file.buffer], { type: file.mimetype || 'image/png' }), file.originalname || 'toonmotion-reference.png');
  form.append('overwrite', 'true');
  const uploadedResponse = await fetch(`${COMFY_URL}/upload/image`, { method: 'POST', body: form });
  const uploaded = await uploadedResponse.json().catch(() => ({}));
  if (!uploadedResponse.ok || !uploaded.name) throw new Error(uploaded.error?.message || 'Could not upload the reference image to ComfyUI.');
  const replace = value => {
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)]));
    if (value === '__PROMPT__') return prompt;
    if (value === '__IMAGE_FILENAME__') return uploaded.name;
    if (value === '__IMAGE_SUBFOLDER__') return uploaded.subfolder || '';
    if (value === '__IMAGE_TYPE__') return uploaded.type || 'input';
    return value;
  };
  const promptResponse = await fetch(`${COMFY_URL}/prompt`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: replace(workflow) })
  });
  const queued = await promptResponse.json().catch(() => ({}));
  if (!promptResponse.ok || !queued.prompt_id) throw new Error(queued.error?.message || queued.message || 'ComfyUI did not accept the workflow. Check the API workflow and its placeholder fields.');
  return queued.prompt_id;
}

app.post('/api/render', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Upload a character reference image.' });
    const prompt = String(req.body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'A scene prompt is required.' });
    if (prompt.length > 12000) return res.status(400).json({ error: 'Scene prompt is too long.' });

    // Automatic provider selection: self-hosted/free first; paid fal only by explicit owner opt-in.
    const comfyReady = await hasComfyWorkflow();
    const provider = chosenProvider(comfyReady);
    if (provider === 'comfyui') {
      const promptId = await submitComfyJob(req.file, prompt);
      return res.json({ request_id: promptId, endpoint: 'comfyui', provider: 'ComfyUI (self-hosted/free-first)', sceneTitle: String(req.body.sceneTitle || 'Scene').slice(0, 100) });
    }
    if (provider === 'fal') {
      const file = new File([req.file.buffer], req.file.originalname || 'character-reference.png', { type: req.file.mimetype || 'image/png' });
      const imageUrl = await fal.storage.upload(file);
      const submitted = await fal.queue.submit(MODEL, { input: { prompt, image_url: imageUrl } });
      return res.json({ request_id: submitted.request_id, endpoint: MODEL, provider: 'fal (paid fallback)', sceneTitle: String(req.body.sceneTitle || 'Scene').slice(0, 100) });
    }
    return res.status(503).json({ error: 'No free video engine is connected yet. To keep ToonMotion free-first, connect a local ComfyUI computer with a compatible image-to-video workflow. Paid fal rendering is switched OFF by default.' });
  } catch (err) {
    console.error('Render submit failed:', err);
    return res.status(502).json({ error: err?.message || 'The selected video provider rejected the render request.' });
  }
});

app.get('/api/jobs/:id', async (req, res) => {
  try {
    const endpoint = String(req.query.endpoint || '');
    if (endpoint === 'comfyui') {
      if (!COMFY_URL) return res.status(503).json({ error: 'COMFYUI_URL is not configured.' });
      const response = await fetch(`${COMFY_URL}/history/${encodeURIComponent(req.params.id)}`);
      const history = await response.json();
      if (!response.ok) return res.status(502).json({ error: 'Could not retrieve ComfyUI job history.' });
      const job = history?.[req.params.id];
      if (!job) return res.json({ status: 'IN_PROGRESS' });
      const outputs = job.outputs || {};
      let media = null;
      for (const node of Object.values(outputs)) {
        for (const kind of ['videos', 'gifs']) if (Array.isArray(node?.[kind]) && node[kind].length) { media = { ...node[kind][0], kind }; break; }
        if (media) break;
      }
      if (!media) {
        const status = job.status?.status;
        if (status === 'error') return res.json({ status: 'FAILED', error: 'ComfyUI reported a workflow error.' });
        return res.json({ status: 'IN_PROGRESS' });
      }
      const params = new URLSearchParams({ filename: media.filename, subfolder: media.subfolder || '', type: media.type || 'output' });
      return res.json({ status: 'COMPLETED', video_url: `/api/jobs/${encodeURIComponent(req.params.id)}/media?${params.toString()}`, provider: 'ComfyUI' });
    }
    if (!process.env.FAL_KEY || !paidEnabled) return res.status(503).json({ error: 'Paid fal fallback is disabled.' });
    if (!/^[a-zA-Z0-9._/-]{3,160}$/.test(endpoint)) return res.status(400).json({ error: 'Invalid model endpoint.' });
    const status = await fal.queue.status(endpoint, { requestId: req.params.id, logs: false });
    if (status.status !== 'COMPLETED') return res.json({ status: status.status });
    const result = await fal.queue.result(endpoint, { requestId: req.params.id });
    const videoUrl = result?.data?.video?.url || result?.data?.output?.video?.url || result?.data?.video_url;
    if (!videoUrl) return res.status(502).json({ error: 'Render completed, but no video URL was returned by the selected model.' });
    return res.json({ status: 'COMPLETED', video_url: videoUrl, provider: 'fal' });
  } catch (err) {
    console.error('Render status failed:', err);
    return res.status(502).json({ error: err?.message || 'Could not retrieve render result.' });
  }
});

app.get('/api/jobs/:id/media', async (req, res) => {
  try {
    if (!COMFY_URL) return res.status(503).end('ComfyUI is not configured.');
    const q = new URLSearchParams({ filename: String(req.query.filename || ''), subfolder: String(req.query.subfolder || ''), type: String(req.query.type || 'output') });
    const upstream = await fetch(`${COMFY_URL}/view?${q.toString()}`);
    if (!upstream.ok || !upstream.body) return res.status(502).end('Could not load generated media.');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) { res.status(502).end(err?.message || 'Media proxy failed.'); }
});

app.listen(PORT, () => console.log(`ToonMotion AI backend running on http://localhost:${PORT}`));
