const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

dotenv.config();
const app = express();
const PORT = Number(process.env.PORT || 3000);
const MOCK_MODE = String(process.env.MOCK_MODE || "true").toLowerCase() === "true";
const SASPAY_BASE = String(process.env.SASPAY_BASE_URL || "https://api.saspay.me").replace(/\/$/, "");

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const dataDir = path.join(__dirname, "data");
const usersFile = path.join(dataDir, "users.json");
const ordersFile = path.join(dataDir, "orders.json");
const transfersFile = path.join(dataDir, "transfers.json");
fs.mkdirSync(dataDir, { recursive: true });
for (const [file, fallback] of [[usersFile, []], [ordersFile, []], [transfersFile, []]]) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
}

function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }
function normalizeCI(phone) { let p = String(phone || "").replace(/\s+/g, ""); if (p.startsWith("+225")) p = p.slice(4); if (p.startsWith("225")) p = p.slice(3); return p; }
function validCI(phone) { return /^(05|07|01)\d{8}$/.test(normalizeCI(phone)); }
function fullCI(phone) { return `+225${normalizeCI(phone)}`; }
const NETWORKS = ["orange_ci", "mtn_ci", "moov_ci", "wave_ci"];
const otpStore = new Map();
const sessions = new Map();

async function saspay(pathname, options = {}) {
  const key = process.env.SASPAY_API_KEY;
  if (!key) throw new Error("SasPay n'est pas configuré côté serveur.");
  const response = await fetch(`${SASPAY_BASE}${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json", ...(options.headers || {}) }
  });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`SasPay ${response.status}: ${body.message || text}`);
  return body;
}

async function infobipSendOtp(phone) {
  const base = process.env.INFOBIP_BASE_URL, key = process.env.INFOBIP_API_KEY;
  const applicationId = process.env.INFOBIP_2FA_APPLICATION_ID, messageId = process.env.INFOBIP_2FA_MESSAGE_ID;
  if (!base || !key || !applicationId || !messageId) throw new Error("Infobip n'est pas configuré côté serveur.");
  const response = await fetch(`${base.replace(/\/$/, "")}/2fa/2/pin`, {
    method: "POST", headers: { Authorization: `App ${key}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ applicationId, messageId, from: process.env.INFOBIP_FROM || "PayCivo", to: `225${normalizeCI(phone)}` })
  });
  const text = await response.text(); if (!response.ok) throw new Error(`Infobip ${response.status}: ${text}`); return JSON.parse(text);
}
async function infobipVerifyOtp(pinId, pin) {
  const base = process.env.INFOBIP_BASE_URL, key = process.env.INFOBIP_API_KEY;
  if (!base || !key) throw new Error("Infobip n'est pas configuré côté serveur.");
  const response = await fetch(`${base.replace(/\/$/, "")}/2fa/2/pin/${encodeURIComponent(pinId)}/verify`, {
    method: "POST", headers: { Authorization: `App ${key}`, "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ pin: String(pin) })
  });
  const text = await response.text(); if (!response.ok) throw new Error(`Infobip ${response.status}: ${text}`); return JSON.parse(text);
}
function requireAuth(req, res, next) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const session = sessions.get(token);
  if (!session) return res.status(401).json({ ok: false, message: "Session expirée. Reconnecte-toi." });
  req.userId = session.userId; next();
}
function getUser(userId) { return readJson(usersFile, []).find(u => u.id === userId); }
function publicUser(user) { return { id: user.id, phone: user.phone, name: user.name, balance: user.balance || 0 }; }

app.get("/api/health", (req, res) => res.json({ ok: true, mockMode: MOCK_MODE, provider: "SasPay + Infobip" }));

