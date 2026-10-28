package io.github.kylechen0419.chattranslate.core;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static org.junit.jupiter.api.Assertions.*;

class CoreTest {
    @Test
    void needsTranslation() {
        assertTrue(Lang.needsTranslation("<Steve> watch out, creeper!", "zh-tw"));
        assertTrue(Lang.needsTranslation("[公會] Alex: こんにちは", "zh-tw"));
        assertTrue(Lang.needsTranslation("안녕하세요", "zh-tw"));
        assertFalse(Lang.needsTranslation("<小明> 小心苦力怕！", "zh-tw"));
        assertFalse(Lang.needsTranslation("12345 !!! ❤️ :)", "zh-tw"));
        assertFalse(Lang.needsTranslation("", "zh-tw"));
        assertTrue(Lang.needsTranslation("你好", "en"));
        assertTrue(Lang.needsTranslation("hola", "en")); // Latin targets always ask the model
        assertFalse(Lang.needsTranslation("ありがとう 漢字", "ja"));
    }

    @Test
    void normalize() {
        assertEquals("zh-tw", Lang.normalize("ZH_TW"));
        assertEquals("zh-tw", Lang.normalize("中文"));
        assertEquals("ja", Lang.normalize("jp"));
        assertNull(Lang.normalize("klingon"));
    }

    @Test
    void orderedQueueKeepsOrder() {
        List<String> out = new ArrayList<>();
        OrderedQueue<String> q = new OrderedQueue<>(out::add);
        CompletableFuture<String> slow = new CompletableFuture<>();
        CompletableFuture<String> fast = new CompletableFuture<>();
        q.add(slow);
        q.add(fast);
        q.add(CompletableFuture.completedFuture("third"));
        fast.complete("second");
        assertEquals(List.of(), out);
        assertFalse(q.isIdle());
        slow.complete("first");
        assertEquals(List.of("first", "second", "third"), out);
        assertTrue(q.isIdle());
    }

    @Test
    void configRoundTrip() throws Exception {
        Path p = Files.createTempDirectory("ct").resolve("config/chattranslate.json");
        Config c = Config.load(p);
        assertEquals("zh-tw", c.targetLang);
        assertTrue(Files.exists(p));
        c.apiKey = "sk-ant-test";
        c.mode = "below";
        c.save();
        Config again = Config.load(p);
        assertEquals("sk-ant-test", again.resolvedApiKey());
        assertEquals("below", again.mode);
        Files.writeString(p, "{ not json");
        assertEquals("replace", Config.load(p).mode);
    }

    /** Fake model: "translates" each line by prefixing 譯: (placeholders kept), and records batch sizes. */
    static String fakeModel(String body, List<Integer> sizes) {
        JsonObject req = JsonParser.parseString(body).getAsJsonObject();
        var content = req.getAsJsonArray("messages").get(0).getAsJsonObject().get("content");
        String user = content.isJsonArray()
                ? content.getAsJsonArray().get(0).getAsJsonObject().get("text").getAsString()
                : content.getAsString();
        JsonArray lines = JsonParser.parseString(user.substring(user.indexOf("\n\n") + 2)).getAsJsonArray();
        sizes.add(lines.size());
        JsonArray out = new JsonArray();
        for (var l : lines) {
            String s = l.getAsString();
            out.add(s.equals("already fine") ? s : s.equals("drop slot {0}") ? "掉了" : "譯:" + s);
        }
        JsonObject o = new JsonObject();
        o.add("translations", out);
        return o.toString();
    }

    @Test
    void masking() {
        Masked m = Masked.of("Go to Hanaka | 350m, Cols: 3 773 §aOK");
        assertEquals("Go to Hanaka | {0}m, Cols: {1} {2}OK", m.template());
        assertEquals("前往 Hanaka｜350m，Cols：3 773 §aOK", m.unmask("前往 Hanaka｜{0}m，Cols：{1} {2}OK"));
        assertNull(m.unmask("前往 Hanaka"), "lost slots must be rejected");
        assertNull(m.unmask("{0}{1}{2}{3}"), "invented slots must be rejected");
        assertEquals(Masked.of("349m left").template(), Masked.of("12m left").template());
    }

    @Test
    void uiCandidate() {
        assertTrue(Lang.uiCandidate("Go to the marshes north of Hanaka", "zh-tw"));
        assertTrue(Lang.uiCandidate("Se rendre aux marécages au nord d'Hanaka | 350m", "zh-tw"));
        assertTrue(Lang.uiCandidate("Backpack", "zh-tw"));
        assertFalse(Lang.uiCandidate("Immortal_0419", "zh-tw"));
        assertFalse(Lang.uiCandidate("TheUnluckyLord", "zh-tw"));
        assertTrue(Lang.uiCandidate("Character registration", "zh-tw"));
        assertFalse(Lang.uiCandidate("31 / 31", "zh-tw"));
        assertFalse(Lang.uiCandidate("本群第一位黃金輔助 VIP", "zh-tw"));
        assertFalse(Lang.uiCandidate("x", "zh-tw"));
    }

