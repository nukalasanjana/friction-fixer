// background.js — Inferential layer
// Orchestrates: content script <-> sidepanel <-> Ollama

const OLLAMA_URL = "http://localhost:11434/api/generate";
const OLLAMA_MODEL = "gemma3:4b"; // change to whichever model you have pulled

// Open the side panel when the extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    // Content script sends captured DOM context
    case "DOM_CONTEXT":
      // Store it so the sidepanel can retrieve it
      chrome.storage.session.set({ domContext: message.payload });
      // Notify the sidepanel that fresh context arrived
      broadcastToSidePanel({ type: "DOM_CONTEXT_READY", payload: message.payload });
      break;

    // Sidepanel asks us to call Ollama
    case "GENERATE_PATCH":
      generatePatch(message.payload)
        .then((patch) => sendResponse({ ok: true, patch }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true; // keep message channel open for async response

    // Sidepanel approved a patch — inject it
    case "APPLY_PATCH":
      applyPatch(message.tabId, message.payload)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    // Sidepanel wants to undo last patch
    case "UNDO_PATCH":
      undoPatch(message.tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
  }
});

// ── Ollama integration ────────────────────────────────────────────────────────
async function generatePatch({ userComplaint, domContext }) {
  const systemPrompt = `You are a CSS/JS code generator for fixing UI usability issues.
You receive:
1. A user's natural-language complaint about a webpage element
2. The relevant HTML/CSS of that element

OUTPUT RULES — follow exactly:
- Output ONLY raw JavaScript that can be injected directly into a page via eval()
- Use document.querySelector() with the provided selector
- Prefer CSS style property changes over adding new elements
- Wrap your style changes in a <style> tag injected into <head> with id="friction-fixer-patch"
- Do NOT output markdown, backticks, explanations, or comments
- Your entire output must be valid JavaScript, nothing else

Example output format:
(function(){const s=document.createElement('style');s.id='friction-fixer-patch';s.textContent='.some-selector{font-size:18px;color:#333;}';document.head.appendChild(s);})();`;

  const userPrompt = `User complaint: "${userComplaint}"

Relevant DOM element:
Selector: ${domContext.selector}
HTML: ${domContext.html}
Computed styles (relevant): ${JSON.stringify(domContext.styles)}

Generate a JavaScript patch to fix this issue.`;

  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: userPrompt,
      system: systemPrompt,
      stream: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.response.trim();
}

// ── Patch injection ───────────────────────────────────────────────────────────
async function applyPatch(tabId, patchCode) {
  // Save patch to session storage for undo
  await chrome.storage.session.set({ lastPatch: patchCode, lastPatchTabId: tabId });

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (code) => {
      try {
        // Remove any previous patch first
        const existing = document.getElementById("friction-fixer-patch");
        if (existing) existing.remove();
        // eslint-disable-next-line no-eval
        eval(code);
      } catch (e) {
        console.error("[FrictionFixer] Patch failed:", e);
      }
    },
    args: [patchCode],
  });
}

async function undoPatch(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const patch = document.getElementById("friction-fixer-patch");
      if (patch) patch.remove();
      // Also undo any inline styles added by the patch (look for data attribute)
      document.querySelectorAll("[data-ff-original-style]").forEach((el) => {
        el.style.cssText = el.getAttribute("data-ff-original-style");
        el.removeAttribute("data-ff-original-style");
      });
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcastToSidePanel(message) {
  // Side panel listens via chrome.runtime.onMessage
  chrome.runtime.sendMessage(message).catch(() => {
    // Sidepanel might not be open yet — that's fine
  });
}
