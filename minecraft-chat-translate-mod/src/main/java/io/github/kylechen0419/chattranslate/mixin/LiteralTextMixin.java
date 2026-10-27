package io.github.kylechen0419.chattranslate.mixin;

import io.github.kylechen0419.chattranslate.ChatTranslateClient;
import net.minecraft.text.PlainTextContent;
import net.minecraft.text.StringVisitable;
import net.minecraft.text.Style;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import java.util.Optional;

/**
 * Swaps server-sent literal text for its translation when it is drawn or measured. Only the styled
 * visit (used by rendering and line wrapping) is changed; getString() still returns the original,
 * so anything that reads text as data keeps working.
 */
@Mixin(PlainTextContent.Literal.class)
public abstract class LiteralTextMixin {
    @Inject(method = "visit(Lnet/minecraft/text/StringVisitable$StyledVisitor;Lnet/minecraft/text/Style;)Ljava/util/Optional;",
            at = @At("HEAD"), cancellable = true)
    private <T> void chattranslate$translate(StringVisitable.StyledVisitor<T> visitor, Style style,
                                             CallbackInfoReturnable<Optional<T>> cir) {
        String raw = ((PlainTextContent.Literal) (Object) this).string();
        String translated = ChatTranslateClient.UI.lookup(raw);
        if (translated == null) return;
        // a server font made for Latin text may not have CJK glyphs; fall back to the default font
        Style s = Style.DEFAULT_FONT_ID.equals(style.getFont()) ? style : style.withFont(Style.DEFAULT_FONT_ID);
        cir.setReturnValue(visitor.accept(s, translated));
    }
}
