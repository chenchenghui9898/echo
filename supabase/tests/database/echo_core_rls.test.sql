begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(25);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values
  ('11111111-1111-1111-1111-111111111111', 'authenticated', 'authenticated', 'anon-user@echo.test', '{}'::jsonb, '{"display_name":"匿名测试用户"}'::jsonb),
  ('22222222-2222-2222-2222-222222222222', 'authenticated', 'authenticated', 'member@echo.test', '{}'::jsonb, '{"display_name":"正式测试用户"}'::jsonb),
  ('33333333-3333-3333-3333-333333333333', 'authenticated', 'authenticated', 'admin@echo.test', '{"role":"admin"}'::jsonb, '{"display_name":"管理员"}'::jsonb);

insert into public.ai_personas (id, display_name, bio)
values ('test_persona', '测试人格', '只用于数据库权限测试。');

insert into public.ai_persona_versions (persona_id, version, configuration, is_current)
values ('test_persona', 1, '{"style":"direct"}'::jsonb, true);

insert into public.posts (id, user_id, content_type, title, body)
values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111', 'diary', '匿名用户日记', '测试正文'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '22222222-2222-2222-2222-222222222222', 'viewpoint', '正式用户观点', '测试观点');

insert into public.chat_messages (
  id, room_id, sender_type, user_id, sender_name_snapshot, content
)
values
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', 'echo-public-mood', 'human', '11111111-1111-1111-1111-111111111111', '匿名测试用户', '匿名用户消息'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2', 'echo-public-mood', 'human', '22222222-2222-2222-2222-222222222222', '正式测试用户', '正式用户消息');

insert into public.chat_messages (
  id, room_id, sender_type, persona_id, sender_name_snapshot, content,
  persona_version, model_config_snapshot, prompt_version
)
values (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3', 'echo-public-mood', 'ai', 'test_persona', '测试人格', 'AI 测试消息',
  1, '{"model":"test"}'::jsonb, 'test-v1'
);

-- Unauthenticated visitors can read published content and normal public chat,
-- but have no write privileges.
set local role anon;
set local request.jwt.claims = '{}';

select results_eq(
  $$select count(*)::bigint from public.posts$$,
  $$values (2::bigint)$$,
  'unauthenticated visitor reads published posts'
);

select results_eq(
  $$select count(*)::bigint from public.chat_messages where id in (
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3'
  )$$,
  $$values (3::bigint)$$,
  'unauthenticated visitor reads normal public messages'
);

select throws_ok(
  $$insert into public.posts (user_id, content_type, body) values ('11111111-1111-1111-1111-111111111111', 'diary', 'forbidden')$$,
  '42501', null,
  'unauthenticated visitor cannot publish'
);

select throws_ok(
  $$insert into public.chat_messages (room_id, sender_type, user_id, sender_name_snapshot, content) values ('echo-public-mood', 'human', '11111111-1111-1111-1111-111111111111', '伪造用户', 'forbidden')$$,
  '42501', null,
  'unauthenticated visitor cannot send messages'
);

-- Supabase anonymous Auth users use the authenticated role and retain strict
-- ownership boundaries.
set local role authenticated;
set local request.jwt.claims = '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","is_anonymous":true,"app_metadata":{}}';

select lives_ok(
  $$insert into public.posts (user_id, content_type, body) values ('11111111-1111-1111-1111-111111111111', 'diary', '匿名用户自己的新内容')$$,
  'anonymous Auth user publishes own post'
);

select throws_ok(
  $$insert into public.posts (user_id, content_type, body) values ('22222222-2222-2222-2222-222222222222', 'diary', '伪造他人内容')$$,
  '42501', null,
  'anonymous Auth user cannot publish for another user'
);

select lives_ok(
  $$update public.profiles set display_name = '匿名用户新昵称' where id = '11111111-1111-1111-1111-111111111111'$$,
  'anonymous Auth user updates own profile'
);

select results_eq(
  $$update public.profiles set display_name = '越权昵称' where id = '22222222-2222-2222-2222-222222222222' returning id$$,
  $$select id from public.profiles where false$$,
  'anonymous Auth user cannot update another profile'
);

