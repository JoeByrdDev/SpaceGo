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
  if (!res.ok) throw new Error(data.error || data.reason || res.statusText || `HTTP ${res.status}`);
  return data;
}

function friendlyAuthError(err) {
  const code = err?.code || "";
  const msg = err?.message || "";

  switch (code) {
    case "auth/invalid-email":
      return "Invalid email address format.";
    case "auth/missing-email":
      return "Enter an email address.";
    case "auth/missing-password":
      return "Enter a password.";
    case "auth/weak-password":
      return "Password is too weak. Use at least 6 characters.";
    case "auth/email-already-in-use":
      return "That email is already in use.";
    case "auth/user-not-found":
      return "No account found for that email.";
    case "auth/wrong-password":
      return "Incorrect password.";
    case "auth/invalid-credential":
      return "Incorrect email or password.";
    case "auth/user-disabled":
      return "That account is disabled.";
    case "auth/too-many-requests":
      return "Too many attempts. Try again later.";
    case "auth/network-request-failed":
      return "Network error talking to auth. Check connection and try again.";
    default:
      // keep it short; but still surface something useful
      if (code) return `Auth error: ${code.replace("auth/", "")}.`;
      if (msg) return msg;
      return "Auth error.";
  }
}

export function wireAuthUI({
  emailEl,
  passEl,
  statusEl,
  btnLogin,
  btnSignup,
  btnLogout,
}) {
  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text || "";
    // lobby.css already defines .ok and .danger; we just apply them. :contentReference[oaicite:2]{index=2}
    statusEl.className = kind ? kind : "";
  }

  function setBusy(b) {
    const v = !!b;
    if (btnLogin) btnLogin.disabled = v;
    if (btnSignup) btnSignup.disabled = v;
    if (btnLogout) btnLogout.disabled = v;
  }

  function readCreds() {
    const email = (emailEl?.value || "").trim();
    const password = passEl?.value || "";
    return { email, password };
  }

  // Keeps us from trying to mint cookies repeatedly during rapid auth state transitions
  let minting = false;
  let lastMintedUid = null;

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      lastMintedUid = null;
      setBusy(false);
      setStatus("signed out");
      return;
    }

    // Already minted for this UID this session; still show signed-in status.
    if (lastMintedUid === user.uid) {
      setStatus(`signed in as ${user.email || "user"}`, "ok");
      return;
    }

    if (minting) return;
    minting = true;
    setBusy(true);
    setStatus("signed in (minting server session…)");
    try {
      const idToken = await user.getIdToken();
      await apiPost("/api/sessionLogin", { idToken });
      lastMintedUid = user.uid;
      setStatus(`signed in as ${user.email || "user"}`, "ok");
    } catch (e) {
      // Important: user is signed into Firebase but server session cookie failed.
      // That means "mine" list etc will behave like signed-out.
      lastMintedUid = null;
      setStatus(`server session failed: ${e?.message || "error"}`, "danger");
    } finally {
      minting = false;
      setBusy(false);
    }
  });

  btnLogin?.addEventListener("click", async () => {
    const { email, password } = readCreds();
    if (!email) return setStatus("enter email", "danger");
    if (!password) return setStatus("enter password", "danger");

    setBusy(true);
    setStatus("signing in…");
    try {
      await signInWithEmailAndPassword(auth, email, password);
      // onAuthStateChanged will complete status + server session
    } catch (e) {
      setStatus(friendlyAuthError(e), "danger");
      setBusy(false);
    }
  });

  btnSignup?.addEventListener("click", async () => {
    const { email, password } = readCreds();
    if (!email) return setStatus("enter email", "danger");
    if (!password) return setStatus("enter password", "danger");

    setBusy(true);
    setStatus("creating account…");
    try {
      await createUserWithEmailAndPassword(auth, email, password);
      // onAuthStateChanged will complete status + server session
    } catch (e) {
      setStatus(friendlyAuthError(e), "danger");
      setBusy(false);
    }
  });

  btnLogout?.addEventListener("click", async () => {
    setBusy(true);
    setStatus("signing out…");
    try {
      // try to clear server session even if firebase signOut fails
      try { await apiPost("/api/sessionLogout", {}); } catch (_) {}
      await signOut(auth);

      lastMintedUid = null;
      setStatus("signed out");
    } catch (e) {
      setStatus(`logout failed: ${e?.message || "error"}`, "danger");
    } finally {
      setBusy(false);
    }
  });
}
