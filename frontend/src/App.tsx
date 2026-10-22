import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, Bot, CheckCircle2, Clock3, Headphones,
  History, LoaderCircle, Mic, Phone, PhoneOff,
  Play, Volume2, X
} from "lucide-react";
import type { CallRecord, TranscriptMessage } from "./types";
import "./App.css";

const API = (import.meta.env.VITE_API_URL || "http://localhost:5000").replace(/\/$/, "");
type RecognitionAlternative = { transcript: string };
type RecognitionResult = ArrayLike<RecognitionAlternative> & { isFinal: boolean };
type RecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
};
type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void; stop: () => void; abort: () => void;
};
type RecognitionConstructor = new () => Recognition;
declare global {
  interface Window {
    SpeechRecognition?: RecognitionConstructor;
    webkitSpeechRecognition?: RecognitionConstructor;
  }
}
function formatTime(seconds: number) {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
function prettyDate(value: string) { return new Date(value).toLocaleString(); }
async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${url}`, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export default function App() {
  const [calls, setCalls] = useState<CallRecord[]>([]);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [duration, setDuration] = useState(0);
  const [active, setActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recordConsent, setRecordConsent] = useState(false);
  const [recording, setRecording] = useState(false);
  const [partial, setPartial] = useState("");
  const [status, setStatus] = useState("Ready to start");
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<CallRecord | null>(null);
  const [tab, setTab] = useState<"call" | "history">("call");
  const callId = useRef("");
  const startedAt = useRef(0);
  const recognition = useRef<Recognition | null>(null);
  const activeRef = useRef(false);
  const speaking = useRef(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const audioChunks = useRef<Blob[]>([]);
  const mediaStream = useRef<MediaStream | null>(null);
  const consentRef = useRef(false);
  const messagesRef = useRef<TranscriptMessage[]>([]);
  const busyRef = useRef(false);
  const stoppingRef = useRef(false);
  const savingRef = useRef(false);

  const refreshCalls = useCallback(async () => {
    try { setCalls(await api<CallRecord[]>("/api/calls")); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load history."); }
  }, []);
  useEffect(() => { void refreshCalls(); }, [refreshCalls]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setDuration(Math.floor((Date.now() - startedAt.current) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  const addMessage = useCallback((role: TranscriptMessage["role"], text: string) => {
    const item = { role, text, time: new Date().toISOString() };
    messagesRef.current = [...messagesRef.current, item];
    setMessages(messagesRef.current);
  }, []);

  const speak = useCallback((text: string) => new Promise<void>(resolve => {
    if (!("speechSynthesis" in window)) { resolve(); return; }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US"; utterance.rate = 1;
    utterance.onstart = () => { speaking.current = true; setStatus("AI speaking"); };
    utterance.onend = () => { speaking.current = false; resolve(); };
    utterance.onerror = () => { speaking.current = false; resolve(); };
    window.speechSynthesis.speak(utterance);
  }), []);

  const handleCustomerSpeech = useCallback(async (text: string) => {
    if (!activeRef.current || busyRef.current || !text.trim()) return;
    busyRef.current = true; setBusy(true); setPartial(""); addMessage("customer", text.trim()); setStatus("Thinking");
    try {
      const history = messagesRef.current.slice(-12).map(m => ({
        role: m.role === "customer" ? "user" : "model", text: m.text
      }));
      history.pop();
      const result = await api<{ reply: string }>("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text.trim(), history })
      });
      if (!activeRef.current) return;
      addMessage("assistant", result.reply);
      await speak(result.reply);
      setStatus("Listening");
    } catch (e) {
      setError(e instanceof Error ? e.message : "AI request failed."); setStatus("Response error");
    } finally {
      busyRef.current = false; setBusy(false);
      if (activeRef.current && !speaking.current && recognition.current) {
        try { recognition.current.start(); } catch { /* already started */ }
      }
    }
  }, [addMessage, speak]);

  const startCall = async () => {
    setError(""); setMessages([]); messagesRef.current = []; audioChunks.current = [];
    stoppingRef.current = false; savingRef.current = false; setDuration(0);
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setError("Speech recognition is unavailable. Use a recent Chrome browser and allow microphone access."); return;
    }
    try {
      if (recordConsent) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStream.current = stream;
        const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
        const mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
        recorder.current = mediaRecorder;
        mediaRecorder.ondataavailable = event => { if (event.data.size > 0) audioChunks.current.push(event.data); };
        mediaRecorder.start(1000); setRecording(true);
      }
      const created = await api<{ id: string }>("/api/calls", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordingConsent: recordConsent })
      });
      callId.current = created.id; consentRef.current = recordConsent; startedAt.current = Date.now();
      activeRef.current = true; setActive(true); setStatus("Listening");
      const agent = new SpeechRecognition();
      agent.lang = "en-US"; agent.continuous = true; agent.interimResults = true;
      agent.onresult = event => {
        let interim = ""; const finals: string[] = [];
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          const transcript = result[0]?.transcript ?? "";

          if (result.isFinal) {
            finals.push(transcript);
          } else {
            interim += transcript;
          }
        }
        setPartial(interim);
        if (finals.length && activeRef.current && !busyRef.current) void handleCustomerSpeech(finals.join(" "));
      };
      agent.onerror = event => {
        if (event.error !== "no-speech" && event.error !== "aborted") setError(`Speech recognition: ${event.error}`);
      };
      agent.onend = () => {
        if (activeRef.current && !speaking.current && !busyRef.current) {
          window.setTimeout(() => {
            if (activeRef.current && !speaking.current && !busyRef.current) try { agent.start(); } catch { /* already running */ }
          }, 250);
        }
      };
      recognition.current = agent; agent.start();
      const greeting = "Hello! I'm the TaskFlow AI sales assistant. I can explain our project-management plans and help you find the right option. How does your team currently manage projects?";
      addMessage("assistant", greeting); await speak(greeting);
      if (activeRef.current) setStatus("Listening");
    } catch (e) {
      activeRef.current = false; setActive(false);
      mediaStream.current?.getTracks().forEach(track => track.stop()); mediaStream.current = null;
      setError(e instanceof Error ? e.message : "Could not start the call."); setStatus("Unable to start");
    }
  };

  const endCall = useCallback(async () => {
    if (stoppingRef.current || savingRef.current || !callId.current) return;
    stoppingRef.current = true; savingRef.current = true; activeRef.current = false;
    setActive(false); setBusy(false); busyRef.current = false;
    window.speechSynthesis?.cancel(); speaking.current = false;
    try { recognition.current?.stop(); } catch { /* ignored */ }
    recognition.current = null; setStatus("Saving call");
    const elapsed = Math.floor((Date.now() - startedAt.current) / 1000);
    const currentRecorder = recorder.current;
    const save = async (blob?: Blob) => {
      try {
        const form = new FormData();
        form.append("transcript", JSON.stringify(messagesRef.current));
        form.append("durationSeconds", String(elapsed));
        if (blob && consentRef.current) form.append("recording", blob, "call.webm");
        const completed = await api<CallRecord>(`/api/calls/${callId.current}/finish`, { method: "POST", body: form });
        setSelected(completed); setTab("history"); await refreshCalls(); setStatus("Call saved");
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not save call."); setStatus("Save failed");
      } finally {
        mediaStream.current?.getTracks().forEach(track => track.stop()); mediaStream.current = null;
        recorder.current = null; callId.current = ""; stoppingRef.current = false; savingRef.current = false; setRecording(false);
      }
    };
    if (currentRecorder?.state === "recording") {
      currentRecorder.onstop = () => void save(new Blob(audioChunks.current, { type: currentRecorder.mimeType || "audio/webm" }));
      currentRecorder.stop();
    } else void save();
  }, [refreshCalls]);

  useEffect(() => {
    const handleUnload = () => {
      activeRef.current = false; window.speechSynthesis?.cancel();
      try { recognition.current?.abort(); } catch { /* ignored */ }
      mediaStream.current?.getTracks().forEach(track => track.stop());
    };
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("beforeunload", handleUnload); window.speechSynthesis?.cancel();
      try { recognition.current?.abort(); } catch { /* ignored */ }
      mediaStream.current?.getTracks().forEach(track => track.stop());
    };
  }, []);

  const playRecording = (id: string) => {
    const audio = new Audio(`${API}/api/calls/${id}/audio`);
    void audio.play().catch(() => setError("Could not play this recording."));
  };
  const converted = calls.filter(c => c.status === "Converted").length;
  const demos = calls.filter(c => c.status === "Demo Requested").length;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-icon"><Activity size={22}/></div><div><strong>TaskFlow</strong><small>AI SALES CONSOLE</small></div></div>
      <div className="nav-label">WORKSPACE</div>
      <button className={tab === "call" ? "nav-item active" : "nav-item"} onClick={() => { setTab("call"); setSelected(null); }}><Phone size={18}/> Live sales call</button>
      <button className={tab === "history" ? "nav-item active" : "nav-item"} onClick={() => setTab("history")}><History size={18}/> Call history</button>
      <div className="sidebar-bottom"><span className="online-dot"/> AI service configured<small>TaskFlow demo environment</small></div>
    </aside>
    <main className="main-content">
      <header className="topbar"><div><div className="eyebrow">SANKAR GROUP · INTERN ASSIGNMENT</div><h1>AI Voice Sales Bot</h1></div><div className="top-status"><span className={active ? "pulse-dot" : "idle-dot"}/>{active ? "Call in progress" : status}</div></header>
      {error && <div className="error-banner"><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error"><X size={16}/></button></div>}
      <section className="metrics">
        <div className="metric-card"><span>Total calls</span><History size={19}/><strong>{calls.length}</strong><small>Saved conversations</small></div>
        <div className="metric-card"><span>Converted</span><CheckCircle2 size={19}/><strong>{converted}</strong><small>Explicit purchase commitments</small></div>
        <div className="metric-card"><span>Demo requests</span><Activity size={19}/><strong>{demos}</strong><small>Customers asking for a demo</small></div>
      </section>
      {tab === "call" ? <section className="workspace">
        <div className="call-panel panel">
          <div className="panel-heading"><div><h2>Live conversation</h2><p>Talk naturally with your AI sales representative.</p></div><span className={active ? "live-badge" : "ready-badge"}>{active ? "LIVE" : "READY"}</span></div>
          <div className="agent-area"><div className={active ? "agent-orb active-orb" : "agent-orb"}><Bot size={40} strokeWidth={1.5}/></div><h3>TaskFlow Sales Assistant</h3><p>{active ? (busy ? "Preparing a response..." : "Speak naturally to the AI agent.") : "Your AI sales agent is ready."}</p><div className="call-clock"><Clock3 size={16}/>{formatTime(duration)}</div><div className="status-line"><span className={active ? "pulse-dot" : "idle-dot"}/>{status}</div></div>
          {!active && <label className="consent-box"><input type="checkbox" checked={recordConsent} onChange={e => setRecordConsent(e.target.checked)}/><span><strong>Enable call recording</strong><small>Inform the participant and obtain explicit consent before recording. Audio will be saved for playback.</small></span></label>}
          <div className="call-actions">{!active ? <button className="primary-button" onClick={() => void startCall()} disabled={busy}><Phone size={18}/> Start call</button> : <button className="danger-button" onClick={() => void endCall()}><PhoneOff size={18}/> End call</button>}{recording && <span className="recording-indicator"><span/> REC</span>}</div>
          <p className="privacy-note">Browser speech recognition may use an online service. Recording is optional and only enabled when consent is selected.</p>
        </div>
        <div className="transcript-panel panel">
          <div className="panel-heading"><div><h2>Conversation transcript</h2><p>Customer and AI messages</p></div><span className="message-count">{messages.length} messages</span></div>
          <div className="transcript-list">
            {messages.length === 0 && <div className="empty-state"><Headphones size={32}/><strong>No conversation yet</strong><span>Start a call to see messages appear here.</span></div>}
            {messages.map((message, index) => <div className={`message ${message.role}`} key={`${message.time}-${index}`}><div className="message-avatar">{message.role === "assistant" ? <Bot size={16}/> : <Mic size={16}/>}</div><div className="message-body"><div className="message-meta"><strong>{message.role === "assistant" ? "TaskFlow AI" : "Customer"}</strong><time>{new Date(message.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div><p>{message.text}</p></div></div>)}
            {partial && <div className="partial-transcript">Listening: {partial}…</div>}
            {busy && <div className="thinking"><LoaderCircle size={16}/> AI is thinking…</div>}
          </div>
          <div className="transcript-footer"><Volume2 size={16}/> Speak clearly in English. Allow microphone access when prompted.</div>
        </div>
      </section> : <section className="history-panel panel">
        <div className="panel-heading"><div><h2>Call history</h2><p>Review completed conversations and sales outcomes.</p></div><button className="secondary-button" onClick={() => void refreshCalls()}>Refresh history</button></div>
        {selected && <div className="detail-card"><button className="close-detail" onClick={() => setSelected(null)} aria-label="Close details"><X size={18}/></button><h3>Call summary</h3><p>{selected.summary || "No summary available."}</p><div className="detail-columns"><div><strong>Requirements</strong><ul>{selected.requirements.map((x, i) => <li key={i}>{x}</li>)}</ul></div><div><strong>Objections</strong><ul>{selected.objections.map((x, i) => <li key={i}>{x}</li>)}</ul></div></div><strong>Next steps</strong><p>{selected.next_steps || "No next step provided."}</p><strong>Transcript</strong><div className="saved-transcript">{selected.transcript.map((m, i) => <p key={i}><b>{m.role === "assistant" ? "AI" : "Customer"}:</b> {m.text}</p>)}</div>{selected.recordingAvailable ? <audio controls preload="none" src={`${API}/api/calls/${selected.id}/audio`}/> : <p className="privacy-note">No recording was saved for this call.</p>}</div>}
        <div className="history-table-wrap"><table><thead><tr><th>Call date</th><th>Duration</th><th>Status</th><th>Summary</th><th>Recording</th><th>Details</th></tr></thead><tbody>
          {calls.map(call => <tr key={call.id}><td>{prettyDate(call.created_at)}</td><td>{formatTime(call.duration_seconds)}</td><td><span className={`status-pill ${call.status.toLowerCase().replaceAll(" ", "-")}`}>{call.status}</span></td><td className="summary-cell">{call.summary || "Not analyzed"}</td><td>{call.recordingAvailable ? <button className="icon-button" onClick={() => playRecording(call.id)} title="Play recording"><Play size={17}/></button> : "—"}</td><td><button className="text-button" onClick={() => setSelected(call)}>View details</button></td></tr>)}
          {calls.length === 0 && <tr><td colSpan={6}>No saved calls yet. Complete a call to see it here.</td></tr>}
        </tbody></table></div>
      </section>}
      <footer className="page-footer">TaskFlow · AI Voice Sales Bot · Sankar Group assignment</footer>
    </main>
  </div>;
}
