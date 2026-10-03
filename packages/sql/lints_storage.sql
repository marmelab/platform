-- Storage rules of the security linter (see lints.sql for the origin and the conventions). Run only when
-- storage.buckets exists (Storage creates it when the app's tenant is registered).

-- 0025_public_bucket_allows_listing: a public bucket serves its objects by URL without any policy; a broad SELECT
-- policy on storage.objects additionally lets anyone list (and find) every file of the bucket
with public_buckets as (
  select id::text as bucket_id from storage.buckets where public
),
listing_policies as (
  select b.bucket_id, p.policyname
    from public_buckets b
    join pg_policies p
      on p.schemaname = 'storage' and p.tablename = 'objects' and p.cmd in ('SELECT', 'ALL')
     and p.permissive = 'PERMISSIVE' and p.roles && array['public', 'anon', 'authenticated']::name[]
   where p.qual is null
      or regexp_replace(lower(p.qual), '\s', '', 'g') in ('true', '(true)', '1=1', '(1=1)')
      or (regexp_match(p.qual, $re$\A\s*\(*\s*bucket_id\s*=\s*('(?:[^']|'')*')(\s*::\s*[[:alnum:]_\.]+)?\s*\)*\s*\Z$re$, 'i'))[1]
         = quote_literal(b.bucket_id)
)
select 'public_bucket_allows_listing' as name, 'WARN' as level,
       'storage bucket ' || bucket_id as object,
       format('Public bucket with a broad SELECT policy on storage.objects (%s): anyone can list all its files. '
         || 'Public buckets do not need it to serve files by URL', string_agg(quote_ident(policyname), ', ' order by policyname)) as detail
from listing_policies
group by bucket_id
