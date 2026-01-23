// auth_client.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";

// Paste your Firebase web config:
const firebaseConfig = {
  apiKey: "AIzaSyBnAQsnmPsxr10XOgA8QlmzUnpJUZ-ST-0",
  authDomain: "spacego-fff13.firebaseapp.com",
  projectId: "spacego-fff13",
  storageBucket: "spacego-fff13.firebasestorage.app",
  messagingSenderId: "985439991571",
  appId: "1:985439991571:web:7fbc6c8c51346062c2cce6"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

async function apiPost(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

export function wireAuthUI({
  emailEl,
  passEl,
  statusEl,
  btnLogin,
  btnSignup,
  btnLogout,
}) {
  function setStatus(s) {
    if (statusEl) statusEl.textContent = s;
  }

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      setStatus("signed out");
      return;
    }

    setStatus("signed in (minting server session…)");

    // Exchange ID token for server session cookie
    const idToken = await user.getIdToken();
    await apiPost("/api/sessionLogin", { idToken });

    setStatus(`signed in as ${user.email}`);
  });

  btnLogin?.addEventListener("click", async () => {
    const email = emailEl.value.trim();
    const password = passEl.value;
    setStatus("signing in…");
    await signInWithEmailAndPassword(auth, email, password);
  });

  btnSignup?.addEventListener("click", async () => {
    const email = emailEl.value.trim();
    const password = passEl.value;
    setStatus("creating account…");
    await createUserWithEmailAndPassword(auth, email, password);
  });

  btnLogout?.addEventListener("click", async () => {
    setStatus("signing out…");
    await apiPost("/api/sessionLogout", {});
    await signOut(auth);
    setStatus("signed out");
  });
}
