import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { createClient } from "@supabase/supabase-js";
import pino from "pino";
import QRCode from "qrcode";
import qrcodeTerminal from "qrcode-terminal";
import {
  buildMessage,
  buildWaitlistMessage,
  formatDateTime,
  normalizeUruguayPhone,
  phoneToJid,
} from "./templates.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

// ─────────────────────────────────────────────────────────────────────────────
// 1. Carga de variables de entorno (.env)
// ─────────────────────────────────────────────────────────────────────────────
function loadEnvFile() {
  const envPath = path.join(ROOT_DIR, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnvFile();

const PORT = Number(process.env.PORT || 3005);
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const PUBLIC_APP_URL = (
  process.env.PUBLIC_APP_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  "https://onyx-agenda-uy.vercel.app"
).replace(/\/+$/, "");
const PANEL_PASSWORD = (process.env.PANEL_PASSWORD || "").trim(); // Opcional para proteger en la nube
const SELF_PING_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_PING_URL || "";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en las variables de entorno");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Respaldo de Sesión y Estado en Supabase Storage (Soporte Nube 24/7)
//    Permite que si el servidor gratuito en la nube se reinicia, NO pierda el QR
// ─────────────────────────────────────────────────────────────────────────────
const STORAGE_BUCKET = "whatsapp-pc-vault";
const DATA_DIR = path.join(ROOT_DIR, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const AUTH_DIR = path.join(ROOT_DIR, "auth_session");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const CLOUD_BACKUP_DEBOUNCE_MS = 3500;
const uploadedAuthSignatures = new Map();

function getFileSignature(filePath) {
  const stat = fs.statSync(filePath);
  return `${stat.size}:${stat.mtimeMs}`;
}

async function listVaultFiles() {
  const files = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase.storage
      .from(STORAGE_BUCKET)
      .list("", { limit: pageSize, offset });
    if (error || !data?.length) break;
    for (const item of data) {
      if (item?.name && item.name.endsWith(".json")) {
        files.push(item.name);
      }
    }
    if (data.length < pageSize) break;
    offset += data.length;
  }
  return files;
}

async function ensureStorageBucket() {
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    if (!buckets?.some((b) => b.id === STORAGE_BUCKET)) {
      await supabase.storage.createBucket(STORAGE_BUCKET, { public: false });
    }
  } catch (err) {
    console.warn("⚠️ No se pudo verificar bucket en Supabase Storage:", err?.message || err);
  }
}

async function restoreCloudVault() {
  try {
    await ensureStorageBucket();
    // Restaurar state.json si no existe localmente
    if (!fs.existsSync(STATE_FILE)) {
      const { data } = await supabase.storage.from(STORAGE_BUCKET).download("state.json");
      if (data) {
        const text = await data.text();
        fs.writeFileSync(STATE_FILE, text, "utf8");
        console.log("☁️ Estado restaurado desde la nube.");
      }
    }
    // Restaurar todos los archivos de sesión y llaves Signal de WhatsApp (creds, session-*, pre-key-*, sender-key-*)
    const vaultFiles = await listVaultFiles();
    const authFiles = vaultFiles.filter((name) => name !== "state.json");
    let restoredCount = 0;
    const concurrency = 8;
    for (let i = 0; i < authFiles.length; i += concurrency) {
      const batch = authFiles.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (fileName) => {
          const safeName = path.basename(fileName);
          if (safeName !== fileName) return;
          const targetPath = path.join(AUTH_DIR, safeName);
          if (fs.existsSync(targetPath)) {
            try {
              uploadedAuthSignatures.set(safeName, getFileSignature(targetPath));
            } catch {}
            return;
          }
          try {
            const { data } = await supabase.storage.from(STORAGE_BUCKET).download(safeName);
            if (data) {
              const buf = Buffer.from(await data.arrayBuffer());
              fs.writeFileSync(targetPath, buf);
              uploadedAuthSignatures.set(safeName, getFileSignature(targetPath));
              restoredCount += 1;
            }
          } catch {}
        })
      );
    }
    if (restoredCount > 0) {
      console.log(`☁️ Sesión y llaves Signal restauradas desde la nube (${restoredCount} archivos, sin re-escanear QR).`);
    }
  } catch (err) {
    console.warn("⚠️ Error restaurando respaldo desde la nube:", err?.message || err);
  }
}

let cloudBackupTimer = null;
let cloudBackupInFlight = false;
let cloudBackupPending = false;
let cloudBackupPromise = null;
let shuttingDown = false;

