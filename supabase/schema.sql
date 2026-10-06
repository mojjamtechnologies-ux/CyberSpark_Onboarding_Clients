-- CyberSpark IT Solutions — Client Onboarding
-- Run this whole file in the Supabase SQL editor.
-- PRICES BELOW ARE PLACEHOLDERS (NGN). Edit them before going live.

create extension if not exists pgcrypto;

-- ---------- Types ----------
do $$ begin
  create type skill_level as enum ('beginner', 'intermediate', 'advanced');
exception when duplicate_object then null; end $$;

do $$ begin
  create type application_status as enum ('pending', 'confirmed', 'rejected');
exception when duplicate_object then null; end $$;

-- ---------- Tables ----------
create table if not exists services (
  id          text primary key,
  name        text not null,
  description text not null,
  sort_order  int  not null default 0,
  active      boolean not null default true
);

create table if not exists service_prices (
  service_id text        not null references services(id) on delete cascade,
  level      skill_level not null,
  price_ngn  integer     not null check (price_ngn >= 0),
  duration_months integer not null default 0,
  duration_minutes integer,
  primary key (service_id, level)
);

create table if not exists applications (
  id                 uuid primary key default gen_random_uuid(),
  reference          text unique not null,
  service_id         text not null references services(id),
  level              skill_level not null,
  price_ngn          integer not null check (price_ngn >= 0),
  duration_months    integer not null default 0,
  duration_minutes   integer,
  full_name          text not null,
  email              text not null,
  phone              text not null,
  coupon_code        text,
  payment_reference  text not null,
  payment_proof_path text not null,
  status             application_status not null default 'pending',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists applications_status_idx  on applications (status);
create index if not exists applications_created_idx on applications (created_at desc);
create index if not exists applications_email_idx   on applications (lower(email));

create or replace function set_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

drop trigger if exists applications_updated_at on applications;
create trigger applications_updated_at before update on applications
  for each row execute function set_updated_at();

-- ---------- Security ----------
-- The Express server uses the service-role key, which bypasses RLS.
-- With RLS on and no policies, the public anon key can read/write nothing.
alter table services       enable row level security;
alter table service_prices enable row level security;
alter table applications   enable row level security;

-- ---------- Private storage bucket for payment proofs ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'payment-proofs', 'payment-proofs', false, 5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do nothing;

-- ---------- Seed: 10 services (placeholder copy + prices, NGN) ----------
insert into services (id, name, description, sort_order) values
  ('web-development',   'Web Development',            'Build and ship responsive websites and web apps.',          1),
  ('mobile-apps',       'Mobile App Development',     'Create Android and iOS apps with React Native.',            2),
  ('cybersecurity',     'Cybersecurity',              'Protect systems, networks and data from attack.',           3),
  ('artificial',        'AI & Automations',           'Leverage artificial intelligence for automation.',          4),
  ('cloud-computing',   'Cloud Computing',            'Deploy and run workloads on modern cloud platforms.',       5),
  ('data-analysis',     'Data Analysis',              'Clean, analyse and present data with real tools.',          6),
  ('ui-ux-design',      'UI/UX Design',               'Research, wireframe and design usable interfaces.',         7),
  ('graphics-design',   'Graphics Design',            'Make logos, flyers and brand assets people remember.',      8),
  ('hardware-repair',   'Computer Hardware & Repair', 'Diagnose, repair and upgrade computers and devices.',       9),
  ('digital-marketing', 'Digital Marketing',          'Grow a business with social, search and email marketing.',  10),
  ('desktop-publication', 'Desktop Publishing',        'Design and layout books, magazines and brochures.',         11),
  ('it-consulting',     'IT Consulting',              'Advise businesses on IT strategy and solutions.',           12),
  ('programming',        'Programming & Scripting',    'Write scripts and programs to automate tasks.',             13)
on conflict (id) do nothing;

insert into service_prices (service_id, level, price_ngn)
select s.id, l.level, (round(p.base * l.mult / 500.0) * 500)::integer
from services s
join (values
  ('web-development',   100000),
  ('mobile-apps',       150000),
  ('cybersecurity',     150000),
  ('artificial',        100000),
  ('cloud-computing',   200000),
  ('data-analysis',     200000),
  ('ui-ux-design',      100000),
  ('graphics-design',   100000),
  ('hardware-repair',   120000),
  ('digital-marketing', 100000),
  ('desktop-publication', 80000),
  ('it-consulting',     50000),
  ('programming',        80000)
) as p(service_id, base) on p.service_id = s.id
cross join (values
  ('beginner'::skill_level, 1.0),
  ('intermediate'::skill_level, 1.5),
  ('advanced'::skill_level, 2.0)
) as l(level, mult)
on conflict (service_id, level) do nothing;

-- To change a price later:
--   update service_prices set price_ngn = 80000
--   where service_id = 'web-development' and level = 'beginner';

-- ---------- Admins table (for dashboard auth) ----------
-- Stores admin email addresses. After running this SQL create an admin
-- row with the email of an account you will use to sign in via Supabase Auth.
create table if not exists admins (
  id   uuid primary key default gen_random_uuid(),
  email text not null unique,
  created_at timestamptz not null default now()
);

-- Example insert (run in SQL editor and replace with a real email):
-- insert into admins (email) values ('admin@example.com') on conflict do nothing;

-- ---------- Settings table (for global app config like banner) ----------
create table if not exists settings (
  key   text primary key,
  value text,
  updated_at timestamptz not null default now()
);

alter table settings enable row level security;

-- Insert default banner URL (can be updated by admins)
insert into settings (key, value) values
  ('banner_image_url', 'https://images.unsplash.com/photo-1552664730-d307ca884978?w=1200&h=300&fit=crop')
on conflict (key) do nothing;

-- ---------- Coupons table (promo codes for discounts) ----------
create table if not exists coupons (
  code text primary key,
  discount_type text not null default 'percentage' check (discount_type in ('percentage', 'fixed')),
  discount_percent integer not null default 0 check (discount_percent >= 0 and discount_percent <= 100),
  discount_amount integer not null default 0 check (discount_amount >= 0),
  max_redemptions integer not null default 1,
  redeemed integer not null default 0,
  expires_at timestamptz,
  active boolean not null default true,
  created_by uuid references admins(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table coupons enable row level security;

-- Example: insert into coupons (code, discount_type, discount_percent, discount_amount, max_redemptions) values ('WELCOME10', 'percentage', 10, 0, 100);
-- Example: insert into coupons (code, discount_type, discount_percent, discount_amount, max_redemptions) values ('SAVE500', 'fixed', 0, 500, 100);

alter table service_prices
  add column if not exists duration_months integer default 0;

alter table applications
  add column if not exists duration_months integer default 0;

alter table service_prices
  add column if not exists duration_minutes integer;

alter table applications
  add column if not exists duration_minutes integer;

-- Backfill from legacy column names if they already exist.
update service_prices
set duration_months = coalesce(duration_months, duration_minutes, 0)
where duration_months is null or duration_minutes is not null;

update applications
set duration_months = coalesce(duration_months, duration_minutes, 0)
where duration_months is null or duration_minutes is not null;
