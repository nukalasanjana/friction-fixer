// sidepanel.js — Intent & Orchestration surface
// Bridges the user, the Preview Card UI, and the background LLM pipeline.

// ── State ─────────────────────────────────────────────────────────────────────
let domContext        = null;   // captured element context from content script
let pendingPatch      = null;   // structured JSON patch awaiting approval
let inspectorActive   = false;
let hasAppliedPatch   = false;
let activeTabId       = null;
let conversationHistory = [];   // [{role:"user"|"assistant", content:string}]

// Socratic mode: LLM returned a clarifying question instead of a patch
let isSocraticMode    = false;  // are we waiting for the user's clarification?
let savedComplaint    = null;   // original complaint preserved across socratic turn

// ── DOM refs ──────────────────────────────────────────────────────────────────
const chat         = document.getElementById("chat");
const contextBar   = document.getElementById("context-bar");
const input        = document.getElementById("complaint-input");
const btnSend      = document.getElementById("btn-send");
const btnInspector = document.getElementById("btn-inspector");
const btnClearCtx  = document.getElementById("btn-clear-ctx");
const btnUndo      = document.getElementById("btn-undo");
const ollamaStatus = document.getElementById("ollama-status");

// Preview Card refs
const previewCard    = document.getElementById("preview-card");
const strategyBadge  = document.getElementById("strategy-badge");
const cardDiagnosis  = document.getElementById("card-diagnosis");
const cardRationale  = document.getElementById("card-rationale");
const cardCodePre    = document.getElementById("card-code-preview");
const btnApprove     = document.getElementById("btn-approve");
const btnRejectCard  = document.getElementById("btn-reject-card");

// ── Init ──────────────────────────────────────────────────────────────────────
(async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) activeTabId = tab.id;

  pingOllama();

  // Restore captured context from previous session
  const stored = await chrome.storage.session.get(["domContext"]);
  if (stored.domContext) setContext(stored.domContext);
})();

// ── Ollama health check ───────────────────────────────────────────────────────
async function pingOllama() {
  try {
    const r = await fetch("http://localhost:11434/api/tags", {
      signal: AbortSignal.timeout(2000),
    });
    if (r.ok) {
      ollamaStatus.classList.remove("offline");
      ollamaStatus.title = "Ollama running";
    } else {
      throw new Error("not ok");
    }
  } catch {
    ollamaStatus.classList.add("offline");
    ollamaStatus.title = "Ollama not reachable — start with: ollama serve";
    addMessage("system", "⚠️ Ollama not detected. Run: ollama serve");
  }
}

// ── Background message listener ───────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "DOM_CONTEXT_READY") {
    setContext(message.payload);
    const tag = message.payload.tagName;
    const text = message.payload.textContent.slice(0, 60);
    addMessage("system", `Captured &lt;${tag}&gt; — "${text}…"`);

    // Auto-cancel inspector UI state
    inspectorActive = false;
    btnInspector.classList.remove("active");
    btnInspector.textContent = "Inspector";
  }
});

// ── Context helpers ───────────────────────────────────────────────────────────
function setContext(ctx) {
  domContext = ctx;
  contextBar.classList.remove("empty");
  contextBar.textContent =
    `${ctx.selector}  ·  <${ctx.tagName}>  ·  ${ctx.pageUrl.slice(0, 40)}…`;
}

function clearContext() {
  domContext = null;
  contextBar.classList.add("empty");
  contextBar.textContent = "No element captured — use Inspector to pick one";
}

// ── Chat helpers ──────────────────────────────────────────────────────────────
function addMessage(role, html) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = html;
  chat.appendChild(div);
  chat.scrollTop = chat.scrollHeight;
  return div;
}

// ── Preview Card ──────────────────────────────────────────────────────────────
const STRATEGY_COLORS = {
  Conservation:   "Conservation",
  Rearrangement:  "Rearrangement",
  Simplification: "Simplification",
  Reduction:      "Reduction",
  Increase:       "Increase",
};

