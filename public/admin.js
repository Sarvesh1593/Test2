// Admin UI (Meta templates integration)
const $id = (id) => document.getElementById(id);
const BASE_URL =
  window.location.hostname === "localhost" ? "http://localhost:3000" : "";
const create = (tag, cls, txt) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (txt) el.textContent = txt;
  return el;
};

function showToast(msg, type = "info", timeout = 3500) {
  const wrap = $id("toast");
  if (!wrap) return;
  const t = document.createElement("div");
  t.className =
    "toast " +
    (type === "success" ? "success" : type === "error" ? "error" : "");
  t.textContent = msg;
  wrap.appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    setTimeout(() => t.remove(), 300);
  }, timeout);
}

async function fetchJSON(url, opts) {
  console.log("Fetching URL:", url);
  const res = await fetch(url, opts);
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json();
  return res.text();
}

function openModal({
  html = "",
  onConfirm = null,
  confirmLabel = "Confirm",
  hideCancel = false,
}) {
  const modal = $id("modal");
  const content = $id("modalContent");
  const confirm = $id("modalConfirm");
  const cancel = $id("modalCancel");
  content.innerHTML = html;
  if (onConfirm) {
    confirm.style.display = "";
    confirm.textContent = confirmLabel;
    confirm.onclick = async () => {
      await onConfirm();
      closeModal();
    };
  } else {
    confirm.style.display = "none";
    confirm.onclick = null;
  }
  cancel.style.display = hideCancel ? "none" : "";
  modal.classList.remove("hidden");
  modal.setAttribute("aria-hidden", "false");
}

function closeModal() {
  const modal = $id("modal");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

function escapeHtml(s) {
  if (!s) return "";
  return s.replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
  );
}

function parsePlaceholders(text) {
  if (!text) return [];
  const re = /\{\{\s*(\d+)\s*\}\}/g;
  const set = new Set();
  let m;
  while ((m = re.exec(text))) set.add(Number(m[1]));
  return Array.from(set).sort((a, b) => a - b);
}

function generatePreviewText(text, params) {
  if (!text) return "";
  return text.replace(/\{\{\s*(\d+)\s*\}\}/g, (m, p1) => {
    const i = Number(p1) - 1;
    return (params && params[i]) || `{{${p1}}}`;
  });
}

function renderParamEditor(placeholders, params = []) {
  const ed = $id("paramEditor");
  if (!ed) return;
  ed.innerHTML = "";
  placeholders.forEach((num) => {
    const row = document.createElement("div");
    row.className = "param-row";
    const label = document.createElement("label");
    label.className = "label small";
    label.textContent = `{{${num}}}`;
    const inp = document.createElement("input");
    inp.className = "input param-input";
    inp.placeholder = `Value for {{${num}}}`;
    inp.dataset.idx = String(num - 1);
    inp.value = params[num - 1] || "";
    inp.addEventListener("input", renderPreviewFromCurrentSource);
    row.appendChild(label);
    row.appendChild(inp);
    ed.appendChild(row);
  });
}

function renderPreviewPanel(text, buttons = [], paramValues = []) {
  const phone = $id("previewPhone");
  if (!phone) return;
  phone.innerHTML = "";
  const wrapper = create("div", "phone-mockup");
  const p = create(
    "div",
    "preview-bubble",
    generatePreviewText(text, paramValues),
  );
  wrapper.appendChild(p);
  if (Array.isArray(buttons) && buttons.length) {
    const row = document.createElement("div");
    row.className = "preview-btn-row";
    buttons.slice(0, 3).forEach((b) => {
      const el = create("div", "preview-btn", b.title || b.label || "");
      row.appendChild(el);
    });
    wrapper.appendChild(row);
  }
  phone.appendChild(wrapper);
}

let templatesCache = [];

