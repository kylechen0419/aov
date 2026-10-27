"""Minimal Source RCON client (the protocol Minecraft's enable-rcon speaks)."""
import socket
import struct
import threading

SERVERDATA_AUTH = 3
SERVERDATA_EXECCOMMAND = 2


class RconError(Exception):
    pass


class Rcon:
    def __init__(self, host, port, password, timeout=5.0):
        self.host, self.port, self.password, self.timeout = host, port, password, timeout
        self.sock = None
        self.req_id = 0
        self.lock = threading.Lock()

    def connect(self):
        self.close()
        self.sock = socket.create_connection((self.host, self.port), timeout=self.timeout)
        rid = self._send(SERVERDATA_AUTH, self.password)
        # Some servers send an empty RESPONSE_VALUE before the auth reply.
        while True:
            got_id, _type, _body = self._recv()
            if got_id == -1:
                self.close()
                raise RconError("RCON 密碼錯誤")
            if _type == 2 and got_id == rid:
                return

    def close(self):
        if self.sock:
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = None

    def command(self, cmd):
        """Run a console command; reconnects once if the connection dropped."""
        with self.lock:
            for attempt in (0, 1):
                try:
                    if not self.sock:
                        self.connect()
                    rid = self._send(SERVERDATA_EXECCOMMAND, cmd)
                    while True:
                        got_id, _type, body = self._recv()
                        if got_id == rid:
                            return body
                except (OSError, RconError, struct.error):
                    self.close()
                    if attempt:
                        raise

    def _send(self, ptype, body):
        self.req_id = (self.req_id + 1) % 0x7FFFFFFF
        payload = struct.pack("<ii", self.req_id, ptype) + body.encode("utf-8") + b"\x00\x00"
        self.sock.sendall(struct.pack("<i", len(payload)) + payload)
        return self.req_id

    def _recv_exact(self, n):
        buf = b""
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise OSError("RCON 連線中斷")
            buf += chunk
        return buf

    def _recv(self):
        (length,) = struct.unpack("<i", self._recv_exact(4))
        data = self._recv_exact(length)
        rid, ptype = struct.unpack("<ii", data[:8])
        return rid, ptype, data[8:-2].decode("utf-8", "replace")
