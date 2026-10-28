package io.github.kylechen0419.chattranslate.mixin;

import io.github.kylechen0419.chattranslate.ChatTranslateClient;
import net.minecraft.text.CharacterVisitor;
import net.minecraft.text.Style;
import net.minecraft.text.TextVisitFactory;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/**
 * Every string that is drawn, measured or wrapped ends up here as characters, whichever path it came
 * from (literal text, StringVisitable.plain in custom item panels, TextRenderer.draw(String)...), so
 * this catches the text the other hooks miss. Translated text is Chinese and isn't looked up again.
 */
@Mixin(TextVisitFactory.class)
public abstract class TextVisitFactoryMixin {
    @Inject(method = "visitFormatted(Ljava/lang/String;ILnet/minecraft/text/Style;Lnet/minecraft/text/Style;Lnet/minecraft/text/CharacterVisitor;)Z",
            at = @At("HEAD"), cancellable = true, require = 0)
    private static void chattranslate$translate(String text, int startIndex, Style startingStyle, Style resetStyle,
                                                CharacterVisitor visitor, CallbackInfoReturnable<Boolean> cir) {
        if (startIndex != 0 || text == null || text.isEmpty()) return;
        String translated = ChatTranslateClient.UI.lookup(text);
        if (translated == null) return;
        Style s = Style.DEFAULT_FONT_ID.equals(startingStyle.getFont()) ? startingStyle
                : startingStyle.withFont(Style.DEFAULT_FONT_ID);
        cir.setReturnValue(TextVisitFactory.visitFormatted(translated, 0, s, resetStyle, visitor));
    }
}
