import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const {
  PORT = "4000",
  CLIENT_ORIGIN = "http://localhost:5173",
  TRUST_PROXY = "0",
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_BUCKET = "payment-proofs",
  BANK_NAME = "",
  BANK_ACCOUNT_NAME = "",
  BANK_ACCOUNT_NUMBER = "",
  PAYMENT_NOTE = "",
  ADMIN_ACCESS_TOKEN = "",
  MAX_FILE_BYTES = String(5 * 1024 * 1024),
} = process.env;

const LEVELS = ["beginner", "intermediate", "advanced"];
const STATUS_VALUES = ["pending", "confirmed", "rejected"];
const MAX_FILE_SIZE_BYTES =
  Number.parseInt(MAX_FILE_BYTES, 10) || 5 * 1024 * 1024;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
        },
      })
    : null;

function ensureSupabase(res) {
  if (!supabase) {
    res
      .status(500)
      .json({ error: "Supabase is not configured on the server." });
    return false;
  }
  return true;
}

const allowedOrigins = (CLIENT_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// ---------- App ----------
const app = express();
if (TRUST_PROXY !== "0") app.set("trust proxy", Number(TRUST_PROXY) || 1);
app.use(helmet());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      // Render deployments may not have the frontend origin wired into env yet,
      // so allow the request rather than returning a CORS error while the app is
      // being updated.
      console.warn(
        `CORS origin not in allowlist, allowing temporarily: ${origin}`,
      );
      return callback(null, true);
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);
app.use(express.json({ limit: "10kb" }));

app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
  }),
);
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many submissions from this network. Please try again later.",
  },
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES, files: 1 },
});

