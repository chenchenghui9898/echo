-- Echo phase 1: core product schema and access control.
-- Existing .echo-data JSON remains the application's active data source.

create extension if not exists pgcrypto with schema extensions;

create type public.post_content_type as enum ('viewpoint', 'work', 'diary');
create type public.post_status as enum ('published', 'deleted');
create type public.chat_sender_type as enum ('human', 'ai', 'legacy');
create type public.chat_message_status as enum ('normal', 'deleted');
create type public.chat_ai_task_status as enum (
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled'
);

create or replace function public.is_admin()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin';
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  avatar_path text,
  bio text not null default '',
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint profiles_display_name_length check (char_length(display_name) between 1 and 80),
  constraint profiles_avatar_path_length check (avatar_path is null or char_length(avatar_path) <= 1024),
  constraint profiles_bio_length check (char_length(bio) <= 500)
);

create or replace function public.create_profile_for_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_name text;
begin
  requested_name := nullif(btrim(new.raw_user_meta_data ->> 'display_name'), '');
  insert into public.profiles (id, display_name)
  values (
    new.id,
    left(coalesce(requested_name, 'Echo 用户·' || left(new.id::text, 4)), 80)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger create_profile_after_auth_user
after insert on auth.users
for each row execute function public.create_profile_for_auth_user();

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

create table public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete restrict,
  content_type public.post_content_type not null,
  title text,
  body text not null,
  status public.post_status not null default 'published',
  published_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  constraint posts_title_length check (title is null or char_length(title) <= 120),
  constraint posts_body_length check (char_length(body) between 1 and 30000),
  constraint posts_deleted_state check (
    (status = 'published' and deleted_at is null)
    or (status = 'deleted' and deleted_at is not null)
  )
);

create index posts_public_feed_idx
  on public.posts (published_at desc, id desc)
  where status = 'published';
create index posts_user_idx on public.posts (user_id, created_at desc);

create trigger posts_set_updated_at
before update on public.posts
for each row execute function public.set_updated_at();

create table public.ai_personas (
  id text primary key,
  display_name text not null,
  avatar_path text,
  bio text not null default '',
  enabled boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint ai_personas_id_format check (id ~ '^[a-z][a-z0-9_-]{1,63}$'),
  constraint ai_personas_display_name_length check (char_length(display_name) between 1 and 80),
  constraint ai_personas_avatar_path_length check (avatar_path is null or char_length(avatar_path) <= 1024),
  constraint ai_personas_bio_length check (char_length(bio) <= 1000)
);

create trigger ai_personas_set_updated_at
before update on public.ai_personas
for each row execute function public.set_updated_at();

create table public.ai_persona_versions (
  id uuid primary key default gen_random_uuid(),
  persona_id text not null references public.ai_personas(id) on delete cascade,
  version integer not null,
  configuration jsonb not null,
  is_current boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  constraint ai_persona_versions_positive_version check (version > 0),
  constraint ai_persona_versions_configuration_object check (jsonb_typeof(configuration) = 'object'),
  constraint ai_persona_versions_unique unique (persona_id, version)
);

create unique index ai_persona_versions_one_current_idx
  on public.ai_persona_versions (persona_id)
  where is_current;
create index ai_persona_versions_persona_idx
  on public.ai_persona_versions (persona_id, version desc);

create table public.chat_rooms (
  id text primary key,
  room_type text not null,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint chat_rooms_id_format check (id ~ '^[a-z][a-z0-9_-]{1,63}$'),
  constraint chat_rooms_type_public_mood check (room_type = 'public_mood'),
  constraint chat_rooms_single_public_mood unique (room_type),
  constraint chat_rooms_name_length check (char_length(name) between 1 and 80)
);

create trigger chat_rooms_set_updated_at
before update on public.chat_rooms
for each row execute function public.set_updated_at();

