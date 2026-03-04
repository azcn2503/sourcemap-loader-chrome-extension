/**
 * devtools.js
 * Runs in the DevTools context. Creates the panel and bridges
 * communication between the panel and the background service worker.
 */

chrome.devtools.panels.create(
  "SourceMap Loader",
  "icons/icon16.png",
  "panel.html",
  (panel) => {
    console.log("[SourceMap Loader] DevTools panel created");
  }
);
