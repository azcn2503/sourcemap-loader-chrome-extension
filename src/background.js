/**
 * background.js
 *
 * Uses the CDP Fetch domain to intercept JS bundle responses in-flight and
 * inject a `SourceMap` response header before Chrome's JS engine parses the
 * script. This means DevTools associates the source map at parse time, so
 * call stacks resolve to original source rather than showing VM#### bundle.js.
 *
 * Flow:
 *  1. Attach CDP debugger to the tab.
 *  2. Enable Fetch domain with a pattern matching all Script resources.
 *  3. On Fetch.requestPaused (response stage):
 *     a. If the response already has a SourceMap/X-SourceMap header -> pass through.
 *     b. Otherwise probe <script-url>.map with a HEAD request.
 *     c. If the map exists, append a SourceMap header and continue the response.
 *     d. Either way, call Fetch.continueResponse so the request is never stalled.
 *  4. Also listen to Debugger.scriptParsed to catch scripts already in the page
 *     before we attached (cached / inline).
 */

const BUNDLE_PATTERN = /\.(bundle|chunk|min)\.js(\?[^.]*)?$|\/[0-9a-f]{8,}\.js(\?.*)?$/i;

/** tabId -> { attached: bool, scripts: Map<url, scriptInfo> } */
const tabState = new Map();

// --- CDP event dispatch ------------------------------------------------------

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const state = tabState.get(source.tabId);
  if (!state) return;

  if (method === "Fetch.requestPaused") {
    await handleFetchRequestPaused(source.tabId, params, state);
  }

  if (method === "Debugger.scriptParsed") {
    handleScriptParsed(source.tabId, params, state);
  }
});

chrome.debugger.onDetach.addListener((source) => {
  tabState.delete(source.tabId);
  broadcastToPanel({ type: "DETACHED", tabId: source.tabId });
});

// --- Attach / Detach ---------------------------------------------------------

async function attachToTab(tabId) {
  if (tabState.get(tabId)?.attached) return { ok: true, alreadyAttached: true };

  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    tabState.set(tabId, { attached: true, scripts: new Map() });

    await sendCommand(tabId, "Debugger.enable", {});

    // Intercept all Script responses — filter to bundles inside the handler
    await sendCommand(tabId, "Fetch.enable", {
      patterns: [{ requestStage: "Response", resourceType: "Script" }],
    });

    broadcastToPanel({ type: "ATTACHED", tabId });
    return { ok: true };
  } catch (err) {
    console.error("[SourceMap Loader] attach failed:", err);
    return { ok: false, error: err.message };
  }
}

async function detachFromTab(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch (_) {}
  tabState.delete(tabId);
  broadcastToPanel({ type: "DETACHED", tabId });
}

// --- Fetch interception ------------------------------------------------------

/**
 * Called for every Script response while paused.
 * We MUST always call Fetch.continueResponse before returning — otherwise
 * the request hangs indefinitely and the page stalls.
 */
async function handleFetchRequestPaused(tabId, params, state) {
  const { requestId, request, responseHeaders } = params;
  const url = request.url;

  // Pass non-bundle scripts straight through
  if (!BUNDLE_PATTERN.test(url)) {
    await continueResponse(tabId, requestId);
    return;
  }

  // Normalise headers for case-insensitive lookup
  const headersArray = responseHeaders || [];
  const headerMap = Object.fromEntries(
    headersArray.map(h => [h.name.toLowerCase(), h.value])
  );

  // Already has a SourceMap header — record and pass through
  const existingMapHeader = headerMap["sourcemap"] || headerMap["x-sourcemap"];
  if (existingMapHeader) {
    const resolvedMap = resolveMapUrl(url, existingMapHeader);
    recordScript(tabId, state, { url, sourceMapURL: resolvedMap, status: "has_map", intercepted: false });
    await continueResponse(tabId, requestId);
    return;
  }

  // No header — probe for <url>.map
  const probeUrl = url.split("?")[0] + ".map";
  const mapExists = await probeMapUrl(probeUrl);

  if (!mapExists) {
    recordScript(tabId, state, { url, sourceMapURL: null, status: "no_map", intercepted: false });
    await continueResponse(tabId, requestId);
    return;
  }

  // Map found — inject the SourceMap header before Chrome parses the script
  const patchedHeaders = [...headersArray, { name: "SourceMap", value: probeUrl }];

  try {
    await sendCommand(tabId, "Fetch.continueResponse", {
      requestId,
      responseHeaders: patchedHeaders,
    });
    recordScript(tabId, state, { url, sourceMapURL: probeUrl, status: "map_found", intercepted: true });
  } catch (err) {
    // continueResponse failed (request cancelled etc.) — don't stall the page
    console.warn("[SourceMap Loader] continueResponse failed:", err.message);
    await continueResponse(tabId, requestId).catch(() => {});
    recordScript(tabId, state, { url, sourceMapURL: probeUrl, status: "map_found", intercepted: false });
  }
}

