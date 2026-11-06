-- Persistent Supabase queue primitives for Echo's trusted AI chat worker.
-- These functions are intentionally executable only by service_role. Browser
-- clients must never be able to create tasks or forge AI messages.

create or replace function public.create_chat_ai_tasks(
  p_room_id text,
  p_trigger_message_id uuid,
  p_tasks jsonb,
  p_model_config jsonb,
  p_prompt_version text,
  p_max_pending_tasks integer
)
returns setof public.chat_ai_tasks
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_trigger public.chat_messages%rowtype;
  v_parent public.chat_messages%rowtype;
  v_planned jsonb;
  v_created public.chat_ai_tasks%rowtype;
  v_is_direct_ai_reply boolean := false;
begin
  select * into v_trigger
  from public.chat_messages
  where id = p_trigger_message_id and room_id = p_room_id
  for share;

  if not found or v_trigger.status <> 'normal' then
    return;
  end if;

  if v_trigger.reply_to_message_id is not null then
    select * into v_parent
    from public.chat_messages
    where id = v_trigger.reply_to_message_id;
    v_is_direct_ai_reply := v_trigger.sender_type = 'human' and v_parent.sender_type = 'ai';
  end if;

  if jsonb_typeof(p_tasks) <> 'array'
     or jsonb_typeof(p_model_config) <> 'object'
     or nullif(btrim(p_prompt_version), '') is null then
    raise exception 'invalid AI task payload' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('echo-chat-ai-task-create:' || p_room_id));

  for v_planned in select value from jsonb_array_elements(p_tasks)
  loop
    if not v_is_direct_ai_reply and (
      select count(*)
      from public.chat_ai_tasks
      where room_id = p_room_id and status in ('pending', 'processing')
    ) >= greatest(1, least(p_max_pending_tasks, 20)) then
      exit;
    end if;

    if not exists (
      select 1
      from public.ai_personas p
      join public.ai_persona_versions pv
        on pv.persona_id = p.id
       and pv.version = (v_planned ->> 'personaVersion')::integer
      where p.id = v_planned ->> 'personaId' and p.enabled
    ) then
      continue;
    end if;

    begin
      insert into public.chat_ai_tasks (
        room_id, trigger_message_id, persona_id, persona_version,
        scheduled_at, chain_depth, model_config_snapshot, prompt_version
      ) values (
        p_room_id,
        p_trigger_message_id,
        v_planned ->> 'personaId',
        (v_planned ->> 'personaVersion')::integer,
        (v_planned ->> 'scheduledAt')::timestamptz,
        greatest(1, least((v_planned ->> 'chainDepth')::integer, 10)),
        p_model_config || jsonb_build_object('commentCount', 1),
        p_prompt_version
      )
      returning * into v_created;
      return next v_created;
    exception when unique_violation then
      -- Scheduling is idempotent for a trigger/persona/chain combination.
      continue;
    end;
  end loop;
end;
$$;

create or replace function public.claim_due_chat_ai_tasks(
  p_limit integer,
  p_stale_before timestamptz,
  p_minimum_global_interval_ms integer,
  p_persona_limits jsonb,
  p_now timestamptz default timezone('utc', now())
)
returns setof public.chat_ai_tasks
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_task public.chat_ai_tasks%rowtype;
  v_trigger public.chat_messages%rowtype;
  v_parent public.chat_messages%rowtype;
  v_claimed public.chat_ai_tasks%rowtype;
  v_claimed_count integer := 0;
  v_limits jsonb;
  v_hourly_limit integer;
  v_daily_limit integer;
  v_persona_interval_ms integer;
  v_last_global_at timestamptz;
  v_last_persona_at timestamptz;
  v_deferred_until timestamptz;
  v_is_direct_ai_reply boolean;
