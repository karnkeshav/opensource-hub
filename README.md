# Open Source Hub

Tiny, free, open-source apps that run offline. This repo is the download site (static, served by GitHub Pages).

- **Add an app:** add an entry to `apps.json`, upload the file to a GitHub Release, then set `"released": true`.
- **Download counts:** read live from the GitHub Releases API (`app.js`), summed per release file name.
- **App requests:** the site form opens a pre-filled GitHub issue labelled `app-request`. Optional Firebase support is in `config.js`.
- **Config:** `config.js` (`githubRepo`, `formEndpoint`, optional `firebase`).

## Receiving requests by email
Create a free Formspree form with the destination email address, then put its URL in `formEndpoint` in `config.js`. The address stays in Formspree, not in this public repo. Until then, requests open a pre-filled GitHub issue and GitHub emails the repo owner.

## Sign in with Google (optional)
1. Create a Firebase project, enable **Authentication > Google**, and create a Firestore database.
2. Add `karnkeshav.github.io` under **Authentication > Settings > Authorized domains**.
3. Paste the Firebase web config into `firebase` in `config.js` (it is public by design).
4. Publish `firestore.rules` (Firebase console > Firestore > Rules, or `firebase deploy --only firestore:rules`).

Signed-in download clicks are written to `downloads` and requests to `requests`. Read them in the Firebase console. Click logging is client-side, so a direct link to a release file is only counted by GitHub's own download count.

The site code is released under the MIT licence (see `LICENSE`), copyright ready4industry.in. Each app has its own licence.
