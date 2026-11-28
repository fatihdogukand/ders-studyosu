import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  doc,
  collection,
  getDocs,
  getDocsFromServer,
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

const OWNER_ADMIN_UID = 'HdgIuerxCehDTxrPrEoDaZuQBXc2';
let currentUser = null;
let driveToken = sessionStorage.getItem('drive_token') || null;
let unsubDataCol = null;
let isApplyingRemote = false;
let syncDebounceTimer = null;
let isMigratingLegacy = false;
let hasInitialServerSnapshot = false;

function isOwnerAccount() {
  return Boolean(currentUser && currentUser.uid === OWNER_ADMIN_UID);
}
window.isCloudOwnerAccount = isOwnerAccount;

const lastSyncedNoteHashes = new Map();
const lastCheckedNoteStamps = new Map();
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

function isPlaceholderFolderName(name) {
  return /^Kurtarılan Klasör\s*\d*$/i.test(String(name || '').trim());
}

function mergeFoldersSafely(notes, ...folderLists) {
  const fMap = new Map();
  const upsert = (f) => {
    if (!f || !f.id) return;
    const prev = fMap.get(f.id);
    const fIsPlaceholder = isPlaceholderFolderName(f.name);
    const prevIsPlaceholder = isPlaceholderFolderName(prev?.name);
    if (prev && !prevIsPlaceholder && fIsPlaceholder) {
      if (typeof f.collapsed === 'boolean') prev.collapsed = f.collapsed;
      return;
    }
    const keptCollapsed = typeof f.collapsed === 'boolean' ? f.collapsed : Boolean(prev?.collapsed);
    fMap.set(f.id, prev ? { ...prev, ...f, collapsed: keptCollapsed } : { ...f, collapsed: keptCollapsed });
  };
  for (const n of (notes || [])) {
    if (Array.isArray(n?.folderTrail)) {
      n.folderTrail.forEach(tf => upsert(tf));
    }
  }
  for (const list of folderLists) {
    if (Array.isArray(list)) list.forEach(f => upsert(f));
  }
  return [...fMap.values()];
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
  lastCheckedNoteStamps.clear();
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
    if (querySnap.metadata?.hasPendingWrites && hasInitialServerSnapshot) return;

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

    // 2. Uzakta silinmiş notları yerelden de temizle (Firestore'da hala duran note_* belgelerini ve boş bulutu ASLA silme!)
    if (metaDoc && Array.isArray(metaDoc.noteIds) && remoteHasRealNotes && (metaDoc.updatedAt || 0) > (local.updatedAt || 0)) {
      const validIds = new Set(metaDoc.noteIds);
      for (const localId of [...localNotesMap.keys()]) {
        const lNote = localNotesMap.get(localId);
        const lTime = lNote?.updatedAt || lNote?.createdAt || 0;
        if (!remoteNotesMap.has(localId) && !validIds.has(localId) && lTime <= (metaDoc.updatedAt || 0)) {
          localNotesMap.delete(localId);
          changed = true;
        }
      }
    }

    // 3. Klasör ve ayar güncellemelerini uygula (eski main belgesi ve note.folderTrail ile gerçek klasör adlarını koru)
    const mergedDb = { ...local };
    const shouldApplyMeta = metaDoc && (localWasSeedOnly || (metaDoc.updatedAt || 0) > (local.updatedAt || 0));
    const hasPlaceholderLocally = (local.folders || []).some(f => isPlaceholderFolderName(f?.name));
    const allCurrentNotes = [...localNotesMap.values()];
    const mergedFolders = mergeFoldersSafely(
      allCurrentNotes,
      legacyMainDoc?.folders,
      remoteMetaOrEmpty(metaDoc),
      local.folders
    );

    if (shouldApplyMeta || (hasPlaceholderLocally && mergedFolders.length > 0)) {
      if (mergedFolders.length > 0) mergedDb.folders = mergedFolders;
      if (shouldApplyMeta) {
        if (metaDoc.settings) mergedDb.settings = { ...local.settings, ...metaDoc.settings };
        if (metaDoc.activeNoteId && localNotesMap.has(metaDoc.activeNoteId)) mergedDb.activeNoteId = metaDoc.activeNoteId;
        mergedDb.updatedAt = metaDoc.updatedAt || Date.now();
      }
      changed = true;
    }

    function remoteMetaOrEmpty(m) {
      return Array.isArray(m?.folders) ? m.folders : [];
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

    // Yalnızca damgası değişen veya yeni eklenen notları serileştir ve buluta gönder (sıfır gereksiz CPU yükü)
    for (const note of (localDb.notes || [])) {
      if (!note || !note.id) continue;
      currentNoteIds.add(note.id);
      const lastTrail = Array.isArray(note.folderTrail) && note.folderTrail.length
        ? note.folderTrail[note.folderTrail.length - 1]
        : null;
      const stamp = `${note.updatedAt || 0}|${note.folderId || ''}|${note.pinned ? 1 : 0}|${note.order ?? ''}|${note.title || ''}|${note.progressBlockId || ''}|${note.folderTrail?.length || 0}|${lastTrail?.name || ''}|${lastTrail?.parentId || ''}`;
      if (lastCheckedNoteStamps.get(note.id) === stamp && lastSyncedNoteHashes.has(note.id)) {
        continue;
      }

      const serializedNote = JSON.stringify(note);
      const noteBytes = serializedNote.length > 450000 ? new Blob([serializedNote]).size : serializedNote.length;

      if (noteBytes > 980 * 1024) {
        const warnMsg = `"${note.title || 'Adsız Not'}" notu 1 MB Firestore belge sınırına ulaştı (${Math.round(noteBytes / 1024)} KB) ve buluta gönderilemedi.`;
        console.warn(warnMsg);
        window.onCloudSyncStatus?.({ type: 'warn', message: warnMsg });
        continue;
      }

      const h = fastHash(serializedNote);
      if (lastSyncedNoteHashes.get(note.id) !== h) {
        await setDoc(doc(dataCol, 'note_' + note.id), JSON.parse(serializedNote));
        lastSyncedNoteHashes.set(note.id, h);
      }
      lastCheckedNoteStamps.set(note.id, stamp);
    }

    // Silinen notları buluttan kaldır
    for (const prevId of [...lastSyncedNoteHashes.keys()]) {
      if (!currentNoteIds.has(prevId)) {
        await deleteDoc(doc(dataCol, 'note_' + prevId));
        lastSyncedNoteHashes.delete(prevId);
        lastCheckedNoteStamps.delete(prevId);
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
  syncDebounceTimer = setTimeout(() => flushCloudSync(localDb), 1000);
};

window.recoverCloudNotes = async () => {
  if (!currentUser) {
    alert('Önce Google hesabınızla giriş yapın.');
    return 0;
  }
  try {
    const dataCol = collection(dbCloud, 'users', currentUser.uid, 'data');
    let snap = null;
    try {
      snap = await getDocsFromServer(dataCol);
    } catch (_) {
      snap = await getDocs(dataCol);
    }

    const foundMap = new Map();
    let legacyMain = null;
    let remoteMeta = null;

    snap.forEach((d) => {
      const data = d.data();
      if (d.id === 'meta') remoteMeta = data;
      else if (d.id === 'main') legacyMain = data;
      else if (d.id.startsWith('note_') && data && data.id && !isSeedWelcomeNote(data)) {
        foundMap.set(data.id, data);
      }
    });

    if (legacyMain && Array.isArray(legacyMain.notes)) {
      for (const ln of legacyMain.notes) {
        if (ln && ln.id && !isSeedWelcomeNote(ln) && !foundMap.has(ln.id)) {
          foundMap.set(ln.id, ln);
        }
      }
    }

    const local = window.getAppDb?.() || { folders: [], notes: [], settings: {} };
    const mergedMap = new Map();
    for (const ln of (local.notes || [])) {
      if (ln && ln.id && !isSeedWelcomeNote(ln)) mergedMap.set(ln.id, ln);
    }
    for (const [id, rn] of foundMap.entries()) {
      const cur = mergedMap.get(id);
      if (!cur || (rn.updatedAt || 0) >= (cur.updatedAt || 0)) {
        mergedMap.set(id, rn);
      }
    }

    const restoredNotes = [...mergedMap.values()];
    if (!restoredNotes.length) {
      alert('Bu Google hesabının Firestore veritabanında (note_* veya eski main belgesinde) kurtarılacak eski not bulunamadı.');
      return 0;
    }

    const restoredFolders = mergeFoldersSafely(
      restoredNotes,
      legacyMain?.folders,
      remoteMeta?.folders,
      local.folders
    );

    const nextDb = {
      ...local,
      folders: restoredFolders,
      notes: restoredNotes,
      activeNoteId: restoredNotes[0].id,
      updatedAt: Date.now()
    };

    isApplyingRemote = true;
    window.setAppDb?.(nextDb);
    isApplyingRemote = false;
    hasInitialServerSnapshot = true;
    await flushCloudSync(window.getAppDb?.() || nextDb);

    alert(`Buluttan ${foundMap.size} not bulundu; toplam ${restoredNotes.length} not ve klasörleri geri yüklendi!`);
    return restoredNotes.length;
  } catch (err) {
    alert('Bulut kurtarma hatası: ' + (err?.message || err));
    return 0;
  }
};

/* ==========================================================================
   MANUEL TARİHLİ BULUT YEDEKLEME (PARÇA-BELGE SNAPSHOT) & YÖNETİCİ ÇÖP KUTUSU
   ========================================================================== */
const SNAPSHOT_CHUNK_CHARS = 450000;
const TRASH_SOFT_LIMIT_BYTES = Math.round(880 * 1024 * 1024);

window.createManualCloudSnapshot = async (customLabel = '') => {
  if (!currentUser) {
    alert('Önce Google hesabınızla giriş yapın.');
    return null;
  }
  const localDb = window.getAppDb?.();
  if (!localDb || !Array.isArray(localDb.notes)) return null;

  const ts = Date.now();
  const snapId = 'snap_' + ts;
  const notesJson = JSON.stringify(localDb.notes);
  const totalBytes = new Blob([notesJson]).size;
  const chunks = [];
  for (let i = 0; i < notesJson.length; i += SNAPSHOT_CHUNK_CHARS) {
    chunks.push(notesJson.slice(i, i + SNAPSHOT_CHUNK_CHARS));
  }
  if (!chunks.length) chunks.push('[]');

  const snapCol = collection(dbCloud, 'users', currentUser.uid, 'snapshots');
  const batch = writeBatch(dbCloud);
  const headerPayload = {
    id: snapId,
    createdAt: ts,
    label: String(customLabel || '').trim() || ('Manuel Yedek · ' + new Date(ts).toLocaleString('tr-TR')),
    noteCount: localDb.notes.length,
    folderCount: (localDb.folders || []).length,
    totalBytes,
    chunkCount: chunks.length,
    folders: JSON.parse(JSON.stringify(localDb.folders || [])),
    activeNoteId: localDb.activeNoteId || null,
    settings: JSON.parse(JSON.stringify(localDb.settings || {}))
  };
  batch.set(doc(snapCol, snapId), headerPayload);

  chunks.forEach((chunkStr, idx) => {
    batch.set(doc(snapCol, `${snapId}_c${idx}`), {
      snapshotId: snapId,
      chunkIndex: idx,
      data: chunkStr
    });
  });

  await batch.commit();
  return headerPayload;
};

window.listCloudSnapshots = async () => {
  if (!currentUser) return [];
  const snapCol = collection(dbCloud, 'users', currentUser.uid, 'snapshots');
  let snap;
  try {
    snap = await getDocsFromServer(snapCol);
  } catch (_) {
    snap = await getDocs(snapCol);
  }
  const headers = [];
  snap.forEach((d) => {
    const data = d.data();
    if (data && !data.snapshotId && data.id) {
      headers.push(data);
    }
  });
  headers.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return headers;
};

window.restoreCloudSnapshot = async (snapId) => {
  if (!currentUser || !snapId) return false;
  const snapCol = collection(dbCloud, 'users', currentUser.uid, 'snapshots');
  let snap;
  try {
    snap = await getDocsFromServer(snapCol);
  } catch (_) {
    snap = await getDocs(snapCol);
  }
  let header = null;
  const chunks = [];
  snap.forEach((d) => {
    const data = d.data();
    if (!data) return;
    if (d.id === snapId && !data.snapshotId) header = data;
    else if (data.snapshotId === snapId) chunks.push(data);
  });
  if (!header || !chunks.length) {
    alert('Seçilen bulut yedeğinin verisi bulunamadı.');
    return false;
  }
  chunks.sort((a, b) => (a.chunkIndex || 0) - (b.chunkIndex || 0));
  const notesJson = chunks.map(c => c.data || '').join('');
  const restoredNotes = JSON.parse(notesJson);
  const local = window.getAppDb?.() || { folders: [], notes: [], settings: {} };
  const mergedFolders = mergeFoldersSafely(restoredNotes, header.folders, local.folders);

  const nextDb = {
    ...local,
    folders: mergedFolders,
    notes: restoredNotes,
    activeNoteId: restoredNotes.some(n => n.id === header.activeNoteId) ? header.activeNoteId : (restoredNotes[0]?.id || null),
    settings: header.settings ? { ...local.settings, ...header.settings } : local.settings,
    updatedAt: Date.now()
  };

  isApplyingRemote = true;
  window.setAppDb?.(nextDb);
  isApplyingRemote = false;
  hasInitialServerSnapshot = true;
  await flushCloudSync(window.getAppDb?.() || nextDb);
  return true;
};

window.deleteCloudSnapshot = async (snapId) => {
  if (!currentUser || !snapId) return;
  const snapCol = collection(dbCloud, 'users', currentUser.uid, 'snapshots');
  const snap = await getDocs(snapCol);
  const batch = writeBatch(dbCloud);
  snap.forEach((d) => {
    const data = d.data();
    if (d.id === snapId || data?.snapshotId === snapId) {
      batch.delete(doc(snapCol, d.id));
    }
  });
  await batch.commit();
};

window.moveNoteToCloudTrash = async (note) => {
  if (!isOwnerAccount() || !note || !note.id || isSeedWelcomeNote(note)) return false;
  try {
    const dataCol = collection(dbCloud, 'users', currentUser.uid, 'data');
    const snap = await getDocs(dataCol);
    let totalBytes = 0;
    const trashList = [];
    snap.forEach((d) => {
      const data = d.data();
      const b = new Blob([JSON.stringify(data)]).size;
      totalBytes += b;
      if (d.id.startsWith('trash_') && data) {
        trashList.push({ docId: d.id, deletedAt: data.deletedAt || 0, bytes: b });
      }
    });

    const cleanNote = JSON.parse(JSON.stringify(note));
    cleanNote.deletedAt = Date.now();
    cleanNote.isTrashed = true;
    let payloadStr = JSON.stringify(cleanNote);
    let noteBytes = new Blob([payloadStr]).size;

    // Tekil belge 980 KB üstündeyse görsel gömmelerini çıkarıp metin/formülleri kurtar
    if (noteBytes > 980 * 1024) {
      cleanNote.blocks = (cleanNote.blocks || []).map(b => ({
        ...b,
        html: String(b.html || '').replace(/<img[^>]+src=["']data:image\/[^"']+["'][^>]*>/gi, '<p><em>[Çöp kutusu boyut koruması: gömülü görsel çıkarıldı]</em></p>')
      }));
      payloadStr = JSON.stringify(cleanNote);
      noteBytes = new Blob([payloadStr]).size;
    }
    if (noteBytes > 980 * 1024) return false;

    // 1 GB limite (%86) yaklaşılırsa en eski çöp kutusu öğelerini otomatik temizle
    trashList.sort((a, b) => (a.deletedAt || 0) - (b.deletedAt || 0));
    while (totalBytes + noteBytes > TRASH_SOFT_LIMIT_BYTES && trashList.length > 0) {
      const oldest = trashList.shift();
      await deleteDoc(doc(dataCol, oldest.docId));
      totalBytes -= oldest.bytes;
    }

    await setDoc(doc(dataCol, 'trash_' + cleanNote.id), cleanNote);
    return true;
  } catch (err) {
    console.warn('Çöp kutusu kaydı atlandı:', err);
    return false;
  }
};

window.listCloudTrash = async () => {
  if (!isOwnerAccount()) return [];
  const dataCol = collection(dbCloud, 'users', currentUser.uid, 'data');
  let snap;
  try {
    snap = await getDocsFromServer(dataCol);
  } catch (_) {
    snap = await getDocs(dataCol);
  }
  const list = [];
  snap.forEach((d) => {
    if (d.id.startsWith('trash_')) {
      const data = d.data();
      if (data && data.id) list.push(data);
    }
  });
  list.sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  return list;
};

window.restoreCloudTrashNote = async (noteId) => {
  if (!isOwnerAccount() || !noteId) return false;
  const dataCol = collection(dbCloud, 'users', currentUser.uid, 'data');
  const snap = await getDocs(dataCol);
  let target = null;
  snap.forEach((d) => {
    if (d.id === 'trash_' + noteId) target = d.data();
  });
  if (!target) return false;
  delete target.deletedAt;
  delete target.isTrashed;
  target.updatedAt = Date.now();

  const local = window.getAppDb?.() || { folders: [], notes: [], settings: {} };
  const mergedFolders = mergeFoldersSafely([target], local.folders);
  const nextNotes = [target, ...(local.notes || []).filter(n => n.id !== target.id)];
  const nextDb = { ...local, folders: mergedFolders, notes: nextNotes, activeNoteId: target.id, updatedAt: Date.now() };

  isApplyingRemote = true;
  window.setAppDb?.(nextDb);
  isApplyingRemote = false;
  hasInitialServerSnapshot = true;
  await deleteDoc(doc(dataCol, 'trash_' + noteId));
  await flushCloudSync(window.getAppDb?.() || nextDb);
  return true;
};

window.purgeCloudTrashNote = async (noteId) => {
  if (!isOwnerAccount() || !noteId) return;
  const dataCol = collection(dbCloud, 'users', currentUser.uid, 'data');
  await deleteDoc(doc(dataCol, 'trash_' + noteId));
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