begin
  if jsonb_typeof(p_persona_limits) <> 'object' then
    raise exception 'invalid persona limits' using errcode = '22023';
  end if;

  -- Serialize claims so independent server instances cannot both reserve the
  -- same global speaking slot. Row locks still protect individual tasks.
  perform pg_advisory_xact_lock(hashtext('echo-chat-ai-task-claim'));

  update public.chat_ai_tasks
  set status = 'pending', started_at = null, execution_token = null
  where status = 'processing' and started_at < p_stale_before;

  select max(created_at) into v_last_global_at
  from public.chat_messages
  where room_id = 'echo-public-mood' and sender_type = 'ai' and status = 'normal';

  for v_task in
    select *
    from public.chat_ai_tasks
    where status = 'pending' and scheduled_at <= p_now
    order by scheduled_at, id
    for update skip locked
  loop
    exit when v_claimed_count >= greatest(1, least(p_limit, 10));

    select * into v_trigger
    from public.chat_messages
    where id = v_task.trigger_message_id and room_id = v_task.room_id;

    if not found or v_trigger.status <> 'normal' then
      update public.chat_ai_tasks
      set status = 'cancelled', last_error = '触发消息已删除。', execution_token = null
      where id = v_task.id;
      continue;
    end if;

    v_is_direct_ai_reply := false;
    if v_trigger.reply_to_message_id is not null then
      select * into v_parent
      from public.chat_messages
      where id = v_trigger.reply_to_message_id;
      v_is_direct_ai_reply := v_trigger.sender_type = 'human'
        and v_parent.sender_type = 'ai'
        and v_parent.persona_id = v_task.persona_id;
    end if;

    v_limits := p_persona_limits -> v_task.persona_id;
    if v_limits is not null then
      v_hourly_limit := greatest(1, coalesce((v_limits ->> 'hourlyMessageLimit')::integer, 1));
      v_daily_limit := greatest(1, coalesce((v_limits ->> 'dailyMessageLimit')::integer, 1));
      v_persona_interval_ms := greatest(0, coalesce((v_limits ->> 'minimumIntervalMs')::integer, 0));

      if (select count(*) from public.chat_messages
          where room_id = v_task.room_id and sender_type = 'ai'
            and persona_id = v_task.persona_id and status = 'normal'
            and created_at >= p_now - interval '1 hour') >= v_hourly_limit
         or (select count(*) from public.chat_messages
          where room_id = v_task.room_id and sender_type = 'ai'
            and persona_id = v_task.persona_id and status = 'normal'
            and created_at >= p_now - interval '24 hours') >= v_daily_limit then
        update public.chat_ai_tasks
        set status = 'cancelled', last_error = '该 AI 人格已达到当前发言频率上限。'
        where id = v_task.id;
        continue;
      end if;

      select max(created_at) into v_last_persona_at
      from public.chat_messages
      where room_id = v_task.room_id and sender_type = 'ai'
        and persona_id = v_task.persona_id and status = 'normal';
    else
      v_persona_interval_ms := 0;
      v_last_persona_at := null;
    end if;

    v_deferred_until := greatest(
      coalesce(v_last_global_at + make_interval(secs => greatest(0, p_minimum_global_interval_ms) / 1000.0), '-infinity'::timestamptz),
      case when v_is_direct_ai_reply then '-infinity'::timestamptz
        else coalesce(v_last_persona_at + make_interval(secs => v_persona_interval_ms / 1000.0), '-infinity'::timestamptz)
      end
    );
    if v_deferred_until > p_now then
      update public.chat_ai_tasks set scheduled_at = v_deferred_until where id = v_task.id;
      continue;
    end if;

    update public.chat_ai_tasks
    set status = 'processing', started_at = p_now, execution_token = gen_random_uuid()
    where id = v_task.id and status = 'pending'
    returning * into v_claimed;
    if found then
      return next v_claimed;
      v_claimed_count := v_claimed_count + 1;
      v_last_global_at := p_now;
    end if;
  end loop;
end;
$$;