insert into public.chat_rooms (id, room_type, name)
values ('echo-public-mood', 'public_mood', '此刻');

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references public.chat_rooms(id) on delete restrict,
  sender_type public.chat_sender_type not null,
  user_id uuid references public.profiles(id) on delete restrict,
  persona_id text references public.ai_personas(id) on delete restrict,
  legacy_sender_id text,
  sender_name_snapshot text not null,
  sender_avatar_snapshot text,
  content text not null,
  reply_to_message_id uuid,
  status public.chat_message_status not null default 'normal',
  persona_version integer,
  model_config_snapshot jsonb,
  prompt_version text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  deleted_at timestamptz,
  constraint chat_messages_id_room_unique unique (id, room_id),
  constraint chat_messages_reply_same_room foreign key (reply_to_message_id, room_id)
    references public.chat_messages(id, room_id) on delete restrict,
  constraint chat_messages_sender_name_length check (char_length(sender_name_snapshot) between 1 and 80),
  constraint chat_messages_sender_avatar_length check (
    sender_avatar_snapshot is null or char_length(sender_avatar_snapshot) <= 1024
  ),
  constraint chat_messages_content_length check (char_length(content) between 1 and 1000),
  constraint chat_messages_legacy_sender_length check (
    legacy_sender_id is null or char_length(legacy_sender_id) <= 128
  ),
  constraint chat_messages_exactly_one_sender check (
    (sender_type = 'human' and user_id is not null and persona_id is null and legacy_sender_id is null)
    or (sender_type = 'ai' and user_id is null and persona_id is not null and legacy_sender_id is null)
    or (sender_type = 'legacy' and user_id is null and persona_id is null and legacy_sender_id is not null)
  ),
  constraint chat_messages_ai_provenance check (
    sender_type <> 'ai'
    or (persona_version is not null and persona_version > 0 and model_config_snapshot is not null and prompt_version is not null)
  ),
  constraint chat_messages_model_config_object check (
    model_config_snapshot is null or jsonb_typeof(model_config_snapshot) = 'object'
  ),
  constraint chat_messages_deleted_state check (
    (status = 'normal' and deleted_at is null)
    or (status = 'deleted' and deleted_at is not null)
  )
);

create index chat_messages_room_timeline_idx
  on public.chat_messages (room_id, created_at desc, id desc)
  where status = 'normal';
create index chat_messages_reply_idx
  on public.chat_messages (reply_to_message_id)
  where reply_to_message_id is not null;
create index chat_messages_user_idx
  on public.chat_messages (user_id, created_at desc)
  where user_id is not null;
create index chat_messages_persona_idx
  on public.chat_messages (persona_id, created_at desc)
  where persona_id is not null;

create trigger chat_messages_set_updated_at
before update on public.chat_messages
for each row execute function public.set_updated_at();

create table public.chat_ai_tasks (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references public.chat_rooms(id) on delete restrict,
  trigger_message_id uuid not null,
  persona_id text not null references public.ai_personas(id) on delete restrict,
  persona_version integer not null,
  scheduled_at timestamptz not null,
  status public.chat_ai_task_status not null default 'pending',
  retry_count integer not null default 0,
  chain_depth integer not null default 1,
  created_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  generated_at timestamptz,
  generated_message_id uuid,
  execution_token uuid,
  last_error text,
  model_config_snapshot jsonb not null,
  prompt_version text not null,
  constraint chat_ai_tasks_trigger_same_room foreign key (trigger_message_id, room_id)
    references public.chat_messages(id, room_id) on delete restrict,
  constraint chat_ai_tasks_generated_message_fk foreign key (generated_message_id, room_id)
    references public.chat_messages(id, room_id) on delete restrict,
  constraint chat_ai_tasks_persona_version_positive check (persona_version > 0),
  constraint chat_ai_tasks_retry_count_nonnegative check (retry_count >= 0),
  constraint chat_ai_tasks_chain_depth_positive check (chain_depth between 1 and 10),
  constraint chat_ai_tasks_model_config_object check (jsonb_typeof(model_config_snapshot) = 'object'),
  constraint chat_ai_tasks_generated_message_unique unique (generated_message_id)
);

create index chat_ai_tasks_due_idx
  on public.chat_ai_tasks (scheduled_at, id)
  where status = 'pending';
create index chat_ai_tasks_trigger_idx on public.chat_ai_tasks (trigger_message_id);
create index chat_ai_tasks_persona_idx on public.chat_ai_tasks (persona_id, created_at desc);
create unique index chat_ai_tasks_active_trigger_persona_idx
  on public.chat_ai_tasks (trigger_message_id, persona_id, chain_depth)
  where status in ('pending', 'processing', 'completed');

-- RLS is enabled on every client-facing business table. The service_role used by
-- trusted AI workers bypasses RLS; its key must never be exposed to the browser.
alter table public.profiles enable row level security;
alter table public.posts enable row level security;
alter table public.ai_personas enable row level security;
alter table public.ai_persona_versions enable row level security;
alter table public.chat_rooms enable row level security;
alter table public.chat_messages enable row level security;
alter table public.chat_ai_tasks enable row level security;

