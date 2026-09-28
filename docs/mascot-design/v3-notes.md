# Mascot v3

Historical candidate, superseded by `v4-notes.md`. Its generated assets are retained but are no longer used by the homepage.

Generated with the built-in image_gen tool using `public/background-character.png` as the identity reference. All three PNGs have genuine alpha transparency and are saved in `public/mascot/`. Original assets remain available.

## Prompt set

### head-v3.png

Edit the provided mascot into an animation-ready BASE HEAD layer. Preserve precisely its recognizable blue gradient hair, white scalloped maid headband, peach face, blush, tilted head, simple clean illustration and proportions. Remove BOTH dark oval eyes (leave seamlessly painted blank skin for runtime eyes), remove the top curved ahoge tuft and right blue bow (these will be separate layers). Keep the right drooping side hair intact, with smooth clean contour. MOST IMPORTANT outpaint/complete the cut-off LEFT silhouette and bottom of head so the head has a complete natural curved outline, not a straight cropped edge. Use a square transparent canvas with a little margin around a complete head, no body. No checkerboard painted into image, no white fringe. Do not redesign the character, do not add eyes mouth nose or text. Deliver ONE base layer PNG with actual transparency, not a contact sheet.

### tuft-v3.png

Extract and faithfully regenerate ONLY the single blue curved ahoge hair tuft at the TOP of the supplied character into one clean separate animation sprite on genuine transparent background. Preserve the original elegant crescent curve, sharp leftward tip, dark blue underside and rich blue gradient. Complete the root underlap for mounting onto the head. Tight centered framing with small clear margins, same 2D smooth illustration style. No head, face, eyes, headband, bow, letters or contact sheet. One tuft only. Actual alpha transparency, no checkerboard painted in.

### bow-v3.png

Extract and faithfully regenerate ONLY the small cyan/blue bow on the right of the provided mascot as a separate animation sprite. Preserve its original two rounded asymmetrical loops, small center knot, blue shading and dark blue fold marks; match the exact simple clean 2D illustration style of reference. Show the entire bow with clean smooth antialiased edges, on genuine alpha transparent background, tight centered framing with small transparent margins. No hair, head, face, letters or other objects. One bow only, not contact sheet. No checkerboard painted in.

## Rig

Complete head with integrated side hair; independent tuft and bow with small spring motion. Side hair no longer uses a hard cutout pivot that exposes seams. Eyes remain SVG for precise gaze and eyelid control: the aperture clips the original eye and highlight, rather than squashing them. Blink closure/hold/open takes 70/35/145ms, with occasional double blinks. Small breathing and gaze replace the fixed sequence of exaggerated poses. Motion pauses in hidden tabs, settings panes, reduced-motion modes, or when the mascot is hidden. All assets preload together; loading failure restores the original static illustration.

This is a lightweight layered 2D rig, not a Live2D model or a reproduction of Grok's renderer. A future Live2D rig would additionally require meshes, deformation parameters and occlusion-complete layers.

## Review

Run the local server and open `/mascot-preview.html`; add `?theme=dark&paused` for a deterministic dark static view. These controls do not change saved user settings. The launcher itself consumes the same public assets and script. GitHub Pages files under `docs/` and installed desktop copies were not replaced.

Verified: JavaScript syntax; 10 existing settings-page tests; actual homepage rendering; 390px width without horizontal overflow; dark and reduced-motion rendering in the isolated preview. Installed desktop application verification is outstanding.
