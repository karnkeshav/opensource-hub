# Open Source Hub

Tiny, free, open-source apps that run offline. This repo is the download site (static, served by GitHub Pages).

- **Add an app:** add an entry to `apps.json`, upload the file to a GitHub Release, then set `"released": true`.
- **Download counts:** read live from the GitHub Releases API (`app.js`), summed per release file name.
- **App requests:** the site form opens a pre-filled GitHub issue labelled `app-request`. Optional Firebase support is in `config.js`.
- **Config:** `config.js` (`githubRepo`, optional `firebase`).

The site code is released under the MIT licence (see `LICENSE`). Each app has its own licence.
