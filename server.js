const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const fsp = fs.promises;

const { applyAuth } = require('./auth');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;
const KIE_API_KEY = process.env.KIE_API_KEY;
const DAILY_BUDGET_USD = parseFloat(process.env.DAILY_BUDGET_USD || '10.00');

// bytedance/seedance-2-5, 480p, no reference-video input ("no video" rate).
const SEEDANCE_MODEL = 'bytedance/seedance-2-5';
const RESOLUTION = '480p';
const COST_PER_SECOND_USD = 0.140;
const KIE_ROOT = 'https://api.kie.ai';
const KIE_API_BASE = `${KIE_ROOT}/api/v1`;
const LLM_MODEL = 'gpt-5-6-luna';

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SPEND_FILE = path.join(DATA_DIR, 'spend.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
const GENERATED_DIR = process.env.GENERATED_DIR || path.join(__dirname, 'public', 'generated');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');

for (const dir of [DATA_DIR, GENERATED_DIR, UPLOADS_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

app.use(express.json());

applyAuth(app, { password: process.env.APP_PASSWORD, secret: process.env.SESSION_SECRET });

// ---------- per-visitor client id ----------

const CLIENT_COOKIE = 'story_client_id';

function getClientId(req, res) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(new RegExp(`${CLIENT_COOKIE}=([^;]+)`));
  if (match) return match[1];

  const id = uuidv4();
  res.setHeader(
    'Set-Cookie',
    `${CLIENT_COOKIE}=${id}; Path=/; Max-Age=${60 * 60 * 24 * 365}; HttpOnly; SameSite=Lax`
  );
  return id;
}

app.use((req, res, next) => {
  req.clientId = getClientId(req, res);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/generated', express.static(GENERATED_DIR));
app.use('/uploads', express.static(UPLOADS_DIR));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 3 },
});

// ---------- date / budget helpers (Asia/Singapore) ----------

function todayKeySGT() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' });
}

async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function writeJson(file, data) {
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

async function getTodaySpend() {
  const spend = await readJson(SPEND_FILE, {});
  return spend[todayKeySGT()] || 0;
}

async function addSpend(amount) {
  const spend = await readJson(SPEND_FILE, {});
  const key = todayKeySGT();
  spend[key] = (spend[key] || 0) + amount;
  await writeJson(SPEND_FILE, spend);
  return spend[key];
}

async function appendHistory(entry) {
  const history = await readJson(HISTORY_FILE, []);
  history.unshift(entry);
  await writeJson(HISTORY_FILE, history.slice(0, 200));
  return history;
}

async function updateHistoryEntry(id, patch) {
  const history = await readJson(HISTORY_FILE, []);
  const entry = history.find((h) => h.id === id);
  if (!entry) return;
  Object.assign(entry, patch);
  await writeJson(HISTORY_FILE, history);
}

// ---------- kie.ai helpers ----------

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

// kie.ai's Claude proxy in particular has shown a high transient-500 rate under longer prompts
// (observed ~75% per-attempt failure in bursts) — retries/backoff are tuned to survive that.
async function fetchWithRetry(url, options, { retries = 8, delayMs = 1500, maxDelayMs = 6000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetch(url, options);
      if (RETRYABLE_STATUS_CODES.has(res.status) && attempt < retries) {
        const wait = Math.min(maxDelayMs, delayMs * 1.5 ** attempt);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        const wait = Math.min(maxDelayMs, delayMs * 1.5 ** attempt);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

async function kieCreateTask(model, input) {
  const res = await fetchWithRetry(`${KIE_API_BASE}/jobs/createTask`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${KIE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input }),
  });
  const body = await res.json();
  if (!res.ok || body.code !== 200) {
    throw new Error(body?.msg || `kie.ai createTask failed (${res.status})`);
  }
  return body.data.taskId;
}

async function kiePollResult(taskId, { timeoutMs = 20 * 60 * 1000, intervalMs = 4000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetchWithRetry(`${KIE_API_BASE}/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${KIE_API_KEY}` },
    });
    const body = await res.json();
    if (!res.ok || body.code !== 200) {
      throw new Error(body?.msg || `kie.ai recordInfo failed (${res.status})`);
    }
    const { state, resultJson, failMsg } = body.data;
    if (state === 'success') {
      const result = JSON.parse(resultJson);
      if (!result.resultUrls || !result.resultUrls[0]) {
        throw new Error('kie.ai task succeeded but returned no video URL.');
      }
      return result.resultUrls[0];
    }
    if (state === 'fail') {
      throw new Error(failMsg || 'kie.ai generation failed.');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('kie.ai generation timed out.');
}

async function downloadToFile(url, destPath) {
  const res = await fetchWithRetry(url);
  if (!res.ok) throw new Error(`failed to download result video (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fsp.writeFile(destPath, buf);
}

// Uses GPT-5.6 via kie.ai's /codex/v1/responses endpoint. kie.ai's Claude proxy has shown
// extended outages (confirmed via trivial unrelated test calls), so this app runs on GPT instead.
async function callClaude(userMessage, { retries = 2 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const res = await fetchWithRetry(`${KIE_ROOT}/codex/v1/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${KIE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        stream: false,
        input: userMessage,
        reasoning: { effort: 'medium' },
      }),
    });

    // kie.ai's codex proxy has occasionally returned a malformed/non-JSON body
    // (a transient gateway glitch, not a code bug) — read as text and retry
    // on a parse failure rather than crashing the whole generation.
    const raw = await res.text();
    let body;
    try {
      body = JSON.parse(raw);
    } catch (parseErr) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      throw new Error('kie.ai LLM call returned a malformed response after retries. Please try again.');
    }

    if (!res.ok) {
      throw new Error(body?.error?.message || body?.msg || `kie.ai LLM call failed (${res.status})`);
    }
    const message = (body.output || []).find((o) => o.type === 'message');
    const textBlock = (message?.content || []).find((c) => c.type === 'output_text' && c.text);
    if (!textBlock) {
      throw new Error('LLM call returned no text.');
    }
    return textBlock.text.trim();
  }
}

