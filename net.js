// 點對點連線（WebRTC，透過 PeerJS 免費的配對伺服器），不需要自己架後端
// 房主是中繼站：每位玩家只連到房主，房主再把訊息轉給其他人
const PREFIX = 'wikirace-tw-1v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode() {
  let s = '';
  for (let i = 0; i < 5; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export class Net {
  constructor() {
    this.peer = null;
    this.conns = new Map(); // 房主：玩家 id → 連線
    this.hostConn = null; // 玩家：連到房主的連線
    this.isHost = false;
    this.code = null;
    this.maxGuests = 1;
    this.onMessage = () => {};
    this.onPeerJoin = () => {};
    this.onPeerLeave = () => {};
  }

  // 房主：用房間代碼註冊一個 Peer ID，等待玩家連進來
  createRoom(maxGuests = 1, tries = 0) {
    this.maxGuests = maxGuests;
    return new Promise((resolve, reject) => {
      this.isHost = true;
      this.code = randomCode();
      const peer = new Peer(PREFIX + this.code);
      peer.on('open', () => { this.peer = peer; resolve(this.code); });
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id' && tries < 5) {
          peer.destroy();
          this.createRoom(maxGuests, tries + 1).then(resolve, reject);
        } else if (!this.peer) {
          reject(new Error(`無法建立房間（${err.type}）`));
        } else {
          console.warn(err);
        }
      });
      peer.on('connection', (conn) => {
        if (this.conns.size >= this.maxGuests || this.locked) {
          conn.on('open', () => { conn.send({ t: 'full', started: !!this.locked }); setTimeout(() => conn.close(), 500); });
          return;
        }
        this.attach(conn, conn.peer);
      });
      peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
    });
  }

  // 玩家：連到房主的 Peer ID
  joinRoom(code) {
    return new Promise((resolve, reject) => {
      this.isHost = false;
      this.code = code.toUpperCase();
      const peer = new Peer();
      let settled = false;
      const fail = (msg) => { if (!settled) { settled = true; peer.destroy(); reject(new Error(msg)); } };
      const timer = setTimeout(() => fail('連線逾時，請確認房間代碼是否正確'), 15000);
      peer.on('open', () => {
        this.peer = peer;
        const conn = peer.connect(PREFIX + this.code, { reliable: true });
        conn.on('open', () => {
          settled = true;
          clearTimeout(timer);
          resolve();
        });
        this.attach(conn, 'host');
      });
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') fail('找不到這個房間，請確認代碼');
        else if (!settled) fail(`連線失敗（${err.type}）`);
        else console.warn(err);
      });
    });
  }

  attach(conn, id) {
    if (this.isHost) {
      conn.on('open', () => { this.conns.set(id, conn); this.onPeerJoin(id); });
    } else {
      this.hostConn = conn;
    }
    conn.on('data', (msg) => {
      if (msg && typeof msg === 'object') this.onMessage(msg, id);
    });
    let gone = false;
    const leave = () => {
      if (gone) return;
      gone = true;
      if (this.isHost) {
        if (this.conns.get(id) !== conn) return;
        this.conns.delete(id);
      } else {
        if (this.hostConn !== conn) return;
        this.hostConn = null;
      }
      this.onPeerLeave(id);
    };
    conn.on('close', leave);
    conn.on('error', leave);
  }

  // 房主：不指定 to 就廣播給所有人（可排除某人）；玩家：一律送給房主
  send(msg, to = null, except = null) {
    if (!this.isHost) {
      if (this.hostConn && this.hostConn.open) this.hostConn.send(msg);
      return;
    }
    if (to) {
      const c = this.conns.get(to);
      if (c && c.open) c.send(msg);
      return;
    }
    for (const [id, c] of this.conns) if (id !== except && c.open) c.send(msg);
  }

  get guestIds() {
    return [...this.conns.keys()];
  }

  get connected() {
    return this.isHost ? this.conns.size > 0 : !!(this.hostConn && this.hostConn.open);
  }

  destroy() {
    for (const c of this.conns.values()) c.close();
    if (this.hostConn) this.hostConn.close();
    if (this.peer) this.peer.destroy();
    this.peer = this.hostConn = null;
    this.conns.clear();
  }
}
