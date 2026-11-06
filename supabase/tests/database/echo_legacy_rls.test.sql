begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(13);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values
  ('44444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated', 'owner@echo.test', '{}'::jsonb, '{"display_name":"反馈用户"}'::jsonb),
  ('55555555-5555-4555-8555-555555555555', 'authenticated', 'authenticated', 'other@echo.test', '{}'::jsonb, '{"display_name":"其他用户"}'::jsonb),
  ('66666666-6666-4666-8666-666666666666', 'authenticated', 'authenticated', 'admin2@echo.test', '{"role":"admin"}'::jsonb, '{"display_name":"管理员"}'::jsonb);

insert into public.ai_personas (id, display_name) values ('feedback_persona', '反馈人格');
insert into public.chat_messages (
  id, room_id, sender_type, persona_id, sender_name_snapshot, content,
  persona_version, model_config_snapshot, prompt_version
) values (
  '77777777-7777-4777-8777-777777777777', 'echo-public-mood', 'ai', 'feedback_persona', '反馈人格', '测试 AI 消息',
  1, '{"model":"test"}'::jsonb, 'test-v1'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"44444444-4444-4444-8444-444444444444","role":"authenticated","app_metadata":{}}';

select results_eq(
  $$select count(*)::bigint from public.legacy_import_batches$$,
  $$values (0::bigint)$$,
  'ordinary user cannot read import archives'
);

select throws_ok(
  $$insert into public.legacy_import_batches (source_name, source_checksum, source_schema_version, source_counts, raw_document) values ('forged', repeat('a', 64), 7, '{}'::jsonb, '{}'::jsonb)$$,
  '42501', null,
  'ordinary user cannot write import archives'
);

select lives_ok(
  $$insert into public.chat_message_reports (room_id, message_id, reporter_user_id, reported_persona_id, reason) values ('echo-public-mood', '77777777-7777-4777-8777-777777777777', '44444444-4444-4444-8444-444444444444', 'feedback_persona', 'other')$$,
  'user can report a message as self'
);

select throws_ok(
  $$insert into public.chat_message_reports (room_id, message_id, reporter_user_id, reported_persona_id, reason) values ('echo-public-mood', '77777777-7777-4777-8777-777777777777', '55555555-5555-4555-8555-555555555555', 'feedback_persona', 'other')$$,
  '42501', null,
  'user cannot report as another user'
);

select lives_ok(
  $$insert into public.chat_ai_style_feedback (room_id, message_id, persona_id, model, prompt_version, user_id, feedback_type, reasons) values ('echo-public-mood', '77777777-7777-4777-8777-777777777777', 'feedback_persona', 'test', 'test-v1', '44444444-4444-4444-8444-444444444444', 'dislike', array['vague'])$$,
  'user can save own AI style feedback'
);

select throws_ok(
  $$insert into public.chat_ai_style_feedback (room_id, message_id, persona_id, model, prompt_version, user_id, feedback_type) values ('echo-public-mood', '77777777-7777-4777-8777-777777777777', 'feedback_persona', 'test', 'test-v1', '55555555-5555-4555-8555-555555555555', 'like')$$,
  '42501', null,
  'user cannot save feedback as another user'
);

select results_eq(
  $$select count(*)::bigint from public.chat_message_reports where message_id = '77777777-7777-4777-8777-777777777777'$$,
  $$values (1::bigint)$$,
  'user reads own report'
);

select results_eq(
  $$select count(*)::bigint from public.chat_ai_style_feedback where message_id = '77777777-7777-4777-8777-777777777777'$$,
  $$values (1::bigint)$$,
  'user reads own style feedback'
);

set local request.jwt.claims = '{"sub":"55555555-5555-4555-8555-555555555555","role":"authenticated","app_metadata":{}}';

select results_eq(
  $$select count(*)::bigint from public.chat_message_reports where message_id = '77777777-7777-4777-8777-777777777777'$$,
  $$values (0::bigint)$$,
  'other user cannot read report'
);

select results_eq(
  $$select count(*)::bigint from public.chat_ai_style_feedback where message_id = '77777777-7777-4777-8777-777777777777'$$,
  $$values (0::bigint)$$,
  'other user cannot read style feedback'
);

set local request.jwt.claims = '{"sub":"66666666-6666-4666-8666-666666666666","role":"authenticated","app_metadata":{"role":"admin"}}';

select results_eq(
  $$select count(*)::bigint from public.chat_message_reports where message_id = '77777777-7777-4777-8777-777777777777'$$,
  $$values (1::bigint)$$,
  'admin reads reports'
);

select results_eq(
  $$select count(*)::bigint from public.chat_ai_style_feedback where message_id = '77777777-7777-4777-8777-777777777777'$$,
  $$values (1::bigint)$$,
  'admin reads style feedback'
);

reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select lives_ok(
  $$insert into public.legacy_import_batches (source_name, source_checksum, source_schema_version, source_counts, raw_document) values ('trusted', repeat('b', 64), 7, '{}'::jsonb, '{}'::jsonb)$$,
  'service role writes import archive'
);

select * from finish();
rollback;
