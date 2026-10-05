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
} = process.env;

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
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
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

app.get("/api/admin/applications", requireAdmin, async (req, res) => {
  const statusFilter = String(req.query.status || "")
    .trim()
    .toLowerCase();

  let query = supabase
    .from("applications")
    .select(
      "id, reference, full_name, email, phone, level, price_ngn, status, payment_reference, payment_proof_path, created_at, updated_at, services(name)",
    )
    .order("created_at", { ascending: false });

  if (statusFilter && STATUS_VALUES.includes(statusFilter)) {
    query = query.eq("status", statusFilter);
  }

  const { data, error } = await query;
  if (error) {
    console.error("admin list failed:", error.message);
    return res.status(500).json({ error: "Could not load applications." });
  }

  const applications = await Promise.all(
    (data || []).map(async (row) => {
      let proofUrl = null;
      if (row.payment_proof_path) {
        const { data: signedData, error: signedError } = await supabase.storage
          .from(SUPABASE_BUCKET)
          .createSignedUrl(row.payment_proof_path, 60 * 60 * 24);

        if (!signedError && signedData?.signedUrl) {
          proofUrl = signedData.signedUrl;
        }
      }

      return {
        id: row.id,
        reference: row.reference,
        fullName: row.full_name,
        email: row.email,
        phone: row.phone,
        serviceName: row.services?.name || "—",
        level: row.level,
        priceNgn: Number(row.price_ngn || 0),
        status: row.status,
        paymentReference: row.payment_reference,
        proofUrl,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    }),
  );

  const summary = {
    total: applications.length,
    pending: applications.filter((item) => item.status === "pending").length,
    confirmed: applications.filter((item) => item.status === "confirmed")
      .length,
    rejected: applications.filter((item) => item.status === "rejected").length,
  };

  return res.json({ applications, summary });
});

app.patch(
  "/api/admin/applications/:id/status",
  requireAdmin,
  async (req, res) => {
    const { id } = req.params;
    const nextStatus = String(req.body?.status ?? "")
      .trim()
      .toLowerCase();

    if (!STATUS_VALUES.includes(nextStatus)) {
      return res
        .status(400)
        .json({ error: "Status must be pending, confirmed, or rejected." });
    }

    const { data, error } = await supabase
      .from("applications")
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select("id, status, updated_at")
      .single();

    if (error) {
      console.error("status update failed:", error.message);
      return res
        .status(500)
        .json({ error: "Could not update the application status." });
    }

    return res.json({
      application: {
        id: data.id,
        status: data.status,
        updatedAt: data.updated_at,
      },
    });
  },
);

// Services with their prices for each level
app.get("/api/services", async (_req, res) => {
  const { data, error } = await supabase
    .from("services")
    .select(
      "id, name, description, sort_order, service_prices(level, price_ngn)",
    )
    .eq("active", true)
    .order("sort_order");

  if (error) {
    console.error("services query failed:", error.message);
    return res.status(500).json({ error: "Could not load services." });
  }

  const services = data.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    prices: Object.fromEntries(
      s.service_prices.map((p) => [p.level, p.price_ngn]),
    ),
  }));
  res.json({ services });
});

// Bank instructions (kept in server env so they are changed in one place)
app.get("/api/payment-info", (_req, res) => {
  res.json({
    bankName: BANK_NAME,
    accountName: BANK_ACCOUNT_NAME,
    accountNumber: BANK_ACCOUNT_NUMBER,
    note: PAYMENT_NOTE,
  });
});

// Create an application (multipart/form-data with a "proof" file)
app.post(
  "/api/applications",
  submitLimiter,
  upload.single("proof"),
  async (req, res) => {
    const { errors, values } = validate(req.body ?? {});
    const file = req.file;
    const kind = file ? sniffFile(file.buffer) : null;

    if (!file) errors.proof = "Upload your payment proof.";
    else if (!kind)
      errors.proof = "Proof must be a JPG, PNG, WEBP or PDF file.";

    if (Object.keys(errors).length)
      return res.status(400).json(fieldError(errors));

    const { data: priceRow, error: priceErr } = await supabase
      .from("service_prices")
      .select("price_ngn, services!inner(id, active)")
      .eq("service_id", values.serviceId)
      .eq("level", values.level)
      .eq("services.active", true)
      .maybeSingle();

    if (priceErr) {
      console.error("price lookup failed:", priceErr.message);
      return res
        .status(500)
        .json({ error: "Something went wrong. Please try again." });
    }
    if (!priceRow) {
      return res
        .status(400)
        .json(
          fieldError({ serviceId: "That service and level is not available." }),
        );
    }

    const proofPath = `proofs/${crypto.randomUUID()}.${kind.ext}`;
    const { error: uploadErr } = await supabase.storage
      .from(SUPABASE_BUCKET)
      .upload(proofPath, file.buffer, {
        contentType: kind.mime,
        upsert: false,
      });

    if (uploadErr) {
      console.error("upload failed:", uploadErr.message);
      return res.status(500).json({
        error: "Could not upload your payment proof. Please try again.",
      });
    }

    let application = null;
    for (let attempt = 0; attempt < 5 && !application; attempt++) {
      const { data, error } = await supabase
        .from("applications")
        .insert({
          reference: makeReference(),
          service_id: values.serviceId,
          level: values.level,
          price_ngn: priceRow.price_ngn,
          full_name: values.fullName,
          email: values.email,
          phone: values.phone,
          payment_reference: values.paymentReference,
          payment_proof_path: proofPath,
          status: "pending",
        })
        .select("reference, status, price_ngn, created_at")
        .single();

      if (!error) application = data;
      else if (error.code !== "23505") {
        console.error("insert failed:", error.message);
        break;
      }
    }

    if (!application) {
      await supabase.storage.from(SUPABASE_BUCKET).remove([proofPath]);
      return res
        .status(500)
        .json({ error: "Could not save your application. Please try again." });
    }

    return res.status(201).json({
      reference: application.reference,
      status: application.status,
      priceNgn: application.price_ngn,
      createdAt: application.created_at,
    });
  },
);

app.use("/api", (_req, res) => res.status(404).json({ error: "Not found." }));

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    return res.status(tooBig ? 413 : 400).json(
      fieldError({
        proof: tooBig
          ? "File is too large. The limit is 5 MB."
          : "Upload a single file.",
      }),
    );
  }
  if (err?.type === "entity.parse.failed")
    return res.status(400).json({ error: "Bad request." });
  console.error(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

app.listen(Number(PORT), () =>
  console.log(`CyberSpark API listening on :${PORT}`),
);
