// 用自己的 Firebase 牽線的點對點連線（取代 PeerJS 的公開配對伺服器）。
// 介面跟 PeerJS 一樣（new FbPeer(...)、on('open'|'connection'|'error'|'disconnected')、connect()、destroy()），net.js 不用分兩套寫法。
// 牽線的方式：
//   房主在 sigh/<id> 掛號（每 10 秒更新一次心跳；超過 25 秒沒心跳，別人才能接手同一個代碼）
//   玩家把連線邀請（WebRTC offer，候選位址一起放進去）放進 sigi/<id>/<編號>，房主寫回 answer，之後就直接點對點連線
// 牽線的資料都只放一下子：連上就刪掉，關掉網頁時 Firebase 也會自動清掉。
const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
const GATHER_MAX = 3000;  // 收集連線位址最多等這麼久（不然有些網路會卡很久）
const HEARTBEAT = 10000;
const CHUNK = 16000;      // 大訊息切成小塊送（資料通道一次能送的大小有限）

const rand = (n = 10) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');

class Emitter {
  constructor() { this.handlers = {}; }
  on(ev, fn) { (this.handlers[ev] ||= []).push(fn); return this; }
  off(ev, fn) { this.handlers[ev] = (this.handlers[ev] || []).filter((f) => f !== fn); return this; }
  emit(ev, ...a) { for (const f of [...(this.handlers[ev] || [])]) { try { f(...a); } catch (e) { console.warn(e); } } }
}

// 等 WebRTC 把可以用的連線位址都找完（最多等 GATHER_MAX），之後一次把 offer／answer 連同位址送出去
function gathered(pc) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((ok) => {
    const done = () => { pc.removeEventListener('icegatheringstatechange', check); ok(); };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(done, GATHER_MAX);
  });
}

class FbConn extends Emitter {
  constructor(peerId, pc) {
    super();
    this.peer = peerId;           // 對方的 id（跟 PeerJS 一樣）
    this.connectionId = `fc_${rand(8)}`;
    this.pc = pc;
    this.dc = null;
    this.open = false;
    this.closed = false;
    this.parts = new Map();
    pc.addEventListener('connectionstatechange', () => {
      const s = pc.connectionState;
      clearTimeout(this.lostTimer);
      if (s === 'failed' || s === 'closed') this.close();
      // 網路一下子斷掉：等一下看會不會自己恢復，回不來就當作斷線（讓上層去重連）
      else if (s === 'disconnected') this.lostTimer = setTimeout(() => { if (pc.connectionState !== 'connected') this.close(); }, 6000);
    });
  }

  attach(dc) {
    this.dc = dc;
    dc.onopen = () => { if (this.closed) return; this.open = true; this.emit('open'); };
    dc.onclose = () => this.close();
    dc.onerror = () => this.close();
    dc.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m && m.__k) {
        // 切成好幾塊的大訊息：收齊了再拼回去
        const p = this.parts.get(m.__k) || [];
        p[m.i] = m.d;
        this.parts.set(m.__k, p);
        if (p.filter((x) => x !== undefined).length < m.n) return;
        this.parts.delete(m.__k);
        try { m = JSON.parse(p.join('')); } catch { return; }
      }
      this.emit('data', m);
    };
    if (dc.readyState === 'open') dc.onopen();
  }

  send(msg) {
    if (!this.open || !this.dc || this.dc.readyState !== 'open') return;
    const s = JSON.stringify(msg);
    if (s.length <= CHUNK) { this.dc.send(s); return; }
    const k = rand(6);
    const n = Math.ceil(s.length / CHUNK);
    for (let i = 0; i < n; i++) this.dc.send(JSON.stringify({ __k: k, i, n, d: s.slice(i * CHUNK, (i + 1) * CHUNK) }));
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    const was = this.open;
    this.open = false;
    clearTimeout(this.lostTimer);
    try { this.dc?.close(); } catch { /* 忽略 */ }
    try { this.pc.close(); } catch { /* 忽略 */ }
    this.cleanup?.();
    if (was || this.dc) this.emit('close');
    else this.emit('error', new Error('closed'));
  }
}

