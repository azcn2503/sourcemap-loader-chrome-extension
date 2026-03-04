/**
 * background.js
 *
 * Intercepts JS bundle responses via the CDP Fetch domain, appends a
 * //# sourceMappingURL pragma to the response body, and fulfills the request
 * with the patched body so V8 sees the pragma when parsing the script.
 *
 * Encoding contract
 * -----------------
 * Fetch.getResponseBody always returns base64-encoded data when
 * base64Encoded=true, and raw text otherwise. We always round-trip through
 * Uint8Array so we never corrupt bytes with btoa/atob string coercion.
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

async function handleFetchRequestPaused(tabId, params, state) {
  const { requestId, request, responseHeaders, responseStatusCode } = params;
  const url = request.url;

  if (!BUNDLE_PATTERN.test(url)) {
    await continueResponse(tabId, requestId);
    return;
  }

  const headersArray = responseHeaders || [];
  const headerMap = Object.fromEntries(
    headersArray.map(h => [h.name.toLowerCase(), h.value])
  );

  // Already has a SourceMap header — pass through untouched
  const existingMapHeader = headerMap["sourcemap"] || headerMap["x-sourcemap"];
  if (existingMapHeader) {
    const resolvedMap = resolveMapUrl(url, existingMapHeader);
    recordScript(tabId, state, { url, sourceMapURL: resolvedMap, status: "has_map", intercepted: false });
    await continueResponse(tabId, requestId);
    return;
  }

  // Probe for <url>.map
  const probeUrl = url.split("?")[0] + ".map";
  const mapExists = await probeMapUrl(probeUrl);

  if (!mapExists) {
    recordScript(tabId, state, { url, sourceMapURL: null, status: "no_map", intercepted: false });
    await continueResponse(tabId, requestId);
    return;
  }

  // Map found — patch the response body
  try {
    const bodyResult = await sendCommand(tabId, "Fetch.getResponseBody", { requestId });

    // Convert whatever we got into a Uint8Array of the raw bytes
    const originalBytes = bodyResult.base64Encoded
      ? base64ToBytes(bodyResult.body)
      : stringToBytes(bodyResult.body);

    // The pragma to append — plain ASCII, safe to encode directly
    const pragma = `\n//# sourceMappingURL=${probeUrl}\n`;
    const pragmaBytes = stringToBytes(pragma);

    // Concatenate and re-encode as base64
    const patched = concatBytes(originalBytes, pragmaBytes);
    const patchedBase64 = bytesToBase64(patched);

    await sendCommand(tabId, "Fetch.fulfillRequest", {
      requestId,
      responseCode: responseStatusCode || 200,
      responseHeaders: headersArray,
      body: patchedBase64,
    });

    recordScript(tabId, state, { url, sourceMapURL: probeUrl, status: "map_found", intercepted: true });
  } catch (err) {
    console.warn("[SourceMap Loader] body patching failed, passing through:", err.message);
    await continueResponse(tabId, requestId).catch(() => {});
    recordScript(tabId, state, { url, sourceMapURL: probeUrl, status: "error", intercepted: false });
  }
}

// --- Debugger.scriptParsed ---------------------------------------------------

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

// --- Encoding helpers --------------------------------------------------------

/** base64 string -> Uint8Array, using chunked atob to handle large payloads */
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode a JS string to UTF-8 bytes via TextEncoder.
 * Used for the pragma (ASCII-only) and for plain-text bodies returned by CDP.
 *
 * When CDP returns base64Encoded=false the body is already a JS string that
 * represents the decoded text. We re-encode to UTF-8 bytes so we can
 * concatenate and round-trip through base64 without corruption.
 */
function stringToBytes(str) {
  return new TextEncoder().encode(str);
}

/** Concatenate two Uint8Arrays */
function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/**
 * Uint8Array -> base64 string.
 * Processes in 8 kB chunks to avoid stack overflows from
 * Function.prototype.apply on large arrays.
 */
function bytesToBase64(bytes) {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// --- Misc helpers ------------------------------------------------------------

function recordScript(tabId, state, entry) {
  const existing = state.scripts.get(entry.url);
  if (existing?.intercepted && !entry.intercepted) return;

  state.scripts.set(entry.url, entry);
  broadcastToPanel({ type: existing ? "SCRIPT_UPDATED" : "SCRIPT_DETECTED", tabId, script: entry });

  if (entry.status === "map_found" && entry.intercepted) {
    broadcastToPanel({ type: "LOG", tabId, level: "ok", msg: `Pragma injected: ${shortUrl(entry.url)} -> ${shortUrl(entry.sourceMapURL)}` });
  } else if (entry.status === "no_map") {
    broadcastToPanel({ type: "LOG", tabId, level: "warn", msg: `No map found for: ${shortUrl(entry.url)}` });
  } else if (entry.status === "has_map") {
    broadcastToPanel({ type: "LOG", tabId, level: "ok", msg: `Map already present: ${shortUrl(entry.url)}` });
  } else if (entry.status === "error") {
    broadcastToPanel({ type: "LOG", tabId, level: "error", msg: `Patching failed for: ${shortUrl(entry.url)}` });
  }
}

async function continueResponse(tabId, requestId) {
  try {
    await sendCommand(tabId, "Fetch.continueResponse", { requestId });
  } catch (err) {
    console.warn("[SourceMap Loader] continueResponse failed:", err.message);
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
  chrome.runtime.sendMessage(message).catch(() => {});
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
