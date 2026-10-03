# CyberSpark IT Solutions — Client Onboarding

React (Vite) + Express + Supabase (PostgreSQL + private Storage).

Clients pick a service and level, see the price, pay by bank transfer, then submit their details with a payment reference and proof (JPG, PNG, WEBP or PDF, max 5 MB). Each application gets a reference like `CS-20261001-A3F92C` and starts as `pending`.

## Structure

```
client/     React + Vite front end
server/     Express API (validation, price check, uploads)
supabase/   schema.sql — tables, private bucket, seed data
```

## Setup

### 1. Supabase

1. Create a project at supabase.com.
2. Open **SQL Editor**, paste `supabase/schema.sql`, run it.
   This creates the tables, the private `payment-proofs` bucket, and 10 placeholder services with prices.
3. Copy your **Project URL** and **service_role key** (Project Settings → API).

### 2. Server

```bash
cd server
cp .env.example .env     # fill in Supabase keys, admin token, and bank details
npm install
npm run dev              # http://localhost:4000
```

Requires Node 20.6+.

### 3. Client

```bash
cd client
cp .env.example .env     # VITE_API_URL=http://localhost:4000
npm install
npm run dev              # http://localhost:5173
```

## Admin dashboard

The project now includes an admin dashboard in the client app.

Two admin flows are supported. Recommended: use Supabase Auth for real admin users.

Supabase Auth (recommended):

1. Enable Email/Password sign-in in your Supabase project's Authentication settings.
2. Create an admin user in Supabase (Auth → Users) or have the admin sign up.
3. In the SQL editor, add the admin's email to the `admins` table created by `supabase/schema.sql`:
   `insert into admins (email) values ('admin@example.com') on conflict do nothing;`
4. In the client, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `client/.env` so the dashboard can sign in.
5. Start the server and client, open the app and switch to **Admin dashboard**, then sign in with the admin account.

Fallback static token (not recommended for production):

1. Set a secure `ADMIN_ACCESS_TOKEN` in `server/.env`.
2. Open the app and use the token to sign in to the dashboard.

Proofs open as signed Supabase URLs for review.

## Change prices and services

Prices are placeholders. Edit them in `supabase/schema.sql` before the first run, or later in SQL:

```sql
update service_prices set price_ngn = 80000
where service_id = 'web-development' and level = 'beginner';
```

Bank details live in `server/.env` (`BANK_NAME`, `BANK_ACCOUNT_NAME`, `BANK_ACCOUNT_NUMBER`).

## API

| Method | Path                                 | Purpose                                     |
| ------ | ------------------------------------ | ------------------------------------------- |
| GET    | `/api/services`                      | Active services with prices per level       |
| GET    | `/api/payment-info`                  | Bank instructions                           |
| POST   | `/api/applications`                  | Submit an application (multipart/form-data) |
| POST   | `/api/admin/login`                   | Verify the admin token                      |
| GET    | `/api/admin/applications`            | Load all applications for the dashboard     |
| PATCH  | `/api/admin/applications/:id/status` | Change application status                   |

`POST` fields: `serviceId`, `level`, `fullName`, `email`, `phone`, `paymentReference`, and file field `proof`.

## Security notes

- Price is looked up in the database on every submission; the browser's price is never trusted.
- Uploaded files are identified by their actual bytes, not the filename or declared type.
- Proofs go to a **private** bucket. The service-role key stays on the server only.
- RLS is enabled with no public policies, so the anon key cannot read applications.
- Rate limits: 120 requests per 15 minutes, and 10 submissions per hour per IP. Set `TRUST_PROXY=1` behind a proxy.
- Set `CLIENT_ORIGIN` to your real front-end URL in production.
- Admin access is protected via a server-side bearer token configured as `ADMIN_ACCESS_TOKEN`.

## Suggested next step

If you want a more production-ready admin flow, add real authentication (Supabase Auth or a dedicated admin user table), email notifications, and audit logs.

## Deploy to Vercel

This project is best deployed as two separate services:

- Frontend: Vercel static site from `client/`
- Backend API: separate Node/Express deployment (for example Vercel serverless or another host)

### Frontend on Vercel

1. Import the repo into Vercel.
2. Set the project root to the repository root.
3. Set the framework preset to Vite.
4. Set the project directory to `client` if prompted.
5. Add environment variables in Vercel:
   - `VITE_API_URL` = your deployed backend URL, e.g. `https://your-api-domain.com`
   - `VITE_SUPABASE_URL` = your Supabase project URL
   - `VITE_SUPABASE_ANON_KEY` = your Supabase anon key
6. Deploy.

The `client/vercel.json` file ensures SPA routes fall back to `index.html`.

### Backend deployment

The Express app in `server/` must run on a host that supports Node 20.6+ and environment variables.

Set these production env vars in your backend deployment:

```bash
PORT=4000
CLIENT_ORIGIN=https://your-vercel-app.vercel.app
TRUST_PROXY=1
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
SUPABASE_BUCKET=payment-proofs
ADMIN_ACCESS_TOKEN=strong-random-token
BANK_NAME=Your Bank Name
BANK_ACCOUNT_NAME=CyberSpark IT Solutions
BANK_ACCOUNT_NUMBER=0000000000
PAYMENT_NOTE=Use your full name as the transfer narration, then upload the receipt.
```

Then update the frontend `VITE_API_URL` to match the deployed backend URL.
# CyberSpark_Onboarding_Clients
