// Offline tests for search recognition and query extraction. No network, no D1. Run with: npm test
//
// The regional-domain checks are the ones that matter. A filter that only knows google.com is
// sidestepped by typing google.co.il — which is also the variant with no forced-SafeSearch
// equivalent, so it is both the easiest bypass and the least protected destination.

import assert from 'node:assert';
import { parseSearchUrl, isSearchUrl, searchCacheKey } from '../src/search.js';

let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`  PASS  ${name}`); }

console.log('\n1. ordinary searches are recognised and the words extracted');
check('google', () => {
  assert.deepEqual(parseSearchUrl('https://www.google.com/search?q=volcano+facts'),
    { engine: 'google', query: 'volcano facts', isImageSearch: false });
});
check('bing', () => {
  assert.equal(parseSearchUrl('https://www.bing.com/search?q=weather').query, 'weather');
});
check('duckduckgo at the root path', () => {
  assert.equal(parseSearchUrl('https://duckduckgo.com/?q=trains').query, 'trains');
});
check('yahoo uses p, not q', () => {
  assert.equal(parseSearchUrl('https://search.yahoo.com/search?p=news').query, 'news');
});
check('yandex uses text', () => {
  assert.equal(parseSearchUrl('https://yandex.com/search/?text=maps').query, 'maps');
});
check('youtube uses search_query', () => {
  const r = parseSearchUrl('https://www.youtube.com/results?search_query=how+to+tie+a+tie');
  assert.equal(r.engine, 'youtube');
  assert.equal(r.query, 'how to tie a tie');
});

console.log('\n2. regional domains are covered');
check('google.co.il', () => {
  assert.equal(parseSearchUrl('https://www.google.co.il/search?q=x').engine, 'google');
});
check('google.de', () => {
  assert.equal(parseSearchUrl('https://google.de/search?q=x').engine, 'google');
});
check('bing.co.uk', () => {
  assert.equal(parseSearchUrl('https://www.bing.co.uk/search?q=x').engine, 'bing');
});

console.log('\n3. image search is flagged separately from the words');
check('google tbm=isch', () => {
  assert.equal(parseSearchUrl('https://www.google.com/search?q=cars&tbm=isch').isImageSearch, true);
});
check('google udm=2', () => {
  assert.equal(parseSearchUrl('https://www.google.com/search?q=cars&udm=2').isImageSearch, true);
});
check('bing /images path', () => {
  assert.equal(parseSearchUrl('https://www.bing.com/images/search?q=cars').isImageSearch, true);
});
check('an ordinary search is not image search', () => {
  assert.equal(parseSearchUrl('https://www.google.com/search?q=cars').isImageSearch, false);
});

console.log('\n4. non-searches are not searches');
check('a plain site', () => {
  assert.equal(parseSearchUrl('https://en.wikipedia.org/wiki/Volcano'), null);
});
check('the engine landing page with no query', () => {
  assert.equal(parseSearchUrl('https://www.google.com/search'), null);
  assert.equal(parseSearchUrl('https://www.google.com/'), null);
});
check('an empty or whitespace query is not a search', () => {
  assert.equal(parseSearchUrl('https://www.google.com/search?q='), null);
  assert.equal(parseSearchUrl('https://www.google.com/search?q=%20%20'), null);
});
check('a lookalike hostname is not the engine', () => {
  assert.equal(parseSearchUrl('https://notgoogle.com/search?q=x'), null);
  assert.equal(parseSearchUrl('https://google.example.com.evil.test/search?q=x'), null);
});
check('garbage input returns null rather than throwing', () => {
  assert.equal(parseSearchUrl('not a url'), null);
  assert.equal(parseSearchUrl(''), null);
  assert.equal(parseSearchUrl(null), null);
  assert.equal(parseSearchUrl('javascript:alert(1)'), null);
});
check('isSearchUrl agrees with parseSearchUrl', () => {
  assert.equal(isSearchUrl('https://www.google.com/search?q=x'), true);
  assert.equal(isSearchUrl('https://en.wikipedia.org/'), false);
});

console.log('\n5. the cache key collapses the ways people retype the same thing');
check('case and spacing do not matter', () => {
  assert.equal(searchCacheKey('Volcano Facts'), searchCacheKey('volcano   facts'));
});
check('word order does not matter', () => {
  assert.equal(searchCacheKey('volcano facts'), searchCacheKey('facts volcano'));
});
check('punctuation does not create a fresh unjudged query', () => {
  assert.equal(searchCacheKey('volcano facts!!'), searchCacheKey('volcano, facts.'));
});
check('different words still differ', () => {
  assert.notEqual(searchCacheKey('volcano facts'), searchCacheKey('volcano photos'));
});
check('non-Latin text survives normalisation', () => {
  assert.equal(searchCacheKey('הר געש'), searchCacheKey('געש הר'));
});
check('an empty query yields an empty key rather than throwing', () => {
  assert.equal(searchCacheKey(''), '');
  assert.equal(searchCacheKey(null), '');
});

console.log(`\nAll ${passed} search checks passed.\n`);
