package io.github.kylechen0419.chattranslate;

import com.anthropic.client.okhttp.AnthropicOkHttpClient;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import io.github.kylechen0419.chattranslate.core.BatchTranslator;
import io.github.kylechen0419.chattranslate.core.Config;
import io.github.kylechen0419.chattranslate.core.Lang;
import io.github.kylechen0419.chattranslate.core.OrderedQueue;
import io.github.kylechen0419.chattranslate.core.UiText;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.command.v2.FabricClientCommandSource;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.fabricmc.fabric.api.client.message.v1.ClientSendMessageEvents;
import net.fabricmc.fabric.api.resource.ResourceManagerHelper;
import net.fabricmc.fabric.api.resource.SimpleSynchronousResourceReloadListener;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.client.MinecraftClient;
import net.minecraft.resource.ResourceManager;
import net.minecraft.resource.ResourceType;
import net.minecraft.text.HoverEvent;
import net.minecraft.text.MutableText;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;
import net.minecraft.util.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

import static net.fabricmc.fabric.api.client.command.v2.ClientCommandManager.argument;
import static net.fabricmc.fabric.api.client.command.v2.ClientCommandManager.literal;

public class ChatTranslateClient implements ClientModInitializer {
    public static final Logger LOG = LoggerFactory.getLogger("chattranslate");
    /** Used by the text-render mixin. */
    public static final UiText UI = new UiText();
    private static final int CHAT_LIMIT = 256;

    private Config config;
    private BatchTranslator translator;
    private BatchTranslator outgoing;
    private long lastErrorShown;
    private final OrderedQueue<Text> queue = new OrderedQueue<>(text ->
            MinecraftClient.getInstance().execute(() -> MinecraftClient.getInstance().inGameHud.getChatHud().addMessage(text)));

    @Override
    public void onInitializeClient() {
        config = Config.load(FabricLoader.getInstance().getConfigDir().resolve("chattranslate.json"));
        rebuildTranslator();

        ClientReceiveMessageEvents.ALLOW_CHAT.register((message, signed, sender, params, time) -> {
            MinecraftClient mc = MinecraftClient.getInstance();
            boolean mine = sender != null && mc.player != null && sender.getId().equals(mc.player.getUuid());
            return onIncoming(message, !mine);
        });
        ClientReceiveMessageEvents.ALLOW_GAME.register((message, overlay) ->
                overlay || onIncoming(message, config.translateSystemMessages));
        ClientSendMessageEvents.ALLOW_CHAT.register(this::onOutgoing);
        ResourceManagerHelper.get(ResourceType.CLIENT_RESOURCES).registerReloadListener(new SimpleSynchronousResourceReloadListener() {
            @Override
            public Identifier getFabricId() {
                return Identifier.of("chattranslate", "font_check");
            }

            @Override
            public void reload(ResourceManager manager) {
                FontCheck.reset();
            }
        });
        ClientLifecycleEvents.CLIENT_STOPPING.register(mc -> {
            if (translator != null) translator.shutdown();
            if (outgoing != null) outgoing.shutdown();
        });
        ClientCommandRegistrationCallback.EVENT.register((dispatcher, registry) -> dispatcher.register(
                literal("ct")
                        .executes(this::status)
                        .then(literal("on").executes(c -> toggle(c, true)))
                        .then(literal("off").executes(c -> toggle(c, false)))
                        .then(literal("key").then(argument("key", StringArgumentType.greedyString()).executes(this::setKey)))
                        .then(literal("lang").then(argument("code", StringArgumentType.word()).executes(c -> setLang(c, false))))
                        .then(literal("out").then(argument("code", StringArgumentType.word()).executes(c -> setLang(c, true))))
                        .then(literal("mode")
                                .then(literal("replace").executes(c -> setMode(c, "replace")))
                                .then(literal("below").executes(c -> setMode(c, "below"))))
                        .then(literal("ui")
                                .then(literal("on").executes(c -> setUi(c, true)))
                                .then(literal("off").executes(c -> setUi(c, false))))
                        .then(literal("offline")
                                .then(literal("on").executes(c -> setOffline(c, true)))
                                .then(literal("off").executes(c -> setOffline(c, false))))
                        .then(literal("model")
                                .then(literal("fast").executes(c -> setModel(c, "claude-haiku-5-5")))
                                .then(literal("best").executes(c -> setModel(c, "claude-opus-5-5"))))
                        .then(literal("chat")
                                .then(literal("on").executes(c -> setChat(c, true)))
                                .then(literal("off").executes(c -> setChat(c, false))))
                        .then(literal("system")
                                .then(literal("on").executes(c -> setSystem(c, true)))
                                .then(literal("off").executes(c -> setSystem(c, false))))));
    }

