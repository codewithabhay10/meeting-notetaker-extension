// background.js — MV3 service worker.
//
// Responsibilities: orchestration + offscreen-document lifecycle + message
// routing ONLY. A service worker has no DOM and cannot touch MediaStream /
// Web Audio APIs — all audio work happens in the offscreen document.

const OFFSCREEN_PATH = "offscreen.html";
const BACKEND_URL = "http://localhost:8000";
const CHUNK_SECONDS = 10; // how much audio to buffer before each /transcribe call

// The tab the user last "invoked" the extension on (has the activeTab grant).
let lastInvokedTabId = null;

// IMPORTANT (MV3 activeTab gotcha): setPanelBehavior settings PERSIST across
// extension reloads. If openPanelOnActionClick was ever set to true, the panel
// keeps opening on icon-click WITHOUT firing action.onClicked — which means no
// `activeTab` grant, and tabCapture.getMediaStreamId() fails with
// "Extension has not been invoked for the current page".
//
// We force it back to FALSE so our own action.onClicked handler runs. Executing
// the action grants activeTab on the active (meeting) tab; that authorization
// persists for the tab until it navigates, so the panel's Start can capture it.
function disableOpenOnActionClick() {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch(() => {});
}
chrome.runtime.onInstalled.addListener(disableOpenOnActionClick);
disableOpenOnActionClick(); // also on every service-worker startup

chrome.action.onClicked.addListener((tab) => {
  // Open the panel synchronously inside the gesture, then remember the tab.
  if (tab && tab.windowId != null) {
    chrome.sidePanel
      .open({ windowId: tab.windowId })
      .catch((e) => console.error("sidePanel.open:", e));
  }
  if (tab) lastInvokedTabId = tab.id;
});

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
async function startCapture(micAllowed) {
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
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/invoked|activeTab/i.test(msg)) {
      throw new Error(
        "Capture not authorized for this tab. Click the extension's toolbar " +
          "icon while your meeting tab is focused (that authorizes capture), " +
          "then press Start."
      );
    }
    throw e;
  }

  await ensureOffscreenDocument();

  await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "OFFSCREEN_START",
    streamId,
    backendUrl: BACKEND_URL,
    chunkSeconds: CHUNK_SECONDS,
    micAllowed: !!micAllowed,
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
    startCapture(msg.micAllowed)
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