// ---------- Helpers ----------
// Decide the real file type from its first bytes — never trust the client's mimetype.
function sniffFile(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return { ext: "jpg", mime: "image/jpeg" };
  if (
    buf
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return { ext: "png", mime: "image/png" };
  if (
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return { ext: "webp", mime: "image/webp" };
  if (buf.subarray(0, 5).toString("ascii") === "%PDF-")
    return { ext: "pdf", mime: "application/pdf" };
  return null;
}

function makeReference() {
  const d = new Date();
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;
  return `CS-${ymd}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function validate(body) {
  const errors = {};
  const fullName = String(body.fullName ?? "")
    .trim()
    .replace(/\s+/g, " ");
  const email = String(body.email ?? "")
    .trim()
    .toLowerCase();
  const phone = String(body.phone ?? "").trim();
  const paymentReference = String(body.paymentReference ?? "").trim();
  const serviceId = String(body.serviceId ?? "").trim();
  const level = String(body.level ?? "")
    .trim()
    .toLowerCase();

  if (fullName.length < 2 || fullName.length > 100)
    errors.fullName = "Enter your full name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254)
    errors.email = "Enter a valid email address.";
  if (!/^\+?[0-9][0-9\s-]{6,17}$/.test(phone))
    errors.phone = "Enter a valid phone number.";
  if (paymentReference.length < 3 || paymentReference.length > 64)
    errors.paymentReference =
      "Enter the reference from your bank transfer (3–64 characters).";
  if (!serviceId) errors.serviceId = "Choose a service.";
  if (!LEVELS.includes(level)) errors.level = "Choose a level.";

  return {
    errors,
    values: { fullName, email, phone, paymentReference, serviceId, level },
  };
}

const fieldError = (fields) => ({
  error: "Please fix the highlighted fields.",
  fields,
});

// ---------- Routes ----------
app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.post("/api/admin/login", (req, res) => {
  const token = String(req.body?.token ?? "").trim();

  if (!ADMIN_ACCESS_TOKEN) {
    return res
      .status(500)
      .json({ error: "Admin authentication is not configured on the server." });
  }
  if (!token || token !== ADMIN_ACCESS_TOKEN) {
    return res.status(401).json({ error: "Invalid admin access token." });
  }

  return res.json({ ok: true });
});

async function requireAdmin(req, res, next) {
  if (!supabase) {
    return res
      .status(500)
      .json({ error: "Supabase is not configured on the server." });
  }

  const auth = req.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";

  if (!token) return res.status(401).json({ error: "Unauthorized." });

  // Backwards-compatible: allow a server-side static admin token if set
  if (ADMIN_ACCESS_TOKEN && token === ADMIN_ACCESS_TOKEN) return next();

  // Verify Supabase access token and check admins table
  try {
    const { data: userData, error: userErr } =
      await supabase.auth.getUser(token);
    if (userErr || !userData?.user) {
      // Expired token, or the client signed in to a different Supabase project
      // than this server's SUPABASE_URL.
      console.warn("admin auth: token rejected:", userErr?.message || "no user");
      return res
        .status(401)
        .json({ error: "Your admin session is no longer valid. Please sign in again." });
    }
    const email = String(userData.user.email || "").trim();
    if (!email) return res.status(403).json({ error: "Forbidden." });

    // Case-insensitive match (escape LIKE wildcards in the address)
    const pattern = email.replace(/[\\%_]/g, (c) => "\\" + c);
    const { data: adminRow, error: adminErr } = await supabase
      .from("admins")
      .select("id")
      .ilike("email", pattern)
      .limit(1)
      .maybeSingle();
    if (adminErr) {
      console.error("admin lookup failed:", adminErr.message);
      return res.status(500).json({ error: "Could not verify admin." });
    }
    if (!adminRow) {
      console.warn(`admin auth: ${email} signed in but is not in the admins table`);
      return res
        .status(403)
        .json({ error: "This account is signed in but is not an admin." });
    }

    req.admin = { id: adminRow.id, email };
    return next();
  } catch (err) {
    console.error("requireAdmin error:", err);
    return res.status(500).json({ error: "Could not verify admin." });
  }
}

// Get banner image URL (public endpoint)
app.get("/api/banner", async (_req, res) => {
  if (!ensureSupabase(res)) return;
  const { data, error } = await supabase
    .from("settings")
    .select("value")
    .eq("key", "banner_image_url")
    .single();

  if (error) {
    console.error("banner fetch failed:", error.message);
    return res.json({
      bannerUrl:
        "https://images.unsplash.com/photo-1552664730-d307ca884978?w=1200&h=300&fit=crop",
    });
  }

  return res.json({ bannerUrl: data?.value || "" });
});

// Update banner image URL (admin only)
app.patch("/api/admin/banner", requireAdmin, async (req, res) => {
  if (!ensureSupabase(res)) return;
  const url = String(req.body?.bannerUrl || "").trim();

  if (!url || url.length > 500) {
    return res.status(400).json({ error: "Invalid banner URL." });
  }

  const { error: updateErr } = await supabase
    .from("settings")
    .update({ value: url, updated_at: new Date().toISOString() })
    .eq("key", "banner_image_url");

  if (updateErr) {
    console.error("banner update failed:", updateErr.message);
    return res.status(500).json({ error: "Could not update banner." });
  }

  return res.json({ bannerUrl: url });
});

// Get current admin info (authenticated endpoint)
app.get("/api/admin/me", requireAdmin, async (req, res) => {
  if (!req.admin) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  return res.json({ admin: req.admin });
});

// Helper: generate short coupon codes
function generateCouponCode(len = 8) {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.randomBytes(len);
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

// Public: validate a coupon code
app.get("/api/coupons/validate", async (req, res) => {
  if (!ensureSupabase(res)) return;
  const codeRaw = String(req.query.code || "").trim();
  if (!codeRaw) return res.status(400).json({ error: "Missing code." });
  const code = codeRaw.toUpperCase();
  const { data: c, error } = await supabase
    .from("coupons")
    .select(
      "code, discount_type, discount_percent, discount_amount, max_redemptions, redeemed, expires_at, active",
    )
    .eq("code", code)
    .maybeSingle();
  if (error) {
    console.error("coupon lookup failed:", error.message);
    return res.status(500).json({ error: "Could not validate coupon." });
  }
  if (!c || !c.active) return res.json({ valid: false });
  if (c.expires_at && new Date(c.expires_at) <= new Date())
    return res.json({ valid: false });
  if (c.redeemed >= (c.max_redemptions || 0)) return res.json({ valid: false });
  return res.json({
    valid: true,
    discountPercent:
      c.discount_type === "fixed" ? 0 : Number(c.discount_percent || 0),
    discountAmount:
      c.discount_type === "fixed" ? Number(c.discount_amount || 0) : 0,
    code: c.code,
    discountType: c.discount_type || "percentage",
  });
});

// Admin: create a coupon
app.post("/api/admin/coupons", requireAdmin, async (req, res) => {
  if (!ensureSupabase(res)) return;
  const body = req.body || {};
  const discountType = String(body.discountType || "percentage").toLowerCase();
  const discountPercent = Number(body.discountPercent || 0);
  const discountAmount = Number(body.discountAmount || 0);
  const maxRedemptions = Number(body.maxRedemptions || 1);
  const expiresAt = body.expiresAt
    ? new Date(body.expiresAt).toISOString()
    : null;

  if (discountType === "fixed") {
    if (!discountAmount || discountAmount <= 0) {
      return res
        .status(400)
        .json({ error: "discountAmount must be greater than 0." });
    }
  } else {
    if (!discountPercent || discountPercent <= 0 || discountPercent > 100) {
      return res
        .status(400)
        .json({ error: "discountPercent must be between 1 and 100." });
    }
  }

  const code = String(body.code || generateCouponCode())
    .trim()
    .toUpperCase();
  const insert = {
    code,
    discount_type: discountType === "fixed" ? "fixed" : "percentage",
    discount_percent:
      discountType === "fixed" ? 0 : Math.round(discountPercent),
    discount_amount: discountType === "fixed" ? Math.round(discountAmount) : 0,
    max_redemptions: maxRedemptions || 1,
    expires_at: expiresAt,
    active: body.active === false ? false : true,
    created_by: req.admin?.id || null,
  };
  const { data, error } = await supabase
    .from("coupons")
    .insert(insert)
    .select()
    .single();
  if (error) {
    console.error("coupon insert failed:", error.message);
    return res.status(500).json({ error: "Could not create coupon." });
  }

  return res.json({ coupon: data });
});

// Admin: update a coupon
// Admin: list coupons
app.get("/api/admin/coupons", requireAdmin, async (_req, res) => {
  if (!ensureSupabase(res)) return;
  const { data, error } = await supabase
    .from("coupons")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) {
    console.error("coupon list failed:", error.message);
    return res.status(500).json({ error: "Could not load coupons." });
  }
  return res.json({ coupons: data || [] });
});

// Admin: update a coupon (the client addresses coupons by CODE)
app.patch("/api/admin/coupons/:code", requireAdmin, async (req, res) => {
  if (!ensureSupabase(res)) return;
  const body = req.body || {};
  const code = String(req.params.code || "").trim().toUpperCase();

  const { data: coupon, error: fetchErr } = await supabase
    .from("coupons")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (fetchErr) {
    console.error("coupon fetch failed:", fetchErr.message);
    return res.status(500).json({ error: "Could not fetch coupon." });
  }
  if (!coupon) return res.status(404).json({ error: "Coupon not found." });

  const discountType = String(body.discountType || "percentage").toLowerCase();
  const discountPercent = Number(body.discountPercent || 0);
  const discountAmount = Number(body.discountAmount || 0);
  const maxRedemptions = Number(body.maxRedemptions || 1);
  const expiresAt = body.expiresAt
    ? new Date(body.expiresAt).toISOString()
    : null;

  if (discountType === "fixed") {
    if (!discountAmount || discountAmount <= 0) {
      return res
        .status(400)
        .json({ error: "discountAmount must be greater than 0." });
    }
  } else if (!discountPercent || discountPercent <= 0 || discountPercent > 100) {
    return res
      .status(400)
      .json({ error: "discountPercent must be between 1 and 100." });
  }

  const update = {
    discount_type: discountType === "fixed" ? "fixed" : "percentage",
    discount_percent: discountType === "fixed" ? 0 : Math.round(discountPercent),
    discount_amount: discountType === "fixed" ? Math.round(discountAmount) : 0,
    max_redemptions: maxRedemptions || 1,
    expires_at: expiresAt,
    active: body.active === false ? false : true,
    updated_at: new Date().toISOString(),
  };
  const { error: updateErr } = await supabase
    .from("coupons")
    .update(update)
    .eq("code", code);
  if (updateErr) {
    console.error("coupon update failed:", updateErr.message);
    return res.status(500).json({ error: "Could not update coupon." });
  }
  return res.json({ coupon: { ...coupon, ...update } });
});

// Admin: delete a coupon
app.delete("/api/admin/coupons/:code", requireAdmin, async (req, res) => {
  if (!ensureSupabase(res)) return;
  const code = String(req.params.code || "").trim().toUpperCase();
  const { data, error } = await supabase
    .from("coupons")
    .delete()
    .eq("code", code)
    .select()
    .maybeSingle();
  if (error) {
    console.error("coupon delete failed:", error.message);
    return res.status(500).json({ error: "Could not delete coupon." });
  }
  if (!data) return res.status(404).json({ error: "Coupon not found." });
  return res.json({ coupon: data });
});

// Public: services with prices per level
app.get("/api/services", async (_req, res) => {
  if (!ensureSupabase(res)) return;
  const { data, error } = await supabase
    .from("services")
    .select("id, name, description, sort_order, service_prices(level, price_ngn)")
    .eq("active", true)
    .order("sort_order");
  if (error) {
    console.error("services query failed:", error.message);
    return res.status(500).json({ error: "Could not load services." });
  }
  const services = (data || []).map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    prices: Object.fromEntries(
      (s.service_prices || []).map((p) => [p.level, p.price_ngn]),
    ),
  }));
  return res.json({ services });
});

// Public: bank instructions
app.get("/api/payment-info", (_req, res) => {
  res.json({
    bankName: BANK_NAME,
    accountName: BANK_ACCOUNT_NAME,
    accountNumber: BANK_ACCOUNT_NUMBER,
    note: PAYMENT_NOTE,
  });
});

// Application: submit a new application
app.post(
  "/api/applications",
  submitLimiter,
  upload.single("proof"),
  async (req, res) => {
    if (!ensureSupabase(res)) return;
    const body = req.body || {};
    const { errors, values } = validate(body);

    const file = req.file;
    const kind = file ? sniffFile(file.buffer) : null;
    if (!file) errors.proof = "Upload your payment proof.";
    else if (!kind) errors.proof = "Proof must be a JPG, PNG, WEBP or PDF file.";
    if (Object.keys(errors).length) {
      return res.status(400).json(fieldError(errors));
    }

    // Price always comes from the database
    const { data: priceRow, error: priceErr } = await supabase
      .from("service_prices")
      .select("price_ngn, services!inner(id, active)")
      .eq("service_id", values.serviceId)
      .eq("level", values.level)
      .eq("services.active", true)
      .maybeSingle();
    if (priceErr) {
      console.error("price lookup failed:", priceErr.message);
      return res.status(500).json({ error: "Something went wrong. Please try again." });
    }
    if (!priceRow) {
      return res
        .status(400)
        .json(fieldError({ serviceId: "That service and level is not available." }));
    }

    // Duplicate payment reference
    const { data: dupes, error: dupesErr } = await supabase
      .from("applications")
      .select("id, status, created_at")
      .eq("payment_reference", values.paymentReference)
      .limit(1);
    if (dupesErr) {
      console.error("duplicate check failed:", dupesErr.message);
      return res.status(500).json({ error: "Could not check for duplicates." });
    }
    if (dupes?.length) {
      return res.status(400).json(
        fieldError({
          paymentReference: "An application with this payment reference already exists.",
        }),
      );
    }

    // Optional coupon (validated here, never trusted from the browser)
    let finalPrice = Number(priceRow.price_ngn);
    let coupon = null;
    const couponCode = String(body.couponCode || "").trim().toUpperCase();
    if (couponCode) {
      const { data: c, error: cErr } = await supabase
        .from("coupons")
        .select("code, discount_type, discount_percent, discount_amount, max_redemptions, redeemed, expires_at, active")
        .eq("code", couponCode)
        .maybeSingle();
      if (cErr) {
        console.error("coupon lookup failed:", cErr.message);
        return res.status(500).json({ error: "Could not validate coupon." });
      }
      const usable =
        c &&
        c.active &&
        !(c.expires_at && new Date(c.expires_at) <= new Date()) &&
        c.redeemed < (c.max_redemptions || 0);
      if (!usable) return res.status(400).json({ error: "Invalid or expired coupon." });
      coupon = c;
      finalPrice =
        c.discount_type === "fixed"
          ? Math.max(0, Math.round(finalPrice - Number(c.discount_amount || 0)))
          : Math.round((finalPrice * (100 - Number(c.discount_percent || 0))) / 100);
    }

    // Upload proof to the private bucket
    const proofPath = `proofs/${crypto.randomUUID()}.${kind.ext}`;
    const { error: uploadErr } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(proofPath, file.buffer, { contentType: kind.mime, upsert: false });
    if (uploadErr) {
      console.error("file upload failed:", uploadErr.message);
      return res.status(500).json({ error: "Could not upload your payment proof." });
    }

    // Insert, retrying on reference collisions
    let application = null;
    for (let attempt = 0; attempt < 5 && !application; attempt++) {
      const { data, error } = await supabase
        .from("applications")
        .insert({
          reference: makeReference(),
          service_id: values.serviceId,
          level: values.level,
          price_ngn: Number(priceRow.price_ngn),
          final_price_ngn: finalPrice,
          coupon_code: coupon ? coupon.code : null,
          full_name: values.fullName,
          email: values.email,
          phone: values.phone,
          payment_reference: values.paymentReference,
          payment_proof_path: proofPath,
          status: "pending",
        })
        .select("reference, status, final_price_ngn, created_at")
        .single();
      if (!error) application = data;
      else if (error.code !== "23505") {
        console.error("application insert failed:", error.message);
        break;
      }
    }
    if (!application) {
      await supabase.storage.from(SUPABASE_BUCKET).remove([proofPath]);
      return res.status(500).json({ error: "Could not save your application. Please try again." });
    }

    // Count the coupon use (optimistic lock so two people can't take the last use)
    if (coupon) {
      const { error: redeemErr } = await supabase
        .from("coupons")
        .update({ redeemed: coupon.redeemed + 1 })
        .eq("code", coupon.code)
        .eq("redeemed", coupon.redeemed);
      if (redeemErr) console.error("coupon redeem failed:", redeemErr.message);
    }

    return res.status(201).json({
      reference: application.reference,
      status: application.status,
      priceNgn: application.final_price_ngn,
      createdAt: application.created_at,
    });
  },
);

// Admin: list applications (+ counts), with signed links to the private proofs
app.get("/api/admin/applications", requireAdmin, async (req, res) => {
  if (!ensureSupabase(res)) return;
  const status = String(req.query.status || "").toLowerCase();

  let query = supabase
    .from("applications")
    .select("*, services(name)")
    .order("created_at", { ascending: false })
    .limit(500);
  if (STATUS_VALUES.includes(status)) query = query.eq("status", status);

  const { data, error } = await query;
  if (error) {
    console.error("admin applications failed:", error.message);
    return res.status(500).json({ error: "Unable to load applications." });
  }
  const rows = data || [];

  const paths = rows.map((r) => r.payment_proof_path).filter(Boolean);
  const signed = {};
  if (paths.length) {
    const { data: urls, error: signErr } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .createSignedUrls(paths, 60 * 60);
    if (signErr) console.error("signing failed:", signErr.message);
    (urls || []).forEach((u) => {
      if (u.path && u.signedUrl) signed[u.path] = u.signedUrl;
    });
  }

  const applications = rows.map((r) => ({
    id: r.id,
    reference: r.reference,
    fullName: r.full_name,
    email: r.email,
    phone: r.phone,
    serviceId: r.service_id,
    serviceName: r.services?.name || r.service_id,
    level: r.level,
    priceNgn: r.final_price_ngn ?? r.price_ngn,
    couponCode: r.coupon_code || null,
    paymentReference: r.payment_reference,
    proofUrl: signed[r.payment_proof_path] || r.proof_url || null,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));

  // Counts across ALL applications, not just the filtered page
  const count = async (s) => {
    let q = supabase.from("applications").select("id", { count: "exact", head: true });
    if (s) q = q.eq("status", s);
    const { count: n } = await q;
    return n || 0;
  };
  const [total, pending, confirmed, rejected] = await Promise.all([
    count(), count("pending"), count("confirmed"), count("rejected"),
  ]);

  return res.json({ applications, summary: { total, pending, confirmed, rejected } });
});

// Admin: change an application's status
app.patch("/api/admin/applications/:id/status", requireAdmin, async (req, res) => {
  if (!ensureSupabase(res)) return;
  const status = String(req.body?.status || "").toLowerCase();
  if (!STATUS_VALUES.includes(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }
  const { data, error } = await supabase
    .from("applications")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", req.params.id)
    .select("id, status, updated_at")
    .maybeSingle();
  if (error) {
    console.error("status update failed:", error.message);
    return res.status(500).json({ error: "Could not update the application status." });
  }
  if (!data) return res.status(404).json({ error: "Application not found." });
  return res.json({ application: data });
});

// Application: get a specific application (admin only)
app.get("/api/applications/:id", requireAdmin, async (req, res) => {
  if (!ensureSupabase(res)) return;
  const id = req.params.id;

  const { data, error } = await supabase
    .from("applications")
    .select("*")
    .eq("id", id)
    .single();
  if (error) {
    console.error("application fetch failed:", error.message);
    return res.status(500).json({ error: "Could not fetch application." });
  }
  if (!data) return res.status(404).json({ error: "Application not found." });

  return res.json({ application: data });
});

// Application: update a specific application (admin only)
app.patch("/api/applications/:id", requireAdmin, async (req, res) => {
  if (!ensureSupabase(res)) return;
  const id = req.params.id;
  const body = req.body || {};

  const { data: appData, error: fetchErr } = await supabase
    .from("applications")
    .select("*")
    .eq("id", id)
    .single();
  if (fetchErr) {
    console.error("application fetch failed:", fetchErr.message);
    return res.status(500).json({ error: "Could not fetch application." });
  }
  if (!appData)
    return res.status(404).json({ error: "Application not found." });

  // Admin can update all fields, but regular users can only update certain fields
  const isAdmin = req.admin !== undefined;
  const updatableFields = isAdmin
    ? Object.keys(body)
    : Object.keys(body).filter(
        (key) =>
          !["status", "admin_notes", "created_at", "updated_at"].includes(key),
      );

  const updateData = {};
  for (const key of updatableFields) {
    updateData[key] = body[key];
  }
  if (isAdmin && body.status) {
    updateData.status = body.status;
  }

  const { error: updateErr } = await supabase
    .from("applications")
    .update(updateData)
    .eq("id", id);

  if (updateErr) {
    console.error("application update failed:", updateErr.message);
    return res.status(500).json({ error: "Could not update application." });
  }

  return res.json({ application: { ...appData, ...updateData } });
});

// Application: delete a specific application (admin only)
app.delete("/api/applications/:id", requireAdmin, async (req, res) => {
  if (!ensureSupabase(res)) return;
  const id = req.params.id;

  const { data, error: deleteErr } = await supabase
    .from("applications")
    .delete()
    .eq("id", id)
    .select()
    .single();
  if (deleteErr) {
    console.error("application delete failed:", deleteErr.message);
    return res.status(500).json({ error: "Could not delete application." });
  }

  return res.json({ application: data });
});

// Webhook: handle payment notifications (e.g., from Midtrans)
app.post(
  "/api/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!ensureSupabase(res)) return;
    const sigHeader = req.headers["x-signature"] || "";
    const payload = req.body;

    // Verify signature (HMAC SHA256)
    const secret = String(process.env.MIDTRANS_SERVER_KEY || "").trim();
    const expectedSig = crypto
      .createHmac("sha256", secret)
      .update(JSON.stringify(payload))
      .digest("hex");
    if (sigHeader !== expectedSig) {
      return res.status(403).json({ error: "Invalid signature." });
    }

    const transaction = payload?.transaction_status;
    const orderId = payload?.order_id;
    const fraudStatus = payload?.fraud_status;

    // Only process successful or pending transactions
    if (transaction === "capture" || transaction === "settlement") {
      // Payment received
      const { error } = await supabase
        .from("applications")
        .update({ status: "confirmed" })
        .eq("payment_reference", orderId);

      if (error) {
        console.error("status update failed:", error.message);
        return res.status(500).json({ error: "Could not update status." });
      }
    } else if (transaction === "pending") {
      // Payment pending
      const { error } = await supabase
        .from("applications")
        .update({ status: "pending" })
        .eq("payment_reference", orderId);

      if (error) {
        console.error("status update failed:", error.message);
        return res.status(500).json({ error: "Could not update status." });
      }
    } else if (transaction === "expire") {
      // Payment expired
      const { error } = await supabase
        .from("applications")
        .update({ status: "expired" })
        .eq("payment_reference", orderId);

      if (error) {
        console.error("status update failed:", error.message);
        return res.status(500).json({ error: "Could not update status." });
      }
    } else if (transaction === "cancel") {
      // Payment canceled
      const { error } = await supabase
        .from("applications")
        .update({ status: "canceled" })
        .eq("payment_reference", orderId);

      if (error) {
        console.error("status update failed:", error.message);
        return res.status(500).json({ error: "Could not update status." });
      }
    }

    return res.json({ received: true });
  },
);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Not found." });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Unexpected error:", err);
  res.status(500).json({ error: "Internal server error." });
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
