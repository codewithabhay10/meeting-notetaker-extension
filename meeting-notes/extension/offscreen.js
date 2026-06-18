// offscreen.js — ALL audio capture, mixing, recording, and upload.
//
// Audio graph we build:
//
//   tabSource ──┬───────────────────────────► ctx.destination   (you HEAR the meeting)
//               └──► mixGain ──► workletNode ─► ctx.destination   (worklet emits silence;
//   micSource ─────► mixGain                                       connection just keeps it
//                                                                  scheduled. mixGain feeds
//                                                                  the worklet for upload.)
//
// Key correctness notes:
//   * Capturing tab audio normally MUTES the meeting for you. We fix that by
//     connecting the tab source to ctx.destination so playback continues. (#2)
//   * We do NOT connect the mic source to ctx.destination, or you'd hear an echo
//     of your own voice. (#3)
//   * The worklet receives the MIX (tab + mic) and produces the transcription
//     audio. It never writes to its output, so it adds no sound. (#2/#3)

let audioCtx = null;
let tabStream = null;
let micStream = null;
let tabSource = null;
let micSource = null;
let mixGain = null;
let workletNode = null;
let scriptNode = null; // ScriptProcessorNode fallback
let tabAnalyser = null;
let micAnalyser = null;
let tabAnalyserBuf = null;
let micAnalyserBuf = null;
let rmsTimer = null;

let backendUrl = "http://localhost:8000";
let inputSampleRate = 48000;
let chunkSamplesNeeded = 0;

// Buffer of Float32Array chunks at the AudioContext's sample rate.
let pcmBuffer = [];
let pcmBufferLen = 0;

const TARGET_RATE = 16000; // Whisper-friendly mono rate

// --------------------------------------------------------------------------- //
// Messaging
// --------------------------------------------------------------------------- //
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target !== "offscreen") return;
  if (msg.type === "OFFSCREEN_START") {
    startCapture(msg.streamId, msg.backendUrl, msg.chunkSeconds);
  } else if (msg.type === "OFFSCREEN_STOP") {
    stopCapture();
  }
});

function send(type, extra) {
  chrome.runtime.sendMessage(Object.assign({ type }, extra || {})).catch(() => {});
}

// --------------------------------------------------------------------------- //
// Start
// --------------------------------------------------------------------------- //
async function startCapture(streamId, beUrl, chunkSeconds) {
  backendUrl = beUrl || backendUrl;

  // 1) Tab audio via the streamId minted by the service worker. Note the legacy
  //    `mandatory` constraint shape — it is REQUIRED for chromeMediaSource:'tab'.
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
  } catch (e) {
    send("CAPTURE_ERROR", { error: "Could not capture tab audio: " + e.message });
    send("OFFSCREEN_STOPPED");
    return;
  }

  // 2) Microphone (optional). If it fails (e.g. permission denied) we continue
  //    with tab audio only so remote participants are still transcribed.
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    micStream = null;
    send("CAPTURE_WARNING", {
      error:
        "Microphone unavailable (" +
        e.name +
        "). Recording meeting/tab audio only.",
    });
  }

  // 3) Build the audio graph.
  audioCtx = new AudioContext();
  inputSampleRate = audioCtx.sampleRate;
  chunkSamplesNeeded = Math.round((chunkSeconds || 10) * inputSampleRate);

  tabSource = audioCtx.createMediaStreamSource(tabStream);
  mixGain = audioCtx.createGain();
  mixGain.gain.value = 1.0;

  // Audibility: route the tab straight to the speakers so you still hear it.
  tabSource.connect(audioCtx.destination);
  // Transcription mix: tab into the mixer.
  tabSource.connect(mixGain);

  if (micStream) {
    micSource = audioCtx.createMediaStreamSource(micStream);
    // Mic into the mixer ONLY — never to destination (would echo your voice).
    micSource.connect(mixGain);
  }

  // RMS meters so the side panel can prove both sources are live.
  tabAnalyser = audioCtx.createAnalyser();
  tabAnalyser.fftSize = 512;
  tabAnalyserBuf = new Float32Array(tabAnalyser.fftSize);
  tabSource.connect(tabAnalyser);

  if (micSource) {
    micAnalyser = audioCtx.createAnalyser();
    micAnalyser.fftSize = 512;
    micAnalyserBuf = new Float32Array(micAnalyser.fftSize);
    micSource.connect(micAnalyser);
  }

  // 4) PCM collector: AudioWorklet preferred, ScriptProcessor fallback.
  await setupPcmCollector();

  // 5) Start RMS reporting.
  rmsTimer = setInterval(() => {
    send("RMS_LEVELS", {
      tab: computeRms(tabAnalyser, tabAnalyserBuf),
      mic: computeRms(micAnalyser, micAnalyserBuf),
    });
  }, 400);

  send("CAPTURE_STARTED", { mic: !!micStream });
}