app.post("/api/auth/request-otp", async (req, res) => {
  try {
    const phone = normalizeCI(req.body.phone);
    if (!validCI(phone)) return res.status(400).json({ ok: false, message: "Numéro ivoirien invalide." });
    if (MOCK_MODE) {
      const code = String(Math.floor(100000 + Math.random() * 900000));
      otpStore.set(phone, { code, expiresAt: Date.now() + 5 * 60 * 1000 });
      console.log(`[DEMO OTP] ${phone}: ${code}`);
      return res.json({ ok: true, demo: true, phone, demoCode: code });
    }
    const result = await infobipSendOtp(phone);
    res.json({ ok: true, demo: false, phone, pinId: result.pinId, message: "Code envoyé par SMS." });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.post("/api/auth/verify-otp", async (req, res) => {
  try {
    const phone = normalizeCI(req.body.phone), pin = String(req.body.pin || "").trim(), pinId = req.body.pinId;
    if (!validCI(phone) || !/^\d{4,8}$/.test(pin)) return res.status(400).json({ ok: false, message: "Données OTP invalides." });
    let verified = false;
    if (MOCK_MODE) { const s = otpStore.get(phone); verified = !!s && s.code === pin && s.expiresAt > Date.now(); if (verified) otpStore.delete(phone); }
    else { if (!pinId) return res.status(400).json({ ok: false, message: "pinId manquant." }); verified = (await infobipVerifyOtp(pinId, pin)).verified === true; }
    if (!verified) return res.status(401).json({ ok: false, message: "Code incorrect ou expiré." });
    const users = readJson(usersFile, []); let user = users.find(u => u.phone === phone);
    if (!user) { user = { id: crypto.randomUUID(), phone, name: "", createdAt: new Date().toISOString(), balance: 0 }; users.push(user); writeJson(usersFile, users); }
    const token = crypto.randomBytes(32).toString("hex"); sessions.set(token, { userId: user.id, createdAt: Date.now() });
    res.json({ ok: true, token, user: publicUser(user) });
  } catch (e) { res.status(500).json({ ok: false, message: e.message }); }
});

app.get("/api/me", requireAuth, (req, res) => { const user = getUser(req.userId); if (!user) return res.status(404).json({ ok:false, message:"Utilisateur introuvable." }); res.json({ ok:true, user: publicUser(user) }); });

app.post("/api/recharges/prepare", requireAuth, async (req, res) => {
  try {
    const recipient = normalizeCI(req.body.recipient), operator = String(req.body.operator), amount = Number(req.body.amount);
    if (!validCI(recipient)) return res.status(400).json({ ok:false, message:"Numéro bénéficiaire invalide." });
    if (!NETWORKS.includes(operator)) return res.status(400).json({ ok:false, message:"Réseau invalide." });
    if (!Number.isInteger(amount) || amount < 100) return res.status(400).json({ ok:false, message:"Montant minimum : 100 FCFA." });
    const user = getUser(req.userId); if (!user) return res.status(404).json({ ok:false, message:"Utilisateur introuvable." });
    const order = { id: crypto.randomUUID(), userId: user.id, recipient, operator, amount, status: "CREATED", paymentId: null, payoutId: null, createdAt: new Date().toISOString() };
    const orders = readJson(ordersFile, []); orders.unshift(order); writeJson(ordersFile, orders);

    if (MOCK_MODE) return res.json({ ok:true, order, demo:true, next:"payment" });

    const payment = await saspay("/api/v1/payments/softpay/", {
      method:"POST",
      headers:{"Idempotency-Key": order.id},
      body: JSON.stringify({ amount: amount.toFixed(2), currency:"XOF", country:"CI", description:`Recharge PayCivo ${recipient}`, customer:{ phone:fullCI(user.phone) }, network:operator, metadata:{ order_id:order.id, recipient, payout_method:operator } })
    });
    order.status = payment.status || "PENDING"; order.paymentId = payment.id; order.checkoutUrl = payment.checkout_url || "";
    writeJson(ordersFile, orders);
    res.json({ ok:true, order, payment, demo:false });
  } catch (e) { res.status(500).json({ ok:false, message:e.message }); }
});

app.get("/api/recharges/:id", requireAuth, async (req, res) => {
  try {
    const orders = readJson(ordersFile, []); const order = orders.find(o => o.id === req.params.id && o.userId === req.userId);
    if (!order) return res.status(404).json({ ok:false, message:"Recharge introuvable." });
    if (!MOCK_MODE && order.paymentId && ["PENDING", "CREATED"].includes(order.status)) {
      const payment = await saspay(`/api/v1/payments/${encodeURIComponent(order.paymentId)}/verify/`, { method:"GET", headers:{} });
      order.paymentStatus = payment.status;
      if (["SUCCESS", "SUCCEEDED", "COMPLETED"].includes(String(payment.status).toUpperCase())) {
        order.status = "PAYMENT_SUCCESS";
        if (!order.payoutId) await initializePayout(order);
      } else if (["FAILED", "CANCELLED", "CANCELED"].includes(String(payment.status).toUpperCase())) order.status = "PAYMENT_FAILED";
      writeJson(ordersFile, orders);
    }
    res.json({ ok:true, order });
  } catch (e) { res.status(500).json({ ok:false, message:e.message }); }
});

async function initializePayout(order) {
  const orders = readJson(ordersFile, []);
  if (MOCK_MODE) {
    order.payoutId = crypto.randomUUID(); order.status = "SUCCESS";
    const transfers = readJson(transfersFile, []); transfers.unshift({ id:order.payoutId, orderId:order.id, phone:order.recipient, operator:order.operator, amount:order.amount, status:"SUCCESS", createdAt:new Date().toISOString() }); writeJson(transfersFile, transfers); return;
  }
  const payout = await saspay("/api/v1/payouts/initialize/", { method:"POST", headers:{"Idempotency-Key":order.id}, body:JSON.stringify({ amount:order.amount.toFixed(2), currency:"XOF", country:"CI", customer:{phone:fullCI(order.recipient)}, method:order.operator, recipient:{msisdn:fullCI(order.recipient)}, description:`Recharge PayCivo ${order.recipient}`, metadata:{order_id:order.id} }) });
  order.payoutId = payout.id; order.status = "PAYOUT_PENDING"; writeJson(ordersFile, orders);
}

app.post("/api/recharges/:id/demo-complete", requireAuth, (req,res)=>{
  if (!MOCK_MODE) return res.status(403).json({ok:false,message:"Route disponible uniquement en mode démo."});
  const orders=readJson(ordersFile,[]); const order=orders.find(o=>o.id===req.params.id&&o.userId===req.userId); if(!order) return res.status(404).json({ok:false,message:"Recharge introuvable."});
  order.status="SUCCESS"; order.paymentStatus="SUCCESS"; if(!order.payoutId) { order.payoutId=crypto.randomUUID(); const transfers=readJson(transfersFile,[]); transfers.unshift({id:order.payoutId,orderId:order.id,phone:order.recipient,operator:order.operator,amount:order.amount,status:"SUCCESS",createdAt:new Date().toISOString()}); writeJson(transfersFile,transfers); } writeJson(ordersFile,orders); res.json({ok:true,order});
});

app.get("/api/history", requireAuth, (req,res)=>{ const orders=readJson(ordersFile,[]).filter(o=>o.userId===req.userId); res.json({ok:true,orders}); });

app.post("/api/webhooks/saspay", async (req,res)=>{
  try {
    const event=req.body||{}; const orderId=event.metadata?.order_id || event.data?.metadata?.order_id || event.order_id;
    if (!orderId) return res.json({ok:true,ignored:true});
    const orders=readJson(ordersFile,[]); const order=orders.find(o=>o.id===orderId); if(!order) return res.json({ok:true,ignored:true});
    const status=String(event.status || event.data?.status || "").toUpperCase();
    if(["SUCCESS","SUCCEEDED","COMPLETED"].includes(status) && order.paymentId && !order.payoutId){ order.status="PAYMENT_SUCCESS"; await initializePayout(order); }
    else if(["FAILED","CANCELLED","CANCELED"].includes(status)){order.status="PAYMENT_FAILED";writeJson(ordersFile,orders);}
    res.json({ok:true});
  } catch(e){ console.error(e); res.status(500).json({ok:false}); }
});

app.get("/api/history/all", requireAuth, (req,res)=>{res.json({ok:true,transfers:readJson(transfersFile,[])});});
app.get("*", (req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`PayCivo v2 sur http://localhost:${PORT} | mode démo=${MOCK_MODE}`));
