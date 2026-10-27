package io.github.kylechen0419.chattranslate.core;

import java.util.ArrayDeque;
import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;

/**
 * Hands results to the sink in the order they were added, even when later translations finish
 * first, so chat lines never shuffle while some of them are still being translated.
 */
public final class OrderedQueue<T> {
    private final ArrayDeque<CompletableFuture<T>> pending = new ArrayDeque<>();
    private final Consumer<T> sink;

    public OrderedQueue(Consumer<T> sink) {
        this.sink = sink;
    }

    public synchronized boolean isIdle() {
        return pending.isEmpty();
    }

    public void add(CompletableFuture<T> future) {
        synchronized (this) {
            pending.add(future);
        }
        future.whenComplete((r, e) -> drain());
    }

    private synchronized void drain() {
        while (!pending.isEmpty() && pending.peek().isDone()) {
            T value = pending.poll().getNow(null);
            if (value != null) sink.accept(value);
        }
    }
}
