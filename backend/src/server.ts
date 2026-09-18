import "dotenv/config";
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { Server } from "socket.io";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "./firebase.js";
import type { HeartbeatInput, Journey } from "./types.js";

const app = express();
const server = http.createServer(app);
const webOrigin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const io = new Server(server, {
  cors: { origin: webOrigin },
});

const port = Number(process.env.PORT ?? 4000);
const checkIntervalMs = Number(process.env.DEAD_MAN_CHECK_INTERVAL_MS ?? 30_000);
const defaultGracePeriodMs = Number(process.env.ALERT_GRACE_PERIOD_MS ?? 300_000);
const shareTokenLifetimeMs = Number(process.env.SHARE_TOKEN_LIFETIME_MS ?? 24 * 60 * 60 * 1000);
const rateLimits = new Map<string, { windowStartedAt: number; failures: number }>();

app.use(cors({ origin: webOrigin }));
app.use(express.json());

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validHeartbeat(input: Partial<HeartbeatInput>) {
  return (
    typeof input.travelerId === "string" &&
    isFiniteCoordinate(input.latitude) &&
    input.latitude >= -90 &&
    input.latitude <= 90 &&
    isFiniteCoordinate(input.longitude) &&
    input.longitude >= -180 &&
    input.longitude <= 180
  );
}

function journeyIdFromRequest(req: Request) {
  const { journeyId } = req.params;
  return Array.isArray(journeyId) ? journeyId[0] : journeyId;
}

function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createToken() {
  return randomBytes(24).toString("base64url");
}

function clientKey(req: Request) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function allowShareAttempt(req: Request) {
  const now = Date.now();
  const key = clientKey(req);
  const state = rateLimits.get(key);
  if (!state || now - state.windowStartedAt >= 60_000) {
    rateLimits.set(key, { windowStartedAt: now, failures: 0 });
    return true;
  }
  return state.failures < 5;
}

function recordShareFailure(req: Request) {
  const key = clientKey(req);
  const state = rateLimits.get(key) ?? { windowStartedAt: Date.now(), failures: 0 };
  state.failures += 1;
  rateLimits.set(key, state);
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/journeys", async (req: Request, res: Response) => {
  const { travelerId, contactName, contactPhone, contactEmail, eta, gracePeriodMs, destination, duress } = req.body ?? {};
  const etaDate = new Date(eta);

  if (
    typeof travelerId !== "string" ||
    typeof contactName !== "string" ||
    !Number.isFinite(etaDate.getTime()) ||
    etaDate.getTime() <= Date.now() ||
    (contactPhone === undefined && contactEmail === undefined)
    || (destination !== undefined && (
      typeof destination.label !== "string" ||
      !isFiniteCoordinate(destination.latitude) ||
      destination.latitude < -90 ||
      destination.latitude > 90 ||
      !isFiniteCoordinate(destination.longitude) ||
      destination.longitude < -180 ||
      destination.longitude > 180
    ))
  ) {
    return res.status(400).json({ error: "travelerId, contactName, future eta, and a contact are required" });
  }

  const doc = db.collection("journeys").doc();
  const shareToken = createToken();
  const ownerToken = createToken();
  const journey: Journey = {
    id: doc.id,
    shareTokenHash: tokenHash(shareToken),
    ownerTokenHash: tokenHash(ownerToken),
    shareExpiresAt: new Date(Date.now() + shareTokenLifetimeMs).toISOString(),
    duress: duress === true,
    travelerId,
    contactName,
    eta: etaDate.toISOString(),
    gracePeriodMs: Number.isFinite(gracePeriodMs) ? Math.max(0, Number(gracePeriodMs)) : defaultGracePeriodMs,
    status: "active",
    lastHeartbeatAt: null,
    lastLocation: null,
    createdAt: new Date().toISOString(),
  };
  if (destination) journey.destination = destination;
  if (typeof contactPhone === "string") journey.contactPhone = contactPhone;
  if (typeof contactEmail === "string") journey.contactEmail = contactEmail;

  await doc.set(journey);
  return res.status(201).json({ ...journey, shareToken, ownerToken, shareTokenHash: undefined, ownerTokenHash: undefined });
});

app.get("/journeys/share/:shareToken", async (req: Request, res: Response) => {
  if (!allowShareAttempt(req)) return res.status(429).json({ error: "Too many share-code attempts. Try again later." });
  const shareToken = Array.isArray(req.params.shareToken) ? req.params.shareToken[0] : req.params.shareToken;
  if (!/^[A-Za-z0-9_-]{32}$/.test(shareToken)) {
    recordShareFailure(req);
    return res.status(404).json({ error: "Journey not found" });
  }
  const snapshot = await db.collection("journeys").where("shareTokenHash", "==", tokenHash(shareToken)).limit(1).get();
  if (snapshot.empty) {
    recordShareFailure(req);
    return res.status(404).json({ error: "Journey not found" });
  }
  const journey = snapshot.docs[0].data() as Journey;
  if (Date.now() >= new Date(journey.shareExpiresAt).getTime()) return res.status(404).json({ error: "Journey not found" });
  return res.json({
    id: journey.id,
    status: journey.status,
    duress: journey.duress,
    eta: journey.eta,
    destination: journey.destination ?? null,
    lastHeartbeatAt: journey.lastHeartbeatAt,
    lastLocation: journey.lastLocation,

    shareToken,
  });
});

