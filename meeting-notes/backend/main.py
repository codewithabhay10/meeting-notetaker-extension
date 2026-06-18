"""
Meeting Notes Taker — local FastAPI backend.

Endpoints:
  GET  /           -> health check  {"status": "ok"}
  POST /transcribe -> faster-whisper transcription of a WAV chunk
  POST /summarize  -> Claude API structured notes from a transcript

Run:
    uvicorn main:app --reload

Heavy imports (faster_whisper, anthropic) are lazy so the health check and
server boot stay fast and don't require the model to be downloaded yet.
"""

import os
import re
import sys
import json
import tempfile
import subprocess

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

# Load .env if present (ANTHROPIC_API_KEY, WHISPER_MODEL, SUMMARY_MODEL).
try:
    from dotenv import load_dotenv

    load_dotenv()
except Exception:
    pass


app = FastAPI(title="Meeting Notes Backend", version="1.0.0")

# CORS: the extension calls this server from a chrome-extension:// origin.
# Local-only dev server, no credentials, so a permissive policy is fine.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_origin_regex=r"chrome-extension://.*",
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --------------------------------------------------------------------------- #
# Health
# --------------------------------------------------------------------------- #
@app.get("/")
def health():
    """Health check used by the extension and by you (open in a browser)."""
    return {"status": "ok"}


# --------------------------------------------------------------------------- #
# Transcription (faster-whisper)
# --------------------------------------------------------------------------- #
_model = None  # cached WhisperModel singleton


def _cuda_probe_ok(model_size: str) -> bool:
    """
    Decide whether CUDA inference actually WORKS — in a child process.

    We can't just try/except in-process: a missing cuDNN/driver makes
    CTranslate2 abort with a NATIVE crash (e.g. "Could not locate
    cudnn_ops64_9.dll"), which kills the whole server instead of raising a
    catchable Python exception. So we run a tiny CUDA transcription in a
    subprocess and only trust CUDA if that subprocess exits cleanly.
    """
    code = (
        "import sys, numpy as np;"
        "from faster_whisper import WhisperModel;"
        "m = WhisperModel(sys.argv[1], device='cuda', compute_type='float16');"
        "list(m.transcribe(np.zeros(16000, dtype=np.float32), language='en')[0]);"
        "sys.exit(0)"
    )
    try:
        r = subprocess.run(
            [sys.executable, "-c", code, model_size],
            capture_output=True,
            timeout=180,
        )
        return r.returncode == 0
    except Exception:
        return False


def get_model():
    """
    Lazily load the Whisper model once and cache it.

    Device selection (env WHISPER_DEVICE = auto | cuda | cpu, default auto):
      * auto -> probe CUDA safely (see _cuda_probe_ok); use it if it works,
        otherwise CPU. Good for an RTX 3050 with small.en/base.en when cuDNN
        is installed; safely falls back to CPU when it isn't.
      * cuda/cpu -> force that device.
    Compute type can be overridden with WHISPER_COMPUTE_TYPE.
    """
    global _model
    if _model is not None:
        return _model

    from faster_whisper import WhisperModel

    size = os.environ.get("WHISPER_MODEL", "small.en")
    device = os.environ.get("WHISPER_DEVICE", "auto").lower()
    compute = os.environ.get("WHISPER_COMPUTE_TYPE", "").strip()

    if device == "auto":
        if _cuda_probe_ok(size):
            device = "cuda"
        else:
            print("[whisper] CUDA not usable (cuDNN/driver missing or probe failed); using CPU.")
            device = "cpu"

    if device == "cuda":
        ct = compute or "float16"
        _model = WhisperModel(size, device="cuda", compute_type=ct)
        print(f"[whisper] loaded '{size}' on cuda/{ct}")
    else:
        ct = compute or "int8"
        _model = WhisperModel(size, device="cpu", compute_type=ct)
        print(f"[whisper] loaded '{size}' on cpu/{ct}")
    return _model


