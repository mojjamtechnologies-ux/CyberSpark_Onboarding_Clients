import { useEffect, useMemo, useRef, useState } from "react";
import logo from "./assets/logo.png";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

const API = (import.meta.env.VITE_API_URL || "http://localhost:4000").replace(
  /\/$/,
  "",
);
const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
const LEVELS = [
  { id: "beginner", label: "Beginner", hint: "Starting from scratch" },
  { id: "intermediate", label: "Intermediate", hint: "Know the basics" },
  { id: "advanced", label: "Advanced", hint: "Ready for depth" },
];
const ADMIN_STORAGE_KEY = "cyberspark-admin-token";
const STATUS_ORDER = ["pending", "confirmed", "rejected"];

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "";
const supabaseClient =
  SUPABASE_URL && SUPABASE_ANON_KEY
    ? createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY)
    : null;

const naira = (n) =>
  new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: "NGN",
    maximumFractionDigits: 0,
  }).format(n);

const initialForm = {
  serviceId: "",
  level: "",
  fullName: "",
  email: "",
  phone: "",
  paymentReference: "",
};

export default function App() {
  const [view, setView] = useState(() => {
    if (typeof window === "undefined") return "client";
    return new URLSearchParams(window.location.search).get("admin") === "1"
      ? "admin"
      : "client";
  });
  const [adminToken, setAdminToken] = useState(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(ADMIN_STORAGE_KEY) || "";
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (adminToken) localStorage.setItem(ADMIN_STORAGE_KEY, adminToken);
    else localStorage.removeItem(ADMIN_STORAGE_KEY);
  }, [adminToken]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="shell topbar-inner">
          <div className="brand-group">
            <img
              src={logo}
              className="brand brand-logo"
              alt="CyberSpark logo"
            />
            <span className="brand brand-mini">CyberSpark IT Solutions</span>
          </div>
          <nav className="nav-toggle" aria-label="Portal switcher">
            <button
              type="button"
              className={
                view === "client" ? "nav-button is-active" : "nav-button"
              }
              onClick={() => setView("client")}
            >
              Clients
            </button>
            <button
              type="button"
              className={
                view === "admin" ? "nav-button is-active" : "nav-button"
              }
              onClick={() => setView("admin")}
            >
              Admin | Staff
            </button>
          </nav>
        </div>
      </header>

      {view === "admin" ? (
        <AdminDashboard token={adminToken} onTokenChange={setAdminToken} />
      ) : (
        <ClientOnboarding />
      )}
    </div>
  );
}

