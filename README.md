# Open Source Hub

Tiny, free, open-source apps that run offline. This repo is the download site (static, served by GitHub Pages).

- **Add an app:** add an entry to `apps.json`, upload the file to a GitHub Release, then set `"released": true`.
- **Download counts:** read live from the GitHub Releases API (`app.js`), summed per release file name.
- **App requests:** the site form opens a pre-filled GitHub issue labelled `app-request`. Optional Firebase support is in `config.js`.
- **Config:** `config.js` (`githubRepo`, `formEndpoint`, optional `firebase`).

## Receiving requests by email
Create a free Formspree form with the destination email address, then put its URL in `formEndpoint` in `config.js`. The address stays in Formspree, not in this public repo. Until then, requests open a pre-filled GitHub issue and GitHub emails the repo owner.

## Firebase
Project `opensource-hub-r4i` (Firestore in `asia-south1`, free tier). `firestore.rules` is deployed, the web config is in `config.js`, and the browser API key is restricted to this site's domains. App requests are stored in the `requests` collection.

## Sign in with Google (optional, not yet switched on)
1. Firebase console > **Authentication > Get started > Sign-in method > Google > Enable**.
2. **Authentication > Settings > Authorized domains**: add `karnkeshav.github.io`.
3. Set `signIn: true` in `config.js`.

Signed-in download clicks are written to `downloads` and requests to `requests`. Read them in the Firebase console. Click logging is client-side, so a direct link to a release file is only counted by GitHub's own download count.

The site code is released under the MIT licence (see `LICENSE`), copyright ready4industry.in. Each app has its own licence.
