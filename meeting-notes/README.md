# Meeting Notes Taker

A Chrome/Brave (Manifest V3) extension + local Python backend that:

1. Captures a meeting tab's audio **and** your microphone, mixed into one stream.
2. Transcribes locally with [`faster-whisper`](https://github.com/SYSTRAN/faster-whisper) (a FastAPI server), showing a near-live transcript in the side panel.
3. On demand, sends the transcript to the **Claude API** and renders structured notes (summary, key points, decisions, action items).
4. Lets you copy the notes as Markdown or download them as a `.md` file.

Works with Google Meet / Zoom web / Teams web — `tabCapture` taps whatever audio the tab plays, so the platform doesn't matter.

> **Consent note:** Recording or transcribing a meeting may require the consent of other participants depending on your jurisdiction and the meeting's context. Make sure you have permission before recording.

---

## Project layout

```
meeting-notes/
  extension/          # MV3 extension (added in Phase 2)
  backend/
    main.py           # FastAPI: /, /transcribe, /summarize
    requirements.txt
    .env.example
  README.md
```

---

## Backend setup

Requires Python 3.9+.

```bash
cd meeting-notes/backend

# (Recommended) create a virtual environment
python -m venv .venv
# Windows PowerShell:
.\.venv\Scripts\Activate.ps1
# macOS/Linux:
# source .venv/bin/activate

pip install -r requirements.txt
```

> **Quick Phase 0 test without the heavy deps:** the health check only needs
> `fastapi` + `uvicorn`. You can run `pip install fastapi "uvicorn[standard]"`
> and skip the rest until Phase 1.

Copy the env template and fill in your key (needed in Phase 4):

```bash
cp .env.example .env
# then edit .env and set ANTHROPIC_API_KEY=...
```

### Run

```bash
uvicorn main:app --reload
```

Open <http://localhost:8000> — you should see:

```json
{"status": "ok"}
```

---

## Build status (phased)

- [x] **Phase 0** — Scaffold + health check (`GET /`)
- [ ] **Phase 1** — `/transcribe` (Whisper)
- [ ] **Phase 2** — Extension capture + audibility
- [ ] **Phase 3** — Live transcript
- [ ] **Phase 4** — Notes (`/summarize` + UI)
- [ ] **Phase 5** — Persistence + polish

The extension load-unpacked instructions are added in Phase 2 once the
`extension/` files exist.