// ---------- bus-fight-style single-take prompt generation ----------
// Architecture: identity locks before any action (suppresses drift), a rigid timecoded
// beat-by-beat timeline covering the WHOLE duration in one continuous take, a native-audio
// block with exact timecoded dialogue, then a camera/lens/grade/photoreal look stack.
// Genre-agnostic — the story's own content determines whether beats are combat, dialogue,
// or something quieter; the architecture holds regardless of tone.

const DIRECTOR_INSTRUCTIONS = `You are an expert cinematic director and prompt engineer for the Seedance video model, using a battle-tested single-continuous-take prompt architecture. Given a story, up to 3 characters, an art style, and a target duration, write ONE complete Seedance prompt for a single continuous take covering the ENTIRE story from beginning to end, in strict chronological order. Output STRICT JSON only — no markdown fences, no commentary — in this exact shape:
{"prompt": "...", "riskNote": "..."}

"prompt" is the full finished Seedance prompt (plain text, section headers in bold **like this**). "riskNote" is a short plain-language note (1-3 sentences) flagging which 1-2 beats are most likely to misbehave in generation and a concrete fallback for each — this is for the human's information only, never sent to the video model.

Produce the "prompt" value using EXACTLY this section order:

1. ART STYLE LOCK — the very first section, before anything else. State the target art style in absolute terms, e.g.: "ENTIRE CLIP RENDERED IN [STYLE], EVERY SINGLE FRAME, START TO FINISH. This is NOT live-action photography, NOT photorealistic, NOT a CGI/3D render [pick whichever of these do NOT apply and name them explicitly as negations]. [One vivid sentence describing what the style's medium concretely looks like — materials, rendering technique, motion quality.]" Pick the negations based on the actual style: if style is "stop motion," negate live-action and smooth CG motion; if "3D animation," negate live-action photography and hand-drawn/2D; if "anime," negate live-action and 3D CG; if "realistic film"/unspecified, negate animation/CGI/stylisation instead. This section's commitment applies to the ENTIRE clip — repeat the style name itself (not just implied traits) again in the SCENE section and once more in each of the four look-stack sections later, so it is never allowed to drift toward generic realism.

2. IDENTITY LOCK — one block per character that has an uploaded reference image, using the EXACT @image number you are told belongs to them. Use this near-verbatim phrasing (fill in the brackets):
"@image1 — [ROLE/NAME]. Take his/her face, hair, skin tone, build, clothing and entire physical appearance ENTIRELY from the uploaded reference image, REINTERPRETED in the [ART STYLE] described above. Reproduce their identity exactly as they appear there, including every item of clothing and every accessory, translated into [ART STYLE]. Do not add, remove, or otherwise alter their appearance or dress at any point in the clip. Whatever they wear in the reference image, they wear identically in every single frame — it may become dishevelled from the action, but no garment or accessory changes, is added, or is removed."
For a character with a text description instead of a photo, write a "[ROLE] — LOCKED APPEARANCE:" block describing them vividly from the given description, rendered in the target art style, with the same "identical in every frame, zero drift" language, but no @image tag.
If the story has other characters beyond the ones provided, add a short block making each one distinguishable and consistent ("clearly distinguishable... do not merge or swap their features").

3. KEY PROPS (only if the story has an object that must stay visually consistent — skip this section entirely if not applicable).

4. THE ENVIRONMENT — a rich, specific setting description (architecture/nature/materials, light sources, weather/time), rendered in the target art style. If there's one fussy geometric detail (a door, a specific layout element), lock it by negation (state what it is NOT, e.g. "NOT a rear door"). State the geometry must not change throughout.

5. SCENE — where/when, mood, headcount if relevant ("empty except for exactly N people" when it matters), atmospheric detail, and a register line that names BOTH the story's tone AND the art style together (e.g. "Grounded stop-motion animation register, theatrical drama tone" or "Grounded photorealistic cinematography, theatrical drama register" — never describe this register in a way that contradicts the ART STYLE LOCK above).

6. CRITICAL — starting constraint. State plainly what must already be true in frame one so the model doesn't waste beats on setup (e.g. "already mid-conversation," "the rain has already started," "she is already holding the letter").

7. SCENE STYLE — the physical/performance register appropriate to what actually happens in the story (this is NOT always a fight — could be quiet, comedic, tense, tender; write whatever the story calls for). If there IS physical action, use: "grounded realism, full body weight and visible consequence, no wire work, no superhero physics," and specify who acts first.

8. AUDIO — state "GENERATE NATIVE AUDIO WITH THE VIDEO." then list every spoken line implied by the story with its exact timecode, speaker, and tone, formatted as bullet points, each ending with an instruction for accurate lip-sync, e.g. "0:04 — SARAH, quietly: \\"...\\"" Lines must never overlap. Then describe layered sound design keyed to specific events/ambience in the scene. State "NO MUSIC SCORE AT ANY POINT" unless the story specifically calls for source music.

9. "THIS IS ONE CONTINUOUS [DURATION]-SECOND TAKE, PLAYED IN STRICT CHRONOLOGICAL ORDER — NO FLASHBACKS, NO FLASH-FORWARDS, NO OUT-OF-ORDER CUTS, NO JUMPING BETWEEN LATER AND EARLIER MOMENTS." Then the full timecoded beat-by-beat timeline, beats roughly 1.5-3 seconds each, covering start to finish with NO gaps, in the EXACT order events happen in the story, ending exactly at the target duration. EVERY BEAT MUST ADVANCE THE STORY WITH SOMETHING NEW — a new action, a new piece of information, a new emotional beat, or a new location/detail. Never write two consecutive beats that show substantially the same thing from a slightly different angle, or that repeat/hold on an action already shown; if nothing new is happening, compress or cut that beat rather than padding the timeline. Each beat names the action, the camera behaviour, and any dialogue spoken in that beat, and must follow on directly and unambiguously from the previous beat's ending position/action — never restart, backtrack, or imply an earlier moment. If the story itself contains a time-skip (e.g. "hours later"), do not leave it as an ambiguous jump: write an explicit passage-of-time beat that visually shows the skip happening (e.g. "sun and shadows visibly sweep across the scene while X remains asleep, Y continues without stopping") so the chronology stays unbroken and legible. On any high-impact or emotionally pivotal beat, consider naming an explicit slow-motion percentage (e.g. "SLOW MOTION at 25% speed") if it fits the story. End on a strong final beat (a locked-off wide shot, a freeze on a face, or similar).

10-13. LOOK STACK — write four short sections — CAMERA PACKAGE, LENS/RENDER BEHAVIOUR, GRADE AND LIGHT, and VISUAL TEXTURE — whose content is entirely appropriate to the target ART STYLE (restate the style name explicitly at the start of each of these four sections), not defaulted to live-action photorealism. Examples of how these sections should differ by style (adapt intelligently for whatever style you're given, these are illustrations, not the only valid options):
- "realistic film" / "cinematic" / unspecified: large-format digital cinema camera (e.g. ARRI ALEXA), real lens behaviour (anamorphic bokeh, chromatic aberration), filmic grade, real skin texture/pores, live-action photographic realism, no CGI look, NOT animated, NOT stylised.
- "3D animation" / "CG" / "Pixar-style": describe the render style (stylised or semi-realistic 3D character/environment rendering, render engine light bounce quality, subsurface scattering on skin, stylised proportions if implied), animated rigging/motion quality, CG lighting and shading language — do NOT describe a physical camera sensor or film grain, NOT live-action, NOT photoreal skin.
- "stop motion": describe practical handmade puppet/set texture, visible fingerprints or seams on models, slightly choppy ON-TWOS motion cadence (explicitly state the frame-stepped cadence, not smooth interpolated motion), physical practical lighting, tangible tactile materials (felt, clay, wood, fabric) — explicitly state NOT live-action, NOT photorealistic skin, NOT smooth digital motion blur, NOT a physical cinema camera/sensor.
- "anime": describe cel-shaded or modern anime rendering, line art quality, stylised expressive motion, appropriate anime lighting/color language — explicitly NOT live-action, NOT 3D CG.
- other styles the user might type (watercolor, claymation, pixel art, etc.): interpret the style's actual visual medium and describe camera/lens/grade/texture language authentic to THAT medium, with explicit negation of live-action/photoreal unless the style itself is photoreal.
Never let these four sections drift back into generic "live-action photographic realism" language unless the requested art style genuinely is realistic film/cinematic.

HARD RULES:
- The identity of every uploaded-photo character must be locked to their EXACT given @image number — never invent or guess numbers.
- The chosen art style must be named explicitly and reinforced in at least 6 different places across the prompt (style lock, identity lock(s), scene, and all four look-stack sections) — it must never be allowed to default back to live-action realism partway through.
- The timeline must play out in strict linear chronological order exactly as the story happens — no flashbacks, no flash-forwards, no reordering, no jumping between later and earlier moments. Every beat must follow directly from where the previous beat left off.
- Every single cut/beat must show something NEW that moves the story forward — never two consecutive beats covering the same action or moment from a different angle.
- Total timeline must add up to exactly the given duration in seconds — no more, no less.
- Never sexualize minors. Never stage a real, named public figure's death/self-harm as fabricated fiction — use a fictional stand-in in the same setting if the story implies this.
- Keep dialogue short and lip-sync-friendly.`;

