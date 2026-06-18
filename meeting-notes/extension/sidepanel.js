// sidepanel.js — UI logic: start/stop, live transcript, notes, persistence.

const BACKEND_URL = "http://localhost:8000";

// --- DOM refs -------------------------------------------------------------- //
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const clearBtn = document.getElementById("clearBtn");
const generateBtn = document.getElementById("generateBtn");
const copyBtn = document.getElementById("copyBtn");
const downloadBtn = document.getElementById("downloadBtn");

const recordingRow = document.getElementById("recordingRow");
const meters = document.getElementById("meters");
const tabLevel = document.getElementById("tabLevel");
const micLevel = document.getElementById("micLevel");
const timerEl = document.getElementById("timer");

const transcriptEl = document.getElementById("transcript");
const notesEl = document.getElementById("notes");
const notesActions = document.getElementById("notesActions");
const banner = document.getElementById("banner");
const backendDot = document.getElementById("backendDot");

// --- State ----------------------------------------------------------------- //
let transcriptText = "";
let lastNotes = null; // { parsed, notes } or { parsed:false, raw }
let timerInterval = null;
let startedAt = null;

// --------------------------------------------------------------------------- //
// Init / restore
// --------------------------------------------------------------------------- //
init();

async function init() {
  wireEvents();

  const stored = await chrome.storage.local.get([
    "transcript",
    "notes",
    "recording",
    "startedAt",
  ]);

  if (stored.transcript) {
    transcriptText = stored.transcript;
    renderTranscript();
  }
  if (stored.notes) {
    lastNotes = stored.notes;
    renderNotes(lastNotes);
  }
  updateGenerateEnabled();

  // If a recording is still running (panel was reopened), restore that UI.
  const state = await chrome.runtime
    .sendMessage({ type: "GET_STATE" })
    .catch(() => null);
  if (state && state.recording) {
    enterRecordingUI();
    startedAt = stored.startedAt || Date.now();
    timerInterval = setInterval(tickTimer, 1000);
    tickTimer();
  }

  checkBackend();
}

function wireEvents() {
  startBtn.addEventListener("click", onStart);
  stopBtn.addEventListener("click", onStop);
  clearBtn.addEventListener("click", onClear);
  generateBtn.addEventListener("click", onGenerate);
  copyBtn.addEventListener("click", onCopy);
  downloadBtn.addEventListener("click", onDownload);

  // Messages from the offscreen document.
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "TRANSCRIPT_CHUNK":
        appendTranscript(msg.text);
        break;
      case "RMS_LEVELS":
        updateMeters(msg.tab, msg.mic);
        break;
      case "CAPTURE_WARNING":
        showBanner(msg.error, "warn");
        break;
      case "CAPTURE_ERROR":
        showBanner(msg.error, "error");
        break;
      case "CAPTURE_STOPPED":
        // Offscreen finished tearing down; make sure UI is in stopped state.
        exitRecordingUI();
        break;
    }
  });
}

// --------------------------------------------------------------------------- //
// Start / stop
// --------------------------------------------------------------------------- //
async function onStart() {
  clearBanner();

  // Trigger the mic-permission prompt here in the (visible) side panel so the
  // offscreen document can use the mic without a prompt it can't display.
  await ensureMicPermission();

  startBtn.disabled = true;
  const res = await chrome.runtime
    .sendMessage({ type: "START_CAPTURE" })
    .catch((e) => ({ ok: false, error: String(e) }));

  if (!res || !res.ok) {
    startBtn.disabled = false;
    showBanner(
      "Couldn't start capture: " + ((res && res.error) || "unknown error"),
      "error"
    );
    return;
  }

  enterRecordingUI();
  startedAt = Date.now();
  timerInterval = setInterval(tickTimer, 1000);
  tickTimer();
  await chrome.storage.local.set({ recording: true, startedAt });
}

async function ensureMicPermission() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop()); // we only wanted the permission grant
  } catch (e) {
    showBanner(
      "Microphone access was not granted (" +
        e.name +
        "). The meeting/tab audio will still be recorded, but your voice won't be.",
      "warn"
    );
  }
}

async function onStop() {
  stopBtn.disabled = true;
  await chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }).catch(() => {});
  await chrome.storage.local.set({ recording: false });
  exitRecordingUI();
}

