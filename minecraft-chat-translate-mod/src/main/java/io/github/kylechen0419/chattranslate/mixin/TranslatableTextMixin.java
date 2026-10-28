package io.github.kylechen0419.chattranslate.mixin;

import io.github.kylechen0419.chattranslate.ChatTranslateClient;
import net.minecraft.text.StringVisitable;
import net.minecraft.text.Style;
import net.minecraft.text.TranslatableTextContent;
import net.minecraft.util.Language;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import java.util.Optional;

/**
 * Mod and resource-pack menus often use translation keys that only have an English entry, so they
 * stay English whatever the game language is. Translate the resolved text of keys without arguments.
 */
@Mixin(TranslatableTextContent.class)
public abstract class TranslatableTextMixin {
    @Inject(method = "visit(Lnet/minecraft/text/StringVisitable$StyledVisitor;Lnet/minecraft/text/Style;)Ljava/util/Optional;",
            at = @At("HEAD"), cancellable = true, require = 0)
    private <T> void chattranslate$translate(StringVisitable.StyledVisitor<T> visitor, Style style,
                                             CallbackInfoReturnable<Optional<T>> cir) {
        TranslatableTextContent self = (TranslatableTextContent) (Object) this;
        if (self.getArgs().length > 0) return;
        String fallback = self.getFallback();
        Language lang = Language.getInstance();
        String resolved = fallback == null ? lang.get(self.getKey()) : lang.get(self.getKey(), fallback);
        if (resolved.indexOf('%') >= 0) return;
        String translated = ChatTranslateClient.UI.lookup(resolved);
        if (translated == null) return;
        cir.setReturnValue(visitor.accept(style, translated));
    }
}