async function runCloudBackup() {
  if (cloudBackupInFlight) {
    cloudBackupPending = true;
    return cloudBackupPromise;
  }
  cloudBackupInFlight = true;
  cloudBackupPromise = (async () => {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const buf = fs.readFileSync(STATE_FILE);
        await supabase.storage.from(STORAGE_BUCKET).upload("state.json", buf, {
          upsert: true,
          contentType: "application/json",
        });
      }

      if (fs.existsSync(AUTH_DIR)) {
        const diskFiles = fs.readdirSync(AUTH_DIR).filter((name) => name.endsWith(".json"));
        const toUpload = [];
        for (const fileName of diskFiles) {
          const filePath = path.join(AUTH_DIR, fileName);
          try {
            const sig = getFileSignature(filePath);
            if (uploadedAuthSignatures.get(fileName) !== sig) {
              toUpload.push({ fileName, filePath, sig });
            }
          } catch {}
        }

        const concurrency = 6;
        for (let i = 0; i < toUpload.length; i += concurrency) {
          const batch = toUpload.slice(i, i + concurrency);
          await Promise.all(
            batch.map(async ({ fileName, filePath, sig }) => {
              try {
                const buf = fs.readFileSync(filePath);
                const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(fileName, buf, {
                  upsert: true,
                  contentType: "application/json",
                });
                if (!error) {
                  uploadedAuthSignatures.set(fileName, sig);
                }
              } catch {}
            })
          );
        }
      }
    } catch (err) {
      console.warn("⚠️ Error respaldando sesión en la nube:", err?.message || err);
    } finally {
      cloudBackupInFlight = false;
      cloudBackupPromise = null;
      if (cloudBackupPending && !shuttingDown) {
        cloudBackupPending = false;
        scheduleCloudBackup();
      }
    }
  })();
  return cloudBackupPromise;
}

function scheduleCloudBackup() {
  if (shuttingDown) return;
  if (cloudBackupTimer) clearTimeout(cloudBackupTimer);
  cloudBackupTimer = setTimeout(() => {
    cloudBackupTimer = null;
    void runCloudBackup();
  }, CLOUD_BACKUP_DEBOUNCE_MS);
}

async function flushCloudBackup() {
  if (cloudBackupTimer) {
    clearTimeout(cloudBackupTimer);
    cloudBackupTimer = null;
    cloudBackupPending = true;
  }
  saveState();
  if (cloudBackupTimer) {
    clearTimeout(cloudBackupTimer);
    cloudBackupTimer = null;
    cloudBackupPending = true;
  }
  while (cloudBackupInFlight || cloudBackupPending) {
    if (cloudBackupPromise) {
      await cloudBackupPromise.catch(() => {});
    } else if (cloudBackupPending) {
      cloudBackupPending = false;
      await runCloudBackup();
    }
  }
}

async function clearCloudSession() {
  try {
    if (cloudBackupTimer) {
      clearTimeout(cloudBackupTimer);
      cloudBackupTimer = null;
    }
    cloudBackupPending = false;
    uploadedAuthSignatures.clear();
    sentMessagesCache.clear();
    const vaultFiles = await listVaultFiles();
    const authFiles = vaultFiles.filter((name) => name !== "state.json");
    for (let i = 0; i < authFiles.length; i += 100) {
      await supabase.storage.from(STORAGE_BUCKET).remove(authFiles.slice(i, i + 100));
    }
  } catch (err) {
    console.warn("⚠️ Error limpiando sesión en la nube:", err?.message || err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Estado Persistente
// ─────────────────────────────────────────────────────────────────────────────
const defaultState = {
  settings: {
    sendConfirmations: true,
    sendReminders: true,
    sendReminder1m: true,
  },
  sentKeys: {},
  optOutPhones: [],
  history: [],
};

let state = structuredClone(defaultState);

function loadStateFromDisk() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
      state = {
        ...defaultState,
        ...parsed,
        settings: {
          ...defaultState.settings,
          ...(parsed.settings || {}),
          sendConfirmations: parsed.settings?.sendConfirmations ?? defaultState.settings.sendConfirmations,
          sendReminders: parsed.settings?.sendReminders ?? defaultState.settings.sendReminders,
        },
      };
    }
  } catch (e) {
    console.warn("⚠️ No se pudo leer state.json, iniciando limpio:", e.message);
  }
}