    private void rebuildTranslator() {
        if (translator != null) translator.shutdown();
        if (outgoing != null) outgoing.shutdown();
        translator = outgoing = null;
        UI.use(null);
        String key = config.resolvedApiKey();
        // Without a key, or in offline mode, the bundled and saved dictionaries still work; nothing is sent.
        var client = key.isEmpty() || config.offline ? null : AnthropicOkHttpClient.builder().apiKey(key).build();
        var dir = FabricLoader.getInstance().getConfigDir().resolve("chattranslate");
        translator = new BatchTranslator(client, config.model, config.effort, config.targetLang,
                dir.resolve("cache-" + config.targetLang + ".json"), this::reportError);
        outgoing = new BatchTranslator(client, config.model, config.effort, config.outgoingLang,
                dir.resolve("cache-" + config.outgoingLang + ".json"), this::reportError);
        applyUi();
    }

    private void applyUi() {
        UI.use(config.enabled && config.translateUi ? translator : null);
    }

    /** Returns true to let Minecraft show the message as is, false when we show it ourselves. */
    private boolean onIncoming(Text message, boolean translatable) {
        if (!config.enabled || translator == null) return true;
        if (!config.translateChat) {
            // keep the interface hook off chat lines too, or they would still be translated (and paid for)
            message.visit(part -> {
                UI.exempt(part);
                return Optional.empty();
            });
            return true;
        }
        String plain = message.getString();
        boolean need = translatable && !plain.isBlank() && Lang.needsTranslation(plain, config.targetLang);

        if (config.mode.equals("below")) {
            if (need) translator.translate(plain).thenAccept(t -> {
                if (t != null && !t.equals(plain)) queue.add(CompletableFuture.completedFuture(
                        marker("  ↳ ").append(Text.literal(t).formatted(Formatting.GRAY))));
            });
            return true;
        }

        // Nothing waiting and nothing to translate: no need to hold this line back.
        if (!need && queue.isIdle()) return true;
        CompletableFuture<Text> shown = need
                ? translator.translate(plain)
                        .completeOnTimeout(null, config.timeoutSeconds, TimeUnit.SECONDS)
                        .thenApply(t -> t == null || t.equals(plain) ? message : translated(message, t))
                : CompletableFuture.completedFuture(message);
        queue.add(shown);
        return false;
    }

    private Text translated(Text original, String translation) {
        MutableText line = config.showMarker ? marker("[譯] ") : Text.empty();
        String raw = original.getString();
        UI.exempt(raw); // the hover is meant to show the original, not get translated again
        return line.append(Text.literal(translation).styled(s -> s.withHoverEvent(new HoverEvent(
                HoverEvent.Action.SHOW_TEXT, Text.literal("原文：").formatted(Formatting.GRAY).append(Text.literal(raw))))));
    }

    private static MutableText marker(String s) {
        return Text.literal(s).formatted(Formatting.DARK_GRAY);
    }

    private boolean onOutgoing(String message) {
        if (!config.enabled || outgoing == null || outgoing.offline() || !message.startsWith(config.outgoingPrefix)) return true;
        String body = message.substring(config.outgoingPrefix.length()).strip();
        if (body.isEmpty()) return false;
        feedback(marker("[譯] 翻譯中…").formatted(Formatting.ITALIC));
        outgoing.translate(body).thenAccept(t -> MinecraftClient.getInstance().execute(() -> {
            var handler = MinecraftClient.getInstance().getNetworkHandler();
            if (handler == null) return;
            if (t == null && Lang.needsTranslation(body, config.outgoingLang)) {
                feedback(Text.literal("[譯] 翻譯失敗，訊息沒有送出：" + body).formatted(Formatting.RED));
                return;
            }
            String out = t == null ? body : t; // null also means it was already in the outgoing language
            handler.sendChatMessage(out.length() > CHAT_LIMIT ? out.substring(0, CHAT_LIMIT) : out);
        }));
        return false;
    }

    private void reportError(String error) {
        LOG.warn("translation failed: {}", error);
        long now = System.currentTimeMillis();
        if (now - lastErrorShown < 30_000) return; // one warning per 30s, not one per message
        lastErrorShown = now;
        String hint = error.contains("Unauthorized") || error.contains("401")
                ? "API key 不對，用 /ct key <你的key> 重新設定" : error;
        MinecraftClient.getInstance().execute(() -> feedback(Text.literal("[譯] 翻譯失敗：" + hint).formatted(Formatting.RED)));
    }

    private static void feedback(Text text) {
        MinecraftClient.getInstance().inGameHud.getChatHud().addMessage(text);
    }