app.post("/journeys/:journeyId/heartbeat", async (req: Request, res: Response) => {
  const input = req.body as Partial<HeartbeatInput>;
  if (!validHeartbeat(input)) return res.status(400).json({ error: "Invalid heartbeat coordinates or travelerId" });

  const journeyId = journeyIdFromRequest(req);
  const ref = db.collection("journeys").doc(journeyId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return res.status(404).json({ error: "Journey not found" });

  const journey = snapshot.data() as Journey;
  if (tokenHash(req.header("authorization")?.replace(/^Bearer\s+/, "") ?? "") !== journey.ownerTokenHash) {
    return res.status(403).json({ error: "Journey authorization required" });
  }
  if (journey.status !== "active") return res.status(409).json({ error: "Journey is no longer active" });

  const heartbeatAt = input.recordedAt && Number.isFinite(new Date(input.recordedAt).getTime())
    ? new Date(input.recordedAt).toISOString()
    : new Date().toISOString();
  const location = { latitude: input.latitude, longitude: input.longitude, accuracy: input.accuracy };
  await ref.update({ lastHeartbeatAt: heartbeatAt, lastLocation: location, updatedAt: FieldValue.serverTimestamp() });

  io.to(journeyId).emit("journey:heartbeat", { journeyId, heartbeatAt, location });
  return res.json({ ok: true, heartbeatAt });
});

app.post("/journeys/:journeyId/complete", async (req: Request, res: Response) => {
  const journeyId = journeyIdFromRequest(req);
  const ref = db.collection("journeys").doc(journeyId);
  const snapshot = await ref.get();
  if (!snapshot.exists) return res.status(404).json({ error: "Journey not found" });
  const journey = snapshot.data() as Journey;
  if (tokenHash(req.header("authorization")?.replace(/^Bearer\s+/, "") ?? "") !== journey.ownerTokenHash) return res.status(403).json({ error: "Journey authorization required" });
  if (snapshot.data()?.status === "completed") return res.json({ ok: true });
  await ref.update({ status: "completed", completedAt: FieldValue.serverTimestamp() });
  io.to(journeyId).emit("journey:completed", { journeyId });
  return res.json({ ok: true });
});

io.on("connection", (socket) => {
  socket.on("journey:join", async (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const { journeyId, token } = payload as { journeyId?: unknown; token?: unknown };
    if (typeof journeyId !== "string" || typeof token !== "string") return;
    const snapshot = await db.collection("journeys").doc(journeyId).get();
    const journey = snapshot.data() as Journey | undefined;
    if (journey && tokenHash(token) === journey.ownerTokenHash) socket.join(journeyId);
  });
  socket.on("journey:leave", (journeyId: unknown) => {
    if (typeof journeyId === "string") socket.leave(journeyId);
  });
});

async function sendAlert(journey: Journey) {
  console.warn(`[DEAD_MAN_ALERT] Journey ${journey.id} for ${journey.contactName} requires attention`, {
    contactPhone: journey.contactPhone,
    contactEmail: journey.contactEmail,
    lastLocation: journey.lastLocation,
  });
  io.to(journey.id).emit("journey:alert", { journeyId: journey.id, reason: "ETA expired without a recent heartbeat" });
}

async function checkDeadMansSwitch() {
  const snapshot = await db.collection("journeys").where("status", "==", "active").get();
  const now = Date.now();

  await Promise.all(snapshot.docs.map(async (doc) => {
    const journey = doc.data() as Journey;
    const expiry = new Date(journey.eta).getTime() + journey.gracePeriodMs;
    const lastHeartbeat = journey.lastHeartbeatAt ? new Date(journey.lastHeartbeatAt).getTime() : 0;
    if (now <= expiry || lastHeartbeat >= expiry) return;

    await doc.ref.update({ status: "alerted", alertedAt: new Date().toISOString() });
    await sendAlert(journey);
  }));
}

setInterval(() => void checkDeadMansSwitch().catch((error) => console.error("Dead man's switch check failed", error)), checkIntervalMs);

app.use((error: unknown, _req: Request, res: Response, _next: (error?: unknown) => void) => {
  void _next;
  console.error("Request failed", error);
  res.status(500).json({ error: "The backend could not complete that request." });
});

server.listen(port, () => {
  console.log(`Journey backend listening on http://localhost:${port}`);
});
