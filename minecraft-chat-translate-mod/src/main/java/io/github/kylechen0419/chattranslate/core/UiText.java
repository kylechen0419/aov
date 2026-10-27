package io.github.kylechen0419.chattranslate.core;

import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Render-thread entry point for interface text. Called for every literal text fragment drawn on
 * screen, every frame, so the "not worth translating" verdict is remembered per string.
 */
public final class UiText {
    private static final int MAX_REMEMBERED = 50_000;

    private final Map<String, Boolean> candidate = new ConcurrentHashMap<>();
    private final Set<String> exempt = ConcurrentHashMap.newKeySet();
    private volatile BatchTranslator translator;

    public void use(BatchTranslator translator) {
        this.translator = translator;
        candidate.clear();
    }

    /** Never translate this exact string (e.g. the "original" shown when hovering a translation). */
    public void exempt(String raw) {
        if (exempt.size() > 5_000) exempt.clear();
        exempt.add(raw);
    }

    /** The translated fragment, or null to draw the original. */
    public String lookup(String raw) {
        BatchTranslator tr = translator;
        if (tr == null || exempt.contains(raw)) return null;
        Boolean worth = candidate.get(raw);
        if (worth == null) {
            worth = Lang.uiCandidate(raw, tr.targetLang());
            if (candidate.size() > MAX_REMEMBERED) candidate.clear();
            candidate.put(raw, worth);
        }
        return worth ? tr.cached(raw) : null;
    }
}
