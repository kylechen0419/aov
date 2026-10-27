"""Chat translation through the Claude API, with a small in-memory cache."""
import json
import os
import threading
from collections import OrderedDict

import anthropic

LANG_NAMES = {
    "zh-tw": "繁體中文（台灣用語）",
    "zh-cn": "简体中文",
    "en": "English",
    "ja": "日本語",
    "ko": "한국어",
    "es": "Español",
    "fr": "Français",
    "de": "Deutsch",
    "pt": "Português",
    "ru": "Русский",
    "th": "ไทย",
    "vi": "Tiếng Việt",
    "id": "Bahasa Indonesia",
}

SYSTEM = """You translate live Minecraft multiplayer chat.
Keep it short and casual like real game chat. Keep player names, item/mob/biome names that players
commonly leave in English, coordinates, numbers, commands (starting with / or !) and emoji unchanged,
and use each language's standard Minecraft terminology (e.g. Creeper = 苦力怕, Nether = 地獄).
Gamer slang and abbreviations (gg, afk, brb, lol, 666, 草, w) should be rendered as the natural
equivalent in the target language, or left as is when players of that language use it too.
For each requested target language, give the translation. If the message is already in that
language, or is only a name/number/emoji/command with nothing to translate, return it unchanged.
Also report the message's language as one of the given codes, or "other"."""

SCHEMA = {
    "type": "object",
    "properties": {
        "source_lang": {"type": "string"},
        "translations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"lang": {"type": "string"}, "text": {"type": "string"}},
                "required": ["lang", "text"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["source_lang", "translations"],
    "additionalProperties": False,
}


class Translator:
    def __init__(self, model=None, effort=None, cache_size=2000, client=None):
        self.model = model or os.environ.get("MCT_MODEL", "claude-opus-5-5")
        # Chat is latency-sensitive; low effort is plenty for short messages.
        self.effort = effort or os.environ.get("MCT_EFFORT", "low")
        self.client = client or anthropic.Anthropic()
        self.cache = OrderedDict()
        self.cache_size = cache_size
        self.lock = threading.Lock()

    def translate(self, text, targets):
        """Return (source_lang, {lang: translated}) for every lang in targets."""
        targets = sorted(set(targets))
        if not targets:
            return "other", {}
        with self.lock:
            hit = self.cache.get(text)
            if hit and all(t in hit[1] for t in targets):
                self.cache.move_to_end(text)
                return hit[0], {t: hit[1][t] for t in targets}

        source, out = self._call(text, targets)
        with self.lock:
            prev = self.cache.get(text, (source, {}))[1]
            self.cache[text] = (source, {**prev, **out})
            self.cache.move_to_end(text)
            while len(self.cache) > self.cache_size:
                self.cache.popitem(last=False)
        return source, out

    def _call(self, text, targets):
        codes = ", ".join(f"{t} ({LANG_NAMES.get(t, t)})" for t in targets)
        known = ", ".join(LANG_NAMES)
        prompt = (
            f"Target languages: {codes}\n"
            f"Language codes for source_lang: {known}\n"
            "Latency-sensitive; begin your answer immediately.\n\n"
            f"<message>\n{text}\n</message>"
        )
        response = self.client.beta.messages.create(
            model=self.model,
            max_tokens=2048,
            system=SYSTEM,
            messages=[{"role": "user", "content": prompt}],
            output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
        if response.stop_reason == "refusal":
            return "other", {}
        body = next((b.text for b in response.content if b.type == "text"), None)
        if not body:
            return "other", {}
        data = json.loads(body)
        out = {t["lang"]: t["text"].strip() for t in data["translations"] if t["lang"] in targets}
        return data["source_lang"], out
