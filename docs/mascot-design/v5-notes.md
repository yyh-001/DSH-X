# Independent secondary motion on original artwork

Restores independent tuft, bow and side-ear movement removed in v4. Three soft SVG displacement fields deform the original transparent artwork, with neutral falloff toward the roots. No raster redraw or silhouette cutout is used. Each field has its own spring, phase and frequency; pointer tracking and head velocity contribute to the target, and clicks add bounded spring impulses. Displacement scale is clamped to ±55 source units. Normal idle excursions are approximately ±34 / ±24 / ±32 for tuft / bow / ear; visible displacement is smaller than scale, based on each color channel's distance from 0.5.

All maps use sRGB so their 50% gray background is neutral. Maps preload alongside the source images. Reduced motion, hidden character, hidden tab and settings pane still stop the animation loop and restore all three displacement scales to zero. The original portrait size, crop and eye animation are preserved.

The isolated `/mascot-preview.html` now shows the ear tip and tuft without the launch card overlapping them. This changes only the review page layout, not the launcher layout.

Verified in the local browser: source illustration renders with the filters; all three scale values change independently between observations; dark paused preview resets all scales to zero and removes the head transform. Also passed `node --check public/mascot.js` and scoped whitespace checks. This is local web verification, not installed-desktop validation or an FPS benchmark.
