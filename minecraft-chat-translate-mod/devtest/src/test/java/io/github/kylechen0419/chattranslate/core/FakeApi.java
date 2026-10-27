package io.github.kylechen0419.chattranslate.core;

import com.anthropic.client.AnthropicClient;
import com.anthropic.client.okhttp.AnthropicOkHttpClient;
import com.sun.net.httpserver.HttpServer;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Function;

/** A local stand-in for the Messages API that records requests and answers with canned text. */
final class FakeApi implements AutoCloseable {
    final List<String> bodies = new CopyOnWriteArrayList<>();
    final List<String> betaHeaders = new CopyOnWriteArrayList<>();
    private final HttpServer server;

    FakeApi(Function<String, String> reply, String stopReason) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", ex -> {
            String body = new String(ex.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            bodies.add(body);
            betaHeaders.add(ex.getRequestHeaders().getFirst("anthropic-beta"));
            String text = reply.apply(body).replace("\\", "\\\\").replace("\"", "\\\"");
            String json = "{\"id\":\"msg_1\",\"type\":\"message\",\"role\":\"assistant\",\"model\":\"claude-opus-5-5\","
                    + "\"stop_reason\":\"" + stopReason + "\",\"stop_sequence\":null,"
                    + "\"usage\":{\"input_tokens\":10,\"output_tokens\":5},"
                    + "\"content\":[{\"type\":\"thinking\",\"thinking\":\"\",\"signature\":\"x\"},{\"type\":\"text\",\"text\":\"" + text + "\"}]}";
            byte[] out = json.getBytes(StandardCharsets.UTF_8);
            ex.getResponseHeaders().add("content-type", "application/json");
            ex.sendResponseHeaders(200, out.length);
            ex.getResponseBody().write(out);
            ex.close();
        });
        server.start();
    }

    AnthropicClient client() {
        return AnthropicOkHttpClient.builder().apiKey("test-key").maxRetries(0)
                .baseUrl("http://127.0.0.1:" + server.getAddress().getPort()).build();
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
