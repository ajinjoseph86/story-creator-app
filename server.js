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
const DAILY_BUDGET_USD = parseFloat(process.env.DAILY_BUDGET_USD || '30.00');

// bytedance/seedance-2-5, 480p, no reference-video input ("no video" rate).
const SEEDANCE_MODEL = 'bytedance/seedance-2-5';
const RESOLUTION = '480p';
const COST_PER_SECOND_USD = 0.140;

// For non-realistic art styles, each uploaded photo is first redrawn in that style with Nano Banana Pro
// (~24 credits = ~$0.12) and the styled image is used as the video reference instead of the real photo,
// because Seedance otherwise copies the photograph's real-camera look and ignores the requested style.
const STYLE_IMAGE_MODEL = 'nano-banana-pro';
const COST_PER_STYLE_IMAGE_USD = 0.12;
const NON_REALISTIC_STYLE = /anim|3d|\bcg\b|cartoon|stop.?motion|clay|paint|water.?colou?r|pixel|comic|illustrat|sketch|puppet|felt|lego|voxel|\bcel\b|ghibli|pixar|manga/i;

function isRealisticStyle(artStyle) {
  return !NON_REALISTIC_STYLE.test(artStyle || '');
}
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
  limits: { fileSize: 15 * 1024 * 1024, files: 9 },
});

const MAX_CHARACTERS = 8;

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
  await writeJson(HISTORY_FILE, history);
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
IMPORTANT when the art style is NOT live-action/realistic (3D animation, stop motion, anime, watercolor, claymation, etc.): the uploaded photo is a PHOTOGRAPH, and the video model tends to copy a photograph's real-camera look and override the style. Counter this inside every identity lock: say the photo is used ONLY for likeness (face shape, hair, skin tone, build, outfit) and that the character MUST be fully redrawn/rebuilt as a [ART STYLE] character — with [ART STYLE] materials, shading and proportions — and explicitly NOT a real person, NOT photographic skin, NOT a live-action actor, NOT a filmed human. The background, props and every other element must also be fully [ART STYLE].
For a character with a text description instead of a photo, write a "[ROLE] — LOCKED APPEARANCE:" block describing them vividly from the given description, rendered in the target art style, with the same "identical in every frame, zero drift" language, but no @image tag.
If the story has other characters beyond the ones provided, add a short block making each one distinguishable and consistent ("clearly distinguishable... do not merge or swap their features").

3. AUDIO — placed early, right after the identity locks, because the video model obeys instructions near the top of the prompt most reliably. State "GENERATE NATIVE AUDIO WITH THE VIDEO." then list every spoken line implied by the story with its exact timecode, speaker, and tone, formatted as bullet points, each ending with an instruction for accurate lip-sync, e.g. "0:04 — SARAH, quietly: \\"...\\"" Lines must never overlap. Then describe layered sound design keyed to specific events/ambience in the scene. State "NO MUSIC SCORE AT ANY POINT" unless the story specifically calls for source music.

4. KEY PROPS (only if the story has an object that must stay visually consistent — skip this section entirely if not applicable). For every prop named here, state exactly where it is and what state it's in at frame one (e.g. "the letter is already open on the desk, face-up"), so the model never has to invent or guess its starting position.

5. THE ENVIRONMENT — a rich, specific setting description (architecture/nature/materials, light sources, weather/time), rendered in the target art style. If there's one fussy geometric detail (a door, a specific layout element), lock it by negation (state what it is NOT, e.g. "NOT a rear door"). State the geometry must not change throughout. If an Environment is provided below: for a reference photo (@image number given), build THE ENVIRONMENT from it — "@imageN is the location reference: take the setting, layout, materials and lighting from it, reinterpreted in the [ART STYLE]; it is a place only, no person from it appears" — and keep the geometry faithful to it; for a text description, treat it as the base and enrich it. If the scene would naturally contain any readable text, signage, screens, or labels, state plainly that none of it needs to be legible — describe it only by vague shape/color, never spell out specific words for the model to render.

6. SCENE — where/when, mood, headcount if relevant ("empty except for exactly N people" when it matters), atmospheric detail, and a register line that names BOTH the story's tone AND the art style together (e.g. "Grounded stop-motion animation register, theatrical drama tone" or, only for realistic film, "Grounded cinematic register, theatrical drama tone" — never use the word photorealistic or realistic in this line for a non-realistic art style, and never describe this register in a way that contradicts the ART STYLE LOCK above).

