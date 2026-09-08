# DirectX in ActiveWorlds: source boundaries

Research checkpoint: 2026-09-07. The current AW wiki was unavailable; these are archived copies of its original documentation, not third-party tutorials. No proprietary geometry, textures, or animation assets were downloaded. Microsoft's file grammar is documented separately in the parser.

## Animation is not geometry

[Official DX Animation, archived 2021-10-11, revision 33060](https://web.archive.org/web/20211011235358/http://wiki.activeworlds.com/index.php?title=DX_Animation) documents text X animation support from AW 5.1 build 1172. It accepts both `.seq` and `.x` extensions. The documented exporter selects a **right-handed, Y-up** basis; this is evidence for that animation-exporter workflow, not proof that every X geometry exporter uses the same convention.

The documented profile uses one AnimationSet, defaults to 30 ticks/second (range 2–200), and treats each track's first key as its reference pose. Rotation, translation and matrix keys are described; scale keys are unsupported. Non-pelvis translation requires build 1176. Its tips recommend a single pelvis root and a neutral first pose. The text profile also specifies CRLF and a 250-character line limit. These are historical AW limits, not requirements of the general Microsoft grammar.

Wayfarer currently rejects standalone X animations explicitly, including X-header content named `.seq`. Embedded geometry animation is not played; its presence must remain visible as an unsupported-feature warning. Existing binary SEQ/AWSQ playback is a separate implementation.

## Skeleton binding

[Official Skinned avatars, archived 2025-05-06, revision 29552](https://web.archive.org/web/20250506100347/https://wiki.activeworlds.com/index.php?title=Skinned_avatars) lists AW's named joints, numeric tags and aliases. Its X example preserves nested Frame/FrameTransformMatrix transforms, with a mesh frame beside the pelvis under a common root. A mesh therefore need not be inside the bone it follows. Hierarchy and bind transforms cannot be discarded during loading.

Wayfarer's resolver recognizes those documented AW names and aliases; it also recognizes the underscored limb spellings used in the DX Animation example. It does not guess Mixamo, Blender-generated or other arbitrary skeleton names. Unrecognized frames remain in the hierarchy. Existing internal SEQ keys `obj1` and `lips` are retained for documented tags 28 and 39. Case folding is a client convenience, not a newly verified AW requirement.

The source warns that invalid hierarchy can interrupt playback, and that older sequences may omit joints needed to deform skin correctly. Geometry parsing and correct weighted bind-pose rendering do not establish complete animation parity.

## CAV is a separate system

[Official Custom Avatar, archived 2025-05-06, revision 30548](https://web.archive.org/web/20250506085803/https://wiki.activeworlds.com/index.php?title=Custom_Avatar) explicitly accepts binary or ASCII `.x` geometry in CAV's avatar folder. Its introductory discussion describes the historical ASCII authoring workflow; the later content contract explicitly allows both encodings.

CAV additionally needs XML templates and portable presets, multipart selection, deformation controls, layered/colorized textures, and configured universe/world permissions. Its content layout uses avatar meshes, textures and external AW sequences. Supporting a `.x` mesh does **not** implement this system, nor does `.awcav` identify another mesh format. The document permits optional password protection for ZIP-compressed mesh assets; Wayfarer does not implement that password workflow. Its ZIP packaging statements do not establish support for X's internal MSZIP `tzip`/`bzip` encoding.

## Deliberate initial support limits

- Geometry: text/binary X with parser-validated 32/64-bit headers; bounded outer ZIP/GZIP. Internal MSZIP bodies are rejected with an actionable error.
- Selection: explicit `.x` and `.rwx` remain format-specific. Extensionless/`.zip` references try ZIP, RWX, then X. A ZIP must contain exactly one matching basename/format; ambiguity, traversal names, over-budget archives and filename/header disagreement are rejected.
- Coordinates: the parser retains source coordinates and matrices. Rendering uses identity basis and a provisional one-source-unit-per-metre policy, **not** RWX's tenfold scale. No retrieved primary AW geometry text establishes universal units or handedness. Geometry scale/orientation parity remains gated on independent, authorized comparative fixtures; this policy is not a verified retail fact.
- Not implemented: CAV assembly/deformation, COB geometry, password-protected assets, standalone/embedded X animation playback, or generic skeletal retargeting.
