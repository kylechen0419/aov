package io.github.kylechen0419.chattranslate;

import io.github.kylechen0419.chattranslate.mixin.TextRendererAccessor;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.font.FontStorage;
import net.minecraft.client.font.Glyph;
import net.minecraft.text.Style;
import net.minecraft.util.Identifier;

import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Translated text keeps its original style when its font can draw it: the SAO menu fonts draw
 * Chinese, and swapping them for the default font turned dark text white. Fonts without CJK glyphs
 * (which would show □□□) fall back to the default font.
 */
public final class FontCheck {
    private static final Map<Identifier, Boolean> CJK = new ConcurrentHashMap<>();

    private FontCheck() {}

    public static Style styleFor(Style style, String translated) {
        Identifier font = style.getFont();
        if (Style.DEFAULT_FONT_ID.equals(font) || drawsCjk(font, translated)) return style;
        return style.withFont(Style.DEFAULT_FONT_ID);
    }

    private static boolean drawsCjk(Identifier font, String sample) {
        if (MinecraftClient.getInstance().textRenderer == null) return true; // fonts not loaded yet: decide later
        return CJK.computeIfAbsent(font, id -> {
            try {
                var tr = MinecraftClient.getInstance().textRenderer;
                FontStorage storage = ((TextRendererAccessor) tr).chattranslate$fonts().apply(id);
                Glyph missing = storage.getGlyph(0x10FFFD, false); // a private-use code point no font has
                for (int cp : new int[]{'的', '中', '一', firstCjk(sample)}) {
                    if (cp > 0 && storage.getGlyph(cp, false) == missing) return false;
                }
                return true;
            } catch (RuntimeException e) {
                return false;
            }
        });
    }

    public static boolean hasHan(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c >= 0x3400 && c <= 0x9FFF) return true;
        }
        return false;
    }

    private static int firstCjk(String s) {
        return s.codePoints().filter(cp -> Character.UnicodeScript.of(cp) == Character.UnicodeScript.HAN).findFirst().orElse(-1);
    }

    /** Fonts change with resource packs (and are only complete after the first load); forget what we learned. */
    public static void reset() {
        CJK.clear();
    }
}
