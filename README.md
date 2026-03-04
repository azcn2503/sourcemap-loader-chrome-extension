# SourceMap Loader — Chrome Extension

Automatically detects JavaScript bundles loaded by any page and injects their
source maps so you can inspect original source code in the **Sources** tab.

---

## Installation (Developer Mode)

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this folder (`sourcemap-loader-chrome-extension/`)

---

## Usage

1. Open DevTools on any page (`F12` / `Cmd+Opt+I`)
2. Click the **SourceMap Loader** tab in the DevTools panel bar
3. Click **Attach** — the extension connects the CDP debugger to the tab
4. **Reload the page** — the extension will now intercept all JS bundle requests
5. Watch the panel populate with detected scripts and their map status

### Status indicators

| Status | Meaning |
|--------|---------|
| 🟡 **Detected** | Bundle seen, checking for map |
| 🟢 **Has Map** | `//# sourceMappingURL` already present in the script |
| 🟢 **Injected** | No map was present — extension found `<name>.map` and injected it |
| 🔴 **No Map** | No `.map` file found at the probed URL |

### The `↺` Retry button

If DevTools was opened *after* a script loaded, the Sources tab may not have
picked up the injected pragma. Click **↺** to re-inject without reloading.

---

## How it works

1. **CDP Debugger domain** — On attach, enables `Debugger` and `Network` CDP
   domains on the inspected tab.
2. **`Debugger.scriptParsed`** — Fires for every script loaded. The extension
   checks the `sourceMapURL` field in the event.
3. **Probe** — If no map URL is present, the extension does a `HEAD` request to
   `<script-url>.map`. If that returns `200 OK`, it records the map URL.
4. **Inject** — Uses `Runtime.evaluate` to append a tiny inline `<script>` with
   `//# sourceURL=<original>` + `//# sourceMappingURL=<map>` pragmas. DevTools
   picks these up and links the source map to the original script in Sources.
5. **Network headers** — Also monitors `Network.responseReceived` for
   `SourceMap` / `X-SourceMap` response headers as a secondary signal.

---

## Limitations

- **CORS** — The `.map` file must be publicly accessible. The extension cannot
  bypass CORS for the map fetch itself.
- **Inline source maps** (`data:application/json;base64,...`) are detected and
  reported but not re-injected (they're already embedded).
- **DevTools must be open** during page load for `scriptParsed` events to fire.
  Use the **↺** button if you attach after load.
- **MV3 service worker** — The background worker may be suspended by Chrome
  between events. Attach state is restored on panel re-open via `GET_STATE`.
- This uses the `debugger` permission which Chrome displays a warning banner
  for — that's expected for any extension using CDP.

---

## Development

No build step required — this is plain vanilla JS/HTML/CSS.

To iterate:
1. Edit source files
2. Go to `chrome://extensions` → click the **↺ reload** icon on the card
3. Close and reopen DevTools
