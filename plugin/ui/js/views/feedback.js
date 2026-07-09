// views/feedback.js — Feedback form (message + email + optional phone, run log, file attachments).
// Now a MODAL dialog that can be opened from anywhere (FAB or "Report this" button on runs).
//
// Wiring-pass contract (this module never touches viewer.html/router.js/etc.):
//   - Modal mount point: #feedbackModal (modal container), #feedbackRoot (form renders here)
//   - Entry points: openFeedbackModal(ctx) — call to open, openFeedbackModal({ runId }) when reporting a run
//   - Boot-time wiring: wireFeedbackModal() — call once from main.boot() to set up modal control listeners + FAB
// No other file needs to know about feedbackState.
import { $, icon } from "../dom.js";
import { esc } from "../format.js";
import { api } from "../api.js";
import { toast } from "../components/toast.js";

const FEEDBACK_EMAIL_KEY = "sidewrite:feedbackEmail";

const feedbackState = {
  context: null,     // { runId, prefillMessage } or null
  sending: false,
  attachLog: false,
  logPreview: null,  // { raw: "...", scrubbed: "...", loading: false }
  files: [],         // Array of File objects (the single source of truth for selected files)
  objectURLs: [],    // Track object URLs for cleanup
  prefillEmail: "",  // Last-used email, restored from localStorage on each fresh open — the
                      // message itself is NEVER persisted, only the email (see openFeedbackModal).
};

// ---- file validation helpers ----
const MAX_FILE_SIZE = 2 * 1024 * 1024;     // 2 MB per file
const MAX_TOTAL_SIZE = 3 * 1024 * 1024;    // 3 MB total
const MAX_FILES = 3;
const ALLOWED_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "text/plain", "application/pdf"]);

function validateFiles(files) {
  const newFiles = Array.from(files);

  // Check count
  if (feedbackState.files.length + newFiles.length > MAX_FILES) {
    toast(`Maximum ${MAX_FILES} files allowed`, "err");
    return [];
  }

  let totalSize = feedbackState.files.reduce((sum, f) => sum + f.size, 0);
  const toAdd = [];

  for (const file of newFiles) {
    // Check individual file size
    if (file.size > MAX_FILE_SIZE) {
      toast(`File "${file.name}" exceeds 2 MB`, "err");
      continue;
    }

    // Check mime type
    if (!ALLOWED_TYPES.has(file.type)) {
      toast(`File type "${file.type}" not allowed for "${file.name}"`, "err");
      continue;
    }

    // Check total size
    if (totalSize + file.size > MAX_TOTAL_SIZE) {
      toast("Total file size exceeds 3 MB", "err");
      continue;
    }

    totalSize += file.size;
    toAdd.push(file);
  }

  return toAdd;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / (1024 * 1024)).toFixed(1) + "MB";
}

function revokeObjectURLs() {
  feedbackState.objectURLs.forEach(url => URL.revokeObjectURL(url));
  feedbackState.objectURLs = [];
}