async function writeStoryPrompt({ story, duration, characters, artStyle }) {
  let nextImageIndex = 1;
  const characterLines = characters.map((ch, i) => {
    if (ch.mode === 'upload') {
      const idx = nextImageIndex;
      nextImageIndex += 1;
      return `${i + 1}. ${ch.label} — has reference photo @image${idx}. Do not invent a different appearance.`;
    }
    return `${i + 1}. ${ch.label} — described as: ${ch.description}`;
  });

  const userMessage =
    `${DIRECTOR_INSTRUCTIONS}\n\n` +
    `Target duration: ${duration} seconds (exactly)\n\n` +
    `Art style: ${artStyle}\n\n` +
    `Characters:\n${characterLines.join('\n') || '(none provided — invent characters as the story implies)'}\n\n` +
    `Story:\n"""\n${story}\n"""\n\n` +
    'Output the JSON now.';

  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let raw;
    try {
      raw = await callClaude(userMessage);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw lastErr;
    }

    // Strip markdown code fences, and strip any stray text before/after the JSON object itself —
    // kie.ai's LLM output has occasionally been seen prefixed with a stray tag (e.g. "<escape>"),
    // or (rarely) returned a non-JSON message instead of the expected output entirely. Either
    // way, retry with a fresh call rather than failing the whole generation outright.
    let cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) {
      lastErr = new Error(`LLM did not return JSON. Got: ${cleaned.slice(0, 200)}`);
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw lastErr;
    }
    if (firstBrace > 0 || lastBrace < cleaned.length - 1) {
      cleaned = cleaned.slice(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (err) {
      lastErr = new Error(`LLM returned unparseable output: ${err.message}`);
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw lastErr;
    }
    if (!parsed.prompt || typeof parsed.prompt !== 'string') {
      lastErr = new Error('LLM did not return a usable prompt.');
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      throw lastErr;
    }
    return { prompt: parsed.prompt, riskNote: parsed.riskNote || null };
  }
  throw lastErr;
}

