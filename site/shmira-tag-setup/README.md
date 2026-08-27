# shmira-tag-setup

The public-facing "back up → reset & enroll → restore" page for parents putting the tag on a phone.
Styled to match `getshmira.com`'s own design system (dark navy, gold accents, Georgia headings) —
built by scraping the live site's `<style>` block rather than guessing, since that source isn't in
this repo.

**Important:** `getshmira.com` is a different, existing product (a browser/desktop accountability
filter) with its own `/setup` signup flow already live at that path. This page is for a separate
product — Android phone tagging via Headwind — so it lives on its own subdomain rather than the
main site's routes, to avoid colliding with the real `/setup` flow.

Deployed as its own small Worker (static assets only, no D1/secrets) — deliberately separate from
`shmira-site` so this page can't break the main site.

- **Live now:** https://tag.getshmira.com
- **Source of truth for the detailed steps it links to:** `../../SETUP-PHONES.md`

## Deploy

```
cd site/shmira-tag-setup
npx wrangler deploy
```

Requires `CLOUDFLARE_API_TOKEN` (or `wrangler login`) for the same account as the rest of this repo.
The `[[routes]]` block in `wrangler.toml` attaches the `tag.getshmira.com` custom domain on every
deploy — no separate DNS/route step needed, the token used to set this up had enough permission for
`custom_domain` routes even though it couldn't hit the classic `workers/routes` API directly.