function showPreviewCard(patch) {
  // Populate diagnosis (amber)
  cardDiagnosis.textContent = patch.ux_diagnosis || "—";

  // Populate rationale (green)
  cardRationale.textContent = patch.user_rationale || "—";

  // Strategy badge: remove all strategy classes, apply the correct one
  strategyBadge.className = "strategy-badge";
  const strategy = STRATEGY_COLORS[patch.adaptation_strategy] || "Conservation";
  strategyBadge.classList.add(strategy);
  strategyBadge.textContent = strategy;

  // Code preview
  cardCodePre.textContent = patch.executable_code || "(no code)";

  // Disable approve if there is no executable code (e.g. malformed response)
  btnApprove.disabled = !patch.executable_code || !patch.executable_code.trim();

  previewCard.classList.add("visible");
  previewCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hidePreviewCard() {
  previewCard.classList.remove("visible");
  pendingPatch = null;
}

// ── Socratic mode helpers ─────────────────────────────────────────────────────
function enterSocraticMode(question) {
  isSocraticMode = true;

  // Render the question with a distinct visual style
  addMessage("socratic", `<strong>Clarifying question:</strong> ${escapeHtml(question)}`);

  // Visually signal that the input is in clarification mode
  input.classList.add("socratic-mode");
  btnSend.classList.add("socratic-mode");
  input.placeholder = "Type your answer to refine the patch…";
}

function exitSocraticMode() {
  isSocraticMode = false;
  input.classList.remove("socratic-mode");
  btnSend.classList.remove("socratic-mode");
  input.placeholder = 'Describe the issue, e.g. "text is too small and hard to read"';
}

// ── Send complaint / socratic answer ─────────────────────────────────────────
async function handleSend() {
  const text = input.value.trim();
  if (!text) return;

  addMessage("user", escapeHtml(text));
  input.value = "";
  btnSend.disabled = true;

  if (!domContext) {
    addMessage("system", "⚠️ No element selected. Click Inspector first, then pick an element.");
    btnSend.disabled = false;
    return;
  }

  // Build the complaint string:
  // • First turn: plain complaint.
  // • Socratic follow-up: original complaint + clarification stitched together.
  let complaintForLLM;
  if (isSocraticMode && savedComplaint) {
    complaintForLLM = `${savedComplaint} — Clarification: ${text}`;
    conversationHistory.push({ role: "user", content: `Clarification: ${text}` });
    exitSocraticMode();
  } else {
    complaintForLLM = text;
    savedComplaint = text;
    conversationHistory.push({ role: "user", content: text });
  }

  hidePreviewCard(); // clear any previous card before requesting a new patch

  const loadingMsg = addMessage(
    "assistant",
    '<span class="spinner"></span> Analysing DOM…'
  );

  const response = await chrome.runtime.sendMessage({
    type: "GENERATE_PATCH",
    payload: {
      userComplaint: complaintForLLM,
      domContext,
      conversationHistory: conversationHistory.slice(-6), // send last 6 turns for context
    },
  });

  loadingMsg.remove();
  btnSend.disabled = false;

  if (!response.ok) {
    addMessage("system", `❌ Error: ${escapeHtml(response.error)}`);
    return;
  }

  const patch = response.patch;

  // Push assistant turn into history (summarised so it doesn't bloat the prompt)
  conversationHistory.push({
    role: "assistant",
    content: `[${patch.adaptation_strategy}] ${patch.ux_diagnosis}`,
  });

  // ── Socratic routing ──────────────────────────────────────────────────────
  if (patch.socratic_question) {
    enterSocraticMode(patch.socratic_question);
    return; // do NOT show the preview card — wait for clarification
  }

  // ── Normal path: show the Preview Card ───────────────────────────────────
  pendingPatch = patch;
  showPreviewCard(patch);
  addMessage(
    "assistant",
    "Patch ready — review the proposal below and approve or reject."
  );
}

// ── Approve patch ─────────────────────────────────────────────────────────────
btnApprove.addEventListener("click", async () => {
  if (!pendingPatch || !activeTabId) return;

  btnApprove.disabled = true;

  const r = await chrome.runtime.sendMessage({
    type: "APPLY_PATCH",
    tabId: activeTabId,
    payload: pendingPatch.executable_code,
  });

  if (r.ok) {
    const count = r.elementCount ?? 0;
    const msg = count > 0
      ? `✅ Patch applied to ${count} element${count !== 1 ? "s" : ""}. Click 'Undo patch' to revert.`
      : `⚠️ CSS injected but no elements matched the selector — try capturing a different element.`;
    addMessage("system", msg);
    hasAppliedPatch = true;
    btnUndo.classList.add("visible");
  } else {
    addMessage("system", `❌ Apply failed: ${escapeHtml(r.error)}`);
  }

  btnApprove.disabled = false;
  hidePreviewCard();
});

// ── Reject patch ──────────────────────────────────────────────────────────────
btnRejectCard.addEventListener("click", () => {
  hidePreviewCard();
  addMessage("system", "Patch rejected. Try rephrasing your description or picking a different element.");
});

// ── Undo patch ────────────────────────────────────────────────────────────────
btnUndo.addEventListener("click", async () => {
  if (!activeTabId) return;

  const r = await chrome.runtime.sendMessage({ type: "UNDO_PATCH", tabId: activeTabId });
  if (r.ok) {
    addMessage("system", "↩ Patch removed. Page restored to original state.");
    hasAppliedPatch = false;
    btnUndo.classList.remove("visible");
  } else {
    addMessage("system", `❌ Undo failed: ${escapeHtml(r.error)}`);
  }
});

// ── Inspector toggle ──────────────────────────────────────────────────────────
btnInspector.addEventListener("click", async () => {
  if (!activeTabId) return;

  if (!inspectorActive) {
    await chrome.tabs.sendMessage(activeTabId, { type: "START_INSPECTOR" });
    inspectorActive = true;
    btnInspector.classList.add("active");
    btnInspector.textContent = "Cancel";
    addMessage("system", "Inspector active — click any element on the page.");
  } else {
    await chrome.tabs.sendMessage(activeTabId, { type: "STOP_INSPECTOR" });
    inspectorActive = false;
    btnInspector.classList.remove("active");
    btnInspector.textContent = "Inspector";
  }
});

// ── Clear context ─────────────────────────────────────────────────────────────
btnClearCtx.addEventListener("click", () => {
  clearContext();
  conversationHistory = [];
  savedComplaint = null;
  exitSocraticMode();
  hidePreviewCard();
  chrome.storage.session.remove("domContext");
  addMessage("system", "Context cleared.");
});

// ── Keyboard shortcut: Enter to send, Shift+Enter for newline ─────────────────
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!btnSend.disabled) handleSend();
  }
});

btnSend.addEventListener("click", handleSend);

// ── Utility ───────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  if (typeof str !== "string") return String(str ?? "");
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
