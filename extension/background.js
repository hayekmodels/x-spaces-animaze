// Service worker: toggles tab-audio capture when the toolbar icon is clicked and
// relays audio levels from the offscreen document to the X tab's content script.

const OFFSCREEN_URL = 'offscreen.html';
const isXUrl = (url) => /^https:\/\/(x|twitter)\.com\//.test(url || '');

// The capturing tab id lives in storage.session so it survives service-worker restarts.
let captureTabId; // undefined = not loaded yet, null = not capturing

async function getCaptureTab() {
  if (captureTabId === undefined) {
    const v = await chrome.storage.session.get('captureTabId');
    captureTabId = v.captureTabId ?? null;
  }
  return captureTabId;
}

async function setCaptureTab(id) {
  captureTabId = id;
  await chrome.storage.session.set({ captureTabId: id });
}

async function badge(tabId, text, color = '#1d9bf0') {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color });
    await chrome.action.setBadgeText({ tabId, text });
  } catch {
    // tab may be gone
  }
}

function tellTab(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

async function ensureContentScript(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'XSA_PING' });
    if (r && r.ok) return;
  } catch {
    // no content script yet (tab was open before the extension was loaded)
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['USER_MEDIA'],
    justification: 'Measure the audio level of the captured X Space tab and keep it audible.',
  });
}

async function stopCapture(reason) {
  const tabId = await getCaptureTab();
  try {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'XSA_STOP' });
  } catch {
    // offscreen document not running
  }
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length) await chrome.offscreen.closeDocument();
  } catch {
    // already closed
  }
  await setCaptureTab(null);
  if (tabId != null) {
    await badge(tabId, '');
    await tellTab(tabId, { type: 'XSA_AUDIO_STATE', on: false, reason });
  }
  console.info('[XSA] capture stopped:', reason);
}

async function startCapture(tab) {
  // Ask for the stream id first, while the click's invocation grant is fresh.
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  } catch (e) {
    await ensureContentScript(tab.id).catch(() => {});
    await tellTab(tab.id, { type: 'XSA_AUDIO_STATE', on: false, error: `getMediaStreamId failed: ${e.message || e}` });
    await badge(tab.id, 'ERR', '#f4212e');
    return;
  }
  await ensureContentScript(tab.id);
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'XSA_START', streamId });
  if (!res || !res.ok) {
    await tellTab(tab.id, { type: 'XSA_AUDIO_STATE', on: false, error: `offscreen start failed: ${res ? res.error : 'no response'}` });
    await badge(tab.id, 'ERR', '#f4212e');
    return;
  }
  await setCaptureTab(tab.id);
  await badge(tab.id, 'ON', '#00ba7c');
  await tellTab(tab.id, { type: 'XSA_AUDIO_STATE', on: true });
  console.info('[XSA] capturing audio of tab', tab.id);
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!isXUrl(tab.url)) {
    await badge(tab.id, '?', '#f4212e');
    console.warn('[XSA] not an x.com tab:', tab.url);
    return;
  }
  const current = await getCaptureTab();
  if (current === tab.id) {
    await stopCapture('toggled off by user');
    return;
  }
  if (current != null) await stopCapture('switched to another tab');
  await startCapture(tab);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.source !== 'offscreen') return;
  if (msg.type === 'XSA_ENDED' || msg.type === 'XSA_ERROR') {
    stopCapture(msg.error || 'stream ended');
    return;
  }
  getCaptureTab().then((tabId) => {
    if (tabId != null) tellTab(tabId, msg);
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === (await getCaptureTab())) await stopCapture('tab closed');
});