// --- Debugger.scriptParsed ---------------------------------------------------

/**
 * Fires after the script is parsed. The Fetch interceptor already ran by this
 * point, so sourceMapURL will be populated if we injected the header. We use
 * this mainly to catch scripts already present before we attached (cached /
 * inline scripts that bypass the Fetch domain).
 */
function handleScriptParsed(tabId, params, state) {
  const { url, sourceMapURL } = params;
  if (!url || !BUNDLE_PATTERN.test(url)) return;

  // Don't overwrite a richer entry already set by the Fetch interceptor
  if (state.scripts.has(url)) return;

  const resolvedMap = resolveMapUrl(url, sourceMapURL);
  recordScript(tabId, state, {
    url,
    sourceMapURL: resolvedMap,
    status: resolvedMap ? "has_map" : "no_map",
    intercepted: false,
  });
}

// --- Helpers -----------------------------------------------------------------

function recordScript(tabId, state, entry) {
  const existing = state.scripts.get(entry.url);
  // Don't downgrade a successfully intercepted entry with a later scriptParsed
  if (existing?.intercepted && !entry.intercepted) return;

  state.scripts.set(entry.url, entry);
  broadcastToPanel({ type: existing ? "SCRIPT_UPDATED" : "SCRIPT_DETECTED", tabId, script: entry });

  if (entry.status === "map_found" && entry.intercepted) {
    broadcastToPanel({ type: "LOG", tabId, level: "ok", msg: `SourceMap header injected: ${shortUrl(entry.url)} -> ${shortUrl(entry.sourceMapURL)}` });
  } else if (entry.status === "no_map") {
    broadcastToPanel({ type: "LOG", tabId, level: "warn", msg: `No map found for: ${shortUrl(entry.url)}` });
  } else if (entry.status === "has_map") {
    broadcastToPanel({ type: "LOG", tabId, level: "ok", msg: `Map already present: ${shortUrl(entry.url)}` });
  }
}

async function continueResponse(tabId, requestId) {
  try {
    await sendCommand(tabId, "Fetch.continueResponse", { requestId });
  } catch (err) {
    console.warn("[SourceMap Loader] continueResponse fallback failed:", err.message);
  }
}

function resolveMapUrl(scriptUrl, sourceMapURL) {
  if (!sourceMapURL) return null;
  if (sourceMapURL.startsWith("data:")) return sourceMapURL;
  try {
    return new URL(sourceMapURL, scriptUrl).href;
  } catch {
    return sourceMapURL;
  }
}

async function probeMapUrl(url) {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

function shortUrl(url) {
  if (!url) return "";
  try {
    return new URL(url).pathname.split("/").pop() || url;
  } catch {
    return url.split("/").pop() || url;
  }
}

function sendCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

function broadcastToPanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Panel may not be open — that's fine
  });
}

// --- Message handler (from panel) --------------------------------------------

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "ATTACH") {
    attachToTab(message.tabId).then(sendResponse);
    return true;
  }
  if (message.type === "DETACH") {
    detachFromTab(message.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message.type === "GET_STATE") {
    const state = tabState.get(message.tabId);
    sendResponse({
      attached: state?.attached ?? false,
      scripts: state ? Array.from(state.scripts.values()) : [],
    });
    return true;
  }
});
