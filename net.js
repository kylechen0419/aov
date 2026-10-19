// 點對點連線（WebRTC，透過 PeerJS 免費的配對伺服器），不需要自己架後端
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
    this.conn = null;
    this.isHost = false;
    this.code = null;
    this.onMessage = () => {};
    this.onPeerJoin = () => {};
    this.onPeerLeave = () => {};
  }

  // 房主：用房間代碼註冊一個 Peer ID，等待對手連進來
  createRoom(tries = 0) {
    return new Promise((resolve, reject) => {
      this.isHost = true;
      this.code = randomCode();
      const peer = new Peer(PREFIX + this.code);
      peer.on('open', () => { this.peer = peer; resolve(this.code); });
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id' && tries < 5) {
          peer.destroy();
          this.createRoom(tries + 1).then(resolve, reject);
        } else if (!this.peer) {
          reject(new Error(`無法建立房間（${err.type}）`));
        } else {
          console.warn(err);
        }
      });
      peer.on('connection', (conn) => {
        if (this.conn && this.conn.open) {
          conn.on('open', () => { conn.send({ t: 'full' }); setTimeout(() => conn.close(), 500); });
          return;
        }
        this.attach(conn);
      });
      peer.on('disconnected', () => { if (!peer.destroyed) peer.reconnect(); });
    });
  }

  // 加入者：連到房主的 Peer ID
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
        this.attach(conn);
      });
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') fail('找不到這個房間，請確認代碼');
        else if (!settled) fail(`連線失敗（${err.type}）`);
        else console.warn(err);
      });
    });
  }

  attach(conn) {
    this.conn = conn;
    conn.on('open', () => { if (this.isHost) this.onPeerJoin(); });
    conn.on('data', (msg) => {
      if (msg && typeof msg === 'object') this.onMessage(msg);
    });
    const leave = () => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.onPeerLeave();
    };
    conn.on('close', leave);
    conn.on('error', leave);
  }

  send(msg) {
    if (this.conn && this.conn.open) this.conn.send(msg);
  }

  get connected() {
    return !!(this.conn && this.conn.open);
  }

  destroy() {
    if (this.conn) this.conn.close();
    if (this.peer) this.peer.destroy();
    this.peer = this.conn = null;
  }
}
