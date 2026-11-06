-- Persistent intent-analysis queue and audit trail for human mood-chat messages.

create table public.chat_ai_intent_decisions (
  id uuid primary key default gen_random_uuid(),
  room_id text not null references public.chat_rooms(id) on delete restrict,
  message_id uuid not null unique references public.chat_messages(id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  scheduled_at timestamptz not null default timezone('utc', now()),
  started_at timestamptz,
  completed_at timestamptz,
  execution_token uuid,
  retry_count integer not null default 0 check (retry_count >= 0),
  last_error text,
  intent text,
  emotion text,
  interaction_target text,
  needs_response boolean,
  response_styles text[] not null default '{}',
  context_dependency text,
  reason text,
  confidence numeric(4,3) check (confidence between 0 and 1),
  response_probability numeric(5,4) check (response_probability between 0 and 1),
  decision_result boolean,
  selected_persona_ids text[] not null default '{}',
  classifier_source text check (classifier_source in ('model', 'fallback')),
  model_config_snapshot jsonb not null check (jsonb_typeof(model_config_snapshot) = 'object'),
  classifier_prompt_version text not null,
  reply_prompt_version text not null,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index chat_ai_intent_decisions_due_idx
  on public.chat_ai_intent_decisions (scheduled_at, id)
  where status = 'pending';
create index chat_ai_intent_decisions_result_idx
  on public.chat_ai_intent_decisions (decision_result, created_at desc);
create index chat_ai_intent_decisions_intent_idx
  on public.chat_ai_intent_decisions (intent, created_at desc);

create trigger chat_ai_intent_decisions_set_updated_at
before update on public.chat_ai_intent_decisions
for each row execute function public.set_updated_at();

alter table public.chat_ai_intent_decisions enable row level security;
revoke all on table public.chat_ai_intent_decisions from anon, authenticated;
grant all on table public.chat_ai_intent_decisions to service_role;

create policy chat_ai_intent_decisions_admin_read
on public.chat_ai_intent_decisions for select
to authenticated
using (public.is_admin());

create or replace function public.enqueue_chat_ai_intent_decision(
  p_room_id text,
  p_message_id uuid,
  p_model_config jsonb,
  p_classifier_prompt_version text,
  p_reply_prompt_version text
)
returns setof public.chat_ai_intent_decisions
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_message public.chat_messages%rowtype;
  v_decision public.chat_ai_intent_decisions%rowtype;
begin
  select * into v_message
  from public.chat_messages
  where id = p_message_id and room_id = p_room_id;

  if not found or v_message.status <> 'normal' or v_message.sender_type <> 'human' then
    return;
  end if;
  if jsonb_typeof(p_model_config) <> 'object'
     or nullif(btrim(p_classifier_prompt_version), '') is null
     or nullif(btrim(p_reply_prompt_version), '') is null then
    raise exception 'invalid intent decision payload' using errcode = '22023';
  end if;

  insert into public.chat_ai_intent_decisions (
    room_id, message_id, model_config_snapshot,
    classifier_prompt_version, reply_prompt_version
  ) values (
    p_room_id, p_message_id, p_model_config,
    p_classifier_prompt_version, p_reply_prompt_version
  )
  on conflict (message_id) do nothing
  returning * into v_decision;

  if found then
    return next v_decision;
  else
    return query select * from public.chat_ai_intent_decisions where message_id = p_message_id;
  end if;
end;
$$;

create or replace function public.claim_chat_ai_intent_decisions(
  p_limit integer,
  p_stale_before timestamptz,
  p_now timestamptz default timezone('utc', now())
)
returns setof public.chat_ai_intent_decisions
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_decision public.chat_ai_intent_decisions%rowtype;
  v_claimed public.chat_ai_intent_decisions%rowtype;
  v_message public.chat_messages%rowtype;
  v_count integer := 0;
begin
  update public.chat_ai_intent_decisions
  set status = 'pending', started_at = null, execution_token = null
  where status = 'processing' and started_at < p_stale_before;

  for v_decision in
    select * from public.chat_ai_intent_decisions
    where status = 'pending' and scheduled_at <= p_now
    order by scheduled_at, id
    for update skip locked
  loop
    exit when v_count >= greatest(1, least(p_limit, 10));
    select * into v_message from public.chat_messages where id = v_decision.message_id;
    if not found or v_message.status <> 'normal' then
      update public.chat_ai_intent_decisions
      set status = 'cancelled', last_error = '触发消息已删除。'
      where id = v_decision.id;
      continue;
    end if;
    update public.chat_ai_intent_decisions
    set status = 'processing', started_at = p_now, execution_token = gen_random_uuid()
    where id = v_decision.id and status = 'pending'
    returning * into v_claimed;
    if found then
      return next v_claimed;
      v_count := v_count + 1;
    end if;
  end loop;
end;
$$;

create or replace function public.complete_chat_ai_intent_decision(
  p_decision_id uuid,
  p_execution_token uuid,
  p_analysis jsonb,
  p_response_probability numeric,
  p_decision_result boolean,
  p_selected_persona_ids text[],
  p_classifier_source text
)
returns setof public.chat_ai_intent_decisions
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_decision public.chat_ai_intent_decisions%rowtype;
begin
  if jsonb_typeof(p_analysis) <> 'object'
     or p_response_probability < 0 or p_response_probability > 1
     or p_classifier_source not in ('model', 'fallback') then
    raise exception 'invalid completed intent decision' using errcode = '22023';
  end if;
  update public.chat_ai_intent_decisions
  set
    status = 'completed', completed_at = timezone('utc', now()), execution_token = null,
    intent = p_analysis ->> 'intent', emotion = p_analysis ->> 'emotion',
    interaction_target = p_analysis ->> 'interactionTarget',
    needs_response = (p_analysis ->> 'needsResponse')::boolean,
    response_styles = coalesce(array(select jsonb_array_elements_text(p_analysis -> 'responseStyles')), '{}'),
    context_dependency = p_analysis ->> 'contextDependency', reason = p_analysis ->> 'reason',
    confidence = (p_analysis ->> 'confidence')::numeric,
    response_probability = p_response_probability, decision_result = p_decision_result,
    selected_persona_ids = coalesce(p_selected_persona_ids, '{}'),
    classifier_source = p_classifier_source, last_error = null
  where id = p_decision_id and status = 'processing' and execution_token = p_execution_token
  returning * into v_decision;
  if found then return next v_decision; end if;
end;
$$;

create or replace function public.fail_chat_ai_intent_decision(
  p_decision_id uuid,
  p_execution_token uuid,
  p_error_message text,
  p_max_retries integer,
  p_retry_at timestamptz
)
returns setof public.chat_ai_intent_decisions
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_decision public.chat_ai_intent_decisions%rowtype;
begin
  update public.chat_ai_intent_decisions
  set retry_count = retry_count + 1,
      last_error = left(coalesce(p_error_message, '意图识别失败。'), 1000),
      execution_token = null, started_at = null,
      status = case when retry_count + 1 <= greatest(0, p_max_retries)
        then 'pending' else 'failed' end,
      scheduled_at = case when retry_count + 1 <= greatest(0, p_max_retries)
        then p_retry_at else scheduled_at end
  where id = p_decision_id and status = 'processing' and execution_token = p_execution_token
  returning * into v_decision;
  if found then return next v_decision; end if;
end;
$$;

revoke all on function public.enqueue_chat_ai_intent_decision(text, uuid, jsonb, text, text) from public, anon, authenticated;
revoke all on function public.claim_chat_ai_intent_decisions(integer, timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function public.complete_chat_ai_intent_decision(uuid, uuid, jsonb, numeric, boolean, text[], text) from public, anon, authenticated;
revoke all on function public.fail_chat_ai_intent_decision(uuid, uuid, text, integer, timestamptz) from public, anon, authenticated;

grant execute on function public.enqueue_chat_ai_intent_decision(text, uuid, jsonb, text, text) to service_role;
grant execute on function public.claim_chat_ai_intent_decisions(integer, timestamptz, timestamptz) to service_role;
grant execute on function public.complete_chat_ai_intent_decision(uuid, uuid, jsonb, numeric, boolean, text[], text) to service_role;
grant execute on function public.fail_chat_ai_intent_decision(uuid, uuid, text, integer, timestamptz) to service_role;

comment on table public.chat_ai_intent_decisions is
  'Private persistent intent-analysis queue and auditable AI participation decision for each human chat message.';
