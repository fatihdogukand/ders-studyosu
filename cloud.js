import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  collection,
  setDoc,
  deleteDoc,
  writeBatch,
  onSnapshot,
  enableIndexedDbPersistence
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCNEL-GtoKv_0QX-6l7JWyE9WH0KjCE0tY",
  authDomain: "ders-studyosu.firebaseapp.com",
  projectId: "ders-studyosu",
  storageBucket: "ders-studyosu.firebasestorage.app",
  messagingSenderId: "868020492973",
  appId: "1:868020492973:web:2f080ca4be4ab38b258424",
  measurementId: "G-578FSXW1NM"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const dbCloud = getFirestore(app);
enableIndexedDbPersistence(dbCloud).catch(() => {});

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/drive.file');

let currentUser = null;
let driveToken = sessionStorage.getItem('drive_token') || null;
let unsubDataCol = null;
let isApplyingRemote = false;
let syncDebounceTimer = null;
let isMigratingLegacy = false;
let hasInitialServerSnapshot = false;

const lastSyncedNoteHashes = new Map();
let lastSyncedMetaHash = '';

function isSeedWelcomeNote(note) {
  if (!note) return false;
  if (note.isWelcomeSeed) return true;
  return note.title === 'Sohbet Okulu · Ders Çalışma Stüdyosu'
    && Array.isArray(note.blocks)
    && note.blocks.length === 1
    && note.blocks[0]?.id === 'blk_1';
}

function isSeedOnlyDb(database) {
  const notes = Array.isArray(database?.notes) ? database.notes : [];
  return notes.length === 0 || (notes.length === 1 && isSeedWelcomeNote(notes[0]));
}

getRedirectResult(auth).then((res) => {
  const cred = res ? GoogleAuthProvider.credentialFromResult(res) : null;
  if (cred?.accessToken) {
    driveToken = cred.accessToken;
    sessionStorage.setItem('drive_token', driveToken);
  }
}).catch(() => {});

function fastHash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36) + '_' + str.length;
}

async function loginWithGoogle() {
  try {
    const res = await signInWithPopup(auth, provider);
    const cred = GoogleAuthProvider.credentialFromResult(res);
    if (cred?.accessToken) {
      driveToken = cred.accessToken;
      sessionStorage.setItem('drive_token', driveToken);
    }
  } catch (e) {
    const code = e?.code || '';
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      try {
        await signInWithRedirect(auth, provider);
        return;
      } catch (re) {
        alert('Yönlendirme giriş hatası: ' + re.message);
        return;
      }
    }
    alert('Giriş hatası: ' + e.message);
  }
}

async function logoutGoogle() {
  if (!confirm('Çıkış yapılsın mı?')) return;
  await signOut(auth);
  sessionStorage.removeItem('drive_token');
}

window.loginWithGoogle = loginWithGoogle;
window.signInWithGoogle = loginWithGoogle;
window.logoutGoogle = logoutGoogle;
window.signOutGoogle = logoutGoogle;

function buildMetaPayload(localDb) {
  return {
    version: localDb.version || '4.5.0',
    folders: Array.isArray(localDb.folders) ? localDb.folders : [],
    activeNoteId: localDb.activeNoteId || null,
    settings: localDb.settings || {},
    noteIds: (localDb.notes || []).map(n => n.id),
    updatedAt: localDb.updatedAt || Date.now()
  };
}

