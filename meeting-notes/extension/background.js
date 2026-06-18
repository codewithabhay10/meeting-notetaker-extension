// background.js — MV3 service worker.
//
// Responsibilities: orchestration + offscreen-document lifecycle + message
// routing ONLY. A service worker has no DOM and cannot touch MediaStream /
// Web Audio APIs — all audio work happens in the offscreen document.

const OFFSCREEN_PATH = "offscreen.html";
const BACKEND_URL = "http://localhost:8000";
const CHUNK_SECONDS = 10; // how much audio to buffer before each /transcribe call

// Open the side panel when the toolbar icon is clicked.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((e) => console.error("setPanelBehavior:", e));
});
// The worker can be torn down and restarted; set behavior on startup too.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {});

// --------------------------------------------------------------------------- //
// Offscreen document lifecycle
// --------------------------------------------------------------------------- //
async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],
    justification:
      "Capture and mix meeting tab audio with the microphone for local transcription.",
  });
}

// --------------------------------------------------------------------------- //
// Start / stop orchestration
// --------------------------------------------------------------------------- //
async function startCapture() {
  // The meeting tab = the active tab in the focused window.
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  if (!tab) throw new Error("No active tab found.");

  const url = tab.url || "";
  if (
    url.startsWith("chrome://") ||
    url.startsWith("chrome-extension://") ||
    url.startsWith("edge://") ||
    url.startsWith("about:")
  ) {
    throw new Error(
      "This page can't be captured. Open your meeting in a normal tab, focus it, then press Start."
    );
  }

  // Mint an opaque stream id the offscreen document turns into a MediaStream.
  // (Done here, not in the worker's media APIs — the worker just brokers it.)
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
  });

  await ensureOffscreenDocument();

  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "OFFSCREEN_START",
    streamId,
    backendUrl: BACKEND_URL,
    chunkSeconds: CHUNK_SECONDS,
  });
}

async function stopCapture() {
  if (await hasOffscreenDocument()) {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "OFFSCREEN_STOP",
    });
  }
}

// --------------------------------------------------------------------------- //
// Message routing
// --------------------------------------------------------------------------- //
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  // From the side panel:
  if (msg.type === "START_CAPTURE") {
    startCapture()
      .then(() => sendResponse({ ok: true }))
      .catch((err) =>
        sendResponse({ ok: false, error: String((err && err.message) || err) })
      );
    return true; // keep the channel open for the async response
  }

  if (msg.type === "STOP_CAPTURE") {
    stopCapture()
      .then(() => sendResponse({ ok: true }))
      .catch((err) =>
        sendResponse({ ok: false, error: String((err && err.message) || err) })
      );
    return true;
  }

  if (msg.type === "GET_STATE") {
    hasOffscreenDocument().then((recording) => sendResponse({ recording }));
    return true;
  }

  // From the offscreen document once it has fully torn down: close it so the
  // mic/tab capture indicators clear and resources are released.
  if (msg.type === "OFFSCREEN_STOPPED") {
    (async () => {
      if (await hasOffscreenDocument()) {
        await chrome.offscreen.closeDocument().catch(() => {});
      }
    })();
    // No response needed.
  }

  // TRANSCRIPT_CHUNK / RMS_LEVELS / CAPTURE_ERROR / CAPTURE_WARNING are consumed
  // directly by the side panel; the worker ignores them.
});