    private int status(CommandContext<FabricClientCommandSource> c) {
        String key = config.resolvedApiKey();
        c.getSource().sendFeedback(Text.literal(String.join("\n",
                "§6聊天翻譯 " + (config.enabled ? "§a開啟" : "§c關閉"),
                "§7API key：" + (key.isEmpty() ? "§c還沒設定（/ct key <key>）" : "§a已設定（…" + key.substring(Math.max(0, key.length() - 4)) + "）"),
                "§7別人的訊息翻成：§f" + config.targetLang + "  §7/ct lang <代碼>",
                "§7打 " + config.outgoingPrefix + " 開頭翻成：§f" + config.outgoingLang + "  §7/ct out <代碼>",
                "§7顯示方式：§f" + (config.mode.equals("below") ? "原文下面加翻譯" : "直接換成翻譯") + "  §7/ct mode replace|below",
                "§7翻譯模型：§f" + config.model + "  §7/ct model fast（快又便宜）| best（翻得最好）",
                "§7聊天室也翻：§f" + (config.translateChat ? "是" : "否") + "  §7/ct chat on|off",
                "§7伺服器訊息也翻：§f" + (config.translateSystemMessages ? "是" : "否") + "  §7/ct system on|off",
                "§7介面（任務、選單、物品）也翻：§f" + (config.translateUi ? "是" : "否") + "  §7/ct ui on|off",
                "§7離線模式（只用字典、不花錢）：§f" + (config.offline ? "開啟" : "關閉") + "  §7/ct offline on|off",
                "§7字典裡的翻譯：§f" + (translator == null ? 0 : translator.cacheSize()) + " 句"
                        + (translator != null && translator.offline() ? "  §7還沒翻到：§f" + translator.missingCount() + " 句" : ""),
                "§7可用語言：§f" + String.join(" ", Lang.NAMES.keySet()))));
        return 1;
    }

    private int toggle(CommandContext<FabricClientCommandSource> c, boolean on) {
        config.enabled = on;
        config.save();
        applyUi();
        c.getSource().sendFeedback(Text.literal(on ? "§a[譯] 翻譯已開啟" : "§c[譯] 翻譯已關閉"));
        return 1;
    }

    private int setKey(CommandContext<FabricClientCommandSource> c) {
        config.apiKey = StringArgumentType.getString(c, "key").strip();
        config.save();
        rebuildTranslator();
        c.getSource().sendFeedback(Text.literal("§a[譯] API key 已儲存，開始翻譯！"));
        return 1;
    }

    private int setLang(CommandContext<FabricClientCommandSource> c, boolean outgoing) {
        String code = Lang.normalize(StringArgumentType.getString(c, "code"));
        if (code == null) {
            c.getSource().sendError(Text.literal("[譯] 不認得這個語言。可用：" + String.join(" ", Lang.NAMES.keySet())));
            return 0;
        }
        if (outgoing) config.outgoingLang = code;
        else config.targetLang = code;
        config.save();
        rebuildTranslator();
        c.getSource().sendFeedback(Text.literal("§a[譯] " + (outgoing ? "你打的 " + config.outgoingPrefix + " 訊息會翻成 " : "別人的訊息會翻成 ") + code));
        return 1;
    }

    private int setMode(CommandContext<FabricClientCommandSource> c, String mode) {
        config.mode = mode;
        config.save();
        c.getSource().sendFeedback(Text.literal("§a[譯] " + (mode.equals("below") ? "原文下面加一行翻譯" : "直接換成翻譯（滑鼠移上去看原文）")));
        return 1;
    }

    private int setModel(CommandContext<FabricClientCommandSource> c, String model) {
        config.model = model;
        config.save();
        rebuildTranslator();
        c.getSource().sendFeedback(Text.literal("§a[譯] 改用 " + model
                + (model.contains("haiku") ? "：比較快、便宜很多，翻譯品質稍差" : "：翻得最好，但比較慢、比較貴")));
        return 1;
    }

    private int setOffline(CommandContext<FabricClientCommandSource> c, boolean on) {
        config.offline = on;
        config.save();
        rebuildTranslator();
        c.getSource().sendFeedback(Text.literal(on
                ? "§a[譯] 離線模式開啟：只用字典翻譯，不會再花錢。沒翻到的句子會記在 config/chattranslate/missing-zh-tw.json"
                : "§a[譯] 離線模式關閉：字典沒有的句子會線上翻譯"));
        return 1;
    }

    private int setChat(CommandContext<FabricClientCommandSource> c, boolean on) {
        config.translateChat = on;
        config.save();
        c.getSource().sendFeedback(Text.literal("§a[譯] 聊天室" + (on ? "會翻譯" : "不翻譯了（任務、選單、物品還是會翻）")));
        return 1;
    }

    private int setSystem(CommandContext<FabricClientCommandSource> c, boolean on) {
        config.translateSystemMessages = on;
        config.save();
        c.getSource().sendFeedback(Text.literal("§a[譯] 伺服器訊息" + (on ? "也會翻譯" : "不翻譯，只翻玩家聊天")));
        return 1;
    }

    private int setUi(CommandContext<FabricClientCommandSource> c, boolean on) {
        config.translateUi = on;
        config.save();
        applyUi();
        c.getSource().sendFeedback(Text.literal("§a[譯] 介面文字" + (on ? "也會翻譯（第一次出現約 1 秒後變中文）" : "不翻譯")));
        return 1;
    }
}
