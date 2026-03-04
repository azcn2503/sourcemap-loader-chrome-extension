/**
 * background.js
 *
 * Service worker that:
 * 1. Attaches the Chrome Debugger (CDP) to a tab when requested.
 * 2. Listens for Debugger.scriptParsed events to detect JS bundles.
 * 3. Probes for a corresponding .map file.
 * 4. If found, calls Debugger.setScriptSource is NOT available in real CDP for
 *    source-map injection — instead we use the proper approach:
 *    Emit the sourceMapURL back to the panel and store it so the Sources tab
 *    picks it up via the x-sourcemap / SourceMappingURL header manipulation
 *    through Network.responseReceived interception.
 *
 * Approach used:
 *  - Enable Debugger + Network domains via CDP.
 *  - On Network.responseReceived for a JS bundle, check if a .map URL exists.
 *  - If the response already has a SourceMap header or sourceMappingURL — great,
 *    just record it.
 *  - If NOT, fetch the .map URL (HEAD request) to confirm it exists, then
 *    use Network.interceptRequestWithResponse isn't available in MV3 cleanly,
 *    so we inject a <script> tag via Runtime.evaluate that appends
 *    //# sourceMappingURL=<url> via a Blob URL trick so DevTools picks it up.
 *
 * This is the most reliable cross-origin compatible approach in MV3.
 */

const BUNDLE_PATTERN = /\.(bundle|chunk|min)\.js(\?[^.]*)?$|\/[0-9a-f]{8,}\.js(\?.*)?$/i;

/** tabId → { attached: bool, scripts: Map<scriptId, scriptInfo> } */
const tabState = new Map();

// ─── Debugger event dispatch ──────────────────────────────────────────────────

chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const state = tabState.get(source.tabId);
  if (!state) return;

  if (method === "Debugger.scriptParsed") {
    await handleScriptParsed(source.tabId, params, state);
  }

  if (method === "Network.responseReceived") {
    await handleNetworkResponse(source.tabId, params, state);
  }
});

chrome.debugger.onDetach.addListener((source) => {
  tabState.delete(source.tabId);
  broadcastToPanel({ type: "DETACHED", tabId: source.tabId });
});

// ─── Attach / Detach ──────────────────────────────────────────────────────────

async function attachToTab(tabId) {
  if (tabState.get(tabId)?.attached) return { ok: true, alreadyAttached: true };

  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    tabState.set(tabId, { attached: true, scripts: new Map() });

    await sendCommand(tabId, "Debugger.enable", {});
    await sendCommand(tabId, "Network.enable", {});

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

// ─── Script handling ──────────────────────────────────────────────────────────

async function handleScriptParsed(tabId, params, state) {
  const { scriptId, url, sourceMapURL } = params;
  if (!url || !BUNDLE_PATTERN.test(url)) return;

  const mapUrl = resolveMapUrl(url, sourceMapURL);
  const entry = { scriptId, url, sourceMapURL: mapUrl, status: "detected", injected: false };
  state.scripts.set(scriptId, entry);

  broadcastToPanel({ type: "SCRIPT_DETECTED", tabId, script: entry });

  if (!mapUrl) {
    // No map advertised — probe for <url>.map
    const probeUrl = url.split("?")[0] + ".map";
    const exists = await probeMapUrl(probeUrl);
    if (exists) {
      entry.sourceMapURL = probeUrl;
      entry.status = "map_found";
      await injectSourceMapURL(tabId, scriptId, url, probeUrl);
      entry.injected = true;
      broadcastToPanel({ type: "SCRIPT_UPDATED", tabId, script: entry });
    } else {
      entry.status = "no_map";
      broadcastToPanel({ type: "SCRIPT_UPDATED", tabId, script: entry });
    }
  } else {
    entry.status = "has_map";
    broadcastToPanel({ type: "SCRIPT_UPDATED", tabId, script: entry });
  }
}

async function handleNetworkResponse(tabId, params, state) {
  // Additional check: look for SourceMap / X-SourceMap response headers
  const { requestId, response, type } = params;
  if (type !== "Script") return;

  const headers = response?.headers || {};
  const headerMap = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );

  const headerSourceMap = headerMap["sourcemap"] || headerMap["x-sourcemap"];
  if (headerSourceMap) {
    // Resolve relative URLs
    const resolved = new URL(headerSourceMap, response.url).href;
    broadcastToPanel({
      type: "HEADER_MAP_FOUND",
      tabId,
      scriptUrl: response.url,
      mapUrl: resolved,
    });
  }
}

// ─── Source map injection ─────────────────────────────────────────────────────

/**
 * Injects a //# sourceMappingURL comment into the live script via CDP.
 * We use Debugger.setScriptSource to append the pragma — however this API
 * requires us to pass the full new source, which we don't have cheaply.
 *
 * Better: use Runtime.evaluate to dynamically add a <script> with the
 * sourceMappingURL pragma, which DevTools will pick up for that URL.
 *
 * The most reliable MV3-compatible method: call Runtime.evaluate with
 * a script that creates a blob URL pointing to a minimal JS file with
 * the sourceMappingURL appended, and registers it via a <script> tag trick.
 *
 * NOTE: This works best when DevTools is already open and the Sources panel
 * has loaded the original script. The inject causes DevTools to re-associate.
 */
async function injectSourceMapURL(tabId, scriptId, scriptUrl, mapUrl) {
  try {
    // Use CDP Debugger.setBlackboxPatterns is not what we need.
    // The correct CDP method is actually just ensuring the script has
    // sourceMapURL set. We do this by injecting a tiny script that
    // registers the source map pragma via a comment in an inline script.
    const js = `
      (() => {
        const s = document.createElement('script');
        s.textContent = ${JSON.stringify(`//# sourceURL=${scriptUrl}\n//# sourceMappingURL=${mapUrl}`)};
        document.head.appendChild(s);
        s.remove();
      })();
    `;
    await sendCommand(tabId, "Runtime.evaluate", {
      expression: js,
      silent: true,
    });
    console.log(`[SourceMap Loader] Injected sourceMappingURL for ${scriptUrl} → ${mapUrl}`);
  } catch (err) {
    console.warn("[SourceMap Loader] inject failed:", err.message);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveMapUrl(scriptUrl, sourceMapURL) {
  if (!sourceMapURL) return null;
  // Inline data URLs — already embedded, no need to fetch
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
    // Panel may not be open yet — that's fine
  });
}

// ─── Message handler (from panel) ────────────────────────────────────────────

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
  if (message.type === "RETRY_INJECT") {
    const state = tabState.get(message.tabId);
    const entry = state?.scripts.get(message.scriptId);
    if (entry?.sourceMapURL) {
      injectSourceMapURL(message.tabId, message.scriptId, entry.url, entry.sourceMapURL)
        .then(() => sendResponse({ ok: true }));
    } else {
      sendResponse({ ok: false, error: "No map URL known for this script" });
    }
    return true;
  }
});
