/**
 * Firebase Services (shared module)
 * Diimpor oleh script.js dan dashboard.js.
 *
 * Dipakai lewat CDN modular (Firebase v10 ES modules), jadi tidak
 * butuh bundler. Pastikan halaman HTML memuat script ini dengan
 * `type="module"`.
 */

import { initializeApp }
  from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getFirestore, collection, doc, setDoc, getDoc, getDocs,
  updateDoc, deleteDoc, query, where, orderBy, onSnapshot,
  serverTimestamp, Timestamp
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, uploadBytesResumable,
  getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-storage.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut,
  onAuthStateChanged, setPersistence, browserLocalPersistence
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

/* =============== Konfigurasi =============== */
const firebaseConfig = {
  apiKey: "AIzaSyDc2XXc2Nn6P12BZA0c8AEvaYtyZIvomJw",
  authDomain: "formulirtep.firebaseapp.com",
  projectId: "formulirtep",
  storageBucket: "formulirtep.firebasestorage.app",
  messagingSenderId: "812883503975",
  appId: "1:812883503975:web:e06d96d700a34bb8cb5dc2",
  measurementId: "G-LGKDXQMFQ6",
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const storage = getStorage(app);
export const auth = getAuth(app);
setPersistence(auth, browserLocalPersistence).catch(() => {});

/* =============== Re-export SDK functions =============== */
export {
  collection, doc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  query, where, orderBy, onSnapshot, serverTimestamp, Timestamp,
  ref, uploadBytes, uploadBytesResumable, getDownloadURL, deleteObject,
  GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
};

/* =============== Nama koleksi (konstanta) =============== */
export const REGISTRATIONS = "registrations";
export const ADMINS = "admins";
export const UPLOADS_PREFIX = "uploads";

/* =============== Helper: status admin =============== */
/**
 * Cek apakah user saat ini adalah admin.
 * Admin didefinisikan oleh dokumen di koleksi `admins/{email}`.
 * @param {import("firebase/auth").User|null} user
 */
export async function isAdmin(user) {
  if (!user || !user.email) return false;
  try {
    const snap = await getDoc(doc(db, ADMINS, user.email));
    return snap.exists();
  } catch (_) { return false; }
}

/* =============== Helper: cek duplikat nomor identitas =============== */
/**
 * Kembalikan true jika nomor identitas sudah terdaftar.
 * Nomor identitas yang sudah dinormalisasi dipakai sebagai doc ID,
 * sehingga pengecekan cukup via getDoc (1 read saja).
 */
export async function isDuplicateNomorId(normalizedId) {
  if (!normalizedId) return false;
  try {
    const snap = await getDoc(doc(db, REGISTRATIONS, normalizedId));
    return snap.exists();
  } catch (_) { return false; }
}

/* =============== Helper: upload berkas PDF =============== */
/**
 * Upload sebuah File ke path `uploads/{docId}/{field}.pdf` dan
 * kembalikan URL download + metadata.
 */
const EXT_TO_MIME = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

const MIME_TO_EXT = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
};

/**
 * Deteksi tipe file dari magic bytes (4–12 byte awal). Dipakai
 * untuk normalisasi content-type karena browser seringkali mengirim
 * varian aneh (image/jpg, application/x-pdf, kosong, dsb) atau
 * bahkan bohong (docx di-rename menjadi .pdf).
 *
 * Return: MIME string standar, atau null kalau tidak dikenali.
 */
export async function detectMimeFromMagic(file) {
  try {
    const buf = await file.slice(0, 16).arrayBuffer();
    const b = new Uint8Array(buf);
    if (b.length < 4) return null;
    // PDF: "%PDF-"
    if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
    // JPEG: FF D8 FF
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return "image/jpeg";
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return "image/png";
    // WEBP: "RIFF"....(size)...."WEBP"
    if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
        && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      return "image/webp";
    }
    // HEIC/HEIF: bytes 4..7 = "ftyp", 8..11 = brand
    if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
      const brand = String.fromCharCode(b[8], b[9], b[10], b[11]).toLowerCase();
      if (["heic", "heix", "mif1", "msf1", "heif", "hevc", "hevx", "hevm", "hevs"].includes(brand)) {
        return "image/heic";
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

export async function uploadRegistrationFile(docId, field, file, onProgress) {
  // 1) Deteksi content-type dari magic bytes (paling reliable).
  // 2) Fallback ke ekstensi file.
  // 3) Fallback terakhir ke file.type.
  const detected = await detectMimeFromMagic(file);
  const rawExt = (file.name.split(".").pop() || "").toLowerCase();
  const contentType = detected || EXT_TO_MIME[rawExt] || file.type || "application/octet-stream";
  const ext = MIME_TO_EXT[contentType] || (EXT_TO_MIME[rawExt] ? rawExt : "bin");
  const safePath = `${UPLOADS_PREFIX}/${docId}/${field}.${ext}`;
  const fileRef = ref(storage, safePath);
  if (onProgress) {
    const task = uploadBytesResumable(fileRef, file, { contentType });
    await new Promise((resolve, reject) => {
      task.on("state_changed",
        (snap) => onProgress((snap.bytesTransferred / snap.totalBytes) * 100),
        reject,
        resolve,
      );
    });
  } else {
    await uploadBytes(fileRef, file, { contentType });
  }
  const url = await getDownloadURL(fileRef);
  return { path: safePath, url, name: file.name, size: file.size, type: contentType };
}

/* =============== Helper: simpan pendaftaran =============== */
/**
 * Simpan satu dokumen pendaftaran dengan doc ID = normalized nomorId.
 * Gagal kalau sudah ada (merge:false + rule exists check).
 */
export async function createRegistration(docId, payload) {
  const registration = {
    ...payload,
    status: "pending",
    submittedAt: serverTimestamp(),
    verifiedAt: null,
    verifiedBy: null,
  };
  await setDoc(doc(db, REGISTRATIONS, docId), registration);
  return docId;
}
