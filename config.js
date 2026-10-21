// Site configuration.
window.HUB_CONFIG = {
  // "owner/repo" of the GitHub repo that holds the Releases.
  githubRepo: "karnkeshav/opensource-hub",

  // Email delivery for app requests: a Formspree form URL, e.g. "https://formspree.io/f/xxxxxxxx".
  // The destination email address is stored in the Formspree form settings, not in this public file.
  // While empty, requests open a pre-filled GitHub issue instead (GitHub emails the repo owner).
  formEndpoint: "",

  // Optional Firebase web config (public by design). Enables "Sign in with Google" and
  // stores requests and signed-in download clicks in Firestore. Protect data with firestore.rules.
  firebase: null
};
