import path from 'path';
import { randomBytes } from 'crypto';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

interface RacketOrientation {
  pitch: number;
  roll: number;
  yaw: number;
  accelMag: number;
  buttonB: boolean;
  connected: boolean;
}

interface SwingEvent {
  seq: number;
  role: 'p1' | 'p2';
  type: 'swing' | 'toss';
  side?: string | null;
  shotType: string;
  speed: number;
  angleX: number;
  dirX: number;
  dirY: number;
  pitch: number;
  roll: number;
  yaw: number;
  timestamp: number;
  serverTimeMs: number;
  source: string;
}

interface FeedbackEvent {
  seq: number;
  role: 'p1' | 'p2';
  kind: string;
  grade: string;
  shotType: string;
  speedKmh: number;
  intensity: number;
  serverTimeMs: number;
}

interface RacketState {
  role: 'p1' | 'p2';
  seq: number;
  lastSeenTs: number;
  connected: boolean;
  orientation: RacketOrientation;
  lastSwing: SwingEvent | null;
  swingHistory: SwingEvent[];
  feedbackSeq: number;
  lastFeedback: FeedbackEvent | null;
}

interface RoomState {
  roomId: string;
  mode: 'solo' | '1v1';
  hostName: string;
  guestName: string;
  gamesToWin: number;
  rackets: { p1: RacketState; p2: RacketState };
  stateSeq: number;
  matchSnapshot: Record<string, unknown> | null;
  p1DesktopSeenTs: number;
  p2DesktopSeenTs: number;
  lastTouched: number;
}

function createRacketState(role: 'p1' | 'p2'): RacketState {
  return {
    role,
    seq: 0,
    lastSeenTs: 0,
    connected: false,
    orientation: {
      pitch: 0,
      roll: 0,
      yaw: 0,
      accelMag: 0,
      buttonB: false,
      connected: false,
    },
    lastSwing: null,
    swingHistory: [],
    feedbackSeq: 0,
    lastFeedback: null,
  };
}

function createRoomState(
  roomId: string,
  hostName = 'Player 1',
  guestName = 'Player 2',
  gamesToWin = 2,
  mode: 'solo' | '1v1' = '1v1',
): RoomState {
  return {
    roomId,
    mode,
    hostName,
    guestName,
    gamesToWin,
    rackets: {
      p1: createRacketState('p1'),
      p2: createRacketState('p2'),
    },
    stateSeq: 0,
    matchSnapshot: null,
    p1DesktopSeenTs: 0,
    p2DesktopSeenTs: 0,
    lastTouched: Date.now(),
  };
}

function serializeRacket(racket: RacketState) {
  const now = Date.now();
  const lastSeenMs = racket.lastSeenTs > 0 ? Math.max(0, now - racket.lastSeenTs) : -1;
  const connected = racket.connected && lastSeenMs >= 0 && lastSeenMs < 12000;
  return {
    role: racket.role,
    connected,
    lastSeenMs,
    orientation: { ...racket.orientation, connected },
    lastSwing: racket.lastSwing ? { ...racket.lastSwing } : null,
    lastFeedback: racket.lastFeedback ? { ...racket.lastFeedback } : null,
    swingHistory: racket.swingHistory.slice(-15),
  };
}

const MAX_BODY_BYTES = 65536;

function readJsonBody(req: any): Promise<Record<string, any> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        resolve(null);
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => {
      if (!settled) {
        settled = true;
        resolve({});
      }
    });
  });
}

function sendJson(res: any, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.end(body);
}