async function loadTemplates() {
  const list = $id("templatesList");
  const sel = $id("templateSelect");
  if (list) list.innerHTML = "Loading…";
  if (sel) sel.innerHTML = '<option value="">(none)</option>';
  try {
    const tpls = await fetchJSON(`${BASE_URL}/meta-templates`);
    templatesCache = Array.isArray(tpls) ? tpls : [];
    if (list) list.innerHTML = "";
    templatesCache.forEach((t, idx) => {
      const card = create("div", "tpl-card");
      const name = create("div", "tpl-name", t.name || "Template");
      const meta = create("div", "muted", `Status: ${t.status || "-"} `);
      const txt = create("pre", "tpl-text", t.body || "");
      const actions = create("div", "tpl-actions");
      const btnPreview = create("button", "btn", "Preview");
      btnPreview.addEventListener("click", () => openPreviewForTemplate(t));
      actions.appendChild(btnPreview);
      card.appendChild(name);
      card.appendChild(meta);
      card.appendChild(txt);
      card.appendChild(actions);
      if (list) list.appendChild(card);
      if (sel) {
        const opt = create(
          "option",
          null,
          `${t.name} ${t.status ? `(${t.status})` : ""}`,
        );
        opt.value = String(idx);
        sel.appendChild(opt);
      }
    });
    updateTemplateStatus(null);
  } catch (err) {
    if (list) list.innerHTML = "Failed to load templates";
    console.error(err);
  }
}

function openPreviewForTemplate(tpl) {
  const body = tpl.body || "";
  renderPreviewPanel(body, [], []);
  openModal({
    html: `<h3>Preview</h3><pre style="white-space:pre-wrap">${escapeHtml(body)}</pre>`,
  });
}

function updateTemplateStatus(idx) {
  const el = $id("templateStatus");
  const lang = $id("templateLang");
  if (!el) return;
  if (idx === null || idx === undefined || idx === "") {
    el.textContent = "Status: —";
    if (lang) lang.value = "en_US" || "en";
    return;
  }
  const tpl = templatesCache[Number(idx)];
  if (!tpl) {
    el.textContent = "Status: —";
    if (lang)
      lang.value =
        metaTemplateLanguage === "en_US" ? "en" : metaTemplateLanguage || "en";
    return;
  }
  el.textContent = `Status: ${tpl.status || "-"}`;
  if (lang)
    lang.value =
      tpl.language || metaTemplateLanguage === "en_US"
        ? "en"
        : metaTemplateLanguage || "en";
}

async function previewBroadcast() {
  const sel = $id("templateSelect");
  const idx = sel?.value;
  if (!idx) {
    return showToast("Choose a template", "error");
  }
  const tpl = templatesCache[Number(idx)];
  if (!tpl) return showToast("Template not found", "error");
  const body = tpl.body || "";
  const params = Array.from(document.querySelectorAll(".param-input")).map(
    (i) => i.value,
  );
  const previewText = generatePreviewText(body, params);
  openModal({
    html: `<h3>Preview</h3><pre style="white-space:pre-wrap">${escapeHtml(previewText)}</pre>`,
    onConfirm: async () => {
      await doBroadcast(true);
    },
    confirmLabel: "Send",
  });
}

