# Plex HDR for Tizen

A small Plex client for Samsung Tizen TVs, built for a QN900B with a Q990C soundbar. It has one job: send the original file to the TV untouched (direct play), so the TV's own decoders handle HDR10+, and send Dolby audio to the soundbar wherever the TV allows it.

It is a sideloaded Tizen web app. It plays through Samsung's AVPlay API, the same native media pipeline Samsung's own apps use.

## What the hardware allows

| Goal | Possible? | Why |
|---|---|---|
| **HDR10+ video** | **Yes** | HDR10+ metadata is carried inside the HEVC stream. AVPlay passes the stream to the TV's hardware decoder, which reads the metadata. It only survives if the server doesn't re-encode the video, so this app never asks for a video transcode. |
| HDR10 / HLG | Yes | Same path. |
| **Dolby Vision** | **No** | No Samsung TV supports Dolby Vision. Profile 7 and 8 files play their HDR10 base layer and look correct. Profile 5 files have no HDR10 layer, so the colours come out wrong. The app warns you about those. |
| **Dolby Atmos via E-AC3 (DD+ Atmos)** | **Yes, reliably** | The TV passes E-AC3 Atmos to the soundbar over eARC. This is the format streaming services use. |
| **Dolby TrueHD / TrueHD Atmos** | **Can't be guaranteed: the TV firmware decides** | An app can hand TrueHD to the TV, but the TV firmware decides what leaves the eARC port. User reports for 2021–2022 Samsung TVs, including a QN900B, say TrueHD from built-in apps doesn't arrive as a bitstream: you get silence, PCM, or a forced transcode ([Plex forum](https://forums.plex.tv/t/still-no-dolby-atmos-on-samsung-tv/825774), [another thread](https://forums.plex.tv/t/cannot-stream-truehd-to-samsung-tv/547058)). No app API can override this. The app tries it and gives you a one-button fallback. |
| DTS / DTS-HD / DTS:X | **No** | Samsung TVs from 2018 on can't decode DTS or pass it through. The app picks another track in the same language, or has the server convert the audio. |

**Bottom line:** HDR10+ works. Atmos works when the file has an E-AC3 Atmos track. Lossless TrueHD Atmos to the Q990C depends on Samsung's firmware, so try it on your TV. The only route that reliably delivers TrueHD Atmos is a player with real passthrough, such as an Nvidia Shield or Apple TV, plugged into a TV HDMI input. The TV then forwards TrueHD over eARC to the soundbar. (An Apple TV outputs PCM, not a TrueHD bitstream; a Shield passes TrueHD through.)

## What the app does

- Signs in with a PIN at plex.tv/link, finds your servers, and prefers a local connection over Plex Relay.
- Shows Continue Watching, your movie and TV libraries, seasons, episodes, and a details page that explains what will happen before you press Play:
  - **Video:** codec and HDR type (HDR10+, HDR10, DV profile)
  - **Audio:** which track is used and whether it's sent as-is or converted
  - **Plan:** direct play, or video copied untouched with only the audio converted
- **TrueHD handling** (Settings, default *Auto*):
  - *Auto*: if the file also has an E-AC3 or AC3 track in the same language (often E-AC3 Atmos on remuxes from streaming sources), use that. Otherwise send TrueHD as-is.
  - *Always send TrueHD as-is*: try passthrough every time.
  - *Always convert*: the server converts the audio to E-AC3 5.1. The video stays untouched, so HDR10+ is kept, but the Atmos height channels are lost.
- **During playback:**

  | Key | Action |
  |---|---|
  | **Yellow** | Switch between direct play and audio conversion at the current position. Use it if a TrueHD track plays silent. |
  | **Blue** | Choose the audio track or embedded subtitles. |
  | OK | Play / pause |
  | ◀ / ▶ | Back 10 s / forward 30 s |
  | ▲ / ▼ | Forward / back 60 s |
  | Back | Stop |

- If direct play fails to open, the app retries once with the audio converted.
- Reports progress to Plex (resume points and watched status) and lets you pick between multiple versions of a film.

**Not included yet:** image subtitles (PGS/VobSub) and external subtitle files (only embedded text subtitles in direct play), music and photo libraries, search, Plex Home user switching.

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
This packages `app/` into `PlexHDR.wgt`, signs it with your profile and installs it. **Plex HDR** then appears under Apps on the TV.

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
| Y | Yellow |
| B | Blue |

## How the code is laid out
| File | Role |
|---|---|
| `app/config.xml` | Tizen manifest (package `PlxHDRtzn0`, TV profile, privileges) |
| `app/js/plex.js` | plex.tv sign-in, server discovery, library API, direct play / audio-transcode URLs, progress reporting |
| `app/js/decide.js` | The rules from the table above: what plays direct, which audio track, when to convert |
| `app/js/player.js` | AVPlay engine (HTML5 fallback), track mapping, seeking, Yellow/Blue handling, auto-retry |
| `app/js/ui.js` | Screens and remote-control focus navigation |
| `app/js/main.js` | Key registration and routing |
| `scripts/build.sh` | Package, sign, install |

## What has and hasn't been checked
- Checked: all the JavaScript parses. In headless Chromium against a mocked Plex server, the full flow was run: sign-in → server → home → details → play → fallback. The details page chose the E-AC3 Atmos track over TrueHD as designed.
- **Not yet checked on a real TV.** Three things need a first run on the QN900B:
  1. That AVPlay lists audio tracks in the same order as Plex. The app relies on this to switch tracks inside a file.
  2. That the audio-only transcode URL is accepted by your server version.
  3. What the Q990C actually receives for TrueHD.
