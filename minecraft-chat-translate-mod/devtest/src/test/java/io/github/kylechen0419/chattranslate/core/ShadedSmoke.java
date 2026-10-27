package io.github.kylechen0419.chattranslate.core;

import java.util.concurrent.TimeUnit;

/** Run by `gradle smoke` against the relocated shadow jar: fails loudly if the bundle is broken. */
public final class ShadedSmoke {
    public static void main(String[] args) throws Exception {
        try (FakeApi api = new FakeApi(body -> "{\"translations\":[\"前往 Hanaka 北邊的沼澤｜{0}m\"]}", "end_turn")) {
            BatchTranslator tr = new BatchTranslator(api.client(), "claude-opus-5-5", "low", "zh-tw", null,
                    e -> { throw new AssertionError(e); });
            String out = tr.translate("Go to the marshes north of Hanaka | 350m").get(20, TimeUnit.SECONDS);
            if (!"前往 Hanaka 北邊的沼澤｜350m".equals(out)) throw new AssertionError("got " + out);
            Class<?> okhttp = Class.forName("io.github.kylechen0419.chattranslate.shaded.okhttp3.OkHttpClient");
            System.out.println("SMOKE OK via " + okhttp.getName() + " -> " + out);
        }
        System.exit(0);
    }
}
