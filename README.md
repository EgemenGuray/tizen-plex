# Lumen for Tizen

> Formerly "Plex HDR". The Tizen app id (`PlxHDRtzn0.PlexHDR`), the certificate profile name `PlexHDR` and the saved settings keys are unchanged, so reinstalling replaces the old app and keeps its sign-in.

A small Plex client for Samsung Tizen TVs, built for a QN900B with a Q990C soundbar. It has one job: send the original file to the TV untouched (direct play), so the TV's own decoders handle HDR10+, and send Dolby audio to the soundbar wherever the TV allows it.

It is a sideloaded Tizen web app. It plays through Samsung's AVPlay API, the same native media pipeline Samsung's own apps use.

## What the hardware allows

| Goal | Possible? | Why |
|---|---|---|
| **HDR10+ video** | **Yes** | HDR10+ metadata is carried inside the HEVC stream. AVPlay passes the stream to the TV's hardware decoder, which reads the metadata. It only survives if the server doesn't re-encode the video, so this app never asks for a video transcode. |
| HDR10 / HLG | Yes | Same path. |
| **Dolby Vision** | **No** | No Samsung TV supports Dolby Vision. Profile 7 and 8 files play their HDR10 base layer and look correct, and when the file also carries HDR10+ metadata (many recent releases do) the TV plays it as HDR10+. Profile 5 files have no HDR10 layer, so the colours come out wrong. The app warns you about those. |
| **Dolby Atmos via E-AC3 (DD+ Atmos)** | **Yes, reliably** | The TV passes E-AC3 Atmos to the soundbar over eARC. This is the format streaming services use. |
| **Dolby TrueHD / TrueHD Atmos** | **Can't be guaranteed: the TV firmware decides** | An app can hand TrueHD to the TV, but the TV firmware decides what leaves the eARC port. User reports for 2021–2022 Samsung TVs, including a QN900B, say TrueHD from built-in apps doesn't arrive as a bitstream: you get silence, PCM, or a forced transcode ([Plex forum](https://forums.plex.tv/t/still-no-dolby-atmos-on-samsung-tv/825774), [another thread](https://forums.plex.tv/t/cannot-stream-truehd-to-samsung-tv/547058)). No app API can override this. The app tries it and gives you a one-button fallback. |
| DTS / DTS-HD / DTS:X | **No** | Samsung TVs from 2018 on can't decode DTS or pass it through. The app picks another track in the same language, or has the server convert the audio. |

**Bottom line:** HDR10+ works. Atmos works when the file has an E-AC3 Atmos track. Lossless TrueHD Atmos to the Q990C depends on Samsung's firmware, so try it on your TV. The only route that reliably delivers TrueHD Atmos is a player with real passthrough, such as an Nvidia Shield or Apple TV, plugged into a TV HDMI input. The TV then forwards TrueHD over eARC to the soundbar. (An Apple TV outputs PCM, not a TrueHD bitstream; a Shield passes TrueHD through.)

## What the app does

### Looks and navigation (Apple TV style)
- **Tab bar** at the top: Home, each movie and TV library, Search, Settings, plus a clock and the current Plex Home user.
- **Home** opens on a full-screen **top shelf**: big artwork, the title logo (when Plex has one), year, rating, runtime, genres and summary, with Play/Resume and More Info. It moves to the next title every 9 s while you rest on it, and ◀ ▶ past the buttons flips between titles. Below it: Continue Watching (wide cards with progress bars) and Recently Added rows for every library.
- Rows slide sideways and the page slides up so the focused item stays in a steady place. Focused artwork lifts and grows with a light sheen; the background cross-fades to the focused title's art. Everything animates with GPU transforms, which the TV handles smoothly.
- **Libraries**: poster grid that loads more as you scroll, with Sort (title, date added, release date, rating, recently watched), Unwatched only, Genre, and Collections.
- **Show page**: backdrop, Play/Resume next episode, Mark watched, season pills (moving onto a season loads it), an episode row with stills, Cast & Crew, More Like This.
- **Details page** (movie or episode): logo or title, metadata, badges (4K, HDR10+, Dolby Atmos, 5.1/7.1, CC/SDH), summary, and one line that says what will happen when you press Play (direct play or converted audio, which track, and why). Buttons: Resume / Play, Start Over, Trailer, Audio & Subtitles, Version, Mark Watched, Info (full technical sheet). Rows below: Chapters (press one to start there), the rest of the season, Cast & Crew (press a person for their films in your library), Extras, More Like This.
- **Ratings** on the top shelf, show and details pages: IMDb, Rotten Tomatoes (Tomatometer and audience), Metascore (critics), Metacritic user score, and Letterboxd (movies). See *Online services* below for where each comes from.
- **Cast & Crew** like Apple TV: every actor with their role, then directors, writers and producers (one card per person, all their jobs listed). Press a person to see everything in your libraries they acted in, directed, wrote or produced, movies and shows together, newest first.
- **Artwork from the internet**: with a TMDB key, titles get TMDB's logo when Plex has none, a TMDB backdrop when Plex has no background art, and a TMDB poster for cards with no poster.
- **Search** with a one-line on-screen keyboard (tvOS style); results update as you type.
- **Settings**: Plex Home user switching (with PIN pad), server, TrueHD mode, preferred audio language, subtitle mode/language/size/colour/style/position, autoplay next episode, auto-skip intros, picture size, sound setup help and a remote-control cheat sheet.

### Playback rules (unchanged)
- Signs in with a PIN at plex.tv/link or by scanning a QR code with a phone, finds your servers, and prefers a local connection over Plex Relay.
- **Video is never transcoded**, so HDR10+ survives. The only server work ever requested is audio conversion with the video copied untouched.
- **TrueHD handling** (Settings, default *Auto*):
  - *Auto*: if the file also has an E-AC3 or AC3 track in the same language (often E-AC3 Atmos on remuxes from streaming sources), use that. Otherwise send TrueHD as-is.
  - *Always send as-is*: try passthrough every time.
  - *Always convert*: the server converts the audio to E-AC3 5.1. The video stays untouched, so HDR10+ is kept, but the Atmos height channels are lost.
- DTS tracks: another track in the same language is used if there is one, otherwise the server converts the audio.
- If direct play fails to open, the app retries once with the audio converted.
- Reports progress to Plex (resume points and watched status).
- **Remembers each title on the TV too**: where you stopped, the version, the audio track, and the subtitle you picked (including a downloaded one, which is kept on the TV so a replay doesn't use your download quota). Resume uses whichever is newer, the TV's record or the server's, so it still works when a progress report didn't reach the server or a Plex Home user doesn't sync. Playing from the start or finishing a title clears its resume point.

### The player
A translucent overlay in the Apple TV layout: title and badges, a timeline with chapter ticks and intro/credits segments, elapsed and remaining time, the current chapter name and "Ends at" time. Video is drawn by the TV on a hardware plane under the page, so the overlay uses dark gradients rather than blur (the page cannot blur the video plane).

| Key | Action |
|---|---|
| OK | Play / pause. When **Skip Intro** or **Up Next** is on screen, OK presses it |
| ◀ / ▶ | Back 10 s / forward 30 s. **While paused**: scrub with preview thumbnails (holding speeds up), OK jumps there, Back cancels |
| ▼ or Info | Panel with tabs: **Info**, **Chapters**, **Audio**, **Subtitles**, **Picture** |
| ▲ | Show the timeline |
| CH ▲ / CH ▼ | Next / previous chapter (±60 s if the file has no chapters) |
| **Yellow** | Switch between direct play and audio conversion at the current position. Use it if a TrueHD track plays silent |
| **Blue** / **Green** / **Red** | Audio tab / Subtitles tab / Picture tab |
| Back | Close the panel, or stop |

- **Skip Intro** appears during Plex intro markers (or skips by itself if you turn that on). **Up Next** appears at the credits marker (or 30 s before the end) with a 10 s countdown; it keeps your subtitle language for the next episode.
- **Preview thumbnails** come from the server's video preview thumbnails (BIF). Turn on "Generate video preview thumbnails" in the Plex server settings if you don't see them.
- **Subtitles**: embedded text subtitles (direct play) and external SRT/ASS/SSA/VTT files, drawn by the app so size, colour, outline/box and position can be changed live. A delay of ±0.1 s steps. **Search online…** searches OpenSubtitles directly (like Infuse) and your server's own subtitle search, in your subtitle and audio languages. OpenSubtitles results matching your exact file come first: the app computes the OpenSubtitles file hash by reading 64 KB from each end of the file over the network. Picking one downloads it and shows it straight away. Forced-only / always / off modes with a preferred language pick a default track.
- **Picture**: original (letterbox), auto aspect ratio, or stretch to fill.

### Switching audio and subtitles during playback
Press **▼** (or **Info**) and move to the **Audio** or **Subtitles** tab, or jump there with **Blue** (audio) or **Green** (subtitles). Audio lists every track in the file (DTS is shown but converted by the server); switching inside a direct-played file is instant, otherwise playback restarts at the same point. Your choice is remembered for that title.

## Online services (optional, all free)
Enter keys in **Settings → Online services** with the on-screen keyboard, or put them in `app/js/keys.js` before building (copy `app/js/keys.example.js`; `keys.js` is git-ignored). Without keys the app works as before and uses only what Plex provides.

| Key | Get it at | Used for |
|---|---|---|
| TMDB | themoviedb.org → Settings → API (v3 key or v4 read token) | Logos, backdrops and posters missing from Plex |
| OMDb | omdbapi.com → API Key | IMDb rating, Metascore, Rotten Tomatoes when Plex doesn't have them |
| OpenSubtitles | opensubtitles.com → Profile → API consumers | Online subtitle search and download. Add your username and password to raise the daily download limit |

Where the ratings come from:
- **IMDb and Rotten Tomatoes**: Plex's own ratings first (when your server's agent provides them), then OMDb.
- **Metascore (critics)**: OMDb, or Metacritic's page.
- **Metacritic user score** and **Letterboxd**: no public API exists, so the app reads the public Metacritic and Letterboxd pages for the title and pulls the score out. This works as long as those sites keep their page layout; if they change it, that score just doesn't show. Letterboxd is looked up by TMDB id, so it needs the title matched by Plex's movie agent.

Ratings are cached for 7 days and artwork indefinitely, so browsing doesn't repeat requests.

## Infuse feature parity

| Infuse feature | Here | Notes |
|---|---|---|
| Artwork-first browsing, top shelf, details with cast, extras, related | Yes | |
| Continue watching, Up Next autoplay, Skip Intro / credits | Yes | Uses Plex markers; your server must have intro/credits detection on |
| Library sort, filters, genres, collections, search | Yes | |
| Chapters (menu, timeline ticks, chapter skip) | Yes | |
| Scrubbing with thumbnails | Yes | Needs server preview thumbnails |
| Audio and subtitle track switching | Yes | Embedded subtitles in direct play; external files always |
| Subtitle styling, delay, forced subtitles, preferred languages | Yes | Delay for embedded subtitles uses AVPlay's `setSubtitlePosition`, not checked on the QN900B yet |
| Download subtitles (OpenSubtitles) | Yes | Direct OpenSubtitles search with file-hash matching, plus your server's subtitle search. Needs a free OpenSubtitles API key |
| Ratings (IMDb, Rotten Tomatoes, Metacritic, Letterboxd) | Yes | Metacritic user score and Letterboxd are read from their web pages (no API) |
| Artwork from TMDB | Yes | Needs a free TMDB key |
| Per-title memory (position, audio, subtitle) | Yes | Stored on the TV and in Plex |
| Cast & crew with filmographies | Yes | Limited to your libraries, like Infuse |
| Multiple versions, Plex Home users, watched sync | Yes | |
| HDR10+ / HDR10 / HLG, native frame rate | Yes | The TV decodes the file itself, so HDR and frame rate always match the source |
| Aspect / zoom modes | Partly | Letterbox, auto and stretch. AVPlay has no crop-zoom mode |
| **Dolby Vision** | **No** | No Samsung TV supports it. Profile 7/8 play their HDR10 base layer |
| **DTS / DTS-HD / DTS:X passthrough** | **No** | Samsung TVs from 2018 on can't decode or pass DTS. Server converts to E-AC3 |
| **Lossless TrueHD Atmos** | **Not guaranteed** | The TV firmware decides what leaves the eARC port; E-AC3 Atmos is reliable |
| **Image subtitles (PGS, VobSub)** | **No** | AVPlay only hands text subtitles to apps. Showing them would need the server to burn them in, which re-encodes the video and loses HDR10+ |
| **Audio delay / lip sync** | **No (in app)** | AVPlay has no audio offset. Use the TV's Settings → Sound → Expert Settings → Digital Output Audio Delay |
| **Playback speed** | **No** | AVPlay's speed control is trick-play only and mutes the audio |
| Picture-in-picture | No | The TV gives one app one 4K video decoder |
| Downloads / offline | No | Tizen apps can't store large media |
| SMB/NFS/WebDAV shares, cloud drives | No (out of scope) | This is a Plex client; Tizen web apps can't mount network shares |
| Trakt scrobbling | Not added | Plex keeps watched status; Trakt would need a Trakt API app and sign-in |
| Music, photos, Live TV | Not added | |

## Live TV (IPTV)

The **Live TV** tab works with or without Plex. Without a Plex account, choose *Live TV only* on the sign-in screen.

- **Sources:** M3U playlists and Xtream Codes logins. Several sources can be on at once, and each gets a coloured dot. To skip typing with the remote, copy `app/js/iptvconfig.example.js` to `app/js/iptvconfig.js` (not committed) before building.
- **Sections:** Home, Live TV, TV Guide, Movies, Series, Favorites, Search, Downloads, Recordings and Playlists.
- **Home:** Continue Watching, recently watched channels, trending channels (your most-watched this week), favourite channels, and trending movies and series. Trending movies and series come from TMDB's weekly list matched to your sources when a TMDB key is set, and are the best-rated new additions otherwise.
- **Live TV:** groups, channels with now-playing and progress, and a muted preview of the focused channel. Quality tags (4K, FHD, HD, SD, HDR, 5.1, Stereo, HEVC) are read from the names and then corrected from the real stream after a channel plays. You can filter by tag. INFO (or green) opens favourite, rename, record, hide group and PIN lock.
- **TV Guide:** XMLTV guide (gzip too), catch-up for past programmes (default, append, shift, flussonic and Xtream timeshift), reminders, record and download.
- **Player:** up and down or CH± to zap, number keys to tune, a channel list on the left, and audio, subtitles, record and picture on the right. It reconnects when a stream drops.
- **Movies and Series:** groups, sorting, details from Xtream, resume, favourites and downloads.
- **Search:** by channel name or by TV programme, with quality tags.
- **Downloads and Recordings:** saved to `Downloads/Lumen` on the TV while Lumen is open. HLS channels are recorded segment by segment.

## Install on the TV (developer mode)

### 1. Set up a computer (Windows, macOS or Linux)
1. Install **Tizen Studio** from developer.samsung.com/smarttv. The CLI version is enough.
2. Open **Package Manager**:
   - Under *Main SDK*, install **Tizen SDK tools**.
   - Under *Extension SDK*, install **Samsung Certificate Extension** and **TV Extensions 6.5** (or the newest TV extension listed).
3. Add `tizen-studio/tools` and `tizen-studio/tools/ide/bin` to your `PATH`, so that `sdb` and `tizen` run.

### 2. Put the TV in developer mode
1. Make sure the TV and the computer are on the same network.
2. On the TV, open **Apps**, then enter **1 2 3 4 5** with the remote's number pad (on-screen if your remote has no digits).
3. Turn **Developer mode** on and enter your computer's IP address.
4. Restart the TV: hold the power button until the Samsung logo appears.
5. Find the TV's IP address under Settings → General → Network → Network Status → IP Settings.

### 3. Create a Samsung certificate (once)
Retail Samsung TVs only install apps signed with a Samsung certificate that names the TV.

1. Run `sdb connect <TV-IP>`. `sdb devices` should list the TV.
2. Open **Certificate Manager** (`tizen-studio/tools/certificate-manager`) and add a profile named **PlexHDR**:
   - Type: **Samsung**, device type **TV**
   - Sign in with a Samsung account when asked
   - Author certificate: create a new one
   - Distributor certificate: privilege level **Public**. Leave the TV's DUID ticked; it's read from the connected TV.

### 4. Build and install
```bash
cd tizen-plex
TIZEN_PROFILE=PlexHDR ./scripts/build.sh <TV-IP>
```
This packages `app/` into `Lumen.wgt`, signs it with your profile and installs it. **Lumen** then appears under Apps on the TV.

If you'd rather use the Tizen Studio GUI, import `app/` as a Tizen web project, then use Run As → Tizen Web Application with the TV selected.

### 5. Set up the TV and soundbar for passthrough
- Settings → Sound → Sound Output → **Receiver (HDMI-eARC)**, with the Q990C on the TV's eARC port.
- Settings → Sound → Expert Settings:
  - **HDMI-eARC Mode** → Auto
  - **Digital Output Audio Format** → Passthrough (or Auto)
- Check what arrives by watching the soundbar's display at the start of playback. It shows "Dolby Atmos" for an Atmos bitstream.

### 6. Plex server
Direct play of 4K remuxes needs a local connection. If the app warns you about Relay, check that the TV can reach the server on your LAN. In the server settings, *Secure connections: Preferred* works fine. The audio conversion fallback uses the server's normal transcoder, which only converts audio and stays light on the CPU.

## Testing it without a TV
Serve the `app/` folder (for example with `python3 -m http.server`) and open it in Chrome. The app falls back to an HTML5 `<video>` player there, so you can check sign-in and browsing. 4K HEVC, TrueHD and HDR obviously don't play in a desktop browser.

Keyboard controls in the browser:

| Key | Action |
|---|---|
| Arrow keys / Enter | Navigate and select |
| Esc | Back |
| Space | Play / pause |
| Y / B / G / R | Yellow / Blue / Green / Red |
| I | Info |
| Page Up / Page Down | CH ▲ / CH ▼ |

## How the code is laid out
| File | Role |
|---|---|
| `app/config.xml` | Tizen manifest (package `PlxHDRtzn0`, TV profile, privileges) |
| `app/js/plex.js` | plex.tv sign-in, server discovery, library API, direct play / audio-transcode URLs, progress reporting |
| `app/js/decide.js` | The rules from the table above: what plays direct, which audio track, when to convert |
| `app/js/player.js` | AVPlay engine (HTML5 fallback), track mapping, seeking and scrubbing, the overlay and its panel, Skip Intro, Up Next, auto-retry |
| `app/js/subs.js` | Parses external SRT/VTT/ASS subtitles and finds the cue for a time |
| `app/js/bif.js` | Reads Plex preview thumbnail (BIF) files |
| `app/js/online.js` | TMDB artwork, OpenSubtitles (hash, search, download), ratings from Plex, OMDb, Metacritic and Letterboxd |
| `app/js/memory.js` | Per-title memory on the TV: position, version, audio track, subtitle |
| `app/js/keys.example.js` | Template for build-time API keys (`keys.js`) |
| `app/js/ui.js` | Screens, the tab bar, the top shelf, rows, sheets, and remote-control focus navigation |
| `app/js/iptv.js` | Live TV data: M3U, Xtream Codes and XMLTV parsing, catch-up addresses, quality tags, favourites, resume, trending and search (IndexedDB cache) |
| `app/js/iptvplayer.js` | Live TV player on AVPlay: zapping, channel list, tracks, reconnect, and the muted preview |
| `app/js/iptvrec.js` | Downloads and recordings to the TV's Downloads folder |
| `app/js/iptvui.js` | The Live TV screens |
| `app/js/iptvconfig.example.js` | Template for playlists added on first launch (`iptvconfig.js`) |
| `app/css/style.css` | The Apple TV-style look and animations |
| `app/js/main.js` | Key registration and routing |
| `scripts/build.sh` | Package, sign, install |

## What has and hasn't been checked
- Live TV: in headless Chromium against a fake M3U, Xtream Codes and XMLTV server, every Live TV section was opened and screenshotted, along with channel options, the guide grid, movie and series pages, search by channel and by programme with a tag filter, and the player overlay and channel list. Not checked yet on the TV: AVPlay preview and muting (`tvaudiocontrol`), writing recordings through `tizen.filesystem`, playing a downloaded file, and real providers' catch-up.
- Checked: all the JavaScript parses and stays ES5 (Tizen 6.5's browser). In headless Chromium against a mocked Plex server, these flows were run and screenshotted: home top shelf and rows, tab bar, library grid with filters, show page with seasons and episodes, details with badges and plan line, Audio & Subtitles sheet, cast & crew → person page (actor, director, writer across movies and shows), ratings chips, TMDB logo, search, settings, Plex Home user switch with PIN pad, playback with the overlay, scrubbing with BIF thumbnails, every panel tab, external subtitles, Skip Intro (jumped to the marker end) and Up Next (played the next episode). With TMDB, OMDb, Metacritic, Letterboxd and OpenSubtitles replaced by fake responses: OpenSubtitles search sent the file hash, the download showed on screen, stopping saved the position and subtitle, and replaying resumed at the saved point with the downloaded subtitle back on.
- **Not yet checked on a real TV.** Things that need a first run on the QN900B:
  1. That AVPlay lists audio tracks in the same order as Plex. The app relies on this to switch tracks inside a file.
  2. That the audio-only transcode URL is accepted by your server version.
  3. What the Q990C actually receives for TrueHD.
  4. Animation smoothness on the TV's GPU (all motion is transforms and opacity; if anything stutters, it is most likely the backdrop cross-fade).
  5. The server subtitle search/save calls (`/library/metadata/{id}/subtitles`), and `setSubtitlePosition` for embedded subtitle delay.
  6. The real TMDB, OMDb and OpenSubtitles services (built to their documented APIs, but only run against fakes here).
  7. The Metacritic user score and Letterboxd readers. They were written against those sites' page markup but couldn't be run against the live sites from here, so they may need adjusting after a first run.
  8. That the Plex server answers byte-range requests from the TV for the OpenSubtitles hash (it should; Plex supports ranges for direct play).
