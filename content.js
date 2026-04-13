// content.js — Afferential layer
// Captures DOM context and runs the element inspector tool

let inspectorActive = false;
let highlightedEl = null;

// ── Inspector overlay styles ──────────────────────────────────────────────────
const inspectorStyle = document.createElement("style");
inspectorStyle.id = "ff-inspector-style";
inspectorStyle.textContent = `
  .ff-highlight {
    outline: 2px solid #7c3aed !important;
    outline-offset: 2px !important;
    cursor: crosshair !important;
  }
  #ff-inspector-banner {
    position: fixed;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    background: #7c3aed;
    color: #fff;
    padding: 8px 20px;
    border-radius: 20px;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    z-index: 2147483647;
    pointer-events: none;
    box-shadow: 0 4px 12px rgba(0,0,0,.25);
  }
`;

// ── Message listener from background/sidepanel ────────────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "START_INSPECTOR") {
    startInspector();
    sendResponse({ ok: true });
  }
  if (message.type === "STOP_INSPECTOR") {
    stopInspector();
    sendResponse({ ok: true });
  }
  if (message.type === "GET_DOM_CONTEXT") {
    // Called when user hasn't used inspector but wants page-level context
    sendResponse(capturePageContext());
  }
});

// ── Inspector activation ──────────────────────────────────────────────────────
function startInspector() {
  if (inspectorActive) return;
  inspectorActive = true;
  document.head.appendChild(inspectorStyle);

  // Banner
  const banner = document.createElement("div");
  banner.id = "ff-inspector-banner";
  banner.textContent = "Click any element to capture it — Esc to cancel";
  document.body.appendChild(banner);

  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("mouseout", onMouseOut, true);
  document.addEventListener("click", onInspectorClick, true);
  document.addEventListener("keydown", onKeyDown, true);
}

function stopInspector() {
  inspectorActive = false;
  inspectorStyle.remove();
  document.getElementById("ff-inspector-banner")?.remove();
  if (highlightedEl) {
    highlightedEl.classList.remove("ff-highlight");
    highlightedEl = null;
  }
  document.removeEventListener("mouseover", onMouseOver, true);
  document.removeEventListener("mouseout", onMouseOut, true);
  document.removeEventListener("click", onInspectorClick, true);
  document.removeEventListener("keydown", onKeyDown, true);
}

function onMouseOver(e) {
  if (!inspectorActive) return;
  if (highlightedEl) highlightedEl.classList.remove("ff-highlight");
  highlightedEl = e.target;
  highlightedEl.classList.add("ff-highlight");
}

function onMouseOut(e) {
  if (e.target === highlightedEl) {
    e.target.classList.remove("ff-highlight");
  }
}

function onInspectorClick(e) {
  if (!inspectorActive) return;
  e.preventDefault();
  e.stopPropagation();
  const context = captureElementContext(e.target);
  stopInspector();
  chrome.runtime.sendMessage({ type: "DOM_CONTEXT", payload: context });
}

function onKeyDown(e) {
  if (e.key === "Escape") stopInspector();
}

// ── Context extraction ────────────────────────────────────────────────────────
function captureElementContext(el) {
  const selector = generateSelector(el);
  const html = el.outerHTML.slice(0, 2000); // cap size
  const computed = window.getComputedStyle(el);

  // Grab the most usability-relevant styles
  const styles = {
    fontSize: computed.fontSize,
    color: computed.color,
    backgroundColor: computed.backgroundColor,
    fontWeight: computed.fontWeight,
    lineHeight: computed.lineHeight,
    padding: computed.padding,
    margin: computed.margin,
    opacity: computed.opacity,
    display: computed.display,
    visibility: computed.visibility,
    contrast: null, // placeholder for future WCAG calc
  };

  return {
    selector,
    html,
    styles,
    tagName: el.tagName.toLowerCase(),
    textContent: el.textContent.slice(0, 200),
    pageUrl: location.href,
    capturedAt: new Date().toISOString(),
  };
}

function capturePageContext() {
  return {
    selector: "body",
    html: document.body.innerHTML.slice(0, 3000),
    styles: {},
    tagName: "body",
    textContent: document.title,
    pageUrl: location.href,
    capturedAt: new Date().toISOString(),
  };
}

// ── CSS selector generator ────────────────────────────────────────────────────
function generateSelector(el) {
  if (el.id) return `#${el.id}`;

  const parts = [];
  let current = el;

  while (current && current !== document.body) {
    let part = current.tagName.toLowerCase();
    if (current.className) {
      const classes = Array.from(current.classList)
        .filter((c) => !c.startsWith("ff-")) // exclude our own classes
        .slice(0, 2)
        .join(".");
      if (classes) part += `.${classes}`;
    }
    // Add :nth-child if needed to disambiguate
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter(
          (s) => s.tagName === current.tagName
        )
      : [];
    if (siblings.length > 1) {
      const idx = siblings.indexOf(current) + 1;
      part += `:nth-of-type(${idx})`;
    }
    parts.unshift(part);
    current = current.parentElement;
  }

  return parts.slice(-3).join(" > "); // only last 3 levels for readability
}
