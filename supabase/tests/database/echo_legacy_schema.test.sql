begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(24);

select has_table('public', 'legacy_import_batches', 'legacy import batches table exists');
select has_table('public', 'lab_prompt_versions', 'lab prompt versions table exists');
select has_table('public', 'lab_inputs', 'lab inputs table exists');
select has_table('public', 'lab_generation_runs', 'lab generation runs table exists');
select has_table('public', 'legacy_posts', 'legacy posts archive exists');
select has_table('public', 'lab_content_analyses', 'lab content analyses table exists');
select has_table('public', 'lab_comment_tasks', 'lab comment tasks table exists');
select has_table('public', 'lab_comments', 'lab comments table exists');
select has_table('public', 'lab_comment_evaluations', 'lab evaluations table exists');
select has_table('public', 'lab_content_feedback', 'lab content feedback table exists');
select has_table('public', 'lab_style_feedback', 'lab style feedback table exists');
select has_table('public', 'chat_message_reports', 'chat reports table exists');
select has_table('public', 'chat_user_blocks', 'chat blocks table exists');
select has_table('public', 'chat_ai_style_feedback', 'chat AI style feedback table exists');
select has_table('public', 'chat_message_deletion_audits', 'private chat deletion audit table exists');
select has_function('public', 'delete_own_chat_message', array['text', 'uuid'], 'safe chat deletion function exists');

select results_eq(
  $$
    select count(*)::bigint
    from pg_class
    where oid in (
      'public.legacy_import_batches'::regclass,
      'public.lab_prompt_versions'::regclass,
      'public.lab_inputs'::regclass,
      'public.lab_generation_runs'::regclass,
      'public.legacy_posts'::regclass,
      'public.lab_content_analyses'::regclass,
      'public.lab_comment_tasks'::regclass,
      'public.lab_comments'::regclass,
      'public.lab_comment_evaluations'::regclass,
      'public.lab_content_feedback'::regclass,
      'public.lab_style_feedback'::regclass,
      'public.chat_message_reports'::regclass,
      'public.chat_user_blocks'::regclass,
      'public.chat_ai_style_feedback'::regclass,
      'public.chat_message_deletion_audits'::regclass
    ) and relrowsecurity
  $$,
  $$values (15::bigint)$$,
  'all migration, archive, and feedback tables have RLS enabled'
);

select col_is_fk('public', 'lab_prompt_versions', 'import_batch_id', 'lab prompts belong to an import batch');
select col_is_fk('public', 'legacy_posts', 'input_id', 'legacy posts reference lab inputs');
select col_is_fk('public', 'legacy_posts', 'run_id', 'legacy posts reference generation runs');
select col_is_fk('public', 'chat_message_reports', 'message_id', 'reports reference chat messages');
select col_is_fk('public', 'chat_ai_style_feedback', 'persona_id', 'chat style feedback references AI personas');

select results_eq(
  $$
    select count(*)::bigint
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'legacy_import_batches'
      and grantee = 'anon'
  $$,
  $$values (0::bigint)$$,
  'anonymous clients have no archive privileges'
);

select results_eq(
  $$select count(*)::bigint from public.posts$$,
  $$values (0::bigint)$$,
  'migration schema does not seed formal posts'
);

select * from finish();
rollback;
