import {
  isDuplicateNomorId as fbCheckDuplicate,
  uploadRegistrationFile,
  createRegistration,
  detectMimeFromMagic,
} from "./firebase-services.js";

(() => {
  "use strict";

  /* ===================== REFERENCES ===================== */
  const form = document.getElementById("tepForm");
  const pages = Array.from(form.querySelectorAll(".page"));
  const backBtn = document.getElementById("backBtn");
  const nextBtn = document.getElementById("nextBtn");
  const submitBtn = document.getElementById("submitBtn");
  const progressBar = document.getElementById("progressBar");
  const progressPct = document.getElementById("progressPct");
  const currentPageLabel = document.getElementById("currentPageLabel");
  const stepperItems = Array.from(document.querySelectorAll(".stepper__item"));
  const successScreen = document.getElementById("successScreen");
  const copyEmailEl = document.getElementById("copyEmail");
  const anotherBtn = document.getElementById("anotherBtn");
  const refCodeEl = document.getElementById("refCode");
  const submittedAtEl = document.getElementById("submittedAt");

  const TOTAL = pages.length;
  let current = 1;

  /* ===================== NAVIGATION ===================== */
  function showPage(n, opts = {}) {
    pages.forEach((p) => {
      const match = Number(p.dataset.page) === n;
      p.hidden = !match;
    });
    current = n;

    const pct = (n / TOTAL) * 100;
    if (progressBar) progressBar.style.width = `${pct}%`;
    if (progressPct) progressPct.textContent = `${Math.round(pct)}%`;
    if (currentPageLabel) currentPageLabel.textContent = String(n).padStart(2, "0");

    backBtn.hidden = n === 1;
    nextBtn.hidden = n === TOTAL;
    submitBtn.hidden = n !== TOTAL;

    stepperItems.forEach((item) => {
      const target = Number(item.dataset.target);
      item.classList.toggle("is-active", target === n);
      item.classList.toggle("is-done", target < n);
    });

    // Update email preview on last page
    const emailField = form.querySelector("#email");
    if (emailField && copyEmailEl) {
      copyEmailEl.textContent = emailField.value.trim() || "email Anda";
    }

    if (!opts.skipScroll) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  /* ===================== STEPPER NAVIGATION ===================== */
  stepperItems.forEach((item) => {
    item.addEventListener("click", () => {
      const target = Number(item.dataset.target);
      if (target === current) return;
      if (target < current) {
        showPage(target);
      } else {
        // Forward navigation requires valid current pages
        for (let i = current; i < target; i++) {
          if (!validatePage(i)) { showPage(i); return; }
        }
        showPage(target);
      }
    });
  });

  /* ===================== "OTHER" HANDLING =====================
   * Mendukung satu atau banyak target via data-other-target,
   * dipisahkan koma. Contoh: data-other-target="namaOrangTua,tahunPenempatan"
   */
  form.querySelectorAll('input[type="radio"][data-other-target]').forEach((radio) => {
    const targetIds = String(radio.dataset.otherTarget || "")
      .split(",").map((s) => s.trim()).filter(Boolean);
    const targets = targetIds.map((id) => document.getElementById(id)).filter(Boolean);
    if (!targets.length) return;

    const groupName = radio.name;
    form.querySelectorAll(`input[type="radio"][name="${groupName}"]`).forEach((r) => {
      r.addEventListener("change", () => {
        if (radio.checked) {
          targets.forEach((t) => {
            t.disabled = false;
            t.required = true;
          });
          requestAnimationFrame(() => targets[0].focus());
        } else {
          targets.forEach((t) => {
            t.disabled = true;
            t.required = false;
            t.value = "";
          });
        }
      });
    });

    targets.forEach((t) => {
      t.addEventListener("focus", () => {
        if (!radio.checked) {
          radio.checked = true;
          radio.dispatchEvent(new Event("change", { bubbles: true }));
        }
      });
    });
  });

  /* ===================== NOMOR IDENTITAS (KTP / PASPOR) ===================== */
  /*
   * Aturan:
   * - KTP  : tepat 16 digit angka (NIK).
   * - Paspor: 1–2 huruf diikuti 6–7 digit angka (mis. A1234567 / AB123456).
   * - Nomor yang sama tidak boleh dipakai dua kali.
   *
   * Uniqueness check:
   * 1) Local guard  -> localStorage (mencegah device yang sama submit 2x).
   * 2) Server check -> fungsi async `checkDuplicateIdServer` di bawah,
   *    tinggal di-wire ke Firestore bila backend sudah aktif.
   */
  const NOMOR_ID_STORAGE_KEY = "tep2026.registeredIds";
  const nomorIdInput = form.querySelector("#nomorId");
  const nomorIdFeedback = document.getElementById("nomorIdFeedback");
  let nomorIdCheckToken = 0;

  function normalizeId(raw) {
    return String(raw || "").trim().toUpperCase().replace(/\s|-/g, "");
  }

  function classifyId(v) {
    const s = normalizeId(v);
    if (/^\d{16}$/.test(s)) return { type: "KTP", value: s };
    if (/^[A-Z]{1,2}\d{6,7}$/.test(s)) return { type: "PASPOR", value: s };
    return { type: null, value: s };
  }

  function getLocalRegisteredIds() {
    try {
      const raw = localStorage.getItem(NOMOR_ID_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (_) { return []; }
  }

  function addLocalRegisteredId(id) {
    try {
      const list = getLocalRegisteredIds();
      if (!list.includes(id)) {
        list.push(id);
        localStorage.setItem(NOMOR_ID_STORAGE_KEY, JSON.stringify(list));
      }
    } catch (_) { /* quota atau privacy mode — abaikan */ }
  }

  // Cek duplikat ke Firestore (doc ID = normalized nomorId).
  async function checkDuplicateIdServer(id) {
    try { return await fbCheckDuplicate(id); } catch (_) { return false; }
  }

  function setFeedback(state, msg) {
    if (!nomorIdFeedback) return;
    nomorIdFeedback.classList.remove("is-error", "is-success", "is-checking");
    if (state) nomorIdFeedback.classList.add(`is-${state}`);
    nomorIdFeedback.textContent = msg || "";
  }

  if (nomorIdInput) {
    nomorIdInput.addEventListener("input", () => {
      const caret = nomorIdInput.selectionStart;
      const before = nomorIdInput.value;
      const after = normalizeId(before);
      if (before !== after) {
        nomorIdInput.value = after;
        try { nomorIdInput.setSelectionRange(caret, caret); } catch (_) { /* noop */ }
      }
      if (/^\d/.test(after) || after === "") {
        nomorIdInput.maxLength = 16;
      } else {
        nomorIdInput.maxLength = 9;
      }
      if (!after) { setFeedback(null, ""); return; }

      const { type } = classifyId(after);
      if (!type) {
        setFeedback("error", "Format belum valid. Gunakan 16 digit NIK KTP atau format paspor (mis. A1234567).");
        return;
      }
      if (getLocalRegisteredIds().includes(after)) {
        setFeedback("error", `Nomor ${type} ini sudah pernah digunakan untuk mendaftar.`);
        return;
      }
      setFeedback("success", `${type} terdeteksi. Format valid.`);
    });

    nomorIdInput.addEventListener("blur", async () => {
      const { type, value } = classifyId(nomorIdInput.value);
      if (!type) return;
      if (getLocalRegisteredIds().includes(value)) return;

      const token = ++nomorIdCheckToken;
      setFeedback("checking", "Memeriksa ketersediaan nomor...");
      try {
        const duplicate = await checkDuplicateIdServer(value);
        if (token !== nomorIdCheckToken) return;
        if (duplicate) {
          setFeedback("error", `Nomor ${type} ini sudah terdaftar pada sistem.`);
          markInvalid(nomorIdInput);
        } else {
          setFeedback("success", `${type} valid dan belum terdaftar.`);
        }
      } catch (_) {
        if (token !== nomorIdCheckToken) return;
        setFeedback(null, "");
      }
    });
  }

  async function validateNomorId() {
    if (!nomorIdInput) return true;
    const { type, value } = classifyId(nomorIdInput.value);
    if (!value) {
      setFeedback("error", "Nomor identitas wajib diisi.");
      markInvalid(nomorIdInput);
      return false;
    }
    if (!type) {
      setFeedback("error", "Format belum valid. Gunakan 16 digit NIK KTP atau format paspor (mis. A1234567).");
      markInvalid(nomorIdInput);
      return false;
    }
    if (getLocalRegisteredIds().includes(value)) {
      setFeedback("error", `Nomor ${type} ini sudah pernah digunakan pada perangkat ini.`);
      markInvalid(nomorIdInput);
      return false;
    }
    try {
      const duplicate = await checkDuplicateIdServer(value);
      if (duplicate) {
        setFeedback("error", `Nomor ${type} ini sudah terdaftar pada sistem.`);
        markInvalid(nomorIdInput);
        return false;
      }
    } catch (_) { /* fallback: lanjutkan */ }
    return true;
  }

  /* ===================== DROPZONES ===================== */
  const PDF_MAX = 10 * 1024 * 1024;
  const IMG_MAX = 5 * 1024 * 1024;

  function fileKind(file) {
    const mime = (file.type || "").toLowerCase();
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (mime === "application/pdf" || ext === "pdf") return "PDF";
    if (mime === "image/png" || ext === "png") return "PNG";
    if (mime === "image/jpeg" || ext === "jpg" || ext === "jpeg") return "JPG";
    return ext.toUpperCase() || "FILE";
  }

  function parseAccept(input) {
    return String(input.accept || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }

  function isFileAccepted(file, tokens) {
    if (!tokens.length) return true;
    const mime = (file.type || "").toLowerCase();
    const ext = "." + (file.name.split(".").pop() || "").toLowerCase();
    return tokens.some((t) => {
      if (t === mime) return true;
      if (t === ext) return true;
      if (t.endsWith("/*") && mime.startsWith(t.slice(0, -1))) return true;
      return false;
    });
  }

  document.querySelectorAll(".dropzone").forEach((zone) => {
    const input = zone.querySelector('input[type="file"]');
    const fileBox = zone.querySelector(".dropzone__file");
    if (!input || !fileBox) return;

    const acceptTokens = parseAccept(input);
    const isImageZone = acceptTokens.some((t) => t.startsWith("image/"));
    const MAX_SIZE = isImageZone ? IMG_MAX : PDF_MAX;
    const MAX_LABEL = isImageZone ? "5 MB" : "10 MB";

    const showFile = (file) => {
      const kb = file.size / 1024;
      const size = kb > 1024 ? `${(kb / 1024).toFixed(2)} MB` : `${Math.round(kb)} KB`;
      const kind = fileKind(file);
      fileBox.innerHTML = `
        <div class="dropzone__file-icon">${escapeHtml(kind)}</div>
        <div>
          <div class="dropzone__file-name">${escapeHtml(file.name)}</div>
          <div class="dropzone__file-size">${size}</div>
        </div>
        <button type="button" class="dropzone__file-remove" aria-label="Hapus file">Ganti</button>
      `;
      fileBox.hidden = false;
      zone.classList.add("is-filled");
      const rm = fileBox.querySelector(".dropzone__file-remove");
      rm.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        input.value = "";
        fileBox.hidden = true;
        zone.classList.remove("is-filled");
      });
    };

    const validate = (file) => {
      if (!file) return false;
      if (file.size > MAX_SIZE) {
        alert(`Ukuran file "${file.name}" melebihi ${MAX_LABEL}.`);
        return false;
      }
      // Tidak mengecek format di sini — browser sudah membatasi lewat
      // atribut `accept`, dan preflight akan menolak kalau benar-benar
      // tidak terbaca. Strategi ini menghindari penolakan palsu akibat
      // MIME type non-standar yang dikirim browser.
      return true;
    };

    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (!file) { zone.classList.remove("is-filled"); fileBox.hidden = true; return; }
      if (!validate(file)) { input.value = ""; return; }
      showFile(file);
    });

    ["dragenter", "dragover"].forEach((ev) => {
      zone.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        zone.classList.add("is-dragover");
      });
    });
    ["dragleave", "drop"].forEach((ev) => {
      zone.addEventListener(ev, (e) => {
        e.preventDefault(); e.stopPropagation();
        zone.classList.remove("is-dragover");
      });
    });
    zone.addEventListener("drop", (e) => {
      const files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      const file = files[0];
      if (!validate(file)) return;
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      showFile(file);
    });
  });

  /* ===================== VALIDATION ===================== */
  function markInvalid(el) {
    el.classList.add("invalid");
    const field = el.closest(".field");
    if (field) field.classList.add("invalid");
    const clear = () => {
      el.classList.remove("invalid");
      if (field) field.classList.remove("invalid");
      el.removeEventListener("input", clear);
      el.removeEventListener("change", clear);
    };
    el.addEventListener("input", clear);
    el.addEventListener("change", clear);
  }

  function validatePage(n) {
    const page = pages.find((p) => Number(p.dataset.page) === n);
    if (!page) return true;
    page.querySelectorAll(".invalid").forEach((el) => el.classList.remove("invalid"));
    page.querySelectorAll(".field.invalid").forEach((el) => el.classList.remove("invalid"));

    let firstInvalid = null;
    let valid = true;

    page.querySelectorAll("input, select, textarea").forEach((el) => {
      if (el.disabled || !el.required) return;
      const type = el.type;

      if (type === "radio") return;

      if (type === "checkbox") {
        if (!el.checked) {
          markInvalid(el);
          valid = false;
          if (!firstInvalid) firstInvalid = el;
        }
        return;
      }

      if (type === "file") {
        if (!el.files || el.files.length === 0) {
          markInvalid(el);
          valid = false;
          if (!firstInvalid) firstInvalid = el;
          return;
        }
        const file = el.files[0];
        const tokens = parseAccept(el);
        const isImg = tokens.some((t) => t.startsWith("image/"));
        const limit = isImg ? IMG_MAX : PDF_MAX;
        const label = isImg ? "5 MB" : "10 MB";
        if (file.size > limit) {
          alert(`File "${file.name}" (${(file.size / 1024 / 1024).toFixed(2)} MB) melebihi batas ${label}.`);
          markInvalid(el);
          valid = false;
          if (!firstInvalid) firstInvalid = el;
        }
        return;
      }

      if (!el.value || !String(el.value).trim()) {
        markInvalid(el);
        valid = false;
        if (!firstInvalid) firstInvalid = el;
        return;
      }

      if (type === "email") {
        const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(el.value.trim());
        if (!ok) {
          markInvalid(el);
          valid = false;
          if (!firstInvalid) firstInvalid = el;
        }
      }
    });

    const radioGroups = new Set();
    page.querySelectorAll('input[type="radio"][required]').forEach((r) => radioGroups.add(r.name));
    radioGroups.forEach((name) => {
      const picked = page.querySelector(`input[type="radio"][name="${name}"]:checked`);
      if (!picked) {
        const first = page.querySelector(`input[type="radio"][name="${name}"]`);
        if (first) {
          markInvalid(first);
          const field = first.closest(".field");
          if (field) field.classList.add("invalid");
          valid = false;
          if (!firstInvalid) firstInvalid = first;
        }
      }
    });

    if (firstInvalid) {
      const scrollTo = firstInvalid.closest(".field") || firstInvalid;
      scrollTo.scrollIntoView({ behavior: "smooth", block: "center" });
      try { firstInvalid.focus({ preventScroll: true }); } catch (_) { /* noop */ }
    }

    return valid;
  }

  /* ===================== BUTTONS ===================== */
  nextBtn.addEventListener("click", async () => {
    if (!validatePage(current)) return;
    if (current === 1) {
      const okId = await validateNomorId();
      if (!okId) return;
    }
    if (current < TOTAL) showPage(current + 1);
  });
  backBtn.addEventListener("click", () => {
    if (current > 1) showPage(current - 1);
  });

  /* ===== Submit Firebase pipeline ===== */
  const FILE_FIELDS = [
    "pasFoto", "ijazah", "portoKarya", "portoTim",
    "suratIntegritas", "suratRekomendasi", "suratBersedia",
    "suratSakit", "suratIzinOrtu",
  ];

  const FILE_FIELD_LABELS = {
    pasFoto: "Pas Foto 4x6",
    ijazah: "Ijazah",
    portoKarya: "Portofolio Karya Ilmiah",
    portoTim: "Portofolio Pengalaman Tim",
    suratIntegritas: "Surat Pernyataan Integritas",
    suratRekomendasi: "Surat Rekomendasi",
    suratBersedia: "Surat Pernyataan Bersedia",
    suratSakit: "Surat Pernyataan Tidak Pernah Sakit Berat/Kronis",
    suratIzinOrtu: "Surat Izin Orang Tua",
  };

  // Tipe yang diterima per kolom (secara eksplisit, terlepas dari header
  // MIME browser) — dipakai oleh preflightValidateFiles().
  const FIELD_EXPECTED_MIMES = {
    pasFoto: ["image/jpeg", "image/png"],
    ijazah: ["application/pdf"],
    portoKarya: ["application/pdf"],
    portoTim: ["application/pdf"],
    suratIntegritas: ["application/pdf"],
    suratRekomendasi: ["application/pdf"],
    suratBersedia: ["application/pdf"],
    suratSakit: ["application/pdf"],
    suratIzinOrtu: ["application/pdf"],
  };

  const FIELD_MAX_BYTES = {
    pasFoto: 5 * 1024 * 1024,
    ijazah: 10 * 1024 * 1024,
    portoKarya: 10 * 1024 * 1024,
    portoTim: 10 * 1024 * 1024,
    suratIntegritas: 10 * 1024 * 1024,
    suratRekomendasi: 10 * 1024 * 1024,
    suratBersedia: 10 * 1024 * 1024,
    suratSakit: 10 * 1024 * 1024,
    suratIzinOrtu: 10 * 1024 * 1024,
  };

  function collectFiles() {
    const out = {};
    for (const name of FILE_FIELDS) {
      const input = form.querySelector(`input[type="file"][name="${name}"]`);
      if (input && input.files && input.files[0]) out[name] = input.files[0];
    }
    return out;
  }

  function humanMime(m) {
    if (m === "application/pdf") return "PDF";
    if (m === "image/jpeg") return "JPG";
    if (m === "image/png") return "PNG";
    return m || "tidak diketahui";
  }

  /**
   * Validasi SEMUA file sebelum upload dimulai.
   * HANYA cek ukuran — tipe file sudah difilter browser via `accept` attribute.
   * Tujuannya supaya upload tidak pernah gagal karena alasan format yang
   * sebenarnya sah.
   */
  async function preflightValidateFiles(filesMap) {
    const errors = [];
    for (const [field, file] of Object.entries(filesMap)) {
      const label = FILE_FIELD_LABELS[field] || field;
      const limit = FIELD_MAX_BYTES[field] || 10 * 1024 * 1024;
      if (file.size > limit) {
        const mb = (limit / 1024 / 1024).toFixed(0);
        errors.push({ field, label, fileName: file.name,
          reason: `Ukuran ${(file.size / 1024 / 1024).toFixed(2)} MB melebihi batas ${mb} MB.` });
      }
    }
    return errors;
  }

  function setSubmitting(isLoading, progressMsg) {
    submitBtn.disabled = isLoading;
    backBtn.disabled = isLoading;
    submitBtn.dataset.originalText = submitBtn.dataset.originalText || submitBtn.innerHTML;
    if (isLoading) {
      submitBtn.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${progressMsg || "Mengirim..."}`;
    } else {
      submitBtn.innerHTML = submitBtn.dataset.originalText;
    }
  }

  function makeRefCode() {
    return "TEP-2026-" + Date.now().toString(36).toUpperCase().slice(-6);
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    for (let i = 1; i <= TOTAL; i++) {
      if (!validatePage(i)) { showPage(i); return; }
    }
    const okId = await validateNomorId();
    if (!okId) { showPage(1); return; }

    const data = serializeForm(form);
    const { value: normalizedId } = classifyId(data.nomorId);
    if (!normalizedId) { showPage(1); return; }
    data.nomorId = normalizedId;

    // Remove raw file entries from payload (akan diisi URL upload)
    FILE_FIELDS.forEach((f) => { delete data[f]; });

    const kode = makeRefCode();
    data.kode = kode;

    const files = collectFiles();
    const fileNames = Object.keys(files);

    try {
      // === PREFLIGHT: validasi semua file sebelum upload dimulai ===
      setSubmitting(true, "Memeriksa berkas...");
      const preErrors = await preflightValidateFiles(files);
      if (preErrors.length) {
        const lines = preErrors.map((e) => `• ${e.label}: ${e.reason}`).join("\n");
        alert(`Beberapa berkas belum sesuai:\n\n${lines}\n\nSilakan perbaiki, lalu kirim ulang.`);
        const firstField = preErrors[0].field;
        const firstInput = form.querySelector(`input[type="file"][name="${firstField}"]`);
        if (firstInput) {
          firstInput.closest(".field")?.scrollIntoView({ behavior: "smooth", block: "center" });
        }
        return;
      }

      setSubmitting(true, "Mengunggah berkas...");
      const berkas = {};
      let done = 0;
      await Promise.all(fileNames.map(async (field) => {
        try {
          const meta = await uploadRegistrationFile(normalizedId, field, files[field]);
          berkas[field] = meta;
          done += 1;
          setSubmitting(true, `Mengunggah berkas ${done}/${fileNames.length}...`);
        } catch (upErr) {
          const fieldLabel = FILE_FIELD_LABELS[field] || field;
          const file = files[field];
          // Firebase Storage error biasanya punya customData.serverResponse
          // berisi JSON respon dari server. Ekstrak supaya bisa didiagnosa.
          let serverResponse = "";
          try {
            serverResponse = (upErr && upErr.customData && upErr.customData.serverResponse) || "";
            if (!serverResponse && upErr && upErr.serverResponse_) {
              serverResponse = upErr.serverResponse_;
            }
          } catch (_) {}
          const detail = {
            field,
            fieldLabel,
            fileName: file && file.name,
            fileSize: file && file.size,
            fileType: file && file.type,
            code: upErr && upErr.code,
            message: upErr && upErr.message,
            serverResponse,
            fullError: upErr,
          };
          console.error(`[TEP 2026] Upload failed for "${fieldLabel}":`, detail);
          const err = new Error(`Upload "${fieldLabel}" gagal`);
          err.code = upErr && upErr.code;
          err.field = field;
          err.fieldLabel = fieldLabel;
          err.fileName = file && file.name;
          err.fileSize = file && file.size;
          err.serverResponse = serverResponse;
          err.originalMessage = upErr && upErr.message;
          throw err;
        }
      }));
      data.berkas = berkas;

      setSubmitting(true, "Menyimpan data...");
      await createRegistration(normalizedId, data);
      addLocalRegisteredId(normalizedId);

      const now = new Date();
      const fmt = now.toLocaleString("id-ID", {
        day: "2-digit", month: "long", year: "numeric",
        hour: "2-digit", minute: "2-digit",
        timeZone: "Asia/Jakarta",
      }) + " WIB";
      if (refCodeEl) refCodeEl.textContent = kode;
      if (submittedAtEl) submittedAtEl.textContent = fmt;

      form.hidden = true;
      successScreen.hidden = false;
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      console.error("[TEP 2026] Submit failed:", err);
      const code = (err && err.code) || "";
      const fileLabel = err && err.fieldLabel;
      const fileName = err && err.fileName;
      const fileField = err && err.field;
      const fileSize = err && err.fileSize;
      const fileMB = typeof fileSize === "number" ? (fileSize / 1024 / 1024).toFixed(2) + " MB" : "";
      let msg = "Terjadi kesalahan saat mengirim formulir. Coba lagi beberapa saat.";

      if (code.includes("permission-denied") || code === "auth/admin-restricted-operation") {
        msg = "Nomor identitas ini sudah terdaftar sebelumnya.";
      } else if (code === "storage/unauthorized") {
        const serverResp = err && err.serverResponse ? String(err.serverResponse).slice(0, 500) : "";
        const originalMsg = err && err.originalMessage ? String(err.originalMessage).slice(0, 300) : "";
        msg = `Gagal mengunggah berkas "${fileLabel || "upload"}"${fileName ? ` — ${fileName}` : ""}${fileMB ? ` (${fileMB})` : ""}.\n\n` +
              `Kode error: ${code}\n\n` +
              (originalMsg ? `Pesan: ${originalMsg}\n\n` : "") +
              (serverResp ? `Respon server:\n${serverResp}\n\n` : "") +
              `Silakan screenshot pesan ini dan kirim ke panitia.`;
      } else if (code === "storage/canceled") {
        msg = "Upload dibatalkan. Silakan coba lagi.";
      } else if (code === "storage/quota-exceeded") {
        msg = "Kuota penyimpanan server penuh. Hubungi admin di patriot@transmigrasi.go.id.";
      } else if (code === "storage/retry-limit-exceeded" || code === "storage/server-file-wrong-size"
                 || code === "unavailable" || code.startsWith("storage/retry")) {
        msg = "Koneksi terganggu saat mengunggah berkas. Periksa internet Anda lalu coba kirim ulang.";
      } else if (code === "storage/invalid-argument" || code === "storage/invalid-format") {
        msg = `Format berkas "${fileLabel || "upload"}" tidak valid. Coba ekspor ulang file lalu kirim kembali.`;
      } else if (fileLabel) {
        msg = `Gagal mengunggah "${fileLabel}"${fileName ? ` (${fileName})` : ""}. ${err.message || "Silakan coba lagi."}`;
      }

      alert(msg);

      // Scroll otomatis ke field yang error supaya user langsung tahu.
      if (fileField) {
        const input = form.querySelector(`input[type="file"][name="${fileField}"]`);
        if (input) {
          const parent = input.closest(".field");
          (parent || input).scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }
    } finally {
      setSubmitting(false);
    }
  });

  anotherBtn.addEventListener("click", () => {
    form.reset();
    // Reset dropzones
    document.querySelectorAll(".dropzone").forEach((z) => {
      z.classList.remove("is-filled");
      const f = z.querySelector(".dropzone__file");
      if (f) { f.hidden = true; f.innerHTML = ""; }
    });
    // Reset "Other" inputs
    form.querySelectorAll('input[type="radio"][data-other-target]').forEach((radio) => {
      const t = document.getElementById(radio.dataset.otherTarget);
      if (t) { t.disabled = true; t.required = false; t.value = ""; }
    });
    form.querySelectorAll(".invalid").forEach((el) => el.classList.remove("invalid"));
    form.querySelectorAll(".field.invalid").forEach((el) => el.classList.remove("invalid"));
    form.hidden = false;
    successScreen.hidden = true;
    showPage(1);
  });

  /* ===================== HELPERS ===================== */
  function serializeForm(f) {
    const out = {};
    const fd = new FormData(f);
    for (const [k, v] of fd.entries()) {
      if (v instanceof File) {
        out[k] = v.name ? { fileName: v.name, size: v.size, type: v.type } : null;
      } else if (out[k] !== undefined) {
        out[k] = [].concat(out[k], v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /* ===================== KEYBOARD SHORTCUTS ===================== */
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input[type=text], input[type=email], input[type=tel], input[type=date], textarea, select")) {
      if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
        e.preventDefault();
        if (current < TOTAL) nextBtn.click(); else submitBtn.click();
      }
    }
  });

  /* ===================== INIT ===================== */
  showPage(1, { skipScroll: true });
})();