export class FbPeer extends Emitter {
  // db：Firebase 資料庫；uid：這個瀏覽器的登入身分；id：房主要掛號的代碼（玩家不用給）
  constructor(db, uid, id = null) {
    super();
    this.db = db;
    this.uid = uid;
    this.host = !!id;
    this.id = id || `g-${rand(12)}`;
    this.session = rand(10);
    this.open = false;
    this.disconnected = false;
    this.destroyed = false;
    this.conns = new Set();
    this.offs = [];
    this.wasOnline = null;
    const info = db.ref('.info/connected');
    const onInfo = (snap) => {
      const up = snap.val() === true;
      if (this.destroyed) return;
      if (!up && this.wasOnline) { this.disconnected = true; this.emit('disconnected'); }
      if (up && this.wasOnline === false && this.host && this.open) this.reclaim();
      if (up) this.disconnected = false;
      this.wasOnline = up;
    };
    info.on('value', onInfo);
    this.offs.push(() => info.off('value', onInfo));
    if (this.host) this.claim();
    else setTimeout(() => { if (!this.destroyed) { this.open = true; this.emit('open', this.id); } }, 0);
  }

  // ---------- 房主 ----------
  hostRef() { return this.db.ref(`sigh/${this.id}`); }
  inboxRef() { return this.db.ref(`sigi/${this.id}`); }

  // 掛號：代碼沒人用、是自己（同一個瀏覽器重新整理）、或原本的房主已經 25 秒沒心跳，才搶得到
  async take() {
    // Firebase 卡住（網路怪怪的）：8 秒內沒結果就當作失敗，改用 PeerJS，不要讓開房一直轉圈
    return Promise.race([this.takeNow(), new Promise((_, no) => { setTimeout(() => no(new Error('timeout')), 8000); })]);
  }

  async takeNow() {
    const offset = await this.db.ref('.info/serverTimeOffset').once('value').then((s) => s.val() || 0, () => 0);
    const me = { u: this.uid, s: this.session, t: window.firebase.database.ServerValue.TIMESTAMP };
    const res = await this.hostRef().transaction((cur) => {
      if (cur && cur.u !== this.uid && cur.s !== this.session && Number(cur.t) > Date.now() + offset - 25000) return undefined;
      return me;
    }, undefined, false);
    return res.committed;
  }

  async claim() {
    try {
      if (!(await this.take())) { this.fail('unavailable-id'); return; }
    } catch (e) {
      this.fail(/permission/i.test(e?.message || e?.code || '') ? 'permission' : 'server-error', e);
      return;
    }
    if (this.destroyed) { this.hostRef().remove().catch(() => {}); return; }
    this.armDisconnect();
    // 自己的掛號被別人接手了（斷線太久）：跟 PeerJS 一樣回報 unavailable-id
    const watch = this.hostRef();
    const onClaim = (snap) => {
      const v = snap.val();
      if (this.destroyed || !this.open) return;
      if (v && v.s !== this.session) { this.displaced = true; this.stopHeart(); this.emit('error', Object.assign(new Error('unavailable-id'), { type: 'unavailable-id' })); }
      else if (!v && !this.disconnected) this.reclaim();
    };
    watch.on('value', onClaim);
    this.offs.push(() => watch.off('value', onClaim));
    this.listenInbox();
    this.heart = setInterval(() => { if (!this.disconnected) this.hostRef().child('t').set(window.firebase.database.ServerValue.TIMESTAMP).catch(() => {}); }, HEARTBEAT);
    this.open = true;
    this.emit('open', this.id);
  }

  // 聽信箱裡的連線邀請。信箱的讀取權限要看掛號是不是自己的：網路斷掉時 Firebase 會先把掛號清掉，
  // 連回來時舊的監聽會被規則取消，所以每次重新掛號成功都要重新聽一次
  listenInbox() {
    this.offInbox?.();
    const inbox = this.inboxRef();
    const onOffer = (snap) => this.answer(snap.key, snap.val());
    inbox.on('child_added', onOffer, () => { /* 被取消（還沒重新掛號）：重新掛號後會再聽 */ });
    this.offInbox = () => inbox.off('child_added', onOffer);
  }

  armDisconnect() {
    this.hostRef().onDisconnect().remove().catch(() => {});
    this.inboxRef().onDisconnect().remove().catch(() => {});
  }

