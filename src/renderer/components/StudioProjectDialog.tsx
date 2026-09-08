import { useState } from "react";
import { Download, FolderOpen, RotateCcw, Save } from "lucide-react";
import { Modal } from "./Modal";
import { decodeStudioProject, encodeStudioProject, STUDIO_LIMITS, type StudioProject } from "../studio-project";

export function StudioProjectDialog({ project, saveError, onRename, onReplace, onClose }: {
  project: StudioProject; saveError: string; onRename: (name: string) => string | undefined;
  onReplace: (project: StudioProject | null) => string | undefined; onClose: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [error, setError] = useState("");
  const [replacement, setReplacement] = useState<{ kind: "import"; project: StudioProject } | { kind: "reset" } | null>(null);
  const [reading, setReading] = useState(false);
  function exportProject() {
    const result = encodeStudioProject(project);
    if (!result.ok) { setError(result.error.message); return; }
    const url = URL.createObjectURL(new Blob([result.value], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${project.name.replace(/[^a-z0-9_-]/gi, "-") || "studio"}.wayfarer.json`;
    anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  return <Modal title="A place of your own." subtitle="Your offline studio is saved on this device. Export a project to keep a portable backup." onClose={onClose}>
    <div className="project-summary"><FolderOpen size={25} /><div><strong>{project.objects.length.toLocaleString()} objects{project.terrain ? ` · ${project.terrain.length} terrain ${project.terrain.length === 1 ? 'patch' : 'patches'}` : ''}</strong><small>Offline project · Version {project.version} · Maximum 5 MB</small></div></div>
    {(error || saveError) && <p role="alert" className="project-error">{error || saveError}</p>}
    <form className="form-stack" onSubmit={event => { event.preventDefault(); const error = onRename(name); setError(error || ""); }}>
      <label>Project name<input value={name} maxLength={64} onChange={event => setName(event.target.value)} /></label>
      <button className="secondary-button" disabled={!name.trim()}><Save size={15} />Save project name</button>
    </form>
    <div className="project-file-actions">
      <button className="primary-button" onClick={exportProject}><Download size={15} />Export project</button>
      <label className="secondary-button import-project"><FolderOpen size={15} />Import project<input type="file" accept=".json,.wayfarer.json,application/json" aria-label="Import studio project" disabled={reading} onChange={async event => {
        const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
        setError(""); setReplacement(null);
        if (file.size > STUDIO_LIMITS.fileBytes) { setError("Choose a project smaller than 5 MB."); return; }
        setReading(true);
        try { const result = decodeStudioProject(await file.text()); if (!result.ok) setError(result.error.message); else setReplacement({ kind: "import", project: result.value }); }
        catch { setError("This project file could not be read."); }
        finally { setReading(false); }
      }} /></label>
    </div>
    <p className="field-help">Projects contain objects, local terrain edits and your camera position, not credentials or remote-world settings. Version 1 files remain readable; terrain edits use version 2. Undo history lasts only for the current world session.</p>
    {replacement ? <div className="project-confirm" role="region" aria-label="Confirm studio replacement">
      <strong>{replacement.kind === "reset" ? "Restore the original Commons?" : `Open “${replacement.project.name}” (${replacement.project.objects.length} objects)?`}</strong>
      <p>This replaces the saved studio and clears its undo history. Export your current project first if you want to keep it.</p>
      <div className="dialog-actions"><button className="secondary-button" disabled={reading} onClick={() => setReplacement(null)}>Keep current studio</button><button className="danger-button" disabled={reading} onClick={() => { const error = onReplace(replacement.kind === "import" ? replacement.project : null); if (error) setError(error); else onClose(); }}>{replacement.kind === "reset" ? "Restore original studio" : "Replace current studio"}</button></div>
    </div> : <button className="subtle-button" disabled={reading} onClick={() => setReplacement({ kind: "reset" })}><RotateCcw size={14} />{reading ? "Reading project…" : "Restore original studio…"}</button>}
  </Modal>;
}
