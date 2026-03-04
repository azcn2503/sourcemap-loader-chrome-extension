/**
 * panel.js
 * Runs in the DevTools panel page context.
 * Communicates with background.js via chrome.runtime.sendMessage.
 */

// ─── State ────────────────────────────────────────────────────────────────────

let currentTabId = chrome.devtools.inspectedWindow.tabId;
let attached = false;
let scripts = new Map(); // url → script entry (we key by url for deduplication)
let filterText = "";
let autoScroll = true;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const toggleBtn     = document.getElementById("toggle-btn");
const clearBtn      = document.getElementById("clear-btn");
const clearLogBtn   = document.getElementById("clear-log-btn");
const statusBadge   = document.getElementById("status-badge");
const filterInput   = document.getElementById("filter-input");
const autoScrollCb  = document.getElementById("auto-scroll");
const countLabel    = document.getElementById("count-label");
const tbody         = document.getElementById("scripts-tbody");
const emptyRow      = document.getElementById("empty-row");
const logOutput     = document.getElementById("log-output");

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const state = await sendMsg({ type: "GET_STATE", tabId: currentTabId });
  if (state.attached) {
    attached = true;
    state.scripts.forEach(s => scripts.set(s.url, s));
    updateAttachUI();
    renderAll();
    log("info", `Restored state: ${scripts.size} scripts tracked.`);
  }
}

init();

// ─── Message listener (from background) ──────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.tabId !== undefined && message.tabId !== currentTabId) return;

  switch (message.type) {
    case "ATTACHED":
      attached = true;
      updateAttachUI();
      log("ok", "Debugger attached. Reload the page to capture bundles.");
      break;

    case "DETACHED":
      attached = false;
      updateAttachUI();
      log("warn", "Debugger detached.");
      break;

    case "SCRIPT_DETECTED":
      upsertScript(message.script);
      log("info", `Detected: ${shortUrl(message.script.url)}`);
      break;

    case "SCRIPT_UPDATED":
      upsertScript(message.script);
      const s = message.script;
      if (s.status === "map_found")
        log("ok", `Map found & injected: ${shortUrl(s.sourceMapURL)}`);
      else if (s.status === "no_map")
        log("warn", `No map found for: ${shortUrl(s.url)}`);
      else if (s.status === "has_map")
        log("ok", `Map already present: ${shortUrl(s.sourceMapURL)}`);
      break;

    case "HEADER_MAP_FOUND":
      log("ok", `SourceMap header found for ${shortUrl(message.scriptUrl)} → ${shortUrl(message.mapUrl)}`);
      break;
  }
});

// ─── Button handlers ──────────────────────────────────────────────────────────

toggleBtn.addEventListener("click", async () => {
  toggleBtn.disabled = true;
  if (!attached) {
    const result = await sendMsg({ type: "ATTACH", tabId: currentTabId });
    if (!result.ok) log("error", `Failed to attach: ${result.error}`);
  } else {
    await sendMsg({ type: "DETACH", tabId: currentTabId });
  }
  toggleBtn.disabled = false;
});

clearBtn.addEventListener("click", () => {
  scripts.clear();
  renderAll();
  log("info", "Cleared script list.");
});

clearLogBtn.addEventListener("click", () => {
  logOutput.innerHTML = "";
});

filterInput.addEventListener("input", () => {
  filterText = filterInput.value.toLowerCase();
  renderAll();
});

autoScrollCb.addEventListener("change", () => {
  autoScroll = autoScrollCb.checked;
});

// ─── Rendering ────────────────────────────────────────────────────────────────

function upsertScript(entry) {
  scripts.set(entry.url, entry);
  renderAll();
}

