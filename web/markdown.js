/** A small, safe markdown renderer: everything is escaped first, then a limited syntax is re-enabled. */

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(escaped) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let out = escaped.replace(/`([^`\n]+)`/g, (_, code) => keep(`<code>${code}</code>`));
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, label, url) =>
    keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`),
  );
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_, lead, url) =>
    `${lead}${keep(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)}`,
  );
  out = out
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, index) => stash[Number(index)]);
}

function tableRow(line, tag) {
  const cells = line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
  return `<tr>${cells.map((cell) => `<${tag}>${inline(cell.trim())}</${tag}>`).join('')}</tr>`;
}

export function renderMarkdown(source) {
  const lines = escapeHtml(source).replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const body = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i += 1;
      html.push(`<pre><code>${body.join('\n')}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 2, 6);
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1] ?? '')) {
      const rows = [`<thead>${tableRow(line, 'th')}</thead><tbody>`];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(tableRow(lines[i++], 'td'));
      html.push(`<div class="md-table"><table>${rows.join('')}</tbody></table></div>`);
      continue;
    }

    const listItem = /^\s*([-*•]|\d+[.)])\s+(.*)$/;
    if (listItem.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && listItem.test(lines[i])) {
        let text = listItem.exec(lines[i])[2];
        i += 1;
        // Indented continuation lines belong to the item above them.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !listItem.test(lines[i])) text += ` ${lines[i++].trim()}`;
        items.push(`<li>${inline(text)}</li>`);
      }
      html.push(`<${ordered ? 'ol' : 'ul'}>${items.join('')}</${ordered ? 'ol' : 'ul'}>`);
      continue;
    }

    if (/^\s*&gt;\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) quote.push(lines[i++].replace(/^\s*&gt;\s?/, ''));
      html.push(`<blockquote>${inline(quote.join(' '))}</blockquote>`);
      continue;
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const paragraph = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !listItem.test(lines[i]) &&
      !/^\s*&gt;\s?/.test(lines[i])
    ) {
      paragraph.push(lines[i++]);
    }
    html.push(`<p>${inline(paragraph.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return html.join('');
}