function enterRecordingUI() {
  recordingRow.classList.remove("hidden");
  meters.classList.remove("hidden");
  startBtn.classList.add("hidden");
  stopBtn.disabled = false;
}

function exitRecordingUI() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  recordingRow.classList.add("hidden");
  meters.classList.add("hidden");
  startBtn.classList.remove("hidden");
  startBtn.disabled = false;
  updateMeters(0, 0);
}

function tickTimer() {
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  const m = String(Math.floor(secs / 60)).padStart(2, "0");
  const s = String(secs % 60).padStart(2, "0");
  timerEl.textContent = `${m}:${s}`;
}

// Map an RMS value (~0..0.3 typical speech) to a 0..100% bar.
function updateMeters(tab, mic) {
  tabLevel.style.width = Math.min(100, (tab || 0) * 400) + "%";
  micLevel.style.width = Math.min(100, (mic || 0) * 400) + "%";
}

// --------------------------------------------------------------------------- //
// Transcript
// --------------------------------------------------------------------------- //
function appendTranscript(text) {
  if (!text) return;
  transcriptText = (transcriptText ? transcriptText + " " : "") + text.trim();
  renderTranscript();
  updateGenerateEnabled();
  chrome.storage.local.set({ transcript: transcriptText });
}

function renderTranscript() {
  if (!transcriptText) {
    transcriptEl.innerHTML =
      '<p class="placeholder">Press <strong>Start recording</strong> while your meeting tab is focused. The live transcript appears here.</p>';
    return;
  }
  // Keep it simple & safe: render as text, auto-scroll to the newest content.
  transcriptEl.textContent = transcriptText;
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function updateGenerateEnabled() {
  generateBtn.disabled = transcriptText.trim().length === 0;
}

async function onClear() {
  transcriptText = "";
  lastNotes = null;
  renderTranscript();
  notesEl.innerHTML =
    '<p class="placeholder">Notes generated from the transcript will appear here.</p>';
  notesActions.classList.add("hidden");
  updateGenerateEnabled();
  await chrome.storage.local.remove(["transcript", "notes"]);
}

// --------------------------------------------------------------------------- //
// Notes (Generate / Copy / Download)
// --------------------------------------------------------------------------- //
async function onGenerate() {
  clearBanner();
  generateBtn.disabled = true;
  notesEl.innerHTML =
    '<p class="placeholder"><span class="spinner"></span>Generating notes…</p>';

  try {
    const res = await fetch(BACKEND_URL + "/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript: transcriptText }),
    });
    if (!res.ok) {
      let detail = "HTTP " + res.status;
      try {
        const j = await res.json();
        if (j && j.detail) detail = j.detail;
      } catch (_) {}
      throw new Error(detail);
    }
    const data = await res.json();
    lastNotes = data;
    renderNotes(data);
    await chrome.storage.local.set({ notes: data });
  } catch (e) {
    notesEl.innerHTML =
      '<p class="placeholder">Notes failed to generate.</p>';
    showBanner("Generate Notes failed: " + (e.message || e), "error");
  } finally {
    updateGenerateEnabled();
  }
}

function renderNotes(data) {
  if (!data) return;

  // Parse failure: show the raw model output so nothing is lost.
  if (data.parsed === false) {
    const pre = document.createElement("pre");
    pre.textContent = data.raw || "(empty response)";
    notesEl.innerHTML = "";
    const note = document.createElement("p");
    note.className = "placeholder";
    note.textContent = "Could not parse structured notes; showing raw output:";
    notesEl.appendChild(note);
    notesEl.appendChild(pre);
    notesActions.classList.remove("hidden");
    return;
  }

  const n = data.notes || {};
  notesEl.innerHTML = "";

  notesEl.appendChild(sectionTitle("Summary"));
  const summary = document.createElement("p");
  summary.className = "summary-text";
  summary.textContent = n.summary || "—";
  notesEl.appendChild(summary);

  notesEl.appendChild(sectionTitle("Key Points"));
  notesEl.appendChild(bulletList(n.key_points));

  notesEl.appendChild(sectionTitle("Decisions"));
  notesEl.appendChild(bulletList(n.decisions));

  notesEl.appendChild(sectionTitle("Action Items"));
  notesEl.appendChild(actionList(n.action_items));

  notesActions.classList.remove("hidden");
}

