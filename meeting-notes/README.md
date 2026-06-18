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
| `SUMMARY_PROVIDER` | `anthropic` | `ollama` (free/offline) or `gemini` (free cloud) need no Claude key. |
| `ANTHROPIC_API_KEY` | — | Only for `SUMMARY_PROVIDER=anthropic`. Stays on the backend. |
| `SUMMARY_MODEL` | `claude-sonnet-4-6` | Claude model. Swap to `claude-haiku-4-5-20251001` for lower cost. |
| `GEMINI_API_KEY` | — | Free key from <https://aistudio.google.com/app/apikey> (for `gemini`). |
| `GEMINI_MODEL` | `gemini-2.0-flash` | Any free Gemini model, e.g. `gemini-2.5-flash`. |
| `OLLAMA_MODEL` | `llama3.1:8b` | Any pulled Ollama model (for `ollama`). |
| `WHISPER_MODEL` | `small.en` | `base.en` (faster), `medium.en`/`medium` (more accurate). |
| `WHISPER_DEVICE` | `auto` | `auto` safely probes CUDA and falls back to CPU. Force with `cuda` or `cpu`. |
| `WHISPER_COMPUTE_TYPE` | — | Override compute type (e.g. `int8`, `float16`). |

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
2. Open your meeting in a normal tab and **focus that tab** (for a quick test, use `http://localhost:8000/test`).
3. **Click the extension's toolbar icon while that tab is focused.** This both opens the side panel **and** authorizes capture of the tab.
   > Why this matters: in MV3, capture needs the `activeTab` grant, which comes from *clicking the action icon* — not from merely opening the side panel. Clicking the icon on your meeting tab is the required gesture.
4. In the side panel click **● Start recording**.
   - Allow the **microphone** prompt the first time (so your voice is captured).
   - You should **still hear the meeting** — if it goes silent, see Troubleshooting.
5. Watch the **Tab** and **Mic** level meters move and the transcript fill in (~every 10 s).
6. Click **■ Stop** when done. (To record again, click the toolbar icon on the meeting tab first, then Start.)
7. Click **Generate Notes** → Summary / Key Points / Decisions / Action Items render.
8. **Copy as Markdown** or **Download .md**.

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

- **"Extension has not been invoked for the current page (activeTab)":** you opened the side panel without authorizing capture. Click the extension's **toolbar icon while your meeting tab is focused** (that grants `activeTab`), then press Start.
- **Backend dot is red / "not reachable":** the server isn't running. Start `uvicorn main:app --reload`.
- **Meeting goes silent when recording:** that's the classic tab-capture bug; this build re-routes tab audio to your speakers, so report it if it happens (check the offscreen console via `chrome://extensions` → the extension's "Inspect views: offscreen.html").
- **Mic meter stays flat:** mic permission was denied. Click the extension, re-trigger the prompt, allow it. Capture still works tab-only without it.
- **`Generate Notes` says key missing:** set `ANTHROPIC_API_KEY` in `backend/.env` and restart the server.
- **First transcription is slow / connection resets:** the first call downloads the model and probes CUDA. Give it a minute; subsequent calls are fast.
- **Want guaranteed CPU:** set `WHISPER_DEVICE=cpu` in `.env`.

---

## Notes without a Claude key

`/summarize` supports two free alternatives to Claude, same JSON schema, selected by `SUMMARY_PROVIDER`.

### Option A — Google Gemini (free cloud API)

1. Get a free key at <https://aistudio.google.com/app/apikey>.
2. In `backend/.env`:
   ```ini
   SUMMARY_PROVIDER=gemini
   GEMINI_API_KEY=AIza...your-key...
   GEMINI_MODEL=gemini-2.0-flash
   ```
3. Restart the backend and click **Generate Notes**. Uses Gemini's `responseMimeType=application/json` so output stays valid JSON.

### Option B — local Ollama (free, offline, no key)

`/summarize` can use a local [Ollama](https://ollama.com) model instead of Claude — zero cost, no API key, same JSON schema. Selected by env flag:

```ini
# backend/.env
SUMMARY_PROVIDER=ollama
OLLAMA_MODEL=llama3.1:8b            # or any pulled model, e.g. llama3.1:latest, qwen2.5:3b
OLLAMA_URL=http://127.0.0.1:11434/api/chat
```

Setup:

```powershell
ollama serve                # if not already running as the background app
ollama pull llama3.1:8b     # one-time model download (~4.9 GB)
```

Then restart the backend (`uvicorn main:app --reload`) and click **Generate Notes** as usual. It calls Ollama's `/api/chat` with `format=json` so output stays valid JSON.

> Tip: use `127.0.0.1`, not `localhost`, on Windows — `localhost` can resolve to IPv6 `::1` while Ollama listens on IPv4, causing timeouts. The default already uses `127.0.0.1`.

Switch back to Claude any time with `SUMMARY_PROVIDER=anthropic`. The provider logic lives entirely in `call_llm()` / `_call_ollama()` / `_call_anthropic()` in `main.py`.
