# Marquee

A Netflix-style front end for a Plex Media Server. It's a fully static site
(plain HTML/CSS/JS, no build step), so it can be hosted for free on GitHub Pages.

Everything happens in the viewer's browser: they sign in with their Plex
account, the site finds the Plex servers that account can reach, and it streams
directly from that server. GitHub only serves the files; your media never
touches it.

## Features

- Sign in with Plex (the same login flow Plex's own apps use)
- Home page with a featured banner, Continue Watching, and Recently Added rows
- One page per library with suggestion rows and a sortable, infinite-scroll grid
- Title pages with cast, genres, season picker, and episode list
- Search across all libraries
- Player: resumes where you left off, syncs progress to Plex, quality picker,
  next-episode button with an autoplay countdown, and keyboard shortcuts
  (space/k = pause, ←/→ = 10s skip, f = fullscreen, Esc = back)

## Run it locally

Any static file server works. From this folder:

```sh
python -m http.server 8000
```

Then open http://localhost:8000.

## Put it on GitHub Pages

1. Create a new repository on GitHub (for example `marquee`).
2. Push this folder to it:
   ```sh
   git remote add origin https://github.com/<you>/marquee.git
   git push -u origin main
   ```
3. On GitHub, go to **Settings → Pages**. Under **Build and deployment**, choose
   **Deploy from a branch**, then pick `main` and `/ (root)`.
4. After a minute the site is live at `https://<you>.github.io/marquee/`.

To rename the app, edit `appName` in [js/config.js](js/config.js).

## Setting up the Plex server (later)

1. Install **Plex Media Server** on an always-on computer or NAS:
   https://www.plex.tv/media-server-downloads/
2. Sign in with your Plex account during setup and add **Movies** and **TV Shows**
   libraries that point at your media folders. Plex expects names like
   `Movies/Heat (1995)/Heat (1995).mkv` and `TV/The Wire/Season 01/The Wire - S01E01.mkv`.
3. **Settings → Network**: leave **Secure connections** set to *Preferred* (the
   default). The site runs on HTTPS, so it can only talk to the server over HTTPS,
   and Plex provides that automatically with its `*.plex.direct` certificates.
4. **Settings → Remote Access**: turn it on so people outside your home network can
   connect. This usually means allowing port 32400 through your router (UPnP often
   does it for you). Without it, Plex falls back to its relay, which is capped at
   low bitrates.
5. To let friends and family in, open **Settings → Users & Sharing** in Plex and
   share your libraries with their Plex accounts. They then sign in to the site with
   their own account and pick your server.

### Transcoding

Files that browsers can play as-is (MP4 with H.264 video and AAC audio) play
directly with no server load. Everything else (MKV, HEVC, DTS, and so on) is
converted on the fly by the server and streamed as HLS. Hardware-accelerated
transcoding needs Plex Pass and makes a big difference on weaker machines.

## How it works

| File | Purpose |
| --- | --- |
| `js/plex.js` | Plex API: PIN login via plex.tv, server discovery, library and playback endpoints |
| `js/views.js` | Pages: home, library, title, search, sign-in and server picker |
| `js/player.js` | Video player: direct play or HLS (via hls.js), progress reporting, up-next |
| `js/app.js` | Hash router, error handling and auto-reconnect, global click handling |
| `js/state.js` | Current server and account, saved in localStorage |

The Plex token is stored in the viewer's own browser (localStorage) and is only
ever sent to plex.tv and their Plex server.

## Known limitations

- Audio track and subtitle selection use the server's defaults. You can change
  them per title in Plex's own app for now.
- Music and photo libraries are hidden; this site is for video.
- In some browsers, the "local network" address of a server can be blocked when
  the site is opened from GitHub Pages. The remote address still works as long as
  Remote Access is on.