// ---- render the form ----
export function renderFeedback() {
  const root = $("#feedbackRoot");
  if (!root) return;

  const ctx = feedbackState.context || {};
  // DOM value wins on in-place re-renders (e.g. toggling the attach-log
  // checkbox mid-edit must not wipe what the user already typed). On a fresh
  // open, #feedbackRoot was just cleared by openFeedbackModal(), so these
  // querySelectors return nothing and we fall back to state — prefillEmail
  // (restored from localStorage) for email, always blank for message.
  const msgText = (root.querySelector("textarea#feedbackMessage") || {}).value || "";
  const emailText = (root.querySelector("input#feedbackEmail") || {}).value || feedbackState.prefillEmail || "";
  const phoneText = (root.querySelector("input#feedbackPhone") || {}).value || "";
  const attachChecked = (root.querySelector("input#feedbackAttachLog") || {}).checked || false;

  const msgChars = msgText.length;
  const msgCounter = '<div style="font-size:12px; color:var(--ink-muted); margin-top:4px;">' +
    msgChars + ' / 5000</div>';

  // Render run-log attach section if context has a runId
  let attachSection = "";
  if (ctx.runId) {
    const logPreview = feedbackState.logPreview || {};
    const previewHtml = logPreview.scrubbed
      ? '<pre style="background:var(--bg-sub); border:1px solid var(--border-obj); padding:10px; font-size:11px; max-height:200px; overflow:auto; margin-top:8px; color:var(--ink-body);">' +
          esc(logPreview.scrubbed) + '</pre>'
      : (logPreview.loading
        ? '<div style="padding:10px; font-size:12px; color:var(--ink-muted);">Loading log preview…</div>'
        : "");

    attachSection = '<div class="field" style="margin-top:14px;">' +
      '<label style="display:flex; align-items:center; gap:8px; cursor:pointer;">' +
        '<input type="checkbox" id="feedbackAttachLog"' + (attachChecked ? " checked" : "") + '>' +
        '<span>Attach this run\'s log (scrubbed before sending)</span>' +
      '</label>' +
      (attachChecked && previewHtml ? previewHtml : "") +
    '</div>';
  }

  // Render file attachment UI
  let filesSection = '<div class="field" style="margin-top:14px;">' +
    '<label for="feedbackFiles" style="font-size:11px; text-transform:uppercase; letter-spacing:.06em; font-weight:600; color:var(--ink-muted);">File attachments (optional)</label>' +
    '<input type="file" id="feedbackFiles" class="feedback-files-input" multiple accept="image/png,image/jpeg,image/webp,image/gif,text/plain,application/pdf"' + (feedbackState.sending ? " disabled" : "") + '>' +
    '<div style="font-size:11px; color:var(--ink-muted); margin-bottom:8px;">Max 3 files, 2 MB each, 3 MB total</div>';

  if (feedbackState.files.length > 0) {
    filesSection += '<div class="feedback-files-preview">';
    feedbackState.files.forEach((file, idx) => {
      if (file.type.startsWith("image/")) {
        // Image thumbnail
        const objUrl = feedbackState.objectURLs[idx] || URL.createObjectURL(file);
        if (!feedbackState.objectURLs[idx]) feedbackState.objectURLs[idx] = objUrl;
        filesSection += '<div class="feedback-file-chip img-chip" data-file-idx="' + idx + '">' +
          '<img src="' + objUrl + '" alt="' + esc(file.name) + '">' +
          '<span class="feedback-file-remove" role="button" tabindex="0">✕</span>' +
        '</div>';
      } else {
        // File chip with name and size
        filesSection += '<div class="feedback-file-chip" data-file-idx="' + idx + '">' +
          esc(file.name) + ' (' + formatFileSize(file.size) + ')' +
          '<span class="feedback-file-remove" role="button" tabindex="0">✕</span>' +
        '</div>';
      }
    });
    filesSection += '</div>';
  }
  filesSection += '</div>';

  root.innerHTML =
    '<div class="section" style="max-width:640px;">' +
      '<p class="eyebrow">Send feedback</p>' +
      '<div class="field">' +
        '<label for="feedbackMessage">Message <span class="hint">(required, 1–5000 characters)</span></label>' +
        '<textarea id="feedbackMessage" class="ta" placeholder="Tell us what\'s on your mind…" maxlength="5000"' + (feedbackState.sending ? " disabled" : "") + '>' +
          esc(msgText) + '</textarea>' +
        msgCounter +
      '</div>' +
      '<div class="field">' +
        '<label for="feedbackEmail">Email <span class="hint">(required — so we can reply)</span></label>' +
        '<input type="email" id="feedbackEmail" class="tf" placeholder="you@example.com" required' + (feedbackState.sending ? " disabled" : "") + ' value="' + esc(emailText) + '">' +
      '</div>' +
      '<div class="field">' +
        '<label for="feedbackPhone">Phone <span class="hint">(optional)</span></label>' +
        '<input type="tel" id="feedbackPhone" class="tf" placeholder="+1 (555) 000-0000"' + (feedbackState.sending ? " disabled" : "") + ' value="' + esc(phoneText) + '">' +
      '</div>' +
      attachSection +
      filesSection +
      '<div style="display:flex; gap:12px; align-items:center; margin-top:16px;">' +
        '<button type="button" id="feedbackSend" class="btn primary"' + (feedbackState.sending ? " disabled" : "") + '>' +
          (feedbackState.sending ? 'Sending…' : 'Send') + '</button>' +
        '<span class="form-msg" id="feedbackMsg"></span>' +
      '</div>' +
    '</div>';

  updateMessageCounter();
}