// ---------- routes ----------

app.get('/api/budget', async (req, res) => {
  const spent = await getTodaySpend();
  res.json({
    date: todayKeySGT(),
    dailyBudgetUsd: DAILY_BUDGET_USD,
    spentUsd: Number(spent.toFixed(4)),
    remainingUsd: Number(Math.max(0, DAILY_BUDGET_USD - spent).toFixed(4)),
    costPerSecondUsd: COST_PER_SECOND_USD,
  });
});

app.get('/api/history', async (req, res) => {
  const history = await readJson(HISTORY_FILE, []);
  res.json(history.filter((entry) => entry.clientId === req.clientId));
});

app.get('/api/status/:id', async (req, res) => {
  const history = await readJson(HISTORY_FILE, []);
  const entry = history.find((h) => h.id === req.params.id && h.clientId === req.clientId);
  if (!entry) {
    return res.status(404).json({ error: 'Story not found.' });
  }
  res.json(entry);
});

// Runs after the HTTP response has already been sent — writing the prompt plus generating a
// 15-30s video easily takes longer than any reverse-proxy timeout would allow.
async function processStory({ id, story, duration, characters, artStyle, aspectRatio, estimatedCost, tempUploadPaths }) {
  try {
    await updateHistoryEntry(id, { stage: 'writing prompt' });

    let promptResult;
    try {
      promptResult = await writeStoryPrompt({ story, duration, characters, artStyle });
    } catch (err) {
      console.error('prompt generation failed:', err.message);
      throw new Error(`Could not write the story prompt: ${err.message}`);
    }

    await updateHistoryEntry(id, {
      stage: 'generating video',
      finalPrompt: promptResult.prompt,
      riskNote: promptResult.riskNote,
    });

    const referenceImageUrls = characters
      .filter((ch) => ch.mode === 'upload')
      .map((ch) => ch.imageUrl);

    const input = {
      prompt: promptResult.prompt,
      generate_audio: true,
      resolution: RESOLUTION,
      aspect_ratio: aspectRatio,
      duration,
    };
    if (referenceImageUrls.length) {
      input.reference_image_urls = referenceImageUrls;
    }

    const taskId = await kieCreateTask(SEEDANCE_MODEL, input);
    const resultVideoUrl = await kiePollResult(taskId);

    const destFile = `${id}.mp4`;
    await downloadToFile(resultVideoUrl, path.join(GENERATED_DIR, destFile));
    const newTotal = await addSpend(estimatedCost);

    await updateHistoryEntry(id, {
      status: 'success',
      stage: 'done',
      resultUrl: `/generated/${destFile}`,
      spentTodayUsd: Number(newTotal.toFixed(4)),
    });
  } catch (err) {
    console.error('story generation error:', err);
    await updateHistoryEntry(id, {
      status: 'fail',
      stage: 'failed',
      error: err.message || 'Story generation failed.',
    });
  } finally {
    for (const p of tempUploadPaths) {
      fsp.unlink(p).catch(() => {});
    }
  }
}

