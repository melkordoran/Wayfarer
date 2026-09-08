import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowDown,
  ArrowRight,
  Bookmark,
  Box,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Compass,
  CornerDownLeft,
  Crosshair,
  Eye,
  Footprints,
  Globe,
  Hand,
  Info,
  Layers,
  LogIn,
  LogOut,
  MapPin,
  Maximize,
  MessageCircle,
  Moon,
  Move3D,
  Navigation,
  Plus,
  Search,
  Send,
  Undo2,
  Redo2,
  MousePointer2,
  Rotate3D,
  FolderOpen,
  Settings,
  Sun,
  Sunset,
  Trash2,
  Users,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import type {
  Avatar,
  ChatMessage,
  ClientCommand,
  ClientEvent,
  ConnectionOptions,
  Contact,
  SocialCommand,
  TelegramMessage,
  Position,
  WorldInfo,
  WorldObject,
  WorldSettings,
  TerrainTile,
} from "../shared/types";
import type { TerrainEditRow, TerrainRegion } from "../shared/terrain-edit";
import { TerrainEditor } from "./components/TerrainEditor";
import { TerrainHistory, sameTerrainRow, type TerrainChange } from "./terrain-editing";
import { requestTerrainMutation } from "./terrain-mutations";
import { applyStudioTerrainRows, materializeStudioTerrain, sampleStudioTerrain } from "./studio-terrain";
import { WorldEngine, type GesturePlaybackState, type AvatarAssetState } from "./engine";
import { createDemoWorld } from "./engine/demo";
import { parseTeleport } from "./engine/actions";
import type { AvatarCatalog } from "./engine/avatar-assets";
import { AvatarDialog } from "./components/AvatarDialog";
import { GestureDialog } from "./components/GestureDialog";
import { WorldDetailsDialog } from "./components/WorldDetailsDialog";
import { WorldSettingsDialog, type WorldSettingsCloseGuard } from "./components/WorldSettingsDialog";
import type { WorldSettingsSetCommand, WorldSettingsResult } from "../shared/world-settings-edit";
import { bridge } from "./client";
import { assertCommand } from "../shared/validation";
import { LOCAL_TELEPORT_DENIED, localTeleportAllowed, sameWorld } from "../shared/navigation";
import {
  coordinates,
  readStored,
  savedPlaces,
  saveStored,
  savedPreferences,
  type Place,
  type Preferences,
} from "./storage";
import { Modal } from "./components/Modal";
import { ConnectDialog } from "./components/ConnectDialog";
import { Inspector } from "./components/Inspector";
import { SelectionInspector } from "./components/SelectionInspector";
import { ModelBrowserDialog } from "./components/ModelBrowserDialog";
import type { ModelLibraryScope } from "./model-library";
import type { TransformChange, TransformMode } from "./engine/transform-tools";
import { version } from "../../package.json";
import {
  BuildHistory,
  sameBuildObject,
  type BuildAdapter,
  type BuildChange,
} from "./build-history";
import { requestBuildMutation } from "./build-mutations";
import { nextLocalObjectId } from "./local-object-id";
import { StudioProjectDialog } from "./components/StudioProjectDialog";
import { SocialDialog } from "./components/SocialDialog";
import {
  clearSocialInbox,
  loadSocialInbox,
  saveSocialInbox,
  SOCIAL_LIMITS,
  type SocialScope,
} from "./social-storage";
import {
  loadStudioProject,
  makeStudioProject,
  saveStudioProject,
  type StudioProject,
} from "./studio-project";

type Dialog =
  | "connect"
  | "teleport"
  | "settings"
  | "help"
  | "palette"
  | "avatar"
  | "gestures"
  | "world-details"
  | "world-settings"
  | "delete"
  | "bookmark"
  | "project"
  | "social"
  | null;
type Phase = Extract<ClientEvent, { type: "status" }>["phase"];
const initialPosition: Position = { x: 0, y: 1.7, z: 12, yaw: 0 };
const systemMessage = (
  text: string,
  kind: ChatMessage["kind"] = "system",
): ChatMessage => ({
  id: crypto.randomUUID(),
  name: "Wayfarer",
  text,
  time: Date.now(),
  kind,
});
const avatarColors = [
  "#dba969",
  "#669c9e",
  "#b290c2",
  "#8eae72",
  "#d47f75",
  "#7c9ac7",
];

const previewAsset = (url: string) => bridge.asset(url);