async function doBroadcast(fromModal = false) {
  const sel = $id("templateSelect");
  const idx = sel?.value;
  const targetsRaw = $id("broadcastTargets")?.value || "";
  const targets = targetsRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const sendAll = !!$id("sendAll")?.checked;

  if (!sendAll && targets.length === 0) {
    return showToast("Specify targets or check 'Send to all'", "error");
  }

  if (!idx) {
    return showToast("Select a template", "error");
  }

  try {
    const tpl = templatesCache[Number(idx)];
    if (!tpl) return showToast("Template not found", "error");
    const params = Array.from(document.querySelectorAll(".param-input")).map(
      (i) => i.value,
    );
    const payload = {
      metaTemplateName: tpl.name,
      metaTemplateLanguage:
        $id("templateLang")?.value || metaTemplateLanguage === "en_US"
          ? "en"
          : metaTemplateLanguage || "en",
      templateParameters: params,
      targets,
      sendToAll: sendAll,
    };
    const res = await fetch("/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    $id("broadcastResult").textContent = JSON.stringify(json, null, 2);
    showToast("Broadcast request complete", "success");
    if (fromModal) closeModal();
  } catch (err) {
    console.error(err);
    showToast("Broadcast failed", "error");
  }
}

async function saveAndTest() {
  const num = $id("testNumber")?.value.trim();
  if (!num) return showToast("Enter a test number", "error");
  const sel = $id("templateSelect");
  const idx = sel?.value;
  if (!idx) return showToast("Select a template", "error");

  try {
    const tpl = templatesCache[Number(idx)];
    if (!tpl) return showToast("Template not found", "error");
    const params = Array.from(document.querySelectorAll(".param-input")).map(
      (i) => i.value,
    );
    const res = await fetch("/broadcast", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        metaTemplateName: tpl.name,
        metaTemplateLanguage:
          $id("templateLang")?.value || metaTemplateLanguage === "en_US"
            ? "en"
            : metaTemplateLanguage || "en",
        templateParameters: params,
        targets: [num],
      }),
    });
    const json = await res.json();
    $id("broadcastResult").textContent = JSON.stringify(json, null, 2);
    showToast("Test send complete", "success");
  } catch (err) {
    console.error(err);
    showToast("Test failed", "error");
  }
}

async function loadSubscribers() {
  try {
    const s = await fetchJSON("/subscribers");
    if ($id("subsSummary"))
      $id("subsSummary").textContent = `Subscribers: ${s.count}`;
  } catch (err) {
    console.warn("subs", err);
  }
}

function renderPreviewFromCurrentSource() {
  const sel = $id("templateSelect");
  const idx = sel?.value;
  const ed = $id("paramEditor");
  const params = ed
    ? Array.from(ed.querySelectorAll(".param-input")).map((i) => i.value)
    : [];
  if (idx) {
    const tpl = templatesCache[Number(idx)];
    if (!tpl) return;
    const body = tpl.body || "";
    renderPreviewPanel(body, [], params);
    updateTemplateStatus(idx);
    return;
  }
  if ($id("previewPhone"))
    $id("previewPhone").innerHTML =
      '<div class="muted">No preview available</div>';
  updateTemplateStatus(null);
}

document.addEventListener("DOMContentLoaded", () => {
  Array.from(document.querySelectorAll(".nav-item")).forEach((btn) =>
    btn.addEventListener("click", () => {
      document
        .querySelectorAll(".nav-item")
        .forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const tab = btn.dataset.tab;
      document
        .querySelectorAll(".tab")
        .forEach((t) => t.classList.remove("active"));
      const sel = document.getElementById("tab-" + tab);
      if (sel) sel.classList.add("active");
    }),
  );
  $id("previewBroadcast")?.addEventListener("click", previewBroadcast);
  $id("sendBroadcast")?.addEventListener("click", () =>
    openModal({
      html: "<p>Send broadcast now? This will send real WhatsApp messages to recipients.</p>",
      onConfirm: doBroadcast,
      confirmLabel: "Send",
    }),
  );
  $id("saveAndTest")?.addEventListener("click", saveAndTest);
  $id("modalClose")?.addEventListener("click", closeModal);
  $id("modalCancel")?.addEventListener("click", closeModal);
  $id("templateSelect")?.addEventListener("change", () => {
    const idx = $id("templateSelect").value;
    if (idx !== "") {
      const tpl = templatesCache[Number(idx)];
      const body = tpl?.body || "";
      const placeholders = parsePlaceholders(body);
      renderParamEditor(placeholders);
    }
    renderPreviewFromCurrentSource();
    updateTemplateStatus(idx);
  });
  loadTemplates();
  loadSubscribers();
  setInterval(loadSubscribers, 10000);
  renderPreviewFromCurrentSource();
});
