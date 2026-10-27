package io.github.kylechen0419.chattranslate.mixin;

import io.github.kylechen0419.chattranslate.ChatTranslateClient;
import net.minecraft.client.font.TextRenderer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyVariable;

/**
 * Custom menus that draw plain Java strings (not Text) skip the text hooks, so swap the string
 * itself when it is drawn or measured. Only the String overloads have a String argument to modify.
 */
@Mixin(TextRenderer.class)
public abstract class TextRendererMixin {
    @ModifyVariable(method = "draw", at = @At("HEAD"), argsOnly = true, require = 0)
    private String chattranslate$draw(String text) {
        return chattranslate$swap(text);
    }

    @ModifyVariable(method = "getWidth", at = @At("HEAD"), argsOnly = true, require = 0)
    private String chattranslate$width(String text) {
        return chattranslate$swap(text);
    }

    private static String chattranslate$swap(String text) {
        if (text == null) return null;
        String translated = ChatTranslateClient.UI.lookup(text);
        return translated == null ? text : translated;
    }
}