function sectionTitle(text) {
  const h = document.createElement("h3");
  h.textContent = text;
  return h;
}

function bulletList(items) {
  const ul = document.createElement("ul");
  if (!Array.isArray(items) || items.length === 0) {
    const li = document.createElement("li");
    li.className = "placeholder";
    li.textContent = "None";
    ul.appendChild(li);
    return ul;
  }
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = typeof item === "string" ? item : JSON.stringify(item);
    ul.appendChild(li);
  }
  return ul;
}

function actionList(items) {
  const ul = document.createElement("ul");
  if (!Array.isArray(items) || items.length === 0) {
    const li = document.createElement("li");
    li.className = "placeholder";
    li.textContent = "None";
    ul.appendChild(li);
    return ul;
  }
  for (const it of items) {
    const li = document.createElement("li");
    const task = document.createElement("span");
    task.textContent = it.task || "(task)";
    li.appendChild(task);

    const owner = document.createElement("span");
    owner.className = "action-owner";
    owner.textContent = " — " + (it.owner || "unassigned");
    li.appendChild(owner);

    if (it.due) {
      const due = document.createElement("span");
      due.className = "action-due";
      due.textContent = " (due: " + it.due + ")";
      li.appendChild(due);
    }
    ul.appendChild(li);
  }
  return ul;
}

// Build a Markdown document from the current notes.
function notesToMarkdown() {
  if (!lastNotes) return "";
  if (lastNotes.parsed === false) {
    return "# Meeting Notes\n\n" + (lastNotes.raw || "");
  }
  const n = lastNotes.notes || {};
  const lines = ["# Meeting Notes", ""];

  lines.push("## Summary", n.summary || "_None_", "");

  lines.push("## Key Points");
  if (Array.isArray(n.key_points) && n.key_points.length) {
    n.key_points.forEach((p) => lines.push(`- ${p}`));
  } else lines.push("_None_");
  lines.push("");

  lines.push("## Decisions");
  if (Array.isArray(n.decisions) && n.decisions.length) {
    n.decisions.forEach((d) => lines.push(`- ${d}`));
  } else lines.push("_None_");
  lines.push("");

  lines.push("## Action Items");
  if (Array.isArray(n.action_items) && n.action_items.length) {
    n.action_items.forEach((a) => {
      const owner = a.owner || "unassigned";
      const due = a.due ? ` (due: ${a.due})` : "";
      lines.push(`- [ ] ${a.task || "(task)"} — ${owner}${due}`);
    });
  } else lines.push("_None_");
  lines.push("");

  return lines.join("\n");
}

async function onCopy() {
  const md = notesToMarkdown();
  if (!md) return;
  try {
    await navigator.clipboard.writeText(md);
    flashButton(copyBtn, "Copied!");
  } catch (e) {
    showBanner("Copy failed: " + (e.message || e), "error");
  }
}

function onDownload() {
  const md = notesToMarkdown();
  if (!md) return;
  // Object-URL download — no "downloads" permission needed from an extension page.
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `meeting-notes-${stamp}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function flashButton(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = original), 1200);
}

// --------------------------------------------------------------------------- //
// Banner + backend health
// --------------------------------------------------------------------------- //
function showBanner(text, kind) {
  banner.textContent = text;
  banner.className = "banner " + (kind || "error");
}
function clearBanner() {
  banner.className = "banner hidden";
  banner.textContent = "";
}

async function checkBackend() {
  try {
    const res = await fetch(BACKEND_URL + "/", { method: "GET" });
    const j = await res.json();
    if (j && j.status === "ok") {
      backendDot.className = "dot dot-ok";
      backendDot.title = "Backend online";
      return;
    }
    throw new Error("unexpected response");
  } catch (_) {
    backendDot.className = "dot dot-bad";
    backendDot.title = "Backend offline — start it with: uvicorn main:app --reload";
    showBanner(
      "Backend not reachable at " +
        BACKEND_URL +
        ". Start it:  uvicorn main:app --reload",
      "warn"
    );
  }
}