// --- Zero-dependency ISO/IEC 18004 QR Code SVG Encoder (Byte mode, ECC Level L, v1..v9) ---
const QR_VER_L: Array<{ ec: number; blocks: Array<[number, number]>; align: number[] } | null> = [
  null,
  { ec: 7, blocks: [[1, 19]], align: [] },
  { ec: 10, blocks: [[1, 34]], align: [6, 18] },
  { ec: 15, blocks: [[1, 55]], align: [6, 22] },
  { ec: 20, blocks: [[1, 80]], align: [6, 26] },
  { ec: 26, blocks: [[1, 108]], align: [6, 30] },
  { ec: 18, blocks: [[2, 68]], align: [6, 34] },
  { ec: 20, blocks: [[2, 78]], align: [6, 22, 38] },
  { ec: 24, blocks: [[2, 97]], align: [6, 24, 42] },
  { ec: 30, blocks: [[2, 116]], align: [6, 26, 46] },
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let val = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = val;
    GF_LOG[val] = i;
    val <<= 1;
    if (val & 0x100) val ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
}

function gfMul(a: number, b: number): number {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsRemainder(data: Uint8Array, degree: number): Uint8Array {
  let gen = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gfMul(gen[j], GF_EXP[i]);
    }
    gen = next;
  }
  const rem = new Uint8Array(degree);
  for (const byte of data) {
    const factor = byte ^ rem[0];
    rem.copyWithin(0, 1);
    rem[degree - 1] = 0;
    for (let j = 0; j < degree; j++) {
      rem[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return rem;
}

function encodeQrSvg(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  let ver = 1;
  while (ver <= 9) {
    const specCandidate = QR_VER_L[ver]!;
    const cap = specCandidate.blocks.reduce((sum, [c, d]) => sum + c * d, 0) - 2;
    if (bytes.length <= cap) break;
    ver++;
  }
  if (ver > 9) {
    throw new Error('QR payload exceeds maximum length');
  }
  const spec = QR_VER_L[ver]!;
  const totalData = spec.blocks.reduce((sum, [c, d]) => sum + c * d, 0);
  const bits: number[] = [];
  const pushBits = (val: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };
  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) pushBits(b, 8);
  const maxBits = totalData * 8;
  pushBits(0, Math.min(4, maxBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const dataCodewords = new Uint8Array(totalData);
  for (let i = 0; i < bits.length / 8; i++) {
    let v = 0;
    for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
    dataCodewords[i] = v;
  }
  for (let i = bits.length / 8, pad = 0; i < totalData; i++, pad ^= 1) {
    dataCodewords[i] = pad ? 0x11 : 0xec;
  }

  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const [count, dLen] of spec.blocks) {
    for (let c = 0; c < count; c++) {
      const blk = dataCodewords.slice(offset, offset + dLen);
      offset += dLen;
      dataBlocks.push(blk);
      ecBlocks.push(rsRemainder(blk, spec.ec));
    }
  }
  const finalBytes: number[] = [];
  const maxDLen = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxDLen; i++) {
    for (const blk of dataBlocks) {
      if (i < blk.length) finalBytes.push(blk[i]);
    }
  }
  for (let i = 0; i < spec.ec; i++) {
    for (const blk of ecBlocks) finalBytes.push(blk[i]);
  }

  const size = 17 + 4 * ver;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size));
  const setFunc = (r: number, c: number, dark: boolean) => {
    if (r >= 0 && r < size && c >= 0 && c < size) {
      modules[r][c] = dark ? 1 : 0;
      isFunc[r][c] = 1;
    }
  };
  const drawFinder = (r0: number, c0: number) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const dist = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
        setFunc(r0 + dr, c0 + dc, dist !== 2 && dist !== 4);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }
  for (const r of spec.align) {
    for (const c of spec.align) {
      if ((r === 6 && c === 6) || (r === 6 && c === size - 7) || (r === size - 7 && c === 6)) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          setFunc(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunc(8, i, false);
      setFunc(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setFunc(8, size - 1 - i, false);
    setFunc(size - 1 - i, 8, false);
  }
  setFunc(size - 8, 8, true);

  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vBits = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((vBits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunc(a, b, bit);
      setFunc(b, a, bit);
    }
  }

  let bitIdx = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const upward = ((size - 1 - (right < 6 ? right + 1 : right)) & 2) === 0;
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!isFunc[r][c]) {
          let dark = false;
          if (bitIdx < finalBytes.length * 8) {
            dark = ((finalBytes[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) !== 0;
            bitIdx++;
          }
          if ((r + c) % 2 === 0) dark = !dark;
          modules[r][c] = dark ? 1 : 0;
        }
      }
    }
  }

  const fData = (0b01 << 3) | 0;
  let fRem = fData;
  for (let i = 0; i < 10; i++) fRem = (fRem << 1) ^ ((fRem >>> 9) * 0x537);
  const fBits = ((fData << 10) | fRem) ^ 0x5412;
  for (let i = 0; i <= 5; i++) modules[8][i] = (fBits >>> (14 - i)) & 1;
  modules[8][7] = (fBits >>> 8) & 1;
  modules[8][8] = (fBits >>> 7) & 1;
  modules[7][8] = (fBits >>> 6) & 1;
  for (let i = 9; i < 15; i++) modules[14 - i][8] = (fBits >>> (14 - i)) & 1;
  for (let i = 0; i < 7; i++) modules[size - 1 - i][8] = (fBits >>> (14 - i)) & 1;
  for (let i = 7; i < 15; i++) modules[8][size - 15 + i] = (fBits >>> (14 - i)) & 1;
  modules[size - 8][8] = 1;

  const margin = 4;
  const viewSize = size + margin * 2;
  let pathData = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        pathData += `M${c + margin},${r + margin}h1v1h-1z`;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#ffffff"/><path d="${pathData}" fill="#0c1b2e"/></svg>`;
}