function ClientOnboarding() {
  const [services, setServices] = useState([]);
  const [pay, setPay] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);

  const [form, setForm] = useState(initialForm);
  const [file, setFile] = useState(null);
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [result, setResult] = useState(null);
  const fileInput = useRef(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, p] = await Promise.all([
          fetch(`${API}/api/services`).then((r) =>
            r.ok ? r.json() : Promise.reject(),
          ),
          fetch(`${API}/api/payment-info`).then((r) =>
            r.ok ? r.json() : Promise.reject(),
          ),
        ]);
        if (!cancelled) {
          setServices(s.services);
          setPay(p);
        }
      } catch {
        if (!cancelled)
          setLoadError(
            "We could not load the services. Check your connection and refresh the page.",
          );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const service = useMemo(
    () => services.find((s) => s.id === form.serviceId),
    [services, form.serviceId],
  );
  const price = service && form.level ? service.prices[form.level] : null;

  const set = (name) => (e) => {
    setForm((f) => ({ ...f, [name]: e.target.value }));
    setErrors((er) => ({ ...er, [name]: undefined }));
  };
  const pick = (name, value) => {
    setForm((f) => ({ ...f, [name]: value }));
    setErrors((er) => ({ ...er, [name]: undefined }));
  };

  function onFile(e) {
    const f = e.target.files?.[0];
    setErrors((er) => ({ ...er, proof: undefined }));
    if (!f) return setFile(null);
    if (!ALLOWED.includes(f.type)) {
      setFile(null);
      e.target.value = "";
      return setErrors((er) => ({
        ...er,
        proof: "Use a JPG, PNG, WEBP or PDF file.",
      }));
    }
    if (f.size > MAX_BYTES) {
      setFile(null);
      e.target.value = "";
      return setErrors((er) => ({
        ...er,
        proof: "File is too large. The limit is 5 MB.",
      }));
    }
    setFile(f);
  }

  function validate() {
    const er = {};
    if (!form.serviceId) er.serviceId = "Choose a service.";
    if (!form.level) er.level = "Choose a level.";
    if (form.fullName.trim().length < 2) er.fullName = "Enter your full name.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim()))
      er.email = "Enter a valid email address.";
    if (!/^\+?[0-9][0-9\s-]{6,17}$/.test(form.phone.trim()))
      er.phone = "Enter a valid phone number.";
    if (form.paymentReference.trim().length < 3)
      er.paymentReference = "Enter the reference from your bank transfer.";
    if (!file) er.proof = "Upload your payment proof.";
    return er;
  }

  async function onSubmit(e) {
    e.preventDefault();
    setFormError("");
    const er = validate();
    setErrors(er);
    if (Object.keys(er).length) {
      requestAnimationFrame(() =>
        document
          .querySelector('[aria-invalid="true"], .field-error')
          ?.scrollIntoView({ block: "center", behavior: "smooth" }),
      );
      return;
    }

    const body = new FormData();
    Object.entries(form).forEach(([k, v]) => body.append(k, v.trim()));
    body.append("proof", file);

    setSubmitting(true);
    try {
      const res = await fetch(`${API}/api/applications`, {
        method: "POST",
        body,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.fields) setErrors(data.fields);
        setFormError(data.error || "Something went wrong. Please try again.");
        return;
      }
      setResult({
        ...data,
        serviceName: service.name,
        level: form.level,
        email: form.email.trim(),
      });
      window.scrollTo({ top: 0 });
    } catch {
      setFormError(
        "We could not reach the server. Check your connection and try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function reset() {
    setForm(initialForm);
    setFile(null);
    setErrors({});
    setFormError("");
    setResult(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  if (result) return <Success result={result} onReset={reset} />;

  return (
    <div className="shell">
      <header className="masthead">
        <p className="brand">Onboarding Session</p>
        <h1>Enrol for a tech training</h1>
        <p className="lede">
          Pick a service and level, pay by bank transfer, then upload your
          receipt. We confirm by email.
        </p>
      </header>

      {loading && (
        <p className="notice" role="status">
          Loading services…
        </p>
      )}
      {loadError && (
        <p className="notice notice-error" role="alert">
          {loadError}
        </p>
      )}

      {!loading && !loadError && (
        <form className="layout" onSubmit={onSubmit} noValidate>
          <div className="steps">
            <fieldset className="block">
              <legend>1. Choose a service</legend>
              <div
                className="service-grid"
                role="radiogroup"
                aria-label="Service"
              >
                {services.map((s) => (
                  <label
                    key={s.id}
                    className={`service ${form.serviceId === s.id ? "is-on" : ""}`}
                  >
                    <input
                      type="radio"
                      name="serviceId"
                      value={s.id}
                      checked={form.serviceId === s.id}
                      onChange={() => pick("serviceId", s.id)}
                    />
                    <span className="service-name">{s.name}</span>
                    <span className="service-desc">{s.description}</span>
                  </label>
                ))}
              </div>
              {errors.serviceId && (
                <p className="field-error">{errors.serviceId}</p>
              )}
            </fieldset>

            <fieldset className="block">
              <legend>2. Choose your level</legend>
              <div className="levels" role="radiogroup" aria-label="Level">
                {LEVELS.map((l) => (
                  <label
                    key={l.id}
                    className={`level ${form.level === l.id ? "is-on" : ""}`}
                  >
                    <input
                      type="radio"
                      name="level"
                      value={l.id}
                      checked={form.level === l.id}
                      onChange={() => pick("level", l.id)}
                    />
                    <span className="level-name">{l.label}</span>
                    <span className="level-hint">{l.hint}</span>
                  </label>
                ))}
              </div>
              {errors.level && <p className="field-error">{errors.level}</p>}
              {price != null && (
                <p className="price-line" aria-live="polite">
                  {service.name}, {form.level}: <strong>{naira(price)}</strong>
                </p>
              )}
            </fieldset>

            <fieldset className="block">
              <legend>3. Your details</legend>
              <Field label="Full name" error={errors.fullName}>
                <input
                  type="text"
                  autoComplete="name"
                  value={form.fullName}
                  onChange={set("fullName")}
                  aria-invalid={!!errors.fullName}
                  maxLength={100}
                />
              </Field>
              <div className="two">
                <Field label="Email" error={errors.email}>
                  <input
                    type="email"
                    autoComplete="email"
                    inputMode="email"
                    value={form.email}
                    onChange={set("email")}
                    aria-invalid={!!errors.email}
                    maxLength={254}
                  />
                </Field>
                <Field label="Phone number" error={errors.phone}>
                  <input
                    type="tel"
                    autoComplete="tel"
                    inputMode="tel"
                    placeholder="0803 000 0000"
                    value={form.phone}
                    onChange={set("phone")}
                    aria-invalid={!!errors.phone}
                    maxLength={20}
                  />
                </Field>
              </div>
            </fieldset>

            <fieldset className="block">
              <legend>4. Pay and upload proof</legend>
              {pay && (
                <dl className="bank">
                  <div>
                    <dt>Bank</dt>
                    <dd>{pay.bankName}</dd>
                  </div>
                  <div>
                    <dt>Account name</dt>
                    <dd>{pay.accountName}</dd>
                  </div>
                  <div>
                    <dt>Account number</dt>
                    <dd className="mono">{pay.accountNumber}</dd>
                  </div>
                  <div>
                    <dt>Amount</dt>
                    <dd>
                      {price != null ? (
                        <strong>{naira(price)}</strong>
                      ) : (
                        "Choose a service and level first"
                      )}
                    </dd>
                  </div>
                </dl>
              )}
              {pay?.note && <p className="help">{pay.note}</p>}

              <Field
                label="Payment reference"
                help="The reference or session ID on your bank receipt."
                error={errors.paymentReference}
              >
                <input
                  type="text"
                  value={form.paymentReference}
                  onChange={set("paymentReference")}
                  aria-invalid={!!errors.paymentReference}
                  maxLength={64}
                />
              </Field>

              <Field
                label="Payment proof"
                help="JPG, PNG, WEBP or PDF. Up to 5 MB."
                error={errors.proof}
              >
                <input
                  ref={fileInput}
                  type="file"
                  accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf"
                  onChange={onFile}
                  aria-invalid={!!errors.proof}
                />
              </Field>
              {file && (
                <p className="file-chip">
                  {file.name} · {(file.size / 1024).toFixed(0)} KB
                </p>
              )}
            </fieldset>
          </div>

          <aside className="summary" aria-label="Order summary">
            <h2>Summary</h2>
            <dl>
              <div>
                <dt>Service</dt>
                <dd>{service?.name ?? "—"}</dd>
              </div>
              <div>
                <dt>Level</dt>
                <dd className="cap">{form.level || "—"}</dd>
              </div>
              <div className="total">
                <dt>Total</dt>
                <dd>{price != null ? naira(price) : "—"}</dd>
              </div>
            </dl>
            {formError && (
              <p className="notice notice-error" role="alert">
                {formError}
              </p>
            )}
            <button className="submit" type="submit" disabled={submitting}>
              {submitting ? "Submitting…" : "Submit application"}
            </button>
            <p className="help">
              We check your payment manually. You will get an email once it is
              confirmed.
            </p>
          </aside>
        </form>
      )}
    </div>
  );
}

function Field({ label, help, error, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {help && !error && <span className="help">{help}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

function Success({ result, onReset }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(result.reference);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — the reference is visible on screen
    }
  }
  return (
    <div className="shell">
      <main className="success">
        <p className="brand">CyberSpark IT Solutions</p>
        <h1>Application received</h1>
        <p className="lede">
          We have your payment proof for <strong>{result.serviceName}</strong> (
          {result.level}). We will review it and email{" "}
          <strong>{result.email}</strong> when your place is confirmed.
        </p>

        <div className="ref-card">
          <span className="field-label">Your application reference</span>
          <p className="ref mono">{result.reference}</p>
          <button type="button" className="ghost" onClick={copy}>
            {copied ? "Copied" : "Copy reference"}
          </button>
        </div>

        <dl className="bank">
          <div>
            <dt>Amount paid</dt>
            <dd>{naira(result.priceNgn)}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <span className="badge">Pending review</span>
            </dd>
          </div>
        </dl>

        <p className="help">
          Keep this reference. Quote it if you contact us about your
          application.
        </p>
        <button type="button" className="submit" onClick={onReset}>
          Start another application
        </button>
      </main>
    </div>
  );
}

function AdminDashboard({ token, onTokenChange }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [applications, setApplications] = useState([]);
  const [summary, setSummary] = useState({
    total: 0,
    pending: 0,
    confirmed: 0,
    rejected: 0,
  });
  const [actionBusyId, setActionBusyId] = useState("");

  const loadApplications = async () => {
    if (!token) return;
    setLoading(true);
    try {
      const query = statusFilter === "all" ? "" : `?status=${statusFilter}`;
      const res = await fetch(`${API}/api/admin/applications${query}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || "Unable to load applications.");
      }
      setApplications(data.applications || []);
      setSummary(
        data.summary || { total: 0, pending: 0, confirmed: 0, rejected: 0 },
      );
    } catch (error) {
      setLoginError(error.message || "Unable to load applications.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadApplications();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, statusFilter]);

  async function handleLogin(e) {
    e.preventDefault();
    setLoginError("");
    setIsSubmitting(true);
    try {
      if (!supabaseClient)
        throw new Error("Supabase is not configured on the client.");
      const { data, error } = await supabaseClient.auth.signInWithPassword({
        email: String(email || "").trim(),
        password: String(password || ""),
      });
      if (error || !data?.session?.access_token)
        throw new Error(error?.message || "Sign-in failed");
      onTokenChange(data.session.access_token);
    } catch (error) {
      setLoginError(
        error.message || "Could not sign in to the admin dashboard.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  const logout = () => {
    onTokenChange("");
    setEmail("");
    setPassword("");
    if (supabaseClient) supabaseClient.auth.signOut().catch(() => {});
    setApplications([]);
    setSummary({ total: 0, pending: 0, confirmed: 0, rejected: 0 });
    setLoginError("");
  };

  async function updateStatus(appId, nextStatus) {
    if (!token) return;
    setActionBusyId(appId);
    try {
      const res = await fetch(`${API}/api/admin/applications/${appId}/status`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok)
        throw new Error(
          data.error || "Could not update the application status.",
        );
      await loadApplications();
    } catch (error) {
      setLoginError(error.message || "Status update failed.");
    } finally {
      setActionBusyId("");
    }
  }

  const filteredApplications = applications.filter((item) => {
    const haystack =
      `${item.fullName} ${item.email} ${item.reference} ${item.serviceName}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  });

  if (!token) {
    return (
      <main className="shell admin-shell">
        <div className="panel login-card">
          <p className="brand">Admin access</p>
          <h1>Review applications</h1>
          <p className="lede">
            Sign in with your admin access to review applications.
          </p>
          <form className="admin-form" onSubmit={handleLogin}>
            <label className="field">
              <span className="field-label">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@example.com"
                autoComplete="username"
              />
            </label>
            <label className="field">
              <span className="field-label">Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </label>
            {loginError && <p className="field-error">{loginError}</p>}
            <button className="submit" type="submit" disabled={isSubmitting}>
              {isSubmitting ? "Signing in…" : "Open dashboard"}
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="shell admin-shell">
      <div className="panel admin-header">
        <div>
          <p className="brand">Admin dashboard</p>
          <h1>Applications</h1>
        </div>
        <button type="button" className="ghost" onClick={logout}>
          Log out
        </button>
      </div>

      <section className="stats-grid" aria-label="Application summary">
        <div className="stat-card">
          <span>Total</span>
          <strong>{summary.total}</strong>
        </div>
        <div className="stat-card pending">
          <span>Pending</span>
          <strong>{summary.pending}</strong>
        </div>
        <div className="stat-card confirmed">
          <span>Confirmed</span>
          <strong>{summary.confirmed}</strong>
        </div>
        <div className="stat-card rejected">
          <span>Rejected</span>
          <strong>{summary.rejected}</strong>
        </div>
      </section>

      <div className="panel admin-toolbar">
        <div className="filter-row">
          <label className="field compact-field">
            <span className="field-label">Search</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, email or reference"
            />
          </label>
          <label className="field compact-field">
            <span className="field-label">Status</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="all">All</option>
              {STATUS_ORDER.map((status) => (
                <option key={status} value={status}>
                  {status[0].toUpperCase() + status.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {loginError && <p className="notice notice-error">{loginError}</p>}
      {loading ? (
        <p className="notice" role="status">
          Loading applications…
        </p>
      ) : (
        <div className="panel table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Applicant</th>
                <th>Service</th>
                <th>Price</th>
                <th>Status</th>
                <th>Proof</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredApplications.length === 0 ? (
                <tr>
                  <td colSpan="7" className="empty-table">
                    No applications match your filters.
                  </td>
                </tr>
              ) : (
                filteredApplications.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div className="applicant-cell">
                        <strong>{item.fullName}</strong>
                        <span>{item.email}</span>
                        <span className="mono">{item.reference}</span>
                      </div>
                    </td>
                    <td>
                      <div className="service-cell">
                        <strong>{item.serviceName}</strong>
                        <span>{item.level}</span>
                      </div>
                    </td>
                    <td>{naira(item.priceNgn)}</td>
                    <td>
                      <span className={`status-pill ${item.status}`}>
                        {item.status}
                      </span>
                    </td>
                    <td>
                      {item.proofUrl ? (
                        <a
                          href={item.proofUrl}
                          target="_blank"
                          rel="noreferrer"
                        >
                          Open file
                        </a>
                      ) : (
                        <span className="muted">Unavailable</span>
                      )}
                    </td>
                    <td>{new Date(item.updatedAt).toLocaleString()}</td>
                    <td>
                      <div className="admin-actions">
                        {STATUS_ORDER.filter(
                          (status) => status !== item.status,
                        ).map((status) => (
                          <button
                            key={status}
                            type="button"
                            className="mini-action"
                            disabled={actionBusyId === item.id}
                            onClick={() => updateStatus(item.id, status)}
                          >
                            {actionBusyId === item.id
                              ? "Saving…"
                              : `Mark ${status}`}
                          </button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
