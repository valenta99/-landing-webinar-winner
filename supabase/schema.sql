-- Panel de admin de la landing de registro (correr una vez en Supabase -> SQL Editor).
-- Tablas prefijadas "mc_" para poder convivir en un proyecto Supabase que ya tenga
-- otras (webinar_*, pb_*, etc.).

-- Registros del form. Se guardan SIEMPRE, aunque GHL falle: es la fuente de verdad
-- del panel y permite reintentar a mano los que no llegaron a GHL.
create table if not exists public.mc_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text,
  email text not null,
  phone text,
  vid text,                                   -- id de visitante (localStorage), une el lead con sus visitas
  tracking jsonb not null default '{}'::jsonb, -- utm_*, fbclid, gclid, etc. tal cual venían en la URL
  page text,                                   -- referer del submit
  ghl_contact_id text,
  ghl_opportunity_id text,
  ghl_status text                              -- 'ok' o 'error: <detalle>'
);
alter table public.mc_leads enable row level security;
-- Sin políticas públicas a propósito: solo se accede server-side con la service_role.
create index if not exists mc_leads_email_idx on public.mc_leads (email);
create index if not exists mc_leads_created_idx on public.mc_leads (created_at desc);

-- Visitas: beacon propio en la landing y en la página de gracias.
create table if not exists public.mc_hits (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  path text not null,
  vid text,
  source text                                  -- utm_source
);
alter table public.mc_hits enable row level security;
create index if not exists mc_hits_created_idx on public.mc_hits (created_at desc);
create index if not exists mc_hits_path_idx on public.mc_hits (path);
