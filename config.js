// Site configuration.
window.HUB_CONFIG = {
  // "owner/repo" of the GitHub repo that holds the Releases.
  githubRepo: "karnkeshav/opensource-hub",

  // Email delivery for app requests: a Formspree form URL, e.g. "https://formspree.io/f/xxxxxxxx".
  // The destination email address is stored in the Formspree form settings, not in this public file.
  // While empty, requests open a pre-filled GitHub issue instead (GitHub emails the repo owner).
  formEndpoint: "",

  // Firebase web config (public by design; the API key is restricted to this site's domains and
  // data access is limited by firestore.rules). Requests are stored in Firestore.
  firebase: {
    apiKey: "AIzaSyCBvfOhYQtrBO_T_Z8mZ9juEXMvXQM5Dz4",
    authDomain: "opensource-hub-r4i.firebaseapp.com",
    projectId: "opensource-hub-r4i",
    storageBucket: "opensource-hub-r4i.firebasestorage.app",
    messagingSenderId: "1092763922163",
    appId: "1:1092763922163:web:7a1196e8b88fa403d6d186"
  },

  // Show "Sign in with Google". Set to true only after enabling Authentication > Google
  // in the Firebase console.
  signIn: false
};