def _run_transcription(path: str) -> str:
    """Blocking transcription helper (runs in a threadpool)."""
    model = get_model()
    segments, _info = model.transcribe(path, language="en")
    return " ".join(seg.text.strip() for seg in segments).strip()


@app.post("/transcribe")
async def transcribe(file: UploadFile = File(...)):
    """
    Accept a WAV chunk (multipart 'file'), transcribe it, return {"text": ...}.

    The audio is written to a temp file because faster-whisper reads from a
    path; the temp file is always cleaned up afterwards.
    """
    suffix = os.path.splitext(file.filename or "")[1] or ".wav"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    tmp_path = tmp.name
    try:
        data = await file.read()
        tmp.write(data)
        tmp.flush()
        tmp.close()

        # The model call (and first-time model download) is blocking, so run it
        # in a worker thread to keep the event loop responsive.
        text = await run_in_threadpool(_run_transcription, tmp_path)
        return {"text": text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# --------------------------------------------------------------------------- #
# Summarization (Claude API)
# --------------------------------------------------------------------------- #
class SummarizeRequest(BaseModel):
    transcript: str


SYSTEM_PROMPT = """You are a meeting-notes assistant. You will be given the raw \
transcript of a meeting. Produce structured notes.

Return ONLY a single JSON object and nothing else — no Markdown, no prose, no \
code fences. The JSON must match exactly this schema:

{
  "summary": "2-4 sentence overview of the meeting",
  "key_points": ["concise point", "..."],
  "decisions": ["decision made", "..."],
  "action_items": [
    { "task": "what needs doing", "owner": "name or 'unassigned'", "due": "date string or null" }
  ]
}

Rules:
- Use [] for any section with no items. Never invent content not supported by the transcript.
- "owner" is a person's name if stated, otherwise the string "unassigned".
- "due" is a date/time string if stated, otherwise null.
- Output must be valid JSON parseable by a strict JSON parser."""


def call_llm(transcript: str) -> str:
    """
    Isolated LLM call so the provider is easy to swap later (e.g. Ollama).
    Returns the model's raw text response.
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=400,
            detail="ANTHROPIC_API_KEY is not set. Add it to backend/.env and restart the server.",
        )

    from anthropic import Anthropic

    client = Anthropic(api_key=api_key)
    model = os.environ.get("SUMMARY_MODEL", "claude-sonnet-4-6")
    resp = client.messages.create(
        model=model,
        max_tokens=2000,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": transcript}],
    )
    return "".join(block.text for block in resp.content if block.type == "text")


def parse_notes(raw: str):
    """
    Robustly parse the model output into the notes dict.

    Strips accidental ```json ... ``` fences and, if needed, extracts the first
    {...} object. Returns (notes_dict, True) on success, (None, False) on failure.
    """
    s = raw.strip()

    # Strip a leading ```json / ``` fence and trailing ``` if present.
    if s.startswith("```"):
        s = re.sub(r"^```(?:json)?\s*", "", s)
        s = re.sub(r"\s*```$", "", s).strip()

    try:
        return json.loads(s), True
    except Exception:
        pass

    # Fallback: grab the first {...} block.
    m = re.search(r"\{.*\}", s, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0)), True
        except Exception:
            pass

    return None, False


@app.post("/summarize")
def summarize(req: SummarizeRequest):
    """
    Turn a transcript into structured notes via the Claude API.

    On success: {"parsed": true, "notes": {...}}
    On parse failure: {"parsed": false, "raw": "<model text>"} so the UI can
    still show something instead of crashing.
    """
    transcript = (req.transcript or "").strip()
    if not transcript:
        raise HTTPException(status_code=400, detail="Transcript is empty.")

    raw = call_llm(transcript)
    notes, ok = parse_notes(raw)
    if ok:
        return {"parsed": True, "notes": notes}
    return {"parsed": False, "raw": raw}