function renderAll() {
  const entries = Array.from(scripts.values())
    .filter(s => !filterText || s.url.toLowerCase().includes(filterText) || (s.sourceMapURL || "").toLowerCase().includes(filterText))
    .sort((a, b) => a.url.localeCompare(b.url));

  const visibleCount = entries.length;
  const total = scripts.size;
  countLabel.textContent = filterText
    ? `${visibleCount} / ${total} scripts`
    : `${total} script${total !== 1 ? "s" : ""}`;

  if (entries.length === 0) {
    emptyRow.style.display = "";
    // Remove all rows except emptyRow
    Array.from(tbody.querySelectorAll("tr[data-url]")).forEach(r => r.remove());
    return;
  }

  emptyRow.style.display = "none";

  // Update / insert rows
  const existingRows = new Map(
    Array.from(tbody.querySelectorAll("tr[data-url]")).map(r => [r.dataset.url, r])
  );

  entries.forEach(entry => {
    let row = existingRows.get(entry.url);
    if (!row) {
      row = document.createElement("tr");
      row.dataset.url = entry.url;
      tbody.appendChild(row);
    }
    existingRows.delete(entry.url);
    row.innerHTML = buildRowHTML(entry);

    // Retry button
    const retryBtn = row.querySelector(".retry-btn");
    if (retryBtn) {
      retryBtn.addEventListener("click", () => retryInject(entry));
    }
  });

  // Remove stale rows
  existingRows.forEach(r => r.remove());

  if (autoScroll) {
    document.getElementById("table-wrap").scrollTop = 99999;
  }
}

function buildRowHTML(entry) {
  const statusLabel = ({
    detected: "Detected",
    has_map:  "Has Map",
    map_found:"Injected",
    no_map:   "No Map",
  })[entry.status] || entry.status;

  const pillClass = `pill pill--${entry.injected ? "injected" : entry.status}`;
  const displayStatus = entry.injected ? "Injected" : statusLabel;

  const urlOrigin = (() => {
    try { const u = new URL(entry.url); return u.origin + "/"; } catch { return ""; }
  })();
  const urlPath = entry.url.replace(urlOrigin, "");

  const mapCell = entry.sourceMapURL
    ? `<a href="${entry.sourceMapURL}" title="${entry.sourceMapURL}" target="_blank">${shortUrl(entry.sourceMapURL)}</a>`
    : `<span class="no-map-text">—</span>`;

  const retryBtn = (entry.status === "map_found" || entry.status === "has_map") && entry.sourceMapURL
    ? `<button class="btn btn--ghost btn--xs retry-btn" title="Re-inject sourceMappingURL">↺</button>`
    : "";

  return `
    <td><span class="${pillClass}">${displayStatus}</span></td>
    <td class="url-cell">
      <span class="url-text" title="${entry.url}">
        <span class="url-origin">${urlOrigin}</span>${urlPath}
      </span>
    </td>
    <td class="map-cell">${mapCell}</td>
    <td class="actions-cell">${retryBtn}</td>
  `;
}

// ─── Attach UI ────────────────────────────────────────────────────────────────

function updateAttachUI() {
  if (attached) {
    statusBadge.textContent = "Attached";
    statusBadge.className = "badge badge--attached";
    toggleBtn.textContent = "Detach";
  } else {
    statusBadge.textContent = "Detached";
    statusBadge.className = "badge badge--detached";
    toggleBtn.textContent = "Attach";
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function retryInject(entry) {
  log("info", `Re-injecting for ${shortUrl(entry.url)}…`);
  const result = await sendMsg({
    type: "RETRY_INJECT",
    tabId: currentTabId,
    scriptId: entry.scriptId,
  });
  if (result.ok) log("ok", "Re-injection sent.");
  else log("error", result.error);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendMsg(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response || {});
    });
  });
}

function shortUrl(url) {
  if (!url) return "";
  try {
    const u = new URL(url);
    return u.pathname.split("/").pop() || u.pathname;
  } catch {
    return url.split("/").pop() || url;
  }
}

function log(level, msg) {
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}:${String(now.getSeconds()).padStart(2,"0")}`;

  const entry = document.createElement("div");
  entry.className = `log-entry log-entry--${level}`;
  entry.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${msg}</span>`;
  logOutput.appendChild(entry);

  // Keep log bounded
  while (logOutput.children.length > 200) {
    logOutput.removeChild(logOutput.firstChild);
  }

  if (autoScroll) logOutput.scrollTop = logOutput.scrollHeight;
}
