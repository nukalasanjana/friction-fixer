# Friction Fixer — Chrome Extension

AI-powered UI adapter. Pick any broken element, describe the problem, get a JS/CSS patch reviewed and applied in one click.

## Prerequisites

1. **Ollama** installed and running: https://ollama.com
2. A model pulled, e.g. `ollama pull llama3`
3. Chrome (or Chromium-based browser)

## Setup

```bash
# 1. Start Ollama
ollama serve

# 2. Verify a model is available
ollama list
# If nothing listed: ollama pull llama3
```

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this `friction-fixer/` folder

The extension icon (purple square) will appear in your toolbar.

## Usage

1. Navigate to any webpage with a UI problem
2. Click the Friction Fixer icon → side panel opens
3. Click **🔎 Inspector** → hover the page → click the problematic element
4. Type your complaint in plain English, e.g. *"the text is tiny and low contrast"*
5. Review the generated patch in the sandbox
6. Click **✓ Accept & Apply** — the fix is injected live
7. If something breaks, click **↩ Undo patch** to restore the original

## File structure

```
friction-fixer/
├── manifest.json     # Extension config (Manifest V3)
├── background.js     # Service worker — orchestrates everything
├── content.js        # Injected into webpages — DOM capture & inspector
├── sidepanel.html    # The sidebar UI
├── sidepanel.js      # Sidebar logic — chat, approve/reject, undo
└── icons/
    ├── icon16.png
    └── icon48.png
```

## Changing the model

In `background.js`, line 4:
```js
const OLLAMA_MODEL = "llama3"; // change to e.g. "mistral", "codellama", "phi3"
```

## How it works

```
[User clicks element]
       ↓
[content.js captures selector + HTML + computed styles]
       ↓
[background.js builds prompt: complaint + DOM context]
       ↓
[Ollama generates JS/CSS patch]
       ↓
[User reviews in sidepanel sandbox]
       ↓  (accept)
[chrome.scripting.executeScript injects patch]
       ↓  (undo)
[patch <style> tag removed, DOM restored]
```

## Troubleshooting

| Problem | Fix |
|---|---|
| Red status dot | Run `ollama serve` in a terminal |
| "Inspector not responding" | Reload the extension at chrome://extensions |
| Patch breaks layout | Click ↩ Undo patch immediately |
| Model generates garbage | Try `ollama pull codellama` for better code generation |