export default function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const engine = useRef<WorldEngine | null>(null);
  const [mouseCaptured, setMouseCaptured] = useState(false);
  const [viewportFullscreen, setViewportFullscreen] = useState(false);
  useEffect(() => {
    const updateCapture = () => setMouseCaptured(document.pointerLockElement === canvas.current && !!canvas.current);
    const updateFullscreen = () => setViewportFullscreen(document.fullscreenElement === viewport.current && !!viewport.current);
    document.addEventListener("pointerlockchange", updateCapture);
    document.addEventListener("fullscreenchange", updateFullscreen);
    updateCapture(); updateFullscreen();
    return () => {
      document.removeEventListener("pointerlockchange", updateCapture);
      document.removeEventListener("fullscreenchange", updateFullscreen);
    };
  }, []);
  const [engineError, setEngineError] = useState("");
  const [mode, setMode] = useState<"studio" | "network">("studio");
  const [phase, setPhase] = useState<Phase>("disconnected");
  const [status, setStatus] = useState("Offline studio");
  const [world, setWorld] = useState<WorldSettings | null>(null);
  const [worlds, setWorlds] = useState<WorldInfo[]>([]);
  const [objects, setObjects] = useState<Map<number, WorldObject>>(new Map());
  const [avatars, setAvatars] = useState<Map<number, Avatar>>(new Map());
  const [identity, setIdentity] = useState({
    name: "Visitor",
    citizen: 0,
    session: 0,
  });
  const [position, setPosition] = useState<Position>(initialPosition);
  const [stats, setStats] = useState({ fps: 0, drawCalls: 0, triangles: 0 });
  const [traffic, setTraffic] = useState({ received: 0, sent: 0 });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chat, setChat] = useState("");
  const [chatTab, setChatTab] = useState<"all" | "system">("all");
  const [whisper, setWhisper] = useState<Avatar | null>(null);
  const [sideTab, setSideTab] = useState<"worlds" | "people" | "places">(
    "worlds",
  );
  const [filter, setFilter] = useState("");
  const [building, setBuilding] = useState(false);
  const [terrainTool, setTerrainTool] = useState(false);
  const [terrainAnchor, setTerrainAnchor] = useState<{ cellX: number; cellZ: number } | null>(null);
  const [terrainRevision, setTerrainRevision] = useState(0);
  const [terrainPreviewVisible, setTerrainPreviewVisible] = useState(false);
  const terrainDirty = useRef(false), terrainBusy = useRef(false);
  const [hasTerrainDraft, setHasTerrainDraft] = useState(false), [terrainPending, setTerrainPending] = useState(false);
  const terrainHistory = useRef(new TerrainHistory());
  const terrainKeys = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const studioTerrain = useRef<TerrainTile[] | undefined>(undefined);
  const studioTerrainNeedsRender = useRef(false);
  const terrainRegion = useRef<TerrainRegion | null>(null);
  const terrainDirtyChanged = useCallback((dirty: boolean) => { terrainDirty.current = dirty; setHasTerrainDraft(dirty); }, []);
  const terrainKeyHandler = useCallback((handler: (event: KeyboardEvent) => boolean) => { terrainKeys.current = handler; }, []);
  const terrainRegionChanged = useCallback((region: TerrainRegion | null) => { terrainRegion.current = region; engine.current?.setTerrainSelection?.(region); }, []);
  const cancelTerrainPreview = useCallback(() => { engine.current?.cancelTerrainPreview?.(); setTerrainPreviewVisible(false); }, []);
  const previewTerrain = useCallback((rows: TerrainEditRow[]) => {
    const accepted = engine.current?.previewTerrainRows?.(rows) ?? false;
    if (accepted) { terrainDirty.current = true; setTerrainPreviewVisible(true); }
    return accepted;
  }, []);
  const terrainBusyChanged = useCallback((busy: boolean) => {
    terrainBusy.current = busy; setTerrainPending(busy);
    if (!busy && studioTerrainNeedsRender.current) {
      studioTerrainNeedsRender.current = false;
      if (state.current.mode === "studio") {
        engine.current?.unloadSceneData([], [{ pageX: 0, pageZ: 0 }]);
        for (const tile of materializeStudioTerrain(studioTerrain.current)) engine.current?.setTerrain(tile);
        engine.current?.setTerrainPageComplete?.(0, 0, true);
        engine.current?.setTerrainSelection?.(terrainRegion.current);
        setTerrainRevision(value => value + 1);
      }
    }
  }, []);
  const [transformMode, setTransformMode] = useState<TransformMode>("select");
  const [transformSnap, setTransformSnap] = useState(() => {
    const stored = readStored<unknown>("building-tools", {});
    const saved = stored && typeof stored === "object" && !Array.isArray(stored)
      ? stored as { translation?: number; rotation?: number; space?: unknown }
      : {};
    return {
      translation: [0, 0.1, 0.25, 0.5, 1].includes(saved.translation!)
        ? saved.translation!
        : 0.5,
      rotation: [0, 5, 15, 45, 90].includes(saved.rotation!)
        ? saved.rotation!
        : 15,
      space: saved.space === "local" ? "local" as const : "world" as const,
    };
  });
  const transformBuild = useRef<
    (changes: TransformChange[]) => Promise<boolean>
  >(async () => false);
  const [selection, setSelection] = useState<number[]>([]);
  const inspectorDirty = useRef(false);
  const [hasInspectorDraft, setHasInspectorDraft] = useState(false);
  const inspectorSelection = useRef<WorldObject[]>([]);
  const inspectorSelectionScope = useRef<string | null>(null);
  const inspectorDraftScope = useRef<string | null>(null);
  const inspectorDraftChanged = useCallback((dirty: boolean) => {
    if (dirty && !inspectorDirty.current)
      inspectorDraftScope.current = inspectorSelectionScope.current;
    else if (!dirty) inspectorDraftScope.current = null;
    inspectorDirty.current = dirty;
    setHasInspectorDraft(dirty);
  }, []);
  const history = useRef(new BuildHistory());
  const buildEpoch = useRef(0);
  const [, refreshHistory] = useState(0);
  const buildKeys = useRef<(event: KeyboardEvent) => boolean>(() => false);
  const [dialog, setDialogState] = useState<Dialog>(null);
  const worldSettingsCloseGuard = useRef<WorldSettingsCloseGuard | null>(null);
  const worldSettingsDirty = useRef(false);
  const [worldSettingsEpoch, setWorldSettingsEpoch] = useState(0);
  const worldSettingsCancels = useRef(new Set<() => void>());
  const setDialog = useCallback((next: Dialog) => {
    const proceed = () => setDialogState(next);
    if (worldSettingsCloseGuard.current) worldSettingsCloseGuard.current(proceed);
    else proceed();
  }, []);
  const worldSettingsGuardChanged = useCallback((guard: WorldSettingsCloseGuard | null) => { worldSettingsCloseGuard.current = guard; }, []);
  const worldSettingsDirtyChanged = useCallback((dirty: boolean) => { worldSettingsDirty.current = dirty; }, []);
  useEffect(() => () => { for (const cancel of worldSettingsCancels.current) cancel(); worldSettingsCancels.current.clear(); }, []);
  const [pending, setPending] = useState(false);
  const [studioName, setStudioName] = useState("The Commons");
  const [projectError, setProjectError] = useState("");
  const [projectSaved, setProjectSaved] = useState(false);
  const lastStudioContent = useRef("");
  const [restoredInbox] = useState(() => {
    const scope = readStored<SocialScope | null>("last-inbox-scope", null);
    if (!scope)
      return { scope: null, messages: [] as TelegramMessage[], error: "" };
    const loaded = loadSocialInbox(scope);
    return loaded.ok
      ? { scope, messages: loaded.value, error: "" }
      : {
          scope: null,
          messages: [] as TelegramMessage[],
          error: loaded.error.message,
        };
  });
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [contactOptions, setContactOptions] = useState(0);
  const [telegrams, setTelegrams] = useState<TelegramMessage[]>(
    restoredInbox.messages,
  );
  const [telegramPending, setTelegramPending] = useState(false);
  const [socialBusy, setSocialBusy] = useState(false);
  const [socialError, setSocialError] = useState("");
  const [inboxError, setInboxError] = useState(restoredInbox.error);
  const socialEpoch = useRef(0);
  const inboxScope = useRef<SocialScope | null>(restoredInbox.scope);
  const inbox = useRef<TelegramMessage[]>(restoredInbox.messages);
  const inboxDirty = useRef(false);
  const pendingSocial = useRef(false);
  const disconnectRequested = useRef(false);
  const connectionTarget = useRef<Pick<
    ConnectionOptions,
    "host" | "port" | "tls"
  > | null>(null);
  const [places, setPlaces] = useState<Place[]>(savedPlaces);
  const [preferences, setPreferences] = useState<Preferences>(savedPreferences);
  const environmentMode = mode === "studio" ? preferences.time : preferences.worldTime || "world";
  const [toast, setToast] = useState("");
  const [avatarType, setAvatarType] = useState(0);
  const avatarTypeRef = useRef(avatarType);
  avatarTypeRef.current = avatarType;
  const [gesturePlayback, setGesturePlayback] = useState<GesturePlaybackState>({
    requestId: 0,
    gesture: 0,
    phase: "idle",
  });
  const [gestureSending, setGestureSending] = useState(false);
  const gestureEpoch = useRef(0);
  const gestureOperation = useRef(0);
  const gestureBusy = useRef(false);
  const avatarSelecting = useRef(false);
  const gestureActive = useRef<{
    requestId: number | null;
    epoch: number;
    gesture: number;
    network: boolean;
    world: string;
    objectPath: string;
    avatar: number;
    session: number;
  } | null>(null);
  const gestureUpdate = useRef<(value: GesturePlaybackState) => void>(() => {});
  const gestureUncleared = useRef<typeof gestureActive.current>(null);
  const [gestureSyncError, setGestureSyncError] = useState("");
  const resetGesture = useCallback(() => {
    gestureEpoch.current++;
    gestureOperation.current++;
    gestureActive.current = null;
    gestureUncleared.current = null;
    setGestureSyncError("");
    gestureBusy.current = false;
    setGestureSending(false);
    engine.current?.setGesture(0);
    setGesturePlayback({ requestId: 0, gesture: 0, phase: "idle" });
  }, []);
  const [avatarCatalog, setAvatarCatalog] = useState<AvatarCatalog | null>(
    null,
  );
  const [avatarAssetState, setAvatarAssetState] = useState<AvatarAssetState | null>(null);
  const [wireframe, setWireframe] = useState(false);
  const [flying, setFlying] = useState(false);
  const [cameraMode, setCameraMode] = useState<"first-person" | "third-person">(
    "first-person",
  );
  const [chatExpanded, setChatExpanded] = useState(false);
  const [unread, setUnread] = useState(0);
  const chatScroll = useRef<HTMLDivElement>(null);
  const chatInput = useRef<HTMLInputElement>(null);
  const followChat = useRef(true);
  const lastMove = useRef(0);
  const lastQuery = useRef("");
  const activeWorld = useRef<string | null>(null);
  const localId = useRef(10_000);
  const state = useRef({
    mode,
    phase,
    world,
    objects,
    building,
    identity,
    position,
    studioName,
  });
  state.current = {
    mode,
    phase,
    world,
    objects,
    building,
    identity,
    position,
    studioName,
  };
  const selectedObjects = selection.flatMap((id) =>
    objects.has(id) ? [objects.get(id)!] : [],
  );
  const selected = selectedObjects.at(-1) ?? null;
  const modelObjects = useMemo(() => [...objects.values()], [objects]);
  const modelScope = useMemo<ModelLibraryScope | null>(() => {
    if (mode === "studio") return { kind: "studio" };
    const target = connectionTarget.current;
    if (!target || !world) return null;
    return {
      kind: "world",
      ...target,
      world: world.name,
      objectPath: world.objectPath,
    };
  }, [mode, world?.name, world?.objectPath]);
  // Numeric object IDs are meaningful only within one entry. buildEpoch also
  // separates same-world reentry and new Studio projects; ordinary attributes
  // do not reset it. Evaluate from refs again at submission, not a stale render.
  function currentInspectorScope() {
    const current = state.current, target = connectionTarget.current;
    return JSON.stringify(current.mode === "studio"
      ? ["studio", buildEpoch.current]
      : ["network", target?.host.toLowerCase(), target?.port, target?.tls,
        current.identity.session, current.world?.name.trim().toLowerCase(), buildEpoch.current]);
  }
  const renderedInspectorScope = currentInspectorScope();
  const readTerrain = useCallback((region: TerrainRegion) => state.current.mode === "studio"
    ? sampleStudioTerrain(studioTerrain.current ?? [], region)
    : engine.current?.sampleTerrain?.(region) ?? [], []);
  const applyTerrain = useCallback(async (change: TerrainChange, scope: string): Promise<TerrainEditRow> => {
    if (scope !== currentInspectorScope()) throw new Error("The terrain edit belongs to an earlier world entry.");
    const current = state.current;
    if (!current.world?.terrainEnabled || (current.mode === "network" && (current.phase !== "online" || current.world.canEditTerrain !== true))) throw new Error("Terrain editing is not permitted in this world.");
    const cells = readTerrain({ cellX: change.before.cellX, cellZ: change.before.cellZ, width: change.before.heights.length, depth: 1 });
    if (cells.length !== change.before.heights.length || cells.some(cell => cell.height === null || cell.texture === null)
      || !sameTerrainRow(change.before, { cellX: change.before.cellX, cellZ: change.before.cellZ, heights: cells.map(cell => cell.height!), textures: cells.map(cell => cell.texture!) })) throw new Error("Terrain changed or unloaded since this edit was prepared. Refresh the preview before continuing.");
    if (current.mode === "network") {
      const result = await requestTerrainMutation(bridge, { type: "terrain-set", requestId: crypto.randomUUID(), world: current.world.name, session: current.identity.session,
        cellX: change.after.cellX, cellZ: change.after.cellZ, heights: [...change.after.heights], texture: change.after.textures[0],
        previousHeights: [...change.before.heights], previousTextures: [...change.before.textures] });
      if (scope !== currentInspectorScope()) throw new Error("The world entry changed before terrain confirmation.");
      return result;
    }
    const terrain = applyStudioTerrainRows(studioTerrain.current ?? [], [change.after]);
    const project = makeStudioProject(current.studioName, [...current.objects.values()], engine.current?.getPosition?.() ?? current.position, undefined, terrain);
    const saved = project.ok ? saveStudioProject(project.value) : project;
    if (!saved.ok) { setProjectError(saved.error.message); setProjectSaved(false); throw new Error(saved.error.message); }
    studioTerrain.current = saved.value.terrain; studioTerrainNeedsRender.current = true;
    lastStudioContent.current = ""; setProjectError(""); setProjectSaved(true);
    return { ...change.after, heights: [...change.after.heights], textures: [...change.after.textures] };
  }, [readTerrain]);
  const inspectorScopeMatches = !hasInspectorDraft || inspectorDraftScope.current === renderedInspectorScope;
  if (!hasInspectorDraft) {
    inspectorSelection.current = selectedObjects;
    inspectorSelectionScope.current = renderedInspectorScope;
  }
  const inspectedObjects = hasInspectorDraft
    ? inspectorSelection.current.map(
        (object) => inspectorScopeMatches ? objects.get(object.id) || object : object,
      )
    : selectedObjects;
  const inspectedObject = hasInspectorDraft && inspectorSelection.current.length === 1
    ? inspectorScopeMatches ? objects.get(inspectorSelection.current[0].id) ?? null : null
    : selected;
  const inspectorUnavailable = !inspectorScopeMatches
    ? "These edits belong to an earlier world entry or Studio project. Copy them before discarding; they cannot be applied to this scene."
    : hasInspectorDraft && inspectorSelection.current.some(object => !objects.has(object.id))
      ? "An edited object is no longer available. Your draft is preserved; revisit it in this world entry to reload it, or copy the edits before discarding."
      : undefined;
  const online = mode === "network" && phase === "online";
  const universeConnected =
    mode === "network" && ["online", "connected", "entering"].includes(phase);
  const canBuild = mode === "studio" || (online && world?.canBuild === true);
  const canEditTerrain = world?.terrainEnabled === true && (mode === "studio" || (online && world.canEditTerrain === true));
  const terrainDisabledReason = !world?.terrainEnabled ? "Terrain is disabled in this world." : !online && mode !== "studio" ? "Enter a world to edit terrain." : "This citizen does not have terrain-editing rights in this world.";
  const navigationActionContext = useRef(false);
  navigationActionContext.current = (mode === "studio" || online) && !building && !pending && !dialog && !hasInspectorDraft && !history.current.busy && !terrainPending && !hasTerrainDraft;
  const appendMessage = useCallback((message: ChatMessage) => {
    setMessages((items) => {
      const last = items.at(-1);
      if (
        message.kind === "error" &&
        last?.kind === "error" &&
        last.text === message.text &&
        Math.abs(last.time - message.time) < 1000
      )
        return items;
      return [...items, message].slice(-500);
    });
    if (!followChat.current) setUnread((count) => count + 1);
  }, []);
  const notify = useCallback((text: string) => {
    setToast(text);
  }, []);
  const inspectorMayLeave = useCallback(() => {
    if (worldSettingsDirty.current) { notify("Apply or discard your world-settings draft first."); return false; }
    if (terrainBusy.current) { notify("Wait for the current terrain edit to finish."); return false; }
    if (terrainDirty.current) { notify("Apply or discard the terrain preview first."); return false; }
    if (!inspectorDirty.current) return true;
    notify("Apply or discard your inspector edits first.");
    return false;
  }, [notify]);
  const toggleBuilding = useCallback(
    (next?: boolean) => {
      if (inspectorMayLeave()) setBuilding((current) => next ?? !current);
    },
    [inspectorMayLeave],
  );
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  const send = useCallback(
    async (command: ClientCommand) => {
      // Stop automatic movement before the asynchronous bridge processes leave;
      // its disconnected event can arrive after another animation frame.
      if (command.type === "disconnect") {
        disconnectRequested.current = true;
        engine.current?.setNavigationActionsEnabled?.(false);
      }
      try {
        await bridge.command(command);
      } catch (error) {
        if (command.type === "disconnect") {
          disconnectRequested.current = false;
          engine.current?.setNavigationActionsEnabled?.(navigationActionContext.current);
        }
        const message =
          error instanceof Error
            ? error.message
            : "The command could not be completed.";
        appendMessage(systemMessage(message, "error"));
        notify(message);
        throw error;
      }
    },
    [appendMessage, notify],
  );
  const fire = useCallback(
    (command: ClientCommand) => {
      void send(command).catch(() => {});
    },
    [send],
  );
  const resetHistory = useCallback(() => {
    buildEpoch.current++;
    history.current.reset();
    terrainHistory.current.reset();
    studioTerrainNeedsRender.current = false;
    setTerrainRevision(value => value + 1);
    refreshHistory((value) => value + 1);
    setPending(false);
  }, []);

  const persistStudio = useCallback((force = false) => {
    if (state.current.mode !== "studio" || activeWorld.current !== "@studio")
      return true;
    const { studioName, objects } = state.current;
    const position = engine.current?.getPosition?.() || state.current.position;
    const content = JSON.stringify([
      studioName,
      [...objects.values()],
      position,
      studioTerrain.current,
    ]);
    if (!force && content === lastStudioContent.current) return true;
    const snapshot = makeStudioProject(
      studioName,
      [...objects.values()],
      position,
      undefined,
      studioTerrain.current,
    );
    const result = snapshot.ok ? saveStudioProject(snapshot.value) : snapshot;
    if (!result.ok) {
      setProjectError(result.error.message);
      setProjectSaved(false);
      return false;
    }
    lastStudioContent.current = content;
    setProjectError("");
    setProjectSaved(true);
    return true;
  }, []);
  const persistInbox = useCallback(() => {
    if (!inboxScope.current) return true;
    const saved = saveSocialInbox(inboxScope.current, inbox.current);
    if (!saved.ok) {
      setInboxError(saved.error.message);
      return false;
    }
    inbox.current = saved.value;
    setTelegrams(saved.value);
    inboxDirty.current = false;
    setInboxError("");
    return true;
  }, []);
  const loadStudio = useCallback(
    (replacement?: StudioProject) => {
      resetGesture();
      const demo = createDemoWorld();
      const seed = makeStudioProject(
        "The Commons",
        demo.objects,
        demo.settings.entry,
      );
      if (!seed.ok) throw new Error(seed.error.message);
      const loaded = replacement
        ? {
            ok: true as const,
            value: { project: replacement, source: "saved" as const },
          }
        : loadStudioProject(seed.value);
      const project = loaded.ok ? loaded.value.project : seed.value;
      setProjectError(loaded.ok ? "" : loaded.error.message);
      setProjectSaved(loaded.ok && loaded.value.source === "saved");
      lastStudioContent.current = "";
      state.current.studioName = project.name;
      studioTerrain.current = project.terrain;
      state.current.position = project.position;
      setStudioName(project.name);
      demo.settings.title = project.name;
      demo.settings.canEditTerrain = true;
      activeWorld.current = "@studio";
      resetHistory();
      state.current.mode = "studio";
      setMode("studio");
      setPhase("disconnected");
      setStatus("Offline studio");
      setWorld(demo.settings);
      state.current.world = demo.settings;
      state.current.objects = new Map(project.objects.map((o) => [o.id, o]));
      localId.current = Math.max(10_000, ...project.objects.map((o) => o.id));
      setObjects(state.current.objects);
      setAvatars(new Map());
      setContacts([]);
      setTelegramPending(false);
      setSelection([]);
      setWhisper(null);
      setIdentity({ name: "Visitor", citizen: 0, session: 0 });
      engine.current?.setWorld(demo.settings);
      engine.current?.setObjects(project.objects, true);
      for (const tile of materializeStudioTerrain(project.terrain)) engine.current?.setTerrain(tile);
      engine.current?.setTerrainPageComplete?.(0, 0, true);
      setTerrainRevision(value => value + 1);
      engine.current?.teleport(project.position);
      setPosition(project.position);
      setMessages([
        systemMessage(
          "Welcome to your offline studio. Explore the plaza, try building, or connect to an Axis universe.",
        ),
        systemMessage(
          "W A S D to walk · Right-drag to look · Double-click for mouse look · Esc to release · B to build.",
        ),
      ]);
      followChat.current = true;
    },
    [resetHistory, resetGesture],
  );

  useEffect(() => {
    if (!canvas.current) return;
    try {
      engine.current = new WorldEngine(canvas.current, {
        onGestureState: (value) => gestureUpdate.current(value),
        onTerrainSelect: cell => { if (inspectorMayLeave()) setTerrainAnchor(cell); else engine.current?.setTerrainSelection?.(terrainRegion.current); },
        onTerrainPreviewCancelled: () => { setTerrainPreviewVisible(false); setTerrainRevision(value => value + 1); },
        onTransform: (changes) => transformBuild.current(changes),
        onAvatarCatalog: catalog => { setAvatarCatalog(catalog); setAvatarAssetState(null); },
        onAvatarAssetState: value => { if (value.local) setAvatarAssetState(value); },
        asset: (url) => bridge.asset(url),
        onSelect: (object, context) => {
          if (!inspectorMayLeave()) {
            const ids = inspectorSelection.current.map((object) => object.id);
            engine.current?.setSelection(ids, ids.at(-1));
            return;
          }
          setSelection((old) => {
            if (!context?.additive) return object ? [object.id] : [];
            if (!object) return old;
            if (old.includes(object.id))
              return old.filter((id) => id !== object.id);
            return old.length < 256 ? [...old, object.id] : old;
          });
          if (object && state.current.building) setBuilding(true);
        },
        onStats: setStats,
        onPosition: (p) => {
          const now = performance.now();
          if (now - lastMove.current < 100) return;
          lastMove.current = now;
          setPosition(p);
          state.current.position = p;
          if (
            state.current.mode === "network" &&
            state.current.phase === "online" &&
            !disconnectRequested.current
          ) {
            fire({ type: "move", position: p });
            const cell = `${Math.floor((p.x + 40) / 80)},${Math.floor((p.z + 40) / 80)}`;
            if (lastQuery.current !== cell) {
              lastQuery.current = cell;
              fire({ type: "query", x: p.x, z: p.z });
            }
          }
        },
        onAction: (action) => {
          if (action.type === "transform-error") {
            notify(action.value || "The transform could not be applied.");
            return;
          }
          if (action.type === "flight-denied") {
            notify(action.value || "Flying is disabled in this world.");
            return;
          }
          if (action.type === "teleport-denied") {
            notify(action.value || LOCAL_TELEPORT_DENIED);
            return;
          }
          if (action.type === "fly") {
            setFlying(action.value === "true");
            return;
          }
          if (action.type === "asset-error") {
            appendMessage(
              systemMessage(
                action.value || "An asset could not be loaded.",
                "error",
              ),
            );
            return;
          }
          if (action.type === "url") {
            notify(
              `Object link: ${action.value || ""}. External links are not opened automatically.`,
            );
            return;
          }
          if (action.type === "teleport" && action.value) {
            if (!inspectorMayLeave()) return;
            if (history.current.busy) {
              notify("Wait for the current build operation to finish.");
              return;
            }
            const target = parseTeleport(
              action.value,
              engine.current?.getPosition() || initialPosition,
            );
            if (
              target &&
              target.world &&
              !sameWorld(target.world, state.current.world?.name)
            ) {
              if (state.current.mode === "network" && state.current.phase === "online" && state.current.world) {
                fire({
                  type: "enter",
                  world: target.world,
                  position: target.position,
                  origin: "action",
                  fromWorld: state.current.world.name,
                  session: state.current.identity.session,
                });
              } else notify("Connect to a universe to travel between worlds.");
            } else if (target) engine.current?.applyServerPosition(target.position);
            else notify(`Unrecognized teleport destination: ${action.value}`);
          }
          if (
            action.type === "click" &&
            action.object &&
            state.current.mode === "network"
          )
            fire({ type: "object-click", object: action.object });
        },
      });
      loadStudio();
    } catch (error) {
      setEngineError(
        error instanceof Error
          ? error.message
          : "Your device could not initialize 3D rendering.",
      );
    }
    return () => {
      gestureEpoch.current++;
      gestureActive.current = null;
      gestureUncleared.current = null;
      engine.current?.dispose();
      engine.current = null;
    };
  }, [appendMessage, fire, loadStudio, notify]);

  useEffect(
    () =>
      bridge.subscribe((event) => {
        if (state.current.mode === "studio") return;
        switch (event.type) {
          case "status":
            setPhase(event.phase);
            setStatus(event.message);
            state.current.phase = event.phase;
            if (event.phase !== "online") setWorldSettingsEpoch(value => value + 1);
            if (event.phase !== "online") resetGesture();
            if (event.phase === "entering") activeWorld.current = null;
            if (event.phase !== "online") resetHistory();
            if (event.phase === "disconnected") {
              socialEpoch.current++;
              pendingSocial.current = false;
              setSocialBusy(false);
            }
            break;
          case "login":
            disconnectRequested.current = false;
            state.current.identity = event;
            setIdentity(event);
            if (connectionTarget.current && event.citizen > 0) {
              inboxScope.current = {
                ...connectionTarget.current,
                citizen: event.citizen,
              };
              saveStored("last-inbox-scope", inboxScope.current);
              const loaded = loadSocialInbox(inboxScope.current);
              inbox.current = loaded.ok ? loaded.value : [];
              inboxDirty.current = false;
              setTelegrams(inbox.current);
              setInboxError(loaded.ok ? "" : loaded.error.message);
            } else {
              inboxScope.current = null;
              inbox.current = [];
              setTelegrams([]);
              setInboxError("");
            }
            break;
          case "contacts":
            setContacts(event.contacts);
            setContactOptions(event.defaultOptions);
            break;
          case "telegram-pending":
            setTelegramPending(event.pending);
            break;
          case "telegram": {
            if (!inboxScope.current) {
              appendMessage(
                systemMessage(
                  "A telegram arrived without a known local inbox identity. Keep this session open.",
                  "error",
                ),
              );
              break;
            }
            if (
              !inbox.current.some((message) => message.id === event.message.id)
            )
              inbox.current = [...inbox.current, event.message];
            inboxDirty.current = true;
            setTelegrams(inbox.current);
            if (!persistInbox())
              notify(
                "A telegram is only in memory. Open Contacts and telegrams to export it before closing.",
              );
            break;
          }
          case "worlds":
            setWorlds(event.worlds);
            break;
          case "world": {
            if (event.settings.caretaker !== true) setWorldSettingsEpoch(value => value + 1);
            const changedWorld = activeWorld.current !== event.settings.name;
            if (
              !changedWorld &&
              state.current.world?.objectPath !== event.settings.objectPath
            )
              stopGesture();
            activeWorld.current = event.settings.name;
            state.current.world = event.settings;
            setWorld(event.settings);
            if (changedWorld) {
              resetGesture();
              resetHistory();
              state.current.objects = new Map();
              setObjects(state.current.objects);
              setAvatars(new Map());
              setSelection([]);
              setWhisper(null);
              lastQuery.current = "";
              engine.current?.setWorld(event.settings);
              const entry = event.settings.entry;
              setPosition(entry);
              appendMessage(
                systemMessage(
                  event.settings.welcome ||
                    `Welcome to ${event.settings.title || event.settings.name}.`,
                ),
              );
            } else engine.current?.updateWorld(event.settings);
            break;
          }
          case "local-avatar":
            if (event.avatar !== avatarTypeRef.current) {
              resetGesture();
              avatarTypeRef.current = event.avatar;
              setAvatarType(event.avatar);
            }
            break;
          case "objects": {
            const next = event.replace
              ? new Map<number, WorldObject>()
              : new Map(state.current.objects);
            for (const object of event.objects) next.set(object.id, object);
            state.current.objects = next;
            setObjects(next);
            if (event.replace)
              setSelection((old) => old.filter((id) => next.has(id)));
            engine.current?.setObjects(event.objects, event.replace);
            break;
          }
          case "object-delete": {
            const next = new Map(state.current.objects);
            next.delete(event.id);
            state.current.objects = next;
            setObjects(next);
            setSelection((old) => old.filter((id) => id !== event.id));
            engine.current?.deleteObject(event.id);
            break;
          }
          case "stream-unload": {
            // Cache eviction is not a server deletion. Ignore old session/world
            // notifications and retain build history/drafts for explicit recovery.
            if (event.session !== state.current.identity.session || !sameWorld(event.world, state.current.world?.name)) break;
            const ids = new Set(event.objectIds), next = new Map(state.current.objects);
            for (const id of ids) next.delete(id);
            state.current.objects = next;
            setObjects(next);
            setSelection(old => old.filter(id => !ids.has(id)));
            engine.current?.unloadSceneData(event.objectIds, event.terrainPages);
            if (event.terrainPages.length) setTerrainRevision(value => value + 1);
            break;
          }
          case "avatar":
            setAvatars((old) =>
              new Map(old).set(event.avatar.session, event.avatar),
            );
            if (event.avatar.session !== state.current.identity.session)
              engine.current?.setAvatar(event.avatar);
            break;
          case "avatar-delete":
            setWhisper((value) =>
              value?.session === event.session ? null : value,
            );
            setAvatars((old) => {
              const next = new Map(old);
              next.delete(event.session);
              return next;
            });
            engine.current?.deleteAvatar(event.session);
            break;
          case "terrain":
            engine.current?.setTerrain(event.tile);
            setTerrainRevision(value => value + 1);
            break;
          case "terrain-page":
            if (event.session === state.current.identity.session && sameWorld(event.world, state.current.world?.name)) {
              engine.current?.setTerrainPageComplete?.(event.pageX, event.pageZ, event.complete);
              setTerrainRevision(value => value + 1);
            }
            break;
          case "chat":
            appendMessage(event.message);
            break;
          case "teleport":
            // Server positioning is not user navigation. Preserve inspector
            // drafts/in-flight mutations, but never veto the trusted position.
            if (event.world && !sameWorld(event.world, state.current.world?.name)) {
              fire({
                type: "enter",
                world: event.world,
                position: event.position,
              });
            } else engine.current?.applyServerPosition(event.position);
            break;
          case "error":
            appendMessage(systemMessage(event.message, "error"));
            notify(event.message);
            break;
          case "stats":
            setTraffic(event);
            break;
          case "query-complete":
            break;
          case "world-settings-result":
            // The scoped editor request observes this event independently.
            break;
        }
      }),
    [appendMessage, fire, notify, resetHistory, persistInbox, resetGesture],
  );
  useEffect(() => {
    engine.current?.setBuildMode(building);
  }, [building]);
  useEffect(() => {
    if (!terrainTool) return;
    engine.current?.setTerrainEditMode?.(building && canEditTerrain && !pending && !dialog && !terrainPending);
    engine.current?.setTerrainSelection?.(building ? terrainRegion.current : null);
    return () => engine.current?.setTerrainEditMode?.(false);
  }, [building, terrainTool, canEditTerrain, pending, dialog, terrainPending, renderedInspectorScope]);
  useEffect(() => {
    engine.current?.setSelection(building ? selection : [], selected?.id);
  }, [selection, building, selected?.id]);
  useEffect(() => {
    engine.current?.setTransformMode(transformMode);
  }, [transformMode]);
  useEffect(() => {
    engine.current?.setTransformSpace?.(transformSnap.space);
    engine.current?.setTransformSnap({
      translation: transformSnap.translation,
      rotation: (transformSnap.rotation * Math.PI) / 180,
    });
    saveStored("building-tools", transformSnap);
  }, [transformSnap]);
  useEffect(() => {
    engine.current?.setTransformEnabled(
      canBuild && !pending && !dialog && !hasInspectorDraft && !terrainTool && !terrainPending,
    );
  }, [canBuild, pending, dialog, hasInspectorDraft, terrainTool, terrainPending]);
  useEffect(() => {
    engine.current?.setNavigationActionsEnabled?.(
      navigationActionContext.current && (mode === "studio" || !disconnectRequested.current),
    );
  }, [mode, online, building, pending, dialog, hasInspectorDraft, terrainPending, hasTerrainDraft]);
  useEffect(() => {
    engine.current?.setTimeOfDay(environmentMode);
    saveStored("preferences", preferences);
  }, [preferences, environmentMode]);
  useEffect(() => {
    engine.current?.setWireframe(wireframe);
  }, [wireframe]);
  useEffect(() => {
    engine.current?.setCameraMode(cameraMode);
  }, [cameraMode]);
  useEffect(() => {
    engine.current?.setAvatarType(avatarType);
  }, [avatarType]);
  useEffect(() => {
    saveStored("places", places);
  }, [places]);
  useEffect(() => {
    if (followChat.current)
      chatScroll.current?.scrollTo({ top: chatScroll.current.scrollHeight });
  }, [messages, chatTab]);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (
        dialog ||
        /INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement).tagName) ||
        (event.target as HTMLElement).isContentEditable
      )
        return;
      if (buildKeys.current(event)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        toggleBuilding();
      }
      if (event.key === "Enter") {
        event.preventDefault();
        document.exitPointerLock?.();
        chatInput.current?.focus();
      }
      if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        document.exitPointerLock?.();
        setDialog("teleport");
      }
      if (event.key.toLowerCase() === "g") {
        event.preventDefault();
        document.exitPointerLock?.();
        setDialog("gestures");
      }
      if (event.key === "F1" || event.key === "?") {
        event.preventDefault();
        document.exitPointerLock?.();
        setDialog("help");
      }
    }
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [dialog, toggleBuilding]);
  useEffect(() => {
    if (!dialog) return;
    document.exitPointerLock?.();
    // Dialogs live outside the viewport's fullscreen subtree. Native window
    // fullscreen is independent and need not be exited.
    if (document.fullscreenElement === viewport.current)
      void document.exitFullscreen?.().catch(() => setToast("Press Escape to leave fullscreen and reveal the dialog."));
  }, [dialog]);
  useEffect(() => {
    if (!building) return;
    if (document.pointerLockElement === canvas.current) document.exitPointerLock?.();
    if (document.fullscreenElement === viewport.current)
      void document.exitFullscreen?.().catch(() => setToast("Press Escape to leave fullscreen and reveal the inspector."));
  }, [building]);
  useEffect(() => {
    if (mode !== "studio") return;
    const timer = setTimeout(() => persistStudio(), 300);
    return () => clearTimeout(timer);
  }, [objects, studioName, mode, persistStudio, terrainRevision]);
  useEffect(() => {
    const save = (event?: BeforeUnloadEvent) => {
      const unsavedStudio = !persistStudio();
      const unsavedInbox = inboxDirty.current && !persistInbox();
      if (
        (history.current.busy ||
          terrainBusy.current || terrainDirty.current ||
          inspectorDirty.current ||
          worldSettingsDirty.current ||
          pendingSocial.current ||
          unsavedStudio ||
          unsavedInbox) &&
        event
      ) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const timer = setInterval(() => save(), 3000);
    window.addEventListener("beforeunload", save);
    return () => {
      clearInterval(timer);
      window.removeEventListener("beforeunload", save);
      save();
    };
  }, [persistStudio, persistInbox]);

  async function applyWorldSettings(input: WorldSettingsSetCommand): Promise<WorldSettingsResult> {
    const assertCurrent = () => {
      const current = state.current, context = current.world?.editContext;
      if (current.mode !== "network" || current.phase !== "online" || disconnectRequested.current
        || current.world?.caretaker !== true || context?.blocked || !context
        || context.entryId !== input.entryId || current.identity.session !== input.session || !sameWorld(current.world.name, input.world))
        throw new Error("This world-settings draft no longer belongs to an editable world entry.");
    };
    assertCurrent(); assertCommand(input);
    const command = { ...input, changes: input.changes.map(change => ({ ...change })) };
    let unsubscribe = () => {}, timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {}, cancelled = false;
    const lifecycle = new Promise<never>((_resolve, reject) => {
      cancel = () => { cancelled = true; reject(new Error("World-settings confirmation is unavailable. Re-enter before editing again.")); };
    });
    worldSettingsCancels.current.add(cancel);
    const response = new Promise<WorldSettingsResult>(resolve => {
      unsubscribe = bridge.subscribe(event => {
        if (event.type === "status" && event.phase !== "online") cancel();
        if (event.type !== "world-settings-result" || event.requestId !== command.requestId
          || event.session !== command.session || event.entryId !== command.entryId || !sameWorld(event.world, command.world)) return;
        if (!["observed", "conflict", "uncertain"].includes(event.status)) { cancel(); return; }
        resolve(event);
      });
      // The protocol's 12-second observation window should finish first. This
      // guard also covers a missing result or a broken renderer bridge.
      timer = setTimeout(cancel, 15_000);
    });
    try {
      const [result] = await Promise.race([Promise.all([response, Promise.resolve().then(() => {
        if (cancelled) throw new Error("World-settings update cancelled before dispatch.");
        assertCurrent(); return bridge.command(command);
      })]), lifecycle]);
      return result;
    } finally {
      if (timer) clearTimeout(timer);
      unsubscribe(); worldSettingsCancels.current.delete(cancel);
    }
  }

  async function connect(options: ConnectionOptions) {
    if (!inspectorMayLeave())
      throw new Error(
        "Apply or discard your inspector edits before connecting.",
      );
    if (history.current.busy) {
      throw new Error("Wait for the current build operation to finish.");
    }
    if (mode === "studio" && !persistStudio(true))
      throw new Error(
        "Your studio could not be saved. Open Project to export it or resolve the storage error before connecting.",
      );
    if (pendingSocial.current || (inboxDirty.current && !persistInbox()))
      throw new Error(
        "Finish saving or exporting your telegrams before changing connections.",
      );
    if (mode === "network") await send({ type: "disconnect" });
    connectionTarget.current = {
      host: options.host,
      port: options.port,
      tls: options.tls,
    };
    socialEpoch.current++;
    setContacts([]);
    setTelegramPending(false);
    setSocialError("");
    state.current.mode = "network";
    setMode("network");
    state.current.world = null;
    setWorld(null);
    setMessages([]);
    setWorlds([]);
    try {
      await send({ type: "connect", options });
    } catch (error) {
      loadStudio();
      throw error;
    }
  }
  function studio() {
    if (!inspectorMayLeave()) return;
    if (history.current.busy) {
      notify("Wait for the current build operation to finish.");
      return;
    }
    if (pendingSocial.current || (inboxDirty.current && !persistInbox())) {
      notify("Save or export your telegrams before leaving this session.");
      return;
    }
    if (mode === "studio") {
      engine.current?.teleport(world?.entry || initialPosition);
      return;
    }
    if (mode === "network") fire({ type: "disconnect" });
    loadStudio();
  }
  function disconnect() {
    if (!inspectorMayLeave()) return;
    if (history.current.busy || pendingSocial.current) {
      notify("Wait for the current build or social operation to finish.");
      return;
    }
    if (inboxDirty.current && !persistInbox()) {
      notify("Save or export your telegrams before disconnecting.");
      return;
    }
    fire({ type: "disconnect" });
  }
  function currentGestureTransportScope(
    active: NonNullable<typeof gestureActive.current>,
  ) {
    return (
      active.epoch === gestureEpoch.current &&
      active.avatar === avatarTypeRef.current &&
      (!active.network ||
        (state.current.mode === "network" &&
          state.current.phase === "online" &&
          !disconnectRequested.current &&
          state.current.world?.name === active.world &&
          state.current.identity.session === active.session))
    );
  }
  function currentGestureScope(
    active: NonNullable<typeof gestureActive.current>,
  ) {
    return (
      currentGestureTransportScope(active) &&
      active.objectPath === (state.current.world?.objectPath || "")
    );
  }
  async function clearGestureState(
    active: NonNullable<typeof gestureActive.current>,
  ) {
    if (!active.network || !currentGestureTransportScope(active)) return;
    const operation = ++gestureOperation.current;
    gestureBusy.current = true;
    setGestureSending(true);
    try {
      await bridge.command({
        type: "gesture",
        gesture: 0,
        avatar: active.avatar,
        world: active.world,
        session: active.session,
      });
      if (currentGestureTransportScope(active)) {
        gestureUncleared.current = null;
        setGestureSyncError("");
      }
    } catch (cause) {
      if (currentGestureTransportScope(active)) {
        gestureUncleared.current = active;
        const message = `The local gesture stopped, but its server state could not be cleared: ${cause instanceof Error ? cause.message : "connection unavailable"}`;
        setGestureSyncError(message);
        notify(message);
      }
    } finally {
      if (
        active.epoch === gestureEpoch.current &&
        operation === gestureOperation.current
      ) {
        gestureBusy.current = false;
        setGestureSending(false);
      }
    }
  }
  gestureUpdate.current = (value) => {
    const active = gestureActive.current;
    if (!active || !currentGestureScope(active)) return;
    if (active.requestId === null) active.requestId = value.requestId;
    if (active.requestId !== value.requestId) return;
    setGesturePlayback(value);
    if (value.phase === "idle" || value.phase === "error") {
      gestureActive.current = null;
      if (value.phase === "error")
        notify(value.message || "This gesture could not be played.");
      void clearGestureState(active);
    }
  };
  async function playGesture(
    index: number,
    showSelf: boolean,
  ): Promise<boolean> {
    if (
      gestureBusy.current ||
      avatarSelecting.current ||
      (mode !== "studio" && !online)
    )
      return false;
    if (gestureUncleared.current)
      throw new Error(
        "Retry clearing the previous gesture state before starting another motion.",
      );
    const definition = avatarCatalog?.entries.find(
      (entry) => entry.index === avatarType,
    );
    if (
      !Number.isInteger(index) ||
      index < 1 ||
      index > 255 ||
      !definition?.explicit[index - 1]?.sequence.trim()
    )
      throw new Error("This gesture is not available for the selected avatar.");
    const epoch = ++gestureEpoch.current;
    const operation = ++gestureOperation.current;
    gestureActive.current = null;
    engine.current?.setGesture(0);
    const active = {
      requestId: null as number | null,
      epoch,
      gesture: index,
      network: mode === "network",
      world: world?.name || "",
      objectPath: world?.objectPath || "",
      avatar: avatarType,
      session: identity.session,
    };
    gestureBusy.current = true;
    setGestureSending(true);
    try {
      if (active.network)
        await bridge.command({
          type: "gesture",
          gesture: index,
          avatar: active.avatar,
          world: active.world,
          session: active.session,
        });
      if (!currentGestureScope(active) || !engine.current) {
        if (currentGestureTransportScope(active))
          await clearGestureState(active);
        return false;
      }
      gestureUncleared.current = null;
      setGestureSyncError("");
      if (showSelf) {
        engine.current.setCameraMode("third-person");
        setCameraMode("third-person");
      }
      gestureActive.current = active;
      active.requestId = engine.current.setGesture(index);
      return true;
    } catch (cause) {
      if (!currentGestureTransportScope(active)) return false;
      if (active.network) {
        gestureUncleared.current = active;
        setGesturePlayback({ requestId: 0, gesture: 0, phase: "idle" });
        setGestureSyncError(
          "Gesture dispatch failed. The previous or attempted motion may still be active remotely; clear its state before playing again.",
        );
      }
      if (!currentGestureScope(active)) return false;
      throw cause;
    } finally {
      if (
        epoch === gestureEpoch.current &&
        operation === gestureOperation.current
      ) {
        gestureBusy.current = false;
        setGestureSending(false);
      }
    }
  }
  function stopGesture() {
    const active = gestureActive.current || gestureUncleared.current;
    gestureActive.current = null;
    engine.current?.setGesture(0);
    setGesturePlayback({ requestId: 0, gesture: 0, phase: "idle" });
    if (active) void clearGestureState(active);
  }
  async function selectAvatar(index: number) {
    if (gestureBusy.current || avatarSelecting.current)
      throw new Error(
        "Wait for the current avatar or gesture command to finish.",
      );
    const epoch = gestureEpoch.current;
    const network = state.current.mode === "network";
    const currentWorld = state.current.world?.name;
    const currentSession = state.current.identity.session;
    if (network) {
      if (state.current.phase !== "online")
        throw new Error("Enter a world before choosing its avatar.");
      const operation = ++gestureOperation.current;
      avatarSelecting.current = true;
      gestureBusy.current = true;
      setGestureSending(true);
      try {
        await bridge.command({
          type: "avatar-select",
          avatar: index,
          world: currentWorld || "",
          session: currentSession,
        });
      } finally {
        avatarSelecting.current = false;
        if (operation === gestureOperation.current) {
          gestureBusy.current = false;
          setGestureSending(false);
        }
      }
      if (
        state.current.mode !== "network" ||
        state.current.world?.name !== currentWorld ||
        state.current.identity.session !== currentSession
      )
        return;
      // The protocol's local-avatar event may have already adopted this submitted type.
      if (avatarTypeRef.current === index) {
        resetGesture();
        return;
      }
    }
    if (epoch !== gestureEpoch.current) return;
    resetGesture();
    avatarTypeRef.current = index;
    setAvatarType(index);
  }
  async function socialCommand(command: SocialCommand) {
    if (pendingSocial.current)
      throw new Error(
        "A contacts or telegram operation is already in progress.",
      );
    if (
      state.current.mode !== "network" ||
      !["online", "connected", "entering"].includes(state.current.phase) ||
      state.current.identity.citizen <= 0
    )
      throw new Error(
        "Connect with a citizen account to use contacts and telegrams.",
      );
    if (command.type === "telegram-fetch" || command.type === "telegram-send") {
      if (!inboxScope.current || !persistInbox())
        throw new Error(
          "The local inbox cannot save messages. Export or resolve the storage error first.",
        );
      if (inbox.current.length >= SOCIAL_LIMITS.messages)
        throw new Error(
          "Your local inbox is full. Export and clear it before receiving more messages.",
        );
    }
    const epoch = socialEpoch.current;
    pendingSocial.current = true;
    setSocialBusy(true);
    setSocialError("");
    try {
      await bridge.command(command);
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : "The social command failed.";
      setSocialError(message);
      throw cause;
    } finally {
      if (epoch === socialEpoch.current) {
        pendingSocial.current = false;
        setSocialBusy(false);
      }
    }
  }
  function enter(name: string) {
    if (!inspectorMayLeave()) return;
    if (history.current.busy) {
      notify("Wait for the current build operation to finish.");
      return;
    }
    if (mode === "studio") {
      setDialog("connect");
      return;
    }
    if (sameWorld(name, state.current.world?.name) && !localTeleportAllowed(state.current.world)) {
      notify(LOCAL_TELEPORT_DENIED);
      return;
    }
    fire({ type: "enter", world: name });
  }
  async function submitChat(event: FormEvent) {
    event.preventDefault();
    const text = chat.trim();
    if (!text) return;
    if (text === "/help") {
      setDialog("help");
      setChat("");
      return;
    }
    if (text === "/home") {
      travel(world?.entry || initialPosition);
      setChat("");
      return;
    }
    if (!online) {
      appendMessage(
        systemMessage(
          "You are in an offline studio. Connect to a universe to chat with other people.",
        ),
      );
      setChat("");
      return;
    }
    try {
      await send({
        type: "chat",
        text,
        ...(whisper ? { whisperTo: whisper.session } : {}),
      });
      setChat("");
    } catch {
      /* Error already surfaced. */
    }
  }
  async function runBuild(
    label: string,
    changes: BuildChange[] = [],
    direction: "execute" | "undo" | "redo" = "execute",
    applyingDraft = false,
    closeDialog = true,
  ): Promise<boolean> {
    if (
      (!applyingDraft && !inspectorMayLeave()) ||
      !canBuild ||
      history.current.busy
    )
      return false;
    const epoch = buildEpoch.current;
    const adapter: BuildAdapter = {
      read: (id) => state.current.objects.get(id),
      apply: async (change) => {
        if (epoch !== buildEpoch.current)
          throw new Error("The world changed during this edit.");
        if (state.current.mode === "network")
          return requestBuildMutation(bridge, change);
        const after = change.after
          ? {
              ...change.after,
              id:
                change.before?.id ??
                (localId.current = nextLocalObjectId(
                  state.current.objects,
                  localId.current,
                )),
            }
          : null;
        const next = new Map(state.current.objects);
        if (change.before) next.delete(change.before.id);
        if (after) next.set(after.id, after);
        const snapshot = makeStudioProject(
          state.current.studioName,
          [...next.values()],
          state.current.position,
          undefined,
          studioTerrain.current,
        );
        if (!snapshot.ok) throw new Error(snapshot.error.message);
        if (after) engine.current?.setObjects([after]);
        else if (change.before) engine.current?.deleteObject(change.before.id);
        state.current.objects = next;
        setObjects(next);
        return { before: change.before, after };
      },
    };
    setPending(true);
    try {
      // Validate the complete batch before the first write; history also preflights stale objects.
      for (const change of changes)
        assertCommand(
          change.before && change.after
            ? {
                type: "object-change",
                previous: change.before,
                object: change.after,
              }
            : {
                type: change.after ? "object-add" : "object-delete",
                object: change.after ?? change.before!,
              },
        );
      const result =
        direction === "execute"
          ? await history.current.execute(label, changes, adapter)
          : direction === "undo"
            ? await history.current.undo(adapter)
            : await history.current.redo(adapter);
      if (result.cancelled || epoch !== buildEpoch.current) return false;
      if (result.applied.length && !result.error) {
        setSelection(
          result.applied.flatMap((change) =>
            change.after && state.current.objects.has(change.after.id)
              ? [change.after.id]
              : [],
          ),
        );
        setBuilding(true);
        if (closeDialog) setDialog(null);
      }
      if (result.error) {
        appendMessage(systemMessage(result.error, "error"));
        notify(result.error);
      } else if (result.applied.length)
        notify(
          direction === "execute"
            ? `${label} applied.`
            : `${direction === "undo" ? "Undid" : "Redid"} ${label.toLowerCase()}.`,
        );
      return !result.error;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "The build operation could not be completed.";
      appendMessage(systemMessage(message, "error"));
      notify(message);
      return false;
    } finally {
      if (epoch === buildEpoch.current) {
        setPending(false);
        refreshHistory((value) => value + 1);
      }
    }
  }
  async function saveObject(object: WorldObject) {
    if (renderedInspectorScope !== currentInspectorScope()) return false;
    if (inspectorDirty.current && inspectorDraftScope.current !== currentInspectorScope()) return false;
    const before = inspectedObject;
    const allowedId = inspectorDirty.current
      ? inspectorSelection.current.length === 1 && inspectorSelection.current[0].id === object.id
      : selected?.id === object.id;
    if (!before || before.id !== object.id || !allowedId || !sameBuildObject(before, state.current.objects.get(object.id))) return false;
    return runBuild(
      "Edit object",
      [{ before, after: object }],
      "execute",
      true,
    );
  }
  transformBuild.current = async (changes) => {
    if (dialog || pending || !inspectorMayLeave()) return false;
    return runBuild(
      transformMode === "rotate" ? "Rotate selection" : "Move selection",
      changes,
    );
  };
  async function saveSelection(next: WorldObject[]) {
    if (renderedInspectorScope !== currentInspectorScope()) return false;
    if (inspectorDirty.current && (inspectorDraftScope.current !== currentInspectorScope()
      || next.length !== inspectorSelection.current.length
      || next.some(object => !inspectorSelection.current.some(selected => selected.id === object.id)))) return false;
    if (next.length !== inspectedObjects.length || new Set(next.map(object => object.id)).size !== next.length
      || next.some(object => {
        const before = inspectedObjects.find(value => value.id === object.id);
        return !before || !sameBuildObject(before, state.current.objects.get(object.id));
      }))
      return false;
    return runBuild(
      "Transform selection",
      next.map((after) => ({
        before: inspectedObjects.find(object => object.id === after.id)!,
        after,
      })),
      "execute",
      true,
    );
  }
  function duplicateSelection() {
    if (!selectedObjects.length) return;
    void runBuild(
      selectedObjects.length === 1 ? "Duplicate object" : "Duplicate selection",
      selectedObjects.map((object) => ({
        before: null,
        after: { ...object, id: 0, x: object.x + 2, owner: identity.citizen },
      })),
    );
  }
  buildKeys.current = (event) => {
    if (building && terrainTool) return terrainKeys.current(event);
    if (!building || !canBuild || event.altKey) return false;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && (key === "z" || key === "y")) {
      event.preventDefault();
      const redo = key === "y" || event.shiftKey;
      const label = redo
        ? history.current.redoLabel
        : history.current.undoLabel;
      if (label) void runBuild(label, [], redo ? "redo" : "undo");
      return true;
    }
    if ((event.ctrlKey || event.metaKey) && key === "d") {
      event.preventDefault();
      duplicateSelection();
      return true;
    }
    if ((event.ctrlKey || event.metaKey) && key === "a") {
      event.preventDefault();
      if (!inspectorMayLeave()) return true;
      if (objects.size > 256)
        notify(
          "Select up to 256 objects at a time. Use Shift-click to choose a smaller group.",
        );
      else setSelection([...objects.keys()]);
      return true;
    }
    if ((key === "delete" || key === "backspace") && selectedObjects.length) {
      event.preventDefault();
      setDialog("delete");
      return true;
    }
    return false;
  };
  async function addObject(model: string, source?: WorldObject) {
    if (!canBuild) return false;
    const object: WorldObject = source
      ? {
          ...source,
          id: 0,
          x: source.x + 2,
          owner: identity.citizen,
        }
      : {
          id: 0,
          owner: identity.citizen,
          model,
          description: "",
          action: "",
          x: Math.round(position.x + Math.sin(position.yaw) * 4),
          y: Math.max(0, Math.round(position.y)),
          z: Math.round(position.z + Math.cos(position.yaw) * 4),
          yaw: 0,
          pitch: 0,
          roll: 0,
        };
    return runBuild(
      source ? "Duplicate object" : "Add object",
      [{ before: null, after: { ...object, id: 0 } }],
      "execute",
      false,
      false,
    );
  }
  async function deleteObject() {
    if (!selectedObjects.length) return;
    await runBuild(
      selectedObjects.length === 1 ? "Delete object" : "Delete selection",
      selectedObjects.map((before) => ({ before, after: null })),
    );
  }
  function travel(
    p: Position,
    targetWorld?: string,
    isStudio = mode === "studio",
  ) {
    if (!inspectorMayLeave()) return;
    if (history.current.busy) {
      notify("Wait for the current build operation to finish.");
      return;
    }
    try {
      assertCommand({ type: "move", position: p });
    } catch (error) {
      notify(error instanceof Error ? error.message : "Invalid destination.");
      return;
    }
    if (isStudio && mode !== "studio") {
      studio();
      engine.current?.teleport(p);
    } else if (!isStudio && mode === "studio") {
      notify("Connect to the saved place’s universe first.");
      return;
    } else if (targetWorld?.trim() && !sameWorld(targetWorld, state.current.world?.name)) {
      fire({ type: "enter", world: targetWorld.trim(), position: p });
    } else {
      if (!localTeleportAllowed(state.current.world)) {
        notify(LOCAL_TELEPORT_DENIED);
        return;
      }
      if (engine.current?.teleport(p) === false) return;
    }
    setDialog(null);
  }
  const filteredMessages =
    chatTab === "all"
      ? messages
      : messages.filter((m) => m.kind === "system" || m.kind === "error");
  const people = [...avatars.values()].filter(
    (a) =>
      a.session !== identity.session &&
      a.name.toLowerCase().includes(filter.toLowerCase()),
  );
  const shownWorlds = worlds.filter((w) =>
    w.name.toLowerCase().includes(filter.toLowerCase()),
  );
  const timeIcon =
    environmentMode === "world" ? <Globe size={16} /> : environmentMode === "day" ? (
      <Sun size={16} />
    ) : environmentMode === "night" ? (
      <Moon size={16} />
    ) : (
      <Sunset size={16} />
    );
  function cycleTime() {
    if (mode === "studio") setPreferences((p) => ({ ...p, time: p.time === "day" ? "sunset" : p.time === "sunset" ? "night" : "day" }));
    else setPreferences(p => ({ ...p, worldTime: p.worldTime === "world" || !p.worldTime ? "day" : p.worldTime === "day" ? "sunset" : p.worldTime === "sunset" ? "night" : "world" }));
  }

  return (
    <div className={`app ${preferences.compact ? "compact" : ""}`}>
      <header className="app-header">
        <button
          className="brand"
          title="Return to offline studio"
          onClick={studio}
        >
          <span className="brand-mark">
            <Compass size={26} strokeWidth={1.4} />
          </span>
          <span>
            wayfarer<span className="brand-dot">.</span>
          </span>
        </button>
        <div className="header-divider" />
        <span className="edition">A PLACE TO BELONG</span>
        <div className="header-spacer" />
        <span className={`connection-pill ${online ? "is-online" : ""}`}>
          <i />
          {mode === "studio" ? "Offline studio" : online ? "Connected" : status}
        </span>
        <button
          className="icon-button"
          title="Help and keyboard shortcuts"
          onClick={() => setDialog("help")}
        >
          <CircleHelp size={18} />
        </button>
        <button
          className="icon-button"
          title="Preferences"
          onClick={() => setDialog("settings")}
        >
          <Settings size={18} />
        </button>
        <button
          className="profile"
          onClick={() => setDialog("avatar")}
          title="Change avatar"
        >
          <span
            className="profile-avatar"
            style={{
              background: avatarColors[avatarType % avatarColors.length],
            }}
          >
            {identity.name.slice(0, 1).toUpperCase()}
          </span>
          <span>
            {identity.name}
            <small>
              {mode === "studio"
                ? "Wandering locally"
                : identity.citizen
                  ? `Citizen #${identity.citizen}`
                  : "Tourist"}
            </small>
          </span>
          <ChevronDown size={13} />
        </button>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-intro">
            <span className="eyebrow">THE UNIVERSE IS OPEN</span>
            <h1>Find your somewhere.</h1>
          </div>
          <div className="sidebar-tabs" role="tablist" aria-label="Explore">
            <button
              role="tab"
              aria-selected={sideTab === "worlds"}
              className={sideTab === "worlds" ? "active" : ""}
              onClick={() => {
                setSideTab("worlds");
                setFilter("");
              }}
            >
              <Globe size={17} />
              Worlds
            </button>
            <button
              role="tab"
              aria-selected={sideTab === "people"}
              className={sideTab === "people" ? "active" : ""}
              onClick={() => {
                setSideTab("people");
                setFilter("");
              }}
            >
              <Users size={17} />
              People
            </button>
            <button
              role="tab"
              aria-selected={sideTab === "places"}
              className={sideTab === "places" ? "active" : ""}
              onClick={() => {
                setSideTab("places");
                setFilter("");
              }}
            >
              <Bookmark size={17} />
              Places
            </button>
          </div>
          <label className="search-field">
            <Search size={15} />
            <input
              aria-label={`Search ${sideTab}`}
              placeholder={`Find ${sideTab === "worlds" ? "a world" : sideTab === "people" ? "someone" : "a place"}…`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <kbd>⌕</kbd>
          </label>
          <div className="sidebar-content">
            {sideTab === "worlds" && (
              <>
                <div className="section-label">
                  <span>
                    {mode === "studio" ? "YOUR SPACE" : "IN THIS UNIVERSE"}
                  </span>
                  <span>
                    {mode === "studio"
                      ? "01"
                      : String(worlds.length).padStart(2, "0")}
                  </span>
                </div>
                {mode === "studio" && (
                  <button className="world-card selected" onClick={studio}>
                    <div className="world-thumbnail">
                      <div className="mini-sun" />
                      <div className="mini-arch" />
                      <div className="mini-block" />
                    </div>
                    <div className="world-card-copy">
                      <span>
                        {world?.title || "The studio"}
                        <ChevronRight size={15} />
                      </span>
                      <p>A little room to imagine.</p>
                      <small>
                        <span className="tiny-dot" />
                        OFFLINE · ORIGINAL WORLD
                      </small>
                    </div>
                  </button>
                )}
                {shownWorlds.map((w, index) => (
                  <button
                    key={w.name}
                    className={`world-list-item ${w.name === world?.name ? "selected" : ""}`}
                    onClick={() => enter(w.name)}
                  >
                    <span className={`world-monogram tone-${index % 3}`}>
                      <Globe size={21} strokeWidth={1.4} />
                    </span>
                    <span>
                      <strong>{w.name}</strong>
                      <small>{w.status || "Open for exploring"}</small>
                    </span>
                    <span className="world-population">
                      <Users size={12} />
                      {w.users}
                    </span>
                  </button>
                ))}
                {mode === "network" && !shownWorlds.length && (
                  <p className="sidebar-empty">
                    {phase === "connecting" || phase === "authenticating"
                      ? "Finding your universe…"
                      : filter
                        ? "No worlds match your search."
                        : "No worlds are available yet."}
                  </p>
                )}
                {mode === "studio" && (
                  <div className="connect-card">
                    <span className="connect-card-icon">
                      <Navigation size={20} />
                    </span>
                    <h3>There’s more out there.</h3>
                    <p>
                      Visit friends, build together, and discover worlds made by
                      people.
                    </p>
                    <button
                      className="text-button"
                      onClick={() => setDialog("connect")}
                    >
                      Connect to a universe <ArrowRight size={15} />
                    </button>
                  </div>
                )}
              </>
            )}
            {sideTab === "people" && (
              <>
                <div className="section-label">
                  <span>HERE WITH YOU</span>
                  <span>{online ? people.length + 1 : 1}</span>
                </div>
                <div className="person-row">
                  <span
                    className="person-avatar"
                    style={{
                      background:
                        avatarColors[avatarType % avatarColors.length],
                    }}
                  >
                    {identity.name[0]}
                  </span>
                  <span>
                    <strong>
                      {identity.name} <em>you</em>
                    </strong>
                    <small>
                      {mode === "studio" ? "Offline studio" : world?.name}
                    </small>
                  </span>
                  <i className="presence-dot" />
                </div>
                {people.map((person, i) => (
                  <button
                    className="person-row"
                    key={person.session}
                    onClick={() => {
                      setWhisper(person);
                      chatInput.current?.focus();
                    }}
                    title={`Whisper to ${person.name}`}
                  >
                    <span
                      className="person-avatar"
                      style={{
                        background: avatarColors[i % avatarColors.length],
                      }}
                    >
                      {person.name[0]}
                    </span>
                    <span>
                      <strong>{person.name}</strong>
                      <small>Citizen #{person.citizen}</small>
                    </span>
                    <MessageCircle size={14} />
                  </button>
                ))}
                {!people.length && (
                  <div className="sidebar-empty">
                    <Users size={27} strokeWidth={1} />
                    <p>
                      {online
                        ? "A quiet moment in this world."
                        : "Connect to a universe to see who’s around."}
                    </p>
                  </div>
                )}
              </>
            )}
            {sideTab === "places" && (
              <>
                <div className="section-label">
                  <span>YOUR BOOKMARKS</span>
                  <button
                    className="icon-button"
                    title="Bookmark current place"
                    onClick={() => setDialog("bookmark")}
                  >
                    <Plus size={14} />
                  </button>
                </div>
                {places
                  .filter((p) =>
                    p.name.toLowerCase().includes(filter.toLowerCase()),
                  )
                  .map((p) => (
                    <div className="place-row" key={p.id}>
                      <button
                        disabled={!p.studio && sameWorld(p.world, world?.name) && !localTeleportAllowed(world)}
                        title={!p.studio && sameWorld(p.world, world?.name) && !localTeleportAllowed(world) ? LOCAL_TELEPORT_DENIED : undefined}
                        onClick={() => travel(p.position, p.world, p.studio)}
                      >
                        <MapPin size={18} />
                        <span>
                          <strong>{p.name}</strong>
                          <small>
                            {p.studio ? "Offline studio" : p.world} ·{" "}
                            {coordinates(p.position)}
                          </small>
                        </span>
                      </button>
                      <button
                        className="icon-button"
                        title={`Remove bookmark ${p.name}`}
                        onClick={() =>
                          setPlaces((ps) => ps.filter((x) => x.id !== p.id))
                        }
                      >
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                {!places.length && (
                  <div className="sidebar-empty">
                    <Bookmark size={28} strokeWidth={1} />
                    <p>Keep the places that feel like home.</p>
                    <button
                      className="subtle-button"
                      onClick={() => setDialog("bookmark")}
                    >
                      Save this spot
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="sidebar-bottom">
            <div className="build-note">
              <Box size={18} />
              <span>
                A world is what you make it.
                <small>Start with a single object.</small>
              </span>
            </div>
            <button
              className="secondary-button full-width"
              onClick={() => {
                setBuilding(true);
                setDialog("palette");
              }}
              disabled={!canBuild}
            >
              <Plus size={16} />
              Create something
            </button>
          </div>
        </aside>

        <main className="main-area">
          <div className="world-toolbar">
            <div className="world-breadcrumb">
              <Globe size={16} />
              <span>{mode === "studio" ? "Local" : "Universe"}</span>
              <ChevronRight size={13} />
              <strong>{world?.title || world?.name || "Choose a world"}</strong>
              <span className="world-tag">
                {mode === "studio" ? "STUDIO" : online ? "LIVE" : "OFFLINE"}
              </span>
            </div>
            <div className="toolbar-actions">
              <button className="icon-button" title="World details" aria-label="World details" onClick={() => setDialog("world-details")}><Info size={16} /></button>
              <button
                className="icon-button"
                title="Avatar gestures (G)"
                aria-label="Avatar gestures"
                onClick={() => setDialog("gestures")}
              >
                <Hand size={16} />
              </button>
              {(identity.citizen > 0 || inboxScope.current) && (
                <button
                  className="icon-button social-open"
                  title="Contacts and telegrams"
                  aria-label={
                    telegramPending
                      ? "Contacts and telegrams, new telegram pending"
                      : "Contacts and telegrams"
                  }
                  onClick={() => setDialog("social")}
                >
                  <Users size={16} />
                  {telegramPending && <i />}
                </button>
              )}
              {mode === "studio" && (
                <button
                  className={`subtle-button ${projectError ? "project-unsaved" : ""}`}
                  title={
                    projectError ||
                    (projectSaved
                      ? "Studio saved on this device"
                      : "Studio project")
                  }
                  onClick={() => setDialog("project")}
                >
                  <FolderOpen size={15} />
                  <span>Project</span>
                  {projectError && <span aria-label="Studio not saved">!</span>}
                </button>
              )}
              <button
                className="subtle-button"
                title="Travel to coordinates (T)"
                onClick={() => setDialog("teleport")}
              >
                <Navigation size={15} />
                <span>Travel</span>
              </button>
              <button
                className="icon-button"
                title="Bookmark this location"
                onClick={() => setDialog("bookmark")}
              >
                <Bookmark size={16} />
              </button>
              <span className="toolbar-separator" />
              <button
                className={`subtle-button ${building ? "is-active" : ""}`}
                aria-pressed={building}
                title="Toggle building mode (B)"
                onClick={() => toggleBuilding()}
              >
                <Box size={16} />
                <span>Build</span>
              </button>
            </div>
          </div>
          <div className="world-and-inspector">
            <div className="viewport" ref={viewport}>
              <canvas
                ref={canvas}
                aria-label="Interactive 3D world"
                tabIndex={0}
              />
              {engineError && (
                <div className="engine-error">
                  <h2>3D rendering couldn’t start.</h2>
                  <p>{engineError}</p>
                  <p>Wayfarer requires hardware-accelerated WebGL 2.</p>
                </div>
              )}
              <div className="viewport-top">
                <div className="location-card">
                  <span className="location-symbol">
                    <MapPin size={17} />
                  </span>
                  <div>
                    <strong>{world?.title || "Welcome"}</strong>
                    <span>
                      {mode === "studio"
                        ? "An original space. Endless possibilities."
                        : world?.name || status}
                    </span>
                  </div>
                </div>
                <button
                  className="glass-button time-control"
                  onClick={cycleTime}
                  title={mode === "studio" ? "Cycle local lighting" : environmentMode === "world" ? "World lighting · click for a local override" : "Local lighting override · click to cycle"}
                >
                  {timeIcon}
                  <span>
                    {environmentMode === "world" ? "World lighting" : environmentMode === "day"
                      ? "Daylight"
                      : environmentMode === "night"
                        ? "After hours"
                        : "Golden hour"}
                    {mode === "network" && environmentMode !== "world" && " · local"}
                  </span>
                  <ChevronDown size={12} />
                </button>
              </div>
              {preferences.reticle && !building && (
                <div className="reticle" aria-hidden="true" />
              )}
              {gesturePlayback.gesture > 0 &&
                gesturePlayback.phase !== "idle" &&
                gesturePlayback.phase !== "error" && (
                  <div className="gesture-playing" role="status">
                    <Hand size={17} />
                    <span>
                      {avatarCatalog?.entries.find(
                        (entry) => entry.index === avatarType,
                      )?.explicit[gesturePlayback.gesture - 1]?.name ||
                        "Gesture"}
                      <small>
                        {gesturePlayback.phase === "loading"
                          ? "Loading motion…"
                          : mode === "studio"
                            ? "Playing locally"
                            : "Playing locally · submitted to world"}
                      </small>
                    </span>
                    <button disabled={gestureSending} onClick={stopGesture}>
                      Stop
                    </button>
                  </div>
                )}
              {gestureSyncError && (
                <div className="gesture-playing" role="alert">
                  <span>
                    Gesture state needs attention
                    <small>{gestureSyncError}</small>
                  </span>
                  <button disabled={gestureSending} onClick={stopGesture}>
                    Retry clear
                  </button>
                </div>
              )}
              {building && <div className="terrain-tool-switch" role="group" aria-label="Building category">
                <button aria-pressed={!terrainTool} disabled={terrainPending} onClick={() => { if (inspectorMayLeave()) setTerrainTool(false); }}><Box size={14} />Objects</button>
                <button aria-pressed={terrainTool} disabled={pending || terrainPending} onClick={() => { if (inspectorMayLeave()) { setTerrainTool(true); setSelection([]); } }}><Layers size={14} />Terrain</button>
              </div>}
              {building && !terrainTool && (
                <div className="build-tools-container">
                  <div className="build-mode-bar">
                    <span>
                      <Box size={14} />
                      BUILD MODE
                    </span>
                    <span>
                      {selectedObjects.length
                        ? `${selectedObjects.length} selected`
                        : "Shift-click to select multiple"}
                    </span>
                    <button
                      aria-label="Undo build"
                      title={
                        history.current.undoLabel
                          ? `Undo ${history.current.undoLabel.toLowerCase()} (Ctrl/⌘ Z)`
                          : "Nothing to undo"
                      }
                      disabled={
                        !canBuild || pending || !history.current.undoLabel
                      }
                      onClick={() =>
                        void runBuild(history.current.undoLabel, [], "undo")
                      }
                    >
                      <Undo2 size={14} />
                    </button>
                    <button
                      aria-label="Redo build"
                      title={
                        history.current.redoLabel
                          ? `Redo ${history.current.redoLabel.toLowerCase()} (Ctrl/⌘ Shift Z)`
                          : "Nothing to redo"
                      }
                      disabled={
                        !canBuild || pending || !history.current.redoLabel
                      }
                      onClick={() =>
                        void runBuild(history.current.redoLabel, [], "redo")
                      }
                    >
                      <Redo2 size={14} />
                    </button>
                    <button
                      onClick={() => setDialog("palette")}
                      disabled={!canBuild}
                    >
                      <Plus size={14} />
                      Add object
                    </button>
                  </div>
                  <div
                    className="transform-toolbar"
                    aria-label="3D building tools"
                  >
                    <div
                      className="transform-modes"
                      role="group"
                      aria-label="Transform mode"
                    >
                      {(
                        [
                          ["select", MousePointer2, "Select"],
                          ["translate", Move3D, "Move"],
                          ["rotate", Rotate3D, "Rotate"],
                        ] as const
                      ).map(([value, Icon, label]) => (
                        <button
                          type="button"
                          key={value}
                          aria-pressed={transformMode === value}
                          aria-label={`${label} tool`}
                          title={`${label} tool`}
                          disabled={
                            pending || (value !== "select" && !canBuild)
                          }
                          onClick={() => {
                            if (inspectorMayLeave()) setTransformMode(value);
                          }}
                        >
                          <Icon size={14} />
                          <span>{label}</span>
                        </button>
                      ))}
                    </div>
                    <label>
                      Axes
                      <select
                        aria-label="Transform axes"
                        aria-describedby="transform-space-help"
                        value={transformSnap.space}
                        disabled={pending || terrainPending || hasInspectorDraft || !!dialog || !canBuild}
                        title="Local axes follow the gold-outlined primary object's authored rotation; a group keeps its shared centre."
                        onChange={(event) => {
                          const space = event.target.value;
                          if (!pending && !terrainPending && !dialog && canBuild && (space === "world" || space === "local") && inspectorMayLeave())
                            setTransformSnap(current => ({ ...current, space }));
                        }}
                      >
                        <option value="world">World</option>
                        <option value="local">Local</option>
                      </select>
                    </label>
                    <label>
                      Move snap
                      <select
                        aria-label="Translation snap"
                        value={transformSnap.translation}
                        disabled={pending}
                        onChange={(event) =>
                          setTransformSnap((current) => ({
                            ...current,
                            translation: Number(event.target.value),
                          }))
                        }
                      >
                        {[0, 0.1, 0.25, 0.5, 1].map((step) => (
                          <option key={step} value={step}>
                            {step ? `${step} m` : "Off"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      Turn snap
                      <select
                        aria-label="Rotation snap"
                        value={transformSnap.rotation}
                        disabled={pending}
                        onChange={(event) =>
                          setTransformSnap((current) => ({
                            ...current,
                            rotation: Number(event.target.value),
                          }))
                        }
                      >
                        {[0, 5, 15, 45, 90].map((step) => (
                          <option key={step} value={step}>
                            {step ? `${step}°` : "Off"}
                          </option>
                        ))}
                      </select>
                    </label>
                    <span className="transform-help" id="transform-space-help">
                      {hasInspectorDraft
                        ? "Apply or discard inspector edits first"
                        : transformMode === "select"
                          ? "Choose an object, then Move or Rotate"
                          : transformSnap.space === "local"
                            ? "Primary object's axes · Relative snap · Shared centre · Esc cancels · Release applies"
                            : "World axes · World-grid snap · Esc cancels · Release applies"}
                    </span>
                  </div>
                </div>
              )}
              <div className="viewport-bottom">
                <div className="movement-hints">
                  <span>
                    <kbd>W</kbd>
                    <span className="stacked-keys">
                      <kbd>A</kbd>
                      <kbd>S</kbd>
                      <kbd>D</kbd>
                    </span>
                  </span>
                  <div>
                    <span aria-live="polite" aria-label="Mouse look status">{mouseCaptured ? "Mouse look captured" : "Move around"}</span>
                    <small>{mouseCaptured ? "Move mouse to look · Esc to release" : "Right-drag to look · Double-click to capture"}</small>
                  </div>
                </div>
                <div className="viewport-buttons">
                  <button
                    className="glass-button"
                    title={world?.canFly === false ? "Flying is disabled in this world" : flying ? "Stop flying (F)" : "Start flying (F)"}
                    disabled={world?.canFly === false}
                    aria-pressed={flying}
                    onClick={() => engine.current?.setFlying(!flying)}
                  >
                    {flying ? (
                      <Navigation size={17} />
                    ) : (
                      <Footprints size={17} />
                    )}
                  </button>
                  <button
                    className="glass-button"
                    title={
                      cameraMode === "first-person"
                        ? "Switch to third person"
                        : "Switch to first person"
                    }
                    onClick={() =>
                      setCameraMode((v) =>
                        v === "first-person" ? "third-person" : "first-person",
                      )
                    }
                  >
                    <Eye size={17} />
                  </button>
                  <button
                    className="glass-button"
                    title={localTeleportAllowed(world) ? "Return to world entrance" : LOCAL_TELEPORT_DENIED}
                    aria-label="Return to world entrance"
                    disabled={!localTeleportAllowed(world)}
                    onClick={() => travel(world?.entry || initialPosition)}
                  >
                    <Crosshair size={17} />
                  </button>
                  <button
                    className="glass-button"
                    title="Toggle fullscreen"
                    aria-label={viewportFullscreen ? "Exit viewport fullscreen" : "Enter viewport fullscreen"}
                    aria-pressed={viewportFullscreen}
                    onClick={() => {
                      if (document.fullscreenElement)
                        void document.exitFullscreen().catch(() => setToast("Fullscreen could not be closed. Press Escape to exit."));
                      else void viewport.current?.requestFullscreen().catch(() => setToast("Fullscreen is unavailable in this window."));
                    }}
                  >
                    <Maximize size={17} />
                  </button>
                </div>
              </div>
              <div
                className="compass-widget"
                title={`Heading ${Math.round((position.yaw * 180) / Math.PI)}°`}
              >
                <span>N</span>
                <Navigation
                  size={21}
                  style={{ transform: `rotate(${-position.yaw}rad)` }}
                />
              </div>
              {toast && (
                <div className="toast" role="status">
                  <Check size={16} />
                  <span>{toast}</span>
                  <button
                    title="Dismiss notification"
                    onClick={() => setToast("")}
                  >
                    <X size={13} />
                  </button>
                </div>
              )}
            </div>
            <TerrainEditor open={building && terrainTool} scope={renderedInspectorScope} anchor={terrainAnchor} revision={terrainRevision} previewVisible={terrainPreviewVisible}
              canEdit={canEditTerrain && !pending && !dialog && !hasInspectorDraft} disabledReason={pending ? "Finish the current object edit first." : dialog ? "Close the dialog to continue terrain editing." : hasInspectorDraft ? "Apply or discard the object inspector draft first." : terrainDisabledReason} studio={mode === "studio"} offset={world?.terrainOffset ?? 0}
              history={terrainHistory.current} sample={readTerrain} onAnchor={setTerrainAnchor} onRegion={terrainRegionChanged} onPreview={previewTerrain} onCancelPreview={cancelTerrainPreview}
              onApply={applyTerrain} onBusy={terrainBusyChanged} onDirty={terrainDirtyChanged} onKeys={terrainKeyHandler}
              onHere={() => { if (inspectorMayLeave()) setTerrainAnchor({ cellX: Math.floor(position.x / 10), cellZ: Math.floor(position.z / 10) }); }} onClose={() => toggleBuilding(false)} />
            {building && !terrainTool && inspectedObjects.length > 1 ? (
              <SelectionInspector
                key={inspectedObjects.map((object) => object.id).join(",")}
                objects={inspectedObjects}
                pending={pending}
                canBuild={
                  canBuild && inspectorScopeMatches &&
                  inspectedObjects.every((object) => objects.has(object.id))
                }
                unavailableReason={inspectorUnavailable}
                onDirtyChange={inspectorDraftChanged}
                onSave={saveSelection}
                onDuplicate={duplicateSelection}
                onDelete={() => setDialog("delete")}
                onClose={() => toggleBuilding(false)}
              />
            ) : (
              building && !terrainTool && (
                <Inspector
                  object={inspectedObject}
                  canBuild={canBuild && inspectorScopeMatches}
                  unavailableReason={inspectorUnavailable}
                  pending={pending}
                  onDirtyChange={inspectorDraftChanged}
                  onSave={saveObject}
                  onDelete={() => setDialog("delete")}
                  onDuplicate={duplicateSelection}
                  onClose={() => toggleBuilding(false)}
                />
              )
            )}
          </div>
          <section
            className={`chat-panel ${chatExpanded ? "expanded" : ""}`}
            aria-label="World chat"
          >
            <div className="chat-heading">
              <div className="chat-tabs">
                <button
                  className={chatTab === "all" ? "active" : ""}
                  onClick={() => setChatTab("all")}
                >
                  <MessageCircle size={15} />
                  World chat
                </button>
                <button
                  className={chatTab === "system" ? "active" : ""}
                  onClick={() => setChatTab("system")}
                >
                  Activity
                </button>
              </div>
              <span className="chat-context">
                {mode === "studio"
                  ? "ONLY YOU, FOR NOW"
                  : `${avatars.size - (avatars.has(identity.session) ? 1 : 0) + (online ? 1 : 0)} IN THIS WORLD`}
              </span>
              <button
                className="icon-button"
                title={chatExpanded ? "Collapse chat" : "Expand chat"}
                onClick={() => setChatExpanded((v) => !v)}
              >
                <ChevronDown
                  size={16}
                  className={chatExpanded ? "" : "rotate-180"}
                />
              </button>
            </div>
            <div
              className="chat-messages"
              ref={chatScroll}
              role="log"
              aria-live="polite"
              aria-relevant="additions"
              onScroll={(e) => {
                const node = e.currentTarget;
                followChat.current =
                  node.scrollHeight - node.scrollTop - node.clientHeight < 35;
                if (followChat.current) setUnread(0);
              }}
            >
              {filteredMessages.map((message) => (
                <div
                  className={`chat-line kind-${message.kind}`}
                  key={message.id}
                >
                  <time>
                    {new Date(message.time).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    })}
                  </time>
                  <span className="chat-name">
                    {message.kind === "system" ? (
                      <Compass size={13} />
                    ) : (
                      message.name
                    )}
                    {message.kind === "whisper" && <small> whisper</small>}
                  </span>
                  <span>{message.text}</span>
                </div>
              ))}
            </div>
            {unread > 0 && (
              <button
                className="unread-button"
                onClick={() => {
                  followChat.current = true;
                  setUnread(0);
                  chatScroll.current?.scrollTo({
                    top: chatScroll.current.scrollHeight,
                  });
                }}
              >
                <ArrowDown size={12} />
                {unread} new messages
              </button>
            )}
            <form className="chat-composer" onSubmit={submitChat}>
              {whisper ? (
                <button
                  type="button"
                  className="whisper-chip"
                  onClick={() => setWhisper(null)}
                >
                  To {whisper.name}
                  <X size={12} />
                </button>
              ) : (
                <MessageCircle size={17} />
              )}
              <input
                ref={chatInput}
                aria-label="Chat message"
                placeholder={
                  online
                    ? whisper
                      ? `Whisper to ${whisper.name}…`
                      : "Say hello to the world…"
                    : "Connect to chat · Try /help or /home"
                }
                value={chat}
                maxLength={1024}
                onChange={(e) => setChat(e.target.value)}
              />
              <span className="composer-hint">
                ENTER <CornerDownLeft size={12} />
              </span>
              <button
                className="send-button"
                title="Send message"
                disabled={!chat.trim()}
              >
                <Send size={16} />
              </button>
            </form>
          </section>
        </main>
      </div>
      <footer className="status-bar">
        <button
          onClick={() =>
            universeConnected ? disconnect() : setDialog("connect")
          }
          title={
            universeConnected
              ? "Disconnect from universe"
              : "Connect to universe"
          }
        >
          {universeConnected ? <Wifi size={13} /> : <WifiOff size={13} />}
          <span>
            {mode === "studio"
              ? "Offline studio"
              : universeConnected
                ? "Universe connected"
                : "Disconnected"}
          </span>
        </button>
        <span className="status-divider" />
        <span>
          <MapPin size={12} />
          {coordinates(position)}
        </span>
        <span className="status-divider" />
        <span>
          <Box size={12} />
          {objects.size.toLocaleString()} objects
        </span>
        <div className="header-spacer" />
        {online && (
          <span
            title={`${traffic.received} bytes received / ${traffic.sent} bytes sent`}
          >
            ↓ {(traffic.received / 1024).toFixed(1)} KB
          </span>
        )}
        <span className="fps">
          <i />
          {stats.fps} FPS
        </span>
        <span className="status-divider" />
        <span className="version">
          WAYFARER {version} · {bridge.mode.toUpperCase()}
        </span>
      </footer>

      {dialog === "connect" && (
        <ConnectDialog onClose={() => setDialog(null)} onConnect={connect} />
      )}
      {dialog === "social" && (
        <SocialDialog
          contacts={contacts}
          defaultOptions={contactOptions}
          messages={telegrams}
          telegramPending={telegramPending}
          accountLabel={
            inboxScope.current
              ? `Citizen #${inboxScope.current.citizen} · ${inboxScope.current.host}:${inboxScope.current.port}${inboxScope.current.tls ? " · TLS" : ""}`
              : undefined
          }
          busy={socialBusy}
          connected={
            mode === "network" &&
            ["online", "connected", "entering"].includes(phase)
          }
          error={inboxError || socialError}
          receiveBlocked={!!inboxError}
          onCommand={socialCommand}
          onClose={() => setDialog(null)}
          onClearInbox={async (confirmedIds) => {
            if (!inboxScope.current || pendingSocial.current)
              throw new Error("Wait for any pending message to finish.");
            if (
              inbox.current.some(
                (message) => !confirmedIds.includes(message.id),
              )
            )
              throw new Error(
                "A new message arrived. Review and export it before clearing the inbox.",
              );
            const cleared = clearSocialInbox(inboxScope.current, confirmedIds);
            if (!cleared.ok) throw new Error(cleared.error.message);
            inbox.current = [];
            inboxDirty.current = false;
            setTelegrams([]);
            setInboxError("");
          }}
        />
      )}
      {dialog === "project" &&
        mode === "studio" &&
        (() => {
          const snapshot = makeStudioProject(
            studioName,
            [...objects.values()],
            engine.current?.getPosition?.() || position,
            undefined,
            studioTerrain.current,
          );
          if (!snapshot.ok)
            return (
              <Modal
                title="Studio needs attention"
                onClose={() => setDialog(null)}
              >
                <p role="alert">{snapshot.error.message}</p>
              </Modal>
            );
          return (
            <StudioProjectDialog
              project={snapshot.value}
              saveError={projectError}
              onClose={() => setDialog(null)}
              onRename={(name) => {
                const next = makeStudioProject(
                  name,
                  [...state.current.objects.values()],
                  state.current.position,
                  undefined,
                  studioTerrain.current,
                );
                if (!next.ok) return next.error.message;
                const saved = saveStudioProject(next.value);
                if (!saved.ok) return saved.error.message;
                state.current.studioName = next.value.name;
                setStudioName(next.value.name);
                if (world) {
                  const settings = { ...world, title: next.value.name };
                  state.current.world = settings;
                  setWorld(settings);
                  engine.current?.updateWorld(settings);
                }
                setProjectError("");
                setProjectSaved(true);
                notify("Studio project saved.");
              }}
              onReplace={(project) => {
                if (!inspectorMayLeave())
                  return "Apply or discard your inspector edits before replacing the studio.";
                if (history.current.busy)
                  return "Wait for the current build operation to finish.";
                if (!project) {
                  const demo = createDemoWorld();
                  const seed = makeStudioProject(
                    "The Commons",
                    demo.objects,
                    demo.settings.entry,
                  );
                  if (!seed.ok) return seed.error.message;
                  project = seed.value;
                }
                const saved = saveStudioProject(project, undefined, {
                  replaceCorrupt: true,
                });
                if (!saved.ok) return saved.error.message;
                loadStudio(saved.value);
                notify("Studio project opened.");
              }}
            />
          );
        })()}
      {dialog === "teleport" && (
        <TravelDialog
          position={position}
          world={world?.name || ""}
          localTeleportAllowed={localTeleportAllowed(world)}
          onClose={() => setDialog(null)}
          onTravel={travel}
        />
      )}
      {dialog === "bookmark" && (
        <BookmarkDialog
          limitReached={places.length >= 100}
          onClose={() => setDialog(null)}
          initialName={world?.title || world?.name || "My place"}
          location={coordinates(position)}
          onSave={(name) => {
            if (places.length >= 100) return;
            setPlaces((ps) => [
              ...ps,
              {
                id: crypto.randomUUID(),
                name,
                world: world?.name || "",
                position: { ...position },
                studio: mode === "studio",
              },
            ]);
            setDialog(null);
            setSideTab("places");
            notify("Place saved. Come back any time.");
          }}
        />
      )}
      {dialog === "palette" && (
        <ModelBrowserDialog
          studio={mode === "studio"}
          objects={modelObjects}
          scope={modelScope}
          objectPath={world?.objectPath || ""}
          asset={previewAsset}
          canBuild={canBuild}
          pending={pending}
          onClose={() => setDialog(null)}
          onAdd={addObject}
          onNotice={notify}
        />
      )}
      {dialog === "delete" && (
        <Modal
          title={
            selectedObjects.length > 1
              ? `Remove ${selectedObjects.length} objects?`
              : "Remove this object?"
          }
          subtitle={
            selectedObjects.length > 1
              ? "Every selected object will be removed from the world."
              : `${selected?.model || "This object"} will be removed from the world.`
          }
          onClose={() => setDialog(null)}
        >
          <p className="dialog-copy">
            {mode === "studio"
              ? "This changes your saved studio. You can undo it during this session or restore an exported project later."
              : "This change is sent to the world server. Undo will attempt to recreate accepted deletions with server-assigned IDs; permissions still apply."}
          </p>
          <div className="dialog-actions">
            <button
              className="secondary-button"
              onClick={() => setDialog(null)}
            >
              {selectedObjects.length > 1 ? "Keep objects" : "Keep object"}
            </button>
            <button
              className="danger-button"
              disabled={pending}
              onClick={() => void deleteObject()}
            >
              <Trash2 size={15} />
              {pending
                ? "Removing…"
                : selectedObjects.length > 1
                  ? "Delete objects"
                  : "Delete object"}
            </button>
          </div>
        </Modal>
      )}
      {dialog === "settings" && (
        <Modal
          title="Make yourself comfortable."
          subtitle="Personal preferences stay on this device."
          onClose={() => setDialog(null)}
        >
          <div className="form-stack">
            <div className="field-label">{mode === "studio" ? "Studio atmosphere" : "World lighting"}</div>
            {mode === "network" && <button className={`secondary-button full-width ${environmentMode === "world" ? "is-active" : ""}`} aria-pressed={environmentMode === "world"} onClick={() => setPreferences(p => ({ ...p, worldTime: "world" }))}><Globe size={16} />Follow the world’s lighting</button>}
            <div className="time-options">
              {(["day", "sunset", "night"] as const).map((time) => (
                <button
                  className={environmentMode === time ? "selected" : ""}
                  key={time}
                  onClick={() => setPreferences((p) => mode === "studio" ? ({ ...p, time }) : ({ ...p, worldTime: time }))}
                >
                  {time === "day" ? (
                    <Sun />
                  ) : time === "sunset" ? (
                    <Sunset />
                  ) : (
                    <Moon />
                  )}
                  <span>
                    {time === "day"
                      ? "Daylight"
                      : time === "sunset"
                        ? "Golden hour"
                        : "After hours"}
                  </span>
                </button>
              ))}
            </div>
            {mode === "network" && <p className="form-note">The presets above are personal sky and lighting overrides. World fog, water and movement restrictions still apply. No server settings are changed.</p>}
            <label className="toggle-row">
              <span>
                Center reticle<small>A small guide for looking around.</small>
              </span>
              <input
                type="checkbox"
                checked={preferences.reticle}
                onChange={(e) =>
                  setPreferences((p) => ({ ...p, reticle: e.target.checked }))
                }
              />
            </label>
            <label className="toggle-row">
              <span>
                Compact interface
                <small>A little more room for your world.</small>
              </span>
              <input
                type="checkbox"
                checked={preferences.compact}
                onChange={(e) =>
                  setPreferences((p) => ({ ...p, compact: e.target.checked }))
                }
              />
            </label>
            <label className="toggle-row">
              <span>
                Wireframe view
                <small>Inspect the geometry behind the scene.</small>
              </span>
              <input
                type="checkbox"
                checked={wireframe}
                onChange={(e) => setWireframe(e.target.checked)}
              />
            </label>
            <div className="settings-about">
              <Compass size={24} />
              <span>
                Wayfarer {version}
                <small>
                  Independent client for Axis virtual worlds.
                  <br />
                  An early implementation, not full AW feature parity.
                </small>
              </span>
            </div>
          </div>
        </Modal>
      )}
      {dialog === "avatar" && (
        <AvatarDialog
          key={`${mode}:${identity.session}:${world?.name}:${world?.objectPath}`}
          studio={mode === "studio"}
          catalog={avatarCatalog}
          current={avatarType}
          assetState={avatarAssetState}
          onSelect={selectAvatar}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "world-details" && <WorldDetailsDialog settings={world} studio={mode === "studio"} online={online} environmentMode={environmentMode} onFollowWorld={() => setPreferences(p => ({ ...p, worldTime: "world" }))} onEdit={() => setDialog("world-settings")} onClose={() => setDialog(null)} />}
      {dialog === "world-settings" && <WorldSettingsDialog settings={world} studio={mode === "studio"} online={online} session={identity.session} invalidationEpoch={worldSettingsEpoch} onApply={applyWorldSettings} onGuardChange={worldSettingsGuardChanged} onDirtyChange={worldSettingsDirtyChanged} onClose={() => setDialog(null)} />}
      {dialog === "gestures" && (
        <GestureDialog
          key={`${mode}:${identity.session}:${world?.name}:${world?.objectPath}:${avatarType}`}
          avatar={
            avatarCatalog?.entries.find(
              (entry) => entry.index === avatarType,
            ) || null
          }
          studio={mode === "studio"}
          online={online}
          busy={gestureSending}
          active={!!gestureActive.current || !!gestureUncleared.current}
          onPlay={playGesture}
          onStop={stopGesture}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "help" && (
        <Modal
          title="Take the scenic route."
          subtitle="A few familiar controls to get you started."
          onClose={() => setDialog(null)}
          wide
        >
          <div className="help-grid">
            <div>
              <h3>
                <Move3D size={17} />
                Find your feet
              </h3>
              <Shortcut keys="W A S D" text="Walk through the world" />
              <Shortcut
                keys="Mouse"
                text="Right-drag to look; double-click to lock"
              />
              <Shortcut keys="Shift" text="Move faster" />
              <Shortcut keys="Esc" text="Release your mouse" />
              <Shortcut keys="Enter" text="Focus world chat" />
            </div>
            <div>
              <h3>
                <Box size={17} />
                Make your mark
              </h3>
              <Shortcut keys="B" text="Toggle the building inspector" />
              <Shortcut keys="Click" text="Select objects or terrain in build mode" />
              <Shortcut keys="Terrain" text="Preview height or texture edits, then Apply" />
              <Shortcut keys="T" text="Travel to exact coordinates" />
              <Shortcut keys="/home" text="Return to the world entrance" />
              <Shortcut keys="F1" text="Bring this guide back" />
            </div>
          </div>
          <div className="help-note">
            <Globe size={22} />
            <p>
              Start in the offline studio, or connect to your own Axis universe.
              Models, textures and world data are loaded from that world’s
              servers. The studio uses original content and saves your edits
              on this device.
            </p>
          </div>
          <button className="primary-button" onClick={() => setDialog(null)}>
            Let’s explore <ArrowRight size={16} />
          </button>
        </Modal>
      )}
    </div>
  );
}

function Shortcut({ keys, text }: { keys: string; text: string }) {
  return (
    <div className="shortcut">
      <kbd>{keys}</kbd>
      <span>{text}</span>
    </div>
  );
}
export function TravelDialog({
  position,
  world,
  localTeleportAllowed: localAllowed,
  onTravel,
  onClose,
}: {
  position: Position;
  world: string;
  localTeleportAllowed: boolean;
  onTravel: (p: Position, world?: string) => void;
  onClose: () => void;
}) {
  const [initial] = useState(() => ({ ...position }));
  const initialHeading = String((initial.yaw * 180) / Math.PI);
  const [draft, setDraft] = useState(() => ({
    x: String(initial.x), y: String(initial.y), z: String(initial.z), heading: initialHeading,
  }));
  const [target, setTarget] = useState(world);
  const blocked = !localAllowed && (!target.trim() || sameWorld(target, world));
  // type=number sanitizes intermediate '-' / '-.' input before React sees it.
  // Keep text until submission; an empty field is not an implicit zero.
  const numericPattern = String.raw`[+\-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+\-]?[0-9]+)?`;
  const syntax = new RegExp(`^(?:${numericPattern})$`);
  const parse = (value: string) => syntax.test(value) ? Number(value) : NaN;
  const values = { x: parse(draft.x), y: parse(draft.y), z: parse(draft.z), heading: parse(draft.heading) };
  const valid = {
    x: Number.isFinite(values.x) && Math.abs(values.x) <= 21474836.47,
    y: Number.isFinite(values.y) && Math.abs(values.y) <= 21474836.47,
    z: Number.isFinite(values.z) && Math.abs(values.z) <= 21474836.47,
    heading: Number.isFinite(values.heading) && Math.abs(values.heading) <= 214748364.7,
  };
  let destination: Position | undefined;
  if (Object.values(valid).every(Boolean)) {
    const candidate = { ...initial, x: values.x, y: values.y, z: values.z,
      yaw: draft.heading === initialHeading ? initial.yaw : (values.heading * Math.PI) / 180 };
    try { assertCommand({ type: "move", position: candidate }); destination = candidate; } catch { /* Keep invalid drafts visible without dispatch. */ }
  }
  return (
    <Modal
      title="Somewhere in particular?"
      subtitle="Travel to a world and an exact position."
      onClose={onClose}
    >
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (blocked || !destination) return;
          onTravel(destination, target);
        }}
      >
        <label>
          World
          <input
            value={target}
            maxLength={64}
            onChange={(e) => setTarget(e.target.value)}
          />
        </label>
        <div className="field-label">
          Position <span>METRES · 10 METRES = 1 AW COORDINATE</span>
        </div>
        <div className="field-row">
          {(["x", "y", "z"] as const).map((key) => (
            <label className="grow" key={key}>
              {key === "x"
                ? "X · west / east"
                : key === "y"
                  ? "Y · altitude"
                  : "Z · north / south"}
              <input
                required
                type="text"
                inputMode="decimal"
                pattern={numericPattern}
                maxLength={64}
                aria-invalid={!valid[key]}
                aria-describedby={!destination ? "travel-validation" : undefined}
                value={draft[key]}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    [key]: e.target.value,
                  }))
                }
              />
            </label>
          ))}
        </div>
        <label>
          Heading (degrees)
          <input
            required
            type="text"
            inputMode="decimal"
            pattern={numericPattern}
            maxLength={64}
            aria-invalid={!valid.heading}
            aria-describedby={!destination ? "travel-validation" : undefined}
            value={draft.heading}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                heading: e.target.value,
              }))
            }
          />
        </label>
        <div className="coordinate-preview">
          <MapPin size={17} />
          {destination ? coordinates(destination) : "Complete the coordinates and heading to preview this destination."}
        </div>
        {!destination && <p id="travel-validation" role="alert">Enter complete numbers. Coordinates must be within ±21,474,836.47 metres; heading within ±214,748,364.7 degrees.</p>}
        {blocked && <p role="status">{LOCAL_TELEPORT_DENIED}</p>}
        <button className="primary-button full-width" disabled={blocked || !destination}>
          Take me there <Navigation size={16} />
        </button>
      </form>
    </Modal>
  );
}
function BookmarkDialog({
  limitReached = false,
  initialName,
  location,
  onSave,
  onClose,
}: {
  limitReached?: boolean;
  initialName: string;
  location: string;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  return (
    <Modal
      title="Worth coming back to."
      subtitle="Save this spot to your places."
      onClose={onClose}
    >
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !limitReached) onSave(name.trim());
        }}
      >
        <label>
          Place name
          <input
            required
            autoFocus
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="coordinate-preview">
          <MapPin size={17} />
          {location}
        </div>
        {limitReached && (
          <p className="inline-error" role="alert">
            You have 100 saved places. Remove an old bookmark before adding
            another.
          </p>
        )}
        <button className="primary-button full-width" disabled={limitReached}>
          <Bookmark size={16} />
          Save place
        </button>
      </form>
    </Modal>
  );
}
