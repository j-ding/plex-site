# DingFlix

A Netflix-style front end for a **Plex** or **Jellyfin** media server. It's a
fully static site (plain HTML/CSS/JS, no build step), so it can be hosted for
free on GitHub Pages.

Everything happens in the viewer's browser: they sign in (with their Plex
account, or with a Jellyfin username and password), and it streams directly from
that server. GitHub only serves the files; your media never
touches it.

## Features

- Sign in with Plex (the same login flow Plex's own apps use)
- Home page with a featured banner, Continue Watching, and Recently Added rows
- One page per library with suggestion rows and a sortable, infinite-scroll grid
- Title pages with cast, genres, season picker, and episode list
- Trailer previews (Jellyfin): rest the mouse on a poster and a pop-out plays
  its trailer, muted, with Play and More info buttons; the home banner and title
  pages play the trailer behind the picture. They stay off on phones, with data
  saver or reduced motion, and can be switched off in the account menu.
- Going back puts you where you were, including how far each row was scrolled
- People pages: actor and director names on a title page open everything in
  your library with them (Jellyfin adds their photo and bio)
- Coming Up (Jellyfin): a home row and page of new episodes about to air for
  shows in your library
- Requests (Jellyfin): anyone can ask for a movie or show that isn't there
  (search offers it when nothing matches). The owner sees everyone's requests,
  with a count on the tab, and marks each one added or declined; people see the
  answer on their own Requests page. Requests are stored in each person's
  Jellyfin display preferences, so nothing else needs to run.
- Hide a title (Jellyfin, owner): from everyone else or from one person, for
  example to keep a horror film away from a kid's profile. Hidden titles use
  Jellyfin's blocked tags, so they're gone in Jellyfin's own apps too. Manage →
  Hidden titles lists them with an Unhide button.
- Watch together (Jellyfin): a **Friends Watching Now** row on the home page
  shows what everyone else is playing. Press **Join** and you start where they
  are; after that playback stays in sync (anyone can pause, play or skip, and
  everyone follows to the next episode) and a chat sits beside the video (under
  it on phones). The owner turns it on in Manage → Watch together.
- Skip intro: a button while the intro plays (Jellyfin media segments from a
  plugin such as Intro Skipper, or Plex's intro markers)
- Preview pictures while you drag through a video or skip with the arrow keys,
  from Jellyfin's trickplay images (turn them on per library in Jellyfin)
- 4K, HDR and Dolby Vision labels on posters and title pages (Jellyfin)
- Sign in with a code (Jellyfin Quick Connect): a new device shows a code under
  "Use a code", and anyone signed in approves it from the account menu → Sign in
  another device
- Watch together extras: start a party yourself and copy an Invite link, and
  send emoji reactions that float over everyone's video
- Choose audio and subtitles on the title page before playing (for a Jellyfin
  show, by language for every episode), with **Find subtitles online** to fetch
  them from OpenSubtitles through the server
- Extras on the title page: deleted scenes, featurettes, behind the scenes,
  interviews and trailers saved with a movie (in subfolders such as
  `deleted scenes` or `featurettes` next to the file), grouped with filters.
  Commentary audio tracks are named as commentary in both audio menus.
- Online extras: featurettes, behind the scenes, bloopers and trailers the
  studios posted on YouTube (as listed on TMDB) join the Extras row and play in
  DingFlix. The owner pastes a free TMDB API key in Manage → Online extras; it's
  kept on the Jellyfin server (as a comment in its custom CSS) so every viewer
  gets it.
- Search across all libraries
- **Manage** tab for the server owner: everyone with access, what they've
  finished watching, who's watching right now, and buttons to remove someone's
  access or delete a profile
- "Who's watching?" profiles from Plex Home, so each person keeps their own
  progress, Continue Watching and watched status (see below)
- Refresh button (next to search) that has Plex check for new files and shows
  them right away. Only the server owner sees it.
- Autoplay next: when the end credits start, a card offers the next episode
  (or, for a movie, the next film in its collection, like a sequel) and plays it
  after 10 seconds; **Watch credits** lets them run and asks again at the end.
  Credits come from Plex's credit markers, Jellyfin's media segments (e.g. the
  Intro Skipper plugin) or a "Credits" chapter; without them, episodes guess the
  last 25 seconds and movies wait for the end. Sequels use TMDb collections
  (Jellyfin). Switch it off in the account menu.
- Player: resumes where you left off, syncs progress to Plex, quality picker,
  next-episode button, and keyboard shortcuts
  (space/k = pause, ←/→ = 10s skip, f = fullscreen, Esc = back)
- Audio & subtitle menu (the speech-bubble button): switch between any audio
  track or subtitle track in the file, or turn subtitles off, and pick a subtitle
  size. Choices are saved to Plex, so they stick for that title in every Plex app.
- Find subtitles online (like VLC's VLSub): in that same menu, search
  OpenSubtitles in any of 20 languages through your Plex server, with results
  that match your exact file flagged. Picking one downloads it to the server and
  switches to it on the spot. No OpenSubtitles account needed.

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
- **Their own Plex account** (friends elsewhere): in DingFlix go to **Manage →
  Invite someone** and enter their email. Send them the link it gives you. The
  link walks them through signing in (or signing up for a free Plex account with
  that email), accepts your invite for them, and drops them into your libraries.

### Transcoding

Files that browsers can play as-is (MP4 with H.264 video and AAC audio) play
directly with no server load. Everything else (MKV, HEVC, DTS, and so on) is
converted on the fly by the server and streamed as HLS. Hardware-accelerated
transcoding needs Plex Pass and makes a big difference on weaker machines.

## Using Jellyfin instead of (or alongside) Plex

On the sign-in screen choose **Use a Jellyfin server** and enter its address.
Jellyfin's users show up as the "Who's watching?" profiles. Everything else (home
rows, libraries, search, the player with quality, audio and subtitle choices,
resume and progress, next episode, Manage) works the same.

Differences from Plex:

- **Hardware transcoding and HDR tone mapping are free** (Dashboard → Playback →
  Transcoding). This setup uses the AMD GPU (AMF) with tone mapping on.
- **Categories**: the Movies and TV Shows pages get category buttons (Featured,
  All, Korean, Action, Revenge, Anime, …) and the home page gets category rows.
  They're built from each title's genres, main production country and keywords,
  and a category only appears once it has at least 3 titles.
- **Text subtitles** (SRT and similar) are drawn by the browser, so changing their
  size is instant. Image subtitles (PGS) are burned in, like on Plex.
- **Inviting** someone creates a Jellyfin account for them (Manage → Invite
  someone) and gives you a sign-in link with their name filled in.
- **Find subtitles online** needs Jellyfin's *Open Subtitles* plugin: Dashboard →
  Plugins → Catalog → Open Subtitles, restart Jellyfin, then sign the plugin in to
  a free OpenSubtitles.com account.
- **The server needs an `https://` address** to be used from the GitHub Pages
  site (browsers block `http://` from an HTTPS page, except `localhost`). A common
  free setup: a DuckDNS name, port 443 forwarded on your router, and Caddy as a
  reverse proxy to `localhost:8096` (it gets the certificate automatically).
- The Jellyfin Windows service runs as `NETWORK SERVICE`, which can't see your
  user folder by default. It was given read-only access to
  `C:\Users\Ding\Videos\Plex` so it can read the same media as Plex.
- Jellyfin only saves "continue watching" progress after the first 5% of a title.

### DingFlix on the NAS (home network, no internet data)

Phones often won't let the GitHub Pages site reach a server on the home network,
and the Tailscale address sends video out to the internet and back. [nas/](nas/)
runs DingFlix on the NAS itself: a small nginx container serves the DingFlix files
and passes everything else to the NAS's Jellyfin, so `http://192.168.50.176:8099`
opens DingFlix already connected, with no certificate warning, and video stays on
the home network. See [nas/compose.yaml](nas/compose.yaml) for the setup.

### Links for people outside your home (Jellyfin)

At home you may be connected through the server's home-network address (say
`https://192.168.50.176:15443/...`), which nobody elsewhere can reach. Manage →
**Address for links** holds the public address (for example your Tailscale
Funnel address) that share and sign-in links use; it fills itself in when you're
connected through a public address. Once it's set, the account menu has **Share
DingFlix link**, which copies that address: it opens DingFlix already pointed at
your server.

### Watch together (Jellyfin only)

Manage → **Watch together → Turn on for everyone** gives every account (not
share-link guests) Jellyfin's *Allow remote control of other users* permission.
That's what lets people see each other's sessions and send messages between
them. It also lets their Jellyfin apps control each other's playback, which is
why it's a switch. New accounts get it while it's on.

Each DingFlix tab keeps a WebSocket open to Jellyfin. The person being joined
hosts: guests send their pauses, skips and chat to the host, and the host sends
everyone its position every few seconds and passes the chat along, all as
Jellyfin session messages, so nothing else needs to run. Joining someone who's
watching in another Jellyfin app (the TV app, say) starts you where they are,
but without sync or chat. The chat isn't saved anywhere.

### Share one movie or show, no sign-up (Jellyfin only)

On any title page, the Jellyfin admin gets a **Share** button. Pick who it's for
(just a note for you) and how long the link should work (1 day, 7 days, 30 days
or until revoked), and send the link. Whoever opens it watches that one title
straight away: no account, no password, and they can't see anything else in your
library.

Behind the scenes the title (and, for a show, its seasons and episodes) gets a
`dfshare-…` tag, and a hidden guest account is created that can only see items
with that tag, can't download, and is limited to two streams. Manage → **Shared
links** lists every link with when it was last watched; **Revoke** deletes the
guest account and removes the tag. Expired links are cleaned up automatically the
next time the admin opens Manage.

Anyone with the link can watch, so treat it like a password. It needs the server's
public `https://` address to work for people outside your home. Plex can't do this
without Plex Pass (sharing only selected titles is a Plex Pass feature).

## Adding more with HolyArrs

[HolyArrs](https://holyarrs.com) is a separate self-hosted app that finds movies and
shows, downloads them through your downloader and files them into your library.
The server owner gets a **HolyArrs** tab: enter its address once (usually
`http://localhost:6262` on the computer it runs on; it's saved per device), then
search for a title or jump to its Explore, Requests, Downloads and Calendar pages.
Searches with no match offer "Find it in HolyArrs", and title pages get a
**HolyArrs ↗** button for that title (missing seasons, a better copy).

HolyArrs doesn't accept requests from other sites and can't be shown inside another
page, so these open HolyArrs in its own tab. Setting up HolyArrs itself (Docker, a
downloader and its Sources) happens in HolyArrs.

## How it works

| File | Purpose |
| --- | --- |
| `js/plex.js` | Plex API: PIN login via plex.tv, server discovery, library and playback endpoints |
| `js/jellyfin.js` | Jellyfin API, translated into the same shape the pages use for Plex |
| `js/views.js` | Pages: home, library, title, search, sign-in and server picker |
| `js/player.js` | Video player: direct play or HLS (via hls.js), progress reporting, up-next |
| `js/trailers.js` | Trailer previews on banners and poster pop-outs (YouTube embeds) |
| `js/party.js` | Watch together: the live connection to Jellyfin, synced playback and chat |
| `js/holyarrs.js` | Links into a HolyArrs install: address, search and title pages |
| `js/app.js` | Hash router, error handling and auto-reconnect, global click handling |
| `js/state.js` | Current server and account, saved in localStorage |

Sign-in tokens are stored in the viewer's own browser (localStorage) and are
only ever sent to plex.tv and the media server itself.

## Known limitations

- On Plex, subtitles are drawn into the picture by the server ("burned in"). That works
  for every subtitle format, including image-based PGS/VobSub, but it means a
  title with subtitles on is always transcoded, and switching tracks restarts the
  stream for a second or two.
- Switching to an audio track other than the file's first one also makes the
  server convert the stream, even for files that would otherwise play directly.
- Music and photo libraries are hidden; this site is for video.
- In some browsers, the "local network" address of a server can be blocked when
  the site is opened from GitHub Pages. The remote address still works as long as
  Remote Access is on.
