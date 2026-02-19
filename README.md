# Send & Archive Button for Gmail Popup Compose

A Chrome extension that adds Gmail's **Send & Archive** button to the **popup compose window**, giving it the same one-click workflow already available in the inline reply compose.

---

## The problem

Gmail shows a **Send & Archive** button in the inline (in-thread) compose window, but that button is absent when you:

- Pop out a reply into its own floating window (the expand ↗ icon)
- Open a new compose popup and reply to a thread from there (make sure to turn off Auto-Advance if you want to use this in a new email)

This extension injects the same button into every popup compose window.

---

## How it works

| Step | What happens                                                                                                                                                                                                                                                                            |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | A `MutationObserver` watches for Gmail popup compose windows appearing inside the `.dw` container (the fixed area at the bottom of the Gmail viewport). The observer starts via `requestIdleCallback` so it never blocks Gmail's initial page load.                                     |
| 2    | Once a compose window is detected, the extension finds Gmail's existing **Send** button and inserts a **Send & Archive** button immediately after it.                                                                                                                                   |
| 3    | Clicking **Send & Archive** (or pressing **Ctrl+Shift+Enter** inside the compose window) checks whether Gmail has already rendered its own native Send & Archive button in the compose DOM. If so, it clicks that directly and Gmail handles everything natively.                       |
| 4    | If no native button exists (the typical case for popup composes), the regular Send button is triggered instead. A `MutationObserver` watches for the compose window to be removed from the DOM, which Gmail does automatically after a successful send.                                 |
| 5    | Once the compose window is gone, the extension clicks the **Archive** button in the conversation toolbar, retrying every 300 ms for up to ~2.4 s to allow Gmail time to finish rendering. If the Archive button still cannot be found after all retries, a toast notification is shown. |

---

## Installation

> Chrome Web Store submission is not available at this time. You can load the extension directly from your local files.

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the `Send Archive Button` folder (the one containing `manifest.json`).
5. The extension icon will appear in the toolbar. Navigate to Gmail — the button will appear automatically in any popup compose window.

---

## File structure

```
Send Archive Button/
├── manifest.json          # Extension manifest (Manifest V3)
├── content.js             # Content script — button injection logic
├── styles.css             # CSS injected into Gmail
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

---

## Permissions

| Permission                                    | Why                                                     |
| --------------------------------------------- | ------------------------------------------------------- |
| `host_permissions: https://mail.google.com/*` | Required to inject the content script into Gmail pages. |

No other permissions are requested. The extension does not read email content, make network requests, or store any data.

---

## Troubleshooting

**The button doesn't appear**

- Make sure the extension is enabled on `chrome://extensions`.
- Reload the Gmail tab after installing or updating the extension.
- The button appears via `requestIdleCallback`, so it may take a few seconds after Gmail finishes loading before it appears in a compose window.
- Gmail's class names can change after a Google update. Check the browser console (filter by `[SAB]`) for diagnostic logs and open an issue.

**Clicking "Send & Archive" sends but doesn't archive**

- This extension only works for **replies to existing threads**. When composing a new email, Gmail returns to the inbox list after sending — the Archive button in that context belongs to whichever conversation is highlighted in the list, not the one just sent. Archiving new outgoing emails requires a different approach (Gmail API).
- If a "Send & Archive: email sent, but the Archive button wasn't found" toast appears, the archive button selector may have changed after a Gmail update. Open an issue with your Gmail version.

**The button appears in the inline compose too**

- The extension only targets elements inside Gmail's `.dw` popup container, which is separate from inline reply composes. If you see it in both places, please open an issue with your Gmail version.

**Ctrl+Shift+Enter doesn't work**

- The shortcut listener is attached in the capture phase to the compose window root, so it should work when focus is anywhere inside the compose (subject, body, To/CC fields). If it doesn't fire, check the browser console for `[SAB] Ctrl+Shift+Enter intercepted`.

---

## Contributing / customising

All logic lives in `content.js`. Key functions:

| Function                                       | Purpose                                                                                       |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `findSendButton(composeEl)`                    | Locates Gmail's Send button inside a compose element                                          |
| `injectButton(composeEl)`                      | Builds and inserts the Send & Archive button; attaches the Ctrl+Shift+Enter shortcut listener |
| `triggerSendAndArchive(composeEl, sendBtn)`    | Core action: prefers Gmail's own native button if present, otherwise sends then archives      |
| `watchComposeForRemoval(composeEl, onRemoved)` | Calls `onRemoved` once the compose element leaves the DOM                                     |
| `archiveCurrentConversation(retriesLeft)`      | Clicks the Archive toolbar button; retries up to 8× and shows a toast on failure              |
| `simulateClick(el)`                            | Dispatches a `mousedown` → `mouseup` → `click` sequence that Gmail's handlers recognise       |
| `scanAll()`                                    | Scans the document for any unprocessed popup compose windows                                  |

---

## License

MIT — use freely, modify as needed.
