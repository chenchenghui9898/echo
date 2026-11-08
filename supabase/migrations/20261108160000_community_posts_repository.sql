-- Durable production repository for viewpoints, works, diaries, their AI
-- generation provenance, comments, and delayed comment tasks.

create table public.post_inputs (
  id uuid primary key,
  post_id uuid not null unique references public.posts(id) on delete cascade,
  content text not null,
  character_count integer not null check (character_count >= 0),
  created_at timestamptz not null default timezone('utc', now())
);

create table public.post_content_analyses (
  id uuid primary key,
  post_id uuid not null unique references public.posts(id) on delete cascade,
  input_id uuid not null references public.post_inputs(id) on delete cascade,
  analysis jsonb not null check (jsonb_typeof(analysis) = 'object'),
  prompt_snapshot jsonb not null check (jsonb_typeof(prompt_snapshot) = 'object'),
  model_config_snapshot jsonb not null check (jsonb_typeof(model_config_snapshot) = 'object'),
  token_usage jsonb check (token_usage is null or jsonb_typeof(token_usage) = 'object'),
  source text not null check (source in ('model', 'fallback')),
  error_message text,
  created_at timestamptz not null default timezone('utc', now())
);

create table public.post_generation_runs (
  id uuid primary key,
  post_id uuid not null unique references public.posts(id) on delete cascade,
  input_id uuid not null references public.post_inputs(id) on delete cascade,
  prompt_version_id uuid not null,
  prompt_snapshot jsonb not null check (jsonb_typeof(prompt_snapshot) = 'object'),
  system_prompt_snapshot text not null,
  model_config_snapshot jsonb not null check (jsonb_typeof(model_config_snapshot) = 'object'),
  status text not null check (status in ('running', 'completed', 'failed')),
  error_message text,
  token_usage jsonb check (token_usage is null or jsonb_typeof(token_usage) = 'object'),
  content_analysis_id uuid references public.post_content_analyses(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  completed_at timestamptz
);

create table public.post_comments (
  id uuid primary key,
  post_id uuid not null references public.posts(id) on delete cascade,
  run_id uuid not null references public.post_generation_runs(id) on delete cascade,
  position integer not null check (position >= 0),
  content text not null,
  persona_snapshot jsonb not null check (jsonb_typeof(persona_snapshot) = 'object'),
  trigger text not null check (trigger in ('initial', 'agreement', 'user_reply')),
  parent_comment_id uuid references public.post_comments(id) on delete restrict,
  trigger_feedback_id uuid,
  scheduled_task_id uuid,
  content_analysis_id uuid references public.post_content_analyses(id) on delete set null,
  strategy_prompt_snapshot jsonb check (
    strategy_prompt_snapshot is null or jsonb_typeof(strategy_prompt_snapshot) = 'object'
  ),
  model_config_snapshot jsonb check (
    model_config_snapshot is null or jsonb_typeof(model_config_snapshot) = 'object'
  ),
  token_usage jsonb check (token_usage is null or jsonb_typeof(token_usage) = 'object'),
  created_at timestamptz not null default timezone('utc', now()),
  constraint post_comments_run_position_unique unique (run_id, position),
  constraint post_comments_scheduled_task_unique unique (scheduled_task_id)
);

create table public.post_comment_tasks (
  id uuid primary key,
  post_id uuid not null references public.posts(id) on delete cascade,
  persona_id text not null,
  scheduled_at timestamptz not null,
  status text not null check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  generated_at timestamptz,
  comment_id uuid references public.post_comments(id) on delete set null,
  retry_count integer not null default 0 check (retry_count >= 0),
  created_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  execution_token uuid,
  last_error text,
  content_analysis_id uuid references public.post_content_analyses(id) on delete set null,
  strategy_prompt_snapshot jsonb check (
    strategy_prompt_snapshot is null or jsonb_typeof(strategy_prompt_snapshot) = 'object'
  )
);

alter table public.post_comments
  add constraint post_comments_task_fk
  foreign key (scheduled_task_id) references public.post_comment_tasks(id) on delete set null;

create index post_comments_post_timeline_idx on public.post_comments (post_id, created_at, id);
create index post_comment_tasks_due_idx on public.post_comment_tasks (scheduled_at, id)
  where status = 'pending';
create index post_comment_tasks_post_idx on public.post_comment_tasks (post_id, created_at);

alter table public.post_inputs enable row level security;
alter table public.post_content_analyses enable row level security;
alter table public.post_generation_runs enable row level security;
alter table public.post_comments enable row level security;
alter table public.post_comment_tasks enable row level security;

revoke all on table public.post_inputs from anon, authenticated;
revoke all on table public.post_content_analyses from anon, authenticated;
revoke all on table public.post_generation_runs from anon, authenticated;
revoke all on table public.post_comments from anon, authenticated;
revoke all on table public.post_comment_tasks from anon, authenticated;
grant all on table public.post_inputs to service_role;
grant all on table public.post_content_analyses to service_role;
grant all on table public.post_generation_runs to service_role;
grant all on table public.post_comments to service_role;
grant all on table public.post_comment_tasks to service_role;

create or replace function public.create_community_post_bundle(
  p_post_id uuid,
  p_user_id uuid,
  p_content_type public.post_content_type,
  p_title text,
  p_body text,
  p_input_id uuid,
  p_analysis_id uuid,
  p_analysis jsonb,
  p_analysis_prompt jsonb,
  p_analysis_model_config jsonb,
  p_analysis_usage jsonb,
  p_analysis_source text,
  p_analysis_error text,
  p_run_id uuid,
  p_prompt_version_id uuid,
  p_prompt_snapshot jsonb,
  p_system_prompt text,
  p_comment_model_config jsonb,
  p_tasks jsonb,
  p_strategy_prompt jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_task jsonb;
  v_created_at timestamptz := timezone('utc', now());
begin
  if not exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'post author profile does not exist' using errcode = '23503';
  end if;
  if jsonb_typeof(p_analysis) <> 'object'
     or jsonb_typeof(p_analysis_prompt) <> 'object'
     or jsonb_typeof(p_analysis_model_config) <> 'object'
     or jsonb_typeof(p_prompt_snapshot) <> 'object'
     or jsonb_typeof(p_comment_model_config) <> 'object'
     or jsonb_typeof(p_tasks) <> 'array'
     or jsonb_typeof(p_strategy_prompt) <> 'object' then
    raise exception 'invalid community post bundle' using errcode = '22023';
  end if;

  insert into public.posts (id, user_id, content_type, title, body, published_at, created_at, updated_at)
  values (p_post_id, p_user_id, p_content_type, nullif(btrim(p_title), ''), btrim(p_body),
          v_created_at, v_created_at, v_created_at);
  insert into public.post_inputs (id, post_id, content, character_count, created_at)
  values (p_input_id, p_post_id, btrim(p_body), char_length(btrim(p_body)), v_created_at);
  insert into public.post_content_analyses (
    id, post_id, input_id, analysis, prompt_snapshot, model_config_snapshot,
    token_usage, source, error_message, created_at
  ) values (
    p_analysis_id, p_post_id, p_input_id, p_analysis, p_analysis_prompt,
    p_analysis_model_config, p_analysis_usage, p_analysis_source,
    nullif(p_analysis_error, ''), v_created_at
  );
  insert into public.post_generation_runs (
    id, post_id, input_id, prompt_version_id, prompt_snapshot, system_prompt_snapshot,
    model_config_snapshot, status, content_analysis_id, created_at, completed_at
  ) values (
    p_run_id, p_post_id, p_input_id, p_prompt_version_id, p_prompt_snapshot,
    p_system_prompt, p_comment_model_config,
    case when jsonb_array_length(p_tasks) = 0 then 'completed' else 'running' end,
    p_analysis_id, v_created_at,
    case when jsonb_array_length(p_tasks) = 0 then v_created_at else null end
  );

  for v_task in select value from jsonb_array_elements(p_tasks)
  loop
    insert into public.post_comment_tasks (
      id, post_id, persona_id, scheduled_at, status, retry_count, created_at,
      content_analysis_id, strategy_prompt_snapshot
    ) values (
      (v_task ->> 'id')::uuid, p_post_id, v_task ->> 'personaId',
      (v_task ->> 'scheduledAt')::timestamptz, 'pending', 0, v_created_at,
      p_analysis_id, p_strategy_prompt
    );
  end loop;
  return p_post_id;
end;
$$;

create or replace function public.claim_due_post_comment_tasks(
  p_limit integer,
  p_stale_before timestamptz,
  p_now timestamptz default timezone('utc', now())
)
returns setof public.post_comment_tasks
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_task public.post_comment_tasks%rowtype;
  v_claimed public.post_comment_tasks%rowtype;
  v_count integer := 0;
begin
  update public.post_comment_tasks
  set status = 'pending', started_at = null, execution_token = null
  where status = 'running' and started_at < p_stale_before;

  for v_task in
    select t.* from public.post_comment_tasks t
    join public.posts p on p.id = t.post_id
    where t.status = 'pending' and t.scheduled_at <= p_now
    order by t.scheduled_at, t.id
    for update of t skip locked
  loop
    exit when v_count >= greatest(1, least(p_limit, 20));
    if exists (select 1 from public.posts where id = v_task.post_id and status = 'deleted') then
      update public.post_comment_tasks set status = 'cancelled', last_error = '作品已删除。'
      where id = v_task.id;
      continue;
    end if;
    update public.post_comment_tasks
    set status = 'running', started_at = p_now, execution_token = gen_random_uuid()
    where id = v_task.id and status = 'pending'
    returning * into v_claimed;
    if found then
      return next v_claimed;
      v_count := v_count + 1;
    end if;
  end loop;
end;
$$;

create or replace function public.complete_post_comment_task(
  p_task_id uuid,
  p_execution_token uuid,
  p_content text,
  p_persona_snapshot jsonb,
  p_token_usage jsonb
)
returns setof public.post_comments
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_task public.post_comment_tasks%rowtype;
  v_run public.post_generation_runs%rowtype;
  v_comment public.post_comments%rowtype;
  v_position integer;
  v_now timestamptz := timezone('utc', now());
begin
  select * into v_task from public.post_comment_tasks where id = p_task_id for update;
  if not found then return; end if;
  if v_task.status = 'completed' and v_task.comment_id is not null then
    return query select * from public.post_comments where id = v_task.comment_id;
    return;
  end if;
  if v_task.status <> 'running' or v_task.execution_token <> p_execution_token then return; end if;
  if exists (select 1 from public.posts where id = v_task.post_id and status = 'deleted') then
    update public.post_comment_tasks set status = 'cancelled', execution_token = null,
      last_error = '作品已删除。' where id = v_task.id;
    return;
  end if;
  select * into v_run from public.post_generation_runs where post_id = v_task.post_id;
  perform pg_advisory_xact_lock(hashtext('echo-post-comment:' || v_run.id::text));
  select coalesce(max(position), -1) + 1 into v_position
  from public.post_comments where run_id = v_run.id;
  insert into public.post_comments (
    id, post_id, run_id, position, content, persona_snapshot, trigger,
    scheduled_task_id, content_analysis_id, strategy_prompt_snapshot,
    token_usage, created_at
  ) values (
    gen_random_uuid(), v_task.post_id, v_run.id, v_position, btrim(p_content),
    p_persona_snapshot, 'initial', v_task.id, v_task.content_analysis_id,
    v_task.strategy_prompt_snapshot, p_token_usage, v_now
  ) returning * into v_comment;
  update public.post_comment_tasks set status = 'completed', generated_at = v_now,
    comment_id = v_comment.id, execution_token = null where id = v_task.id;
  if not exists (
    select 1 from public.post_comment_tasks
    where post_id = v_task.post_id and status in ('pending', 'running')
  ) then
    update public.post_generation_runs set status = 'completed', completed_at = v_now
    where id = v_run.id;
  end if;
  return next v_comment;
end;
$$;

create or replace function public.fail_post_comment_task(
  p_task_id uuid,
  p_execution_token uuid,
  p_error_message text,
  p_max_retries integer,
  p_retry_at timestamptz
)
returns setof public.post_comment_tasks
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_task public.post_comment_tasks%rowtype;
begin
  update public.post_comment_tasks
  set retry_count = retry_count + 1,
      last_error = left(coalesce(p_error_message, '评论生成失败。'), 1000),
      execution_token = null, started_at = null,
      status = case when retry_count + 1 <= greatest(0, p_max_retries)
        then 'pending' else 'failed' end,
      scheduled_at = case when retry_count + 1 <= greatest(0, p_max_retries)
        then p_retry_at else scheduled_at end
  where id = p_task_id and status = 'running' and execution_token = p_execution_token
  returning * into v_task;
  if not found then return; end if;
  if v_task.status = 'failed' and not exists (
    select 1 from public.post_comment_tasks
    where post_id = v_task.post_id and status in ('pending', 'running')
  ) then
    update public.post_generation_runs set status = 'completed', completed_at = timezone('utc', now())
    where post_id = v_task.post_id;
  end if;
  return next v_task;
end;
$$;

create or replace function public.delete_community_post(p_post_id uuid, p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_deleted boolean := false;
begin
  update public.posts set status = 'deleted', deleted_at = timezone('utc', now())
  where id = p_post_id and user_id = p_user_id and status = 'published';
  v_deleted := found;
  if v_deleted then
    update public.post_comment_tasks set status = 'cancelled', execution_token = null,
      last_error = '作品已删除。'
    where post_id = p_post_id and status in ('pending', 'running');
  end if;
  return v_deleted;
end;
$$;

revoke all on function public.create_community_post_bundle(uuid, uuid, public.post_content_type, text, text, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, text, uuid, uuid, jsonb, text, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.claim_due_post_comment_tasks(integer, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.complete_post_comment_task(uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.fail_post_comment_task(uuid, uuid, text, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.delete_community_post(uuid, uuid) from public, anon, authenticated;
grant execute on function public.create_community_post_bundle(uuid, uuid, public.post_content_type, text, text, uuid, uuid, jsonb, jsonb, jsonb, jsonb, text, text, uuid, uuid, jsonb, text, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.claim_due_post_comment_tasks(integer, timestamptz, timestamptz) to service_role;
grant execute on function public.complete_post_comment_task(uuid, uuid, text, jsonb, jsonb) to service_role;
grant execute on function public.fail_post_comment_task(uuid, uuid, text, integer, timestamptz) to service_role;
grant execute on function public.delete_community_post(uuid, uuid) to service_role;
