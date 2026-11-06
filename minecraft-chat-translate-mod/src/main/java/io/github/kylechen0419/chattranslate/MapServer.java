package io.github.kylechen0419.chattranslate;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * A small web page on this computer only (127.0.0.1) that shows the map images JourneyMap saved
 * on disk, with your position read from the game every tick.
 */
public final class MapServer {
    private static final Pattern TILE = Pattern.compile("/tile/(day|night|topo|biome|-?\\d{1,3})/(-?\\d{1,7}),(-?\\d{1,7})\\.png");
    private static final Pattern LAYER = Pattern.compile("day|night|topo|biome|-?\\d{1,3}");

    private final Path journeymap;
    /** Your own markers (papers found, dead ends), kept between games. */
    private final Path markers;
    private HttpServer server;
    private int port;

    /** Latest position, written on the client thread each tick and read by the web server. */
    private volatile Snapshot pos;
    private Path cachedDir;
    private String cachedDim;
    private long cachedAt;

    private record Snapshot(double x, double y, double z, float yaw, String dim) {}

    public MapServer(Path gameDir, Path configDir) {
        this.journeymap = gameDir.resolve("journeymap").resolve("data");
        this.markers = configDir.resolve("chattranslate").resolve("map-markers.json");
    }

    public void tick(MinecraftClient mc) {
        ClientPlayerEntity p = mc.player;
        pos = p == null || mc.world == null ? null
                : new Snapshot(p.getX(), p.getY(), p.getZ(), p.getYaw(), mc.world.getRegistryKey().getValue().toString());
    }

    public synchronized boolean running() {
        return server != null;
    }

