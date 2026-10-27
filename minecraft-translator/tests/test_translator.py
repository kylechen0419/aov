import json
import os
import socket
import struct
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import mc_translator as mt  # noqa: E402
from rcon import Rcon  # noqa: E402
from translator import Translator  # noqa: E402


class ParseTest(unittest.TestCase):
    def test_formats(self):
        cases = {
            "[12:34:56] [Server thread/INFO]: <Steve> hello there\n": ("chat", "Steve", "hello there"),
            "[12:34:56 INFO]: <Alex> こんにちは\n": ("chat", "Alex", "こんにちは"),
            "[12:34:56] [Server thread/INFO]: [Not Secure] <Bob_1> 你好\n": ("chat", "Bob_1", "你好"),
            "[27Oct2026 12:34:56.123] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: <Kim> 안녕\n":
                ("chat", "Kim", "안녕"),
            "[12:34:56 INFO]: \x1b[0;37;22m<.Geyser> hi\x1b[m\n": ("chat", ".Geyser", "hi"),
            "[12:34:56] [Server thread/INFO]: Steve joined the game\n": ("join", "Steve"),
            "[12:34:56] [Server thread/INFO]: Steve left the game\n": ("leave", "Steve"),
        }
        for line, want in cases.items():
            self.assertEqual(mt.parse_line(line), want, line)

    def test_ignores_non_chat(self):
        for line in [
            "[12:34:56] [Server thread/INFO]: Done (3.2s)! For help, type \"help\"\n",
            "[12:34:56] [Server thread/INFO]: [Rcon: Made Steve say hi]\n",
            "[12:34:56] [Server thread/INFO]: Steve has made the advancement [Stone Age]\n",
            "garbage\n",
        ]:
            self.assertIsNone(mt.parse_line(line), line)

    def test_custom_regex(self):
        import re
        rx = re.compile(r"^\[\w+\] (?P<name>\w+): (?P<msg>.+)$")
        self.assertEqual(mt.parse_line("[12:00:00 INFO]: [Member] Steve: yo\n", rx), ("chat", "Steve", "yo"))

    def test_normalize_lang(self):
        self.assertEqual(mt.normalize_lang("JP"), "ja")
        self.assertEqual(mt.normalize_lang("zh_TW"), "zh-tw")
        self.assertEqual(mt.normalize_lang("中文"), "zh-tw")
        self.assertIsNone(mt.normalize_lang("klingon"))


class FollowTest(unittest.TestCase):
    def test_partial_lines_and_rotation(self):
        d = tempfile.mkdtemp()
        path = os.path.join(d, "latest.log")
        open(path, "w").write("old line\n")
        got = []
        gen = mt.follow(path, poll=0.01)

        t = threading.Thread(target=lambda: [got.append(next(gen)) for _ in range(3)], daemon=True)
        t.start()
        time.sleep(0.1)
        with open(path, "a", encoding="utf-8") as f:
            f.write("half ")
            f.flush()
            time.sleep(0.05)
            f.write("一行\n")
        time.sleep(0.1)
        os.rename(path, os.path.join(d, "old.log"))
        open(path, "w").write("after rotate\n")
        with open(os.path.join(d, "old.log"), "a") as f:
            f.write("tail of old\n")  # written before we notice the rename
        t.join(3)
        self.assertEqual(got[0], "half 一行\n")
        self.assertIn("after rotate\n", got)
        self.assertNotIn("old line\n", got)


class FakeRconServer(threading.Thread):
    def __init__(self, password, responses):
        super().__init__(daemon=True)
        self.password, self.responses, self.commands = password, responses, []
        self.srv = socket.socket()
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen()
        self.port = self.srv.getsockname()[1]

    def run(self):
        conn, _ = self.srv.accept()
        while True:
            head = conn.recv(4)
            if not head:
                return
            (n,) = struct.unpack("<i", head)
            data = b""
            while len(data) < n:
                data += conn.recv(n - len(data))
            rid, ptype = struct.unpack("<ii", data[:8])
            body = data[8:-2].decode()
            if ptype == 3:
                reply_id = rid if body == self.password else -1
                self._send(conn, reply_id, 2, "")
            else:
                self.commands.append(body)
                self._send(conn, rid, 0, self.responses.get(body.split()[0], ""))

    def _send(self, conn, rid, ptype, body):
        payload = struct.pack("<ii", rid, ptype) + body.encode() + b"\x00\x00"
        conn.sendall(struct.pack("<i", len(payload)) + payload)


class RconTest(unittest.TestCase):
    def test_command(self):
        srv = FakeRconServer("pw", {"list": "There are 1 of a max of 20 players online: Steve"})
        srv.start()
        r = Rcon("127.0.0.1", srv.port, "pw")
        self.assertIn("Steve", r.command("list"))
        r.command('tellraw Steve [{"text":"嗨"}]')
        self.assertEqual(srv.commands[-1], 'tellraw Steve [{"text":"嗨"}]')

    def test_bad_password(self):
        srv = FakeRconServer("pw", {})
        srv.start()
        with self.assertRaises(Exception):
            Rcon("127.0.0.1", srv.port, "nope").connect()


