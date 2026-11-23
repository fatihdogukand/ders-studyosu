import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, doc, setDoc, onSnapshot, enableIndexedDbPersistence } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

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
let unsubSnap = null;
let isApplyingRemote = false;

const statusEl = document.getElementById('syncStatus');
const bar = statusEl.parentElement;
const authBtn = document.createElement('button');
authBtn.className = 'mini-btn';
authBtn.style.fontWeight = '700';
authBtn.textContent = '🔑 Giriş';
bar.appendChild(authBtn);

authBtn.onclick = async () => {
  if (currentUser) {
    if (confirm('Çıkış yapılsın mı?')) { await signOut(auth); sessionStorage.removeItem('drive_token'); }
    return;
  }
  try {
    const res = await signInWithPopup(auth, provider);
    const cred = GoogleAuthProvider.credentialFromResult(res);
    if (cred?.accessToken) {
      driveToken = cred.accessToken;
      sessionStorage.setItem('drive_token', driveToken);
    }
  } catch (e) {
    alert('Giriş hatası: ' + e.message);
  }
};

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (unsubSnap) { unsubSnap(); unsubSnap = null; }

  if (!user) {
    statusEl.textContent = '💾 Yerel Mod (Offline)';
    authBtn.textContent = '🔑 Giriş';
    return;
  }

  statusEl.textContent = '☁️ ' + (user.displayName?.split(' ')[0] || 'Bağlı');
  authBtn.textContent = '🚪 Çıkış';

  const userDoc = doc(dbCloud, 'users', user.uid, 'data', 'main');
  unsubSnap = onSnapshot(userDoc, (snap) => {
    if (!snap.exists()) {
      window.syncToCloud?.(window.getAppDb());
      return;
    }
    const remote = snap.data();
    const local = window.getAppDb();
    if (remote.updatedAt && remote.updatedAt > (local.updatedAt || 0)) {
      isApplyingRemote = true;
      window.setAppDb(remote);
      isApplyingRemote = false;
    }
    checkDailyDriveBackup(remote);
  });
});

window.syncToCloud = async (localDb) => {
  if (!currentUser || isApplyingRemote) return;
  try {
    localDb.updatedAt = Date.now();
    await setDoc(doc(dbCloud, 'users', currentUser.uid, 'data', 'main'), localDb);
  } catch (e) {
    console.warn('Offline kuyruğunda bekliyor:', e);
  }
};

async function checkDailyDriveBackup(data) {
  if (!driveToken) return;
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