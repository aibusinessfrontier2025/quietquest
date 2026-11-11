import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../web/markdown.js';

test('markdown renders the common shapes', () => {
  const html = renderMarkdown('# Title\n\nSome **bold** and `code`.\n\n- one\n- two\n\n```\nx < 1\n```');
  assert.match(html, /<h3>Title<\/h3>/);
  assert.match(html, /<strong>bold<\/strong> and <code>code<\/code>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<pre><code>x &lt; 1<\/code><\/pre>/);
});

test('markdown never lets model output become markup', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) <script>1</script>');
  assert.ok(!/<img|<script|href="javascript/i.test(html));
  assert.match(html, /&lt;img/);
});

test('markdown links only open http(s) and mailto', () => {
  const html = renderMarkdown('[site](https://example.com/a?b=1&c=2) and https://example.org/x.');
  assert.match(html, /<a href="https:\/\/example.com\/a\?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">site<\/a>/);
  assert.match(html, /<a href="https:\/\/example.org\/x"[^>]*>https:\/\/example.org\/x<\/a>\./);
});

test('markdown tables', () => {
  const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(html, /<th>a<\/th><th>b<\/th>/);
  assert.match(html, /<td>1<\/td><td>2<\/td>/);
});