class FakeRcon:
    def __init__(self, online=""):
        self.sent = []
        self.online = online

    def command(self, cmd):
        if cmd == "list":
            return f"There are 3 of a max of 20 players online: {self.online}"
        self.sent.append(cmd)
        return ""

    def tells(self, player):
        out = []
        for c in self.sent:
            if c.startswith(f"tellraw {player} "):
                out.append("".join(p["text"] for p in json.loads(c.split(" ", 2)[2])))
        return out


class FakeTranslator:
    def __init__(self):
        self.calls = []

    def translate(self, text, targets):
        self.calls.append((text, sorted(targets)))
        return "en", {t: f"{t}:{text}" for t in targets}


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.file = os.path.join(tempfile.mkdtemp(), "players.json")
        self.rcon = FakeRcon("Steve, Alex, Kim")
        self.tr = FakeTranslator()
        self.b = mt.Bridge(self.rcon, self.tr, self.file)
        self.b.sync_online()

    def chat(self, name, msg):
        self.b.handle(("chat", name, msg))
        self.b.pool.shutdown(wait=True)
        self.b.pool = mt.ThreadPoolExecutor(max_workers=4)

    def test_flow(self):
        self.chat("Alex", "!lang ja")
        self.chat("Kim", "!lang zh")
        self.chat("Steve", "!lang en")
        self.rcon.sent.clear()
        self.chat("Steve", "watch out, creeper!")
        self.assertEqual(self.tr.calls[-1], ("watch out, creeper!", ["ja", "zh-tw"]))
        self.assertEqual(self.rcon.tells("Alex"), ["[譯] <Steve> ja:watch out, creeper!"])
        self.assertEqual(self.rcon.tells("Kim"), ["[譯] <Steve> zh-tw:watch out, creeper!"])
        self.assertEqual(self.rcon.tells("Steve"), [])  # sender, and source == en
        self.assertEqual(json.load(open(self.file)), {"alex": "ja", "kim": "zh-tw", "steve": "en"})

    def test_no_readers_no_call(self):
        self.chat("Steve", "hello")
        self.assertEqual(self.tr.calls, [])

    def test_off_and_leave(self):
        self.chat("Alex", "!lang ja")
        self.chat("Kim", "!lang ko")
        self.chat("Kim", "!lang off")
        self.b.handle(("leave", "Alex"))
        self.chat("Steve", "hello")
        self.assertEqual(self.tr.calls, [])

    def test_default_lang_and_commands_skipped(self):
        self.b.default_lang = "zh-tw"
        self.chat("Steve", "/home")
        self.chat("Steve", "gg")
        self.assertEqual(self.tr.calls, [("gg", ["zh-tw"])])

    def test_bad_lang_and_translator_error(self):
        self.chat("Alex", "!lang klingon")
        self.assertIn("不認得", self.rcon.tells("Alex")[-1])
        self.chat("Alex", "!lang ja")

        def boom(*a):
            raise RuntimeError("api down")
        self.tr.translate = boom
        self.chat("Steve", "hello")  # must not raise
        self.assertEqual(len(self.rcon.tells("Alex")), 2)


class TranslatorTest(unittest.TestCase):
    def make(self, payload, stop="end_turn"):
        calls = []

        def create(**kw):
            calls.append(kw)
            return SimpleNamespace(stop_reason=stop, content=[
                SimpleNamespace(type="thinking", thinking=""),
                SimpleNamespace(type="text", text=json.dumps(payload)),
            ])
        client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create)))
        return Translator(client=client), calls

    def test_parse_and_cache(self):
        tr, calls = self.make({"source_lang": "en", "translations": [
            {"lang": "ja", "text": "クリーパーだ！ "}, {"lang": "zh-tw", "text": "苦力怕！"}, {"lang": "xx", "text": "?"}]})
        self.assertEqual(tr.translate("creeper!", {"ja", "zh-tw"}), ("en", {"ja": "クリーパーだ！", "zh-tw": "苦力怕！"}))
        self.assertEqual(tr.translate("creeper!", {"ja"}), ("en", {"ja": "クリーパーだ！"}))
        self.assertEqual(len(calls), 1)
        kw = calls[0]
        self.assertEqual(kw["model"], "claude-opus-5-5")
        self.assertEqual(kw["fallbacks"], "default")
        self.assertEqual(kw["output_config"]["format"]["type"], "json_schema")
        self.assertNotIn("thinking", kw)

    def test_refusal(self):
        tr, _ = self.make({}, stop="refusal")
        self.assertEqual(tr.translate("x", {"ja"}), ("other", {}))


if __name__ == "__main__":
    unittest.main()
