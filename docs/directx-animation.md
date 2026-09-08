# External DirectX avatar animation

World avatar catalogs may explicitly reference a separate `.x` motion, or a
`.seq` file containing X data. This is experimental playback, not a claim of
pixel-exact AW 5.2/6.2 behavior. Ordinary geometry loading never auto-selects or
plays its embedded AnimationSet. Existing binary SEQ/AWSQ playback is unchanged.

Supported X clips contain exactly one nonempty AnimationSet, with named AW
limbs or uniquely resolved frame references. Text and binary32/64, outer ZIP/GZIP
and internal MSZIP tzip/bzip use the same bounded loaders as other assets. Tick
rate may occur at the document or set level (not both); the default is 30 and
the accepted range is 2–200. Independent rotation and translation timestamps
are preserved, with interpolation through the existing sequence sampler.

Rotation keys use the selected Microsoft WXYZ/conjugated-vector encoding.
Translation and rotation are first-key-relative, applied to the target rig's
bind pose; one source unit is one metre. Matrix types 3 and 4 must decompose
without shear, reflection or singular scale. Constant positive reference scale
is not reapplied to the target rig. Animated scale, mixed matrix/component
tracks, spline translation, ambiguous references, multiple sets and unknown
animation metadata are explicit failures. Nonzero initial key times hold the
reference pose before the first key. Visible diagnostics retain the fact that
historical AW exporter signs, units and parent-space translation are unverified.
See [primary-source research and independent oracles](directx-animation-research.md).

An explicit `.x` name tries its ZIP then X file; an explicit `.seq` tries ZIP then
SEQ. Bare names try ZIP, SEQ, then X. A present but malformed or format-mismatched
archive is rejected, not silently replaced with another animation. Archives
must contain one exact matching basename/format; checksum, real expansion,
entry count and unsafe-path checks apply before returning bytes. The clip
loader caps input/expansion at 16 MB, animation work at 100,000 keys, and parser
duration at 24 hours. The gesture UI additionally permits only clips up to 60
seconds, with a 10-second load deadline. Root motion remains disabled for
gestures and does not change server coordinates.

The studio's original X avatar offers **X Salute** after Wave and Bow. Its
four-second shoulder/elbow motion includes an eight-degree head nod and returns
to neutral. It is original CC0 content, not an AW or Microsoft sample. Only that
avatar's explicit list changes; existing avatar and gesture indices are stable.

## Verification workflow

```sh
node scripts/directx-animation-assets.mjs --studio --check
npm test -- tests/directx-animation.test.ts tests/directx-animation-assets.test.ts tests/studio-avatar-assets.test.ts
npx tsx scripts/axis-isolated-directx-smoke.ts --animation
```

The opt-in live runner creates fresh owned Axis servers on loopback ports and
a distinct `directx-animation` asset profile. It checks every original raw/ZIP/
MSZIP motion variant and its actual weighted pose, the catalog-selected clip,
two citizens' positive/neutral states, existing geometry/property checks and
guarded cleanup. Default baseline and old DirectX profiles stay byte-identical.
Network gesture delivery does not prove that a remote renderer displayed the
motion; numeric, engine, UI and native evidence remain distinct. Actual dated
results belong in [verification](verification.md), not this workflow description.
