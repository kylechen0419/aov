package io.github.kylechen0419.chattranslate.core;

import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Language codes the mod understands, and a cheap check for "is this already in my language?". */
public final class Lang {
    public static final Map<String, String> NAMES = new LinkedHashMap<>();
    private static final Map<String, String> ALIASES = Map.ofEntries(
            Map.entry("zh", "zh-tw"), Map.entry("tw", "zh-tw"), Map.entry("中文", "zh-tw"), Map.entry("繁中", "zh-tw"),
            Map.entry("cn", "zh-cn"), Map.entry("简中", "zh-cn"), Map.entry("jp", "ja"), Map.entry("kr", "ko"));

    static {
        NAMES.put("zh-tw", "Traditional Chinese as used in Taiwan (繁體中文)");
        NAMES.put("zh-cn", "Simplified Chinese (简体中文)");
        NAMES.put("en", "English");
        NAMES.put("ja", "Japanese");
        NAMES.put("ko", "Korean");
        NAMES.put("es", "Spanish");
        NAMES.put("pt", "Portuguese");
        NAMES.put("fr", "French");
        NAMES.put("de", "German");
        NAMES.put("ru", "Russian");
        NAMES.put("th", "Thai");
        NAMES.put("vi", "Vietnamese");
        NAMES.put("id", "Indonesian");
    }

    private Lang() {}

    /** Returns the canonical code, or null when unknown. */
    public static String normalize(String code) {
        if (code == null) return null;
        String c = code.trim().toLowerCase(Locale.ROOT).replace('_', '-');
        c = ALIASES.getOrDefault(c, c);
        return NAMES.containsKey(c) ? c : null;
    }

    private static Set<Character.UnicodeScript> scriptsOf(String lang) {
        return switch (lang) {
            case "zh-tw", "zh-cn" -> EnumSet.of(Character.UnicodeScript.HAN);
            case "ja" -> EnumSet.of(Character.UnicodeScript.HAN, Character.UnicodeScript.HIRAGANA, Character.UnicodeScript.KATAKANA);
            case "ko" -> EnumSet.of(Character.UnicodeScript.HANGUL);
            case "ru" -> EnumSet.of(Character.UnicodeScript.CYRILLIC);
            case "th" -> EnumSet.of(Character.UnicodeScript.THAI);
            default -> EnumSet.of(Character.UnicodeScript.LATIN);
        };
    }

    /**
     * False when the text has no letters outside the target language's script, e.g. a Chinese line
     * for a zh-tw reader, or a line that is only numbers, symbols and emoji. Latin-script targets can't
     * tell English from Spanish this way, so for them any Latin text goes to the model, which returns
     * it unchanged when it is already in the target language.
     */
    public static boolean needsTranslation(String text, String target) {
        Set<Character.UnicodeScript> own = scriptsOf(target);
        boolean latinTarget = own.contains(Character.UnicodeScript.LATIN);
        for (int i = 0; i < text.length(); ) {
            int cp = text.codePointAt(i);
            i += Character.charCount(cp);
            if (!Character.isLetter(cp)) continue;
            Character.UnicodeScript s = Character.UnicodeScript.of(cp);
            if (latinTarget || !own.contains(s)) return true;
        }
        return false;
    }

    private static final java.util.regex.Pattern USERNAME = java.util.regex.Pattern.compile("[A-Za-z0-9_]{3,16}");

    /**
     * Stricter check for interface text (menus, tooltips, HUD), which is drawn every frame: skip
     * fragments that already contain the target script (already localized), player-name-like words,
     * and anything with fewer than two letters.
     */
    public static boolean uiCandidate(String text, String target) {
        if (text.length() < 2 || text.length() > 2000) return false;
        Set<Character.UnicodeScript> own = scriptsOf(target);
        boolean latinTarget = own.contains(Character.UnicodeScript.LATIN);
        int letters = 0;
        for (int i = 0; i < text.length(); ) {
            int cp = text.codePointAt(i);
            i += Character.charCount(cp);
            if (!Character.isLetter(cp)) continue;
            letters++;
            if (!latinTarget && own.contains(Character.UnicodeScript.of(cp))) return false;
        }
        if (letters < 2) return false;
        String trimmed = text.strip();
        boolean nameLike = USERNAME.matcher(trimmed).matches()
                && trimmed.chars().anyMatch(c -> c == '_' || Character.isDigit(c));
        return !nameLike && needsTranslation(text, target);
    }
}