7. CRITICAL — starting position. State plainly what must already be true in frame one so the model doesn't waste beats on setup: not just the general situation (e.g. "already mid-conversation," "the rain has already started") but the concrete starting state — each character's exact body position/pose, what their hands are doing, and their contact point with any prop or piece of furniture at the very first frame.

8. SCENE STYLE — the physical/performance register appropriate to what actually happens in the story (this is NOT always a fight — could be quiet, comedic, tense, tender; write whatever the story calls for). State in one line the emotional or tonal engine of the scene — which character drives it, and the single moment (if any) where the tone shifts or lands. If there IS physical action and the art style is realistic film/cinematic, use: "grounded realism, full body weight and visible consequence, no wire work, no superhero physics". For any other art style, describe the action in that style's own motion language instead (e.g. stylised animated weight and timing for 3D animation/anime, on-twos puppet movement for stop motion) and do NOT use the words realism, photoreal or live-action except in the negations. Always specify who acts first.

9. "THIS IS ONE CONTINUOUS [DURATION]-SECOND TAKE, PLAYED IN STRICT CHRONOLOGICAL ORDER — NO FLASHBACKS, NO FLASH-FORWARDS, NO OUT-OF-ORDER CUTS, NO JUMPING BETWEEN LATER AND EARLIER MOMENTS." Then the full timecoded beat-by-beat timeline, beats roughly 1.5-3 seconds each, covering start to finish with NO gaps, in the EXACT order events happen in the story, ending exactly at the target duration. EVERY BEAT MUST ADVANCE THE STORY WITH SOMETHING NEW — a new action, a new piece of information, a new emotional beat, or a new location/detail. Never write two consecutive beats that show substantially the same thing from a slightly different angle, or that repeat/hold on an action already shown; if nothing new is happening, compress or cut that beat rather than padding the timeline. Each beat names the action, the camera behaviour, and any dialogue spoken in that beat, and must follow on directly and unambiguously from the previous beat's ending position/action — never restart, backtrack, or imply an earlier moment. If the story itself contains a time-skip (e.g. "hours later"), do not leave it as an ambiguous jump: write an explicit passage-of-time beat that visually shows the skip happening (e.g. "sun and shadows visibly sweep across the scene while X remains asleep, Y continues without stopping") so the chronology stays unbroken and legible. On any high-impact or emotionally pivotal beat, consider naming an explicit slow-motion percentage (e.g. "SLOW MOTION at 25% speed") if it fits the story. End on a strong final beat (a locked-off wide shot, a freeze on a face, or similar).