select lives_ok(
  $$insert into public.chat_messages (room_id, sender_type, user_id, sender_name_snapshot, content, reply_to_message_id) values ('echo-public-mood', 'human', '11111111-1111-1111-1111-111111111111', '匿名测试用户', '回复消息', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2')$$,
  'anonymous Auth user sends a human reply as self'
);

select throws_ok(
  $$insert into public.chat_messages (room_id, sender_type, user_id, sender_name_snapshot, content) values ('echo-public-mood', 'human', '22222222-2222-2222-2222-222222222222', '伪造用户', 'forbidden')$$,
  '42501', null,
  'anonymous Auth user cannot impersonate another human'
);

select throws_ok(
  $$insert into public.chat_messages (room_id, sender_type, persona_id, sender_name_snapshot, content) values ('echo-public-mood', 'ai', 'test_persona', '测试人格', 'forbidden')$$,
  '42501', null,
  'ordinary client cannot forge an AI message'
);

select results_eq(
  $$select count(*)::bigint from public.chat_ai_tasks$$,
  $$values (0::bigint)$$,
  'ordinary client cannot read AI tasks'
);

select throws_ok(
  $$insert into public.ai_personas (id, display_name) values ('forged_persona', '伪造人格')$$,
  '42501', null,
  'ordinary client cannot create AI persona configuration'
);

select lives_ok(
  $$select public.delete_own_chat_message('echo-public-mood', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1')$$,
  'anonymous Auth user deletes own message through the safe RPC'
);

select results_eq(
  $$select status::text, content from public.chat_messages where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1'$$,
  $$values ('deleted'::text, '该消息已删除'::text)$$,
  'deleted message is publicly sanitized'
);

select throws_ok(
  $$select count(*) from public.chat_message_deletion_audits$$,
  '42501', null,
  'ordinary user has no privilege to read deletion audit content'
);

select results_eq(
  $$select count(*)::bigint from public.ai_persona_versions where persona_id = 'test_persona'$$,
  $$values (0::bigint)$$,
  'ordinary client cannot read private persona versions'
);

-- A permanent user has the same ownership boundary.
set local request.jwt.claims = '{"sub":"22222222-2222-2222-2222-222222222222","role":"authenticated","is_anonymous":false,"app_metadata":{}}';

select lives_ok(
  $$update public.posts set title = '修改自己的观点' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2'$$,
  'registered user updates own post'
);

select results_eq(
  $$update public.posts set title = '越权修改' where id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1' returning id$$,
  $$select id from public.posts where false$$,
  'registered user cannot update another post'
);

select results_eq(
  $$update public.chat_messages set content = '越权修改消息' where id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1' returning id$$,
  $$select id from public.chat_messages where false$$,
  'registered user cannot update another message'
);

-- Admin authority comes from app_metadata, not user_metadata.
set local request.jwt.claims = '{"sub":"33333333-3333-3333-3333-333333333333","role":"authenticated","is_anonymous":false,"app_metadata":{"role":"admin"},"user_metadata":{"role":"ordinary"}}';

select lives_ok(
  $$insert into public.ai_personas (id, display_name) values ('admin_persona', '管理员创建的人格')$$,
  'admin creates AI persona configuration using app_metadata role'
);

select results_eq(
  $$select count(*)::bigint from public.ai_persona_versions where persona_id = 'test_persona'$$,
  $$values (1::bigint)$$,
  'admin reads private persona versions'
);

select results_eq(
  $$select count(*)::bigint from public.chat_ai_tasks where trigger_message_id in (
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2',
    'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb3'
  )$$,
  $$values (0::bigint)$$,
  'admin can read the private task table'
);

-- The trusted service role bypasses RLS and can create AI messages and tasks.
reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select lives_ok(
  $$insert into public.chat_ai_tasks (room_id, trigger_message_id, persona_id, persona_version, scheduled_at, model_config_snapshot, prompt_version) values ('echo-public-mood', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2', 'test_persona', 1, now(), '{"model":"test"}'::jsonb, 'test-v1')$$,
  'trusted service role creates an AI task'
);

select lives_ok(
  $$insert into public.chat_messages (room_id, sender_type, persona_id, sender_name_snapshot, content, persona_version, model_config_snapshot, prompt_version, reply_to_message_id) values ('echo-public-mood', 'ai', 'test_persona', '测试人格', '服务端 AI 回复', 1, '{"model":"test"}'::jsonb, 'test-v1', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2')$$,
  'trusted service role creates an AI message'
);

select * from finish();
rollback;