  // 網路斷掉又回來：Firebase 可能已經把掛號清掉了，重新掛一次（被別人接手就算被擠掉）
  async reclaim() {
    if (this.reclaiming || this.displaced || this.destroyed) return;
    this.reclaiming = true;
    try {
      if (await this.take()) { this.armDisconnect(); this.listenInbox(); this.emit('open', this.id); }
      else if (!this.displaced) { this.displaced = true; this.stopHeart(); this.emit('error', Object.assign(new Error('unavailable-id'), { type: 'unavailable-id' })); }
    } catch { /* 下次再試 */ } finally { this.reclaiming = false; }
  }

  stopHeart() { clearInterval(this.heart); this.heart = null; }

  fail(type, e) {
    if (this.destroyed) return;
    this.emit('error', Object.assign(new Error(type), { type, cause: e }));
  }

  // 房主：收到一個連線邀請，寫回 answer
  async answer(key, offer) {
    if (!offer || typeof offer.o !== 'string' || offer.a || this.destroyed) return;
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const conn = new FbConn(String(offer.f || key), pc);
    const entry = this.inboxRef().child(key);
    conn.cleanup = () => { entry.remove().catch(() => {}); this.conns.delete(conn); };
    this.conns.add(conn);
    pc.ondatachannel = (e) => { conn.attach(e.channel); conn.on('open', () => entry.remove().catch(() => {})); };
    this.emit('connection', conn);
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: offer.o });
      await pc.setLocalDescription(await pc.createAnswer());
      await gathered(pc);
      await entry.child('a').set(pc.localDescription.sdp);
    } catch { conn.close(); return; }
    // 30 秒還沒接上就放棄（對方可能已經走了）
    setTimeout(() => { if (!conn.open) conn.close(); }, 30000);
  }

  // ---------- 玩家 ----------
  // 這個代碼現在有沒有房主掛號（有心跳）
  async has(remoteId) {
    // 5 秒內問不到就當作沒有（改用 PeerJS 試試看），不要讓加入房間一直轉圈
    const v = await Promise.race([
      this.db.ref(`sigh/${remoteId}`).once('value').then((s) => s.val()),
      new Promise((_, no) => { setTimeout(() => no(new Error('timeout')), 5000); }),
    ]);
    return !!v;
  }

  connect(remoteId) {
    const pc = new RTCPeerConnection({ iceServers: ICE });
    const conn = new FbConn(remoteId, pc);
    this.conns.add(conn);
    conn.attach(pc.createDataChannel('d', { ordered: true }));
    (async () => {
      if (!(await this.has(remoteId))) {
        this.emit('error', Object.assign(new Error('peer-unavailable'), { type: 'peer-unavailable' }));
        conn.close();
        return;
      }
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      if (conn.closed) return;
      const entry = this.db.ref(`sigi/${remoteId}`).push();
      conn.cleanup = () => { entry.off(); entry.remove().catch(() => {}); this.conns.delete(conn); };
      entry.onDisconnect().remove().catch(() => {});
      await entry.set({ u: this.uid, f: this.id, o: pc.localDescription.sdp });
      const onAns = async (snap) => {
        const sdp = snap.val();
        if (typeof sdp !== 'string' || pc.remoteDescription) return;
        entry.child('a').off('value', onAns);
        try { await pc.setRemoteDescription({ type: 'answer', sdp }); } catch { conn.close(); }
      };
      entry.child('a').on('value', onAns);
      conn.on('open', () => { entry.child('a').off('value', onAns); entry.remove().catch(() => {}); entry.onDisconnect().cancel().catch(() => {}); });
    })().catch(() => conn.close());
    return conn;
  }

  reconnect() { /* Firebase 會自己重連；回來時會重新掛號 */ }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.open = false;
    this.stopHeart();
    for (const off of this.offs) { try { off(); } catch { /* 忽略 */ } }
    try { this.offInbox?.(); } catch { /* 忽略 */ }
    for (const c of [...this.conns]) c.close();
    if (this.host && !this.displaced) {
      this.hostRef().transaction((cur) => (cur && cur.s === this.session ? null : undefined), undefined, false).catch(() => {});
      this.inboxRef().remove().catch(() => {});
    }
    this.emit('close');
  }
}