function saveState() {
  try {
    if (state.history.length > 150) {
      state.history = state.history.slice(0, 150);
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
    scheduleCloudBackup();
  } catch (e) {
    console.error("⚠️ Error guardando state.json:", e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Cola de envío con Protección Anti-Ban (simulación de escritura + pausas)
// ─────────────────────────────────────────────────────────────────────────────
let sock = null;
let connectionStatus = "starting";
let currentQrDataUrl = null;
let connectedPhone = null;
let cachedBarber = null;
let cachedBarbers = new Map();
let cachedAppointments = [];
let cachedWaitlist = [];
let sendQueue = Promise.resolve();
let reconnectTimer = null;
let startingWhatsApp = false;
const inFlightKeys = new Set();

function getBusinessTodayIso(timeZone = "America/Montevideo") {
  const opts = { timeZone: timeZone || "America/Montevideo", year: "numeric", month: "2-digit", day: "2-digit" };
  try {
    return new Intl.DateTimeFormat("en-CA", opts).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Montevideo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }
}

async function sendTrackedKey(key, fn) {
  if (state.sentKeys[key] || inFlightKeys.has(key)) return { skipped: true };
  inFlightKeys.add(key);
  try {
    const value = await fn();
    state.sentKeys[key] = new Date().toISOString();
    saveState();
    return { skipped: false, value };
  } catch (err) {
    delete state.sentKeys[key];
    throw err;
  } finally {
    inFlightKeys.delete(key);
  }
}

const MAX_SENT_MESSAGES_CACHE = 200;
const sentMessagesCache = new Map();

function cacheSentMessage(sentMsg) {
  const id = sentMsg?.key?.id;
  const message = sentMsg?.message;
  if (!id || !message) return;
  if (sentMessagesCache.has(id)) sentMessagesCache.delete(id);
  sentMessagesCache.set(id, message);
  while (sentMessagesCache.size > MAX_SENT_MESSAGES_CACHE) {
    const oldestKey = sentMessagesCache.keys().next().value;
    sentMessagesCache.delete(oldestKey);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function enqueueWhatsAppSend({ phone, text, meta = {}, quota }) {
  const task = async () => {
    if (connectionStatus !== "connected" || !sock) {
      throw new Error("WhatsApp no está conectado en este momento");
    }
    const jid = phoneToJid(phone);
    if (!jid) {
      throw new Error(`Número inválido: ${phone}`);
    }

    const [result] = await sock.onWhatsApp(jid.replace("@s.whatsapp.net", ""));
    const targetJid = result?.jid || jid;
    if (result && result.exists === false) {
      throw new Error(`El número ${phone} no tiene cuenta activa de WhatsApp`);
    }

    try {
      await sock.presenceSubscribe(targetJid);
      await sock.sendPresenceUpdate("composing", targetJid);
      await sleep(randomBetween(2000, 3800));
      await sock.sendPresenceUpdate("paused", targetJid);
    } catch {
      await sleep(1500);
    }

    if (quota) {
      const { data: decision, error } = await supabase.rpc("onyx_reserve_whatsapp_message", quota);
      if (error) throw new Error("No se pudo verificar el cupo de WhatsApp");
      if (decision === "limit") throw new Error("Cupo mensual de WhatsApp alcanzado");
      if (decision === "inactive") throw new Error("La barbería tiene los mensajes desactivados");
      if (decision !== "reserved") throw new Error("El mensaje ya fue reservado o no pertenece a este profesional");
    }

    try {
      await sock.assertSessions([targetJid], true);
    } catch {}

    const sentMsg = await sock.sendMessage(targetJid, { text });
    cacheSentMessage(sentMsg);
    scheduleCloudBackup();
    const messageId = sentMsg?.key?.id || `local-${Date.now()}`;

    if (meta.kind === "staff_booking_alert") {
      await sleep(randomBetween(4000, 8000));
      return messageId;
    }

    const entry = {
      id: messageId,
      phone: normalizeUruguayPhone(phone),
      clientName: meta.clientName || "Cliente",
      kind: meta.kind || "manual",
      appointmentId: meta.appointmentId || null,
      status: "sent",
      sentAt: new Date().toISOString(),
      preview: text.slice(0, 140),
    };
    state.history.unshift(entry);
    saveState();

    console.log(`✅ [WhatsApp Enviado] -> ${entry.clientName} (${entry.phone}) [${entry.kind}]`);

    await sleep(randomBetween(4000, 8000));
    return messageId;
  };

  const chained = sendQueue.then(task);
  sendQueue = chained.catch(() => {});
  return chained;
}

function sendAppointment(appointment, kind, barber) {
  return enqueueWhatsAppSend({
    phone: appointment.client_phone,
    text: buildMessage(kind, appointment, barber, PUBLIC_APP_URL),
    meta: { clientName: appointment.client_name, kind, appointmentId: appointment.id },
    quota: {
      p_barber_id: appointment.barber_id,
      p_member_id: appointment.member_id,
      p_key: `${appointment.id}:${kind}:${appointment.start_at}`,
      p_appointment_id: appointment.id,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Conexión Baileys (WhatsApp Web Multi-Device)
// ─────────────────────────────────────────────────────────────────────────────
function scheduleWhatsAppReconnect(delayMs) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startWhatsApp();
  }, delayMs);
}

async function startWhatsApp() {
  if (startingWhatsApp) return;
  startingWhatsApp = true;
  try {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (sock) {
      try {
        sock.ev.removeAllListeners();
        sock.end?.(undefined);
      } catch {}
      sock = null;
    }

    const baileysLogger = pino({ level: "silent" });
    const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const originalKeysSet = authState.keys.set.bind(authState.keys);
    authState.keys.set = async (data) => {
      await originalKeysSet(data);
      scheduleCloudBackup();
    };

    let version = [2, 3000, 1015901307];
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch {}

    sock = makeWASocket({
      version,
      auth: {
        creds: authState.creds,
        keys: makeCacheableSignalKeyStore(authState.keys, baileysLogger),
      },
      logger: baileysLogger,
      printQRInTerminal: false,
      browser: ["Onyx BarberFlow Cloud", "Chrome", "122.0.0"],
      syncFullHistory: false,
      markOnlineOnConnect: false,
      getMessage: async (key) => {
        if (!key?.id) return undefined;
        return sentMessagesCache.get(key.id) || undefined;
      },
    });

    sock.ev.on("creds.update", async () => {
      try {
        await saveCreds();
        scheduleCloudBackup();
      } catch (err) {
        console.warn("⚠️ Error guardando credenciales de Baileys:", err?.message || err);
      }
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        connectionStatus = "qr";
        try {
          currentQrDataUrl = await QRCode.toDataURL(qr, { margin: 2, width: 320 });
        } catch (err) {
          console.warn("⚠️ No se pudo renderizar QR en DataURL:", err?.message || err);
        }
        console.log("\n══════════════════════════════════════════════════════════════");
        console.log("📱 ESCANEA ESTE CÓDIGO QR CON EL WHATSAPP DE TU NÚMERO NUEVO");
        console.log("   (O desde el panel web en el puerto " + PORT + ")");
        console.log("══════════════════════════════════════════════════════════════\n");
        qrcodeTerminal.generate(qr, { small: true });
      }

      if (connection === "open") {
        connectionStatus = "connected";
        currentQrDataUrl = null;
        connectedPhone = sock?.user?.id ? sock.user.id.split(":")[0].split("@")[0] : "Conectado";
        console.log(`\n🟢 ¡WHATSAPP CONECTADO CON ÉXITO! Número activo: +${connectedPhone}`);
        scheduleCloudBackup();
        void syncWithSupabase();
      }

      if (connection === "close") {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        connectedPhone = null;

        if (loggedOut) {
          console.log("🔴 Sesión cerrada desde el celular. Limpiando credenciales para generar nuevo QR...");
          connectionStatus = "qr";
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            fs.mkdirSync(AUTH_DIR, { recursive: true });
          } catch {}
          await clearCloudSession();
          scheduleWhatsAppReconnect(2000);
        } else {
          connectionStatus = "reconnecting";
          console.log("🔄 Reconectando con WhatsApp en 4 segundos...");
          scheduleWhatsAppReconnect(4000);
        }
      }
    });

    sock.ev.on("messages.update", async (updates) => {
      for (const u of updates) {
        const msgId = u.key?.id;
        const rawStatus = u.update?.status;
        if (!msgId || !rawStatus) continue;
        const mapped = rawStatus === 4 || rawStatus === 5 ? "read" : rawStatus === 3 ? "delivered" : null;
        if (!mapped) continue;

        const hist = state.history.find((h) => h.id === msgId);
        if (hist) {
          hist.status = mapped;
          saveState();
        }

        try {
          await supabase
            .from("notification_jobs")
            .update({ delivery_status: mapped })
            .eq("provider_id", msgId)
            .eq("channel", "whatsapp");
        } catch {}
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const msg of messages) {
        if (msg.key.fromMe) continue;
        const senderJid = msg.key.remoteJid || "";
        if (!senderJid.endsWith("@s.whatsapp.net")) continue;
        const fromPhone = normalizeUruguayPhone(senderJid.split("@")[0]);
        const text = (
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text ||
          ""
        )
          .trim()
          .toUpperCase();

        if (["BAJA", "STOP", "CANCELAR RECORDATORIOS"].includes(text)) {
          if (!state.optOutPhones.includes(fromPhone)) {
            state.optOutPhones.push(fromPhone);
            saveState();
          }
          try {
            await supabase
              .from("appointments")
              .update({ whatsapp_opt_in: false })
              .eq("client_phone", fromPhone)
              .eq("status", "confirmed");
          } catch (err) {
            console.warn("⚠️ Error actualizando opt-out en Supabase:", err?.message || err);
          }
          console.log(`🔕 Cliente ${fromPhone} solicitó BAJA de recordatorios.`);
          try {
            await enqueueWhatsAppSend({
              phone: fromPhone,
              text: "✅ Hemos desactivado los recordatorios automáticos por WhatsApp para tu número. ¡Gracias!",
              meta: { clientName: "Baja automática", kind: "opt_out" },
            });
          } catch {}
        }
      }
    });
  } catch (err) {
    console.error("⚠️ Error iniciando Baileys, reintentando en 5 segundos:", err?.message || err);
    connectionStatus = "reconnecting";
    scheduleWhatsAppReconnect(5000);
  } finally {
    startingWhatsApp = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Sincronización con Supabase
// ─────────────────────────────────────────────────────────────────────────────
function isOptedOut(phone) {
  const norm = normalizeUruguayPhone(phone);
  return state.optOutPhones.includes(norm);
}

async function syncJobToSupabase(appointment, kind, providerId, errorMsg = null) {
  try {
    const { data: existing } = await supabase
      .from("notification_jobs")
      .select("id")
      .eq("appointment_id", appointment.id)
      .eq("appointment_start_at", appointment.start_at)
      .eq("channel", "whatsapp")
      .maybeSingle();

    const payload = {
      barber_id: appointment.barber_id,
      appointment_id: appointment.id,
      appointment_start_at: appointment.start_at,
      revision: appointment.notification_revision || 0,
      channel: "whatsapp",
      kind: "reminder",
      scheduled_at: new Date().toISOString(),
      status: errorMsg ? "failed" : "sent",
      provider_id: providerId || null,
      delivery_status: errorMsg ? "failed" : "sent",
      last_error: errorMsg || null,
      sent_at: errorMsg ? null : new Date().toISOString(),
      lease_until: null,
    };

    if (existing?.id) {
      await supabase.from("notification_jobs").update(payload).eq("id", existing.id);
    } else {
      await supabase.from("notification_jobs").insert(payload);
    }
  } catch {}
}

let syncing = false;

async function dispatchStaffBookingAlerts() {
  for (let i = 0; i < 3 && connectionStatus === "connected" && sock; i++) {
    const { data: jobs, error } = await supabase.rpc("onyx_claim_staff_booking_alert");
    if (error) throw error;
    const job = jobs?.[0];
    if (!job) return;

    let sent = false;
    try {
      const { dateStr, timeStr } = formatDateTime(job.start_at, job.timezone);
      const singleLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
      await enqueueWhatsAppSend({
        phone: job.phone,
        text: [
          "✂️ *Nueva reserva en tu agenda*",
          `*Cliente:* ${singleLine(job.client_name)}`,
          `*Servicio:* ${singleLine(job.service_name)}`,
          `*Día:* ${dateStr}\n*Hora:* ${timeStr}`,
          "*Ver mi agenda en Onyx*\nhttps://onyx-agenda-uy.vercel.app/admin",
        ].join("\n\n"),
        meta: { kind: "staff_booking_alert" },
      });
      sent = true;
    } catch {
      console.warn("⚠️ No se pudo enviar un aviso interno de reserva.");
    }

    const { error: finishError } = await supabase.rpc("onyx_finish_staff_booking_alert", {
      p_appointment_id: job.appointment_id,
      p_sent: sent,
    });
    if (finishError) throw finishError;
  }
}

async function getOrFetchBarber(barberId) {
  if (!barberId) return null;
  if (cachedBarbers.has(barberId)) return cachedBarbers.get(barberId);
  try {
    const { data: b } = await supabase.from("barbers").select("*").eq("id", barberId).maybeSingle();
    if (b) {
      cachedBarbers.set(b.id, b);
      return b;
    }
  } catch {}
  return null;
}

async function syncWithSupabase() {
  if (syncing) return;
  syncing = true;
  try {
    try {
      await dispatchStaffBookingAlerts();
    } catch (error) {
      console.error("⚠️ Falló la sincronización de avisos internos:", error.code || "unknown");
    }
    const { data: barbers, error } = await supabase.from("barbers").select("*")
      .eq("onboarding_completed", true)
      .order("created_at", { ascending: true });
    if (error) throw error;
    cachedBarbers = new Map(barbers.map((barber) => [barber.id, barber]));
    cachedBarber = barbers[0] ?? null;
    cachedAppointments = [];
    cachedWaitlist = [];
    for (const barber of barbers) {
      if (!barber.whatsapp_reminders_enabled) continue;
      try {
        await syncBarber(barber);
      } catch (error) {
        console.error(`⚠️ Falló la sincronización de la barbería ${barber.name || barber.id}:`, error.message);
      }
    }
  } catch (error) {
    console.error("⚠️ Error en ciclo de sincronización:", error.message);
  } finally {
    syncing = false;
  }
}

async function syncBarber(barber) {
    const fromIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const toIso = new Date(Date.now() + 60 * 24 * 3600 * 1000).toISOString();

    const { data: appointments, error } = await supabase
      .from("appointments")
      .select("*")
      .eq("barber_id", barber.id)
      .gte("start_at", fromIso)
      .lte("start_at", toIso)
      .order("start_at", { ascending: true });

    if (error || !appointments) return;
    cachedAppointments.push(...appointments);

    const todayIso = getBusinessTodayIso(barber.timezone);
    const { data: waitlist } = await supabase
      .from("waitlist")
      .select("*")
      .eq("barber_id", barber.id)
      .gte("date", todayIso)
      .in("status", ["waiting", "notified"])
      .order("created_at", { ascending: true });
    cachedWaitlist.push(...(waitlist || []));

    if (connectionStatus !== "connected") return;

    const now = Date.now();

    for (const a of appointments) {
      if (a.status !== "confirmed") continue;
      const clientOptOut = isOptedOut(a.client_phone) || !a.whatsapp_opt_in;
      if (clientOptOut || !a.client_phone) continue;

      const startMs = new Date(a.start_at).getTime();
      const minsUntilStart = (startMs - now) / 60000;
      const createdMs = a.created_at ? new Date(a.created_at).getTime() : 0;
      const apptBarber = (await getOrFetchBarber(a.barber_id)) || barber;

      // 1. Confirmación inmediata al agendar (reserva reciente en las últimas 24h y a futuro)
      const confKey = `${a.id}:confirmation`;
      if (
        state.settings.sendConfirmations &&
        startMs > now &&
        createdMs > 0 &&
        (now - createdMs) < 24 * 3600 * 1000 &&
        !state.sentKeys[confKey]
      ) {
        try {
          console.log(`📨 [Confirmación WhatsApp] -> ${a.client_name} (${a.client_phone}) - ${apptBarber.name}`);
          await sendTrackedKey(confKey, () => sendAppointment(a, "confirmation", apptBarber));
        } catch (err) {
          console.error(`⚠️ Error enviando confirmación a ${a.client_name}:`, err.message);
        }
      }

      // 2. Recordatorio 2 horas antes (se envía entre 125 y 10 minutos antes)
      const remKey = `${a.id}:reminder:${a.start_at}`;
      if (
        state.settings.sendReminders &&
        minsUntilStart > 10 &&
        minsUntilStart <= 125 &&
        !state.sentKeys[remKey]
      ) {
        try {
          console.log(`⏰ [Recordatorio 2h WhatsApp] -> ${a.client_name} (${a.client_phone}) - ${apptBarber.name}`);
          const res = await sendTrackedKey(remKey, () => sendAppointment(a, "reminder", apptBarber));
          if (!res.skipped) {
            await supabase.from("notification_jobs")
              .update({ status: "sent", sent_at: new Date().toISOString(), provider_id: res.value, delivery_status: "sent", lease_until: null })
              .eq("appointment_id", a.id)
              .eq("channel", "whatsapp");
          }
        } catch (err) {
          console.error(`⚠️ Error enviando recordatorio 2h a ${a.client_name}:`, err.message);
        }
      }

      // 3. Recordatorio 1 minuto antes
      const rem1mKey = `${a.id}:reminder_1m:${a.start_at}`;
      if (
        state.settings.sendReminder1m &&
        minsUntilStart >= 0 &&
        minsUntilStart <= 1.5 &&
        !state.sentKeys[rem1mKey]
      ) {
        try {
          console.log(`⏱️ [Recordatorio 1m WhatsApp] -> ${a.client_name} (${a.client_phone}) - ${apptBarber.name}`);
          await sendTrackedKey(rem1mKey, () => sendAppointment(a, "reminder_1m", apptBarber));
        } catch (err) {
          console.error(`⚠️ Error enviando recordatorio 1m a ${a.client_name}:`, err.message);
        }
      }
    }

    if (state.settings.sendReminders) {
      const { data: claimedJobs, error: claimError } = await supabase.rpc("onyx_claim_whatsapp_jobs", { p_barber_id: barber.id });
      if (claimError) {
        console.error(`⚠️ Error al reclamar trabajos para ${barber.name}:`, claimError.message);
      } else {
        for (const job of claimedJobs || []) {
          let appt = appointments.find((x) => x.id === job.appointment_id);
          if (!appt && job.appointment_id) {
            const { data: fetchedAppt } = await supabase
              .from("appointments")
              .select("*")
              .eq("id", job.appointment_id)
              .maybeSingle();
            appt = fetchedAppt || undefined;
          }
          if (!appt || appt.status !== "confirmed" || !appt.whatsapp_opt_in || isOptedOut(appt.client_phone)
              || new Date(appt.start_at).getTime() !== new Date(job.appointment_start_at).getTime()) {
            await supabase.from("notification_jobs").update({ status: "cancelled", lease_until: null }).eq("id", job.id);
            continue;
          }
          const apptBarber = (await getOrFetchBarber(appt.barber_id)) || barber;

          const remKey = `${appt.id}:reminder:${appt.start_at}`;
          if (state.sentKeys[remKey]) {
            await supabase
              .from("notification_jobs")
              .update({ status: "sent", sent_at: new Date().toISOString(), lease_until: null })
              .eq("id", job.id);
            continue;
          }
          if (inFlightKeys.has(remKey)) continue;
          try {
            const res = await sendTrackedKey(remKey, () => sendAppointment(appt, "reminder", apptBarber));
            if (res.skipped) continue;
            await supabase
              .from("notification_jobs")
              .update({
                status: "sent",
                provider_id: res.value,
                delivery_status: "sent",
                sent_at: new Date().toISOString(),
                lease_until: null,
                last_error: null,
              })
              .eq("id", job.id);
          } catch (err) {
            await supabase
              .from("notification_jobs")
              .update({
                status: "failed",
                last_error: err.message,
                lease_until: null,
              })
              .eq("id", job.id);
          }
        }
      }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Servidor Web Local / Nube + Keep-Alive
// ─────────────────────────────────────────────────────────────────────────────
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function isAuthorized(req, url) {
  if (!PANEL_PASSWORD) return false;
  let parsedUrl = url;
  if (!parsedUrl) {
    try {
      parsedUrl = new URL(req.url || "/", `http://localhost:${PORT}`);
    } catch {
      return false;
    }
  }
  const headerVal = req.headers["x-panel-password"];
  const rawHeader = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  const provided = String(rawHeader || parsedUrl.searchParams.get("key") || "").trim();
  if (!provided) return false;
  const expectedBuf = Buffer.from(PANEL_PASSWORD, "utf8");
  const providedBuf = Buffer.from(provided, "utf8");
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url || "/", `http://localhost:${PORT}`);
  } catch {
    return sendJson(res, 400, { ok: false, error: "invalid_url" });
  }

  try {

  // Healthcheck público para mantener vivo el servidor en Render / Oracle / Railway
  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, status: connectionStatus, uptime: Math.floor(process.uptime()) });
  }

  if (req.method === "GET" && url.pathname === "/") {
    const htmlPath = path.join(__dirname, "public", "index.html");
    const html = fs.readFileSync(htmlPath, "utf8");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(html);
  }

  if (!isAuthorized(req, url)) {
    return sendJson(res, 401, { ok: false, error: "requires_password" });
  }

  if (req.method === "GET" && url.pathname === "/api/status") {
    const barbersList = Array.from(cachedBarbers.values()).map((b) => ({
      id: b.id,
      name: b.name,
      address: b.address,
      phone: b.phone,
    }));
    return sendJson(res, 200, {
      connectionStatus,
      qrDataUrl: currentQrDataUrl,
      connectedPhone,
      barber: cachedBarber
        ? { id: cachedBarber.id, name: cachedBarber.name, address: cachedBarber.address, timezone: cachedBarber.timezone }
        : null,
      barbers: barbersList,
      settings: state.settings,
      upcomingAppointments: cachedAppointments
        .filter((a) => a.status === "confirmed" && new Date(a.start_at).getTime() > Date.now() - 3600000)
        .map((a) => ({
          ...a,
          barber_id: a.barber_id,
          barber_name: cachedBarbers.get(a.barber_id)?.name || "Barbería",
        }))
        .slice(0, 50),
      waitlist: cachedWaitlist,
      history: state.history.slice(0, 40).map((h) => ({
        ...h,
        barber_name: h.barberId ? (cachedBarbers.get(h.barberId)?.name || h.barberName || "Barbería") : (h.barberName || undefined),
      })),
      optOutPhones: state.optOutPhones,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    try {
      const body = await readJsonBody(req);
      state.settings = {
        ...state.settings,
        sendConfirmations:
          body.sendConfirmations !== undefined
            ? Boolean(body.sendConfirmations)
            : state.settings.sendConfirmations,
        sendReminders:
          body.sendReminders !== undefined
            ? Boolean(body.sendReminders)
            : state.settings.sendReminders,
        sendReminder1m:
          body.sendReminder1m !== undefined
            ? Boolean(body.sendReminder1m)
            : state.settings.sendReminder1m,
      };
      saveState();
      return sendJson(res, 200, { ok: true, settings: state.settings });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/send-test") {
    try {
      const { phone, message } = await readJsonBody(req);
      if (!phone) return sendJson(res, 400, { ok: false, error: "Ingresa un número de teléfono" });
      const shop = cachedBarber?.name || "Onyx BarberFlow";
      const text =
        (message || "").trim() ||
        `¡Hola! 💈 Este es un mensaje de prueba automático desde *${shop}*.`;
      const msgId = await enqueueWhatsAppSend({
        phone,
        text,
        meta: { clientName: "Prueba Manual", kind: "test" },
      });
      return sendJson(res, 200, { ok: true, messageId: msgId });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/send-appointment") {
    try {
      const { appointmentId, kind = "reminder" } = await readJsonBody(req);
      let appt = cachedAppointments.find((a) => a.id === appointmentId);
      if (!appt && appointmentId) {
        const { data: fetched } = await supabase.from("appointments").select("*").eq("id", appointmentId).maybeSingle();
        appt = fetched || undefined;
      }
      if (!appt) return sendJson(res, 404, { ok: false, error: "Cita no encontrada" });
      if (!["reminder", "reminder_1m", "confirmation", "rescheduled", "cancelled"].includes(kind)) {
        return sendJson(res, 400, { ok: false, error: "Tipo de mensaje inválido" });
      }
      if (!appt.whatsapp_opt_in || isOptedOut(appt.client_phone)) {
        return sendJson(res, 409, { ok: false, error: "El cliente no autorizó mensajes" });
      }
      const barber = (await getOrFetchBarber(appt.barber_id)) || cachedBarber;
      const msgId = await sendAppointment(appt, kind, barber);
      state.sentKeys[`${appt.id}:${kind}:${appt.start_at}`] = new Date().toISOString();
      saveState();
      await syncJobToSupabase(appt, kind, msgId);
      return sendJson(res, 200, { ok: true, messageId: msgId });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/send-waitlist") {
    try {
      const { waitlistId, slotTime } = await readJsonBody(req);
      const entry = cachedWaitlist.find((w) => w.id === waitlistId);
      if (!entry) return sendJson(res, 404, { ok: false, error: "Registro no encontrado en lista de espera" });
      if (isOptedOut(entry.client_phone)) return sendJson(res, 409, { ok: false, error: "El cliente solicitó no recibir mensajes" });
      const b = (await getOrFetchBarber(entry.barber_id)) || cachedBarber;
      const text = buildWaitlistMessage(entry, slotTime, b, PUBLIC_APP_URL);
      const msgId = await enqueueWhatsAppSend({
        phone: entry.client_phone,
        text,
        meta: { clientName: entry.client_name, kind: "waitlist" },
        quota: { p_barber_id: entry.barber_id, p_member_id: entry.barber_id, p_key: `waitlist:${entry.id}` },
      });
      await supabase.from("waitlist").update({ status: "notified" }).eq("id", entry.id);
      await syncWithSupabase();
      return sendJson(res, 200, { ok: true, messageId: msgId });
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: e.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    try {
      if (sock) await sock.logout().catch(() => {});
    } catch {}
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    } catch {}
    await clearCloudSession();
    connectionStatus = "qr";
    connectedPhone = null;
    scheduleWhatsAppReconnect(1500);
    return sendJson(res, 200, { ok: true });
  }

  sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    console.warn("⚠️ Error no controlado en servidor HTTP del bot:", err?.message || err);
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: "internal_error" });
    }
  }
});

// Inicialización completa
(async () => {
  await restoreCloudVault();
  loadStateFromDisk();

  supabase
    .channel("onyx-pc-whatsapp")
    .on("postgres_changes", { event: "*", schema: "public", table: "appointments" }, () => {
      setTimeout(() => void syncWithSupabase(), 1500);
    })
    .subscribe();

  setInterval(() => void syncWithSupabase(), 20000);

  // Auto-ping cada 10 minutos si está alojado en Render u otro servidor cloud gratuito
  if (SELF_PING_URL) {
    setInterval(() => {
      fetch(`${SELF_PING_URL.replace(/\/$/, "")}/health`).catch(() => {});
    }, 10 * 60 * 1000);
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log("╔══════════════════════════════════════════════════════════════════╗");
    console.log("║     💈 ONYX WHATSAPP BOT — MOTOR OPEN SOURCE (PC & CLOUD 24/7)   ║");
    console.log("╠══════════════════════════════════════════════════════════════════╣");
    console.log(`║ 🖥️  Panel de Control: http://localhost:${PORT}                      ║`);
    console.log("║ ☁️  Respaldo automático de sesión QR en Supabase Storage activo  ║");
    console.log("╚══════════════════════════════════════════════════════════════════╝");
    void syncWithSupabase();
    void startWhatsApp();
  });
})();

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 Recibido ${signal}, guardando estado y respaldo antes de apagar...`);
  try {
    const hadPending = Boolean(cloudBackupTimer || cloudBackupInFlight || cloudBackupPending);
    if (hadPending) {
      await Promise.race([flushCloudBackup(), sleep(4500)]);
    } else {
      saveState();
      if (cloudBackupTimer) {
        clearTimeout(cloudBackupTimer);
        cloudBackupTimer = null;
      }
    }
  } catch (err) {
    console.warn("⚠️ Error durante el respaldo de apagado:", err?.message || err);
  }
  try {
    server.close();
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", () => void gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => void gracefulShutdown("SIGINT"));
