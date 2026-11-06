begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(15);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values (
  '44444444-4444-4444-4444-444444444444',
  'authenticated', 'authenticated', 'worker-user@echo.test', '{}'::jsonb,
  '{"display_name":"Worker 测试用户"}'::jsonb
);

insert into public.ai_personas (id, display_name, avatar_path, bio)
values ('worker_persona', '任务人格', '任', '只用于 Worker 队列测试。');

insert into public.ai_persona_versions (persona_id, version, configuration, is_current)
values ('worker_persona', 1, '{"style":"direct"}'::jsonb, true);

insert into public.chat_messages (
  id, room_id, sender_type, user_id, sender_name_snapshot, content
) values
  ('cccccccc-cccc-cccc-cccc-ccccccccccc1', 'echo-public-mood', 'human',
   '44444444-4444-4444-4444-444444444444', 'Worker 测试用户', '请安排一条 AI 回复'),
  ('cccccccc-cccc-cccc-cccc-ccccccccccc2', 'echo-public-mood', 'human',
   '44444444-4444-4444-4444-444444444444', 'Worker 测试用户', '请测试失败重试');

set local role authenticated;
set local request.jwt.claims = '{"sub":"44444444-4444-4444-4444-444444444444","role":"authenticated","is_anonymous":true,"app_metadata":{}}';

select throws_ok(
  $$select * from public.create_chat_ai_tasks(
    'echo-public-mood', 'cccccccc-cccc-cccc-cccc-ccccccccccc1',
    '[{"personaId":"worker_persona","personaVersion":1,"scheduledAt":"2099-11-05T00:00:00Z","chainDepth":1}]'::jsonb,
    '{"model":"test"}'::jsonb, 'worker-test-v1', 3
  )$$,
  '42501', null,
  'ordinary authenticated clients cannot create AI tasks'
);

reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select results_eq(
  $$select count(*)::bigint from public.create_chat_ai_tasks(
    'echo-public-mood', 'cccccccc-cccc-cccc-cccc-ccccccccccc1',
    '[{"personaId":"worker_persona","personaVersion":1,"scheduledAt":"2099-11-05T00:00:00Z","chainDepth":1}]'::jsonb,
    '{"provider":"deepseek","model":"test"}'::jsonb, 'worker-test-v1', 3
  )$$,
  $$values (1::bigint)$$,
  'trusted worker creates one persistent task'
);

select results_eq(
  $$select count(*)::bigint from public.create_chat_ai_tasks(
    'echo-public-mood', 'cccccccc-cccc-cccc-cccc-ccccccccccc1',
    '[{"personaId":"worker_persona","personaVersion":1,"scheduledAt":"2099-11-05T00:00:00Z","chainDepth":1}]'::jsonb,
    '{"provider":"deepseek","model":"test"}'::jsonb, 'worker-test-v1', 3
  )$$,
  $$values (0::bigint)$$,
  'scheduling the same trigger and persona is idempotent'
);

select results_eq(
  $$select count(*)::bigint from public.claim_due_chat_ai_tasks(
    2, '2099-11-05T00:00:00Z', 0,
    '{"worker_persona":{"hourlyMessageLimit":10,"dailyMessageLimit":20,"minimumIntervalMs":0}}'::jsonb,
    '2099-11-05T01:00:00Z'
  )$$,
  $$values (1::bigint)$$,
  'due task is claimed once'
);

select results_eq(
  $$select status::text, (execution_token is not null) from public.chat_ai_tasks
    where trigger_message_id = 'cccccccc-cccc-cccc-cccc-ccccccccccc1'$$,
  $$values ('processing'::text, true)$$,
  'claim records processing status and execution token'
);

select results_eq(
  $$select count(*)::bigint from public.claim_due_chat_ai_tasks(
    2, '2099-11-05T00:00:00Z', 0,
    '{"worker_persona":{"hourlyMessageLimit":10,"dailyMessageLimit":20,"minimumIntervalMs":0}}'::jsonb,
    '2099-11-05T01:00:00Z'
  )$$,
  $$values (0::bigint)$$,
  'a processing task cannot be claimed twice'
);