    /** Starts the page if needed and returns its address. */
    public synchronized String start() throws IOException {
        if (server == null) {
            IOException last = null;
            for (int p = 25599; p < 25609 && server == null; p++) {
                try {
                    server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), p), 0);
                    port = p;
                } catch (IOException e) {
                    last = e;
                }
            }
            if (server == null) throw last;
            server.createContext("/", this::handle);
            server.setExecutor(Executors.newSingleThreadExecutor(r -> {
                Thread t = new Thread(r, "chattranslate-map");
                t.setDaemon(true);
                return t;
            }));
            server.start();
        }
        return "http://127.0.0.1:" + port + "/";
    }

    public synchronized void stop() {
        if (server != null) server.stop(0);
        server = null;
    }

    private void handle(HttpExchange ex) throws IOException {
        try (ex) {
            // only answer pages opened on this computer by address, not other sites pointing a name at it
            String host = String.valueOf(ex.getRequestHeaders().getFirst("Host")).toLowerCase(Locale.ROOT);
            if (!host.startsWith("127.0.0.1:") && !host.startsWith("localhost:")) {
                send(ex, 403, "text/plain", "forbidden".getBytes(StandardCharsets.UTF_8));
                return;
            }
            String path = ex.getRequestURI().getPath();
            if (path.equals("/")) {
                try (InputStream in = MapServer.class.getResourceAsStream("/assets/chattranslate/map/index.html")) {
                    send(ex, 200, "text/html; charset=utf-8", in.readAllBytes());
                }
            } else if (path.equals("/pos")) {
                send(ex, 200, "application/json; charset=utf-8", posJson().getBytes(StandardCharsets.UTF_8));
            } else if (path.equals("/bundled")) {
                // paper spots other players reported, shipped with the mod
                try (InputStream in = MapServer.class.getResourceAsStream("/assets/chattranslate/map/markers.json")) {
                    send(ex, 200, "application/json; charset=utf-8", in == null ? "[]".getBytes(StandardCharsets.UTF_8) : in.readAllBytes());
                }
            } else if (path.equals("/markers") && ex.getRequestMethod().equals("POST")) {
                byte[] body = ex.getRequestBody().readNBytes(1_000_001);
                if (body.length > 1_000_000 || body.length == 0 || body[0] != '[') {
                    send(ex, 400, "text/plain", new byte[0]);
                    return;
                }
                Files.createDirectories(markers.getParent());
                Path tmp = markers.resolveSibling("map-markers.json.tmp");
                Files.write(tmp, body);
                Files.move(tmp, markers, java.nio.file.StandardCopyOption.REPLACE_EXISTING);
                send(ex, 200, "application/json", "{}".getBytes(StandardCharsets.UTF_8));
            } else if (path.equals("/markers")) {
                send(ex, 200, "application/json; charset=utf-8",
                        Files.isRegularFile(markers) ? Files.readAllBytes(markers) : "[]".getBytes(StandardCharsets.UTF_8));
            } else {
                Matcher m = TILE.matcher(path);
                Path dir = m.matches() ? dimDir() : null;
                Path file = dir == null ? null : dir.resolve(m.group(1)).resolve(m.group(2) + "," + m.group(3) + ".png");
                if (file != null && Files.isRegularFile(file)) send(ex, 200, "image/png", Files.readAllBytes(file));
                else send(ex, 404, "text/plain", new byte[0]);
            }
        } catch (RuntimeException e) {
            ChatTranslateClient.LOG.warn("map page request failed", e);
        }
    }

    private String posJson() {
        Snapshot s = pos;
        if (s == null) return "{\"ok\":false}";
        Path dir = dimDir();
        List<String> layers = new ArrayList<>();
        if (dir != null) try (Stream<Path> list = Files.list(dir)) {
            list.filter(Files::isDirectory).map(d -> d.getFileName().toString()).filter(n -> LAYER.matcher(n).matches()).forEach(layers::add);
        } catch (IOException ignored) {
        }
        return String.format(Locale.ROOT, "{\"ok\":true,\"x\":%.2f,\"y\":%.2f,\"z\":%.2f,\"yaw\":%.1f,\"dim\":\"%s\",\"found\":%b,\"layers\":[%s]}",
                s.x(), s.y(), s.z(), s.yaw(), s.dim().replace("\"", ""), dir != null,
                String.join(",", layers.stream().map(l -> "\"" + l + "\"").toList()));
    }

    /**
     * JourneyMap keeps one folder per server you played on, each with one folder per dimension
     * (for example "minecraft~backrooms"). Takes the most recently written one for the current dimension.
     */
    private synchronized Path dimDir() {
        Snapshot s = pos;
        if (s == null) return null;
        long now = System.currentTimeMillis();
        if (s.dim().equals(cachedDim) && now - cachedAt < 5000) return cachedDir;
        String id = s.dim(), shortName = id.substring(id.indexOf(':') + 1), tilde = id.replace(':', '~');
        Path best = null;
        long bestTime = Long.MIN_VALUE;
        for (String kind : new String[] {"mp", "sp"}) {
            Path root = journeymap.resolve(kind);
            if (!Files.isDirectory(root)) continue;
            try (Stream<Path> worlds = Files.list(root)) {
                for (Path w : worlds.filter(Files::isDirectory).toList()) {
                    for (String name : new String[] {tilde, shortName}) {
                        Path d = w.resolve(name);
                        if (!Files.isDirectory(d)) continue;
                        long t = freshness(d, s);
                        if (t > bestTime) {
                            bestTime = t;
                            best = d;
                        }
                    }
                }
            } catch (IOException ignored) {
            }
        }
        cachedDim = s.dim();
        cachedDir = best;
        cachedAt = now;
        return best;
    }

    /**
     * How recently this dimension folder saw you: the newest image covering where you stand now, or
     * failing that the newest layer folder (folder dates only change when files are added).
     */
    private static long freshness(Path dimDir, Snapshot s) throws IOException {
        String tile = Math.floorDiv((long) Math.floor(s.x()), 512) + "," + Math.floorDiv((long) Math.floor(s.z()), 512) + ".png";
        long here = Long.MIN_VALUE, any = Files.getLastModifiedTime(dimDir).toMillis();
        try (Stream<Path> layers = Files.list(dimDir)) {
            for (Path l : layers.filter(Files::isDirectory).toList()) {
                any = Math.max(any, Files.getLastModifiedTime(l).toMillis());
                Path f = l.resolve(tile);
                if (Files.isRegularFile(f)) here = Math.max(here, Files.getLastModifiedTime(f).toMillis());
            }
        }
        // a folder with a picture of this spot always beats one without
        return here != Long.MIN_VALUE ? Long.MAX_VALUE / 2 + here / 2 : any / 2;
    }

    private static void send(HttpExchange ex, int code, String type, byte[] body) throws IOException {
        ex.getResponseHeaders().set("Content-Type", type);
        ex.getResponseHeaders().set("Cache-Control", "no-store");
        ex.sendResponseHeaders(code, body.length == 0 ? -1 : body.length);
        if (body.length > 0) try (OutputStream out = ex.getResponseBody()) {
            out.write(body);
        }
    }
}
