# DirectX animation: encoding, reference poses, and evidence limits

Research checkpoint: 2026-09-07. This is an implementation research record, not a claim that Wayfarer matches every AW 5.2/6.2 exporter or client. The public Microsoft sample was inspected transiently in memory; its assets and animation tracks were not saved into this repository or bundled. The numerical fixtures below are independently authored.

## Published structures

- [Animation](https://learn.microsoft.com/en-us/windows/win32/direct3d9/animation) associates animation data with one frame reference and at least one AnimationKey block; AnimationOptions is optional. Named geometry frames are ordinary Microsoft targets, whereas standalone AW sequences use the application's known limb names.
- [AnimationKey](https://learn.microsoft.com/en-us/windows/win32/direct3d9/animationkey) contains a key type, key count, and TimedFloatKeys array. Its published table assigns rotation/scale/translation/matrix to 0/1/2/3. **Real Microsoft SDK exports also use type 4 for matrices**, as verified below; accepting 3 and 4 is an explicit interoperability policy.
- [TimedFloatKeys](https://learn.microsoft.com/en-us/windows/win32/direct3d9/timedfloatkeys) contains a DWORD timestamp and FloatKeys; [FloatKeys](https://learn.microsoft.com/en-us/windows/win32/direct3d9/floatkeys) carries an explicit float count and array. Count, monotonic time, finite values, and global resource budgets must all be validated. Zero timestamps occur in both primary examples despite the TimedFloatKeys prose calling time positive.
- [AnimTicksPerSecond](https://learn.microsoft.com/en-us/windows/win32/direct3d9/animtickspersecond) supplies a DWORD time scale. The AW default/range below are application policy, not universal limits of the Microsoft container.
- [AnimationOptions](https://learn.microsoft.com/en-us/windows/win32/direct3d9/animationoptions) uses openclosed=0 for closed or 1 for open; closed is the documented default. Position quality is 0 for spline or 1 for linear. This does not establish that AW honors either field. Rejecting an explicit unsupported spline request is more honest than silently changing its motion; loop control can remain with the existing caller, with a visible limitation.

The current [Microsoft template index](https://learn.microsoft.com/en-us/windows/win32/direct3d9/dx9-graphics-reference-x-file-format-templates) does not list a standalone Quaternion template. Rotation AnimationKey records use FloatKeys, so no such template is required to decode them. The [D3DXQUATERNION structure](https://learn.microsoft.com/en-us/windows/win32/direct3d9/d3dxquaternion) is an **in-memory API** XYZW type with a documented axis/half-angle relation; it must not be mistaken for the WXYZ X-file serialization or proof of its rotation sign.

## What the official AW description actually establishes

The [archived official DX Animation page, revision 33060](https://web.archive.org/web/20211011235358/http://wiki.activeworlds.com/index.php?title=DX_Animation) describes text X sequences from build 1172, with `.seq` or `.x` names and one AnimationSet. Its exporter uses right-handed, Y-up coordinates. Default playback is 30 ticks/second, range 2–200. Each limb's first key is the untransformed reference pose. Types 0/1/2/3 are quaternion/unsupported scale/translation/matrix; non-pelvis translations require build 1176. Only linear interpolation is documented. Historical line constraints are CRLF and 250 characters.

The rotation example's identity is WXYZ=(1,0,0,0); the prose's description of the first value as an angle is imprecise. Translation is described as world-space, while rotation is described as object-space. The page does not provide reference-quaternion multiplication order, translation-unit conversion, parent-space conversion, or a quaternion-versus-matrix numerical pair. Its exporter source was not recovered during the bounded search. Those omissions prevent a retail-fidelity claim for arbitrary nonidentity references or non-root translations.

## Microsoft export evidence: type 4 and quaternion signs

[Microsoft's Tiny sample](https://github.com/microsoft/DirectX-SDK-Samples/blob/3e4d64baef027420c31863c2527876e0eb45a3f2/Media/Tiny/tiny.x) contains 47 AnimationKey blocks, all type 4. The [MultiAnimation sample](https://github.com/microsoft/DirectX-SDK-Samples/blob/3e4d64baef027420c31863c2527876e0eb45a3f2/C%2B%2B/Direct3D/MultiAnimation/tiny_4anim.x) contains 138 blocks each of types 0, 1 and 2, plus 12 type-4 blocks. That is direct first-party exporter/runtime example evidence, despite the template documentation's type-3 table.

For MultiAnimation, a read-only numerical probe matched each first rotation key to its named FrameTransformMatrix when their poses coincided. Of 138 examined rotation tracks, 21 nontrivial matches across seven distinct bones required conjugation after WXYZ unpacking: neck, both first finger bones, both toes, body, and Spine1. Maximum residual was approximately 1.013e-6 radians. There were zero direct-only matches. Other first keys differ from the bind pose and were not treated as sign evidence. The sample revision is `3e4d64baef027420c31863c2527876e0eb45a3f2`; its 2,508,994 bytes hash to SHA-256 `009f5cf0a12e12adfc211c4da92e1af4671b6fce8f66fb785f917a35d4276950`.

This supports the explicit conversion `X(w,x,y,z) -> Three(-x,-y,-z,w)` for this Microsoft X encoding profile. Negating w instead produces the equivalent antipodal quaternion; negating all four components alone does **not** conjugate it. This is an encoding interpretation, not a geometry handedness flip. It does not prove that the historical custom AW Blender exporter produced the same sign convention. Keep that uncertainty visible rather than guessing from filenames or joint names.

## Matrices and multiplication order

[Microsoft's transform reference](https://learn.microsoft.com/en-us/windows/win32/direct3d9/transforms) places translation in the fourth row and composes visible row-vector operations left to right. The [DirectX FAQ's exporter discussion](https://learn.microsoft.com/en-us/windows/win32/dxtecharts/directx-9-frequently-asked-questions#directx-extensions-for-alias-maya) specifies S*R*T and warns that shear and off-center operations may not decompose into this form. Reading the row-major X float array directly with Three's column-major `Matrix4.fromArray` produces the transpose representation needed for column-vector application. A further `.transpose()` would be an error.

For example, this independently handwritten X matrix performs scale(2,3,4), Rx(+90 degrees), then translation(3,5,7):

```text
 2, 0, 0, 0,
 0, 0, 3, 0,
 0,-4, 0, 0,
 3, 5, 7, 1
```

It maps point(1,2,3) to (5,-7,13). Three decomposition returns translation(3,5,7), rotation Rx90 and scale(2,3,4). Under the selected first-reference adaptation, a constant positive source scale can remain part of the discarded reference while the target retains its own bind scale; this requires an explicit warning. Changing scale is unsupported. Animated matrices need affine, finite, nonsingular validation; reject unsupported shear/reflection instead of dropping it silently. Scale constancy and orthogonality checks must be relative to the linear basis magnitude: a fixed absolute epsilon must not hide a tenfold change or strong shear in a small-scale matrix. Matrix tracks and separate S/R/T tracks on one target require explicit conflict handling.

[D3DXQuaternionMultiply](https://learn.microsoft.com/en-us/windows/win32/direct3d9/d3dxquaternionmultiply) deliberately returns Q2*Q1 for inputs Q1,Q2 so its function argument order matches row-matrix concatenation. Do not copy that argument order into Three's Hamilton `Quaternion.multiply`, which uses the ordinary current*argument product.

## Adapter into the existing AvatarSequence

Wayfarer's rig application already uses `qGeometryBind * qDelta` and `tGeometryBind + tDelta`. The following is a coherent **local-reference adaptation policy**, not an undocumented AW runtime fact:

1. Decode each rotation into the selected Three convention; normalize finite nonzero quaternions.
2. Produce `qDelta(t) = inverse(qFirst) * qKey(t)` and `tDelta(t) = tKey(t) - tFirst`. Matrix keys are decomposed first, then adapted by the same rule. Treating the complete reference matrix inverse as a single delta would rotate translations and is a different policy.
3. Preserve geometry bind transforms. Do not replace them with sequence frame matrices. Resolve only documented AW limb names/aliases; reject duplicate canonical tracks and warn about unmapped targets. All-unmapped motion must not report successful animation.
4. Convert ticks to milliseconds with `tick * 1000 / ticksPerSecond`, preserving inter-track timing. If first ticks are nonzero, holding the first reference until then is a stated convenience; shifting every track independently would destroy synchronization. Bound duration and aggregate keys.
5. Retain existing shortest-path quaternion interpolation and linear position interpolation, and existing caller-controlled looping/root-motion suppression. The AW page does not settle spherical-versus-normalized-linear quaternion interpolation; do not claim an exact interpolator match.

Identity coordinate basis and one source unit per metre are still provisional choices. General world-space limb translation would require the appropriate inverse parent linear transform at playback time; simple subtraction is only a same-parent-space interpretation. Neither the X grammar nor the current adapter proves that every historical AW non-root translation follows it.

## Independent original regression oracles

`tests/fixtures/directx-animation-oracles.ts` contains an original two-key, one-limb sequence emitted as quaternion+translation and equivalent type-3/type-4 matrix tracks. It includes no Microsoft/AW sample content. The self-checks in `tests/directx-animation-oracles.test.ts` verify the mathematical data independently of Wayfarer's parser and adapter.

Let `s=sqrt(1/2)`, in Three XYZW notation:

```text
qFirst = Rx90 = (s,0,0,s)
qLast  = Ry90 = (0,s,0,s)
correctDelta = inverse(qFirst)*qLast = (-.5,.5,-.5,.5)
wrongDelta   = qLast*inverse(qFirst) = (-.5,.5,+.5,.5)
```

With geometry bind rotation qFirst, point(1,2,3) ends at (3,2,-1) for the correct order, but (-2,1,3) for the reversed order. First/last translation keys are (3,5,7)/(5,8,11), so delta=(2,3,4). Independently choose geometry bind position(1,2,3): the final retargeted point must be (6,7,6). Both matrix and quaternion fixtures must produce the same result, a neutral first sample, and identical interpolation under the selected profile.

Remaining independent comparison gates are the historical AW exporter sign/units, reference multiplication under differing bind orientations, parent-transformed non-root translation, exact interpolation and loop endpoints, and playback of authorized fixtures in the actual target AW versions. No amount of self-authored fixtures establishes those external facts.
