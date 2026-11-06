begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(6);

select has_column(
  'public', 'chat_messages', 'client_request_id',
  'chat messages store the optimistic client request ID'
);

select has_index(
  'public', 'chat_messages', 'chat_messages_user_client_request_idx',
  'client request IDs have a per-user unique index'
);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values
  ('88888888-8888-4888-8888-888888888881', 'authenticated', 'authenticated', 'request-one@echo.test', '{}'::jsonb, '{"display_name":"请求用户一"}'::jsonb),
  ('88888888-8888-4888-8888-888888888882', 'authenticated', 'authenticated', 'request-two@echo.test', '{}'::jsonb, '{"display_name":"请求用户二"}'::jsonb);

set local role authenticated;
set local request.jwt.claims = '{"sub":"88888888-8888-4888-8888-888888888881","role":"authenticated","app_metadata":{}}';

select lives_ok(
  $$insert into public.chat_messages (
    room_id, sender_type, user_id, sender_name_snapshot, content, client_request_id
  ) values (
    'echo-public-mood', 'human', '88888888-8888-4888-8888-888888888881',
    '请求用户一', '第一次发送', '99999999-9999-4999-8999-999999999999'
  )$$,
  'human message accepts a client request UUID'
);

select throws_ok(
  $$insert into public.chat_messages (
    room_id, sender_type, user_id, sender_name_snapshot, content, client_request_id
  ) values (
    'echo-public-mood', 'human', '88888888-8888-4888-8888-888888888881',
    '请求用户一', '重复发送', '99999999-9999-4999-8999-999999999999'
  )$$,
  '23505', null,
  'the same user cannot persist one client request twice'
);

set local request.jwt.claims = '{"sub":"88888888-8888-4888-8888-888888888882","role":"authenticated","app_metadata":{}}';

select lives_ok(
  $$insert into public.chat_messages (
    room_id, sender_type, user_id, sender_name_snapshot, content, client_request_id
  ) values (
    'echo-public-mood', 'human', '88888888-8888-4888-8888-888888888882',
    '请求用户二', '另一位用户的请求', '99999999-9999-4999-8999-999999999999'
  )$$,
  'client request UUID uniqueness is scoped to its user'
);

reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select throws_ok(
  $$insert into public.chat_messages (
    room_id, sender_type, persona_id, sender_name_snapshot, content,
    persona_version, model_config_snapshot, prompt_version, client_request_id
  ) values (
    'echo-public-mood', 'ai', 'xiaolin', '小林', '伪造请求 ID',
    2, '{"model":"test"}'::jsonb, 'test-v1', '99999999-9999-4999-8999-999999999998'
  )$$,
  '23514', null,
  'AI messages cannot carry a human client request ID'
);

select * from finish();
rollback;