const assetCache = new Map<string, { contentType: string; body: Buffer }>();
const assetInFlight = new Map<string, Promise<{ contentType: string; body: Buffer }>>();
const ASSET_CACHE_MAX_ENTRIES = 200;
const ASSET_CACHE_MAX_BYTES = 100 * 1024 * 1024;
const ASSET_MAX_ITEM_BYTES = 25 * 1024 * 1024;
let assetCacheBytes = 0;

function assetCacheGet(key: string) {
  const entry = assetCache.get(key);
  if (entry) {
    assetCache.delete(key);
    assetCache.set(key, entry);
  }
  return entry;
}

function assetCachePut(key: string, entry: { contentType: string; body: Buffer }) {
  if (entry.body.length > ASSET_MAX_ITEM_BYTES) return;
  const prev = assetCache.get(key);
  if (prev) {
    assetCache.delete(key);
    assetCacheBytes -= prev.body.length;
  }
  assetCache.set(key, entry);
  assetCacheBytes += entry.body.length;
  while (assetCache.size > ASSET_CACHE_MAX_ENTRIES || assetCacheBytes > ASSET_CACHE_MAX_BYTES) {
    const oldest = assetCache.keys().next().value;
    if (oldest === undefined) break;
    const item = assetCache.get(oldest);
    if (item) assetCacheBytes -= item.body.length;
    assetCache.delete(oldest);
  }
}

const ASSET_PATH_RE = /^\/assets\/(models|audio|textures|mediapipe)\/[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

function safeAssetPath(rawPathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPathname);
  } catch {
    return null;
  }
  if (
    decoded.includes('..') ||
    decoded.includes('\\') ||
    decoded.includes('%') ||
    decoded.includes('//') ||
    decoded.includes('\0') ||
    !ASSET_PATH_RE.test(decoded)
  ) {
    return null;
  }
  return decoded;
}

