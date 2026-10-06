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
    if (userErr || !userData?.user)
      return res.status(401).json({ error: "Unauthorized." });
    const email = userData.user.email;
    if (!email) return res.status(403).json({ error: "Forbidden." });

    const { data: adminRow, error: adminErr } = await supabase
      .from("admins")
      .select("id")
      .eq("email", email)
      .maybeSingle();
    if (adminErr) {
      console.error("admin lookup failed:", adminErr.message);
      return res.status(500).json({ error: "Could not verify admin." });
    }
    if (!adminRow) return res.status(403).json({ error: "Forbidden." });

    // attach user info to request for later use
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
app.patch("/api/admin/coupons/:id", requireAdmin, async (req, res) => {
  if (!ensureSupabase(res)) return;
  const body = req.body || {};
  const id = req.params.id;

  const { data: coupon, error: fetchErr } = await supabase
    .from("coupons")
    .select("*")
    .eq("id", id)
    .single();
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
  } else {
    if (!discountPercent || discountPercent <= 0 || discountPercent > 100) {
      return res
        .status(400)
        .json({ error: "discountPercent must be between 1 and 100." });
    }
  }

  const update = {
    discount_type: discountType === "fixed" ? "fixed" : "percentage",
    discount_percent:
      discountType === "fixed" ? 0 : Math.round(discountPercent),
    discount_amount: discountType === "fixed" ? Math.round(discountAmount) : 0,
    max_redemptions: maxRedemptions || 1,
    expires_at: expiresAt,
    active: body.active === false ? false : true,
    updated_at: new Date().toISOString(),
  };
  const { error: updateErr } = await supabase
    .from("coupons")
    .update(update)
    .eq("id", id);

  if (updateErr) {
    console.error("coupon update failed:", updateErr.message);
    return res.status(500).json({ error: "Could not update coupon." });
  }

  return res.json({ coupon: { ...coupon, ...update } });
});

// Application: submit a new application
app.post(
  "/api/applications",
  submitLimiter,
  upload.single("proof"),
  async (req, res) => {
    if (!ensureSupabase(res)) return;
    const body = req.body || {};
    const file = req.file;
    const ip = req.ip;

    // Validate request data
    const { errors, values } = validate(body);
    if (Object.keys(errors).length) {
      return res.status(400).json(fieldError(errors));
    }

    // Check for duplicate application (same payment reference)
    const { data: dupes, error: dupesErr } = await supabase
      .from("applications")
      .select("id, status, created_at")
      .eq("payment_reference", values.paymentReference)
      .order("created_at", { ascending: false })
      .limit(2);
    if (dupesErr) {
      console.error("duplicate check failed:", dupesErr.message);
      return res.status(500).json({ error: "Could not check for duplicates." });
    }
    if (dupes?.length) {
      const latest = dupes[0];
      return res.status(400).json({
        error: "Duplicate application found.",
        fields: ["paymentReference"],
        message: `You already submitted an application with this payment reference on ${new Date(
          latest.created_at,
        ).toLocaleString()}.`,
        status: latest.status,
        id: latest.id,
      });
    }

    // Handle file upload: store to Supabase Storage
    let fileUrl = null;
    if (file) {
      const fileExt = file.originalname.split(".").pop().toLowerCase();
      const fileName = `${makeReference()}.${fileExt}`;
      const { error: uploadErr } = await supabase.storage
        .from(SUPABASE_BUCKET)
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });
      if (uploadErr) {
        console.error("file upload failed:", uploadErr.message);
        return res.status(500).json({ error: "Could not upload file." });
      }
      fileUrl = supabase.storage.from(SUPABASE_BUCKET).getPublicUrl(fileName)
        .data.publicUrl;
    }

    // Create the application record
    const application = {
      ...values,
      status: "pending",
      ip_address: ip,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      proof_url: fileUrl,
    };
    const { data, error } = await supabase
      .from("applications")
      .insert(application)
      .select()
      .single();
    if (error) {
      console.error("application insert failed:", error.message);
      return res.status(500).json({ error: "Could not submit application." });
    }

    // handle optional coupon code: validate and compute discounted price
    let finalPrice = Number(priceRow.price_ngn ?? 0);
    let usedCoupon = null;
    try {
      const codeRaw = String(values.couponCode || "").trim();
      if (codeRaw) {
        const code = codeRaw.toUpperCase();
        const { data: c, error: cErr } = await supabase
          .from("coupons")
          .select(
            "code, discount_type, discount_percent, discount_amount, max_redemptions, redeemed, expires_at, active",
          )
          .eq("code", code)
          .maybeSingle();

        if (
          cErr &&
          !/does not exist|relation .* coupons|table .* coupons/.test(
            cErr.message || "",
          )
        ) {
          console.error("coupon lookup failed:", cErr.message);
        } else if (!cErr && c && c.active) {
          if (c.expires_at && new Date(c.expires_at) <= new Date()) {
            return res.status(400).json({ error: "Coupon code has expired." });
          }
          if (c.redeemed >= (c.max_redemptions || 0)) {
            return res
              .status(400)
              .json({ error: "Coupon code has been fully redeemed." });
          }
          usedCoupon = c;
          if (c.discount_type === "fixed") {
            finalPrice = Math.max(
              0,
              Math.round(finalPrice - Number(c.discount_amount || 0)),
            );
          } else {
            finalPrice = Math.round(
              (finalPrice * (100 - Number(c.discount_percent || 0))) / 100,
            );
          }
        } else if (!cErr && c && !c.active) {
          return res
            .status(400)
            .json({ error: "Invalid or inactive coupon code." });
        }
      }
    } catch (err) {
      console.error("coupon validation error:", err?.message || err);
    }

    return res.json({
      application: { ...data, finalPrice },
      ...(usedCoupon ? { coupon: usedCoupon } : {}),
    });
  },
);

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
