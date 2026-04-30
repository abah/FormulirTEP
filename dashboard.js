/* ===========================================================
 * Dashboard Admin - Tim Ekspedisi Patriot 2026
 * Terintegrasi dengan Firebase (Firestore + Auth + Storage).
 * =========================================================== */

import {
  auth, db, storage,
  REGISTRATIONS,
  isAdmin,
  doc, updateDoc, deleteDoc, collection, onSnapshot, query, orderBy,
  serverTimestamp,
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from "./firebase-services.js";

(() => {
  "use strict";

  /* ============================================================
   *  DATA SOURCE - Firestore adapter (realtime via onSnapshot)
   * ============================================================ */
  let unsubscribeSnapshot = null;

  const DataSource = {
    subscribe(onData, onError) {
      if (unsubscribeSnapshot) unsubscribeSnapshot();
      const q = query(collection(db, REGISTRATIONS), orderBy("submittedAt", "desc"));
      unsubscribeSnapshot = onSnapshot(q,
        (snap) => {
          const rows = snap.docs.map((d) => {
            const data = d.data();
            return {
              id: d.id,
              ...data,
              submittedAt: tsToISO(data.submittedAt),
              verifiedAt: tsToISO(data.verifiedAt),
            };
          });
          onData(rows);
        },
        (err) => onError && onError(err),
      );
      return unsubscribeSnapshot;
    },
    async updateStatus(id, status, by) {
      await updateDoc(doc(db, REGISTRATIONS, id), {
        status,
        verifiedAt: status === "pending" ? null : serverTimestamp(),
        verifiedBy: status === "pending" ? null : (by || null),
      });
    },
    async remove(id) {
      await deleteDoc(doc(db, REGISTRATIONS, id));
    },
  };

  function tsToISO(ts) {
    if (!ts) return null;
    if (typeof ts === "string") return ts;
    if (ts.toDate) return ts.toDate().toISOString();
    return null;
  }

  /* ============================================================
   *  STATE
   * ============================================================ */
  const state = {
    all: [],
    filtered: [],
    search: "",
    filters: { status: "", ptMitra: "", posisi: "" },
    sort: { key: "submittedAt", dir: "desc" },
    page: 1,
    pageSize: 10,
    activeId: null,
  };

  /* ============================================================
   *  DOM REFERENCES
   * ============================================================ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const el = {
    search: $("#searchInput"),
    exportBtn: $("#exportBtn"),
    exportMenu: $("#exportMenu"),
    filterStatus: $("#filterStatus"),
    filterMitra: $("#filterMitra"),
    filterPosisi: $("#filterPosisi"),
    clearFilters: $("#clearFilters"),
    statTotal: $("#statTotal"),
    statTotalDelta: $("#statTotalDelta"),
    statPending: $("#statPending"),
    statVerified: $("#statVerified"),
    statRejected: $("#statRejected"),
    barsByMitra: $("#barsByMitra"),
    tableBody: $("#tableBody"),
    emptyState: $("#emptyState"),
    pagination: $("#dashPagination"),
    paginationInfo: $("#paginationInfo"),
    prevPage: $("#prevPage"),
    nextPage: $("#nextPage"),
    pageLabel: $("#pageLabel"),
    theadSort: $$("#dashTable thead th[data-sort]"),
    modal: $("#detailModal"),
    modalKode: $("#modalKode"),
    modalStatus: $("#modalStatus"),
    modalBody: $("#modalBody"),
    modalVerify: $("#modalVerify"),
    modalReject: $("#modalReject"),
  };

  /* ============================================================
   *  HELPERS
   * ============================================================ */
  const STATUS_LABEL = {
    pending: "Menunggu",
    verified: "Terverifikasi",
    rejected: "Ditolak",
  };

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" })
      + " · " + d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  }
  function formatDateShort(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
  }

  /* ============================================================
   *  LOADING + FILTERS
   * ============================================================ */
  function subscribe() {
    DataSource.subscribe(
      (rows) => {
        state.all = rows;
        populateFilters();
        applyFilters();
      },
      (err) => {
        console.error("[dashboard] onSnapshot error:", err);
        if (String(err.code).includes("permission-denied")) {
          showAuthNote("Akun Anda belum terdaftar sebagai admin. Minta super-admin menambahkan email Anda ke koleksi `admins`.", true);
          signOut(auth);
        }
      },
    );
  }

  function populateFilters() {
    const mitras = [...new Set(state.all.map((r) => r.ptMitra).filter(Boolean))].sort();
    const posisis = [...new Set(state.all.map((r) => r.posisi).filter(Boolean))].sort();
    el.filterMitra.innerHTML = `<option value="">Semua PT mitra</option>` +
      mitras.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
    el.filterPosisi.innerHTML = `<option value="">Semua posisi</option>` +
      posisis.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
  }

  function applyFilters() {
    const q = state.search.trim().toLowerCase();
    const { status, ptMitra, posisi } = state.filters;
    let list = state.all.filter((r) => {
      if (status && r.status !== status) return false;
      if (ptMitra && r.ptMitra !== ptMitra) return false;
      if (posisi && r.posisi !== posisi) return false;
      if (q) {
        const hay = [
          r.namaLengkap, r.namaGelar, r.email, r.emailAktif, r.kode, r.nomorId,
          r.ptMitra, r.ptAsal, r.ptAsalOther, r.prodiPT, r.posisi,
          r.whatsapp, r.asalDaerah, r.tempatLahir, r.namaOrangTua, r.tahunPenempatan, r.lokasiTransmigrasi,
        ].filter(Boolean).join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const { key, dir } = state.sort;
    list.sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null) return 1;
      if (bv == null) return -1;
      const cmp = av > bv ? 1 : av < bv ? -1 : 0;
      return dir === "asc" ? cmp : -cmp;
    });

    state.filtered = list;
    state.page = 1;
    renderAll();
  }

  /* ============================================================
   *  RENDER
   * ============================================================ */
  function renderAll() {
    renderStats();
    renderTable();
    renderPagination();
    renderSortHeaders();
  }

  function renderStats() {
    const all = state.all;
    const total = all.length;
    const pending = all.filter((r) => r.status === "pending").length;
    const verified = all.filter((r) => r.status === "verified").length;
    const rejected = all.filter((r) => r.status === "rejected").length;
    el.statTotal.textContent = total.toLocaleString("id-ID");
    el.statTotalDelta.textContent = `${state.filtered.length.toLocaleString("id-ID")} tampil`;
    el.statPending.textContent = pending.toLocaleString("id-ID");
    el.statVerified.textContent = verified.toLocaleString("id-ID");
    el.statRejected.textContent = rejected.toLocaleString("id-ID");

    const byMitra = {};
    all.forEach((r) => {
      const key = r.ptMitra || "—";
      byMitra[key] = (byMitra[key] || 0) + 1;
    });
    const max = Math.max(1, ...Object.values(byMitra));
    const sorted = Object.entries(byMitra).sort((a, b) => b[1] - a[1]);
    el.barsByMitra.innerHTML = sorted.map(([name, n]) => `
      <div class="bar">
        <div class="bar__label" title="${esc(name)}">${esc(name)}</div>
        <div class="bar__track"><div class="bar__fill" style="width:${(n / max) * 100}%"></div></div>
        <div class="bar__value">${n}</div>
      </div>
    `).join("");
  }

  function renderTable() {
    const { page, pageSize, filtered } = state;
    const start = (page - 1) * pageSize;
    const slice = filtered.slice(start, start + pageSize);

    el.emptyState.hidden = slice.length > 0;
    el.tableBody.innerHTML = slice.map((r) => `
      <tr data-id="${esc(r.id)}">
        <td class="td-kode">${esc(r.kode)}</td>
        <td>
          <div class="td-nama">${esc(r.namaLengkap)}</div>
          <div class="td-sub">${esc(r.email || r.emailAktif)}</div>
        </td>
        <td>${esc(r.ptMitra || "—")}</td>
        <td>${esc(r.ptAsal === "__other__" ? (r.ptAsalOther || "—") : (r.ptAsal || "—"))}</td>
        <td>${esc(r.posisi || "—")}</td>
        <td><span class="status-pill is-${esc(r.status)}">${esc(STATUS_LABEL[r.status] || r.status)}</span></td>
        <td class="td-date">${formatDateShort(r.submittedAt)}</td>
        <td class="td-actions">
          <button class="icon-btn" aria-label="Lihat detail" data-detail="${esc(r.id)}">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        </td>
      </tr>
    `).join("");

    $$("#tableBody tr").forEach((tr) => {
      tr.addEventListener("click", () => openDetail(tr.dataset.id));
    });
  }

  function renderPagination() {
    const totalPages = Math.max(1, Math.ceil(state.filtered.length / state.pageSize));
    if (state.page > totalPages) state.page = totalPages;
    const start = (state.page - 1) * state.pageSize;
    const end = Math.min(start + state.pageSize, state.filtered.length);
    el.pagination.hidden = state.filtered.length === 0;
    el.paginationInfo.textContent = state.filtered.length
      ? `Menampilkan ${start + 1}–${end} dari ${state.filtered.length}`
      : "0 hasil";
    el.pageLabel.textContent = `${state.page} / ${totalPages}`;
    el.prevPage.disabled = state.page <= 1;
    el.nextPage.disabled = state.page >= totalPages;
  }

  function renderSortHeaders() {
    el.theadSort.forEach((th) => {
      th.classList.remove("is-sort-asc", "is-sort-desc");
      if (th.dataset.sort === state.sort.key) {
        th.classList.add(state.sort.dir === "asc" ? "is-sort-asc" : "is-sort-desc");
      }
    });
  }

  /* ============================================================
   *  DETAIL MODAL
   * ============================================================ */
  const FILE_FIELD_LABELS = {
    pasFoto: "Pas Foto 4×6",
    ijazah: "Ijazah",
    portoKarya: "Portofolio Karya Ilmiah",
    portoTim: "Portofolio Pengalaman Tim",
    suratIntegritas: "Surat Integritas",
    suratRekomendasi: "Surat Rekomendasi",
    suratBersedia: "Surat Bersedia",
  };
  function kindBadge(meta) {
    const t = (meta && meta.type) || "";
    const n = (meta && meta.name) || "";
    if (t === "image/png" || /\.png$/i.test(n)) return "PNG";
    if (t === "image/jpeg" || /\.jpe?g$/i.test(n)) return "JPG";
    return "PDF";
  }
  function isImageMeta(meta) {
    const badge = kindBadge(meta);
    return badge === "PNG" || badge === "JPG";
  }
  function renderBerkas(berkas) {
    if (!berkas || typeof berkas !== "object") return "";
    const entries = Object.entries(berkas).filter(([, v]) => v && v.url);
    if (!entries.length) return "";
    const items = entries.map(([key, meta]) => {
      const label = FILE_FIELD_LABELS[key] || key;
      const badge = kindBadge(meta);
      const thumb = isImageMeta(meta)
        ? `<img class="berkas-link__thumb" src="${esc(meta.url)}" alt="${esc(label)}" loading="lazy" />`
        : `<span class="berkas-link__icon">${badge}</span>`;
      return `
        <a class="berkas-link" href="${esc(meta.url)}" target="_blank" rel="noopener">
          ${thumb}
          <span class="berkas-link__label">${esc(label)}</span>
          <span class="berkas-link__size">${formatBytes(meta.size)}</span>
        </a>
      `;
    }).join("");
    return `
      <div class="modal__row modal__row--full">
        <div class="modal__label">Berkas Terlampir</div>
        <div class="berkas-grid">${items}</div>
      </div>
    `;
  }
  function formatBytes(n) {
    if (!n) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    return `${(n / 1024 / 1024).toFixed(2)} MB`;
  }

  // Helper: ambil nilai "other" bila radio menunjuk ke __other__, kalau
  // tidak pakai nilai radio-nya.
  function resolveOther(value, otherValue) {
    if (value === "__other__") return otherValue || "—";
    return value;
  }

  // Helper: tampilkan nilai panjang (textarea) dengan preservasi baris baru.
  function longText(v) {
    if (!v) return '<span class="modal__value--muted">—</span>';
    return `<div class="modal__longtext">${esc(v).replace(/\n/g, "<br/>")}</div>`;
  }

  function openDetail(id) {
    const reg = state.all.find((r) => r.id === id);
    if (!reg) return;
    state.activeId = id;
    el.modalKode.textContent = reg.kode || "—";
    el.modalStatus.className = "status-pill is-" + reg.status;
    el.modalStatus.textContent = STATUS_LABEL[reg.status] || reg.status;

    const row = (label, value, full = false) => `
      <div class="modal__row ${full ? 'modal__row--full' : ''}">
        <div class="modal__label">${esc(label)}</div>
        <div class="modal__value ${value ? '' : 'modal__value--muted'}">${esc(value || '—')}</div>
      </div>
    `;
    const rowHTML = (label, html, full = false) => `
      <div class="modal__row ${full ? 'modal__row--full' : ''}">
        <div class="modal__label">${esc(label)}</div>
        <div class="modal__value">${html}</div>
      </div>
    `;
    const section = (title) => `
      <div class="modal__section-title">${esc(title)}</div>
    `;

    const ptAsal = resolveOther(reg.ptAsal, reg.ptAsalOther);
    const ukuranKemeja = resolveOther(reg.ukuranKemeja, reg.ukuranKemejaOther);
    const ukuranCelana = resolveOther(reg.ukuranCelana, reg.ukuranCelanaOther);
    const ukuranRompi = resolveOther(reg.ukuranRompi, reg.ukuranRompiOther);
    const ukuranJaket = resolveOther(reg.ukuranJaket, reg.ukuranJaketOther);

    el.modalBody.innerHTML = [
      // --- Identitas ---
      section("Identitas"),
      row("Nama Lengkap", reg.namaLengkap, true),
      row("Nama + Gelar", reg.namaGelar),
      row("Nomor Identitas (KTP / Paspor)", reg.nomorId),
      row("Kewarganegaraan", reg.kewarganegaraan),
      row("Tempat, Tanggal Lahir", [reg.tempatLahir, formatDateShort(reg.tanggalLahir)].filter(Boolean).join(", ")),
      row("Jenis Kelamin", reg.jenisKelamin),
      row("Suku Bangsa", reg.sukuBangsa),
      row("Asal Daerah", reg.asalDaerah),
      row("Alamat Domisili", reg.alamatDomisili, true),
      row("Keluarga Transmigran", reg.keluargaTransmigran || reg.asalKawasanTransmigrasi),
      row("Nama Orang Tua (Transmigran)", (reg.keluargaTransmigran || reg.asalKawasanTransmigrasi) === "Iya" ? reg.namaOrangTua : "—"),
      row("Tahun Penempatan", (reg.keluargaTransmigran || reg.asalKawasanTransmigrasi) === "Iya" ? reg.tahunPenempatan : "—"),
      row("Lokasi Transmigrasi", (reg.keluargaTransmigran || reg.asalKawasanTransmigrasi) === "Iya" ? reg.lokasiTransmigrasi : "—"),

      // --- Kontak ---
      section("Kontak"),
      row("Email", reg.email),
      row("Email Aktif", reg.emailAktif),
      row("WhatsApp", reg.whatsapp),

      // --- Akademik ---
      section("Akademik"),
      row("Perguruan Tinggi Mitra (Induk)", reg.ptMitra, true),
      row("Perguruan Tinggi Asal", ptAsal, true),
      row("Jenjang", reg.jenjang),
      row("Status Pendidikan", reg.statusPendidikan),
      row("Program Studi", reg.prodiPT),

      // --- Posisi ---
      section("Posisi yang Dilamar"),
      row("Posisi", reg.posisi, true),
      row("Masa Waktu Kegiatan", reg.masaWaktuKegiatan),

      // --- Pengalaman ---
      section("Pengalaman & Portofolio"),
      rowHTML("Pengalaman / Karya Ilmiah", longText(reg.pengalamanKarya), true),
      rowHTML("Pengalaman Tim", longText(reg.pengalamanTim), true),

      // --- Ukuran Seragam & Biometrik ---
      section("Ukuran Seragam & Biometrik"),
      row("Ukuran Kemeja", ukuranKemeja),
      row("Ukuran Celana", ukuranCelana),
      row("Ukuran Rompi", ukuranRompi),
      row("Ukuran Jaket", ukuranJaket),
      row("Tinggi Badan (cm)", reg.tinggiBadan),
      row("Berat Badan (kg)", reg.beratBadan),
      row("Golongan Darah", reg.golonganDarah),

      // --- Kontak Darurat ---
      section("Kontak Darurat"),
      row("Nama", reg.namaDarurat),
      row("Hubungan", reg.hubunganDarurat),
      row("Telepon", reg.teleponDarurat),
      row("Alamat", reg.alamatDarurat, true),

      // --- Persetujuan ---
      section("Persetujuan"),
      row("Pernyataan kebenaran data", reg.pernyataanBenar || "—"),
      row("Persetujuan kegiatan", reg.persetujuanKegiatan || "—"),

      // --- Metadata ---
      section("Metadata Pendaftaran"),
      row("Kode Pendaftaran", reg.kode),
      row("Tanggal Daftar", formatDate(reg.submittedAt)),
      row("Status", STATUS_LABEL[reg.status] || reg.status),
      row("Tanggal Verifikasi", reg.verifiedAt ? formatDate(reg.verifiedAt) : null),
      row("Diverifikasi oleh", reg.verifiedBy),

      // --- Berkas ---
      renderBerkas(reg.berkas),
    ].join("");

    el.modal.hidden = false;
    el.modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
  }
  function closeDetail() {
    el.modal.hidden = true;
    el.modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    state.activeId = null;
  }

  async function setStatus(newStatus) {
    if (!state.activeId) return;
    try {
      await DataSource.updateStatus(state.activeId, newStatus, auth.currentUser?.email || null);
      // onSnapshot akan otomatis refresh, namun update visual modal segera:
      el.modalStatus.className = "status-pill is-" + newStatus;
      el.modalStatus.textContent = STATUS_LABEL[newStatus];
    } catch (err) {
      console.error(err);
      alert("Gagal memperbarui status. Pastikan Anda masih masuk sebagai admin.");
    }
  }

  /* ============================================================
   *  EXPORT CSV
   *
   *  Strategi: kolom disusun dari 3 sumber sehingga TIDAK ADA field
   *  yang terlewat, walaupun field baru ditambahkan di form.
   *    1. "canonical" — daftar kolom + label rapi, urutan manusiawi
   *    2. "extras"   — field lain yang ada di data tapi belum ada di
   *                    canonical (auto-discovered dari semua baris)
   *    3. "berkas"   — URL + nama + ukuran + tipe untuk setiap file
   * ============================================================ */

  // Label manusiawi untuk setiap field. Urutan di sini menentukan
  // urutan kolom di CSV.
  const CSV_CANONICAL = [
    // Metadata
    ["id", "Doc ID"],
    ["kode", "Kode"],
    ["submittedAt", "Tanggal Daftar"],
    ["status", "Status"],
    ["verifiedAt", "Tanggal Verifikasi"],
    ["verifiedBy", "Verifikator"],
    // Identitas
    ["namaLengkap", "Nama Lengkap"],
    ["namaGelar", "Nama + Gelar"],
    ["nomorId", "Nomor Identitas (KTP/Paspor)"],
    ["kewarganegaraan", "Kewarganegaraan"],
    ["tempatLahir", "Tempat Lahir"],
    ["tanggalLahir", "Tanggal Lahir"],
    ["jenisKelamin", "Jenis Kelamin"],
    ["sukuBangsa", "Suku Bangsa"],
    ["asalDaerah", "Asal Daerah"],
    ["alamatDomisili", "Alamat Domisili"],
    ["keluargaTransmigran", "Keluarga Transmigran"],
    ["namaOrangTua", "Nama Orang Tua (Transmigran)"],
    ["tahunPenempatan", "Tahun Penempatan"],
    ["lokasiTransmigrasi", "Lokasi Transmigrasi"],
    // Field lama (registrasi sebelum 30 Apr 2026) - tetap diekspor
    // bila ada di data, supaya backward compatible.
    ["asalKawasanTransmigrasi", "[Lama] Keturunan Transmigran"],
    ["namaKawasanTransmigrasi", "[Lama] Nama Kawasan Transmigrasi"],
    // Kontak
    ["email", "Email"],
    ["emailAktif", "Email Aktif"],
    ["whatsapp", "WhatsApp"],
    // Akademik
    ["ptMitra", "PT Mitra (Induk)"],
    ["ptAsal", "PT Asal"],
    ["ptAsalOther", "PT Asal (isian lain)"],
    ["jenjang", "Jenjang"],
    ["statusPendidikan", "Status Pendidikan"],
    ["prodiPT", "Program Studi"],
    // Posisi
    ["posisi", "Posisi"],
    ["masaWaktuKegiatan", "Masa Waktu Kegiatan"],
    // Pengalaman
    ["pengalamanKarya", "Pengalaman / Karya Ilmiah"],
    ["pengalamanTim", "Pengalaman Tim"],
    // Ukuran seragam & biometrik
    ["ukuranKemeja", "Ukuran Kemeja"],
    ["ukuranKemejaOther", "Ukuran Kemeja (isian lain)"],
    ["ukuranCelana", "Ukuran Celana"],
    ["ukuranCelanaOther", "Ukuran Celana (isian lain)"],
    ["ukuranRompi", "Ukuran Rompi"],
    ["ukuranRompiOther", "Ukuran Rompi (isian lain)"],
    ["ukuranJaket", "Ukuran Jaket"],
    ["ukuranJaketOther", "Ukuran Jaket (isian lain)"],
    ["tinggiBadan", "Tinggi Badan (cm)"],
    ["beratBadan", "Berat Badan (kg)"],
    ["golonganDarah", "Golongan Darah"],
    // Kontak darurat
    ["namaDarurat", "Darurat - Nama"],
    ["hubunganDarurat", "Darurat - Hubungan"],
    ["teleponDarurat", "Darurat - Telepon"],
    ["alamatDarurat", "Darurat - Alamat"],
    // Persetujuan
    ["pernyataanBenar", "Pernyataan Data Benar"],
    ["persetujuanKegiatan", "Persetujuan Kegiatan"],
  ];

  // Label untuk field berkas (akan dipecah menjadi URL / Nama / Ukuran / Tipe).
  const CSV_BERKAS_LABELS = {
    pasFoto: "Pas Foto 4x6",
    ijazah: "Ijazah",
    portoKarya: "Portofolio Karya Ilmiah",
    portoTim: "Portofolio Pengalaman Tim",
    suratIntegritas: "Surat Pernyataan Integritas",
    suratRekomendasi: "Surat Rekomendasi",
    suratBersedia: "Surat Pernyataan Bersedia",
  };

  // Field yang tidak boleh ikut diekspor dari extras (internal atau
  // sudah dipecah terpisah).
  const CSV_SKIP_KEYS = new Set(["berkas"]);

  // Format nilai untuk dimasukkan ke CSV.
  function csvFormatValue(v) {
    if (v == null) return "";
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "string") {
      // Kalau sudah ISO date, ubah ke format lokal yang lebih enak dibaca.
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
        try {
          const d = new Date(v);
          return d.toLocaleString("id-ID", {
            day: "2-digit", month: "2-digit", year: "numeric",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
          });
        } catch (_) { return v; }
      }
      return v;
    }
    if (typeof v === "boolean" || typeof v === "number") return String(v);
    if (Array.isArray(v)) return v.map(csvFormatValue).join(" | ");
    if (typeof v === "object") {
      // Timestamp Firestore yang belum sempat di-ISO-kan
      if (typeof v.toDate === "function") {
        try { return v.toDate().toLocaleString("id-ID"); } catch (_) {}
      }
      try { return JSON.stringify(v); } catch (_) { return String(v); }
    }
    return String(v);
  }

  function csvEscape(v) {
    const s = csvFormatValue(v);
    return /[",\n\r\t]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  /**
   * Bentuk daftar kolom (canonical + extras + berkas) berdasarkan
   * data baris yang akan diekspor. Dipakai oleh CSV maupun XLSX.
   */
  function buildExportColumns(rows) {
    const canonicalKeys = new Set(CSV_CANONICAL.map(([k]) => k));
    const cols = [...CSV_CANONICAL];

    const extras = new Set();
    rows.forEach((r) => {
      Object.keys(r || {}).forEach((k) => {
        if (!canonicalKeys.has(k) && !CSV_SKIP_KEYS.has(k)) extras.add(k);
      });
    });
    [...extras].sort().forEach((k) => cols.push([k, k]));

    const berkasKeys = new Set();
    rows.forEach((r) => {
      if (r && r.berkas && typeof r.berkas === "object") {
        Object.keys(r.berkas).forEach((k) => berkasKeys.add(k));
      }
    });
    const knownOrder = Object.keys(CSV_BERKAS_LABELS);
    const orderedBerkas = [
      ...knownOrder.filter((k) => berkasKeys.has(k)),
      ...[...berkasKeys].filter((k) => !knownOrder.includes(k)).sort(),
    ];
    const berkasCols = [];
    orderedBerkas.forEach((key) => {
      const label = CSV_BERKAS_LABELS[key] || key;
      berkasCols.push([`berkas.${key}.url`, `${label} - URL`, (r) => r?.berkas?.[key]?.url]);
      berkasCols.push([`berkas.${key}.name`, `${label} - Nama File`, (r) => r?.berkas?.[key]?.name]);
      berkasCols.push([`berkas.${key}.size`, `${label} - Ukuran (byte)`, (r) => r?.berkas?.[key]?.size]);
      berkasCols.push([`berkas.${key}.type`, `${label} - Tipe`, (r) => r?.berkas?.[key]?.type]);
      berkasCols.push([`berkas.${key}.path`, `${label} - Path Storage`, (r) => r?.berkas?.[key]?.path]);
    });

    return [...cols, ...berkasCols];
  }

  function getCellValue(row, col) {
    if (typeof col[2] === "function") return col[2](row);
    return row?.[col[0]];
  }

  function timestampForFile() {
    return new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  }

  function exportCSV() {
    const rows = state.filtered.length ? state.filtered : state.all;
    if (!rows.length) { alert("Tidak ada data untuk diekspor."); return; }

    const cols = buildExportColumns(rows);
    const header = cols.map((c) => csvEscape(c[1])).join(",");
    const body = rows.map((r) => cols.map((c) => csvEscape(getCellValue(r, c))).join(",")).join("\n");

    const csv = "\uFEFF" + header + "\n" + body;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `tep-2026-pendaftar-${timestampForFile()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  /**
   * Excel export pakai SheetJS (window.XLSX, di-load via CDN).
   * Kalau library belum siap, fallback ke CSV.
   */
  function exportXLSX() {
    if (typeof window.XLSX === "undefined") {
      alert("Pustaka Excel belum termuat. Mohon coba lagi beberapa detik.\nSementara ini, ekspor CSV tetap tersedia.");
      return;
    }

    const rows = state.filtered.length ? state.filtered : state.all;
    if (!rows.length) { alert("Tidak ada data untuk diekspor."); return; }

    const cols = buildExportColumns(rows);

    // Bentuk array-of-arrays: baris pertama = header, sisanya = data
    const aoa = [
      cols.map((c) => c[1]),
      ...rows.map((r) => cols.map((c) => {
        const v = getCellValue(r, c);
        // Nilai numerik dipertahankan sebagai number agar Excel bisa
        // mengaplikasi format/sortir angka yang benar.
        if (typeof v === "number" && Number.isFinite(v)) return v;
        return csvFormatValue(v);
      })),
    ];

    const ws = window.XLSX.utils.aoa_to_sheet(aoa);

    // Auto-width sederhana berbasis konten terpanjang per kolom
    // (max 60 karakter supaya kolom tidak melebar berlebihan).
    const colWidths = cols.map((_, i) => {
      let max = 8;
      for (const row of aoa) {
        const cell = row[i];
        if (cell == null) continue;
        const len = String(cell).length;
        if (len > max) max = len;
      }
      return { wch: Math.min(max + 2, 60) };
    });
    ws["!cols"] = colWidths;
    ws["!freeze"] = { xSplit: 0, ySplit: 1 };

    const wb = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(wb, ws, "Pendaftar");

    // Sheet ringkasan ringan biar admin tahu kapan diekspor
    const summary = [
      ["Tim Ekspedisi Patriot 2026 - Daftar Pendaftar"],
      [],
      ["Tanggal Ekspor", new Date().toLocaleString("id-ID")],
      ["Jumlah Baris", rows.length],
      ["Total Pendaftar Database", state.all.length],
      ["Filter Aktif",
        [
          state.filters.status && `Status: ${STATUS_LABEL[state.filters.status] || state.filters.status}`,
          state.filters.ptMitra && `PT Mitra: ${state.filters.ptMitra}`,
          state.filters.posisi && `Posisi: ${state.filters.posisi}`,
          state.search && `Pencarian: ${state.search}`,
        ].filter(Boolean).join(" | ") || "—"
      ],
    ];
    const wsSummary = window.XLSX.utils.aoa_to_sheet(summary);
    wsSummary["!cols"] = [{ wch: 28 }, { wch: 60 }];
    window.XLSX.utils.book_append_sheet(wb, wsSummary, "Ringkasan");

    window.XLSX.writeFile(wb, `tep-2026-pendaftar-${timestampForFile()}.xlsx`);
  }

  /* ============================================================
   *  EVENT BINDINGS
   * ============================================================ */
  el.search.addEventListener("input", (e) => {
    state.search = e.target.value;
    applyFilters();
  });

  el.filterStatus.addEventListener("click", (e) => {
    const btn = e.target.closest(".pill");
    if (!btn) return;
    el.filterStatus.querySelectorAll(".pill").forEach((p) => p.classList.remove("is-active"));
    btn.classList.add("is-active");
    state.filters.status = btn.dataset.value || "";
    applyFilters();
  });

  el.filterMitra.addEventListener("change", (e) => {
    state.filters.ptMitra = e.target.value;
    applyFilters();
  });
  el.filterPosisi.addEventListener("change", (e) => {
    state.filters.posisi = e.target.value;
    applyFilters();
  });
  el.clearFilters.addEventListener("click", () => {
    state.search = "";
    el.search.value = "";
    state.filters = { status: "", ptMitra: "", posisi: "" };
    el.filterMitra.value = "";
    el.filterPosisi.value = "";
    el.filterStatus.querySelectorAll(".pill").forEach((p) => {
      p.classList.toggle("is-active", p.dataset.value === "");
    });
    applyFilters();
  });

  el.theadSort.forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) {
        state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort.key = key;
        state.sort.dir = "asc";
      }
      applyFilters();
    });
  });

  el.prevPage.addEventListener("click", () => {
    if (state.page > 1) { state.page--; renderTable(); renderPagination(); }
  });
  el.nextPage.addEventListener("click", () => {
    const totalPages = Math.ceil(state.filtered.length / state.pageSize);
    if (state.page < totalPages) { state.page++; renderTable(); renderPagination(); }
  });

  // === Export menu ===
  function setExportMenuOpen(open) {
    if (!el.exportMenu) return;
    el.exportMenu.classList.toggle("is-open", open);
    el.exportBtn.setAttribute("aria-expanded", String(open));
    const dropdown = el.exportMenu.querySelector(".export-menu__dropdown");
    if (dropdown) dropdown.hidden = !open;
  }
  el.exportBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isOpen = el.exportMenu.classList.contains("is-open");
    setExportMenuOpen(!isOpen);
  });
  el.exportMenu?.querySelectorAll(".export-menu__item").forEach((item) => {
    item.addEventListener("click", () => {
      const kind = item.dataset.export;
      setExportMenuOpen(false);
      if (kind === "xlsx") exportXLSX();
      else exportCSV();
    });
  });
  document.addEventListener("click", (e) => {
    if (!el.exportMenu) return;
    if (!el.exportMenu.contains(e.target)) setExportMenuOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") setExportMenuOpen(false);
  });

  el.modal.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-modal]")) closeDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (!el.modal.hidden && e.key === "Escape") closeDetail();
  });
  el.modalVerify.addEventListener("click", () => setStatus("verified"));
  el.modalReject.addEventListener("click", () => setStatus("rejected"));

  // Nav items (stub — hanya Pendaftaran yang aktif)
  $$(".dash-nav__item").forEach((b) => {
    b.addEventListener("click", () => {
      $$(".dash-nav__item").forEach((x) => x.classList.remove("is-active"));
      b.classList.add("is-active");
      if (b.dataset.view === "export") {
        setExportMenuOpen(true);
        el.exportBtn.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      if (b.dataset.view === "overview") {
        document.querySelector(".stats-grid").scrollIntoView({ behavior: "smooth", block: "start" });
      }
      if (b.dataset.view === "registrations") {
        document.querySelector(".dash-table-wrap").scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  /* ============================================================
   *  AUTH GATE (Google Sign-In + admin whitelist via Firestore)
   * ============================================================ */
  const authGate = $("#authGate");
  const signInBtn = $("#signInBtn");
  const signOutBtn = $("#signOutBtn");
  const userNameEl = $("#userName");
  const userEmailEl = $("#userEmail");
  const userAvatarEl = $("#userAvatar");
  const authNote = $("#authNote");

  function showAuthNote(msg, isError) {
    if (!authNote) return;
    authNote.textContent = msg || "";
    authNote.classList.toggle("is-error", !!isError);
  }
  function showGate(show) {
    authGate.hidden = !show;
    document.body.style.overflow = show ? "hidden" : "";
  }

  signInBtn?.addEventListener("click", async () => {
    signInBtn.disabled = true;
    showAuthNote("Menghubungkan ke Google...");
    try {
      const provider = new GoogleAuthProvider();
      await signInWithPopup(auth, provider);
      // onAuthStateChanged di bawah akan ambil alih flow.
    } catch (err) {
      console.error(err);
      showAuthNote(err.code === "auth/popup-closed-by-user"
        ? "Jendela login ditutup sebelum selesai."
        : "Gagal masuk. Coba lagi.", true);
    } finally {
      signInBtn.disabled = false;
    }
  });

  signOutBtn?.addEventListener("click", async () => {
    if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
    await signOut(auth);
  });

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      showGate(true);
      showAuthNote("");
      state.all = [];
      state.filtered = [];
      renderAll();
      return;
    }
    showAuthNote("Memverifikasi izin akses...");
    const admin = await isAdmin(user);
    if (!admin) {
      await signOut(auth);
      showAuthNote(`Akun ${user.email} belum terdaftar sebagai admin. Hubungi super-admin untuk menambahkan.`, true);
      return;
    }
    showGate(false);
    if (userNameEl) userNameEl.textContent = user.displayName || user.email;
    if (userEmailEl) userEmailEl.textContent = user.email;
    if (userAvatarEl) userAvatarEl.textContent = (user.displayName || user.email || "A").charAt(0).toUpperCase();
    subscribe();
  });

  /* Tampilkan gate secara default sampai auth diketahui */
  showGate(true);
})();