async function setupPcmCollector() {
  try {
    await audioCtx.audioWorklet.addModule(
      chrome.runtime.getURL("audio-worklet.js")
    );
    // Force mono so the worklet receives a single down-mixed channel.
    workletNode = new AudioWorkletNode(audioCtx, "pcm-collector", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "speakers",
    });
    workletNode.port.onmessage = (e) => onPcm(e.data);
    mixGain.connect(workletNode);
    // Connect to destination so the node stays scheduled. It emits silence.
    workletNode.connect(audioCtx.destination);
  } catch (err) {
    console.warn("[offscreen] AudioWorklet unavailable, using ScriptProcessor:", err);
    // Fallback: ScriptProcessorNode (deprecated but widely supported).
    scriptNode = audioCtx.createScriptProcessor(4096, 1, 1);
    scriptNode.onaudioprocess = (ev) => {
      onPcm(new Float32Array(ev.inputBuffer.getChannelData(0)));
    };
    mixGain.connect(scriptNode);
    scriptNode.connect(audioCtx.destination); // emits silence (we never write output)
  }
}

// --------------------------------------------------------------------------- //
// PCM accumulation -> chunked upload
// --------------------------------------------------------------------------- //
function onPcm(float32) {
  pcmBuffer.push(float32);
  pcmBufferLen += float32.length;
  if (pcmBufferLen >= chunkSamplesNeeded) {
    flushChunk(false);
  }
}

async function flushChunk(isFinal) {
  if (pcmBufferLen === 0) return;

  // Merge accumulated PCM into one Float32Array, then reset the buffer.
  const merged = new Float32Array(pcmBufferLen);
  let offset = 0;
  for (const a of pcmBuffer) {
    merged.set(a, offset);
    offset += a.length;
  }
  pcmBuffer = [];
  pcmBufferLen = 0;

  // Skip a tiny final fragment (< 0.5 s) — not worth a request.
  if (isFinal && merged.length < inputSampleRate * 0.5) return;

  const down = resampleTo16k(merged, inputSampleRate);
  const wav = encodeWav16(down, TARGET_RATE);
  await postChunk(wav);
}

async function postChunk(wavBlob) {
  try {
    const fd = new FormData();
    fd.append("file", wavBlob, "chunk.wav");
    const res = await fetch(backendUrl + "/transcribe", {
      method: "POST",
      body: fd,
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
    const text = (data && data.text ? data.text : "").trim();
    if (text) send("TRANSCRIPT_CHUNK", { text });
  } catch (e) {
    send("CAPTURE_ERROR", {
      error:
        "Transcription request failed (is the backend running on " +
        backendUrl +
        "?): " +
        (e.message || e),
    });
  }
}

// --------------------------------------------------------------------------- //
// Stop / teardown
// --------------------------------------------------------------------------- //
async function stopCapture() {
  if (rmsTimer) {
    clearInterval(rmsTimer);
    rmsTimer = null;
  }

  // Stop feeding the collector, then flush whatever audio remains.
  try {
    if (workletNode) workletNode.disconnect();
    if (scriptNode) {
      scriptNode.onaudioprocess = null;
      scriptNode.disconnect();
    }
    if (mixGain) mixGain.disconnect();
    if (tabSource) tabSource.disconnect();
    if (micSource) micSource.disconnect();
    if (tabAnalyser) tabAnalyser.disconnect();
    if (micAnalyser) micAnalyser.disconnect();
  } catch (_) {}

  await flushChunk(true);

  // Release the OS-level capture (clears the "tab is being captured" UI).
  try {
    if (tabStream) tabStream.getTracks().forEach((t) => t.stop());
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    if (audioCtx && audioCtx.state !== "closed") await audioCtx.close();
  } catch (_) {}

  // Reset all state.
  audioCtx = tabStream = micStream = null;
  tabSource = micSource = mixGain = null;
  workletNode = scriptNode = null;
  tabAnalyser = micAnalyser = null;
  pcmBuffer = [];
  pcmBufferLen = 0;

  send("CAPTURE_STOPPED");
  // Ask the worker to close this offscreen document.
  send("OFFSCREEN_STOPPED");
}

// --------------------------------------------------------------------------- //
// DSP helpers
// --------------------------------------------------------------------------- //
function computeRms(analyser, buf) {
  if (!analyser || !buf) return 0;
  analyser.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

// Linear-interpolation resample from inRate to 16 kHz mono.
function resampleTo16k(input, inRate) {
  if (inRate === TARGET_RATE) return input;
  const ratio = inRate / TARGET_RATE;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

// Encode Float32 mono samples as a 16-bit PCM WAV Blob.
function encodeWav16(samples, sampleRate) {
  const bytesPerSample = 2;
  const blockAlign = 1 * bytesPerSample; // mono
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeStr = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  let off = 0;
  writeStr(off, "RIFF"); off += 4;
  view.setUint32(off, 36 + dataSize, true); off += 4;
  writeStr(off, "WAVE"); off += 4;
  writeStr(off, "fmt "); off += 4;
  view.setUint32(off, 16, true); off += 4;        // fmt chunk size
  view.setUint16(off, 1, true); off += 2;         // PCM
  view.setUint16(off, 1, true); off += 2;         // mono
  view.setUint32(off, sampleRate, true); off += 4;
  view.setUint32(off, byteRate, true); off += 4;
  view.setUint16(off, blockAlign, true); off += 2;
  view.setUint16(off, 16, true); off += 2;        // bits per sample
  writeStr(off, "data"); off += 4;
  view.setUint32(off, dataSize, true); off += 4;

  for (let i = 0; i < samples.length; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }

  return new Blob([view], { type: "audio/wav" });
}
