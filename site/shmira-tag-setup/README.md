# shmira-tag-setup

The public-facing "back up → reset & enroll → restore" page for parents putting the tag on a phone.
Written in plain language, with a technical aside for whoever is actually running enrollment.

Deployed as its own small Worker (static assets only, no D1/secrets) — deliberately separate from
`shmira-site` so this page can't break the main site.

- **Live now:** https://shmira-tag-setup.daniel08-madar.workers.dev
- **Source of truth for the detailed steps it links to:** `../../SETUP-PHONES.md`

## Deploy

```
cd site/shmira-tag-setup
npx wrangler deploy
```

Requires `CLOUDFLARE_API_TOKEN` (or `wrangler login`) for the same account as the rest of this repo.

## Putting it on getshmira.com

Not wired up yet — the token used in this session has `worker:edit` but not the zone-level
`workers_routes` (or DNS) permission needed to attach a route, and adding one blind risked being
rejected or clobbering something on the live `shmira-site` zone config. Two ways to finish it,
whichever is easier:

1. **Dashboard (one click, no new token):** Cloudflare dashboard → Workers & Pages →
   `shmira-tag-setup` → Settings → Domains & Routes → Add → either a path route
   (`getshmira.com/setup*`) or a subdomain (`setup.getshmira.com`, needs a CNAME too — the dashboard
   offers to create it).
2. **API, if you mint a token with `Zone:Workers Routes:Edit`:**
   ```
   curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     "https://api.cloudflare.com/client/v4/zones/48db1a290939c5570a05fd230a41353f/workers/routes" \
     -d '{"pattern":"getshmira.com/setup*","script":"shmira-tag-setup"}'
   ```

Either way, `shmira-site` itself is untouched — this stays a separate Worker either behind its own
route or its own subdomain.
