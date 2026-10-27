package io.github.kylechen0419.chattranslate.core;

import com.anthropic.client.AnthropicClient;
import com.anthropic.core.JsonValue;
import com.anthropic.models.beta.messages.BetaJsonOutputFormat;
import com.anthropic.models.beta.messages.BetaMessage;
import com.anthropic.models.beta.messages.BetaOutputConfig;
import com.anthropic.models.beta.messages.BetaStopReason;
import com.anthropic.models.beta.messages.MessageCreateParams;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonParser;
import com.google.gson.reflect.TypeToken;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Semaphore;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * Translates strings into one target language. Strings are masked (numbers become {0}), collected
 * for a moment and sent to Claude in one request, and the results are kept on disk so the same
 * menu, quest or item text is only ever paid for once.
 *
 * {@link #cached} never blocks, so it can be called from the render thread on every frame.
 */
public final class BatchTranslator {
    static final String SYSTEM = """
            You translate text from a Minecraft RPG server (an SAO-style MMO: quests, classes, jobs, items,
            NPC dialogue, menus and player chat) for one player. You get a JSON list of separate strings;
            translate each one on its own and return them in the same order.
            Rules:
            - Keep placeholders like {0} and {1} exactly as written; they stand for numbers and formatting.
            - Keep player names, place names (e.g. Hanaka) and proper nouns as they are, unless the target
              language has a well-known name for them. Keep commands (/..., !...) and URLs unchanged.
            - Use the target language's standard Minecraft terms (Creeper = 苦力怕, Nether = 地獄,
              Enderman = 終界使者) and the usual MMO/RPG wording for stats and menus.
            - Menu labels and item names stay short; chat stays casual like game chat.
            - Some strings may be in French or another language; translate those too.
            - If a string is already in the target language or has nothing to translate, return it unchanged.""";

    private static final Pattern SLOT = Pattern.compile("\\{\\d+}");
    /** Interface strings per request; smaller batches come back sooner. */
    private static final int MAX_BATCH = 20;
    /** Chat lines per request: someone is waiting to read these. */
    private static final int MAX_URGENT_BATCH = 8;
    /** Requests in flight at once, so one slow reply doesn't hold up the rest. */
    private static final int PARALLEL = 4;
    private static final long RETRY_MS = 30_000;

    private final AnthropicClient client;
    private final String model;
    private final BetaOutputConfig.Effort effort;
    private final String targetLang;
    private final Path cacheFile;
    private final Consumer<String> errorLog;

    /** masked template -> translated template ("" = keep the original). */
    private final Map<String, String> done = new ConcurrentHashMap<>();
    /** raw string -> final string, so the render hot path skips masking. */
    private final Map<String, String> rawCache = new ConcurrentHashMap<>();
    private final Map<String, Long> cooldown = new ConcurrentHashMap<>();
    private final Map<String, List<CompletableFuture<String>>> waiting = new HashMap<>();
    private final LinkedBlockingQueue<String> queue = new LinkedBlockingQueue<>();
    /** Strings someone is waiting on (chat lines): sent before interface text, without the gather delay. */
    private final LinkedBlockingQueue<String> urgent = new LinkedBlockingQueue<>();
    private final Semaphore slots = new Semaphore(PARALLEL);
    private final ExecutorService calls = Executors.newFixedThreadPool(PARALLEL, r -> {
        Thread t = new Thread(r, "chattranslate-call");
        t.setDaemon(true);
        return t;
    });
    private final Thread worker;
    private volatile boolean running = true;
    private volatile boolean dirty;

    public BatchTranslator(AnthropicClient client, String model, String effort, String targetLang,
                           Path cacheFile, Consumer<String> errorLog) {
        this.client = client;
        this.model = model;
        this.effort = BetaOutputConfig.Effort.of(effort);
        this.targetLang = targetLang;
        this.cacheFile = cacheFile;
        this.errorLog = errorLog;
        load();
        worker = new Thread(this::run, "chattranslate-" + targetLang);
        worker.setDaemon(true);
        worker.start();
    }

    public String targetLang() {
        return targetLang;
    }

    /**
     * The translation if we already have it, else null (and the string is queued, so a later frame
     * gets it). Also null when the string needs no translation.
     */
    public String cached(String raw) {
        String hit = rawCache.get(raw);
        if (hit != null) return hit.isEmpty() ? null : hit;
        Masked m = Masked.of(raw);
        String t = done.get(m.template());
        if (t != null) {
            String out = t.isEmpty() ? null : m.unmask(t);
            if (rawCache.size() > 50_000) rawCache.clear();
            rawCache.put(raw, out == null ? "" : out);
            return out;
        }
        request(m.template(), null);
        return null;
    }

    /** Completes with the translation, or with null when nothing changed or the request failed. */
    public CompletableFuture<String> translate(String raw) {
        Masked m = Masked.of(raw);
        String t = done.get(m.template());
        if (t != null) return CompletableFuture.completedFuture(t.isEmpty() ? null : m.unmask(t));
        CompletableFuture<String> f = new CompletableFuture<>();
        request(m.template(), f);
        return f.thenApply(x -> x == null || x.isEmpty() ? null : m.unmask(x));
    }

    private void request(String template, CompletableFuture<String> future) {
        synchronized (waiting) {
            List<CompletableFuture<String>> list = waiting.get(template);
            if (list == null) {
                Long until = cooldown.get(template);
                if (future == null && until != null && until > System.currentTimeMillis()) return;
                list = new ArrayList<>();
                waiting.put(template, list);
                (future != null ? urgent : queue).add(template);
            }
            if (future != null) list.add(future);
        }
    }

    private void run() {
        while (running) {
            try {
                slots.acquire();
                List<String> batch = nextBatch();
                if (batch == null) {
                    slots.release();
                    if (dirty) save();
                    continue;
                }
                calls.submit(() -> {
                    try {
                        Map<String, String> results = new HashMap<>();
                        try {
                            results = call(batch);
                        } catch (RuntimeException e) {
                            errorLog.accept(e.getClass().getSimpleName() + ": " + e.getMessage());
                        }
                        for (String template : batch) finish(template, results.get(template));
                    } finally {
                        slots.release();
                    }
                });
            } catch (InterruptedException e) {
                return;
            }
        }
    }

    /** The next batch to send, chat first; null after a second with nothing to do. */
    private List<String> nextBatch() throws InterruptedException {
        for (int waited = 0; waited < 1000; waited += 50) {
            String first = urgent.poll();
            if (first != null) {
                List<String> batch = new ArrayList<>(List.of(first));
                urgent.drainTo(batch, MAX_URGENT_BATCH - 1);
                return batch;
            }
            first = queue.poll(50, TimeUnit.MILLISECONDS);
            if (first != null) {
                Thread.sleep(150); // let the rest of this screen's strings arrive
                List<String> batch = new ArrayList<>(List.of(first));
                queue.drainTo(batch, MAX_BATCH - 1);
                return batch;
            }
        }
        return null;
    }

    private void finish(String template, String translated) {
        if (translated != null) {
            done.put(template, translated.equals(template) ? "" : translated);
            dirty = true;
        } else {
            cooldown.put(template, System.currentTimeMillis() + RETRY_MS);
        }
        List<CompletableFuture<String>> futures;
        synchronized (waiting) {
            futures = waiting.remove(template);
        }
        if (futures != null) for (var f : futures) f.complete(translated == null ? null : done.get(template));
    }

    private Map<String, String> call(List<String> batch) {
        Gson gson = new Gson();
        Map<String, Object> schema = Map.of(
                "type", "object",
                "properties", Map.of("translations", Map.of("type", "array", "items", Map.of("type", "string"))),
                "required", List.of("translations"),
                "additionalProperties", false);
        BetaJsonOutputFormat.Schema.Builder sb = BetaJsonOutputFormat.Schema.builder();
        schema.forEach((k, v) -> sb.putAdditionalProperty(k, JsonValue.from(v)));

        MessageCreateParams params = MessageCreateParams.builder()
                .model(model)
                .maxTokens(16000L)
                .system(SYSTEM)
                .outputConfig(BetaOutputConfig.builder()
                        .effort(effort)
                        .format(BetaJsonOutputFormat.builder().schema(sb.build()).build())
                        .build())
                .addBeta("server-side-fallback-2026-07-01")
                .fallbacksDefault()
                .addUserMessage("Target language: " + Lang.NAMES.getOrDefault(targetLang, targetLang)
                        + "\nReturn exactly " + batch.size() + " translations.\n\n" + gson.toJson(batch))
                .build();
        BetaMessage response = client.beta().messages().create(params);
        Map<String, String> out = new HashMap<>();
        if (response.stopReason().map(BetaStopReason.REFUSAL::equals).orElse(false)) {
            batch.forEach(t -> out.put(t, t)); // declined: show these as they are, don't retry forever
            return out;
        }
        StringBuilder text = new StringBuilder();
        response.content().forEach(b -> b.text().ifPresent(t -> text.append(t.text())));
        JsonArray arr = JsonParser.parseString(text.toString()).getAsJsonObject().getAsJsonArray("translations");
        if (arr == null || arr.size() != batch.size()) {
            throw new IllegalStateException("expected " + batch.size() + " translations, got " + (arr == null ? 0 : arr.size()));
        }
        for (int i = 0; i < batch.size(); i++) {
            String src = batch.get(i);
            String t = arr.get(i).getAsString().strip();
            // a translation that dropped or invented a {n} slot can't be filled back in: keep the original
            if (!slots(src).equals(slots(t))) t = src;
            out.put(src, t);
        }
        return out;
    }

    private static List<String> slots(String s) {
        List<String> out = new ArrayList<>();
        var m = SLOT.matcher(s);
        while (m.find()) out.add(m.group());
        out.sort(null);
        return out;
    }

    private void load() {
        if (cacheFile == null || !Files.exists(cacheFile)) return;
        try {
            Map<String, String> m = new Gson().fromJson(Files.readString(cacheFile, StandardCharsets.UTF_8),
                    new TypeToken<Map<String, String>>() {}.getType());
            if (m != null) done.putAll(m);
        } catch (IOException | RuntimeException e) {
            errorLog.accept("cache unreadable, starting fresh: " + e.getMessage());
        }
    }

    public synchronized void save() {
        dirty = false;
        if (cacheFile == null) return;
        try {
            Files.createDirectories(cacheFile.getParent());
            Path tmp = cacheFile.resolveSibling(cacheFile.getFileName() + ".tmp");
            Files.writeString(tmp, new Gson().toJson(new HashMap<>(done)), StandardCharsets.UTF_8);
            Files.move(tmp, cacheFile, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException e) {
            errorLog.accept("could not save cache: " + e.getMessage());
        }
    }

    public int cacheSize() {
        return done.size();
    }

    public void shutdown() {
        running = false;
        worker.interrupt();
        calls.shutdownNow();
        save();
    }
}