create or replace function public.complete_chat_ai_task(
  p_task_id uuid,
  p_execution_token uuid,
  p_content text
)
returns setof public.chat_messages
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_task public.chat_ai_tasks%rowtype;
  v_trigger public.chat_messages%rowtype;
  v_persona public.ai_personas%rowtype;
  v_message public.chat_messages%rowtype;
begin
  select * into v_task
  from public.chat_ai_tasks
  where id = p_task_id
  for update;

  if not found then return; end if;
  if v_task.status = 'completed' and v_task.generated_message_id is not null then
    return query select * from public.chat_messages where id = v_task.generated_message_id;
    return;
  end if;
  if v_task.status <> 'processing' or v_task.execution_token <> p_execution_token then return; end if;

  select * into v_trigger from public.chat_messages where id = v_task.trigger_message_id;
  if not found or v_trigger.status <> 'normal' then
    update public.chat_ai_tasks
    set status = 'cancelled', execution_token = null, last_error = '触发消息已删除。'
    where id = v_task.id;
    return;
  end if;

  select * into v_persona from public.ai_personas
  where id = v_task.persona_id and enabled;
  if not found then
    update public.chat_ai_tasks
    set status = 'failed', execution_token = null, last_error = 'AI 人格不存在或已停用。'
    where id = v_task.id;
    return;
  end if;

  insert into public.chat_messages (
    room_id, sender_type, persona_id, sender_name_snapshot,
    sender_avatar_snapshot, content, reply_to_message_id, persona_version,
    model_config_snapshot, prompt_version
  ) values (
    v_task.room_id, 'ai', v_task.persona_id, v_persona.display_name,
    v_persona.avatar_path, btrim(p_content), v_task.trigger_message_id,
    v_task.persona_version, v_task.model_config_snapshot, v_task.prompt_version
  ) returning * into v_message;

  update public.chat_ai_tasks
  set status = 'completed', generated_at = v_message.created_at,
      generated_message_id = v_message.id, execution_token = null
  where id = v_task.id;

  return next v_message;
end;
$$;

create or replace function public.fail_chat_ai_task(
  p_task_id uuid,
  p_execution_token uuid,
  p_error_message text,
  p_max_retries integer,
  p_retry_at timestamptz
)
returns setof public.chat_ai_tasks
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_task public.chat_ai_tasks%rowtype;
begin
  select * into v_task
  from public.chat_ai_tasks
  where id = p_task_id
  for update;
  if not found or v_task.status <> 'processing' or v_task.execution_token <> p_execution_token then
    return;
  end if;

  update public.chat_ai_tasks
  set retry_count = retry_count + 1,
      last_error = left(coalesce(p_error_message, 'AI 群聊消息生成失败。'), 1000),
      execution_token = null,
      started_at = null,
      status = case when retry_count + 1 <= greatest(0, p_max_retries)
        then 'pending'::public.chat_ai_task_status else 'failed'::public.chat_ai_task_status end,
      scheduled_at = case when retry_count + 1 <= greatest(0, p_max_retries)
        then p_retry_at else scheduled_at end
  where id = p_task_id
  returning * into v_task;
  return next v_task;
end;
$$;

revoke all on function public.create_chat_ai_tasks(text, uuid, jsonb, jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.claim_due_chat_ai_tasks(integer, timestamptz, integer, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.complete_chat_ai_task(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.fail_chat_ai_task(uuid, uuid, text, integer, timestamptz) from public, anon, authenticated;

grant execute on function public.create_chat_ai_tasks(text, uuid, jsonb, jsonb, text, integer) to service_role;
grant execute on function public.claim_due_chat_ai_tasks(integer, timestamptz, integer, jsonb, timestamptz) to service_role;
grant execute on function public.complete_chat_ai_task(uuid, uuid, text) to service_role;
grant execute on function public.fail_chat_ai_task(uuid, uuid, text, integer, timestamptz) to service_role;

comment on function public.claim_due_chat_ai_tasks(integer, timestamptz, integer, jsonb, timestamptz)
is 'Atomically recovers stale work, applies AI speaking limits, and claims due tasks for trusted workers.';
