import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import Database from "better-sqlite3";
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.dirname(process.env.DB_PATH || path.join(ROOT, "data", "calls.db"));
const RECORDINGS = process.env.RECORDINGS_DIR || path.join(ROOT, "recordings");
const TEMP_DIR = path.join(ROOT, "tmp");
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(RECORDINGS, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

const app = express();
const PORT = Number(process.env.PORT || 5000);
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.includes("paste_your")) {
  console.error("Set GEMINI_API_KEY in backend/.env before starting the server.");
  process.exit(1);
}
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
app.use(cors({ origin: (process.env.FRONTEND_URL || "http://localhost:5173").split(",").map(s => s.trim()) }));
app.use(express.json({ limit: "1mb" }));

const db = new Database(process.env.DB_PATH || path.join(ROOT, "data", "calls.db"));
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS calls (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  transcript TEXT NOT NULL DEFAULT '[]', summary TEXT NOT NULL DEFAULT '',
  requirements TEXT NOT NULL DEFAULT '[]', objections TEXT NOT NULL DEFAULT '[]',
  next_steps TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'Follow-up Required',
  recording_file TEXT, recording_consent INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0
)`);
const STATUSES = ["Converted", "Interested", "Follow-up Required", "Not Interested", "Demo Requested", "No Response"];
const PRODUCT_INFO = `
You are the honest, helpful AI sales representative for TaskFlow, a fictional project-management SaaS.
Features: task boards, project timelines, team assignments, due dates, progress dashboards and collaboration.
Sample demo prices: Starter $9/user/month; Team $19/user/month. A 14-day demo trial is available in this prototype.
These prices are illustrative only. Never claim a real purchase, payment, booking or CRM action occurred.
Do not invent integrations, security certifications or capabilities. Ask about team size and current project challenges.
Handle objections respectfully and do not pressure customers. Keep spoken replies conversational and preferably under 70 words.
`;
function parseJson(text) {
  return JSON.parse(String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
}
function safeCall(row) {
  if (!row) return null;
  return {
    ...row,
    transcript: JSON.parse(row.transcript || "[]"),
    requirements: JSON.parse(row.requirements || "[]"),
    objections: JSON.parse(row.objections || "[]"),
    recordingAvailable: Boolean(row.recording_file)
  };
}
const upload = multer({
  dest: TEMP_DIR, limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("audio/") || file.mimetype === "video/webm") cb(null, true);
    else cb(new Error("Only audio recordings are accepted."));
  }
});
app.get("/api/health", (_req, res) => res.json({ ok: true, service: "TaskFlow AI Sales Bot" }));

app.post("/api/chat", async (req, res) => {
  try {
    const { message, history = [] } = req.body || {};
    if (typeof message !== "string" || !message.trim()) return res.status(400).json({ error: "A message is required." });
    const safeHistory = Array.isArray(history) ? history.slice(-12).filter(item =>
      ["user", "model"].includes(item?.role) && typeof item?.text === "string"
    ).map(item => ({ role: item.role, parts: [{ text: item.text.slice(0, 2000) }] })) : [];
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [...safeHistory, { role: "user", parts: [{ text: message.trim().slice(0, 2000) }] }],
      config: {
        systemInstruction: PRODUCT_INFO + "\nIdentify yourself as TaskFlow's AI sales assistant when appropriate. Be honest and ask one useful question at a time.",
        maxOutputTokens: 220, temperature: 0.5
      }
    });
    const reply = response.text?.trim();
    if (!reply) throw new Error("The AI returned an empty response.");
    res.json({ reply });
  } catch (error) {
    console.error("Chat error:", error.message);
    res.status(502).json({ error: "The AI could not respond. Check your API key/model and try again." });
  }
});
app.get("/api/calls", (_req, res) => {
  const rows = db.prepare("SELECT * FROM calls ORDER BY created_at DESC LIMIT 100").all();
  res.json(rows.map(safeCall));
});
app.get("/api/calls/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM calls WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Call not found." });
  res.json(safeCall(row));
});
app.post("/api/calls", (req, res) => {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const consent = req.body?.recordingConsent === true;
  db.prepare("INSERT INTO calls (id, created_at, recording_consent) VALUES (?, ?, ?)")
    .run(id, createdAt, consent ? 1 : 0);
  res.status(201).json({ id, createdAt });
});
app.post("/api/calls/:id/finish", upload.single("recording"), async (req, res) => {
  const tempPath = req.file?.path;
  let savedAudioPath = null;
  try {
    const existing = db.prepare("SELECT * FROM calls WHERE id = ?").get(req.params.id);
    if (!existing) return res.status(404).json({ error: "Call not found." });
    if (existing.completed) return res.status(409).json({ error: "Call already completed." });
    const transcript = JSON.parse(req.body.transcript || "[]");
    if (!Array.isArray(transcript) || transcript.length > 500) return res.status(400).json({ error: "Invalid transcript." });
    const cleanTranscript = transcript.map(item => ({
      role: item.role === "assistant" ? "assistant" : "customer",
      text: String(item.text || "").slice(0, 3000),
      time: String(item.time || "")
    }));
    const duration = Math.max(0, Math.min(86400, Number(req.body.durationSeconds) || 0));
    let recordingFile = null;
    if (req.file) {
      if (!existing.recording_consent) return res.status(403).json({ error: "Recording consent was not granted." });
      const ext = req.file.mimetype.includes("mp4") ? ".m4a" : ".webm";
      recordingFile = `${existing.id}${ext}`;
      savedAudioPath = path.join(RECORDINGS, recordingFile);
      fs.renameSync(tempPath, savedAudioPath);
    }
    const transcriptText = cleanTranscript.map(item => `${item.role}: ${item.text}`).join("\n");
    let analysis = {
      summary: "Call ended before a detailed analysis was available.",
      requirements: [], objections: [], status: "Follow-up Required",
      next_steps: "Review the transcript and contact the customer if appropriate."
    };
    if (transcriptText.trim()) {
      try {
        const result = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: `Analyze this TaskFlow SaaS sales call. Return only valid JSON with summary (string), requirements (array of strings), objections (array of strings), status (one of ${STATUSES.join(", ")}), next_steps (string). Use only transcript evidence. Converted means explicit purchase commitment. Demo Requested means the customer explicitly asks for a demo. Interested means clear interest without commitment. Follow-up Required means later contact or more information is needed. Not Interested means clear rejection. No Response means no usable customer reply. If evidence is insufficient, choose Follow-up Required. Do not invent completed actions.\n\nTranscript:\n${transcriptText.slice(0, 14000)}`,
          config: { responseMimeType: "application/json", maxOutputTokens: 700, temperature: 0.1 }
        });
        const parsed = parseJson(result.text);
        if (typeof parsed.summary === "string") analysis.summary = parsed.summary.slice(0, 2000);
        if (Array.isArray(parsed.requirements)) analysis.requirements = parsed.requirements.slice(0, 20).map(x => String(x).slice(0, 500));
        if (Array.isArray(parsed.objections)) analysis.objections = parsed.objections.slice(0, 20).map(x => String(x).slice(0, 500));
        if (typeof parsed.next_steps === "string") analysis.next_steps = parsed.next_steps.slice(0, 2000);
        if (STATUSES.includes(parsed.status)) analysis.status = parsed.status;
      } catch (e) {
        console.error("Call analysis failed:", e.message);
        analysis.summary = "AI analysis was unavailable. Review the transcript manually.";
      }
    } else {
      analysis.status = "No Response";
      analysis.summary = "No usable conversation was captured.";
      analysis.next_steps = "Check the connection and retry if appropriate.";
    }
    db.prepare(`UPDATE calls SET duration_seconds=?, transcript=?, summary=?, requirements=?,
      objections=?, next_steps=?, status=?, recording_file=?, completed=1 WHERE id=?`)
      .run(duration, JSON.stringify(cleanTranscript), analysis.summary, JSON.stringify(analysis.requirements),
        JSON.stringify(analysis.objections), analysis.next_steps, analysis.status, recordingFile, existing.id);
    res.json(safeCall(db.prepare("SELECT * FROM calls WHERE id = ?").get(existing.id)));
  } catch (error) {
    if (savedAudioPath && fs.existsSync(savedAudioPath)) fs.unlinkSync(savedAudioPath);
    console.error("Finish call error:", error.message);
    res.status(500).json({ error: "Could not save and analyze this call." });
  } finally {
    if (tempPath && fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
});
app.get("/api/calls/:id/audio", (req, res) => {
  const row = db.prepare("SELECT recording_file, recording_consent FROM calls WHERE id = ?").get(req.params.id);
  if (!row?.recording_file || !row.recording_consent) return res.status(404).json({ error: "Recording not available." });
  const audioPath = path.join(RECORDINGS, path.basename(row.recording_file));
  if (!fs.existsSync(audioPath)) return res.status(404).json({ error: "Audio file not found." });
  res.setHeader("Cache-Control", "no-store");
  res.sendFile(audioPath);
});
app.use((error, _req, res, _next) => {
  console.error(error.message);
  res.status(400).json({ error: error.message || "Request failed." });
});
app.listen(PORT, () => console.log(`TaskFlow API running at http://localhost:${PORT}`));
