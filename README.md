# DingFlix

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
- **Manage** tab for the server owner: everyone with access, what they've
  finished watching, who's watching right now, and buttons to remove someone's
  access or delete a profile
- "Who's watching?" profiles from Plex Home, so each person keeps their own
  progress, Continue Watching and watched status (see below)
- Refresh button (next to search) that has Plex check for new files and shows
  them right away. Only the server owner sees it.
- Player: resumes where you left off, syncs progress to Plex, quality picker,
  next-episode button with an autoplay countdown, and keyboard shortcuts
  (space/k = pause, ←/→ = 10s skip, f = fullscreen, Esc = back)
- Audio & subtitle menu (the speech-bubble button): switch between any audio
  track or subtitle track in the file, or turn subtitles off, and pick a subtitle
  size. Choices are saved to Plex, so they stick for that title in every Plex app.

## Run it locally

Any static file server works. From this folder:

```sh
python -m http.server 8000
```

Then open http://localhost:8000.

## Put it on GitHub Pages

1. Create a new repository on GitHub (for example `dingflix`).
2. Push this folder to it:
   ```sh
   git remote add origin https://github.com/<you>/dingflix.git
   git push -u origin main
   ```
3. On GitHub, go to **Settings → Pages**. Under **Build and deployment**, choose
   **Deploy from a branch**, then pick `main` and `/ (root)`.
4. After a minute the site is live at `https://<you>.github.io/dingflix/`.

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

### Separate progress for each person

Plex tracks progress per Plex user. There are two ways to give everyone their own:

- **Plex Home** (people in your household): at https://app.plex.tv go to
  **Settings → Plex Home** and add a user for each person, optionally with a
  4-digit PIN, or use **+ Add profile** on the site's "Who's watching?" screen
  (the owner must be signed in on that device). The site then asks "Who's watching?" after sign-in, and each
  device remembers its choice (change it under the account menu → Switch profile).
- **Their own Plex account** (friends elsewhere): share your libraries with them
  under **Settings → Users & Sharing**. They sign in with their own account.

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

- Subtitles are drawn into the picture by the server ("burned in"). That works
  for every subtitle format, including image-based PGS/VobSub, but it means a
  title with subtitles on is always transcoded, and switching tracks restarts the
  stream for a second or two.
- Switching to an audio track other than the file's first one also makes the
  server convert the stream, even for files that would otherwise play directly.
- Music and photo libraries are hidden; this site is for video.
- In some browsers, the "local network" address of a server can be blocked when
  the site is opened from GitHub Pages. The remote address still works as long as
  Remote Access is on.
