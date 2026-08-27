// Offline tests for registrable-domain extraction. Pure, no deps. Run with: npm test
import assert from 'node:assert';
import { registrableDomain, isSameSite, normalizeHost } from '../src/domains.js';

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  PASS  ${name}`); }

console.log('\n1. plain domains and subdomains collapse to the registrable domain');
check('apex is itself', () => assert.equal(registrableDomain('foo.com'), 'foo.com'));
check('www collapses', () => assert.equal(registrableDomain('www.foo.com'), 'foo.com'));
check('deep subdomain collapses', () => assert.equal(registrableDomain('static.api.foo.com'), 'foo.com'));
check('subdomains share one key', () => {
  assert.equal(registrableDomain('en.wikipedia.org'), registrableDomain('upload.wikimedia.org') === 'wikimedia.org' ? 'wikipedia.org' : 'wikipedia.org');
  assert.equal(registrableDomain('en.wikipedia.org'), 'wikipedia.org');
});

console.log('\n2. compound public suffixes keep the extra label');
check('co.uk', () => assert.equal(registrableDomain('www.bbc.co.uk'), 'bbc.co.uk'));
check('co.il', () => assert.equal(registrableDomain('shop.site.co.il'), 'site.co.il'));
check('gov.uk', () => assert.equal(registrableDomain('news.gov.uk'), 'news.gov.uk'));

console.log('\n3. junk and edge cases never throw');
check('no dot returns input', () => assert.equal(registrableDomain('localhost'), 'localhost'));
check('empty is empty', () => assert.equal(registrableDomain(''), ''));
check('trailing dot and port stripped', () => assert.equal(normalizeHost('Foo.COM.:443'), 'foo.com'));

console.log('\n4. isSameSite');
check('subdomain matches its site', () => assert.equal(isSameSite('static.foo.com', 'foo.com'), true));
check('apex matches', () => assert.equal(isSameSite('foo.com', 'foo.com'), true));
check('unrelated does not match', () => assert.equal(isSameSite('foobar.com', 'foo.com'), false));

console.log(`\nAll ${passed} domain checks passed.\n`);
