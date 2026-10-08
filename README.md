# Playlist Plus (Spotify mod)

Adds two things Spotify doesn't have:

1. **Song trimming.** Set a custom start and/or end point for any song. Spotify jumps to your start point and skips to the next song at your end point.
2. **Timed sessions.** Pick a total length (say 50 minutes) and split it into phases, each with its own playlist:

   | Phase     | Playlist           | Time            |
   |-----------|--------------------|-----------------|
   | Warm-up   | *My warm-up songs* | 6 minutes       |
   | Normal    | *Running mix*      | 36 minutes      |
   | Cool-down | *Chill*            | remaining time  |

   Press **Start**. Each phase plays songs from its playlist for its share of the time, then moves to the next phase. The session stops when the time is up.

It comes in two versions that share the same playback logic:

- **[iPhone / Android](#phone-iphone-android):** a web app you add to your home screen. It remote-controls the Spotify app on your phone.
- **[Desktop](#desktop-windows-macos-linux):** a [Spicetify](https://spicetify.app) extension that runs inside the Spotify desktop app.

## Phone (iPhone, Android)

Apple doesn't allow modifying the Spotify app on iPhone. So the phone version is a separate web app that controls Spotify through Spotify's official remote-control API (the same API "Spotify Connect" remotes use). Spotify Premium is required.

### One-time setup

1. **Turn on hosting** (repository owner, once): on GitHub, open this repository's **Settings → Pages** and set **Source** to **GitHub Actions**. Then re-run the latest "Deploy phone app to GitHub Pages" workflow under **Actions**, or push any commit. The app is published at **https://dimssen.github.io/spotify-mod/**.
2. **Create a Spotify app key.** Spotify requires every app to have one, and it's free. Open the web app; it shows these steps too.
   1. Go to [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and log in.
   2. **Create app**. Any name and description will do.
   3. Under **Redirect URIs**, add `https://dimssen.github.io/spotify-mod/` exactly.
   4. Under **APIs used**, tick **Web API**, then save.
   5. Copy the **Client ID** into the web app, then tap **Connect Spotify**.
3. **Add it to your home screen:** in Safari, tap **Share → Add to Home Screen**. It then opens full-screen like a normal app.

### Use

- **Timed session:** open the **Session** tab. Tap each phase's playlist to pick one from your library, and set its time (**Minutes**, **Percent** or **Rest**). Then tap the green play button. The list icon next to it previews the plan first. During the session the screen shows a big countdown, the phase timeline, the current song and controls, and stays awake.
- **Trim a song:** play it in Spotify, open the **Trims** tab, and tap **Trim** on the "Now playing" card. Drag the two handles, or tap **Start here** / **End here** while you listen. You can also open one of your playlists below and tap any song.
- **Copy trims from desktop:** in the desktop extension's **Trimmed songs** tab, use **Export**. Send yourself the text and use **Import** on the phone. The phone app has the same export and import, and both versions use the same format.

### Phone limitations (from iOS and Spotify, not fixable in the app)

- **The app has to be open for trims and exact phase timing.** iOS pauses web apps that are in the background or when the screen locks. During a session the app keeps the screen on for this reason, so leave it open (a phone on an armband or a treadmill works fine).
  - If you lock the phone anyway, Spotify keeps playing the planned songs in order, so the music still moves through warm-up, normal and cool-down. While the phone is locked, songs play untrimmed and phase changes happen at song boundaries. When you open the app again it catches up.
  - Outside sessions, trims only apply while the app is open.
- **Only playlists you created or collaborate on can be used.** Since February 2026, Spotify doesn't let personal apps read other people's playlists, including Spotify's own. To use one, create a playlist and add its songs to it (select all, then **Add to playlist**).
- **No fade-out on iPhone.** iPhones don't allow remote volume control, so cut songs stop without fading. Fades work when Spotify plays on a computer or speaker.
- **Trims and templates are stored per device.** Use Export and Import to copy them across.

## Desktop (Windows, macOS, Linux)

### Install

1. **Install Spicetify** (skip this if you already have it):
   - Windows (PowerShell): `iwr -useb https://raw.githubusercontent.com/spicetify/cli/main/install.ps1 | iex`
   - macOS / Linux: `curl -fsSL https://raw.githubusercontent.com/spicetify/cli/main/install.sh | sh`
2. **Copy `playlist-plus.js` into Spicetify's `Extensions` folder:**
   - Windows: `%appdata%\spicetify\Extensions\`
   - macOS / Linux: `~/.config/spicetify/Extensions/`

   (`spicetify path userdata` prints the exact folder.)
3. **Enable it and apply:**
   ```sh
   spicetify config extensions playlist-plus.js
   spicetify backup apply      # first time; afterwards just: spicetify apply
   ```

Spotify updates undo Spicetify's changes. After an update, run `spicetify backup apply` again.

To uninstall, run `spicetify config extensions playlist-plus.js-` and then `spicetify apply`. To remove Spicetify completely, run `spicetify restore`.

### Use

#### Trim a song
Right-click a song and choose **Trim song…**. Drag the two handles on the timeline, or type the start and end times. If the song is playing, **Start here** and **End here** use the current position. **Play from start** and **Hear the end** let you check the cut points.

To see, edit, back up or import all your trims, open the **Playlist Plus** button (the clock icon in the top bar) and go to the **Trimmed songs** tab.

#### Timed session
1. Click the **Playlist Plus** clock icon in the top bar.
2. Set the session length, then give each phase a playlist (choose one from your library, or use the link button to paste one) and an amount of time:
   - **Min**: a fixed number of minutes.
   - **%**: a share of the session length.
   - **Rest**: whatever the other phases don't use. If several phases use this, they split it equally. If no phase uses it, any leftover time goes to the last phase.
3. Click the list icon to preview which songs will play and when, or the green play button to start.

While a session runs, a card above the player shows the current phase, a countdown, the phase timeline, the current song and **Stop / Play-pause / Next song / Next phase** controls.

Notes:
- The session timer counts listening time only. It pauses when the music pauses.
- **Smart fit** (the pulse icon) picks songs that finish before the phase ends when it can, so fewer songs get cut off, and it never ends a phase on a few-second scrap of a song. **Shuffle** (the shuffle icon) mixes each phase's playlist.
- Trims apply inside sessions too. Settings lets you turn that off, change the fade length, or turn trims off entirely.
- If you skip a song or start something else in Spotify, the session plays its next planned song. Press **Stop** to leave a session.
- Sessions are saved as **templates**. Use **Duplicate** to make variants, for example a 30-minute version.
- Everything is stored locally in your Spotify client. Nothing is uploaded anywhere.

## Development

- `playlist-plus.js`: the desktop extension. The top of the file is the shared core (time budgets, track planning, the session runner and the trim watcher). It's pure JavaScript with no Spotify dependencies.
- `web/`: the phone app (`index.html`, `app.js`). It loads the core from `playlist-plus.js` and talks to the Spotify Web API.
- `.github/workflows/pages.yml`: runs the tests, builds `_site/` and deploys it to GitHub Pages.

```sh
npm test            # core logic, tested against simulated desktop and phone players
npm run serve:web   # build and serve the phone app at http://127.0.0.1:8080
```

To log in to a local copy, add `http://127.0.0.1:8080/` as a Redirect URI in your Spotify app. Spotify accepts plain http only on 127.0.0.1.

## Disclaimer

The desktop version uses Spicetify, which modifies the Spotify desktop client. Spotify's terms don't allow client modifications, but Spicetify is widely used; you use it at your own risk. The phone version only uses Spotify's official Web API. Both use your normal Premium playback and don't bypass anything.