select results_eq(
  $$select count(*)::bigint from public.complete_chat_ai_task(
    (select id from public.chat_ai_tasks where trigger_message_id = 'cccccccc-cccc-cccc-cccc-ccccccccccc1'),
    (select execution_token from public.chat_ai_tasks where trigger_message_id = 'cccccccc-cccc-cccc-cccc-ccccccccccc1'),
    '这是一条真实落库的 AI 回复'
  )$$,
  $$values (1::bigint)$$,
  'completion atomically creates an AI message'
);

select results_eq(
  $$select status::text, (generated_message_id is not null) from public.chat_ai_tasks
    where trigger_message_id = 'cccccccc-cccc-cccc-cccc-ccccccccccc1'$$,
  $$values ('completed'::text, true)$$,
  'completion persists task provenance'
);

select results_eq(
  $$select sender_type::text, persona_id, reply_to_message_id
    from public.chat_messages where content = '这是一条真实落库的 AI 回复'$$,
  $$values ('ai'::text, 'worker_persona'::text, 'cccccccc-cccc-cccc-cccc-ccccccccccc1'::uuid)$$,
  'generated message keeps persona and reply relationship'
);

select results_eq(
  $$select count(*)::bigint from public.complete_chat_ai_task(
    (select id from public.chat_ai_tasks where trigger_message_id = 'cccccccc-cccc-cccc-cccc-ccccccccccc1'),
    gen_random_uuid(), '不应生成第二条消息'
  )$$,
  $$values (1::bigint)$$,
  'repeated completion returns the existing message'
);

select results_eq(
  $$select count(*)::bigint from public.chat_messages where sender_type = 'ai' and persona_id = 'worker_persona'$$,
  $$values (1::bigint)$$,
  'repeated completion never duplicates the AI message'
);

select results_eq(
  $$select count(*)::bigint from public.create_chat_ai_tasks(
    'echo-public-mood', 'cccccccc-cccc-cccc-cccc-ccccccccccc2',
    '[{"personaId":"worker_persona","personaVersion":1,"scheduledAt":"2099-11-06T02:00:00Z","chainDepth":1}]'::jsonb,
    '{"provider":"deepseek","model":"test"}'::jsonb, 'worker-test-v1', 3
  )$$,
  $$values (1::bigint)$$,
  'a second trigger gets its own task'
);

select results_eq(
  $$select count(*)::bigint from public.claim_due_chat_ai_tasks(
    1, '2099-11-06T00:00:00Z', 0,
    '{"worker_persona":{"hourlyMessageLimit":10,"dailyMessageLimit":20,"minimumIntervalMs":0}}'::jsonb,
    '2099-11-06T03:00:00Z'
  )$$,
  $$values (1::bigint)$$,
  'second task can be claimed independently'
);

select results_eq(
  $$select count(*)::bigint from public.fail_chat_ai_task(
    (select id from public.chat_ai_tasks where trigger_message_id = 'cccccccc-cccc-cccc-cccc-ccccccccccc2'),
    (select execution_token from public.chat_ai_tasks where trigger_message_id = 'cccccccc-cccc-cccc-cccc-ccccccccccc2'),
    'temporary model failure', 2, '2099-11-06T03:01:00Z'
  )$$,
  $$values (1::bigint)$$,
  'failed execution is recorded and scheduled for retry'
);

select results_eq(
  $$select status::text, retry_count, scheduled_at
    from public.chat_ai_tasks where trigger_message_id = 'cccccccc-cccc-cccc-cccc-ccccccccccc2'$$,
  $$values ('pending'::text, 1, '2099-11-06T03:01:00Z'::timestamptz)$$,
  'retry state survives process and page restarts'
);

select * from finish();
rollback;
