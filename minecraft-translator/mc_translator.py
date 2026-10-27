#!/usr/bin/env python3
"""Real-time chat translation for a Minecraft Java server.

Runs next to the server (no mods or plugins): it follows logs/latest.log for chat lines,
translates each message with Claude into every language the online players picked, and
sends the result back to each player privately with /tellraw over RCON.
Works with vanilla, Paper/Spigot, Fabric and Forge servers.
"""
import argparse
import json
import logging
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from rcon import Rcon
from translator import LANG_NAMES

log = logging.getLogger("mc-translator")

NAME = r"[A-Za-z0-9_.]{1,16}"  # "." covers Bedrock (Geyser) names like .Steve
ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]|§[0-9a-fk-or]", re.I)
CHAT = re.compile(rf"^(?:\[Not Secure\] )?<(?P<name>{NAME})> (?P<msg>.+)$")
JOIN = re.compile(rf"^(?P<name>{NAME}) joined the game$")
LEAVE = re.compile(rf"^(?P<name>{NAME}) left the game$")
LIST = re.compile(r"online:\s*(?P<names>.*)$", re.S)

LANG_ALIASES = {
    "zh": "zh-tw", "tw": "zh-tw", "zh_tw": "zh-tw", "繁中": "zh-tw", "中文": "zh-tw",
    "cn": "zh-cn", "zh_cn": "zh-cn", "简中": "zh-cn", "jp": "ja", "kr": "ko",
    "english": "en", "日本語": "ja", "한국어": "ko",
}


def log_content(line):
    """Strip the timestamp/thread prefix: works for vanilla, Paper and Forge layouts."""
    line = ANSI.sub("", line).rstrip("\r\n")
    idx = line.find("]: ")
    return line[idx + 3:] if idx != -1 else None


def parse_line(line, chat_re=CHAT):
    """Return ("chat", name, msg) / ("join", name) / ("leave", name) / None."""
    content = log_content(line)
    if content is None:
        return None
    m = chat_re.match(content)
    if m:
        return ("chat", m.group("name"), m.group("msg").strip())
    m = JOIN.match(content)
    if m:
        return ("join", m.group("name"))
    m = LEAVE.match(content)
    if m:
        return ("leave", m.group("name"))
    return None


def normalize_lang(code):
    code = code.strip().lower().replace("_", "-")
    code = LANG_ALIASES.get(code, code)
    return code if code in LANG_NAMES else None


def follow(path, poll=0.2, from_start=False):
    """Yield new lines of a log file, surviving the server rotating latest.log."""
    f, ino, partial = None, None, b""
    while True:
        if f is None:
            try:
                f = open(path, "rb")
                ino = os.fstat(f.fileno()).st_ino
                if not from_start:
                    f.seek(0, os.SEEK_END)
                from_start = True  # files that appear later are read from the top
                partial = b""
            except FileNotFoundError:
                time.sleep(1)
                continue
        chunk = f.readline()
        if chunk:
            partial += chunk
            if partial.endswith(b"\n"):
                line, partial = partial, b""
                yield line.decode("utf-8", "replace")
            continue
        time.sleep(poll)
        try:
            st = os.stat(path)
            if st.st_ino != ino or st.st_size < f.tell():
                f.close()
                f = None
        except FileNotFoundError:
            pass


