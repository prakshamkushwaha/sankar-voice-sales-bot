# Sankar Group — AI Voice Sales Bot

A browser-based voice sales assistant for the fictional TaskFlow project-management SaaS.

## Features
- Live browser speech recognition (Chrome recommended) and spoken AI responses
- Start/end call controls, call timer and live transcript
- Optional consent-based microphone recording
- AI-generated call summary, requirements, objections, next steps and sales status
- SQLite-backed call history and saved recording playback

## Requirements
- Node.js 20+ recommended
- Google Gemini API key from https://aistudio.google.com/apikey
- Recent Chrome browser for speech recognition

## Run locally

### 1. Backend
```bash
cd backend
cp .env.example .env
# Edit .env and set GEMINI_API_KEY
npm install
npm run dev
```
Windows PowerShell:
```powershell
Copy-Item .env.example .env
notepad .env
```

### 2. Frontend (second terminal)
```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```
Open the URL Vite prints, usually http://localhost:5173.

## Product information
TaskFlow is a fictional demo product. Prices ($9/user/month Starter and $19/user/month Team) and the 14-day trial are sample data for this assignment, not a real offer.

## Important limitations and deployment notes
- Browser speech recognition support varies. Chrome is recommended; recognition may use a browser-provided online service.
- This is a browser microphone application, not a telephone dialer.
- The backend stores SQLite data in `backend/data/calls.db` and recordings in `backend/recordings`. On cloud hosting, mount persistent storage at these paths or update `DB_PATH` and `RECORDINGS_DIR`.
- Before public use with real customers, add authentication, per-user authorization, rate limits, secure recording access, retention controls, and appropriate privacy/legal notices. This starter app is not production-hardened.
- Obtain the participant's explicit consent before recording. The checkbox is a consent workflow for the prototype, not a substitute for legally appropriate consent procedures.
- Never commit `.env`, API keys, database files or recordings.
