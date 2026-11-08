begin;

create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(14);

insert into auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
values (
  '77777777-7777-4777-8777-777777777777',
  'authenticated', 'authenticated', 'post-owner@echo.test', '{}'::jsonb,
  '{"display_name":"帖子测试用户"}'::jsonb
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"77777777-7777-4777-8777-777777777777","role":"authenticated","is_anonymous":true,"app_metadata":{}}';

select throws_ok(
  $$select public.create_community_post_bundle(
    '70000000-0000-4000-8000-000000000001', '77777777-7777-4777-8777-777777777777',
    'diary', '测试日记', '正文', '70000000-0000-4000-8000-000000000002',
    '70000000-0000-4000-8000-000000000003', '{}'::jsonb, '{}'::jsonb,
    '{"model":"analysis"}'::jsonb, null, 'model', '',
    '70000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000005',
    '{}'::jsonb, 'system', '{"model":"comment"}'::jsonb, '[]'::jsonb, '{}'::jsonb
  )$$,
  '42501', null,
  'ordinary clients cannot forge a complete AI generation bundle'
);

reset role;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

select is(
  public.create_community_post_bundle(
    '70000000-0000-4000-8000-000000000001', '77777777-7777-4777-8777-777777777777',
    'diary', '测试日记', E'第一行\n第二行', '70000000-0000-4000-8000-000000000002',
    '70000000-0000-4000-8000-000000000003', '{"topics":["生活"]}'::jsonb,
    '{"id":"70000000-0000-4000-8000-000000000006","version":1}'::jsonb,
    '{"model":"analysis"}'::jsonb, '{"totalTokens":12}'::jsonb, 'model', '',
    '70000000-0000-4000-8000-000000000004', '70000000-0000-4000-8000-000000000005',
    '{"id":"70000000-0000-4000-8000-000000000005","version":1}'::jsonb,
    'system', '{"model":"comment"}'::jsonb,
    '[{"id":"70000000-0000-4000-8000-000000000007","personaId":"reader","scheduledAt":"2099-11-08T01:00:00Z"}]'::jsonb,
    '{"id":"70000000-0000-4000-8000-000000000008","version":1}'::jsonb
  ),
  '70000000-0000-4000-8000-000000000001'::uuid,
  'trusted server atomically creates a post bundle'
);

select results_eq(
  $$select content_type::text, title, body from public.posts where id = '70000000-0000-4000-8000-000000000001'$$,
  $$values ('diary'::text, '测试日记'::text, E'第一行\n第二行'::text)$$,
  'the public post preserves content and line breaks'
);

select is((select count(*) from public.post_inputs), 1::bigint, 'one immutable input is stored');
select is((select count(*) from public.post_content_analyses), 1::bigint, 'one analysis snapshot is stored');
select is((select count(*) from public.post_generation_runs), 1::bigint, 'one generation run is stored');
select is((select count(*) from public.post_comment_tasks), 1::bigint, 'one delayed task is stored');

select is(
  (select count(*) from public.claim_due_post_comment_tasks(
    2, '2099-11-08T00:00:00Z', '2099-11-08T02:00:00Z'
  )),
  1::bigint,
  'a due task is claimed exactly once'
);

select is(
  (select count(*) from public.claim_due_post_comment_tasks(
    2, '2099-11-08T00:00:00Z', '2099-11-08T02:00:00Z'
  )),
  0::bigint,
  'a running task cannot be claimed twice'
);

select is(
  (select count(*) from public.complete_post_comment_task(
    '70000000-0000-4000-8000-000000000007',
    (select execution_token from public.post_comment_tasks where id = '70000000-0000-4000-8000-000000000007'),
    '具体的一条 AI 评论', '{"id":"reader","name":"细读者","version":1}'::jsonb,
    '{"totalTokens":20}'::jsonb
  )),
  1::bigint,
  'completion atomically stores one AI comment'
);

select results_eq(
  $$select t.status, c.content from public.post_comment_tasks t
    join public.post_comments c on c.id = t.comment_id
    where t.id = '70000000-0000-4000-8000-000000000007'$$,
  $$values ('completed'::text, '具体的一条 AI 评论'::text)$$,
  'task and generated comment remain linked'
);

select results_eq(
  $$select status, (completed_at is not null) from public.post_generation_runs
    where id = '70000000-0000-4000-8000-000000000004'$$,
  $$values ('completed'::text, true)$$,
  'the generation run completes after all tasks settle'
);

select is(
  public.delete_community_post(
    '70000000-0000-4000-8000-000000000001',
    '77777777-7777-4777-8777-777777777777'
  ),
  true,
  'the owner can soft-delete the post through the trusted repository'
);

select results_eq(
  $$select status::text, (deleted_at is not null) from public.posts
    where id = '70000000-0000-4000-8000-000000000001'$$,
  $$values ('deleted'::text, true)$$,
  'soft deletion preserves the post record and provenance'
);

select * from finish();
rollback;
