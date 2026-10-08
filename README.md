# Playlist Plus (Spotify mod)

A [Spicetify](https://spicetify.app) extension for the **Spotify desktop app** that adds:

1. **Song trimming.** Set a custom start and/or end point for any song. Spotify jumps to your start point and skips to the next song at your end point, wherever the song plays.
2. **Timed sessions.** Pick a total length (say 50 minutes) and split it into phases, each with its own playlist:

   | Phase     | Playlist           | Time            |
   |-----------|--------------------|-----------------|
   | Warm-up   | *My warm-up songs* | 6 minutes       |
   | Normal    | *Running mix*      | 36 minutes      |
   | Cool-down | *Chill*            | remaining time  |

   Press **Start**. Each phase plays songs from its playlist for its share of the time, then moves to the next phase. The session stops when the time is up. When a phase boundary cuts a song short, the song fades out.

## Install

You need the Spotify **desktop** app (Windows, macOS or Linux). Spicetify can't modify the phone app.

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

## Use

### Trim a song
Right-click a song, choose **Trim song…**, and enter a start and/or end time (`m:ss`). If the song is playing, **Use current position** fills in the current playback position. **Preview start** and **Preview end** let you check the cut points.

To see, edit, back up or import all your trims, open the **Playlist Plus** button (the clock icon in the top bar) and go to the **Trimmed songs** tab.

### Timed session
1. Click the **Playlist Plus** clock icon in the top bar.
2. Set the session length, then give each phase a playlist (choose one from your library or paste a link) and an amount of time:
   - **minutes**: a fixed length.
   - **% of total**: a share of the session length.
   - **remaining time**: whatever the other phases don't use. If several phases use this, they split it equally. If no phase uses it, any leftover time goes to the last phase.
3. Choose **Preview plan** to see which songs will play and when, or **Start session**.

While a session runs, a small panel above the player shows the current phase, the time left in the phase and in the session, and **Next song / Next phase / Stop** buttons.

Notes:
- The session timer counts listening time only. It pauses when the music pauses.
- **Smart fit** picks songs that finish before the phase ends when it can, so fewer songs get cut off.
- Trims apply inside sessions too. Settings lets you turn that off, change the fade length, or turn trims off entirely.
- If you skip a song or start something else in Spotify, the session plays its next planned song. Press **Stop** to leave a session.
- Sessions are saved as **templates**. Use **Duplicate** to make variants, for example a 30-minute version.
- Everything is stored locally in your Spotify client. Nothing is uploaded anywhere.

## Development

The playback logic (time budgets, track planning, the session runner and the trim watcher) is pure JavaScript at the top of `playlist-plus.js`. It is unit-tested in Node against a simulated player:

```sh
npm test
```

## Disclaimer

Spicetify modifies the Spotify desktop client. Spotify's terms don't allow client modifications, but Spicetify is widely used. You use it at your own risk. This mod uses your normal Premium playback and doesn't bypass anything.
