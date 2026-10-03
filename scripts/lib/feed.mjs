// Builds an Atom feed from the digest, for NetNewsWire and other readers.
//
// Atom rather than RSS 2.0: it requires an explicit updated timestamp per entry
// and a stable id, which is what lets a reader tell a revised story from a new
// one. Readers poll it as a static file on GitHub Pages, so there is nothing to
// run and nothing to subscribe to but a URL.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Strip characters XML cannot carry at all, rather than emitting a broken feed. */
const safe = (value) => String(value ?? '')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '')
  .replace(/[\uD800-\uDFFF]/g, '');

/**
 * One entry per story, in rank order.
 *
 * The provenance that makes the brief worth reading - how many outlets ran it,
 * across how many leans, and who else carried it - goes in the entry body,
 * because a reader shows that where a notification had no room for it.
 */
export function buildAtom(digest, { siteUrl, feedUrl, title = 'Morning Brief' }) {
  const updated = new Date(digest.generatedAt).toISOString();
  const entries = digest.stories.map((story) => {
    const link = story.url || siteUrl;
    const coverage = (story.coverage ?? [])
      .map((c) => `<li>${xml(safe(c.source))} <em>(${xml(c.lean)})</em> — ${
        c.url ? `<a href="${xml(safe(c.url))}">${xml(safe(c.title))}</a>` : xml(safe(c.title))
      }</li>`)
      .join('\n        ');

    const body = [
      story.summary ? `<p>${xml(safe(story.summary))}</p>` : '',
      `<p><strong>${story.sourceCount} outlet${story.sourceCount === 1 ? '' : 's'}`,
      ` · ${story.leanCount} editorial lean${story.leanCount === 1 ? '' : 's'}`,
      ` · headline via ${xml(safe(story.headlineSource))}</strong></p>`,
      coverage ? `\n      <p>Also reported by:</p>\n      <ul>\n        ${coverage}\n      </ul>` : '',
    ].join('');

    return `  <entry>
    <title>${xml(safe(story.title))}</title>
    <link rel="alternate" href="${xml(safe(link))}"/>
    <id>tag:morning-brief,${digest.edition}:${xml(story.id)}</id>
    <updated>${updated}</updated>
    <category term="${xml(story.topic ?? 'world')}" label="${xml(safe(story.topicLabel ?? 'World'))}"/>
    <author><name>${xml(safe(story.headlineSource))}</name></author>
    <summary type="text">${xml(safe(story.summary || story.title))}</summary>
    <content type="html">${xml(body)}</content>
  </entry>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${xml(title)}</title>
  <subtitle>Ten stories ranked by how many outlets across the spectrum covered them. Edition ${xml(digest.edition)}.</subtitle>
  <link rel="self" href="${xml(feedUrl)}"/>
  <link rel="alternate" href="${xml(siteUrl)}"/>
  <id>${xml(feedUrl)}</id>
  <updated>${updated}</updated>
  <generator uri="https://github.com/philkellner/morning-brief">morning-brief</generator>
${entries}
</feed>
`;
}