function mimeForPath(p: string): string {
  if (p.endsWith('.glb')) return 'model/gltf-binary';
  if (p.endsWith('.mp3')) return 'audio/mpeg';
  if (p.endsWith('.png')) return 'image/png';
  if (p.endsWith('.wasm')) return 'application/wasm';
  if (p.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'application/octet-stream';
}

const MAX_ROOMS = 500;
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_ROOM_RE = /^AT-[A-Z0-9]{4,24}$/;

function clip(value: unknown, fallback: string, maxLen = 32): string {
  return String(value ?? fallback).slice(0, maxLen);
}

function normalizeRoomCode(raw: unknown): string {
  const cleaned = String(raw || '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 32)
    .toUpperCase();
  if (!cleaned || cleaned === 'DEFAULT') return 'default';
  return cleaned;
}

function resolvePublicBaseUrl(req: any): string {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configured && /^https?:\/\/[a-zA-Z0-9.:-]+$/.test(configured)) {
    return configured;
  }
  const rawHost = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000')
    .split(',')[0]
    .trim();
  const safeHost = /^[a-zA-Z0-9.:-]+$/.test(rawHost) ? rawHost : 'localhost:3000';
  const rawProto = String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const isLocal = safeHost.startsWith('localhost') || safeHost.startsWith('127.0.0.1');
  const proto = rawProto === 'https' || rawProto === 'http' ? rawProto : isLocal ? 'http' : 'https';
  return `${proto}://${safeHost}`;
}

function argonTennisRelayPlugin() {
  const rooms = new Map<string, RoomState>();

  const putRoom = (roomId: string, state: RoomState) => {
    const now = Date.now();
    for (const [id, existing] of rooms) {
      if (now - (existing.lastTouched || 0) > ROOM_TTL_MS) {
        rooms.delete(id);
      }
    }
    while (rooms.size >= MAX_ROOMS) {
      const oldest = rooms.keys().next().value;
      if (oldest === undefined) break;
      rooms.delete(oldest);
    }
    state.lastTouched = now;
    rooms.set(roomId, state);
  };

  const getOrRestoreSessionRoom = (rawRoom: unknown): RoomState | null => {
    const roomId = normalizeRoomCode(rawRoom);
    if (roomId === 'default') return null;
    const existing = rooms.get(roomId);
    if (existing) {
      if (Date.now() - (existing.lastTouched || 0) > ROOM_TTL_MS) {
        rooms.delete(roomId);
      } else {
        rooms.delete(roomId);
        existing.lastTouched = Date.now();
        rooms.set(roomId, existing);
        return existing;
      }
    }
    if (SESSION_ROOM_RE.test(roomId)) {
      const restored = createRoomState(roomId);
      putRoom(roomId, restored);
      return restored;
    }
    return null;
  };

  const attachMiddleware = (middlewares: any) => {
    middlewares.use(async (req: any, res: any, next: any) => {
      const reqUrl = req.url || '/';
      const parsedUrl = new URL(reqUrl, 'http://localhost:3000');
      const pathname = parsedUrl.pathname;

      if (pathname === '/___rPc_sWiTcH___') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('OK');
        return;
      }

      if (
        pathname.startsWith('/assets/models/') ||
        pathname.startsWith('/assets/audio/') ||
        pathname.startsWith('/assets/textures/') ||
        pathname.startsWith('/assets/mediapipe/')
      ) {
        const sp = safeAssetPath(pathname);
        if (!sp) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.end('Bad asset path');
          return;
        }
        const targetUrl = `https://www.gstatic.com/aistudio/starter-apps/tennis/${sp.slice(8)}`;
        try {
          let entry = assetCacheGet(targetUrl);
          if (!entry) {
            let pending = assetInFlight.get(targetUrl);
            if (!pending) {
              pending = fetch(targetUrl)
                .then(async (resp) => {
                  if (!resp.ok) throw new Error(`Upstream ${resp.status}`);
                  const buf = Buffer.from(await resp.arrayBuffer());
                  const item = { contentType: mimeForPath(sp), body: buf };
                  assetCachePut(targetUrl, item);
                  return item;
                })
                .finally(() => assetInFlight.delete(targetUrl));
              assetInFlight.set(targetUrl, pending);
            }
            entry = await pending;
          }
          res.statusCode = 200;
          res.setHeader('Content-Type', entry.contentType);
          res.setHeader('Content-Length', entry.body.length);
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader('Cache-Control', 'public, max-age=86400');
          res.end(entry.body);
        } catch (err) {
          console.error('Asset proxy fetch failed', err);
          res.statusCode = 502;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('Upstream asset fetch failed');
        }
        return;
      }

      if (!pathname.startsWith('/api/')) {
        next();
        return;
      }

      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('Allow', 'GET, POST, OPTIONS');
        res.end();
        return;
      }

      const baseUrl = resolvePublicBaseUrl(req);
      const queryRoom = normalizeRoomCode(parsedUrl.searchParams.get('room'));
      const rawRole = (parsedUrl.searchParams.get('role') || 'p1').toLowerCase();
      const queryRole: 'p1' | 'p2' =
        rawRole === 'p2' || rawRole === '2' || rawRole === 'opponent' ? 'p2' : 'p1';

      if (req.method === 'GET' && pathname === '/api/qr.svg') {
        if (queryRoom === 'default') {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.end('Valid session room required');
          return;
        }
        const companionUrl = `${baseUrl}/companion.html?room=${encodeURIComponent(queryRoom)}&role=${queryRole}`;
        try {
          const svg = encodeQrSvg(companionUrl);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
          res.setHeader('X-Content-Type-Options', 'nosniff');
          res.setHeader(
            'Content-Security-Policy',
            "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          );
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
          res.end(svg);
        } catch (err) {
          console.error('QR generation failed', err);
          res.statusCode = 500;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('QR generation failed');
        }
        return;
      }

      if (req.method === 'GET' && pathname === '/api/racket/state') {
        const room = getOrRestoreSessionRoom(queryRoom);
        if (!room) {
          const empty = serializeRacket(createRacketState(queryRole));
          sendJson(res, queryRoom === 'default' ? 200 : 404, {
            ...empty,
            roomId: queryRoom,
            tunnelUrl: baseUrl,
          });
          return;
        }
        sendJson(res, 200, {
          ...serializeRacket(room.rackets[queryRole]),
          roomId: room.roomId,
          tunnelUrl: baseUrl,
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/tunnel/status') {
        const roomParam = queryRoom !== 'default' ? `room=${encodeURIComponent(queryRoom)}&` : '';
        sendJson(res, 200, {
          ok: true,
          active: true,
          tunnelUrl: baseUrl,
          companionUrl: `${baseUrl}/companion.html?${roomParam}role=${queryRole}`,
          joinUrl: `${baseUrl}/join.html?${roomParam}role=${queryRole}`,
        });
        return;
      }

      if (req.method === 'GET' && pathname === '/api/match/state') {
        if (queryRoom === 'default') {
          const p1Empty = serializeRacket(createRacketState('p1'));
          const p2Empty = serializeRacket(createRacketState('p2'));
          sendJson(res, 200, {
            ok: true,
            roomId: 'default',
            mode: 'solo',
            hostName: 'Player 1',
            guestName: 'Club AI',
            gamesToWin: 2,
            p1Online: false,
            p2Online: false,
            p1DesktopOnline: false,
            p2DesktopOnline: false,
            p1PhoneConnected: false,
            p2PhoneConnected: false,
            p1: p1Empty,
            p2: p2Empty,
            rackets: { p1: p1Empty, p2: p2Empty },
            snapshotSeq: 0,
            snapshot: null,
            tunnelUrl: baseUrl,
          });
          return;
        }

        const room = getOrRestoreSessionRoom(queryRoom);
        if (!room) {
          sendJson(res, 404, { ok: false, error: 'Room not found' });
          return;
        }

        const touch = (parsedUrl.searchParams.get('touch') || '').toLowerCase();
        if (touch === '1' || touch === 'true' || touch === 'p1' || touch === 'p2') {
          if (touch === 'p2' || (touch !== 'p1' && queryRole === 'p2')) {
            room.p2DesktopSeenTs = Date.now();
          } else {
            room.p1DesktopSeenTs = Date.now();
          }
        }

        const now = Date.now();
        const p1 = serializeRacket(room.rackets.p1);
        const p2 = serializeRacket(room.rackets.p2);
        const p1DesktopOnline = room.p1DesktopSeenTs > 0 && now - room.p1DesktopSeenTs < 8000;
        const p2DesktopOnline = room.p2DesktopSeenTs > 0 && now - room.p2DesktopSeenTs < 8000;
        sendJson(res, 200, {
          ok: true,
          roomId: room.roomId,
          mode: room.mode,
          hostName: room.hostName,
          guestName: room.guestName,
          gamesToWin: room.gamesToWin,
          p1Online: p1DesktopOnline,
          p2Online: p2DesktopOnline,
          p1DesktopOnline,
          p2DesktopOnline,
          p1PhoneConnected: p1.connected,
          p2PhoneConnected: p2.connected,
          p1,
          p2,
          rackets: { p1, p2 },
          snapshotSeq: room.stateSeq,
          snapshot: room.matchSnapshot,
          tunnelUrl: baseUrl,
        });
        return;
      }

      if (req.method === 'POST') {
        const body = await readJsonBody(req);
        if (body === null) {
          res.setHeader('Connection', 'close');
          res.on('finish', () => req.destroy());
          sendJson(res, 413, { ok: false, error: 'Payload too large' });
          return;
        }

        if (pathname === '/api/match/create') {
          const roomId = 'AT-' + randomBytes(6).toString('hex').toUpperCase();
          const mode: 'solo' | '1v1' =
            String(body.mode || '').toLowerCase() === 'solo' ? 'solo' : '1v1';
          const hostName = clip(body.hostName || body.p1Name || 'Player 1', 'Player 1', 64);
          const guestName = clip(
            body.guestName || body.p2Name || (mode === 'solo' ? 'Club AI' : 'Player 2'),
            mode === 'solo' ? 'Club AI' : 'Player 2',
            64,
          );
          const gamesToWin = Math.min(7, Math.max(1, Math.floor(Number(body.gamesToWin) || 2)));
          const newRoom = createRoomState(roomId, hostName, guestName, gamesToWin, mode);
          putRoom(roomId, newRoom);
          const urls = {
            hostDesktopUrl: `${baseUrl}/?room=${roomId}&role=p1`,
            guestDesktopUrl: `${baseUrl}/?room=${roomId}&role=p2`,
            p1PhoneUrl: `${baseUrl}/companion.html?room=${roomId}&role=p1`,
            p2PhoneUrl: `${baseUrl}/companion.html?room=${roomId}&role=p2`,
            guestJoinHubUrl: `${baseUrl}/join.html?room=${roomId}&role=p2`,
          };
          sendJson(res, 200, {
            ok: true,
            roomId,
            mode,
            tunnelUrl: baseUrl,
            ...urls,
            urls,
          });
          return;
        }

        const targetRoomCode = normalizeRoomCode(body.room || queryRoom);
        if (targetRoomCode === 'default') {
          sendJson(res, 400, { ok: false, error: 'Create or join a session room first' });
          return;
        }
        const room = getOrRestoreSessionRoom(targetRoomCode);
        if (!room) {
          sendJson(res, 404, { ok: false, error: 'Room not found' });
          return;
        }

        const bodyRoleRaw = String(body.role || queryRole || 'p1').toLowerCase();
        const role: 'p1' | 'p2' =
          bodyRoleRaw === 'p2' || bodyRoleRaw === '2' || bodyRoleRaw === 'opponent' ? 'p2' : 'p1';
        const racket = room.rackets[role];

        if (pathname === '/api/racket/swing') {
          const now = Date.now();
          racket.seq += 1;
          racket.lastSeenTs = now;
          racket.connected = true;
          const swing: SwingEvent = {
            seq: racket.seq,
            role: racket.role,
            type: String(body.type || 'swing').toLowerCase() === 'toss' ? 'toss' : 'swing',
            side: body.side ? clip(body.side, '', 16).toLowerCase() : null,
            shotType: clip(body.shotType || 'topspin', 'topspin').toLowerCase(),
            speed: Number(body.speed ?? 1),
            angleX: Number(body.angleX ?? body.dirX ?? 0),
            dirX: Number(body.angleX ?? body.dirX ?? 0),
            dirY: Number(body.dirY ?? 0),
            pitch: Number(body.pitch ?? racket.orientation.pitch ?? 0),
            roll: Number(body.roll ?? racket.orientation.roll ?? 0),
            yaw: Number(body.yaw ?? racket.orientation.yaw ?? 0),
            timestamp: Number(body.timestamp ?? now),
            serverTimeMs: now,
            source: clip(body.source || 'phone', 'phone'),
          };
          racket.lastSwing = swing;
          racket.swingHistory.push(swing);
          if (racket.swingHistory.length > 50) racket.swingHistory.shift();
          sendJson(res, 200, {
            ok: true,
            roomId: room.roomId,
            role: racket.role,
            swing,
          });
          return;
        }

        if (pathname === '/api/racket/telemetry') {
          racket.lastSeenTs = Date.now();
          racket.connected = Boolean(body.connected ?? true);
          racket.orientation = {
            pitch: Number(body.pitch ?? racket.orientation.pitch ?? 0),
            roll: Number(body.roll ?? racket.orientation.roll ?? 0),
            yaw: Number(body.yaw ?? racket.orientation.yaw ?? 0),
            accelMag: Number(body.accelMag ?? 0),
            buttonB: Boolean(body.buttonB ?? false),
            connected: racket.connected,
          };
          sendJson(res, 200, {
            ok: true,
            roomId: room.roomId,
            role: racket.role,
            orientation: racket.orientation,
            lastFeedback: racket.lastFeedback,
          });
          return;
        }

        if (pathname === '/api/racket/feedback') {
          racket.feedbackSeq += 1;
          racket.lastFeedback = {
            seq: racket.feedbackSeq,
            role: racket.role,
            kind: clip(body.kind || 'hit', 'hit'),
            grade: clip(body.grade || 'PERFECT', 'PERFECT'),
            shotType: clip(body.shotType || 'TOPSPIN', 'TOPSPIN'),
            speedKmh: Number(body.speedKmh ?? 160),
            intensity: Number(body.intensity ?? 1),
            serverTimeMs: Date.now(),
          };
          sendJson(res, 200, {
            ok: true,
            roomId: room.roomId,
            feedback: racket.lastFeedback,
          });
          return;
        }

        if (pathname === '/api/match/sync') {
          room.stateSeq += 1;
          room.p1DesktopSeenTs = Date.now();
          const snap =
            body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : body;
          room.matchSnapshot = {
            ...snap,
            seq: room.stateSeq,
            serverTimeMs: Date.now(),
          };
          sendJson(res, 200, {
            ok: true,
            roomId: room.roomId,
            seq: room.stateSeq,
            p2Racket: serializeRacket(room.rackets.p2),
          });
          return;
        }
      }

      next();
    });
  };

  return {
    name: 'argon-tennis-relay',
    configureServer(server: any) {
      attachMiddleware(server.middlewares);
    },
    configurePreviewServer(server: any) {
      attachMiddleware(server.middlewares);
    },
  };
}

export default defineConfig(({ mode }) => {
  loadEnv(mode, '.', '');
  return {
    server: {
      port: 3000,
      host: '0.0.0.0',
      allowedHosts: true,
      hmr: process.env.DISABLE_HMR !== 'true',
    },
    preview: {
      port: 3000,
      host: '0.0.0.0',
      allowedHosts: true,
    },
    plugins: [react(), argonTennisRelayPlugin()],
    resolve: {
      alias: {
        '../assets/vendor/GLTFLoader.js': 'three/examples/jsm/loaders/GLTFLoader.js',
        '@': path.resolve('.'),
      },
    },
  };
});