revoke all on table public.profiles from anon, authenticated;
revoke all on table public.posts from anon, authenticated;
revoke all on table public.ai_personas from anon, authenticated;
revoke all on table public.ai_persona_versions from anon, authenticated;
revoke all on table public.chat_rooms from anon, authenticated;
revoke all on table public.chat_messages from anon, authenticated;
revoke all on table public.chat_ai_tasks from anon, authenticated;

grant select on table public.profiles to anon, authenticated;
grant update (display_name, avatar_path, bio) on table public.profiles to authenticated;

grant select on table public.posts to anon, authenticated;
grant insert, update on table public.posts to authenticated;

grant select on table public.ai_personas to anon, authenticated;
grant insert, update, delete on table public.ai_personas to authenticated;
grant select, insert, update, delete on table public.ai_persona_versions to authenticated;

grant select on table public.chat_rooms to anon, authenticated;

grant select on table public.chat_messages to anon, authenticated;
grant insert (
  room_id,
  sender_type,
  user_id,
  sender_name_snapshot,
  sender_avatar_snapshot,
  content,
  reply_to_message_id
) on table public.chat_messages to authenticated;
grant update (content, status, deleted_at) on table public.chat_messages to authenticated;

grant select on table public.chat_ai_tasks to authenticated;

create policy profiles_public_read
on public.profiles for select
to anon, authenticated
using (true);

create policy profiles_update_self
on public.profiles for update
to authenticated
using (auth.uid() is not null and id = auth.uid())
with check (auth.uid() is not null and id = auth.uid());

create policy profiles_admin_update
on public.profiles for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy posts_public_read_published
on public.posts for select
to anon, authenticated
using (status = 'published');

create policy posts_owner_read_deleted
on public.posts for select
to authenticated
using (auth.uid() is not null and user_id = auth.uid());

create policy posts_admin_read_all
on public.posts for select
to authenticated
using (public.is_admin());

create policy posts_insert_own
on public.posts for insert
to authenticated
with check (auth.uid() is not null and user_id = auth.uid() and status = 'published' and deleted_at is null);

create policy posts_update_own
on public.posts for update
to authenticated
using (auth.uid() is not null and user_id = auth.uid())
with check (auth.uid() is not null and user_id = auth.uid());

create policy posts_admin_write
on public.posts for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy ai_personas_public_read_enabled
on public.ai_personas for select
to anon, authenticated
using (enabled or public.is_admin());

create policy ai_personas_admin_write
on public.ai_personas for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy ai_persona_versions_admin_all
on public.ai_persona_versions for all
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy chat_rooms_public_read_active
on public.chat_rooms for select
to anon, authenticated
using (is_active or public.is_admin());

create policy chat_messages_public_read_normal
on public.chat_messages for select
to anon, authenticated
using (status = 'normal');

create policy chat_messages_owner_read_deleted
on public.chat_messages for select
to authenticated
using (sender_type = 'human' and auth.uid() is not null and user_id = auth.uid());

create policy chat_messages_admin_read_all
on public.chat_messages for select
to authenticated
using (public.is_admin());

create policy chat_messages_insert_human_self
on public.chat_messages for insert
to authenticated
with check (
  auth.uid() is not null
  and sender_type = 'human'
  and user_id = auth.uid()
  and persona_id is null
  and legacy_sender_id is null
  and status = 'normal'
  and deleted_at is null
  and persona_version is null
  and model_config_snapshot is null
  and prompt_version is null
);

create policy chat_messages_update_human_self
on public.chat_messages for update
to authenticated
using (sender_type = 'human' and auth.uid() is not null and user_id = auth.uid())
with check (sender_type = 'human' and auth.uid() is not null and user_id = auth.uid());

create policy chat_messages_admin_update
on public.chat_messages for update
to authenticated
using (public.is_admin())
with check (public.is_admin());

create policy chat_ai_tasks_admin_read
on public.chat_ai_tasks for select
to authenticated
using (public.is_admin());

comment on table public.profiles is 'Public profile data for Supabase Auth users, including anonymous Auth users.';
comment on table public.posts is 'Viewpoints, works, and diaries authored by human users.';
comment on table public.ai_personas is 'Public identity for AI personas; never linked to auth.users.';
comment on table public.ai_persona_versions is 'Immutable versioned AI persona configuration.';
comment on table public.chat_rooms is 'Chat rooms; phase 1 permits exactly one public mood room.';
comment on table public.chat_messages is 'Human, AI, and migrated legacy messages with reply relationships.';
comment on table public.chat_ai_tasks is 'Private persistent delayed-AI task queue for trusted workers.';
