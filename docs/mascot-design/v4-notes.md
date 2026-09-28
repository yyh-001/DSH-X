# Original-art refinement

Follow-up: `v5-notes.md` restores independent secondary motion using local deformation of the original image.

The v3 redraw changed the face silhouette, accessory proportions, eye spacing and crop. This revision uses `public/background-character.png` directly for the head, tuft, bow and even the eye pixels. No new raster images are generated. The v3 PNGs remain as review history and are no longer loaded by the mascot.

Only the two eye areas are covered with feathered skin from the existing `public/mascot/base.png`. The original eyes are shown through local SVG clips above those patches. This retains the original gradients and removes the added highlights. Moving eyelids reveal skin, without flattening the artwork. Accessories stay integrated into the original head so their roots and outlines cannot separate.

The desktop size and placement are restored to `min(70vh, 48vw)`, left `-3vh`, bottom `-8vh`; narrow screens use `64vw`, left `-3vw`, bottom `-5vw`. Head rotation stays below one degree and gaze travel is limited to 6/4 source pixels horizontally/vertically. CSS overscan hides the original left crop; this version does not claim to have outpainted that edge. Breathing, asynchronous blinks, occasional double blinks and click expressions remain.

Validation: JavaScript syntax and whitespace checks; real homepage rendering; light/dark fully closed-eye views using `/mascot-preview.html?paused&closed` (append `&theme=dark`); 390px responsive view without horizontal overflow; geometric bounds check at six viewport sizes from 320x568 to 1920x1080 confirms the original left source edge stays offscreen throughout the bounded rotation. No installed desktop files or published website were changed.