// ---- modal control ----
export function openFeedbackModal(ctx) {
  feedbackState.context = ctx || null;
  feedbackState.sending = false;
  feedbackState.attachLog = false;
  feedbackState.logPreview = null;
  feedbackState.files = [];
  revokeObjectURLs();
  let savedEmail = "";
  try {
    savedEmail = localStorage.getItem(FEEDBACK_EMAIL_KEY) || "";
  } catch (_) {
    // localStorage can throw in locked-down contexts (private mode, etc.) — fine, just skip prefill.
  }
  feedbackState.prefillEmail = savedEmail;
  // Clear any leftover markup from a previous open BEFORE rendering, so
  // renderFeedback()'s DOM-value-wins reads don't pick up stale text — this
  // is what makes the message field start blank every time while email
  // still prefills from prefillEmail above.
  const root = $("#feedbackRoot");
  if (root) root.innerHTML = "";
  renderFeedback();
  const modal = $("#feedbackModal");
  if (modal) modal.hidden = false;
}

export function closeFeedbackModal() {
  const modal = $("#feedbackModal");
  if (modal) modal.hidden = true;
  feedbackState.context = null;
  feedbackState.sending = false;
  feedbackState.attachLog = false;
  feedbackState.logPreview = null;
  feedbackState.files = [];
  revokeObjectURLs();
  const root = $("#feedbackRoot");
  if (root) root.innerHTML = "";
}

// ---- message counter ----
function updateMessageCounter() {
  const ta = $("#feedbackMessage");
  if (!ta) return;
  const count = (ta.value || "").length;
  const counter = ta.closest(".field").querySelector("[style*='color:var(--ink-muted)']");
  if (counter) counter.textContent = count + " / 5000";
}

// ---- log preview fetch ----
async function fetchLogPreview() {
  const ctx = feedbackState.context;
  if (!ctx || !ctx.runId) return;
  if (!feedbackState.logPreview) feedbackState.logPreview = {};
  feedbackState.logPreview.loading = true;
  renderFeedback();
  try {
    const r = await api("/api/feedback/log-preview?run_id=" + encodeURIComponent(ctx.runId));
    feedbackState.logPreview = {
      raw: (r && r.raw) || "",
      scrubbed: (r && r.scrubbed) || "",
      loading: false,
    };
  } catch (err) {
    toast("Could not fetch run log: " + err.message, "err");
    feedbackState.logPreview = { raw: "", scrubbed: "", loading: false };
  }
  renderFeedback();
}

// ---- read file as base64 (returns { filename, mime_type, data_base64 }) ----
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result is "data:image/png;base64,..." — strip prefix
      const dataUrl = reader.result;
      const commaIdx = dataUrl.indexOf(",");
      if (commaIdx === -1) {
        reject(new Error("Failed to read file"));
        return;
      }
      const base64 = dataUrl.slice(commaIdx + 1);
      resolve({
        filename: file.name,
        mime_type: file.type,
        data_base64: base64,
      });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// ---- wiring (call once at boot; delegates on #feedbackRoot & modal controls) ----