async function migrateLegacyMainToPerNote(uid, legacyData) {
  if (isMigratingLegacy || !legacyData || !Array.isArray(legacyData.notes)) return;
  isMigratingLegacy = true;
  try {
    const dataCol = collection(dbCloud, 'users', uid, 'data');
    const batch = writeBatch(dbCloud);
    const metaPayload = buildMetaPayload(legacyData);
    batch.set(doc(dataCol, 'meta'), metaPayload);

    for (const note of legacyData.notes) {
      if (!note || !note.id) continue;
      const cleanNote = JSON.parse(JSON.stringify(note));
      batch.set(doc(dataCol, 'note_' + cleanNote.id), cleanNote);
      lastSyncedNoteHashes.set(cleanNote.id, fastHash(JSON.stringify(cleanNote)));
    }
    await batch.commit();
    lastSyncedMetaHash = fastHash(JSON.stringify(metaPayload));
    console.info(`Sohbet Okulu: ${legacyData.notes.length} not tekil bulut belgelerine aktarıldı (1 GB kapasite aktif).`);
  } catch (err) {
    console.warn('Bulut geçişi sırasında hata:', err);
  } finally {
    isMigratingLegacy = false;
  }
}

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (unsubDataCol) { unsubDataCol(); unsubDataCol = null; }
  lastSyncedNoteHashes.clear();
  lastSyncedMetaHash = '';
  hasInitialServerSnapshot = false;

  window.setAuthUserUI?.(user);

  if (!user) return;

  const dataCol = collection(dbCloud, 'users', user.uid, 'data');

  unsubDataCol = onSnapshot(dataCol, { includeMetadataChanges: true }, async (querySnap) => {
    // Yerel IndexedDB yüklemesi bitmeden bulut birleştirmesi yapma (yarış durumu önlemi)
    if (typeof window.waitForAppDbReady === 'function') {
      await window.waitForAppDbReady();
    }

    const fromCache = Boolean(querySnap.metadata?.fromCache);

    if (querySnap.empty) {
      // Önbellekten boş gelmişse sunucu cevabını bekle; yeni cihazın boş karşılama notunu asla buluta yazma!
      if (fromCache) return;
      hasInitialServerSnapshot = true;
      const local = window.getAppDb?.();
      if (local && !isSeedOnlyDb(local)) {
        await window.syncToCloud?.(local, { immediate: true });
      } else {
        window.onCloudSyncStatus?.({
          type: 'info',
          message: 'Bu Google hesabında henüz bulut notu yok. PC veya diğer cihazınızdan Google ile giriş yapıp eşitleyin.'
        });
      }
      return;
    }

    let metaDoc = null;
    let legacyMainDoc = null;
    const remoteNotesMap = new Map();

    querySnap.forEach((docSnap) => {
      const id = docSnap.id;
      const data = docSnap.data();
      if (id === 'meta') {
        metaDoc = data;
      } else if (id === 'main') {
        legacyMainDoc = data;
      } else if (id.startsWith('note_') && data && data.id) {
        remoteNotesMap.set(data.id, data);
        lastSyncedNoteHashes.set(data.id, fastHash(JSON.stringify(data)));
      }
    });

    if (!fromCache) {
      hasInitialServerSnapshot = true;
    }

    // İlk kez v4.5.0+ yapısına geçiliyorsa eski tek parça 'main' belgesini otomatik olarak not bazlı belgelere böl
    if (!metaDoc && legacyMainDoc && Array.isArray(legacyMainDoc.notes)) {
      const local = window.getAppDb?.() || {};
      const preferRemote = isSeedOnlyDb(local) || (legacyMainDoc.updatedAt || 0) >= (local.updatedAt || 0);
      const sourceDb = preferRemote ? legacyMainDoc : local;
      isApplyingRemote = true;
      window.setAppDb?.(sourceDb);
      isApplyingRemote = false;
      if (!fromCache) {
        await migrateLegacyMainToPerNote(user.uid, sourceDb);
      }
      checkDailyDriveBackup(sourceDb);
      return;
    }

    if (metaDoc) {
      lastSyncedMetaHash = fastHash(JSON.stringify(metaDoc));
    }

    const local = window.getAppDb?.() || { folders: [], notes: [], settings: {} };
    const localWasSeedOnly = isSeedOnlyDb(local);
    const localNotesMap = new Map((local.notes || []).map(n => [n.id, n]));
    let changed = false;

    // Bulutta gerçek notlar varsa yeni cihazda oluşan geçici karşılama notunu temizle
    const remoteHasRealNotes = [...remoteNotesMap.values()].some(n => !isSeedWelcomeNote(n));
    if (remoteHasRealNotes) {
      for (const [lid, ln] of [...localNotesMap.entries()]) {
        if (isSeedWelcomeNote(ln) && !remoteNotesMap.has(lid)) {
          localNotesMap.delete(lid);
          changed = true;
        }
      }
    }

    // 1. Uzaktan gelen yeni veya güncellenmiş notları birleştir
    for (const [noteId, rNote] of remoteNotesMap.entries()) {
      const lNote = localNotesMap.get(noteId);
      if (!lNote || (rNote.updatedAt || 0) > (lNote.updatedAt || 0)) {
        localNotesMap.set(noteId, rNote);
        changed = true;
      }
    }

    // 2. Uzakta silinmiş notları yerelden de temizle (boş/karşılama bulutu ise asla yerel gerçek notu silme!)
    if (metaDoc && Array.isArray(metaDoc.noteIds) && remoteHasRealNotes && (metaDoc.updatedAt || 0) > (local.updatedAt || 0)) {
      const validIds = new Set(metaDoc.noteIds);
      for (const localId of [...localNotesMap.keys()]) {
        const lNote = localNotesMap.get(localId);
        const lTime = lNote?.updatedAt || lNote?.createdAt || 0;
        if (!validIds.has(localId) && lTime <= (metaDoc.updatedAt || 0)) {
          localNotesMap.delete(localId);
          changed = true;
        }
      }
    }

    // 3. Klasör ve ayar güncellemelerini uygula
    const mergedDb = { ...local };
    const shouldApplyMeta = metaDoc && (localWasSeedOnly || (metaDoc.updatedAt || 0) > (local.updatedAt || 0));
    if (shouldApplyMeta) {
      if (Array.isArray(metaDoc.folders) && metaDoc.folders.length) mergedDb.folders = metaDoc.folders;
      if (metaDoc.settings) mergedDb.settings = { ...local.settings, ...metaDoc.settings };
      if (metaDoc.activeNoteId && localNotesMap.has(metaDoc.activeNoteId)) mergedDb.activeNoteId = metaDoc.activeNoteId;
      mergedDb.updatedAt = metaDoc.updatedAt || Date.now();
      changed = true;
    }

    if (changed) {
      const orderedNotes = [];
      const seen = new Set();
      if (metaDoc && Array.isArray(metaDoc.noteIds)) {
        for (const id of metaDoc.noteIds) {
          if (localNotesMap.has(id)) {
            orderedNotes.push(localNotesMap.get(id));
            seen.add(id);
          }
        }
      }
      for (const [id, n] of localNotesMap.entries()) {
        if (!seen.has(id)) orderedNotes.push(n);
      }
      mergedDb.notes = orderedNotes;

      isApplyingRemote = true;
      window.setAppDb?.(mergedDb);
      isApplyingRemote = false;
    }

    checkDailyDriveBackup(window.getAppDb?.() || mergedDb);
  });
});

