import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RotateCcw } from "lucide-react";
import type { AssetFetcher } from "../engine/assets";
import { ModelPreviewSession, framePreview } from "../engine/model-preview";

type PreviewRuntime = { active: boolean; scene: THREE.Scene; current: THREE.Group | null; draw: () => void; fit: () => void };

export function ModelPreview({ model, objectPath, asset, requestId }: { model: string; objectPath: string; asset: AssetFetcher; requestId?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const reset = useRef<() => void>(() => {});
  const runtime = useRef<PreviewRuntime | null>(null);
  const [status, setStatus] = useState("Loading model…");
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState<string[]>([]);
  useEffect(() => {
    if (!canvas.current) return;
    let renderer: THREE.WebGLRenderer | undefined;
    let controls: OrbitControls | undefined;
    let resize: ResizeObserver | undefined;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
    const state: PreviewRuntime = { active: true, scene, current: null, draw: () => {}, fit: () => {} };
    const draw = state.draw = () => { if (state.active && renderer) renderer.render(scene, camera); };
    const release = () => {
      if (!state.active) return;
      state.active = false;
      if (runtime.current === state) runtime.current = null;
      reset.current = () => {};
      controls?.removeEventListener("change", draw); controls?.dispose(); resize?.disconnect();
      // Do not forceContextLoss: React StrictMode reuses the same canvas.
      renderer?.dispose();
    };
    try {
      renderer = new THREE.WebGLRenderer({ canvas: canvas.current, antialias: true, alpha: true, powerPreference: "low-power" });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.15;
      scene.add(new THREE.HemisphereLight("#edf4ff", "#5a665c", 2.4));
      const light = new THREE.DirectionalLight("#fff0d7", 3); light.position.set(5, 8, -6); scene.add(light);
      controls = new OrbitControls(camera, canvas.current);
      controls.enablePan = false; controls.enableDamping = false;
      controls.addEventListener("change", draw);
      reset.current = state.fit = () => {
        if (!state.active || !state.current || !controls) return;
        const framing = framePreview(camera, state.current);
        controls.target.copy(framing.centre);
        controls.minDistance = framing.radius * 0.15;
        controls.maxDistance = framing.distance * 5;
        controls.update(); draw();
      };
      const updateSize = () => {
        if (!state.active || !renderer || !canvas.current) return;
        const width = Math.max(1, canvas.current.clientWidth), height = Math.max(1, canvas.current.clientHeight);
        renderer.setSize(width, height, false); camera.aspect = width / height;
        camera.updateProjectionMatrix(); reset.current(); draw();
      };
      resize = new ResizeObserver(updateSize); resize.observe(canvas.current); updateSize();
      runtime.current = state;
    } catch (cause) {
      release();
      setError(cause instanceof Error ? cause.message : "3D preview is unavailable.");
    }
    return release;
  }, []);

  // Preview changes replace only model-owned resources. The mounted canvas keeps
  // one renderer, OrbitControls instance and resize observer across user retries.
  useEffect(() => {
    const state = runtime.current;
    if (!state?.active) return;
    let active = true;
    const session = new ModelPreviewSession(asset, objectPath, next => {
      if (active && state.active) { setWarnings(next); state.draw(); }
    });
    setError(""); setWarnings([]); setStatus("Loading model…");
    void session.load(model).then(result => {
      if (!active || !state.active) return;
      state.current = result.root; state.scene.add(result.root); setWarnings(result.warnings);
      const size = new THREE.Box3().setFromObject(result.root).getSize(new THREE.Vector3());
      setStatus(`${size.x.toFixed(2)} × ${size.y.toFixed(2)} × ${size.z.toFixed(2)} m`);
      state.fit();
    }).catch(cause => { if (active && state.active) setError(cause instanceof Error ? cause.message : "Model preview unavailable."); });
    return () => {
      active = false; session.dispose(); state.current = null; state.draw();
    };
  }, [model, objectPath, asset, requestId]);
  return <section className="model-preview" aria-label="Selected model preview">
    <canvas ref={canvas} aria-label={`3D preview of ${model}`} />
    {error ? <p className="model-preview-error" role="alert">{error}</p> : <>
      <div className="model-preview-status"><span>{status}</span><button type="button" className="icon-button" title="Reset model preview view" onClick={() => reset.current()}><RotateCcw size={14} /></button></div>
      <p className="model-preview-hint">Drag to orbit · Scroll to zoom · Geometry and materials only</p>
    </>}
    {!!warnings.length && <details className="model-preview-warnings"><summary>{warnings.length} preview {warnings.length === 1 ? "notice" : "notices"}</summary><ul>{warnings.slice(0, 20).map(warning => <li key={warning}>{warning}</li>)}</ul></details>}
  </section>;
}
