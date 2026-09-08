using System.Reflection;
using System.Text.Json;
using Axis.Platform.Shared.Cipher;
using Axis.Platform.Shared.Common;
using Axis.WorldServer.Configuration;
using Axis.WorldServer.Database;
using Axis.WorldServer.Models;

if (args is ["--key"]) {
    Console.WriteLine(Convert.ToBase64String(new RSAPrivateKey(512).ToByteArray()));
    return;
}

if (args.Length < 2) throw new ArgumentException("Usage: AxisFixture DATA_DIRECTORY OBJECT_PATH [OBJECT_MANIFEST]");
var dataPath = Path.GetFullPath(args[0]);
var uid = Guid.Parse("180f65f0-2e70-4b69-9a42-497815a2d8a0");
var worldPath = Path.Combine(dataPath, uid.ToString("N"));
Directory.CreateDirectory(worldPath);

using (var containers = new ContainerDbContext(Path.Combine(dataPath, "world.dat"))) {
    containers.EnsureCreated("ContainerDbSchema.yml");
    if (containers.FindWorld("Haven") == null) {
        containers.AddWorld(new WorldInfo {
            Uid = uid, Name = "Haven", Password = "HavenLocal42!", Enabled = true,
            Created = DateTimeOffset.UtcNow, Caretakers = "2,3"
        });
    }
}

var attributes = new WorldAttributes(worldPath) {
    Title = "Haven · a place to begin", WelcomeMessage = "Welcome to Haven. Build something worth coming back to.",
    ObjectPath = args[1], EntryPoint = "2.9S 0W 0a 0", EnableTerrain = true,
    EnterRight = "*", BuildRight = "*", SpeakRight = "*", BotsRight = "*", TerrainRight = "2,3",
    EnableCav = 0, EnablePav = false, TerrainOffset = 0, Ground = "", FogEnable = true,
    FogMinimum = 120, FogMaximum = 350, FogRed = 196, FogGreen = 217, FogBlue = 227,
    SkyTopRed = 108, SkyTopGreen = 164, SkyTopBlue = 199,
    SkyBottomRed = 215, SkyBottomGreen = 231, SkyBottomBlue = 235,
};
// Upstream has no public offline save method. Invoke its existing serializer rather
// than editing upstream code or duplicating its binary attribute format.
typeof(WorldAttributes).GetMethod("SaveToFile", BindingFlags.NonPublic | BindingFlags.Instance)!.Invoke(attributes, null);

using (var terrain = new TerrainDbContext(Path.Combine(worldPath, "terrain.dat"))) {
    terrain.EnsureCreated("TerrainDbSchema.yml");
    // One real, flat 128 x 128 terrain page, centered on Haven's entry point.
    for (var z = -64; z < 64; z++) terrain.SetTerrainRow(0, -64, z, 128, 0, new int[128]);
}

using (var cells = new CellDbContext(Path.Combine(worldPath, "cell.dat"))) {
    cells.EnsureCreated("CellDbSchema.yml");
    if (cells.GetCount(0) == 0 && args.Length > 2 && File.Exists(args[2])) {
        using var manifest = JsonDocument.Parse(File.ReadAllText(args[2]));
        var objects = manifest.RootElement.ValueKind == JsonValueKind.Array ? manifest.RootElement : manifest.RootElement.GetProperty("objects");
        foreach (var item in objects.EnumerateArray()) {
            int Value(string key) => item.TryGetProperty(key, out var value) ? value.GetInt32() : 0;
            string Text(string key) => item.TryGetProperty(key, out var value) ? value.GetString() ?? "" : "";
            cells.InsertObject(0, new CellObject {
                Model = Text("model"), Description = Text("description"), Action = Text("action"),
                Citizen = 2, Timestamp = DateTimeOffset.UtcNow,
                CellX = Utility.CellFromCm(Value("x")), CellZ = Utility.CellFromCm(Value("z")),
                X = Value("x"), Y = Value("y"), Z = Value("z"), Yaw = Value("yaw"), Tilt = Value("tilt"), Roll = Value("roll")
            });
        }
    }
    Console.WriteLine($"Haven fixture seeded: {cells.GetCount(0)} objects, 1 terrain page, citizen 2/3 caretakers.");
}
