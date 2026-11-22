const test = require('node:test');
const assert = require('node:assert/strict');

const browser = require('../src/agent/adapters/browser');

test('valid CSS selectors accept the small BRO subset', () => {
  assert.equal(browser.validSelector('a#video-title'), true);
  assert.equal(browser.validSelector('div > button'), true);
  assert.equal(browser.validSelector('.class'), true);
  assert.equal(browser.validSelector('#id'), true);
  assert.equal(browser.validSelector('input[type="text"]'), true);

  assert.equal(browser.validSelector('a{color:red}'), false);
  assert.equal(browser.validSelector('url(javascript:)'), false);
  assert.equal(browser.validSelector('expression(/)'), false);
  assert.equal(browser.validSelector(''), false);
  assert.equal(browser.validSelector('very long selector ' + 'x'.repeat(301)), false);
});

test('isLoginUrl recognizes auth walls', () => {
  assert.equal(browser.isLoginUrl('https://accounts.google.com'), true);
  assert.equal(browser.isLoginUrl('https://login.microsoftonline.com'), true);
  assert.equal(browser.isLoginUrl('https://www.linkedin.com/login'), true);
  assert.equal(browser.isLoginUrl('https://github.com/login'), true);
  assert.equal(browser.isLoginUrl('https://www.facebook.com/login'), true);
  assert.equal(browser.isLoginUrl('https://example.com'), false);
  assert.equal(browser.isLoginUrl('https://mail.google.com/mail/u/0/#inbox'), false);
});

test('youtubeUrl builds a proper search URL', () => {
  assert.equal(
    require('../src/agent/adapters/webapps').youtubeUrl('lofi beats'),
    'https://www.youtube.com/results?search_query=lofi%20beats'
  );
  assert.equal(
    require('../src/agent/adapters/webapps').youtubeUrl(''),
    'https://www.youtube.com/results?search_query='
  );
});

test('linkedinUrl builds proper search URLs', () => {
  const w = require('../src/agent/adapters/webapps');
  assert.equal(w.linkedinUrl('people', 'machine learning'),
    'https://www.linkedin.com/search/results/people/?keywords=machine%20learning');
  assert.equal(w.linkedinUrl('jobs', 'python developer'),
    'https://www.linkedin.com/jobs/search/?keywords=python%20developer');
  assert.equal(w.linkedinUrl('posts', 'AI'),
    'https://www.linkedin.com/search/results/content/?keywords=AI');
  assert.equal(w.linkedinUrl('unknown', 'test'),
    'https://www.linkedin.com/search/results/people/?keywords=test');
});