    @Test
    void batchesMasksAndPersists() throws Exception {
        List<Integer> sizes = new java.util.concurrent.CopyOnWriteArrayList<>();
        Path cache = Files.createTempDirectory("ct").resolve("cache-zh-tw.json");
        try (FakeApi api = new FakeApi(body -> fakeModel(body, sizes), "end_turn")) {
            List<String> errors = new ArrayList<>();
            BatchTranslator tr = new BatchTranslator(api.client(), "claude-opus-5-5", "low", "zh-tw", cache, errors::add);
            UiText ui = new UiText();
            ui.use(tr);
            // a screen's worth of strings, asked for on the render thread: nothing blocks, one batch;
            // chat lines go in their own batch, after interface text
            // a screen's worth of strings, looked up once on the render thread: nothing blocks, and after
            // a moment they go out in one batch, minus the steps of text that was still typing itself out
            for (String t : List.of("Grue pouch", "Zorp log", "Go to Zanaka | 350m", "Immortal_0419", "sao:latency",
                    "Zo and l", "Zo and lo", "Zo and look"))
                assertNull(ui.lookup(t));
            var chat = tr.translate("already fine");
            var bad = tr.translate("drop slot 5");
            assertNull(chat.get(10, TimeUnit.SECONDS), "unchanged lines come back as null");
            assertNull(bad.get(10, TimeUnit.SECONDS), "a translation that lost its number is discarded");
            for (int i = 0; i < 100 && ui.lookup("Grue pouch") == null; i++) Thread.sleep(50);
            assertEquals(List.of(2, 4), sizes.stream().sorted().toList());
            assertEquals("譯:Zo and look", ui.lookup("Zo and look"));
            assertNull(ui.lookup("Zo and lo"), "typing and word-wrap steps are never sent");
            assertEquals("譯:Grue pouch", ui.lookup("Grue pouch"));
            assertEquals("譯:Go to Zanaka | 349m", ui.lookup("Go to Zanaka | 349m"), "new number, same template: no new call");
            assertEquals("譯:Zorp log", tr.translate("Zorp log").get(1, TimeUnit.SECONDS));
            assertEquals(2, api.bodies.size());
            String body = api.bodies.get(0);
            assertTrue(body.contains("\"fallbacks\":\"default\""), body);
            assertTrue(body.contains("\"json_schema\""), body);
            assertTrue(body.contains("\"effort\":\"low\""), body);
            assertFalse(body.contains("\"thinking\""), body);
            assertTrue(api.betaHeaders.get(0).contains("server-side-fallback-2026-07-01"));
            assertEquals(List.of(), errors);
            tr.shutdown();
        }
        // a new session reads the disk cache: no API needed at all
        try (FakeApi down = new FakeApi(body -> { throw new AssertionError("should not call"); }, "end_turn")) {
            BatchTranslator tr = new BatchTranslator(down.client(), "claude-opus-5-5", "low", "zh-tw", cache, e -> {});
            assertEquals("譯:Grue pouch", tr.cached("Grue pouch"));
            assertEquals("譯:Go to Zanaka | 1m", tr.cached("Go to Zanaka | 1m"));
            assertNull(tr.cached("already fine"));
            tr.shutdown();
        }
    }

    @Test
    void refusalAndErrorsGiveNull() throws Exception {
        try (FakeApi api = new FakeApi(body -> "", "refusal")) {
            BatchTranslator tr = new BatchTranslator(api.client(), "claude-opus-5-5", "low", "zh-tw", null, e -> {});
            assertNull(tr.translate("x y").get(10, TimeUnit.SECONDS));
            tr.shutdown();
        }
        List<String> errors = new java.util.concurrent.CopyOnWriteArrayList<>();
        FakeApi dead = new FakeApi(b -> "", "end_turn");
        var client = dead.client();
        dead.close();
        BatchTranslator tr = new BatchTranslator(client, "claude-opus-5-5", "low", "zh-tw", null, errors::add);
        assertNull(tr.translate("hello").get(30, TimeUnit.SECONDS));
        assertEquals(1, errors.size());
        assertNull(tr.cached("hello"), "failed strings wait for the cooldown instead of hammering the API");
        tr.shutdown();
    }

    @Test
    void offlineUsesOnlyDictionariesAndRecordsMisses() throws Exception {
        Path cache = Files.createTempDirectory("ct").resolve("cache-zh-tw.json");
        Files.writeString(cache, "{\"Backpack\":\"背包\"}");
        BatchTranslator tr = new BatchTranslator(null, "claude-opus-5-5", "low", "zh-tw", cache, e -> {});
        assertTrue(tr.offline());
        assertEquals("背包", tr.cached("Backpack"));
        assertNull(tr.translate("Never seen").get(1, TimeUnit.SECONDS));
        assertNull(tr.cached("Quest log"));
        for (int i = 0; i < 40 && tr.missingCount() == 0; i++) Thread.sleep(50);
        assertEquals(1, tr.missingCount());
        tr.shutdown();
        String missing = Files.readString(cache.resolveSibling("missing-zh-tw.json"));
        assertTrue(missing.contains("Quest log"), missing);
        assertFalse(missing.contains("Never seen"), "chat lines are not dictionary material");
    }

    @Test
    void bundledDictionaryWorksWithoutKeyOrCache() throws Exception {
        BatchTranslator tr = new BatchTranslator(null, "claude-opus-5-5", "low", "zh-tw", null, e -> {
            throw new AssertionError(e);
        });
        assertEquals("購買", tr.cached("Buy"));
        assertEquals("15 珂爾", tr.cached("15 Cols"));
        assertTrue(tr.cacheSize() > 3000);
        tr.shutdown();
    }
}
