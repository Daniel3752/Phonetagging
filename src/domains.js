// Registrable-domain ("eTLD+1") extraction. Site verdicts are keyed by the whole domain, not the
// exact hostname, so one AI judgement of foo.com covers www.foo.com, static.foo.com and api.foo.com
// — a page's fan-out of subresource hosts costs one classification, not a dozen of nonsense ones.
//
// Deliberately pure and dependency-free. A full Public Suffix List would be more precise, but the
// consequence of being slightly off here is bounded and safe-ish: over-grouping means two unrelated
// sites on the same registrable domain share a verdict (rare, and they usually ARE the same
// operator); under-grouping means a subdomain gets its own verdict (a little redundant, never
// unsafe). The multi-label public suffixes below cover the ones this audience actually hits.

// Second-level labels that are really part of the suffix: bbc.co.uk, site.co.il, gov.uk, ac.il, …
// When the label before the TLD is one of these, the registrable domain takes one more label.
const MULTI_LABEL_SUFFIX_SLDS = new Set([
  'co', 'com', 'org', 'net', 'gov', 'edu', 'ac', 'mil', 'sch', 'ne', 'or', 'go', 'gob',
]);

// The bare hostname, lowercased, trailing dot and any port stripped. Returns '' for junk.
export function normalizeHost(host) {
  return String(host || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
}

// The registrable domain for a hostname. www.bbc.co.uk -> bbc.co.uk; a.b.foo.com -> foo.com;
// localhost or a bare TLD -> the input unchanged (nothing sensible to group).
export function registrableDomain(host) {
  const h = normalizeHost(host);
  if (!h || !h.includes('.')) return h;

  const labels = h.split('.');
  if (labels.length <= 2) return h;

  // If the second-to-last label is part of a compound public suffix (co.uk, co.il, gov.uk…), the
  // registrable domain is the last THREE labels; otherwise the last two.
  const secondToLast = labels[labels.length - 2];
  const take = MULTI_LABEL_SUFFIX_SLDS.has(secondToLast) ? 3 : 2;
  return labels.slice(-take).join('.');
}

// True when `host` is the registrable domain itself or a subdomain of it. Used to confirm a stored
// whole-domain verdict actually covers the requested host.
export function isSameSite(host, domain) {
  const h = normalizeHost(host);
  const d = normalizeHost(domain);
  return h === d || h.endsWith(`.${d}`);
}