class Bridge:
    def __init__(self, rcon, translator, players_file, default_lang=None, workers=4):
        self.rcon = rcon
        self.translator = translator
        self.players_file = players_file
        self.default_lang = default_lang
        self.online = set()
        self.lock = threading.Lock()
        self.pool = ThreadPoolExecutor(max_workers=workers)
        self.langs = self._load()

    def _load(self):
        try:
            with open(self.players_file, encoding="utf-8") as f:
                return json.load(f)
        except (FileNotFoundError, json.JSONDecodeError):
            return {}

    def _save(self):
        tmp = self.players_file + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.langs, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.players_file)

    def lang_of(self, name):
        lang = self.langs.get(name.lower(), self.default_lang)
        return None if lang == "off" else lang

    def sync_online(self):
        try:
            m = LIST.search(ANSI.sub("", self.rcon.command("list")))
        except OSError as e:
            log.warning("讀不到線上玩家名單：%s", e)
            return
        names = {n.strip() for n in m.group("names").split(",") if n.strip()} if m else set()
        with self.lock:
            self.online = names
        log.info("線上玩家：%s", ", ".join(sorted(names)) or "（無）")

    def handle(self, event):
        kind, name = event[0], event[1]
        if kind == "join":
            with self.lock:
                self.online.add(name)
            lang = self.lang_of(name)
            if lang:
                self.tell(name, [{"text": f"[翻譯] 你的語言：{LANG_NAMES[lang]}（!lang 可更改）", "color": "gray"}])
            else:
                self.tell(name, [{"text": "[翻譯] 聊天可以即時翻譯！輸入 !lang zh-tw / en / ja / ko … 選你的語言", "color": "gray"}])
        elif kind == "leave":
            with self.lock:
                self.online.discard(name)
        elif kind == "chat":
            msg = event[2]
            with self.lock:
                self.online.add(name)  # we may have started after they joined
            if msg.lower().startswith(("!lang", "!tr")):
                self.command(name, msg)
            elif not msg.startswith("/"):
                self.pool.submit(self._translate_and_send, name, msg)

    def command(self, name, msg):
        parts = msg.split()
        if len(parts) < 2:
            current = self.lang_of(name)
            codes = " ".join(LANG_NAMES)
            self.tell(name, [{"text": f"[翻譯] 目前：{LANG_NAMES[current] if current else '不翻譯'}。"
                                      f"用法：!lang <代碼> 或 !lang off。可用：{codes}", "color": "gray"}])
            return
        arg = parts[1]
        if arg.lower() == "off":
            self.langs[name.lower()] = "off"
            self._save()
            self.tell(name, [{"text": "[翻譯] 已關閉，你不會再收到翻譯", "color": "gray"}])
            return
        lang = normalize_lang(arg)
        if not lang:
            self.tell(name, [{"text": f"[翻譯] 不認得「{arg}」。可用：{' '.join(LANG_NAMES)}", "color": "red"}])
            return
        self.langs[name.lower()] = lang
        self._save()
        self.tell(name, [{"text": f"[翻譯] 好的！之後別人的聊天會翻成 {LANG_NAMES[lang]} 給你", "color": "green"}])

    def _translate_and_send(self, sender, msg):
        with self.lock:
            readers = {p: self.lang_of(p) for p in self.online if p != sender}
        readers = {p: l for p, l in readers.items() if l}
        if not readers:
            return
        try:
            source, out = self.translator.translate(msg, set(readers.values()))
        except Exception as e:  # never let one bad call stop the bridge
            log.warning("翻譯失敗（%s）：%s", type(e).__name__, e)
            return
        for player, lang in readers.items():
            text = out.get(lang)
            if not text or lang == source or text == msg:
                continue
            self.tell(player, [
                {"text": "[譯] ", "color": "dark_gray"},
                {"text": f"<{sender}> ", "color": "gray"},
                # hover shows the original; hoverEvent for <=1.21.4, hover_event for 1.21.5+
                {"text": text, "color": "white",
                 "hoverEvent": {"action": "show_text", "contents": f"原文：{msg}"},
                 "hover_event": {"action": "show_text", "value": f"原文：{msg}"}},
            ])
        log.info("<%s> %s → %s", sender, msg, out)

    def tell(self, player, components):
        try:
            self.rcon.command(f"tellraw {player} {json.dumps(components, ensure_ascii=False)}")
        except OSError as e:
            log.warning("送不出 tellraw 給 %s：%s", player, e)


def main():
    p = argparse.ArgumentParser(description="Minecraft 伺服器聊天即時翻譯")
    p.add_argument("--log", default=os.environ.get("MCT_LOG", "logs/latest.log"), help="伺服器的 logs/latest.log 路徑")
    p.add_argument("--rcon-host", default=os.environ.get("MCT_RCON_HOST", "127.0.0.1"))
    p.add_argument("--rcon-port", type=int, default=int(os.environ.get("MCT_RCON_PORT", "25575")))
    p.add_argument("--rcon-password", default=os.environ.get("MCT_RCON_PASSWORD"), help="或設定環境變數 MCT_RCON_PASSWORD")
    p.add_argument("--players-file", default=os.environ.get("MCT_PLAYERS_FILE", "players_lang.json"))
    p.add_argument("--default-lang", default=os.environ.get("MCT_DEFAULT_LANG"),
                   help="還沒設定 !lang 的玩家預設收哪種語言（不設＝不翻給他們）")
    p.add_argument("--chat-regex", default=os.environ.get("MCT_CHAT_REGEX"),
                   help="聊天插件改了格式時用，需含 (?P<name>...) 和 (?P<msg>...)，例如 '^\\[\\w+\\] (?P<name>\\w+): (?P<msg>.+)$'")
    p.add_argument("--model", default=None, help="Claude 模型（預設 claude-opus-5-5，或用 MCT_MODEL）")
    args = p.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if not args.rcon_password:
        p.error("需要 RCON 密碼：--rcon-password 或環境變數 MCT_RCON_PASSWORD")
    default_lang = normalize_lang(args.default_lang) if args.default_lang else None
    if args.default_lang and not default_lang:
        p.error(f"不認得的語言代碼：{args.default_lang}")
    chat_re = re.compile(args.chat_regex) if args.chat_regex else CHAT

    from translator import Translator
    bridge = Bridge(Rcon(args.rcon_host, args.rcon_port, args.rcon_password),
                    Translator(model=args.model), args.players_file, default_lang)
    bridge.sync_online()
    log.info("開始監看 %s", args.log)
    for line in follow(args.log):
        event = parse_line(line, chat_re)
        if event:
            bridge.handle(event)


if __name__ == "__main__":
    main()
