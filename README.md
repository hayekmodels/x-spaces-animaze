# x-spaces-animaze — active-speaker probe

This repo currently holds one experiment. It tries to answer one question:

> Can a Chrome extension reliably identify the **active speaker** in the X Space currently open in Chrome?

It doesn't include Animaze, the X API, xspaces.to, OBS or a desktop app. It's a minimal Manifest V3 extension (`extension/`) with no dependencies and no bundler.

## What it does

| Piece | File | What it does |
|---|---|---|
| Participant discovery | `content.js` | Finds the Space's participant tiles from content X has to render: profile-image URLs (`/profile_images/`), role badge text (`Host`, `Co-host`, `Speaker`, `Listener`) and `@handles`. It doesn't hard-code any X CSS class or `data-testid`. |
| Diagnostic panel | `content.js` | Fixed panel in the bottom-left of the X tab, showing `ACTIVE SPEAKER`, `AUDIO LEVEL` and one row per host/speaker (`@bob  SPEAKER  SPEAKING`). |
| Console events | `content.js` | `[XSA] SPEAKER_STARTED @bob` / `[XSA] SPEAKER_STOPPED @bob` |
| OBSERVE mode | `content.js` | A MutationObserver on the Space root records every attribute, class, style, child and text change, tagged with the participant tile it happened in and the current audio level. A 250 ms sampler fingerprints every tile and ranks the features that switch on and off as **speaking-signal candidates**. |
| Tab audio level | `background.js`, `offscreen.html/js` | Clicking the toolbar icon runs `chrome.tabCapture.getMediaStreamId` and passes the id to an offscreen document. That document calls `getUserMedia({chromeMediaSource:'tab'})` and feeds the stream into an `AnalyserNode`, which gives an RMS level mapped to 0–1 (−60 dBFS → 0, 0 dBFS → 1) at about 20 updates/s. The stream is also connected to `AudioContext.destination`, so you keep hearing the Space. |

### Why the speaking signal isn't hard-coded

We don't know what X changes in the DOM when someone talks. It could be a class, an inline style, an animation or an extra element. Instead of guessing, the probe measures it:

1. Every tile is turned into a set of **features**. Each feature is keyed by the element's child-index path from the tile root:
   - `T>div:0>div:1 .r-abc123`: class token present
   - `T>div:0 [aria-label=…]` / `[attr]`: attribute value, or attribute present
   - `T>div:0 style:opacity=1`: inline style
   - `T>div:0 anim:pulse`: running CSS animation or transition (`getAnimations()`)
   - `T>div:0>div:2`: element exists
2. A feature that appears and disappears inside tiles is tracked. For each one, the probe compares the mean tab-audio level while the feature is present on any tile with the mean while it's absent on all tiles. That difference is **audioΔ**.
3. The candidates with the highest audioΔ and toggle count are listed in the panel. Clicking **use** makes that feature the speaking signal. It's stored in `chrome.storage.local`.
4. With a signal chosen, a tile is `SPEAKING` while the feature is present. It becomes `IDLE` after the feature has been absent for 400 ms (`holdMs`).

If no candidate is convincing, **Export** downloads a JSON file with every recorded mutation, feature statistics, the audio-level timeline and each tile's `outerHTML`, so we can analyse it offline.

## Build

```bash
npm run check   # validate manifest, referenced files, JS syntax
npm run build   # check + copy to dist/x-spaces-probe/ + dist/x-spaces-probe-0.1.0.zip
```

Nothing needs installing. You can also load `extension/` directly, without building.

## Load it in Chrome (Chrome 116 or newer)

1. Get the files onto the machine that runs Chrome: `git clone` this repo, check out the branch, then `npm run build` (optional).
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the `extension/` folder (or `dist/x-spaces-probe/`).
5. Pin **X Spaces Active Speaker Probe** from the puzzle-piece menu so its icon is visible.

## Test against the live Space you already have open

You don't need to reload the X tab, so you won't drop out of the Space.

1. Switch to the X tab with the Space playing.
2. **Expand the Space** so the full participant view is visible, with avatars and the `Host` / `Speaker` badges. The small docked player isn't enough.
3. **Click the extension's toolbar icon once.** This:
   - injects the probe into the already-open tab, so the panel appears bottom-left;
   - starts tab-audio capture: the badge turns green `ON` and `AUDIO LEVEL` starts moving.

   You should keep hearing the Space. If it goes silent, note that; it's one of the results we're after.
4. Open DevTools on the X tab (F12) → **Console**. Type `XSA` in the filter box to see `[XSA] participants …`, `[XSA] observing Space root …` and so on.
5. Check the panel:
   - `Space:` shows the Space id, if it's in the URL or a link.
   - `Root: auto, N labeled tile(s)` means the participant list was found. The rows should list your hosts and speakers with display name, @handle and role.
   - If `Root: not found`, click **Pick root**, hover the participant list (a yellow outline shows the choice) and click it.
6. Click **OBSERVE: off** to turn it **on**. Grey outlines now show each detected tile, and a blue outline shows the root.
7. Wait **1–2 minutes** while people talk, ideally with several different speakers and some pauses. Watch **Speaking-signal candidates** and **Recent tile mutations**.
8. A good candidate has a clearly positive **audioΔ**, many toggles, and a low `%on`, because at any moment only one or two tiles are speaking. Click **use** on it.
9. Check it: the row should say `SPEAKING` for the person you can hear, the tile outline turns green, the panel shows `ACTIVE SPEAKER: @name`, and the console prints `SPEAKER_STARTED @name` / `SPEAKER_STOPPED @name`.
10. Click **Export** and keep the JSON, whatever happened. It's the raw evidence for deciding whether the signal is reliable.

Click the toolbar icon again to stop audio capture. Closing the tab also stops it.

### Useful from DevTools

In the Console context dropdown, choose **X Spaces Active Speaker Probe** (the content-script context). Then:

```js
xsa.candidates(20)           // top 20 candidate signals
xsa.setRule('T>div:0 .r-xyz') // set a signal by hand; xsa.setRule(null) clears it
xsa.state.participants        // what was discovered
xsa.exportData()              // same as the Export button
```

### Troubleshooting

- **No panel:** click the toolbar icon, which injects the probe. Or reload the X tab.
- **Participants found but roles are `?`:** your X UI language isn't English. Add your words to `ROLE_TEXT` at the top of `extension/content.js`, click reload on `chrome://extensions`, then click the icon again.
- **Badge `ERR`:** the reason appears in the panel's `AUDIO LEVEL` line. The usual cause is the tab already being captured. Click the icon again, or reload the extension.
- **Badge `?`:** the icon was clicked on a tab that isn't x.com or twitter.com.
- **Signal stops working after a while:** the path or class probably changed, for example after X re-rendered or deployed. Clear the signal and observe again. Note this in the results, because it matters for reliability.

## Files

```
extension/
  manifest.json    MV3; permissions: tabCapture, offscreen, scripting, activeTab, storage
  background.js    toolbar click → tabCapture stream id → offscreen; relays levels to the tab
  offscreen.html   hosts offscreen.js
  offscreen.js     getUserMedia(tab) → AnalyserNode → level; replays audio to speakers
  content.js       discovery, panel, speaking state, OBSERVE instrumentation, export
scripts/build.mjs  validation + packaging
```
