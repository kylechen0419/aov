package io.github.kylechen0419.chattranslate.core;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A string with its numbers, § formatting codes and icon glyphs replaced by {0}, {1}, ... so that
 * "Go to Hanaka | 350m" and "Go to Hanaka | 349m" share one cached translation.
 */
public record Masked(String template, List<String> values) {
    // numbers (incl. "3 773", "1,250", "0.5"), legacy § codes, private-use icon glyphs
    private static final Pattern MASK = Pattern.compile(
            "\\d+(?:[.,\\u00A0\\u202F ]\\d+)*|§[0-9a-fk-orA-FK-OR]|[\\uE000-\\uF8FF]+");
    private static final Pattern SLOT = Pattern.compile("\\{(\\d+)}");

    public static Masked of(String raw) {
        Matcher m = MASK.matcher(raw);
        StringBuilder sb = new StringBuilder();
        List<String> values = new ArrayList<>();
        int last = 0;
        while (m.find()) {
            sb.append(raw, last, m.start()).append('{').append(values.size()).append('}');
            values.add(m.group());
            last = m.end();
        }
        sb.append(raw, last, raw.length());
        return new Masked(sb.toString(), values);
    }

    /** Puts the values back into a translated template; null if the translation lost or invented a slot. */
    public String unmask(String translatedTemplate) {
        Matcher m = SLOT.matcher(translatedTemplate);
        StringBuilder sb = new StringBuilder();
        boolean[] used = new boolean[values.size()];
        while (m.find()) {
            int i = Integer.parseInt(m.group(1));
            if (i >= values.size()) return null;
            used[i] = true;
            m.appendReplacement(sb, Matcher.quoteReplacement(values.get(i)));
        }
        m.appendTail(sb);
        for (boolean u : used) if (!u) return null;
        return sb.toString();
    }
}
