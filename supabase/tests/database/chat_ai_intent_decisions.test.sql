begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(14);

select has_table('public', 'chat_ai_intent_decisions', 'intent decisions have a persistent table');
select has_column('public', 'chat_ai_intent_decisions', 'response_probability', 'decision probability is auditable');
select has_column('public', 'chat_ai_intent_decisions', 'selected_persona_ids', 'selected personas are auditable');
select has_index('public', 'chat_ai_intent_decisions', 'chat_ai_intent_decisions_due_idx', 'pending decisions have a due-work index');

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values (
  '77777777-7777-4777-8777-777777777777',
  'authenticated', 'authenticated', 'intent-user@echo.test', '{}'::jsonb,
  '{"display_name":"意图测试用户"}'::jsonb
);

insert into public.chat_messages (
  id, room_id, sender_type, user_id, sender_name_snapshot, content
) values (
  'dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'echo-public-mood', 'human',
  '77777777-7777-4777-8777-777777777777', '意图测试用户', '今天有点难过，能陪我说句话吗'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"77777777-7777-4777-8777-777777777777","role":"authenticated","app_metadata":{}}';

select throws_ok(
  $$select * from public.enqueue_chat_ai_intent_decision(
    'echo-public-mood', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    '{"model":"test"}'::jsonb, 'intent-v1', 'reply-v1'
  )$$,
  '42501', null,
  'ordinary users cannot enqueue private intent work'
);

select throws_ok(
  $$select id from public.chat_ai_intent_decisions$$,
  '42501', null,
  'ordinary users cannot read intent decisions'
);

reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select results_eq(
  $$select count(*)::bigint from public.enqueue_chat_ai_intent_decision(
    'echo-public-mood', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    '{"provider":"deepseek","model":"test"}'::jsonb, 'intent-v1', 'reply-v1'
  )$$,
  $$values (1::bigint)$$,
  'trusted server enqueues one intent decision'
);

select results_eq(
  $$select count(*)::bigint from public.enqueue_chat_ai_intent_decision(
    'echo-public-mood', 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    '{"provider":"deepseek","model":"test"}'::jsonb, 'intent-v1', 'reply-v1'
  )$$,
  $$values (1::bigint)$$,
  'enqueue is idempotent and returns the existing decision'
);

select results_eq(
  $$select count(*)::bigint from public.claim_chat_ai_intent_decisions(
    2, '2000-01-01T00:00:00Z', '2099-01-01T00:00:00Z'
  )$$,
  $$values (1::bigint)$$,
  'worker atomically claims due intent work'
);

select results_eq(
  $$select status, (execution_token is not null) from public.chat_ai_intent_decisions
    where message_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'$$,
  $$values ('processing'::text, true)$$,
  'claim stores processing state and token'
);

select results_eq(
  $$select count(*)::bigint from public.claim_chat_ai_intent_decisions(
    2, '2000-01-01T00:00:00Z', '2099-01-01T00:00:00Z'
  )$$,
  $$values (0::bigint)$$,
  'processing intent work cannot be claimed twice'
);

select results_eq(
  $$select count(*)::bigint from public.complete_chat_ai_intent_decision(
    (select id from public.chat_ai_intent_decisions where message_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
    (select execution_token from public.chat_ai_intent_decisions where message_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
    '{"intent":"seeking_comfort","emotion":"sad","interactionTarget":"group","needsResponse":true,"responseStyles":["empathetic","casual"],"contextDependency":"medium","reason":"明确寻求陪伴","confidence":0.9}'::jsonb,
    0.85, true, array['mengxia'], 'model'
  )$$,
  $$values (1::bigint)$$,
  'worker completes an intent decision once'
);

select results_eq(
  $$select status, intent, emotion, needs_response, response_probability::text,
      decision_result, selected_persona_ids, classifier_source
    from public.chat_ai_intent_decisions
    where message_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'$$,
  $$values (
    'completed'::text, 'seeking_comfort'::text, 'sad'::text, true,
    '0.8500'::text, true, array['mengxia']::text[], 'model'::text
  )$$,
  'completed decision preserves analysis, probability, result, and persona'
);

select results_eq(
  $$select count(*)::bigint from public.complete_chat_ai_intent_decision(
    (select id from public.chat_ai_intent_decisions where message_id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
    gen_random_uuid(),
    '{"intent":"casual_chat","emotion":"neutral","interactionTarget":"group","needsResponse":false,"responseStyles":[],"contextDependency":"low","reason":"wrong token","confidence":1}'::jsonb,
    0.45, false, '{}'::text[], 'model'
  )$$,
  $$values (0::bigint)$$,
  'stale execution token cannot overwrite a completed decision'
);

select * from finish();
rollback;
