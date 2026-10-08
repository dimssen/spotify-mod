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

### Smooth transitions (the default on phones)

iPhones don't let apps change Spotify's volume, and Spotify's crossfade only applies when a song ends by itself, never when an app skips it. So on a phone the smoothest session is one where no song gets cut. With **Transitions → Smooth**:

- Each phase ends where a song ends. Playlist Plus picks songs whose lengths add up to the phase's time, and tries several shuffles to find the closest fit. Any small difference carries over into the next phase, so the session as a whole ends on time; with reasonably sized playlists it's usually within seconds.
- Spotify gets the whole plan as one queue and plays it by itself, so **you can lock your phone**. When you come back, the app catches up to wherever Spotify got to.
- Turn on **Crossfade** in Spotify (Settings → Playback) and enter the same number of seconds in Playlist Plus → Settings. Every song change and phase change then fades smoothly, and the session stops cleanly at the end.
- Trimmed songs are the exception: jumping to a trim point needs the app. Playlist Plus starts a song with a trimmed start right at its trim point (you don't hear the intro first), and sends trim-end skips early enough to make up for network delay. If the phone is locked, trimmed songs simply play in full.
- Turn off **Autoplay** in Spotify if you lock your phone. Otherwise Spotify keeps playing similar songs after the session.

**Exact** transitions are still there if you want phases to change on the dot, but on an iPhone that means a hard cut, and the app must stay open.

If iOS closes the app in the background, the session isn't lost: reopening the app picks it up again (or offers to resume it).

### Use

- **Timed session:** open the **Session** tab. Tap each phase's playlist to pick one from your library, and set its time (**Minutes**, **Percent** or **Rest**). Then tap the green play button. The list icon next to it previews the plan first. During the session the screen shows a big countdown, the phase timeline, the current song and controls, and stays awake.
- **Trim a song:** play it in Spotify, open the **Trims** tab, and tap **Trim** on the "Now playing" card. Drag the two handles, or tap **Start here** / **End here** while you listen. You can also open one of your playlists below and tap any song.
- **Sync with your computer:** see [Sync](#sync-between-phone-and-computer) below.

### Phone limitations (from iOS and Spotify, not fixable in the app)

- **Trims need the app open.** iOS pauses web apps in the background. Smooth sessions don't need the app at all, apart from trimmed songs; outside sessions, trims only apply while the app is open. During a session the app keeps the screen on.
- **Only playlists you created or collaborate on can be used.** Since February 2026, Spotify doesn't let personal apps read other people's playlists, including Spotify's own. To use one, create a playlist and add its songs to it (select all, then **Add to playlist**).
- **No volume fades on iPhone.** iPhones don't allow remote volume control. Use Smooth transitions with Spotify's own crossfade instead (see above). Volume fades work when Spotify plays on a computer or speaker.
- **Sync needs the app open:** devices sync when Playlist Plus is open (on launch, when you come back to it, after each change and every minute), not in the background.

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
The desktop app can fade the volume, so its default is **On time**: phases change exactly on the minute and the playing song fades out. Choose **Between songs** for the phone-style smooth mode.

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

## Sync between phone and computer

Your trims and sessions (templates) can stay the same on every device: trim a song on your computer and it's trimmed on your phone too. They're kept in a **secret GitHub Gist** in your own GitHub account, so no server is involved.

1. On any device, [create a GitHub token](https://github.com/settings/tokens/new?scopes=gist&description=Playlist%20Plus%20sync). The link pre-selects only the **gist** permission, so the token can't access anything else. Choose a long expiration, click **Generate token** and copy it.
2. Phone: **Settings → Sync with your other devices**, paste the token, **Connect**. Desktop: **Playlist Plus → Settings → Sync**, paste the token, **Connect**.
3. Use the same GitHub account (the same token works) on every device.

How it behaves:

- Each trim and session remembers when it was last changed. Syncing keeps the newest version of each one, and deletions sync too, so devices can be edited separately (even offline) without losing changes.
- Devices sync when Playlist Plus opens, when you switch back to it, a moment after every change, and every minute while it's open. **Sync now** forces it.
- Synced: trims and session templates. Not synced: device settings (crossfade, fades), which session is selected, and your Spotify login.
- The gist is secret (not listed or searchable), but anyone with its link could read it. It only holds song IDs, trim times and session settings.
- **Stop syncing** disconnects a device; it keeps its current copy. To remove everything, delete the "Playlist Plus sync" gist on GitHub.

Export/Import (phone: Settings → Backup, desktop: Trimmed songs) still works for one-off copies without GitHub.

## Development

- `playlist-plus.js`: the desktop extension. The top of the file is the shared core (time budgets, track planning, the session runner, the trim watcher, and sync: merging, the local store and the Gist client). It has no Spotify dependencies.
- `web/`: the phone app (`index.html`, `app.js`). It loads the core from `playlist-plus.js` and talks to the Spotify Web API.
- `.github/workflows/pages.yml`: runs the tests, builds `_site/` and deploys it to GitHub Pages.

```sh
npm test            # core logic, tested against simulated desktop and phone players
npm run serve:web   # build and serve the phone app at http://127.0.0.1:8080
```

To log in to a local copy, add `http://127.0.0.1:8080/` as a Redirect URI in your Spotify app. Spotify accepts plain http only on 127.0.0.1.

## Disclaimer

The desktop version uses Spicetify, which modifies the Spotify desktop client. Spotify's terms don't allow client modifications, but Spicetify is widely used; you use it at your own risk. The phone version only uses Spotify's official Web API. Both use your normal Premium playback and don't bypass anything.