app.post(
  '/api/generate',
  upload.fields([
    { name: 'character1Photo', maxCount: 1 },
    { name: 'character2Photo', maxCount: 1 },
    { name: 'character3Photo', maxCount: 1 },
  ]),
  async (req, res) => {
    const tempUploadPaths = [];
    try {
      if (!KIE_API_KEY) {
        return res.status(500).json({ error: 'Server is missing KIE_API_KEY. Add it to your .env file and restart.' });
      }

      const story = (req.body.story || '').trim();
      const duration = parseInt(req.body.duration, 10);
      const artStyle = (req.body.artStyle || '').trim() || 'Realistic film';
      const aspectRatio = req.body.aspectRatio || '9:16';

      const validAspectRatios = ['1:1', '4:3', '3:4', '16:9', '9:16', '21:9'];
      if (!validAspectRatios.includes(aspectRatio)) {
        return res.status(400).json({ error: 'Unknown aspect ratio.' });
      }
      if (story.length < 20) {
        return res.status(400).json({ error: 'Write a bit more story before generating.' });
      }
      if (!Number.isInteger(duration) || duration < 4 || duration > 30) {
        return res.status(400).json({ error: 'Choose a video length between 4 and 30 seconds.' });
      }

      const origin = `${req.protocol}://${req.get('host')}`;
      const characters = [];

      for (let i = 1; i <= 3; i += 1) {
        const rawMode = req.body[`character${i}Mode`];
        const mode = rawMode === 'describe' ? 'describe' : rawMode === 'upload' ? 'upload' : null;
        if (!mode) continue; // this character slot wasn't used

        const label = `CHARACTER ${i}`;
        if (mode === 'upload') {
          const file = req.files?.[`character${i}Photo`]?.[0];
          if (!file) {
            return res.status(400).json({ error: `Upload a photo for Character ${i}, or switch it to Describe.` });
          }
          const fileName = `${uuidv4()}.jpg`;
          const destPath = path.join(UPLOADS_DIR, fileName);
          await sharp(file.buffer)
            .rotate()
            .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 88 })
            .toFile(destPath);
          tempUploadPaths.push(destPath);
          characters.push({ label, mode: 'upload', imageUrl: `${origin}/uploads/${fileName}` });
        } else {
          const description = (req.body[`character${i}Description`] || '').trim();
          if (!description) {
            return res.status(400).json({ error: `Describe Character ${i}, or switch it to Upload.` });
          }
          characters.push({ label, mode: 'describe', description });
        }
      }

      // ---- budget check BEFORE spending anything ----
      const estimatedCost = duration * COST_PER_SECOND_USD;
      const spentToday = await getTodaySpend();
      if (spentToday + estimatedCost > DAILY_BUDGET_USD) {
        return res.status(429).json({
          error: `Daily budget of $${DAILY_BUDGET_USD.toFixed(2)} reached. ` +
            `Spent $${spentToday.toFixed(2)} today. Try again after midnight (Asia/Singapore).`,
        });
      }

      const id = uuidv4();
      const entry = {
        id,
        clientId: req.clientId,
        createdAt: new Date().toISOString(),
        story,
        duration,
        artStyle,
        aspectRatio,
        status: 'pending',
        stage: 'starting',
        costUsd: estimatedCost,
      };
      await appendHistory(entry);

      res.json({ id, status: 'pending' });

      processStory({ id, story, duration, characters, artStyle, aspectRatio, estimatedCost, tempUploadPaths });
    } catch (err) {
      console.error('generate error:', err);
      for (const p of tempUploadPaths) {
        fsp.unlink(p).catch(() => {});
      }
      res.status(500).json({ error: err.message || 'Story generation failed.' });
    }
  }
);

// multer errors land here instead of Express's default HTML error page.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  console.error('unhandled error:', err);
  res.status(500).json({ error: 'Something went wrong.' });
});

app.listen(PORT, () => {
  console.log(`Story Creator app running at http://localhost:${PORT}`);
  if (!KIE_API_KEY) {
    console.warn('WARNING: KIE_API_KEY is not set. Copy .env.example to .env and add your kie.ai API key.');
  }
});