10-13. LOOK STACK — write four short sections — CAMERA PACKAGE, LENS/RENDER BEHAVIOUR, GRADE AND LIGHT, and VISUAL TEXTURE — whose content is entirely appropriate to the target ART STYLE (restate the style name explicitly at the start of each of these four sections), not defaulted to live-action photorealism. Examples of how these sections should differ by style (adapt intelligently for whatever style you're given, these are illustrations, not the only valid options):
- "realistic film" / "cinematic" / "photorealistic" / "photoreal" / "live action" / unspecified (the default): you MUST name a specific cinema camera and lens package in CAMERA PACKAGE and LENS/RENDER BEHAVIOUR (e.g. "shot on an ARRI ALEXA 35 with vintage anamorphic prime lenses"), with real lens behaviour (anamorphic bokeh, subtle chromatic aberration, natural depth-of-field falloff), a filmic grade, and live-action photographic realism, no CGI look, NOT animated, NOT stylised. For these styles you MUST ALSO write a fifth section after VISUAL TEXTURE titled PHOTOREAL: real skin texture with visible pores, peach fuzz, fine lines and natural asymmetry, no airbrushing or plastic-smooth skin, individual hair strands, real eyes with catchlights, natural fabric weave and creasing, believable hands with the correct finger count, authentic material reflections, natural motion blur, fine sensor grain.
- "3D animation" / "CG" / "Pixar-style": describe the render style (stylised or semi-realistic 3D character/environment rendering, render engine light bounce quality, subsurface scattering on skin, stylised proportions if implied), animated rigging/motion quality, CG lighting and shading language — do NOT describe a physical camera sensor or film grain, NOT live-action, NOT photoreal skin.
- "stop motion": describe practical handmade puppet/set texture, visible fingerprints or seams on models, slightly choppy ON-TWOS motion cadence (explicitly state the frame-stepped cadence, not smooth interpolated motion), physical practical lighting, tangible tactile materials (felt, clay, wood, fabric) — explicitly state NOT live-action, NOT photorealistic skin, NOT smooth digital motion blur, NOT a physical cinema camera/sensor.
- "anime": describe cel-shaded or modern anime rendering, line art quality, stylised expressive motion, appropriate anime lighting/color language — explicitly NOT live-action, NOT 3D CG.
- other styles the user might type (watercolor, claymation, pixel art, etc.): interpret the style's actual visual medium and describe camera/lens/grade/texture language authentic to THAT medium, with explicit negation of live-action/photoreal unless the style itself is photoreal.
Never let these four sections drift back into generic "live-action photographic realism" language unless the requested art style genuinely is realistic film/cinematic.

14. CONSTRAINT RECAP — the final section, one tight paragraph restating the hardest-to-hold rules in case the model's attention has drifted by this point in a long prompt: the exact art style name again, "one continuous take in strict chronological order, no flashbacks or reordering," the audio/music policy, that every character's identity and wardrobe stay exactly as locked with zero substitutions, and that no on-screen text needs to be legible. This repetition is deliberate — it is the last thing the model reads before generating.

HARD RULES:
- The identity of every uploaded-photo character must be locked to their EXACT given @image number — never invent or guess numbers.
- The chosen art style must be named explicitly and reinforced in at least 7 different places across the prompt (style lock, identity lock(s), audio section's opening line if natural, scene, constraint recap, and all four look-stack sections) — it must never be allowed to default back to live-action realism partway through.
- The timeline must play out in strict linear chronological order exactly as the story happens — no flashbacks, no flash-forwards, no reordering, no jumping between later and earlier moments. Every beat must follow directly from where the previous beat left off.
- Every single cut/beat must show something NEW that moves the story forward — never two consecutive beats covering the same action or moment from a different angle.
- Total timeline must add up to exactly the given duration in seconds — no more, no less.
- Never write specific on-screen text, signage, or UI copy for the model to render legibly — it reliably comes out garbled; describe such elements only by shape, color, or vague presence.
- Never sexualize minors. Never stage a real, named public figure's death/self-harm as fabricated fiction — use a fictional stand-in in the same setting if the story implies this.
- Keep dialogue short and lip-sync-friendly.`;

async function writeStoryPrompt({ story, duration, characters, environment, artStyle }) {
  let nextImageIndex = 1;
  const characterLines = characters.map((ch, i) => {
    if (ch.mode === 'upload') {
      const idx = nextImageIndex;
      nextImageIndex += 1;
      return `${i + 1}. ${ch.label} — has reference photo @image${idx}. Do not invent a different appearance.`;
    }
    return `${i + 1}. ${ch.label} — described as: ${ch.description}`;
  });

  let environmentLine = '(none provided — invent a fitting setting from the story)';
  if (environment?.mode === 'upload') {
    environmentLine =
      `Reference photo @image${nextImageIndex} — a LOCATION-ONLY reference with no people in it. ` +
      'Take the setting (layout, architecture, materials, lighting, atmosphere) from it, rebuilt in the art style. ' +
      'Do not add any person from this photo.';
  } else if (environment?.mode === 'describe') {
    environmentLine = `Described as: ${environment.description}`;
  }

  const userMessage =
    `${DIRECTOR_INSTRUCTIONS}\n\n` +
    `Target duration: ${duration} seconds (exactly)\n\n` +
    `Art style: ${artStyle}\n\n` +
    `Characters:\n${characterLines.join('\n') || '(none provided — invent characters as the story implies)'}\n\n` +
    `Environment:\n${environmentLine}\n\n` +
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

async function condensePrompt(prompt, targetChars) {
  const message =
    'Rewrite the following Seedance video prompt so it is at most ' + targetChars + ' characters, ' +
    'keeping every section header, every @image tag, the art style lock wording, all dialogue lines with their timecodes, ' +
    'and the full chronological beat-by-beat timeline (merge or shorten descriptive wording, never drop a beat or change the order). ' +
    'Output ONLY the rewritten prompt as plain text — no JSON, no commentary.\n\n' + prompt;
  const out = await callClaude(message);
  return out.replace(/^```\w*\s*/, '').replace(/```\s*$/, '').trim();
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
    costPerStyleImageUsd: COST_PER_STYLE_IMAGE_USD,
  });
});

app.get('/api/history', async (req, res) => {
  const history = await readJson(HISTORY_FILE, []);
  // Shared gallery: every visitor sees every finished video. Only non-sensitive fields are exposed.
  res.json(
    history
      .filter((entry) => entry.status === 'success')
      .map((e) => ({
        id: e.id,
        status: e.status,
        resultUrl: e.resultUrl,
        createdAt: e.createdAt,
        duration: e.duration,
        aspectRatio: e.aspectRatio,
        artStyle: e.artStyle,
        promptText: e.story,
        generationSeconds: e.generationSeconds,
      }))
  );
});

// Full details (including the long written prompt) for one finished video, fetched when it is opened.
app.get('/api/history/:id', async (req, res) => {
  const history = await readJson(HISTORY_FILE, []);
  const e = history.find((h) => h.id === req.params.id && h.status === 'success');
  if (!e) return res.status(404).json({ error: 'Not found.' });
  res.json({
    id: e.id,
    resultUrl: e.resultUrl,
    createdAt: e.createdAt,
    duration: e.duration,
    aspectRatio: e.aspectRatio,
    artStyle: e.artStyle,
    promptText: e.story,
    finalPrompt: e.finalPrompt,
    inputs: e.inputs,
    generationSeconds: e.generationSeconds,
  });
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
// Small preview copies of the photos used for a generation, kept alongside the video so the gallery
// can show what went in. The full-size staged uploads are still deleted after generation.
async function saveInputThumb(buffer) {
  const name = 'in-' + uuidv4() + '.jpg';
  await sharp(buffer)
    .rotate()
    .resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 72 })
    .toFile(path.join(GENERATED_DIR, name));
  return '/generated/' + name;
}

async function createStyledReference({ photoUrl, artStyle, kind, origin, tempUploadPaths }) {
  const prompt = kind === 'environment'
    ? 'Redraw the location in the reference photo as a ' + artStyle + ' environment: keep the same layout, architecture, ' +
      'materials, lighting mood and colour palette, but render it fully in ' + artStyle + ' style (the materials, shading and look ' +
      'of that medium). It must NOT look like a photograph. No people, no characters, no text.'
    : 'Redraw the person in the reference photo as a ' + artStyle + ' character. Keep their likeness: face shape, facial features, ' +
      'hairstyle and hair colour, skin tone, build and outfit. Render them fully in ' + artStyle + ' style (the materials, shading ' +
      'and proportions of that medium) — NOT a photograph, NOT photorealistic, NOT a real person. Single character, three-quarter ' +
      'body, plain neutral background, no text.';
  const taskId = await kieCreateTask(STYLE_IMAGE_MODEL, {
    prompt,
    image_input: [photoUrl],
    aspect_ratio: kind === 'environment' ? 'auto' : '3:4',
    output_format: 'jpg',
  });
  const resultUrl = await kiePollResult(taskId, { timeoutMs: 5 * 60 * 1000, intervalMs: 3000 });
  const fileName = uuidv4() + '.jpg';
  const destPath = path.join(UPLOADS_DIR, fileName);
  await downloadToFile(resultUrl, destPath);
  tempUploadPaths.push(destPath);
  return origin + '/uploads/' + fileName;
}

async function processStory({ id, story, duration, characters, environment, artStyle, aspectRatio, estimatedCost, origin, tempUploadPaths }) {
  try {
    const startedAt = Date.now();
    let styledCount = 0;
    if (!isRealisticStyle(artStyle)) {
      await updateHistoryEntry(id, { stage: 'styling characters' });
      const jobs = [];
      for (const ch of characters) {
        if (ch.mode !== 'upload') continue;
        jobs.push(
          createStyledReference({ photoUrl: ch.imageUrl, artStyle, kind: 'character', origin, tempUploadPaths })
            .then((url) => { ch.imageUrl = url; styledCount += 1; })
            .catch((err) => console.warn('character styling failed, using the original photo:', err.message))
        );
      }
      if (environment?.mode === 'upload') {
        jobs.push(
          createStyledReference({ photoUrl: environment.imageUrl, artStyle, kind: 'environment', origin, tempUploadPaths })
            .then((url) => { environment.imageUrl = url; styledCount += 1; })
            .catch((err) => console.warn('environment styling failed, using the original photo:', err.message))
        );
      }
      await Promise.all(jobs);
    }

    await updateHistoryEntry(id, { stage: 'writing prompt' });

    let promptResult;
    try {
      promptResult = await writeStoryPrompt({ story, duration, characters, environment, artStyle });
    } catch (err) {
      console.error('prompt generation failed:', err.message);
      throw new Error(`Could not write the story prompt: ${err.message}`);
    }

    await updateHistoryEntry(id, {
      stage: 'generating video',
      finalPrompt: promptResult.prompt,
      riskNote: promptResult.riskNote,
    });

    // Order must match the @image numbering used in writeStoryPrompt: uploaded characters first,
    // then the environment photo.
    const referenceImageUrls = characters
      .filter((ch) => ch.mode === 'upload')
      .map((ch) => ch.imageUrl);
    if (environment?.mode === 'upload') {
      referenceImageUrls.push(environment.imageUrl);
    }

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

    // Seedance rejects over-long prompts (more likely on 25-30s timelines). If that happens,
    // condense the prompt and retry rather than failing the user's generation.
    let resultVideoUrl;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const taskId = await kieCreateTask(SEEDANCE_MODEL, input);
        await updateHistoryEntry(id, { taskId });
        resultVideoUrl = await kiePollResult(taskId);
        break;
      } catch (err) {
        const msg = err.message || '';
        const tooLong = /(text|prompt)[^.]*length|length[^.]*maximum|too long/i.test(msg) && !/hourly|points|credits/i.test(msg);
        if (!tooLong || attempt >= 2) throw err;
        console.warn(`Seedance rejected a ${input.prompt.length}-char prompt (${err.message}); condensing and retrying.`);
        await updateHistoryEntry(id, { stage: 'writing prompt' });
        input.prompt = await condensePrompt(input.prompt, Math.floor(input.prompt.length * 0.6));
        await updateHistoryEntry(id, { stage: 'generating video', finalPrompt: input.prompt });
      }
    }

    const destFile = `${id}.mp4`;
    await downloadToFile(resultVideoUrl, path.join(GENERATED_DIR, destFile));
    const actualCost = duration * COST_PER_SECOND_USD + styledCount * COST_PER_STYLE_IMAGE_USD;
    const newTotal = await addSpend(actualCost);

    await updateHistoryEntry(id, {
      status: 'success',
      stage: 'done',
      resultUrl: `/generated/${destFile}`,
      spentTodayUsd: Number(newTotal.toFixed(4)),
      finishedAt: new Date().toISOString(),
      generationSeconds: Math.round((Date.now() - startedAt) / 1000),
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
  upload.any(),
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
      const fileFor = (fieldName) => (req.files || []).find((f) => f.fieldname === fieldName);
      const saveReferenceImage = async (file) => {
        const fileName = `${uuidv4()}.jpg`;
        const destPath = path.join(UPLOADS_DIR, fileName);
        await sharp(file.buffer)
          .rotate()
          .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 88 })
          .toFile(destPath);
        tempUploadPaths.push(destPath);
        return `${origin}/uploads/${fileName}`;
      };

      for (let i = 1; i <= MAX_CHARACTERS; i += 1) {
        const rawMode = req.body[`character${i}Mode`];
        const mode = rawMode === 'describe' ? 'describe' : rawMode === 'upload' ? 'upload' : null;
        if (!mode) continue; // this character slot wasn't used

        const label = `CHARACTER ${i}`;
        if (mode === 'upload') {
          const file = fileFor(`character${i}Photo`);
          if (!file) {
            return res.status(400).json({ error: `Upload a photo for Character ${i}, or switch it to Describe.` });
          }
          characters.push({ label, mode: 'upload', imageUrl: await saveReferenceImage(file), thumbUrl: await saveInputThumb(file.buffer) });
        } else {
          const description = (req.body[`character${i}Description`] || '').trim();
          if (!description) {
            return res.status(400).json({ error: `Describe Character ${i}, or switch it to Upload.` });
          }
          characters.push({ label, mode: 'describe', description });
        }
      }

      // Environment: a photo of the location (no people in it), a text description, or nothing.
      let environment = null;
      const envMode = req.body.environmentMode;
      if (envMode === 'upload') {
        const file = fileFor('environmentPhoto');
        if (!file) {
          return res.status(400).json({ error: 'Upload an environment photo, or switch it to Describe/Not used.' });
        }
        environment = { mode: 'upload', imageUrl: await saveReferenceImage(file), thumbUrl: await saveInputThumb(file.buffer) };
      } else if (envMode === 'describe') {
        const description = (req.body.environmentDescription || '').trim();
        if (!description) {
          return res.status(400).json({ error: 'Describe the environment, or switch it to Upload/Not used.' });
        }
        environment = { mode: 'describe', description };
      }

      // ---- budget check BEFORE spending anything ----
      let styleImageCount = 0;
      if (!isRealisticStyle(artStyle)) {
        styleImageCount = characters.filter((c) => c.mode === 'upload').length + (environment?.mode === 'upload' ? 1 : 0);
      }
      const estimatedCost = duration * COST_PER_SECOND_USD + styleImageCount * COST_PER_STYLE_IMAGE_USD;
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
        inputs: {
          characters: characters.map((c) => ({ label: c.label, mode: c.mode, thumbUrl: c.thumbUrl, description: c.description })),
          environment: environment ? { mode: environment.mode, thumbUrl: environment.thumbUrl, description: environment.description } : null,
        },
        status: 'pending',
        stage: 'starting',
        costUsd: estimatedCost,
      };
      await appendHistory(entry);

      res.json({ id, status: 'pending' });

      processStory({ id, story, duration, characters, environment, artStyle, aspectRatio, estimatedCost, origin, tempUploadPaths });
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

// ---------- delete a creation (login required; must type DELETE to confirm) ----------

app.delete('/api/history/:id', async (req, res) => {
  const { confirm } = req.body || {};
  if (confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Type DELETE to confirm.' });
  }
  const id = req.params.id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return res.status(400).json({ error: 'Bad id.' });
  }
  const history = await readJson(HISTORY_FILE, []);
  const entry = history.find((h) => h.id === id);
  if (!entry) {
    return res.status(404).json({ error: 'Creation not found.' });
  }
  if (entry.status === 'pending') {
    return res.status(409).json({ error: 'This creation is still generating. Wait for it to finish.' });
  }
  const files = [id + '.mp4'];
  const inputs = entry.inputs || {};
  const thumbs = [
    ...(inputs.characters || []).map((c) => c.thumbUrl),
    inputs.environment && inputs.environment.thumbUrl,
    ...(inputs.characterThumbs || []),
    ...(inputs.productThumbs || []),
  ].filter(Boolean);
  for (const t of thumbs) {
    const base = path.basename(t);
    if (/^in-[0-9a-f-]+\.jpg$/i.test(base)) files.push(base);
  }
  for (const f of files) {
    await fsp.unlink(path.join(GENERATED_DIR, f)).catch(() => {});
  }
  await writeJson(HISTORY_FILE, history.filter((h) => h.id !== id));
  res.json({ ok: true });
});

// If the server restarts (e.g. a redeploy) while videos are being made, the in-memory job dies but the
// kie.ai task keeps running. On boot: resume any job that already has a kie.ai task id, and fail the rest
// cleanly so the page shows a clear message instead of waiting forever.
async function recoverInterruptedJobs() {
  const history = await readJson(HISTORY_FILE, []);
  for (const e of history.filter((h) => h.status === 'pending')) {
    if (!e.taskId) {
      await updateHistoryEntry(e.id, {
        status: 'fail',
        stage: 'failed',
        error: 'This generation was interrupted by a server restart before the video was started. Please try again.',
      });
      continue;
    }
    console.log('Resuming interrupted generation ' + e.id + ' (kie.ai task ' + e.taskId + ')');
    (async () => {
      try {
        const videoUrl = await kiePollResult(e.taskId);
        const latest = (await readJson(HISTORY_FILE, [])).find((h) => h.id === e.id);
        if (!latest || latest.status === 'success') return;
        const destFile = e.id + '.mp4';
        await downloadToFile(videoUrl, path.join(GENERATED_DIR, destFile));
        const total = await addSpend(e.costUsd || 0);
        await updateHistoryEntry(e.id, {
          status: 'success',
          stage: 'done',
          resultUrl: '/generated/' + destFile,
          spentTodayUsd: Number(total.toFixed(4)),
          finishedAt: new Date().toISOString(),
          generationSeconds: Math.round((Date.now() - Date.parse(e.createdAt)) / 1000),
        });
      } catch (err) {
        await updateHistoryEntry(e.id, {
          status: 'fail',
          stage: 'failed',
          error: err.message || 'Generation failed after a server restart.',
        });
      }
    })();
  }
}

app.listen(PORT, () => {
  console.log(`Story Creator app running at http://localhost:${PORT}`);
  recoverInterruptedJobs().catch((err) => console.error('recovery failed:', err.message));
  if (!KIE_API_KEY) {
    console.warn('WARNING: KIE_API_KEY is not set. Copy .env.example to .env and add your kie.ai API key.');
  }
});