async function flushCloudSync(localDb) {
  if (!currentUser || isApplyingRemote || !localDb || !hasInitialServerSnapshot) return;
  if (lastSyncedNoteHashes.size === 0 && isSeedOnlyDb(localDb)) return;
  try {
    const dataCol = collection(dbCloud, 'users', currentUser.uid, 'data');
    const currentNoteIds = new Set();

    // Yalnızca değişen veya yeni eklenen notları buluta gönder (Delta Sync)
    for (const note of (localDb.notes || [])) {
      if (!note || !note.id) continue;
      currentNoteIds.add(note.id);
      const cleanNote = JSON.parse(JSON.stringify(note));
      const serializedNote = JSON.stringify(cleanNote);
      const noteBytes = new Blob([serializedNote]).size;

      if (noteBytes > 980 * 1024) {
        const warnMsg = `"${note.title || 'Adsız Not'}" notu 1 MB Firestore belge sınırına ulaştı (${Math.round(noteBytes / 1024)} KB) ve buluta gönderilemedi.`;
        console.warn(warnMsg);
        window.onCloudSyncStatus?.({ type: 'warn', message: warnMsg });
        continue;
      }

      const h = fastHash(serializedNote);
      if (lastSyncedNoteHashes.get(note.id) !== h) {
        await setDoc(doc(dataCol, 'note_' + note.id), cleanNote);
        lastSyncedNoteHashes.set(note.id, h);
      }
    }

    // Silinen notları buluttan kaldır
    for (const prevId of [...lastSyncedNoteHashes.keys()]) {
      if (!currentNoteIds.has(prevId)) {
        await deleteDoc(doc(dataCol, 'note_' + prevId));
        lastSyncedNoteHashes.delete(prevId);
      }
    }

    // Hafif üst veriyi (klasörler, ayarlar, not sırası) güncelle
    localDb.updatedAt = Date.now();
    const metaPayload = buildMetaPayload(localDb);
    const metaHash = fastHash(JSON.stringify(metaPayload));
    if (lastSyncedMetaHash !== metaHash) {
      await setDoc(doc(dataCol, 'meta'), metaPayload);
      lastSyncedMetaHash = metaHash;
    }
  } catch (e) {
    console.warn('Offline kuyruğunda bekliyor:', e);
  }
}

window.syncToCloud = (localDb, opts = {}) => {
  if (!currentUser || isApplyingRemote || !localDb || !hasInitialServerSnapshot) return;
  if (opts && opts.immediate) {
    if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
    return flushCloudSync(localDb);
  }
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => flushCloudSync(localDb), 650);
};

async function checkDailyDriveBackup(data) {
  if (!driveToken || !data) return;
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem('last_drive_backup') === today) return;

  try {
    const q = encodeURIComponent("name='DersStudyosu_Yedekler' and mimeType='application/vnd.google-apps.folder' and trashed=false");
    const listRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}`, {
      headers: { Authorization: `Bearer ${driveToken}` }
    }).then(r => r.json());

    let folderId = listRes.files?.[0]?.id;
    if (!folderId) {
      const fRes = await fetch('https://www.googleapis.com/drive/v3/files', {
        method: 'POST',
        headers: { Authorization: `Bearer ${driveToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'DersStudyosu_Yedekler', mimeType: 'application/vnd.google-apps.folder' })
      }).then(r => r.json());
      folderId = fRes.id;
    }

    const meta = { name: `DersStudyosu_Yedek_${today}.json`, parents: [folderId] };
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    form.append('file', new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));

    const up = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${driveToken}` },
      body: form
    });
    if (up.ok) localStorage.setItem('last_drive_backup', today);
  } catch (e) {
    console.warn('Drive yedekleme atlandı:', e);
  }
}