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
  const systemPrompt = `You are a JavaScript code generator. Output ONLY a single self-executing JavaScript function. No markdown, no backticks, no explanation.

The code MUST follow this exact pattern:
(function(){
  var s = document.createElement('style');
  s.id = 'friction-fixer-patch';
  s.textContent = 'SELECTOR { CSS_PROPERTY: VALUE !important; }';
  document.head.appendChild(s);
})();

Rules:
- Use !important on every CSS value
- Use the exact selector provided
- Output nothing except the JavaScript function`;

  const userPrompt = `Fix this problem: "${userComplaint}"

Element selector: ${domContext.selector}
Element tag: ${domContext.tagName}
Current font-size: ${domContext.styles.fontSize}
Current color: ${domContext.styles.color}
Current background: ${domContext.styles.backgroundColor}

Output ONLY the JavaScript function. Start your response with (function(){`;

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
  let code = data.response.trim();
  // Strip markdown code fences gemma likes to add
  code = code.replace(/^```[\w]*\n?/m, "").replace(/```$/m, "").trim();
  return code;
}

// ── Patch injection ───────────────────────────────────────────────────────────
async function applyPatch(tabId, patchCode) {
  await chrome.storage.session.set({ lastPatch: patchCode, lastPatchTabId: tabId });

  await chrome.scripting.executeScript({
    target: { tabId },
    func: (code) => {
      console.log("[FrictionFixer] Injecting patch:", code);
      try {
        // Remove any previous patch
        const existing = document.getElementById("friction-fixer-patch");
        if (existing) existing.remove();

        // Extract the CSS string from inside s.textContent = '...';
        // This avoids eval entirely — we just parse the CSS out and inject it directly
        const match = code.match(/s\.textContent\s*=\s*'([\s\S]*?)'\s*;/);
        if (match) {
          const style = document.createElement("style");
          style.id = "friction-fixer-patch";
          style.textContent = match[1];
          document.head.appendChild(style);
          console.log("[FrictionFixer] Patch injected via CSS extraction:", match[1]);
        } else {
          // Fallback: try to find any CSS-like block in the code
          const cssMatch = code.match(/\{[\s\S]*?\}/);
          const selectorMatch = code.match(/['"]([^'"]+\{[\s\S]*?\})['"]/);
          if (selectorMatch) {
            const style = document.createElement("style");
            style.id = "friction-fixer-patch";
            style.textContent = selectorMatch[1];
            document.head.appendChild(style);
            console.log("[FrictionFixer] Patch injected via fallback extraction");
          } else {
            console.error("[FrictionFixer] Could not extract CSS from patch:", code);
          }
        }
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
