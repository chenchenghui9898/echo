begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(26);

select has_table('public', 'profiles', 'profiles table exists');
select has_table('public', 'posts', 'posts table exists');
select has_table('public', 'ai_personas', 'ai_personas table exists');
select has_table('public', 'ai_persona_versions', 'ai_persona_versions table exists');
select has_table('public', 'chat_rooms', 'chat_rooms table exists');
select has_table('public', 'chat_messages', 'chat_messages table exists');
select has_table('public', 'chat_ai_tasks', 'chat_ai_tasks table exists');

select results_eq(
  $$select count(*)::bigint from public.chat_rooms where room_type = 'public_mood'$$,
  $$values (1::bigint)$$,
  'exactly one public mood room is seeded'
);

select col_is_fk('public', 'profiles', 'id', 'profiles.id references auth.users');
select col_is_fk('public', 'posts', 'user_id', 'posts.user_id references profiles');
select results_eq(
  $$
    select count(*)::bigint
    from pg_constraint
    where conrelid = 'public.chat_messages'::regclass
      and conname = 'chat_messages_reply_same_room'
      and contype = 'f'
  $$,
  $$values (1::bigint)$$,
  'chat reply uses a same-room composite foreign key'
);
select col_is_fk('public', 'chat_ai_tasks', 'persona_id', 'AI tasks reference AI personas');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass),
  'profiles has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.posts'::regclass),
  'posts has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.ai_personas'::regclass),
  'ai_personas has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.ai_persona_versions'::regclass),
  'ai_persona_versions has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.chat_rooms'::regclass),
  'chat_rooms has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.chat_messages'::regclass),
  'chat_messages has RLS enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.chat_ai_tasks'::regclass),
  'chat_ai_tasks has RLS enabled'
);

select has_index(
  'public',
  'chat_messages',
  'chat_messages_room_timeline_idx',
  'chat timeline index exists'
);
select has_index(
  'public',
  'chat_ai_tasks',
  'chat_ai_tasks_due_idx',
  'due task index exists'
);

select results_eq(
  $$
    select count(*)::bigint
    from pg_policies
    where schemaname = 'public'
      and tablename = 'chat_ai_tasks'
      and policyname = 'chat_ai_tasks_admin_read'
  $$,
  $$values (1::bigint)$$,
  'AI tasks expose only the explicit admin read policy to client roles'
);

select results_eq(
  $$
    select count(*)::bigint
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'chat_ai_tasks'
      and grantee in ('anon', 'authenticated')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
  $$,
  $$values (0::bigint)$$,
  'client roles cannot write AI tasks'
);

select results_eq(
  $$
    select count(*)::bigint
    from pg_policies
    where schemaname = 'public'
      and tablename = 'chat_messages'
      and policyname = 'chat_messages_insert_human_self'
  $$,
  $$values (1::bigint)$$,
  'human message insert policy exists'
);

select results_eq(
  $$
    select count(*)::bigint
    from pg_constraint
    where conrelid = 'public.chat_messages'::regclass
      and conname = 'chat_messages_exactly_one_sender'
  $$,
  $$values (1::bigint)$$,
  'chat messages enforce one sender identity kind'
);

select results_eq(
  $$
    select count(*)::bigint
    from pg_constraint
    where conrelid = 'public.chat_rooms'::regclass
      and conname = 'chat_rooms_single_public_mood'
  $$,
  $$values (1::bigint)$$,
  'database constrains the public mood room to one row'
);

select * from finish();
rollback;
