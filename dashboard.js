/* ===========================================================
 * Dashboard Admin - Tim Ekspedisi Patriot 2026
 * Terintegrasi dengan Firebase (Firestore + Auth + Storage).
 * =========================================================== */

import {
  auth, db, storage,
  REGISTRATIONS, EDIT_LOGS,
  isAdmin,
  doc, updateDoc, deleteDoc, collection, onSnapshot, query, where, orderBy, limit,
  serverTimestamp,
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
  updateRegistrationFields, deleteRegistration as svcDeleteRegistration,
  replaceRegistrationFile, tryDeleteStorageFile, writeEditLog,
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
              rejectedAt: tsToISO(data.rejectedAt),
            };
          });
          onData(rows);
        },
        (err) => onError && onError(err),
      );
      return unsubscribeSnapshot;
    },
    async updateStatus(id, status, by, reason) {
      const updates = {
        status,
        verifiedAt: status === "pending" ? null : serverTimestamp(),
        verifiedBy: status === "pending" ? null : (by || null),
      };
      if (status === "rejected") {
        updates.rejectionReason = reason || "(tidak dicantumkan)";
        updates.rejectedAt = serverTimestamp();
        updates.rejectedBy = by || null;
      } else {
        // Saat verify atau set pending, bersihkan reject metadata
        updates.rejectionReason = null;
        updates.rejectedAt = null;
        updates.rejectedBy = null;
      }
      await updateDoc(doc(db, REGISTRATIONS, id), updates);
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
   *  WAKTU - SEMUA TANGGAL/JAM DI DASHBOARD PAKAI WIB (UTC+7)
   *  Indonesia WIB tidak mengenal DST, jadi offset selalu +7 jam.
   * ============================================================ */
  const WIB_TZ = "Asia/Jakarta";
  const WIB_OFFSET_MS = 7 * 3600 * 1000;

  // Kembalikan kunci tanggal kalender WIB (YYYY-MM-DD) untuk
  // sebuah timestamp/Date. Berguna untuk grouping per-hari.
  function wibDateKey(date) {
    const t = date instanceof Date ? date.getTime() : new Date(date).getTime();
    return new Date(t + WIB_OFFSET_MS).toISOString().slice(0, 10);
  }

  // Kembalikan timestamp UTC ms untuk tengah malam (00:00) WIB
  // pada hari dari `date`. Dipakai untuk batas window "hari ini",
  // "kemarin", "7 hari terakhir" sehingga konsisten meskipun
  // browser admin tidak berada di zona WIB.
  function wibStartOfDay(date) {
    const t = (date instanceof Date ? date.getTime() : new Date(date).getTime());
    const dayUTC = Math.floor((t + WIB_OFFSET_MS) / (24 * 3600 * 1000)) * (24 * 3600 * 1000);
    return dayUTC - WIB_OFFSET_MS;
  }

  // Format tanggal+jam WIB untuk display, mis: "01 Mei 2026, 19.42 WIB"
  function fmtDateTimeWIB(input, opts) {
    if (!input) return "—";
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return "—";
    const o = Object.assign({
      day: "2-digit", month: "short", year: "numeric",
      hour: "2-digit", minute: "2-digit",
      timeZone: WIB_TZ,
    }, opts || {});
    return d.toLocaleString("id-ID", o) + " WIB";
  }
  // Format tanggal saja WIB, mis: "01 Mei 2026"
  function fmtDateWIB(input) {
    if (!input) return "—";
    const d = input instanceof Date ? input : new Date(input);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("id-ID", {
      day: "2-digit", month: "short", year: "numeric",
      timeZone: WIB_TZ,
    });
  }
  // Format tanggal panjang WIB, mis: "01 Mei 2026, 19.42 WIB"
  function fmtLongDateTimeWIB(input) {
    return fmtDateTimeWIB(input, { day: "2-digit", month: "long", year: "numeric" });
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
    editing: false,            // mode edit aktif?
    editValues: {},            // staging form values
    editFiles: {},             // { fieldName: File } file baru yang akan di-upload
    editLogs: [],              // audit log untuk pendaftar yang sedang dibuka
    auditUnsub: null,          // unsubscribe listener audit log per pendaftar
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
    modalEdit: $("#modalEdit"),
    modalDelete: $("#modalDelete"),
    modalFootView: $("#modalFootView"),
    modalFootEdit: $("#modalFootEdit"),
    editCancel: $("#editCancel"),
    editSave: $("#editSave"),
    deleteDialog: $("#deleteDialog"),
    deleteDialogTitle: $("#deleteDialogTitle"),
    deletePreview: $("#deletePreview"),
    deleteAlsoFiles: $("#deleteAlsoFiles"),
    deleteConfirm: $("#deleteConfirm"),
    rejectDialog: $("#rejectDialog"),
    rejectDialogTitle: $("#rejectDialogTitle"),
    rejectReason: $("#rejectReason"),
    rejectCharCount: $("#rejectCharCount"),
    rejectPresets: $("#rejectPresets"),
    rejectConfirm: $("#rejectConfirm"),
    // Executive view
    viewOverview: $("#viewOverview"),
    viewRegistrations: $("#viewRegistrations"),
    execAsOf: $("#execAsOf"),
    execPrintBtn: $("#execPrintBtn"),
    execPrintedAt: $("#execPrintedAt"),
    kpiTotal: $("#kpiTotal"),
    kpiTotalSub: $("#kpiTotalSub"),
    kpiToday: $("#kpiToday"),
    kpiTodaySub: $("#kpiTodaySub"),
    kpi7d: $("#kpi7d"),
    kpi7dSub: $("#kpi7dSub"),
    kpiComplete: $("#kpiComplete"),
    kpiCompleteSub: $("#kpiCompleteSub"),
    kpiVerified: $("#kpiVerified"),
    kpiVerifiedSub: $("#kpiVerifiedSub"),
    kpiGender: $("#kpiGender"),
    kpiGenderSub: $("#kpiGenderSub"),
    funnel: $("#funnel"),
    logistikTable: $("#logistikTable"),
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
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("id-ID", {
      day: "2-digit", month: "short", year: "numeric", timeZone: WIB_TZ,
    }) + " · " + d.toLocaleTimeString("id-ID", {
      hour: "2-digit", minute: "2-digit", timeZone: WIB_TZ,
    }) + " WIB";
  }
  function formatDateShort(iso) {
    return fmtDateWIB(iso);
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
    renderOverview();
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
        <td><span class="status-pill is-${esc(r.status)}"${r.status === "rejected" && r.rejectionReason ? ` title="Alasan: ${esc(r.rejectionReason)}"` : ""}>${esc(STATUS_LABEL[r.status] || r.status)}</span></td>
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
   *  EXECUTIVE OVERVIEW (charts + KPI)
   * ============================================================ */
  const charts = {};

  // Palet konsisten dengan tema (navy + gold + aksen)
  const PALETTE = [
    "#122B5C", "#D4A853", "#1C3C7A", "#E3C16F", "#3A5AA0",
    "#B38A2B", "#0E7C66", "#C53030", "#7C3AED", "#0EA5E9",
    "#F59E0B", "#EC4899", "#10B981", "#6366F1", "#F472B6",
  ];

  function fmtN(n) {
    return Number(n || 0).toLocaleString("id-ID");
  }

  // Hitung kelengkapan berkas. Berkas wajib (sesuai form): pasFoto,
  // ijazah, suratIntegritas, suratRekomendasi, suratBersedia, suratSakit,
  // suratIzinOrtu. Optional: portoKarya, portoTim.
  const REQUIRED_FILES = [
    "pasFoto", "ijazah",
    "suratIntegritas", "suratRekomendasi", "suratBersedia",
    "suratSakit", "suratIzinOrtu",
  ];
  function isComplete(reg) {
    if (!reg.berkas || typeof reg.berkas !== "object") return false;
    return REQUIRED_FILES.every((k) => reg.berkas[k] && reg.berkas[k].url);
  }

  // Normalisasi value untuk grouping. Buang spasi awal/akhir, tampilkan
  // "—" bila kosong.
  function nz(v) {
    const s = String(v || "").trim();
    return s || "—";
  }

  function aggregate(rows, getKey) {
    const map = new Map();
    rows.forEach((r) => {
      const k = getKey(r);
      if (k == null) return;
      map.set(k, (map.get(k) || 0) + 1);
    });
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }

  function destroyChart(key) {
    if (charts[key]) {
      try { charts[key].destroy(); } catch (_) {}
      delete charts[key];
    }
  }

  function makeChart(key, ctx, config) {
    destroyChart(key);
    if (!ctx || typeof window.Chart === "undefined") return null;
    charts[key] = new window.Chart(ctx, config);
    return charts[key];
  }

  /**
   * Render seluruh konten Ringkasan Eksekutif. Dipanggil tiap kali
   * data berubah (lewat onSnapshot) DAN ketika view eksekutif aktif.
   * Jika library Chart.js belum termuat, di-skip.
   */
  function renderOverview() {
    if (!el.viewOverview) return;
    if (typeof window.Chart === "undefined") return;
    if (!state.all.length) {
      // Tetap update KPI ke 0 supaya tampilan awal masuk akal
      setKPIs(state.all);
      return;
    }
    setKPIs(state.all);
    renderTrendChart(state.all);
    renderPtAsalChart(state.all);
    renderPtMitraChart(state.all);
    renderGenderChart(state.all);
    renderPendidikanChart(state.all);
    renderMasaWaktuChart(state.all);
    renderGolDarahChart(state.all);
    renderTransmigranChart(state.all);
    renderPosisiChart(state.all);
    renderDaerahChart(state.all);
    renderUkuranChart(state.all);
    renderFunnel(state.all);
    if (el.execAsOf) el.execAsOf.textContent = fmtLongDateTimeWIB(new Date());
  }

  // ---------- KPI ----------
  function setKPIs(rows) {
    const total = rows.length;
    const today = wibStartOfDay(new Date());
    const yesterday = today - 24 * 3600 * 1000;
    const sevenDays = today - 6 * 24 * 3600 * 1000; // termasuk hari ini (WIB)

    const todayCount = rows.filter((r) => {
      const t = r.submittedAt ? new Date(r.submittedAt).getTime() : 0;
      return t >= today;
    }).length;
    const yesterdayCount = rows.filter((r) => {
      const t = r.submittedAt ? new Date(r.submittedAt).getTime() : 0;
      return t >= yesterday && t < today;
    }).length;
    const last7 = rows.filter((r) => {
      const t = r.submittedAt ? new Date(r.submittedAt).getTime() : 0;
      return t >= sevenDays;
    }).length;
    const verified = rows.filter((r) => r.status === "verified").length;
    const complete = rows.filter(isComplete).length;
    const male = rows.filter((r) => /laki/i.test(r.jenisKelamin || "")).length;
    const female = rows.filter((r) => /perempuan/i.test(r.jenisKelamin || "")).length;

    el.kpiTotal.textContent = fmtN(total);
    el.kpiTotalSub.textContent = `${fmtN(rows.filter((r) => r.status === "pending").length)} menunggu verifikasi`;

    el.kpiToday.textContent = fmtN(todayCount);
    if (yesterdayCount === 0 && todayCount === 0) {
      el.kpiTodaySub.textContent = "—";
      el.kpiTodaySub.className = "kpi__sub";
    } else {
      const delta = todayCount - yesterdayCount;
      const arrow = delta > 0 ? "▲" : delta < 0 ? "▼" : "—";
      const cls = delta > 0 ? "kpi__sub is-up" : delta < 0 ? "kpi__sub is-down" : "kpi__sub";
      el.kpiTodaySub.textContent = `${arrow} ${fmtN(Math.abs(delta))} vs kemarin (${fmtN(yesterdayCount)})`;
      el.kpiTodaySub.className = cls;
    }

    el.kpi7d.textContent = fmtN(last7);
    el.kpi7dSub.textContent = `rata-rata ${fmtN(Math.round(last7 / 7))} pendaftar/hari`;

    el.kpiComplete.textContent = fmtN(complete);
    el.kpiCompleteSub.textContent = total ? `${((complete / total) * 100).toFixed(1)}% dari total` : "—";

    el.kpiVerified.textContent = fmtN(verified);
    el.kpiVerifiedSub.textContent = total ? `${((verified / total) * 100).toFixed(1)}% dari total` : "—";

    el.kpiGender.textContent = `${fmtN(male)} : ${fmtN(female)}`;
    const tot = male + female;
    el.kpiGenderSub.textContent = tot
      ? `${((male / tot) * 100).toFixed(0)}% L · ${((female / tot) * 100).toFixed(0)}% P`
      : "komposisi gender";
  }

  // ---------- Tren harian (line + cumulative) ----------
  function renderTrendChart(rows) {
    const cvs = document.getElementById("chartTrend");
    if (!cvs) return;

    // Grouping per-hari pakai kalender WIB. Key = YYYY-MM-DD WIB.
    const byDay = new Map();
    rows.forEach((r) => {
      if (!r.submittedAt) return;
      const key = wibDateKey(r.submittedAt);
      byDay.set(key, (byDay.get(key) || 0) + 1);
    });

    if (byDay.size === 0) {
      destroyChart("trend");
      return;
    }

    const sortedKeys = [...byDay.keys()].sort();
    const startKey = sortedKeys[0];
    const endKey = sortedKeys[sortedKeys.length - 1];

    // Iterasi hari demi hari dari start s/d end (kalender WIB).
    // Trick: hitung pakai UTC midnight + WIB offset agar tidak
    // tergantung timezone browser admin.
    function dayMs(yyyyMmDd) {
      // Anggap "yyyy-mm-dd" sebagai tanggal kalender WIB → konversi
      // ke ms UTC pada 00:00 WIB hari itu.
      const [y, m, d] = yyyyMmDd.split("-").map(Number);
      return Date.UTC(y, m - 1, d) - WIB_OFFSET_MS;
    }

    const labels = [];     // label pendek untuk axis: "01 Mei"
    const titles = [];     // label panjang untuk tooltip: "Jumat, 01 Mei 2026 WIB"
    const daily = [];
    let cumulative = 0;
    const cumul = [];

    for (let t = dayMs(startKey); t <= dayMs(endKey); t += 24 * 3600 * 1000) {
      const k = wibDateKey(new Date(t));
      const v = byDay.get(k) || 0;
      const dt = new Date(t);
      labels.push(dt.toLocaleDateString("id-ID", {
        day: "2-digit", month: "short", timeZone: WIB_TZ,
      }));
      titles.push(dt.toLocaleDateString("id-ID", {
        weekday: "long", day: "2-digit", month: "long", year: "numeric", timeZone: WIB_TZ,
      }) + " · WIB");
      daily.push(v);
      cumulative += v;
      cumul.push(cumulative);
    }

    makeChart("trend", cvs.getContext("2d"), {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Pendaftar baru / hari",
            data: daily,
            borderColor: "#122B5C",
            backgroundColor: "rgba(18, 43, 92, 0.12)",
            fill: true,
            tension: 0.32,
            pointRadius: 2.5,
            pointHoverRadius: 5,
            yAxisID: "y",
            borderWidth: 2.5,
          },
          {
            label: "Akumulasi total",
            data: cumul,
            borderColor: "#D4A853",
            backgroundColor: "rgba(212, 168, 83, 0.0)",
            fill: false,
            tension: 0.32,
            pointRadius: 0,
            yAxisID: "y1",
            borderWidth: 2,
            borderDash: [6, 4],
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12, padding: 14, color: "#334155" } },
          tooltip: {
            backgroundColor: "#0F172A",
            padding: 12,
            titleFont: { size: 12, weight: "600" },
            bodyFont: { size: 12 },
            callbacks: {
              title: (items) => items.length ? titles[items[0].dataIndex] : "",
              label: (ctx) => `${ctx.dataset.label}: ${fmtN(ctx.parsed.y)}`,
            },
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { color: "#64748B", precision: 0 },
            grid: { color: "rgba(0,0,0,0.05)" },
            title: { display: true, text: "Pendaftar / hari (WIB)", color: "#64748B", font: { size: 11 } },
          },
          y1: {
            beginAtZero: true,
            position: "right",
            ticks: { color: "#B38A2B" },
            grid: { drawOnChartArea: false },
            title: { display: true, text: "Akumulasi total", color: "#B38A2B", font: { size: 11 } },
          },
          x: {
            ticks: { color: "#64748B", maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
            grid: { display: false },
          },
        },
      },
    });
  }

  // ---------- Top 10 PT Asal ----------
  function renderPtAsalChart(rows) {
    const cvs = document.getElementById("chartPtAsal");
    if (!cvs) return;
    const top = aggregate(rows, (r) => {
      const v = r.ptAsal === "__other__" ? r.ptAsalOther : r.ptAsal;
      return v ? nz(v) : null;
    }).slice(0, 10);

    if (!top.length) { destroyChart("ptAsal"); return; }

    makeChart("ptAsal", cvs.getContext("2d"), {
      type: "bar",
      data: {
        labels: top.map(([k]) => k),
        datasets: [{
          label: "Pendaftar",
          data: top.map(([, v]) => v),
          backgroundColor: "rgba(18, 43, 92, 0.85)",
          borderRadius: 4,
          maxBarThickness: 22,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: "#0F172A" },
        },
        scales: {
          x: { beginAtZero: true, ticks: { color: "#64748B", precision: 0 }, grid: { color: "rgba(0,0,0,0.05)" } },
          y: { ticks: { color: "#334155", font: { size: 11 } }, grid: { display: false } },
        },
      },
    });
  }

  // ---------- Donut PT Mitra ----------
  function renderPtMitraChart(rows) {
    const cvs = document.getElementById("chartPtMitra");
    if (!cvs) return;
    const data = aggregate(rows, (r) => r.ptMitra ? nz(r.ptMitra) : null);
    if (!data.length) { destroyChart("ptMitra"); return; }
    renderDoughnut("ptMitra", cvs, data);
  }

  // ---------- Donut Gender ----------
  function renderGenderChart(rows) {
    const cvs = document.getElementById("chartGender");
    if (!cvs) return;
    const data = aggregate(rows, (r) => r.jenisKelamin ? nz(r.jenisKelamin) : null);
    renderDoughnut("gender", cvs, data, ["#122B5C", "#D4A853", "#94A3B8"]);
  }

  // ---------- Donut Status Pendidikan ----------
  function renderPendidikanChart(rows) {
    const cvs = document.getElementById("chartPendidikan");
    if (!cvs) return;
    const data = aggregate(rows, (r) => r.statusPendidikan ? nz(r.statusPendidikan) : null);
    renderDoughnut("pendidikan", cvs, data);
  }

  // ---------- Donut Masa Waktu Kegiatan ----------
  function renderMasaWaktuChart(rows) {
    const cvs = document.getElementById("chartMasaWaktu");
    if (!cvs) return;
    const data = aggregate(rows, (r) => r.masaWaktuKegiatan ? nz(r.masaWaktuKegiatan) : null);
    renderDoughnut("masaWaktu", cvs, data, ["#122B5C", "#D4A853"]);
  }

  // ---------- Donut Golongan Darah ----------
  function renderGolDarahChart(rows) {
    const cvs = document.getElementById("chartGolDarah");
    if (!cvs) return;
    const data = aggregate(rows, (r) => r.golonganDarah ? nz(r.golonganDarah) : null);
    renderDoughnut("golDarah", cvs, data);
  }

  // ---------- Donut Keluarga Transmigran ----------
  function renderTransmigranChart(rows) {
    const cvs = document.getElementById("chartTransmigran");
    if (!cvs) return;
    const data = aggregate(rows, (r) => {
      const v = r.keluargaTransmigran || r.asalKawasanTransmigrasi;
      return v ? nz(v) : null;
    });
    renderDoughnut("transmigran", cvs, data, ["#0E7C66", "#94A3B8"]);
  }

  // ---------- Donut Posisi ----------
  function renderPosisiChart(rows) {
    const cvs = document.getElementById("chartPosisi");
    if (!cvs) return;
    const data = aggregate(rows, (r) => r.posisi ? nz(r.posisi) : null);
    renderDoughnut("posisi", cvs, data);
  }

  // ---------- Top 15 Daerah ----------
  function renderDaerahChart(rows) {
    const cvs = document.getElementById("chartDaerah");
    if (!cvs) return;
    const top = aggregate(rows, (r) => r.asalDaerah ? nz(r.asalDaerah) : null).slice(0, 15);
    if (!top.length) { destroyChart("daerah"); return; }

    makeChart("daerah", cvs.getContext("2d"), {
      type: "bar",
      data: {
        labels: top.map(([k]) => k),
        datasets: [{
          label: "Pendaftar",
          data: top.map(([, v]) => v),
          backgroundColor: "rgba(212, 168, 83, 0.92)",
          borderRadius: 4,
          maxBarThickness: 20,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: "y",
        plugins: {
          legend: { display: false },
          tooltip: { backgroundColor: "#0F172A" },
        },
        scales: {
          x: { beginAtZero: true, ticks: { color: "#64748B", precision: 0 }, grid: { color: "rgba(0,0,0,0.05)" } },
          y: { ticks: { color: "#334155", font: { size: 11 } }, grid: { display: false } },
        },
      },
    });
  }

  // ---------- Logistik Ukuran Pakaian ----------
  // Stacked bar (4 series = 4 jenis pakaian) + tabel ringkasan.
  function renderUkuranChart(rows) {
    const cvs = document.getElementById("chartUkuran");
    if (!cvs) return;

    const SIZE_ORDER = ["S", "M", "L", "XL", "2XL", "3XL", "4XL"];
    const items = [
      { key: "ukuranKemeja", other: "ukuranKemejaOther", label: "Kemeja", color: "#122B5C" },
      { key: "ukuranCelana", other: "ukuranCelanaOther", label: "Celana", color: "#1C3C7A" },
      { key: "ukuranRompi",  other: "ukuranRompiOther",  label: "Rompi",  color: "#D4A853" },
      { key: "ukuranJaket",  other: "ukuranJaketOther",  label: "Jaket",  color: "#B38A2B" },
    ];

    function normalizeSize(v) {
      if (!v) return null;
      const s = String(v).trim().toUpperCase().replace(/\s+/g, "");
      if (s === "__OTHER__") return null;
      // Ke standar 2XL, 3XL, 4XL (bukan XXL/XXXL/XXXXL)
      if (s === "XXL") return "2XL";
      if (s === "XXXL") return "3XL";
      if (s === "XXXXL") return "4XL";
      if (SIZE_ORDER.includes(s)) return s;
      return null;
    }

    const datasets = items.map((it) => {
      const counts = SIZE_ORDER.map(() => 0);
      rows.forEach((r) => {
        let v = r[it.key];
        if (v === "__other__") v = r[it.other];
        const s = normalizeSize(v);
        if (s) counts[SIZE_ORDER.indexOf(s)]++;
      });
      return {
        label: it.label,
        data: counts,
        backgroundColor: it.color,
        borderRadius: 4,
        maxBarThickness: 28,
        _total: counts.reduce((a, b) => a + b, 0),
      };
    });

    makeChart("ukuran", cvs.getContext("2d"), {
      type: "bar",
      data: { labels: SIZE_ORDER, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: "bottom", labels: { boxWidth: 12, padding: 14, color: "#334155" } },
          tooltip: { backgroundColor: "#0F172A" },
        },
        scales: {
          x: { ticks: { color: "#334155", font: { weight: "600" } }, grid: { display: false } },
          y: { beginAtZero: true, ticks: { color: "#64748B", precision: 0 }, grid: { color: "rgba(0,0,0,0.05)" } },
        },
      },
    });

    // --- Tabel ringkasan ---
    if (el.logistikTable) {
      const tbody = el.logistikTable.querySelector("tbody");
      tbody.innerHTML = items.map((it) => {
        const counts = SIZE_ORDER.map((sz) => {
          let n = 0;
          rows.forEach((r) => {
            let v = r[it.key];
            if (v === "__other__") v = r[it.other];
            if (normalizeSize(v) === sz) n++;
          });
          return n;
        });
        const total = counts.reduce((a, b) => a + b, 0);
        return `<tr>
          <td>${esc(it.label)}</td>
          ${counts.map((c) => `<td>${c || "—"}</td>`).join("")}
          <td>${total}</td>
        </tr>`;
      }).join("");
    }
  }

  // ---------- Funnel Verifikasi ----------
  function renderFunnel(rows) {
    if (!el.funnel) return;
    const total = rows.length;
    const complete = rows.filter(isComplete).length;
    const verified = rows.filter((r) => r.status === "verified").length;
    const rejected = rows.filter((r) => r.status === "rejected").length;

    const max = Math.max(1, total);
    const steps = [
      { label: "Total Pendaftar", value: total, max, modifier: "" },
      { label: "Berkas Lengkap", value: complete, max, modifier: "gold" },
      { label: "Terverifikasi",  value: verified, max, modifier: "green" },
      { label: "Ditolak",        value: rejected, max, modifier: "red" },
    ];

    el.funnel.innerHTML = steps.map((s) => {
      const pct = max ? (s.value / max) * 100 : 0;
      const pctOfTotal = total ? ((s.value / total) * 100).toFixed(1) : "0.0";
      return `
        <div class="funnel-step ${s.modifier ? `funnel-step--${s.modifier}` : ""}">
          <div class="funnel-step__label">${esc(s.label)}</div>
          <div class="funnel-step__bar">
            <div class="funnel-step__fill" style="width:${pct.toFixed(1)}%"></div>
            <div class="funnel-step__bar-text">${fmtN(s.value)} pendaftar</div>
          </div>
          <div class="funnel-step__pct">
            ${pctOfTotal}%
            <small>dari total pendaftar</small>
          </div>
        </div>
      `;
    }).join("");
  }

  // ---------- Helper: doughnut chart ----------
  function renderDoughnut(key, cvs, data, palette) {
    if (!data.length) { destroyChart(key); return; }
    const colors = (palette && palette.length >= data.length) ? palette : PALETTE;
    makeChart(key, cvs.getContext("2d"), {
      type: "doughnut",
      data: {
        labels: data.map(([k]) => k),
        datasets: [{
          data: data.map(([, v]) => v),
          backgroundColor: data.map((_, i) => colors[i % colors.length]),
          borderWidth: 2,
          borderColor: "#fff",
          hoverOffset: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: "62%",
        plugins: {
          legend: {
            position: "right",
            align: "center",
            labels: { boxWidth: 10, padding: 8, color: "#334155", font: { size: 11.5 } },
          },
          tooltip: {
            backgroundColor: "#0F172A",
            callbacks: {
              label: (ctx) => {
                const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                const pct = total ? ((ctx.parsed / total) * 100).toFixed(1) : "0.0";
                return `${ctx.label}: ${fmtN(ctx.parsed)} (${pct}%)`;
              },
            },
          },
        },
      },
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
    suratSakit: "Surat Tidak Pernah Sakit Berat",
    suratIzinOrtu: "Surat Izin Orang Tua",
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
    state.editLogs = []; // reset cache log; akan diisi lewat onSnapshot
    setEditMode(false);  // memicu renderViewMode otomatis

    el.modal.hidden = false;
    el.modal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";

    // Subscribe ke audit log untuk pendaftar ini (realtime)
    subscribeAuditLogs(id);
  }
  function closeDetail() {
    if (state.editing) {
      // Konfirmasi kalau ada perubahan yang belum disimpan
      const hasChanges = Object.keys(state.editValues).length > 0
                       || Object.keys(state.editFiles).length > 0;
      if (hasChanges && !confirm("Ada perubahan yang belum disimpan. Yakin tutup tanpa menyimpan?")) return;
    }
    el.modal.hidden = true;
    el.modal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    state.activeId = null;
    state.editing = false;
    state.editValues = {};
    state.editFiles = {};
    state.editLogs = [];
    if (state.auditUnsub) { state.auditUnsub(); state.auditUnsub = null; }
    setEditMode(false);
  }

  async function setStatus(newStatus, opts) {
    if (!state.activeId) return;
    const reg = state.all.find((r) => r.id === state.activeId);
    if (!reg) return;
    const oldStatus = reg.status;
    const reason = opts?.reason || null;
    const user = auth.currentUser;
    const byEmail = user?.email || null;

    try {
      await DataSource.updateStatus(state.activeId, newStatus, byEmail, reason);

      // Update visual modal segera (onSnapshot akan refresh juga)
      el.modalStatus.className = "status-pill is-" + newStatus;
      el.modalStatus.textContent = STATUS_LABEL[newStatus];

      // Audit log: catat perubahan status + alasan (kalau reject)
      const changes = [
        { field: "status", label: "Status", oldValue: oldStatus, newValue: newStatus },
      ];
      if (newStatus === "rejected" && reason) {
        changes.push({
          field: "rejectionReason", label: "Alasan Penolakan",
          oldValue: reg.rejectionReason || null, newValue: reason,
        });
      }
      const action = newStatus === "verified" ? "verify"
                  : newStatus === "rejected" ? "reject"
                  : "edit";
      await writeEditLog({
        action,
        registrationId: state.activeId,
        registrationKode: reg.kode,
        registrationName: reg.namaLengkap,
        changes,
        changedBy: byEmail,
        changedByName: user?.displayName || byEmail,
      });
    } catch (err) {
      console.error(err);
      alert("Gagal memperbarui status. Pastikan Anda masih masuk sebagai admin.");
    }
  }

  /* ---------- REJECT DIALOG ---------- */

  function openRejectDialog() {
    if (!state.activeId) return;
    const reg = state.all.find((r) => r.id === state.activeId);
    if (!reg) return;
    el.rejectDialogTitle.textContent = `Tolak pendaftaran: ${reg.namaLengkap || reg.kode}?`;
    el.rejectReason.value = "";
    el.rejectCharCount.textContent = "0";
    el.rejectConfirm.disabled = true;
    el.rejectPresets?.querySelectorAll(".reject-preset").forEach((b) => b.classList.remove("is-active"));
    el.rejectDialog.hidden = false;
    el.rejectDialog.setAttribute("aria-hidden", "false");
    setTimeout(() => el.rejectReason.focus(), 80);
  }
  function closeRejectDialog() {
    el.rejectDialog.hidden = true;
    el.rejectDialog.setAttribute("aria-hidden", "true");
  }
  async function confirmReject() {
    const reason = (el.rejectReason.value || "").trim();
    if (!reason) {
      el.rejectReason.focus();
      return;
    }
    el.rejectConfirm.disabled = true;
    el.rejectConfirm.innerHTML = `<span class="spinner"></span>Memproses…`;
    try {
      await setStatus("rejected", { reason });
      closeRejectDialog();
    } catch (err) {
      console.error("[reject] gagal:", err);
      alert(`Gagal menolak pendaftar.\n\n${err?.code || ""}\n${err?.message || err}`);
    } finally {
      el.rejectConfirm.disabled = false;
      el.rejectConfirm.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6"/><path d="m9 9 6 6"/></svg>Tolak Pendaftaran`;
    }
  }

  /* ============================================================
   *  EDIT MODE — schema field, render form, save, audit log
   * ============================================================ */

  // Schema field: tipe input + label + opsi pilihan. Field yang TIDAK
  // tercantum di sini tidak akan muncul di form edit (kunci, file, dll).
  // Order penting: menentukan urutan tampil di form.
  const PT_MITRA_OPTIONS = [
    "Universitas Indonesia (UI)",
    "Institut Teknologi Bandung (ITB)",
    "Institut Pertanian Bogor (IPB)",
    "Universitas Gadjah Mada (UGM)",
    "Institut Teknologi Sepuluh Nopember (ITS)",
    "Universitas Hasanuddin (UNHAS)",
    "Universitas Brawijaya (UB)",
    "Universitas Padjadjaran (UNPAD)",
    "Universitas Diponegoro (UNDIP)",
    "Universitas Sebelas Maret (UNS)",
  ];
  const SIZE_OPTIONS = ["S", "M", "L", "XL", "2XL", "3XL", "4XL"];

  const FIELD_SCHEMA = [
    // -- Identitas --
    { section: "Identitas" },
    { key: "namaLengkap", label: "Nama Lengkap", type: "text", full: true },
    { key: "namaGelar", label: "Nama + Gelar", type: "text" },
    { key: "kewarganegaraan", label: "Kewarganegaraan", type: "text" },
    { key: "tempatLahir", label: "Tempat Lahir", type: "text" },
    { key: "tanggalLahir", label: "Tanggal Lahir", type: "date" },
    { key: "jenisKelamin", label: "Jenis Kelamin", type: "select", options: ["Laki-laki", "Perempuan"] },
    { key: "sukuBangsa", label: "Suku Bangsa", type: "text" },
    { key: "asalDaerah", label: "Asal Daerah", type: "text" },
    { key: "alamatDomisili", label: "Alamat Domisili", type: "textarea", full: true },
    { key: "keluargaTransmigran", label: "Keluarga Transmigran", type: "select", options: ["Iya", "Tidak"] },
    { key: "namaOrangTua", label: "Nama Orang Tua (Transmigran)", type: "text", showIf: (v) => v.keluargaTransmigran === "Iya" },
    { key: "tahunPenempatan", label: "Tahun Penempatan", type: "text", showIf: (v) => v.keluargaTransmigran === "Iya" },
    { key: "lokasiTransmigrasi", label: "Lokasi Transmigrasi", type: "text", showIf: (v) => v.keluargaTransmigran === "Iya" },
    // -- Kontak --
    { section: "Kontak" },
    { key: "email", label: "Email", type: "email" },
    { key: "emailAktif", label: "Email Aktif", type: "email" },
    { key: "whatsapp", label: "WhatsApp", type: "tel" },
    // -- Akademik --
    { section: "Akademik" },
    { key: "ptMitra", label: "PT Mitra (Induk)", type: "select", options: PT_MITRA_OPTIONS, full: true },
    { key: "ptAsal", label: "PT Asal", type: "text", full: true,
      hint: "Kalau dulu pendaftar memilih 'Lainnya', isikan nama PT Asal di sini langsung." },
    { key: "ptAsalOther", label: "PT Asal (isian lain - jika ada)", type: "text" },
    { key: "jenjang", label: "Jenjang", type: "select", options: ["Diploma", "S1", "S2", "S3"] },
    { key: "statusPendidikan", label: "Status Pendidikan", type: "select",
      options: ["Pasca Sarjana", "S1 Lulus", "S1 Berjalan", "Lainnya"] },
    { key: "prodiPT", label: "Program Studi", type: "text", full: true },
    // -- Posisi --
    { section: "Posisi yang Dilamar" },
    { key: "posisi", label: "Posisi", type: "text", full: true },
    { key: "masaWaktuKegiatan", label: "Masa Waktu Kegiatan", type: "select", options: ["12 bulan", "4 bulan"] },
    // -- Pengalaman --
    { section: "Pengalaman & Portofolio" },
    { key: "pengalamanKarya", label: "Pengalaman / Karya Ilmiah", type: "textarea", full: true },
    { key: "pengalamanTim", label: "Pengalaman Tim", type: "textarea", full: true },
    // -- Ukuran & Biometrik --
    { section: "Ukuran Seragam & Biometrik" },
    { key: "ukuranKemeja", label: "Ukuran Kemeja", type: "select", options: SIZE_OPTIONS },
    { key: "ukuranCelana", label: "Ukuran Celana", type: "select", options: SIZE_OPTIONS },
    { key: "ukuranRompi", label: "Ukuran Rompi", type: "select", options: SIZE_OPTIONS },
    { key: "ukuranJaket", label: "Ukuran Jaket", type: "select", options: SIZE_OPTIONS },
    { key: "tinggiBadan", label: "Tinggi Badan (cm)", type: "number", min: 100, max: 250 },
    { key: "beratBadan", label: "Berat Badan (kg)", type: "number", min: 30, max: 200 },
    { key: "golonganDarah", label: "Golongan Darah", type: "select", options: ["A", "B", "AB", "O", "Tidak tahu"] },
    // -- Kontak Darurat --
    { section: "Kontak Darurat" },
    { key: "namaDarurat", label: "Nama", type: "text" },
    { key: "hubunganDarurat", label: "Hubungan", type: "text" },
    { key: "teleponDarurat", label: "Telepon", type: "tel" },
    { key: "alamatDarurat", label: "Alamat", type: "textarea", full: true },
    // -- Berkas --
    { section: "Berkas" },
    { key: "berkas.pasFoto", label: "Pas Foto 4×6", type: "file", fieldKey: "pasFoto" },
    { key: "berkas.ijazah", label: "Ijazah / SKL", type: "file", fieldKey: "ijazah" },
    { key: "berkas.suratIntegritas", label: "Surat Pernyataan Integritas & Komitmen", type: "file", fieldKey: "suratIntegritas" },
    { key: "berkas.suratRekomendasi", label: "Surat Rekomendasi", type: "file", fieldKey: "suratRekomendasi" },
    { key: "berkas.suratBersedia", label: "Surat Pernyataan Bersedia Mengikuti Kegiatan", type: "file", fieldKey: "suratBersedia" },
    { key: "berkas.suratSakit", label: "Surat Pernyataan Tidak Pernah Sakit Berat/Kronis", type: "file", fieldKey: "suratSakit" },
    { key: "berkas.suratIzinOrtu", label: "Surat Izin Orang Tua", type: "file", fieldKey: "suratIzinOrtu" },
    { key: "berkas.portoKarya", label: "Portofolio Karya Ilmiah", type: "file", fieldKey: "portoKarya" },
    { key: "berkas.portoTim", label: "Portofolio Pengalaman Tim", type: "file", fieldKey: "portoTim" },
  ];

  // Field yang dikunci (tidak boleh diedit lewat UI)
  const LOCKED_FIELDS = new Set(["nomorId", "kode", "submittedAt", "status", "verifiedAt", "verifiedBy"]);

  /**
   * Render form edit di modal body. Mengisi state.editValues dengan
   * snapshot awal supaya bisa dideteksi perubahan saat save.
   */
  function renderEditForm(reg) {
    state.editValues = {};
    state.editFiles = {};

    // Snapshot awal: salin semua field yang ada di schema
    FIELD_SCHEMA.forEach((f) => {
      if (f.section || f.type === "file") return;
      state.editValues[f.key] = reg[f.key] === undefined ? "" : reg[f.key];
    });

    const lockedRow = (label, value, badge = "Kunci") => `
      <div class="edit-field edit-field--full edit-field--readonly">
        <label class="edit-field__label">
          ${esc(label)}
          <span class="edit-field__label-badge edit-field__label-badge--lock">🔒 ${esc(badge)}</span>
        </label>
        <input class="edit-field__input" type="text" value="${esc(value || "—")}" readonly />
      </div>`;

    const sections = [];
    let currentSection = null;
    let currentFields = [];

    const flushSection = () => {
      if (currentSection == null) return;
      sections.push(`
        <section class="edit-section">
          <div class="edit-section__title">${esc(currentSection)}</div>
          <div class="edit-grid">${currentFields.join("")}</div>
        </section>
      `);
      currentFields = [];
    };

    FIELD_SCHEMA.forEach((f) => {
      if (f.section) {
        flushSection();
        currentSection = f.section;
        return;
      }
      if (f.type === "file") {
        currentFields.push(renderFileField(reg, f));
        return;
      }
      currentFields.push(renderInputField(reg, f));
    });
    flushSection();

    // Section locked fields di paling atas (sebelum sections lain)
    const lockedSection = `
      <section class="edit-section">
        <div class="edit-section__title">Identitas Kunci (tidak bisa diedit)</div>
        <div class="edit-grid">
          ${lockedRow("Kode Pendaftaran", reg.kode, "Kunci")}
          ${lockedRow("Nomor Identitas (KTP/Paspor)", reg.nomorId, "Kunci")}
        </div>
      </section>`;

    el.modalBody.classList.add("modal__body--edit");
    el.modalBody.innerHTML = lockedSection + sections.join("");
    bindEditFormEvents();
  }

  function renderInputField(reg, f) {
    const value = state.editValues[f.key] ?? "";
    const fullCls = f.full ? " edit-field--full" : "";
    const hint = f.hint ? `<div class="edit-field__hint">${esc(f.hint)}</div>` : "";
    let input = "";

    if (f.type === "textarea") {
      input = `<textarea class="edit-field__textarea" data-edit-key="${esc(f.key)}" rows="3">${esc(value)}</textarea>`;
    } else if (f.type === "select") {
      const opts = f.options.map((o) =>
        `<option value="${esc(o)}"${o === value ? " selected" : ""}>${esc(o)}</option>`
      ).join("");
      input = `<select class="edit-field__select" data-edit-key="${esc(f.key)}">
        <option value="">— pilih —</option>
        ${opts}
      </select>`;
    } else {
      const attrs = [];
      if (f.min != null) attrs.push(`min="${f.min}"`);
      if (f.max != null) attrs.push(`max="${f.max}"`);
      input = `<input class="edit-field__input" type="${f.type || "text"}" data-edit-key="${esc(f.key)}" value="${esc(value)}" ${attrs.join(" ")} />`;
    }

    // Conditional show: tetap render tapi disembunyikan kalau tidak match
    const hidden = f.showIf && !f.showIf(state.editValues) ? ' style="display:none"' : "";

    return `
      <div class="edit-field${fullCls}" data-edit-wrap="${esc(f.key)}"${hidden}>
        <label class="edit-field__label">${esc(f.label)}</label>
        ${input}
        ${hint}
      </div>`;
  }

  function renderFileField(reg, f) {
    const fk = f.fieldKey;
    const meta = reg.berkas?.[fk];
    const has = meta && meta.url;
    const isImg = has && (/^image\//.test(meta.type || "") || /\.(jpe?g|png|webp)$/i.test(meta.name || ""));
    const badge = has ? (isImg ? (/(png)$/i.test(meta.name || meta.type || "") ? "PNG" : "JPG") : "PDF") : "";
    const current = !has
      ? `<span class="edit-file__none">Belum ada berkas terunggah</span>`
      : `<div class="edit-file__current">
          ${isImg
            ? `<img class="edit-file__thumb" src="${esc(meta.url)}" alt="" />`
            : `<span class="edit-file__icon">${esc(badge)}</span>`}
          <a href="${esc(meta.url)}" target="_blank" rel="noopener">${esc(meta.name || "berkas")}</a>
          <span style="margin-left:auto;font-size:11px;color:var(--ink-500)">${formatBytes(meta.size)}</span>
        </div>`;
    return `
      <div class="edit-field edit-field--full" data-edit-file-wrap="${esc(fk)}">
        <label class="edit-field__label">${esc(f.label)}</label>
        <div class="edit-file">
          ${current}
          <input type="file" class="edit-file__input" data-edit-file="${esc(fk)}"
                 accept=".pdf,application/pdf,.jpg,.jpeg,.png,image/jpeg,image/png" />
          <span class="edit-file__newfile" data-edit-file-newname="${esc(fk)}" hidden></span>
        </div>
      </div>`;
  }

  function bindEditFormEvents() {
    // Tracking perubahan input
    $$("[data-edit-key]", el.modalBody).forEach((inp) => {
      inp.addEventListener("input", () => {
        const k = inp.dataset.editKey;
        let v = inp.value;
        if (inp.type === "number") v = v === "" ? "" : Number(v);
        state.editValues[k] = v;

        // Re-evaluate conditional fields kalau key ini punya dependent
        if (k === "keluargaTransmigran") {
          ["namaOrangTua", "tahunPenempatan", "lokasiTransmigrasi"].forEach((dep) => {
            const wrap = el.modalBody.querySelector(`[data-edit-wrap="${dep}"]`);
            if (wrap) wrap.style.display = (v === "Iya" ? "" : "none");
          });
        }
      });
      inp.addEventListener("change", () => inp.dispatchEvent(new Event("input")));
    });

    // Tracking file replacement
    $$("[data-edit-file]", el.modalBody).forEach((inp) => {
      inp.addEventListener("change", (e) => {
        const fk = inp.dataset.editFile;
        const file = e.target.files[0];
        const newNameEl = el.modalBody.querySelector(`[data-edit-file-newname="${fk}"]`);
        if (!file) {
          delete state.editFiles[fk];
          if (newNameEl) { newNameEl.textContent = ""; newNameEl.hidden = true; }
          return;
        }
        // Validasi sederhana: ukuran < 15 MB
        if (file.size > 15 * 1024 * 1024) {
          alert(`File "${file.name}" terlalu besar (>15 MB). Gunakan file < 15 MB.`);
          inp.value = "";
          delete state.editFiles[fk];
          if (newNameEl) { newNameEl.textContent = ""; newNameEl.hidden = true; }
          return;
        }
        state.editFiles[fk] = file;
        if (newNameEl) {
          newNameEl.textContent = `✓ Berkas baru: ${file.name} (${formatBytes(file.size)}) — akan diunggah saat Simpan`;
          newNameEl.hidden = false;
        }
      });
    });
  }

  function setEditMode(on) {
    state.editing = !!on;
    el.modalFootView.hidden = on;
    el.modalFootEdit.hidden = !on;
    el.modal.classList.toggle("modal--editing", on);

    if (!on) {
      el.modalBody.classList.remove("modal__body--edit");
      // Re-render view dari data terkini
      const reg = state.all.find((r) => r.id === state.activeId);
      if (reg) renderViewMode(reg);
    }
  }

  // Re-render view mode (extract bagian rendering body dari openDetail
  // agar bisa dipakai ulang setelah save)
  function renderViewMode(reg) {
    // Build & inject body lagi (sama dengan openDetail body), lalu sertakan audit log
    el.modalKode.textContent = reg.kode || "—";
    el.modalStatus.className = "status-pill is-" + reg.status;
    el.modalStatus.textContent = STATUS_LABEL[reg.status] || reg.status;

    const row = (label, value, full = false) => `
      <div class="modal__row ${full ? 'modal__row--full' : ''}">
        <div class="modal__label">${esc(label)}</div>
        <div class="modal__value ${value ? '' : 'modal__value--muted'}">${esc(value || '—')}</div>
      </div>`;
    const rowHTML = (label, html, full = false) => `
      <div class="modal__row ${full ? 'modal__row--full' : ''}">
        <div class="modal__label">${esc(label)}</div>
        <div class="modal__value">${html}</div>
      </div>`;
    const section = (title) => `<div class="modal__section-title">${esc(title)}</div>`;
    const ptAsal = resolveOther(reg.ptAsal, reg.ptAsalOther);
    const ukuranKemeja = resolveOther(reg.ukuranKemeja, reg.ukuranKemejaOther);
    const ukuranCelana = resolveOther(reg.ukuranCelana, reg.ukuranCelanaOther);
    const ukuranRompi = resolveOther(reg.ukuranRompi, reg.ukuranRompiOther);
    const ukuranJaket = resolveOther(reg.ukuranJaket, reg.ukuranJaketOther);

    // Banner alasan penolakan kalau status = rejected
    const rejectBanner = (reg.status === "rejected" && reg.rejectionReason)
      ? `<div class="rejection-banner">
          <div class="rejection-banner__head">
            <span class="rejection-banner__title">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6"/><path d="m9 9 6 6"/></svg>
              Pendaftaran Ditolak
            </span>
            <span class="rejection-banner__meta">
              ${reg.rejectedBy ? `oleh ${esc(reg.rejectedBy)} ` : ""}${reg.rejectedAt ? `pada ${fmtDateTimeWIB(reg.rejectedAt)}` : ""}
            </span>
          </div>
          <div class="rejection-banner__reason">${esc(reg.rejectionReason)}</div>
        </div>`
      : "";

    el.modalBody.innerHTML = [
      rejectBanner,
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
      section("Kontak"),
      row("Email", reg.email),
      row("Email Aktif", reg.emailAktif),
      row("WhatsApp", reg.whatsapp),
      section("Akademik"),
      row("Perguruan Tinggi Mitra (Induk)", reg.ptMitra, true),
      row("Perguruan Tinggi Asal", ptAsal, true),
      row("Jenjang", reg.jenjang),
      row("Status Pendidikan", reg.statusPendidikan),
      row("Program Studi", reg.prodiPT),
      section("Posisi yang Dilamar"),
      row("Posisi", reg.posisi, true),
      row("Masa Waktu Kegiatan", reg.masaWaktuKegiatan),
      section("Pengalaman & Portofolio"),
      rowHTML("Pengalaman / Karya Ilmiah", longText(reg.pengalamanKarya), true),
      rowHTML("Pengalaman Tim", longText(reg.pengalamanTim), true),
      section("Ukuran Seragam & Biometrik"),
      row("Ukuran Kemeja", ukuranKemeja),
      row("Ukuran Celana", ukuranCelana),
      row("Ukuran Rompi", ukuranRompi),
      row("Ukuran Jaket", ukuranJaket),
      row("Tinggi Badan (cm)", reg.tinggiBadan),
      row("Berat Badan (kg)", reg.beratBadan),
      row("Golongan Darah", reg.golonganDarah),
      section("Kontak Darurat"),
      row("Nama", reg.namaDarurat),
      row("Hubungan", reg.hubunganDarurat),
      row("Telepon", reg.teleponDarurat),
      row("Alamat", reg.alamatDarurat, true),
      section("Persetujuan"),
      row("Pernyataan kebenaran data", reg.pernyataanBenar || "—"),
      row("Persetujuan kegiatan", reg.persetujuanKegiatan || "—"),
      section("Metadata Pendaftaran"),
      row("Kode Pendaftaran", reg.kode),
      row("Tanggal Daftar", formatDate(reg.submittedAt)),
      row("Status", STATUS_LABEL[reg.status] || reg.status),
      row("Tanggal Verifikasi", reg.verifiedAt ? formatDate(reg.verifiedAt) : null),
      row("Diverifikasi oleh", reg.verifiedBy),
      reg.status === "rejected" ? row("Alasan Penolakan", reg.rejectionReason || "—", true) : "",
      reg.status === "rejected" && reg.rejectedAt ? row("Tanggal Ditolak", formatDate(reg.rejectedAt)) : "",
      reg.status === "rejected" && reg.rejectedBy ? row("Ditolak oleh", reg.rejectedBy) : "",
      renderBerkas(reg.berkas),
      renderAuditLogSection(),
    ].join("");
  }

  /* ---------- AUDIT LOG: subscribe + render ---------- */

  function subscribeAuditLogs(registrationId) {
    if (state.auditUnsub) { state.auditUnsub(); state.auditUnsub = null; }
    try {
      const q = query(
        collection(db, EDIT_LOGS),
        where("registrationId", "==", registrationId),
        orderBy("changedAt", "desc"),
        limit(20),
      );
      state.auditUnsub = onSnapshot(q, (snap) => {
        state.editLogs = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        // Hanya re-render section log kalau modal sedang view mode
        if (!state.editing) {
          const cont = el.modalBody.querySelector(".audit-log");
          if (cont) cont.outerHTML = renderAuditLogSection();
        }
      }, (err) => {
        // Index belum dibangun? Tampilkan pesan ramah, jangan crash.
        console.warn("[auditLogs] subscribe gagal:", err);
        state.editLogs = [];
      });
    } catch (err) {
      console.warn("[auditLogs] error:", err);
    }
  }

  function renderAuditLogSection() {
    if (!state.editLogs.length) {
      return `
        <div class="audit-log">
          <div class="audit-log__title">Riwayat Edit</div>
          <div class="audit-log__empty">Belum ada perubahan tercatat untuk pendaftar ini.</div>
        </div>`;
    }
    const items = state.editLogs.map((log) => {
      const action = log.action || "edit";
      const icon = action === "delete" ? "🗑️"
                 : action === "verify" ? "✓"
                 : action === "reject" ? "✗"
                 : "✏️";
      const head = `
        <div class="audit-entry__head">
          <span><strong>${icon} ${esc(actionLabel(action))}</strong>
            &middot; <span class="audit-entry__by">${esc(log.changedByName || log.changedBy || "—")}</span>
          </span>
          <span>${fmtDateTimeWIB(log.changedAt) || "—"}</span>
        </div>`;
      let body = "";
      if (action === "edit" && Array.isArray(log.changes)) {
        body = `<div class="audit-entry__changes">${log.changes.map((c) => `
          <div class="audit-entry__change">
            <span class="audit-entry__change-field">${esc(c.label || c.field)}:</span>
            <span class="audit-entry__diff-old">${esc(formatLogValue(c.oldValue))}</span>
            →
            <span class="audit-entry__diff-new">${esc(formatLogValue(c.newValue))}</span>
          </div>`).join("")}</div>`;
      } else if (action === "delete") {
        body = `<div class="audit-entry__change">Pendaftar <strong>${esc(log.registrationName || "")}</strong> dihapus permanen${
          Array.isArray(log.deletedFiles) && log.deletedFiles.length
            ? ` &middot; ${log.deletedFiles.length} file di Storage ikut dihapus`
            : ""
        }.</div>`;
      }
      return `<div class="audit-entry audit-entry--${esc(action)}">${head}${body}</div>`;
    }).join("");
    return `
      <div class="audit-log">
        <div class="audit-log__title">Riwayat Edit (${state.editLogs.length})</div>
        <div class="audit-log__list">${items}</div>
      </div>`;
  }

  function actionLabel(a) {
    return ({ edit: "Edit Data", delete: "Hapus Pendaftar", verify: "Verifikasi", reject: "Tolak" })[a] || a;
  }
  function formatLogValue(v) {
    if (v == null || v === "") return "(kosong)";
    if (typeof v === "object") {
      try { return JSON.stringify(v).slice(0, 80); } catch (_) { return "(kompleks)"; }
    }
    const s = String(v);
    return s.length > 120 ? s.slice(0, 120) + "…" : s;
  }

  /* ---------- SAVE EDIT ---------- */

  async function saveEdit() {
    if (!state.activeId) return;
    const reg = state.all.find((r) => r.id === state.activeId);
    if (!reg) return;

    // Hitung perubahan field non-file
    const changes = [];
    const updates = {};
    Object.entries(state.editValues).forEach(([k, newVal]) => {
      const oldVal = reg[k] ?? "";
      // Normalisasi: number kosong = null, string kosong tetap ""
      let nv = newVal;
      if (nv === "" && (typeof oldVal === "number")) nv = null;
      if (nv !== oldVal && !(nv === "" && (oldVal == null || oldVal === ""))) {
        const f = FIELD_SCHEMA.find((s) => s.key === k);
        changes.push({ field: k, label: f?.label || k, oldValue: oldVal, newValue: nv });
        updates[k] = nv;
      }
    });

    const fileKeys = Object.keys(state.editFiles);
    if (!changes.length && !fileKeys.length) {
      alert("Tidak ada perubahan untuk disimpan.");
      return;
    }

    el.editSave.disabled = true;
    el.editSave.innerHTML = `<span class="spinner"></span>Menyimpan…`;

    try {
      // 1. Upload file pengganti (kalau ada)
      const newBerkas = { ...(reg.berkas || {}) };
      for (const fk of fileKeys) {
        const file = state.editFiles[fk];
        const oldMeta = reg.berkas?.[fk];
        const newMeta = await replaceRegistrationFile(state.activeId, fk, file);
        newBerkas[fk] = newMeta;
        const fLabel = FIELD_SCHEMA.find((s) => s.fieldKey === fk)?.label || fk;
        changes.push({
          field: `berkas.${fk}`,
          label: `Berkas: ${fLabel}`,
          oldValue: oldMeta ? `${oldMeta.name || "berkas lama"} (${formatBytes(oldMeta.size)})` : "(kosong)",
          newValue: `${file.name} (${formatBytes(file.size)})`,
        });
      }
      if (fileKeys.length) updates.berkas = newBerkas;

      // 2. Tambahkan metadata informational ke audit log
      updates._kodeForLog = reg.kode;
      updates._namaForLog = reg.namaLengkap;
      // Hapus field marker dari payload yang akan ditulis ke Firestore
      const writeUpdates = { ...updates };
      delete writeUpdates._kodeForLog;
      delete writeUpdates._namaForLog;

      await updateRegistrationFields(state.activeId, writeUpdates, changes, auth.currentUser);

      el.editSave.disabled = false;
      el.editSave.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>Simpan Perubahan`;

      setEditMode(false);
      // (onSnapshot akan refresh data, view akan ter-render ulang dengan data baru)
    } catch (err) {
      console.error("[edit] gagal simpan:", err);
      alert(`Gagal menyimpan perubahan.\n\n${err?.code || ""}\n${err?.message || err}`);
      el.editSave.disabled = false;
      el.editSave.innerHTML = `Simpan Perubahan`;
    }
  }

  /* ---------- DELETE ---------- */

  function openDeleteDialog() {
    if (!state.activeId) return;
    const reg = state.all.find((r) => r.id === state.activeId);
    if (!reg) return;
    el.deleteDialogTitle.textContent = `Hapus pendaftar: ${reg.namaLengkap || reg.kode}?`;
    el.deletePreview.innerHTML = `
      <strong>${esc(reg.namaLengkap || "—")}</strong>
      <small>Kode ${esc(reg.kode || "—")} &middot; ${esc(reg.nomorId || "—")}</small>
      <small>${esc(reg.email || reg.emailAktif || "—")} &middot; ${esc(reg.posisi || "—")}</small>`;
    el.deleteAlsoFiles.checked = true;
    el.deleteDialog.hidden = false;
    el.deleteDialog.setAttribute("aria-hidden", "false");
  }
  function closeDeleteDialog() {
    el.deleteDialog.hidden = true;
    el.deleteDialog.setAttribute("aria-hidden", "true");
  }

  async function confirmDelete() {
    if (!state.activeId) return;
    const reg = state.all.find((r) => r.id === state.activeId);
    if (!reg) return;
    el.deleteConfirm.disabled = true;
    el.deleteConfirm.innerHTML = `<span class="spinner"></span>Menghapus…`;
    try {
      await svcDeleteRegistration(state.activeId, reg, auth.currentUser, el.deleteAlsoFiles.checked);
      closeDeleteDialog();
      closeDetail();
    } catch (err) {
      console.error("[delete] gagal:", err);
      alert(`Gagal menghapus pendaftar.\n\n${err?.code || ""}\n${err?.message || err}`);
      el.deleteConfirm.disabled = false;
      el.deleteConfirm.innerHTML = `Ya, Hapus Permanen`;
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
    ["rejectionReason", "Alasan Penolakan"],
    ["rejectedAt", "Tanggal Ditolak"],
    ["rejectedBy", "Ditolak oleh"],
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
    suratSakit: "Surat Tidak Pernah Sakit Berat-Kronis",
    suratIzinOrtu: "Surat Izin Orang Tua",
  };

  // Field yang tidak boleh ikut diekspor dari extras (internal atau
  // sudah dipecah terpisah).
  const CSV_SKIP_KEYS = new Set(["berkas"]);

  // Format nilai untuk dimasukkan ke CSV.
  function csvFormatValue(v) {
    if (v == null) return "";
    if (v instanceof Date) return fmtDateTimeWIB(v);
    if (typeof v === "string") {
      // Kalau sudah ISO date, ubah ke format WIB yang enak dibaca.
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
        try {
          const d = new Date(v);
          return d.toLocaleString("id-ID", {
            day: "2-digit", month: "2-digit", year: "numeric",
            hour: "2-digit", minute: "2-digit", second: "2-digit",
            timeZone: WIB_TZ,
          }) + " WIB";
        } catch (_) { return v; }
      }
      return v;
    }
    if (typeof v === "boolean" || typeof v === "number") return String(v);
    if (Array.isArray(v)) return v.map(csvFormatValue).join(" | ");
    if (typeof v === "object") {
      // Timestamp Firestore yang belum sempat di-ISO-kan
      if (typeof v.toDate === "function") {
        try { return fmtDateTimeWIB(v.toDate()); } catch (_) {}
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
    // Pakai WIB sehingga nama file mencerminkan jam admin di Indonesia
    // (mis. "tep-2026-pendaftar-2026-05-01-1942-wib.csv").
    const d = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: WIB_TZ,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value || "";
    return `${get("year")}-${get("month")}-${get("day")}-${get("hour")}${get("minute")}-wib`;
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
      ["Tanggal Ekspor", fmtDateTimeWIB(new Date())],
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
  el.modalReject.addEventListener("click", () => openRejectDialog());

  // === Reject dialog ===
  el.rejectDialog?.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-reject]")) closeRejectDialog();
  });
  el.rejectReason?.addEventListener("input", (e) => {
    const len = e.target.value.length;
    el.rejectCharCount.textContent = String(len);
    el.rejectConfirm.disabled = e.target.value.trim().length === 0;
  });
  el.rejectPresets?.querySelectorAll(".reject-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      el.rejectPresets.querySelectorAll(".reject-preset").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      el.rejectReason.value = btn.dataset.preset || "";
      el.rejectReason.dispatchEvent(new Event("input"));
      el.rejectReason.focus();
    });
  });
  el.rejectConfirm?.addEventListener("click", () => confirmReject());
  document.addEventListener("keydown", (e) => {
    if (!el.rejectDialog?.hidden && e.key === "Escape") closeRejectDialog();
    if (!el.rejectDialog?.hidden && (e.metaKey || e.ctrlKey) && e.key === "Enter") {
      if (!el.rejectConfirm.disabled) confirmReject();
    }
  });

  // === Edit mode ===
  el.modalEdit?.addEventListener("click", () => {
    if (!state.activeId) return;
    const reg = state.all.find((r) => r.id === state.activeId);
    if (!reg) return;
    setEditMode(true);
    renderEditForm(reg);
  });
  el.editCancel?.addEventListener("click", () => {
    if (Object.keys(state.editValues).length || Object.keys(state.editFiles).length) {
      if (!confirm("Batalkan edit? Perubahan yang sudah dibuat tidak akan disimpan.")) return;
    }
    state.editValues = {};
    state.editFiles = {};
    setEditMode(false);
  });
  el.editSave?.addEventListener("click", () => saveEdit());

  // === Delete ===
  el.modalDelete?.addEventListener("click", () => openDeleteDialog());
  el.deleteDialog?.addEventListener("click", (e) => {
    if (e.target.closest("[data-close-delete]")) closeDeleteDialog();
  });
  el.deleteConfirm?.addEventListener("click", () => confirmDelete());
  document.addEventListener("keydown", (e) => {
    if (!el.deleteDialog?.hidden && e.key === "Escape") closeDeleteDialog();
  });

  // Nav items: switch view antara Ringkasan Eksekutif <-> Pendaftaran
  function switchView(view) {
    if (!el.viewOverview || !el.viewRegistrations) return;
    if (view === "registrations") {
      el.viewOverview.hidden = true;
      el.viewRegistrations.hidden = false;
    } else if (view === "overview") {
      el.viewOverview.hidden = false;
      el.viewRegistrations.hidden = true;
      // Render ulang chart begitu view aktif (canvas baru terlihat → ukuran benar)
      requestAnimationFrame(() => renderOverview());
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  $$(".dash-nav__item").forEach((b) => {
    b.addEventListener("click", () => {
      $$(".dash-nav__item").forEach((x) => x.classList.remove("is-active"));
      b.classList.add("is-active");
      const view = b.dataset.view;
      if (view === "export") {
        // Buka menu ekspor di view tabel
        switchView("registrations");
        setTimeout(() => {
          setExportMenuOpen(true);
          el.exportBtn?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 60);
        return;
      }
      switchView(view);
    });
  });

  // Tombol Cetak / Simpan PDF
  el.execPrintBtn?.addEventListener("click", () => {
    if (el.execPrintedAt) {
      el.execPrintedAt.textContent = fmtLongDateTimeWIB(new Date());
    }
    // Beri jeda agar repaint sebelum print dialog
    setTimeout(() => window.print(), 80);
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
