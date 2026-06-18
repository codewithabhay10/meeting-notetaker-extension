# Meeting Notes Taker

A Chrome/Brave (Manifest V3) extension + local Python backend that:

1. Captures a meeting tab's audio **and** your microphone, mixed into one stream.
2. Transcribes locally with [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) (a FastAPI server), showing a near-live transcript in the side panel.
3. On demand, sends the transcript to the **Claude API** and renders structured notes — summary, key points, decisions, and action items.
4. Lets you copy the notes as Markdown or download them as a `.md` file.

Works with Google Meet / Zoom web / Teams web — `tabCapture` taps whatever audio the tab plays, so the platform doesn't matter.

> ⚠️ **Consent note:** Recording or transcribing a meeting may legally require the consent of the other participants depending on your jurisdiction. Make sure you have permission before you record.

---

## Project layout

```
meeting-notes/
  extension/
    manifest.json
    background.js        # service worker: routing + offscreen lifecycle only
    sidepanel.html / .js / .css
    offscreen.html / offscreen.js   # tab+mic capture, mixing, PCM->WAV, upload
    audio-worklet.js     # PCM collector (runs on the audio thread)
    icons/               # 16 / 48 / 128 placeholder icons
  backend/
    main.py              # FastAPI: /, /transcribe, /summarize
    requirements.txt
    .env.example
    sample.wav           # a synthesized test clip for /transcribe
  README.md
```

---

## 1. Backend setup

Requires Python 3.9+ (tested on 3.11).

```powershell
cd C:\Users\ABHAY\Desktop\NoteTaker\meeting-notes\backend

# (recommended) virtual environment
python -m venv .venv
.\.venv\Scripts\Activate.ps1     # Windows PowerShell
# source .venv/bin/activate      # macOS/Linux

pip install -r requirements.txt
```

Create your env file and add your Claude key (needed only for **Generate Notes**):

```powershell
copy .env.example .env
# edit .env -> ANTHROPIC_API_KEY=sk-ant-...
```

`.env` options:

| Variable | Default | Notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | — | Required for `/summarize`. Stays on the backend; never shipped in the extension. |
| `WHISPER_MODEL` | `small.en` | `base.en` (faster), `medium.en`/`medium` (more accurate). |
| `WHISPER_DEVICE` | `auto` | `auto` safely probes CUDA and falls back to CPU. Force with `cuda` or `cpu`. |
| `WHISPER_COMPUTE_TYPE` | — | Override compute type (e.g. `int8`, `float16`). |
| `SUMMARY_MODEL` | `claude-sonnet-4-6` | Swap to `claude-haiku-4-5-20251001` for lower cost. |

### Run the server

```powershell
uvicorn main:app --reload
```

Leave this running while you use the extension.

> **GPU note (RTX 3050):** `WHISPER_DEVICE=auto` tries CUDA but only uses it if it actually works. Full GPU inference needs **CUDA 12 + cuDNN 9** on your PATH; without cuDNN, CTranslate2 crashes natively, so the backend probes CUDA in a child process and quietly falls back to CPU. CPU with `small.en`/`int8` is perfectly usable for meetings.

---

## 2. Load the extension

1. Open `chrome://extensions` (or `brave://extensions`).
2. Toggle **Developer mode** (top-right).
3. Click **Load unpacked** and select the `meeting-notes/extension` folder.
4. Pin the extension and click its toolbar icon to open the **side panel**.

---

## 3. Use it

1. Start the backend (step 1) — the dot next to "Meeting Notes" in the panel turns **green** when it's reachable.
2. Open your meeting in a normal tab and **focus that tab**.
3. Open the side panel and click **● Start recording**.
   - Allow the **microphone** prompt the first time (so your voice is captured).
   - You should **still hear the meeting** — if it goes silent, see Troubleshooting.
4. Watch the **Tab** and **Mic** level meters move and the transcript fill in (~every 10 s).
5. Click **■ Stop** when done.
6. Click **Generate Notes** → Summary / Key Points / Decisions / Action Items render.
7. **Copy as Markdown** or **Download .md**.

Transcript and notes are saved in `chrome.storage.local`, so reopening the panel restores your last session.

---

## Per-phase verification

**Phase 0 — health check**
```powershell
uvicorn main:app --reload
# open http://localhost:8000  ->  {"status":"ok"}
```

**Phase 1 — transcription** (a `sample.wav` is included)
```powershell
curl.exe -X POST http://localhost:8000/transcribe -F "file=@sample.wav"
# -> {"text":"The quarterly planning meeting is scheduled for next Thursday. ..."}
```
First call downloads the model (~240 MB) and, in `auto` mode, runs a one-time CUDA probe.

**Phase 2 — capture + audibility:** Start recording on a meeting tab. Pass = you still hear the meeting, and **both** the Tab and Mic meters react (tab to remote audio, mic to your voice).

**Phase 3 — live transcript:** Speak / let the meeting play; transcript text appears in the panel roughly every 10 seconds.

**Phase 4 — notes:** With `ANTHROPIC_API_KEY` set, click Generate Notes → four populated sections; Copy and Download work.

**Phase 5 — persistence:** Close and reopen the side panel → your transcript and notes are still there. The timer counts up while recording.

---

## How it works (the tricky parts)

- **MV3 offscreen pattern:** the service worker can't touch media APIs, so it mints a `tabCapture.getMediaStreamId` and hands it to an **offscreen document**, which does all Web Audio work.
- **Audibility:** capturing tab audio normally mutes it for you. `offscreen.js` connects the tab source to `audioContext.destination` so playback continues. The **mic** source is *not* connected to destination (that would echo your voice).
- **Mixing:** tab + mic feed one `GainNode`, which feeds an `AudioWorkletNode` that collects raw Float32 **PCM** (we never slice webm — later webm chunks lack headers and can't be transcribed). PCM is resampled to **16 kHz mono**, encoded as **16-bit WAV** in JS, and POSTed to `/transcribe`.
- **Notes JSON:** `/summarize` instructs Claude to return JSON only, then parses robustly (strips accidental ```` ```json ```` fences, extracts the first `{...}`). On parse failure it returns the raw text so the UI shows it instead of crashing.

---

## Troubleshooting

- **Backend dot is red / "not reachable":** the server isn't running. Start `uvicorn main:app --reload`.
- **Meeting goes silent when recording:** that's the classic tab-capture bug; this build re-routes tab audio to your speakers, so report it if it happens (check the offscreen console via `chrome://extensions` → the extension's "Inspect views: offscreen.html").
- **Mic meter stays flat:** mic permission was denied. Click the extension, re-trigger the prompt, allow it. Capture still works tab-only without it.
- **`Generate Notes` says key missing:** set `ANTHROPIC_API_KEY` in `backend/.env` and restart the server.
- **First transcription is slow / connection resets:** the first call downloads the model and probes CUDA. Give it a minute; subsequent calls are fast.
- **Want guaranteed CPU:** set `WHISPER_DEVICE=cpu` in `.env`.

---

## Optional: local LLM instead of Claude

`/summarize` isolates the model call in `call_llm()`. To use a local Ollama server later, swap that one function to POST to `http://localhost:11434/api/chat` (model `llama3.1:8b`) returning the same JSON schema — no other changes needed.
