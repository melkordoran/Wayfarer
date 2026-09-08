# RWX vertex prelighting

Wayfarer reads the documented `Vertex` / `VertexExt` optional `PRELIGHT r g b` argument, including the inline `#! prelight` extension spelling. Components are decimal numbers from 0 through 1. UV and PRELIGHT options can appear in either order. The last valid color carries forward to later vertices within that clump; earlier unspecified vertices start black. Child clumps and prototype instances have independent prelight state. Transform and attribute scopes do not create a new vertex clump. These rules follow the archived official [Vertex reference](https://web.archive.org/web/20250506084923/https://wiki.activeworlds.com/index.php?title=Vertex).

PRELIGHT is added illumination, not ordinary vertex-paint multiplication: black adds nothing, while white supplies full base-surface illumination even without world lights. The official [prelighting tutorial](https://www.activeworlds.com/newsletter/1201/1206.html) explains that it combines with dynamic lights and can keep lamps bright in a dark world.

The shared mesh factory applies an interpolated additive term, `base surface RGB × prelight RGB`, alongside Three's reflected lighting. Base surface RGB includes the material color and any decoded texture. Numeric coefficients use the existing linear-light pipeline; texture images retain their sRGB decoding. PRELIGHT does not create a light source or illuminate other objects. UVs, masks, opacity, fog, object transforms, and rigid avatar-joint animation remain independent of the prelight attribute.

## Compatibility limits

- This is not pixel-identical historical AW shading. Three's physical material, tone mapping, color-space handling, and unclamped intermediate lighting differ from the original renderer.
- The official [TextureMode reference](https://web.archive.org/web/20250506084926/https://wiki.activeworlds.com/index.php?title=TextureMode) specifies ambient-only lighting when texture lighting is disabled. Prelit parts on Wayfarer's legacy non-Lit path use an ambient-only modern approximation and report a warning. Non-prelit legacy materials are unchanged. Other historical texture-mode combinations remain approximate.
- Full RWX [Surface](https://web.archive.org/web/20250506084927/https://wiki.activeworlds.com/index.php?title=Surface) ambient/diffuse coefficient behavior and explicit inline vertex normals are not added by this feature. Computed smooth/facet normals continue to use the existing mesh pipeline.
- Malformed, missing, duplicated, out-of-range, hexadecimal, or non-finite RGB values report a warning and retain the prior valid clump value. They do not silently reset it to black. Ordinary `#` comments are not executed; `#!` marks executable AW extensions.
- Colors stay within the existing parser's source, command, prototype, vertex, and triangle budgets. This bounds retained attribute size; it is not a guarantee of a fixed peak allocation during parsing.

## Evidence and manual graphics check

`tests/engine-rwx-prelight.test.ts` covers clump inheritance, prototype isolation, transforms, UVs, triangulation, malformed values, command budgets, shader composition, linear coefficients, smooth-geometry seams, independent instances, material cloning, texture/disposal races, tagged avatar animation, preview loading, and environment loading.

The development-only `/tests/environment-render.html` page uses original local comparison panels. Looking north (+Z), they appear white, red, black from screen left to right (AW's +X is west). Enable **PRELIGHT panels**, then set **World lights** to zero. The black panel adds no illumination; the red and white panels remain lit. Cycle to **disabled baseline**: all three panels should become dark. This exercises the real shared WebGL shader without contacting a universe or world server. The harness and its original fixtures are not production build entries.

This comparison was manually verified in the real WebGL harness: white/red remained lit with zero ambient, hemisphere, and directional light; all three baseline panels were black, with zero shader errors. It proves the shared additive-light path works, not historical AW pixel parity.
