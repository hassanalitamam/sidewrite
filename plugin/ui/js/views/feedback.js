// views/feedback.js — Feedback form: message + email + optional phone and run log.
//
// Wiring-pass contract (this module never touches viewer.html/router.js/etc.):
//   - Mount point: a single empty container the page section wraps, id
//     "#feedbackRoot". render() replaces its entire innerHTML each call.
//   - Router hook:  enterFeedback(ctx)  — call when the "feedback" page tab is
//     shown. ctx is optional and may contain { runId, prefillMessage }.
//   - Boot-time wiring: wireFeedback() — call once from main.boot() to set up
//     delegated event listeners on #feedbackRoot. wireFeedbackFab() wires the
//     floating action button (#feedbackFab) to navigate to the feedback page.
// No other file needs to know about feedbackState.
import { $, icon } from "../dom.js";
import { esc } from "../format.js";
import { api } from "../api.js";
import { toast } from "../components/toast.js";
import { showPage } from "../router.js";

const feedbackState = {
  context: null,     // { runId, prefillMessage } or null
  sending: false,
  attachLog: false,
  logPreview: null,  // { raw: "...", scrubbed: "...", loading: false }
};

// ---- render ----
export function renderFeedback() {
  const root = $("#feedbackRoot");
  if (!root) return;

  const ctx = feedbackState.context || {};
  const msgText = (root.querySelector("textarea#feedbackMessage") || {}).value || "";
  const emailText = (root.querySelector("input#feedbackEmail") || {}).value || "";
  const phoneText = (root.querySelector("input#feedbackPhone") || {}).value || "";
  const attachChecked = (root.querySelector("input#feedbackAttachLog") || {}).checked || false;

  const msgChars = msgText.length;
  const msgCounter = '<div style="font-size:12px; color:var(--ink-muted); margin-top:4px;">' +
    msgChars + ' / 5000</div>';

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
      '<div style="display:flex; gap:12px; align-items:center; margin-top:16px;">' +
        '<button type="button" id="feedbackSend" class="btn primary"' + (feedbackState.sending ? " disabled" : "") + '>' +
          (feedbackState.sending ? 'Sending…' : 'Send') + '</button>' +
        '<span class="form-msg" id="feedbackMsg"></span>' +
      '</div>' +
    '</div>';

  updateMessageCounter();
}

export function enterFeedback(ctx) {
  feedbackState.context = ctx || null;
  feedbackState.logPreview = null;
  feedbackState.attachLog = false;
  feedbackState.sending = false;
  renderFeedback();
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

// ---- wiring (call once at boot; delegates on #feedbackRoot, survives re-renders) ----
export function wireFeedback() {
  const root = $("#feedbackRoot");
  if (!root) return;

  root.addEventListener("input", (e) => {
    if (e.target.id === "feedbackMessage") {
      updateMessageCounter();
    }
  });

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

  root.addEventListener("click", async (e) => {
    const btn = e.target.closest && e.target.closest("#feedbackSend");
    if (!btn || btn.disabled) return;

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
      const body = {
        message,
        email,
        phone,
        attach_log: feedbackState.attachLog,
      };
      if (feedbackState.context && feedbackState.context.runId) {
        body.run_id = feedbackState.context.runId;
      }
      await api("/api/feedback", { method: "POST", body: JSON.stringify(body) });
      toast("Feedback sent — thank you!", "ok");
      if (msgEl_) { msgEl_.className = "form-msg ok"; msgEl_.textContent = "Sent!"; }
      // Clear the form
      feedbackState.context = null;
      feedbackState.attachLog = false;
      feedbackState.logPreview = null;
      feedbackState.sending = false;
      renderFeedback();
    } catch (err) {
      feedbackState.sending = false;
      if (msgEl_) { msgEl_.className = "form-msg err"; msgEl_.textContent = err.message; }
      toast("Failed to send feedback: " + err.message, "err");
      renderFeedback();
    }
  });
}

// ---- wire the floating action button ----
export function wireFeedbackFab() {
  const fab = $("#feedbackFab");
  if (!fab) return;
  fab.addEventListener("click", () => {
    enterFeedback();
    showPage("feedback");
  });
}
