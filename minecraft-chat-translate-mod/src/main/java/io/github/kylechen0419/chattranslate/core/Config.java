package io.github.kylechen0419.chattranslate.core;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/** Settings saved in .minecraft/config/chattranslate.json. */
public final class Config {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create();

    public String apiKey = "";
    public boolean enabled = true;
    /** Language incoming chat is translated into. */
    public String targetLang = "zh-tw";
    /** Language your own messages are translated into when they start with outgoingPrefix. */
    public String outgoingLang = "en";
    public String outgoingPrefix = ">>";
    /** "replace": show only the translation (hover for the original). "below": original, then translation. */
    public String mode = "replace";
    /** Translate anything in the chat box (player chat and server messages). */
    public boolean translateChat = true;
    /** Also translate server/plugin messages, not just player chat. */
    public boolean translateSystemMessages = true;
    /** Translate interface text too: menus, item names and lore, quest tracker, titles, boss bars. */
    public boolean translateUi = true;
    public boolean showMarker = true;
    public String model = "claude-opus-5-5";
    public String effort = "low";
    public int timeoutSeconds = 8;

    private transient Path path;

    public static Config load(Path path) {
        Config c = null;
        if (Files.exists(path)) {
            try {
                c = GSON.fromJson(Files.readString(path, StandardCharsets.UTF_8), Config.class);
            } catch (IOException | RuntimeException ignored) {
                // a broken file falls back to defaults and gets rewritten below
            }
        }
        if (c == null) c = new Config();
        c.path = path;
        c.save();
        return c;
    }

    public void save() {
        if (path == null) return;
        try {
            Files.createDirectories(path.getParent());
            Files.writeString(path, GSON.toJson(this), StandardCharsets.UTF_8);
        } catch (IOException ignored) {
        }
    }

    /** The key from the config, or ANTHROPIC_API_KEY from the environment. */
    public String resolvedApiKey() {
        if (apiKey != null && !apiKey.isBlank()) return apiKey.trim();
        String env = System.getenv("ANTHROPIC_API_KEY");
        return env == null ? "" : env.trim();
    }
}
