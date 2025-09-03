import express from "express";
import multer from "multer";
import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { FATE_SERVER } from "./constants/api";

dotenv.config();

const PORT = process.env.PORT || 8080;
const MODEL = process.env.MODEL || "gemini-2.5-flash";
const CACHE_TTL_SECONDS = Number(process.env.CACHE_TTL_SECONDS || 60 * 60 * 24 * 30); // default 30d

const app = express();
app.use(express.json());

const upload = multer({ storage: multer.memoryStorage() });

const SCHEMA_PATH = path.resolve("./schema.json");
const PROMPT_PATH = path.resolve("./ilp_extraction_prompt.txt");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Keep cache name in memory (and persist to file for restarts)
const CACHE_META_PATH = path.resolve("./.cache.json");
let cachedName = null;

async function loadSchema() {
  const raw = await fs.readFile(SCHEMA_PATH, "utf-8");
  return JSON.parse(raw);
}

async function ensureCache() {
  try {
    // If we have a stored cache name, use it
    try {
      const raw = await fs.readFile(CACHE_META_PATH, "utf-8");
      const meta = JSON.parse(raw);
      if (meta && meta.name) {
        cachedName = meta.name;
        return cachedName;
      }
    } catch { }

    // Create a new cache from prompt
    const prompt = await fs.readFile(PROMPT_PATH, "utf-8");
    const caches = genAI.caches;
    const created = await caches.create({
      model: MODEL,
      displayName: "ilp_extraction_rules_v1",
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      ttlSeconds: CACHE_TTL_SECONDS,
    });
    cachedName = created.name;
    await fs.writeFile(CACHE_META_PATH, JSON.stringify({ name: cachedName }, null, 2), "utf-8");
    return cachedName;
  } catch (err) {
    console.error("Cache creation failed (continuing without cache):", err?.message || err);
    cachedName = null;
    return null;
  }
}

app.get("/ilpCheck", (req, res) => {
  res.json({ ok: true, model: MODEL, cached: Boolean(cachedName) });
});

app.post("/cache/rebuild", async (req, res) => {
  try {
    await fs.unlink(CACHE_META_PATH).catch(() => { });
    const name = await ensureCache();
    res.json({ ok: true, cachedContent: name });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.post("/extract", upload.single("pdf"), async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(400).json({ error: "Missing GEMINI_API_KEY" });
    }
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: "Upload a PDF in form-data with field name 'pdf'." });
    }
    if (file.mimetype !== "application/pdf") {
      return res.status(400).json({ error: "Only application/pdf is supported." });
    }

    // Ensure we have cache (optional; proceed even if fails)
    await ensureCache();

    const schema = await loadSchema();
    const model = genAI.getGenerativeModel({
      model: MODEL,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema
      },
      systemInstruction: "Return ONLY JSON per the response schema."
    });

    const inlineData = {
      mimeType: "application/pdf",
      data: file.buffer.toString("base64"),
    };

    const request = {
      contents: [{
        role: "user",
        parts: [
          { text: "Extract the required fields for the calculator." },
          { inlineData }
        ]
      }]
    };

    if (cachedName) {
      request.cachedContent = cachedName;
    } else {
      // If cache failed, prepend the full prompt inline as a fallback
      const prompt = await fs.readFile(PROMPT_PATH, "utf-8");
      request.contents[0].parts.unshift({ text: prompt });
    }

    const result = await model.generateContent(request);
    const text = result?.response?.text?.() || "{}";

    // Validate JSON parsing
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (e) {
      return res.status(502).json({ error: "Model did not return valid JSON", raw: text });
    }

    res.json({ ok: true, data: payload });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: String(e) });
  }
});

// Start server
app.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  await ensureCache(); // try to warm cache on boot
  startHealthCheck(`${FATE_SERVER}/fateCheck`);
});
