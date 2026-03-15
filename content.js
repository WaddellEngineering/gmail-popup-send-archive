/**
 * Send & Archive Button for Gmail Popup Compose
 *
 * Adds a "Send & Archive" button to Gmail's popup compose windows,
 * mirroring the same button available in the inline compose window.
 *
 * How it works:
 *  1. A MutationObserver watches for new popup compose windows appearing in .dw
 *  2. When found, a "Send & Archive" button is injected next to the Send button
 *  3. On click: the regular Send button is triggered, then — once the compose
 *     window leaves the DOM — the current conversation is archived
 */

(function () {
    "use strict";

    // ─── Constants ────────────────────────────────────────────────────────────

    /** Attribute set on compose containers that have already been processed. */
    const PROCESSED_ATTR = "data-sab-processed";

    /** Attribute set on the button we inject so we never mistake it for Gmail's send button. */
    const BTN_ATTR = "data-sab-btn";

    const LOG = (...args) => console.log("[SAB]", ...args);
    LOG("content script loaded");

    // ─── DOM Helpers ─────────────────────────────────────────────────────────

    /**
     * Returns the popup compose container that contains `el`, or null if `el`
     * is not inside a popup compose window.
     *
     * Gmail renders popup compose windows (both new-message and popped-out reply)
     * inside a fixed `.dw` element at the bottom of the viewport.  Inline
     * reply composes live inside conversation threads and do NOT have `.dw` as
     * an ancestor, so they are excluded naturally.
     */
    function getPopupComposeRoot(el) {
        const dw = el.closest && el.closest(".dw");
        return dw || null;
    }

    /**
     * Finds the Send button inside `composeEl`.
     * Looks for Gmail's `.aoO` class (send button marker) while excluding any
     * button we have already injected.
     */
    function findSendButton(composeEl) {
        // Gmail marks its send button with the `aoO` class.
        // We verify via data-tooltip (a cheap attribute read) rather than
        // textContent (which traverses the full subtree of every candidate).
        const byClass = composeEl.querySelectorAll(".aoO");
        for (const el of byClass) {
            if (el.hasAttribute(BTN_ATTR)) continue;
            const tooltip = (
                el.getAttribute("data-tooltip") || ""
            ).toLowerCase();
            // Accept buttons whose tooltip starts with "send" but NOT "send & archive"
            // (that would be Gmail's own S&A button, not the plain Send button).
            if (
                tooltip === "send" ||
                (tooltip.startsWith("send ") && !tooltip.startsWith("send &"))
            ) {
                return el;
            }
        }

        // Secondary: a Send button with no tooltip yet — match by aria-label.
        const byAriaLabel = composeEl.querySelectorAll(
            '[aria-label="Send"], [aria-label^="Send "]',
        );
        for (const el of byAriaLabel) {
            if (el.hasAttribute(BTN_ATTR)) continue;
            const label = (el.getAttribute("aria-label") || "").toLowerCase();
            if (
                label === "send" ||
                (label.startsWith("send ") && !label.startsWith("send &"))
            ) {
                return el;
            }
        }

        return null;
    }

    /**
     * Finds the top-level compose window element within a `.dw` area.
     * We search for the innermost node that contains a Send button and treat
     * that subtree as the compose window.
     */
    function findComposeWindows(dwEl) {
        // Strategy: locate Send buttons directly, then walk UP to the closest
        // .nH ancestor.  This guarantees we always get the innermost .nH for
        // each button — never an outer ancestor that also "contains" the button.
        // Using a Set deduplicates naturally when multiple selectors hit the
        // same element.
        const seen = new Set();
        const results = [];

        // Collect every element that looks like a Send button inside this .dw.
        const sendCandidates = [
            ...dwEl.querySelectorAll(".aoO"),
            ...dwEl.querySelectorAll(
                '[aria-label="Send"], [aria-label^="Send "]',
            ),
        ];

        for (const el of sendCandidates) {
            if (el.hasAttribute(BTN_ATTR)) continue;

            // Walk up to the nearest .nH ancestor that is still inside the .dw.
            const closest = el.closest(".nH");
            const root = closest && dwEl.contains(closest) ? closest : dwEl;
            if (seen.has(root)) continue;
            seen.add(root);
            results.push(root);
        }

        return results;
    }

    // ─── Idle Scheduler ───────────────────────────────────────────────────────

    /**
     * Runs `fn` during a browser idle period.  Falls back to setTimeout when
     * requestIdleCallback is unavailable (e.g. Safari < 16).
     *
     * Using idle callbacks means we never block Gmail's initial render —
     * the browser only calls us when it has spare cycles.
     *
     * @param {Function} fn
     * @param {number}   [timeoutMs=5000]  Maximum wait before forced execution.
     */
    function runWhenIdle(fn, timeoutMs = 5000) {
        if ("requestIdleCallback" in window) {
            requestIdleCallback(fn, { timeout: timeoutMs });
        } else {
            setTimeout(fn, timeoutMs);
        }
    }

    // ─── Toast Notification ──────────────────────────────────────────────────

    /**
     * Shows a brief notification at the bottom of the viewport.
     * Styled to sit alongside Gmail's own notification bar.
     *
     * @param {string} message
     * @param {'info'|'error'} [type='error']
     */
    function showToast(message, type = "error") {
        const existing = document.getElementById("sab-toast");
        if (existing) existing.remove();

        const toast = document.createElement("div");
        toast.id = "sab-toast";
        toast.setAttribute("role", "alert");
        toast.textContent = message;

        Object.assign(toast.style, {
            position: "fixed",
            bottom: "24px",
            left: "50%",
            transform: "translateX(-50%)",
            background: type === "error" ? "#c0392b" : "#1a73e8",
            color: "#fff",
            padding: "10px 20px",
            borderRadius: "4px",
            fontSize: "14px",
            fontFamily: '"Google Sans",Roboto,sans-serif',
            zIndex: "99999",
            boxShadow: "0 2px 8px rgba(0,0,0,.35)",
            pointerEvents: "none",
            opacity: "1",
            transition: "opacity 0.4s ease",
            whiteSpace: "nowrap",
        });

        document.body.appendChild(toast);

        // Fade out after 5 seconds then remove.
        setTimeout(() => {
            toast.style.opacity = "0";
            setTimeout(() => toast.remove(), 400);
        }, 5000);
    }

    // ─── Archive Logic ────────────────────────────────────────────────────────

    /**
     * Finds Gmail's native Send & Archive button within a compose element,
     * if one exists (Gmail renders it in inline/thread composes but not in
     * popup composes).  Returns the element or null.
     *
     * We check visibility so we can tell whether Gmail actually shows it or
     * is just keeping it in the DOM in a hidden state.
     */
    function findNativeSendAndArchiveButton(composeEl) {
        // Gmail's inline compose button says "Send and archive" (lowercase, "and"
        // not "&").  Handle both variants for resilience.
        const candidates = composeEl.querySelectorAll(
            '[data-tooltip^="Send & Archive"], [data-tooltip^="Send and archive"],' +
                '[aria-label^="Send & Archive"], [aria-label^="Send and archive"]',
        );
        for (const el of candidates) {
            if (el.hasAttribute(BTN_ATTR)) continue;
            return el;
        }
        return null;
    }

    /**
     * Archives the currently displayed conversation by clicking Gmail's own
     * Archive toolbar button.
     *
     * Gmail may not have finished rendering the conversation view right after
     * a send completes, so we retry up to `retriesLeft` times (300 ms apart,
     * ~2.4 s total) before giving up silently.  No keyboard-shortcut fallback
     * is used.
     */
    function archiveCurrentConversation(retriesLeft = 8) {
        LOG(`archiveCurrentConversation: attempt ${9 - retriesLeft} of 8`);
        // Gmail renders the Archive button in the conversation toolbar.
        // The tooltip text can include the keyboard shortcut, e.g. "Archive (y)",
        // so we use prefix/contains matching in addition to exact matching.
        const archiveBtn =
            document.querySelector('[data-tooltip="Archive"]') ||
            document.querySelector('[data-tooltip^="Archive ("]') ||
            document.querySelector('[aria-label="Archive"]') ||
            document.querySelector('[aria-label^="Archive"]') ||
            document.querySelector('button[title="Archive"]') ||
            // Broad scan: any role=button whose tooltip or label starts with "Archive".
            [...document.querySelectorAll('[role="button"]')].find(
                (el) =>
                    (el.getAttribute("data-tooltip") || "").startsWith(
                        "Archive",
                    ) ||
                    (el.getAttribute("aria-label") || "").startsWith("Archive"),
            );

        if (archiveBtn) {
            LOG(
                "archiveCurrentConversation: found archive button, clicking",
                archiveBtn,
            );
            simulateClick(archiveBtn);
            return;
        }

        LOG(
            `archiveCurrentConversation: archive button not found (retries left: ${retriesLeft})`,
        );
        // Not found yet — Gmail may still be transitioning to the thread view.
        if (retriesLeft > 0) {
            setTimeout(() => archiveCurrentConversation(retriesLeft - 1), 300);
            return;
        }

        // All retries exhausted — email was sent but archive couldn't be triggered.
        LOG("archiveCurrentConversation: giving up, showing toast");
        showToast(
            "Send & Archive: email sent, but the Archive button wasn't found. Please archive manually.",
        );
    }

    /**
     * Dispatches a realistic mouse event sequence on `el` so that Gmail's
     * event handlers respond.  Gmail ignores bare `.click()` calls on toolbar
     * buttons because it listens on `mousedown` and also checks that events
     * are trusted-looking bubbling events rather than synthetic no-ops.
     */
    function simulateClick(el) {
        for (const type of ["mousedown", "mouseup", "click"]) {
            el.dispatchEvent(
                new MouseEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    view: window,
                    buttons: 1,
                }),
            );
        }
    }

    /**
     * Watches `composeEl` for removal from the DOM and calls `onRemoved` once
     * when it disappears (i.e. after Gmail closes the compose window post-send).
     *
     * Using a callback instead of a shared flag means multiple compose windows
     * can each have their own independent archive lifecycle — no risk of one
     * window's send cancelling another window's pending archive.
     *
     * @param {Element}  composeEl  - The compose container to watch.
     * @param {Function} onRemoved  - Called exactly once when composeEl leaves the DOM.
     */
    function watchComposeForRemoval(composeEl, onRemoved) {
        // Observe at document.body so we catch removal of composeEl *or any of
        // its ancestors* (Gmail sometimes tears down a whole parent container).
        // Instead of chasing which specific node was removed, we simply check
        // whether composeEl is still in the document after any childList change.
        LOG("watchComposeForRemoval: watching for compose removal", composeEl);
        const removalObserver = new MutationObserver(() => {
            if (!document.contains(composeEl)) {
                LOG(
                    "watchComposeForRemoval: compose removed from DOM, triggering archive",
                );
                removalObserver.disconnect();
                onRemoved();
            }
        });

        removalObserver.observe(document.body, {
            childList: true,
            subtree: true,
        });
    }

    // ─── Button Injection ─────────────────────────────────────────────────────

    /**
     * Builds and returns the "Send & Archive" button DOM element.
     */
    function buildButton(sendBtn) {
        const btn = document.createElement("div");

        // Copy Gmail's button base classes so the button is styled identically.
        // The extra `sab-btn` class is our own hook for CSS overrides.
        btn.className =
            (sendBtn.className || "").replace(/\baoO\b/, "").trim() +
            " aoO sab-btn";

        btn.setAttribute("role", "button");
        btn.setAttribute("tabindex", "1");
        btn.setAttribute(BTN_ATTR, "true");
        btn.setAttribute("aria-label", "Send & Archive");
        btn.setAttribute(
            "data-tooltip",
            "Send this message and archive the conversation (Ctrl+Shift+Enter)",
        );

        btn.textContent = "Send & Archive";

        return btn;
    }

    /**
     * Core send-and-archive action, shared by both the button click and the
     * Ctrl+Shift+Enter keyboard shortcut.
     */
    function triggerSendAndArchive(composeEl, sendBtn) {
        LOG("triggerSendAndArchive: invoked");

        // ── Preferred path ────────────────────────────────────────────────────
        const nativeBtn = findNativeSendAndArchiveButton(composeEl);
        if (nativeBtn) {
            LOG(
                "triggerSendAndArchive: using native Send & Archive button",
                nativeBtn,
            );
            simulateClick(nativeBtn);
            return;
        }
        LOG(
            "triggerSendAndArchive: no native button, using fallback send+archive",
        );

        // ── Fallback path ─────────────────────────────────────────────────────
        watchComposeForRemoval(composeEl, () => {
            LOG(
                "triggerSendAndArchive: compose closed, waiting 2s then archiving",
            );
            setTimeout(archiveCurrentConversation, 2000);
        });

        LOG("triggerSendAndArchive: clicking Send button", sendBtn);
        setTimeout(() => sendBtn.click(), 0);
    }

    /**
     * Injects a "Send & Archive" button next to the Send button in `composeEl`.
     * Safe to call multiple times — idempotent thanks to `PROCESSED_ATTR`.
     */
    function injectButton(composeEl) {
        if (composeEl.hasAttribute(PROCESSED_ATTR)) return;

        const sendBtn = findSendButton(composeEl);
        if (!sendBtn) return; // Not ready yet — caller should retry.

        LOG("injecting button into compose window", composeEl);
        // Mark as processed before mutating the DOM to prevent re-entrancy.
        composeEl.setAttribute(PROCESSED_ATTR, "true");

        const btn = buildButton(sendBtn);

        // ── Keyboard shortcut: Ctrl+Shift+Enter on the compose window ─────────
        // Gmail's own Ctrl+Enter sends; we intercept Ctrl+Shift+Enter before it
        // reaches Gmail and trigger send+archive instead.
        composeEl.addEventListener(
            "keydown",
            (e) => {
                if (e.key === "Enter" && e.ctrlKey && e.shiftKey) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    LOG("Ctrl+Shift+Enter intercepted");
                    triggerSendAndArchive(composeEl, sendBtn);
                }
            },
            true,
        ); // capture phase so we beat Gmail's own listeners

        // ── Keyboard support on the button itself (Tab then Enter/Space) ──────
        btn.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                btn.click();
            }
        });

        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopImmediatePropagation();
            LOG("button clicked");
            triggerSendAndArchive(composeEl, sendBtn);
        });

        // Insert immediately after the Send button.
        sendBtn.insertAdjacentElement("afterend", btn);
    }

    /**
     * Attempts to inject the button up to `maxRetries` times, backing off by
     * 300 ms between attempts.  This handles cases where the compose DOM is not
     * fully rendered when the MutationObserver fires.
     */
    function tryInjectWithRetry(composeEl, retriesLeft = 6) {
        if (!document.contains(composeEl)) return;
        if (composeEl.hasAttribute(PROCESSED_ATTR)) return;

        if (findSendButton(composeEl)) {
            injectButton(composeEl);
        } else if (retriesLeft > 0) {
            setTimeout(
                () => tryInjectWithRetry(composeEl, retriesLeft - 1),
                300,
            );
        }
    }

    // ─── Scanning ─────────────────────────────────────────────────────────────

    /**
     * Timer ID for the pending debounced scan.  Keeping a single ID ensures
     * that no matter how many mutations fire in quick succession, only one
     * scanAll() ever runs — the one scheduled after the last mutation settles.
     */
    let scanTimer = null;

    /**
     * Scans the full document for popup compose windows and attempts injection.
     */
    function scanAll() {
        scanTimer = null;
        const dwEls = document.querySelectorAll(".dw");
        LOG(`scanAll: found ${dwEls.length} .dw element(s)`);
        dwEls.forEach((dw) => {
            findComposeWindows(dw).forEach((composeEl) =>
                tryInjectWithRetry(composeEl),
            );
        });
    }

    /**
     * Schedules a scanAll() after `delay` ms, cancelling any previously
     * scheduled scan.  This is the only place setTimeout(scanAll, …) should
     * be called, so scans never pile up.
     */
    function scheduleScan(delay = 300) {
        if (scanTimer !== null) clearTimeout(scanTimer);
        scanTimer = setTimeout(scanAll, delay);
    }

    // ─── MutationObserver ─────────────────────────────────────────────────────

    /**
     * Main observer — watches for new nodes being added anywhere in the body.
     * When a mutation looks like a popup compose window (ancestor is .dw),
     * we schedule an injection attempt.
     */
    const mainObserver = new MutationObserver((mutations) => {
        let needsScan = false;

        for (const mut of mutations) {
            for (const node of mut.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;

                // Is the added node inside a popup compose area?
                if (getPopupComposeRoot(node)) {
                    needsScan = true;
                    break;
                }

                // Does the added node *contain* a popup compose area (e.g., Gmail
                // lazy-loaded the whole compose widget)?
                if (node.querySelector && node.querySelector(".dw")) {
                    needsScan = true;
                    break;
                }
            }
            if (needsScan) break;
        }

        if (needsScan) {
            // Debounced: cancels any already-pending scan and re-schedules.
            scheduleScan(300);
        }
    });

    // ─── Deferred observer start ───────────────────────────────────────────────
    // We use requestIdleCallback so the browser decides when to start us,
    // rather than guessing a fixed delay.  This means zero impact on Gmail's
    // initial render — we only start watching once the browser is truly idle.
    // A 6 s hard timeout ensures we start even on a very busy tab.
    runWhenIdle(() => {
        LOG("starting MutationObserver");
        mainObserver.observe(document.body, { childList: true, subtree: true });
    }, 6000);

    // ─── Initial Scan
    runWhenIdle(() => {
        LOG("running initial scan");
        scheduleScan(0);
    }, 6000);
})();
