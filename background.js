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
      chrome.storage.session.set({ domContext: message.payload });
      broadcastToSidePanel({ type: "DOM_CONTEXT_READY", payload: message.payload });
      break;

    // Sidepanel asks us to call Ollama — returns structured JSON patch
    case "GENERATE_PATCH":
      generatePatch(message.payload)
        .then((patch) => sendResponse({ ok: true, patch }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true; // keep message channel open for async response

    // Sidepanel approved a patch — inject its CSS into the live page
    case "APPLY_PATCH":
      chrome.storage.session.get(["domContext"]).then(({ domContext }) => {
        applyPatch(message.tabId, message.payload, domContext)
          .then((result) => sendResponse({ ok: true, ...result }))
          .catch((err) => sendResponse({ ok: false, error: err.message }));
      });
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
async function generatePatch({ userComplaint, domContext, conversationHistory = [] }) {
  const systemPrompt = `You are an expert HCI/UX researcher and adaptive UI accessibility auditor embedded in a Chrome extension called Friction Fixer.

Your job is to diagnose interface friction from DOM snapshots and generate CSS patches that improve usability and accessibility.

## STRICT OUTPUT FORMAT
Respond ONLY with a single valid JSON object. No markdown, no code fences, no prose outside the JSON object. The very first character of your response must be "{".

## JSON SCHEMA — all fields required
{
  "ux_diagnosis": "Plain-language explanation of the specific cognitive friction or accessibility barrier present in the captured DOM. Name the element and describe the barrier concretely.",
  "adaptation_strategy": "Exactly one of: Conservation | Rearrangement | Simplification | Reduction | Increase",
  "user_rationale": "1-2 sentences that trust-calibrate the user: explain how this specific CSS patch resolves their stated pain point and why this strategy was chosen over alternatives.",
  "socratic_question": null,
  "executable_code": "Valid CSS rules only — no JavaScript. Example: body { font-size: 18px !important; line-height: 1.6 !important; }"
}

## ADAPTATION STRATEGIES — choose the most appropriate one
- Conservation: Scale elements (font size, spacing, contrast) while preserving existing layout structure. Use for readability and legibility problems.
- Rearrangement: Reposition or reflow elements to optimize spatial flow and navigation (e.g., flexbox order, position). Use for layout and navigation issues.
- Simplification: Reduce visual complexity — suppress noise, flatten cluttered regions. Use for cognitive overload and visual clutter.
- Reduction: Hide non-essential UI elements entirely for a minimal, focused experience (graceful degradation). Use for maximalist designs that overwhelm.
- Increase: Add clarifying visual cues via CSS ::before/::after pseudo-elements (progressive enhancement). Use when navigation labels or hints are missing.

## ACCESSIBILITY AUDIT CHECKLIST — apply when forming your diagnosis
- WCAG 2.1 contrast: text/background pairs must meet 4.5:1 ratio (3:1 for large text ≥18px)
- Minimum readable font size: 16px body text; 14px acceptable for bold/UI labels
- Interactive elements need a visible :focus-visible indicator (outline)
- Clickable touch targets should be at least 44×44 CSS px
- Line height should be at least 1.5 for paragraph text
- Avoid color as the sole means of conveying information

## SUBTRACTIVE SCULPTING PRIORITY
Prefer hiding, collapsing, or de-emphasising distracting elements (Reduction/Simplification) over adding new ones. Only use Increase when a critical navigation cue is absent.

## SOCRATIC QUESTION RULES — when the intent is ambiguous
- If the user's complaint could apply to multiple distinct elements, or the desired outcome is unclear, set "socratic_question" to a single focused diagnostic question that narrows the intent.
- If the intent is specific and actionable from the DOM context alone, set "socratic_question" to null.
- When socratic_question is non-null, set "executable_code" to "" (empty string) — do NOT generate code when asking for clarification.
- NEVER guess — always ask if genuinely uncertain.

## RULES FOR executable_code
- Output ONLY valid CSS rules. The extension wraps your CSS in a <style> tag automatically.
- Use !important on all CSS values to override page specificity.
- To hide elements: use display: none !important or visibility: hidden !important
- To enlarge text: use font-size, line-height, letter-spacing
- Always use the exact element selector provided in the DOM context.
- Do NOT output JavaScript, @import rules, or external URLs.
- When executable_code is empty (socratic case), output: ""`;

  // Build conversation history block
  let historyBlock = "";
  if (conversationHistory.length > 0) {
    historyBlock = "\n\n## CONVERSATION HISTORY (for context)\n" +
      conversationHistory
        .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
        .join("\n");
  }

  const userPrompt = `${historyBlock}

## USER COMPLAINT
"${userComplaint}"

## CAPTURED DOM CONTEXT
Element selector : ${domContext.selector}
Tag              : <${domContext.tagName}>
Page URL         : ${domContext.pageUrl}
Font size        : ${domContext.styles.fontSize   || "unknown"}
Color            : ${domContext.styles.color       || "unknown"}
Background       : ${domContext.styles.backgroundColor || "unknown"}
Font weight      : ${domContext.styles.fontWeight  || "unknown"}
Line height      : ${domContext.styles.lineHeight  || "unknown"}
Padding          : ${domContext.styles.padding     || "unknown"}
Opacity          : ${domContext.styles.opacity     || "unknown"}
Display          : ${domContext.styles.display     || "unknown"}
Visibility       : ${domContext.styles.visibility  || "unknown"}
HTML snippet     : ${domContext.html.slice(0, 600)}
Text content     : "${domContext.textContent.slice(0, 150)}"

Respond ONLY with the JSON object. Start your response with the character "{".`;

  const response = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: userPrompt,
      system: systemPrompt,
      stream: false,
      options: {
        temperature: 0.2,  // low temp → more deterministic JSON output
        top_p: 0.9,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return parseStructuredResponse(data.response);
}

// ── JSON response parser ──────────────────────────────────────────────────────
function parseStructuredResponse(rawText) {
  // Strip any markdown code fences the LLM may have added despite instructions
  let text = rawText.trim()
    .replace(/^```(?:json)?\s*/im, "")
    .replace(/```\s*$/m, "")
    .trim();

  // Locate the outermost JSON object
  const start = text.indexOf("{");
  const end   = text.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new Error(
      "LLM did not return a JSON object. Raw response: " + text.slice(0, 300)
    );
  }

  const jsonStr = text.slice(start, end + 1);

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (e) {
    throw new Error(
      `Failed to parse LLM JSON: ${e.message}. Snippet: ${jsonStr.slice(0, 300)}`
    );
  }

  // Validate required fields
  const required = ["ux_diagnosis", "adaptation_strategy", "user_rationale", "executable_code"];
  for (const field of required) {
    if (parsed[field] === undefined) {
      throw new Error(`LLM response missing required field: "${field}"`);
    }
  }

  // Normalize socratic_question to null if LLM output a string "null"
  if (
    !parsed.socratic_question ||
    String(parsed.socratic_question).toLowerCase() === "null" ||
    String(parsed.socratic_question).toLowerCase() === "none" ||
    parsed.socratic_question.trim() === ""
  ) {
    parsed.socratic_question = null;
  }

  // Validate strategy value
  const validStrategies = ["Conservation", "Rearrangement", "Simplification", "Reduction", "Increase"];
  if (!validStrategies.includes(parsed.adaptation_strategy)) {
    // Try to fuzzy-match
    const found = validStrategies.find((s) =>
      parsed.adaptation_strategy.toLowerCase().includes(s.toLowerCase())
    );
    parsed.adaptation_strategy = found || "Conservation";
  }

  return parsed;
}

// ── Patch injection ───────────────────────────────────────────────────────────
// cssCode is the raw CSS string from the LLM's executable_code field
async function applyPatch(tabId, cssCode, domContext) {
  await chrome.storage.session.set({ lastPatchCss: cssCode, lastPatchTabId: tabId });

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (css, selector) => {
      try {
        document.querySelectorAll("[style]").forEach((el) => {
          if (!el.hasAttribute("data-ff-original-style")) {
            el.setAttribute("data-ff-original-style", el.getAttribute("style") || "");
          }
        });

        document.querySelectorAll("style[data-ff-patch]").forEach((s) => s.remove());
        document.getElementById("friction-fixer-patch")?.remove();

        if (!css || !css.trim()) return { elementCount: 0 };

        let finalCss = css.trim();

        // Replace any ff-highlight or generic selectors with the real captured selector
        finalCss = finalCss.replace(/[a-z]*\.ff-highlight/g, selector);

        // Also replace if LLM used a bare tag selector that's too broad
        // e.g. "p { ... }" → use the specific selector instead
        finalCss = finalCss.replace(/^(p|div|span|a|h[1-6]|li|ul|section)\s*\{/gm, `${selector} {`);

        const style = document.createElement("style");
        style.id = "friction-fixer-patch";
        style.setAttribute("data-ff-patch", "1");
        style.textContent = finalCss;
        document.head.appendChild(style);

        // Also apply inline styles directly to matched elements so the patch
        // takes effect even when the page has competing !important rules with
        // higher specificity (inline styles always win over stylesheets).
        const elements = Array.from(document.querySelectorAll(selector));
        elements.forEach((el) => {
          if (!el.hasAttribute("data-ff-original-style")) {
            el.setAttribute("data-ff-original-style", el.getAttribute("style") || "");
          }
          // Parse every property-value pair from the CSS block
          const propRegex = /([\w-]+)\s*:\s*([^;!}]+?)(?:\s*!important)?\s*[;}\n]/g;
          let m;
          while ((m = propRegex.exec(css)) !== null) {
            const prop = m[1].trim();
            const val  = m[2].trim();
            if (prop && val) el.style.setProperty(prop, val, "important");
          }
        });

        // Flash a brief purple outline on each patched element so the user
        // can see which part of the page was targeted.
        elements.forEach((el) => {
          el.style.setProperty("outline", "2px solid #7c3aed", "important");
          el.style.setProperty("outline-offset", "2px", "important");
          setTimeout(() => {
            el.style.removeProperty("outline");
            el.style.removeProperty("outline-offset");
          }, 1200);
        });

        console.log("[FrictionFixer] Patch injected:", finalCss.slice(0, 150),
          "| Elements matched:", elements.length);
        return { elementCount: elements.length };
      } catch (e) {
        console.error("[FrictionFixer] Patch injection error:", e);
        return { elementCount: -1, error: e.message };
      }
    },
    args: [cssCode, domContext?.selector || "body"],
  });

  return results?.[0]?.result ?? {};
}
// ── Undo patch ────────────────────────────────────────────────────────────────
async function undoPatch(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // Remove all Friction Fixer injected style tags
      document.querySelectorAll("style[data-ff-patch]").forEach((s) => s.remove());
      document.getElementById("friction-fixer-patch")?.remove();

      // Restore any inline styles we snapshotted before the patch
      document.querySelectorAll("[data-ff-original-style]").forEach((el) => {
        const original = el.getAttribute("data-ff-original-style");
        if (original) {
          el.setAttribute("style", original);
        } else {
          el.removeAttribute("style");
        }
        el.removeAttribute("data-ff-original-style");
      });

      console.log("[FrictionFixer] Patch fully reverted.");
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function broadcastToSidePanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // Sidepanel might not be open yet — that's fine
  });
}
