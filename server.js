
import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI, createPartFromUri } from "@google/genai";
import mammoth from "mammoth";

// If these exist in your project, they'll work; otherwise the try/catch below prevents crashes.
import { startHealthCheck } from "./healthcheck/checker.js";
import { FATE_SERVER } from "./constants/api.js";

dotenv.config();

const PORT = process.env.PORT || 8080;
// Cheapest default; override via env if you want full flash
const MODEL = process.env.MODEL || "gemini-2.5-flash-lite";
// Keep the inline payload small enough to stay under ~20MB request after base64 + prompt
const MAX_INLINE_BYTES = Number(process.env.MAX_INLINE_BYTES || 14 * 1024 * 1024);

const app = express();
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const SCHEMA_PATH = path.resolve("./schema.json");

// Prefer GOOGLE_API_KEY, fallback GEMINI_API_KEY
const API_KEY = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: API_KEY });

const IMAGE_MIMES = new Set([
  "image/png", "image/jpeg", "image/webp", "image/heic", "image/heif",
]);
const TEXTY_MIMES = new Set([
  "text/plain", "text/csv", "application/json",
]);
const DIRECT_DOC_MIMES = new Set([
  "application/pdf",
]);

// Compact, cheap system instruction (no caching needed)
const MICRO_PROMPT = `Return ONLY JSON that matches responseSchema.
Percents as 55 (not 0.55), round ≤2dp.
Missing required → 0. allocation_schedule_pct must be exactly 3 items: {year:1},{year:2},{year:3}. If unknown use [40,80,95].
Bonuses: pick tier for S$12k/yr if banded; else headline.
headline_gross_return_pct: use marketed illustration (if multiple, use higher).
Source precedence: Contract/Product Summary/PHS > brochure > fund factsheet.
Ignore COI/riders/switch/surrender/fees.`;

async function loadSchema() {
  const raw = await fs.readFile(SCHEMA_PATH, "utf-8");
  return JSON.parse(raw);
}

// Build model "parts" from an uploaded file (type + size aware)
async function buildPartsFromUpload(file) {
  const mt = file.mimetype;
  const size = file.size || file.buffer?.length || 0;

  // 1) PDFs & images → inline if small, else Files API
  if (DIRECT_DOC_MIMES.has(mt) || IMAGE_MIMES.has(mt)) {
    if (size <= MAX_INLINE_BYTES) {
      return [{ inlineData: { mimeType: mt, data: file.buffer.toString("base64") } }];
    }
    const tmp = `/tmp/${Date.now()}-${(file.originalname || "upload").replace(/\s+/g, "_")}`;
    await fs.writeFile(tmp, file.buffer);
    try {
      const uploaded = await ai.files.upload({ file: tmp, config: { mimeType: mt } });
      return [createPartFromUri(uploaded.uri, uploaded.mimeType)];
    } finally {
      await fs.unlink(tmp).catch(() => { });
    }
  }

  // 2) Text-like → send as text if small, else Files API
  if (TEXTY_MIMES.has(mt)) {
    if (size <= MAX_INLINE_BYTES) {
      const txt = file.buffer.toString("utf-8");
      return [{ text: txt }];
    }
    const tmp = `/tmp/${Date.now()}-${(file.originalname || "upload.txt").replace(/\s+/g, "_")}`;
    await fs.writeFile(tmp, file.buffer);
    try {
      const uploaded = await ai.files.upload({ file: tmp, config: { mimeType: mt } });
      return [createPartFromUri(uploaded.uri, uploaded.mimeType)];
    } finally {
      await fs.unlink(tmp).catch(() => { });
    }
  }

  // 3) DOCX → extract to text (pure JS) → send as text
  if (mt === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    const { value } = await mammoth.extractRawText({ buffer: file.buffer });
    const txt = (value || "").trim();
    if (!txt) throw new Error("DOCX parsed but produced empty text.");
    return [{ text: txt }];
  }

  const supported = [
    ...DIRECT_DOC_MIMES,
    ...IMAGE_MIMES,
    ...TEXTY_MIMES,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document (DOCX)",
  ];
  throw new Error(`Unsupported file type: \${mt}. Supported: \${supported.join(", ")}. Convert PPTX/others to PDF or TXT first.`);
}

// Accept both field names: "file" (preferred) and "pdf" (legacy)
const uploadEither = upload.fields([{ name: "file", maxCount: 1 }, { name: "pdf", maxCount: 1 }]);
function getUploadedFile(req) {
  return (req.files && req.files.file && req.files.file[0]) ||
    (req.files && req.files.pdf && req.files.pdf[0]) ||
    req.file || null;
}

app.get("/ilpCheck", (_req, res) => {
  res.json({ ok: true, model: MODEL, maxInlineBytes: MAX_INLINE_BYTES });
});

// JS-only: wrap Multer to avoid TS overload issues in mixed projects
function uploadEitherWrapped(req, res, next) {
  uploadEither(req, res, (err) => {
    if (err) return res.status(400).json({ error: String(err) });
    next();
  });
}

app.post("/extract", uploadEitherWrapped, async (req, res) => {
  try {
    if (!API_KEY) return res.status(400).json({ error: "Missing GOOGLE_API_KEY (or GEMINI_API_KEY)" });

    const file = getUploadedFile(req);
    if (!file) {
      return res.status(400).json({ error: "Upload in multipart/form-data under field 'file' (or legacy 'pdf')." });
    }

    const fileParts = await buildPartsFromUpload(file);
    const schema = await loadSchema();

    const result = await ai.models.generateContent({
      model: MODEL,
      contents: [{
        role: "user",
        parts: [
          { text: "Extract the required fields for the calculator." },
          ...fileParts
        ]
      }],
      config: {
        systemInstruction: { role: "user", parts: [{ text: MICRO_PROMPT }] },
        responseMimeType: "application/json",
        responseSchema: schema,
      }
    });

    const text = result?.text || "{}";
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      return res.status(502).json({ error: "Model did not return valid JSON", raw: text });
    }

    res.json({ ok: true, data: payload });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  try {
    startHealthCheck(`${FATE_SERVER}/fateCheck`);
  } catch (e) {
    console.warn("Healthcheck not started:", e?.message || e);
  }
});