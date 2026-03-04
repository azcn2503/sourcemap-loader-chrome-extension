/**
 * background.js
 *
 * The key insight: Chrome's DevTools reads sourceMapURL exclusively from the
 * Debugger.scriptParsed event. That field is populated by V8 when it parses
 * the script and finds either:
 *   a) a //# sourceMappingURL= pragma in the script body, OR
 *   b) a SourceMap / X-SourceMap HTTP response header
 *
 * Fetch.continueResponse with patched headers is NOT sufficient because
 * Chrome only allows header modification via continueResponse for request
 * headers, not response headers. To modify response headers you must use
 * Fetch.fulfillRequest, which requires supplying the full response body.
 *
 * So the correct approach is:
 *  1. Intercept the response via Fetch domain (requestStage: Response)
 *  2. Read the full response body via Fetch.getResponseBody
 *  3. Append //# sourceMappingURL=<url> to the body
 *  4. Fulfill the request with the modified body via Fetch.fulfillRequest
 *
 * This way V8 sees the pragma when parsing, scriptParsed fires with
 * sourceMapURL set, and DevTools loads and displays the source files.
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

    // Intercept all Script responses at the response stage
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

  // Already has a SourceMap header — record and pass through untouched
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

  // Map found — we need to append the pragma to the response body.
  // Fetch.continueResponse cannot modify response headers in Chrome (only
  // request headers), so we must use Fetch.fulfillRequest with the full body.
  try {
    const bodyResult = await sendCommand(tabId, "Fetch.getResponseBody", { requestId });

    // bodyResult.base64Encoded tells us if the body is base64 or plain text
    let bodyText;
    if (bodyResult.base64Encoded) {
      bodyText = atob(bodyResult.body);
    } else {
      bodyText = bodyResult.body;
    }

    // Append the sourceMappingURL pragma
    const patchedBody = bodyText + `\n//# sourceMappingURL=${probeUrl}\n`;
    const patchedBase64 = btoa(unescape(encodeURIComponent(patchedBody)));

    // Fulfill with the patched body, preserving original status and headers
    await sendCommand(tabId, "Fetch.fulfillRequest", {
      requestId,
      responseCode: responseStatusCode || 200,
      responseHeaders: headersArray,
      body: patchedBase64,
    });

    recordScript(tabId, state, { url, sourceMapURL: probeUrl, status: "map_found", intercepted: true });
  } catch (err) {
    // If body fetch or fulfill fails, don't stall the page
    console.warn("[SourceMap Loader] body patching failed, passing through:", err.message);
    await continueResponse(tabId, requestId).catch(() => {});
    recordScript(tabId, state, { url, sourceMapURL: probeUrl, status: "no_map", intercepted: false });
  }
}

// --- Debugger.scriptParsed ---------------------------------------------------

/**
 * Fires after V8 parses the script. If our body patching worked, sourceMapURL
 * will be populated here. We use this as confirmation and to catch any scripts
 * that were already present before we attached (e.g. cached).
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
  if (existing?.intercepted && !entry.intercepted) return;

  state.scripts.set(entry.url, entry);
  broadcastToPanel({ type: existing ? "SCRIPT_UPDATED" : "SCRIPT_DETECTED", tabId, script: entry });

  if (entry.status === "map_found" && entry.intercepted) {
    broadcastToPanel({ type: "LOG", tabId, level: "ok", msg: `Pragma injected into body: ${shortUrl(entry.url)} -> ${shortUrl(entry.sourceMapURL)}` });
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