export function wireFeedbackModal() {
  const root = $("#feedbackRoot");
  const modal = $("#feedbackModal");
  const overlay = modal;
  const closeBtn = $("#feedbackModalClose");

  if (!root || !modal) return;

  // Input event: message counter
  root.addEventListener("input", (e) => {
    if (e.target.id === "feedbackMessage") {
      updateMessageCounter();
    }
    // File input: capture newly selected files
    if (e.target.id === "feedbackFiles") {
      const validFiles = validateFiles(e.target.files);
      if (validFiles.length > 0) {
        feedbackState.files.push(...validFiles);
        renderFeedback();
        // Clear the input so re-selecting the same file triggers change again
        e.target.value = "";
      }
    }
  });

  // Change event: run-log attach checkbox
  root.addEventListener("change", async (e) => {
    if (e.target.id === "feedbackAttachLog") {
      feedbackState.attachLog = e.target.checked;
      if (e.target.checked) {
        await fetchLogPreview();
      } else {
        feedbackState.logPreview = null;
        renderFeedback();
      }
    }
  });

  // Click event: send button + file remove
  root.addEventListener("click", async (e) => {
    // Send button
    const btn = e.target.closest && e.target.closest("#feedbackSend");
    if (btn && !btn.disabled) {
      const msgEl = $("#feedbackMessage");
      const emailEl = $("#feedbackEmail");
      const phoneEl = $("#feedbackPhone");

      const message = (msgEl && msgEl.value || "").trim();
      const email = (emailEl && emailEl.value || "").trim();
      const phone = (phoneEl && phoneEl.value || "").trim() || undefined;

      if (!message) {
        toast("Please enter a message", "err");
        return;
      }
      if (!email) {
        toast("Please enter your email", "err");
        return;
      }
      if (message.length > 5000) {
        toast("Message is too long (max 5000 characters)", "err");
        return;
      }

      feedbackState.sending = true;
      renderFeedback();

      const msgEl_ = $("#feedbackMsg");
      if (msgEl_) { msgEl_.className = "form-msg"; msgEl_.textContent = "Sending…"; }

      try {
        // Read all files as base64 and build attachments array
        const attachments = [];
        if (feedbackState.files.length > 0) {
          const filePromises = feedbackState.files.map(f => readFileAsBase64(f));
          const encodedFiles = await Promise.all(filePromises);
          attachments.push(...encodedFiles);
        }

        const body = {
          message,
          email,
          phone,
          attach_log: feedbackState.attachLog,
        };
        if (attachments.length > 0) {
          body.attachments = attachments;
        }
        if (feedbackState.context && feedbackState.context.runId) {
          body.run_id = feedbackState.context.runId;
        }

        await api("/api/feedback", { method: "POST", body: JSON.stringify(body) });
        toast("Feedback sent — thank you!", "ok");
        if (msgEl_) { msgEl_.className = "form-msg ok"; msgEl_.textContent = "Sent!"; }

        // Remember the email for next time (message/phone/attachments are
        // intentionally NOT persisted — only email, per design).
        try {
          localStorage.setItem(FEEDBACK_EMAIL_KEY, email);
        } catch (_) {
          // ignore — non-critical convenience feature
        }

        // Close modal and clean up
        setTimeout(() => closeFeedbackModal(), 500);
      } catch (err) {
        feedbackState.sending = false;
        if (msgEl_) { msgEl_.className = "form-msg err"; msgEl_.textContent = err.message; }
        toast("Failed to send feedback: " + err.message, "err");
        renderFeedback();
      }
    }

    // File remove button
    const removeBtn = e.target.closest && e.target.closest(".feedback-file-remove");
    if (removeBtn) {
      const chip = removeBtn.closest("[data-file-idx]");
      if (chip) {
        const idx = parseInt(chip.dataset.fileIdx, 10);
        // files[] and objectURLs[] are kept index-aligned (render sets
        // objectURLs[idx] for image files at the same idx). Splicing both at
        // the same index preserves that alignment so remaining thumbnails keep
        // pointing at their own cached URL.
        if (feedbackState.objectURLs[idx]) URL.revokeObjectURL(feedbackState.objectURLs[idx]);
        feedbackState.files.splice(idx, 1);
        feedbackState.objectURLs.splice(idx, 1);
        renderFeedback();
      }
    }
  });

  // Modal close: close button
  if (closeBtn) {
    closeBtn.addEventListener("click", closeFeedbackModal);
  }

  // Modal close: backdrop click (but not clicks inside .modal)
  if (overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        closeFeedbackModal();
      }
    });
  }

  // Modal close: Escape key (only if modal is open)
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) {
      closeFeedbackModal();
      e.preventDefault();
    }
  });
}

// ---- wire the floating action button ----
export function wireFeedbackFab() {
  const fab = $("#feedbackFab");
  if (!fab) return;
  fab.addEventListener("click", () => {
    openFeedbackModal();
  });
}
