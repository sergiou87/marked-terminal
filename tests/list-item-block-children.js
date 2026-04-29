import { ok, match, doesNotMatch, equal } from 'assert';
import chalk from 'chalk';
import { markedTerminal } from '../index.js';
import marked, { resetMarked } from './_marked.js';

// Force chalk colors so block renderers wrap content in ANSI codes —
// the bug we're driving out (extra blank lines around html siblings)
// is triggered by ANSI sequences interacting with `bulletPointLines`'
// `.filter(identity)` empty-line drop. Under piped mocha output chalk
// auto-disables (`chalk.level === 0`), which would mask the bug. We
// restore the previous level after the suite to avoid surprising
// other test files.
const prevChalkLevel = chalk.level;
before(function () {
  chalk.level = 3;
});
after(function () {
  chalk.level = prevChalkLevel;
});

// Strip ANSI escape sequences (colors, hyperlinks, formatting) so we can
// assert against pure text. The patterns here are a superset of what the
// existing inline-formatting.js helper strips because some block renderers
// emit OSC and CSI sequences with multiple parameter bytes.
function stripAnsi(str) {
  return str
    .replace(/\u001b\]8;[^\u0007]*\u0007/g, '')
    .replace(/\u001b\[[\d;]*m/g, '');
}

function render(md, opts) {
  resetMarked();
  marked.use(markedTerminal(Object.assign({ reflowText: false }, opts)));
  return stripAnsi(marked.parse(md));
}

describe('List item children: separators between inline prose and block tokens', function () {
  beforeEach(function () {
    resetMarked();
  });

  it('does not glue a table to the prose line in a tight ordered list item', function () {
    const md = [
      '1. Intro:',
      '   | A | B |',
      '   | - | - |',
      '   | 1 | 2 |'
    ].join('\n');

    const out = render(md, { width: 80 });

    doesNotMatch(out, /Intro:[^\n]*┌/);
    match(out, /Intro:\s*\n[^\n]*┌/);
  });

  it('does not glue a table to the prose line in a loose ordered list item', function () {
    const md = [
      '1. **Header** with intro:',
      '',
      '   | A | B |',
      '   |---|---|',
      '   | x | y |'
    ].join('\n');

    const out = render(md, { width: 80 });

    doesNotMatch(out, /:┌/);
    match(out, /intro:\s*\n[^\n]*┌/);
  });

  it('does not glue a blockquote to the prose line in a tight list item', function () {
    const md = ['1. Intro:', '   > A blockquote inside a list item.'].join('\n');

    const out = render(md, { width: 100 });

    doesNotMatch(out, /Intro:[^\n]*A blockquote/);
    match(out, /Intro:\s*\n[^\n]*A blockquote/);
  });

  it('does not glue a blockquote to the prose line in a loose list item', function () {
    const md = [
      '1. **Intro:**',
      '',
      '   > A blockquote inside a list item.',
      '2. After.',
      ''
    ].join('\n');

    const out = render(md, { width: 100 });

    doesNotMatch(out, /Intro:[^\n]*A blockquote/);
    match(out, /Intro:\s*\n[^\n]*A blockquote/);
  });

  it('does not glue a fenced code block to the prose line in a list item', function () {
    const md = [
      '1. Run this:',
      '',
      '   ```bash',
      '   echo hello',
      '   ```',
      '2. Done.',
      ''
    ].join('\n');

    const out = render(md, { width: 100 });

    doesNotMatch(out, /Run this:[^\n]*echo hello/);
    match(out, /Run this:\s*\n[\s\S]*echo hello/);
  });

  it('does not glue a heading to the prose line in a tight list item', function () {
    const md = ['1. Intro', '   # Heading'].join('\n');

    const out = render(md, { width: 100, showSectionPrefix: true });

    doesNotMatch(out, /Intro[^\n]*# Heading/);
    match(out, /Intro\s*\n[\s\S]*Heading/);
  });

  it('preserves task-list checkbox layout when the item also contains a table', function () {
    const md = [
      '- [ ] Open task with **bold**:',
      '',
      '  | A | B |',
      '  |---|---|',
      '  | 1 | 2 |'
    ].join('\n');

    const out = render(md, { width: 80 });

    ok(out.includes('[ ]'), 'checkbox should be preserved');
    doesNotMatch(out, /:┌/);
    ok(out.includes('┌'), 'table top border should appear');
    ok(out.includes('│ 1'), 'table body should appear');
  });

  it('does not introduce extra newlines for a tight list with no block children', function () {
    const md = ['- item 1', '- item 2', '- item 3', ''].join('\n');

    const out = render(md, { width: 80 });

    // Each item should appear on exactly one bullet line, in order, with no
    // blank line between them.
    equal(out, '    * item 1\n    * item 2\n    * item 3\n\n');
  });

  it('does not split decimal text as a nested ordered list', function () {
    const md = '1. Peer harnesses get 33.3%. Almost certainly a config bug.';

    const out = render(md, { width: 80, reflowText: false });

    equal(out, '    1. Peer harnesses get 33.3%. Almost certainly a config bug.\n\n');
  });

  it('does not duplicate task-checkbox text when the same markdown is rendered twice', function () {
    const md = '- [x] Done **task**\n';

    resetMarked();
    marked.use(markedTerminal({ reflowText: false }));
    const first = stripAnsi(marked.parse(md));
    const second = stripAnsi(marked.parse(md));

    equal((first.match(/\[X\]/g) || []).length, 1);
    equal((second.match(/\[X\]/g) || []).length, 1);
  });

  it('renders the original failing session content without a floating top border', function () {
    // Verbatim excerpt of the assistant message that produced the broken
    // render reported in copilot-agent-runtime PR #7141.
    const md = [
      '2. **7 runs trimmed across 6 cells** (full audit in Appendix A.4):',
      '',
      '   | Cell | Trimmed | AvgRate change |',
      '   |---|---|---|',
      '   | Claude Code sonnet `copilotclibench` | r1=57.14% (lone-low) | 62.86 → **64.29** |',
      '   | Codex gpt-5.4 `mcpmark-mutated` | r2=51.90% (lone-low) | 58.48 → **60.13** |',
      ''
    ].join('\n');

    const out = render(md, { width: 200 });

    doesNotMatch(out, /A\.4\):┌/);
    match(out, /A\.4\):\s*\n[^\n]*┌/);
  });

  it('does not glue a horizontal rule to the prose line in a list item', function () {
    const md = ['- Intro:', '', '  ***', '- After'].join('\n');

    // Use reflowText:true so `Renderer.prototype.hr`'s rendered length
    // is deterministic from `width` rather than falling back to
    // `process.stdout.columns` (which is undefined under piped mocha
    // output and would yield an empty hr).
    const out = render(md, { width: 40, reflowText: true });

    doesNotMatch(out, /Intro:[^\n]*-/);
    match(out, /Intro:\s*\n[\s\S]*-{3,}/);
  });

  it('does not glue an html block to the prose line, AND still expands emoji / unescapes entities', function () {
    // `Renderer.prototype.html` does not append a newline, so historically
    // a tight list item with `[text, html]` siblings rendered as
    // `Intro :smile:<div>x</div>` — glued. The naive separator fix would
    // restore separation but flip `isNested` true and silently drop
    // emoji/entity transforms on the prose. This case asserts BOTH:
    //   * the html sibling is on its own line (no gluing), and
    //   * the prose still gets emoji/entity transforms applied.
    const out1 = render('- Intro :smile:\n  <div>x</div>', { width: 80 });
    ok(out1.includes('😄'), `expected emoji expansion, got: ${JSON.stringify(out1)}`);
    doesNotMatch(out1, /:smile:/);
    doesNotMatch(out1, /😄[^\n]*<div>/);
    match(out1, /😄[\s\S]*\n[\s\S]*<div>x<\/div>/);

    const out2 = render('- Intro &amp; html\n  <div>x</div>', { width: 80 });
    ok(out2.includes('Intro & html'), `expected entity unescape, got: ${JSON.stringify(out2)}`);
    doesNotMatch(out2, /&amp;/);
    doesNotMatch(out2, /Intro &[^\n]*<div>/);
  });

  it('still renders nested ordered/unordered lists with correct markers', function () {
    // Regression guard: the gluing fix must NOT split before nested `list`
    // tokens, because `fixNestedLists` post-processing relies on the
    // sub-list being glued to its parent prose at this stage. If the fix
    // gets generalised, these assertions catch the resulting renumbering
    // (e.g. inner `* ul item` getting rewritten to `2. ul item`).
    const olul = '1. ol item\n    * ul item';
    const ulol = '* ul item\n    1. ol item';

    equal(
      render(olul, {}),
      '    1. ol item\n        * ul item\n\n'
    );
    equal(
      render(ulol, {}),
      '    * ul item\n        1. ol item\n\n'
    );
  });

  // === FAILING TEST for the unified post-pass refactor ===
  //
  // Reproduces the real defect in the current chunked-parse
  // implementation that a unified approach should fix.

  it('inserts exactly ONE blank line (not two) between an html sibling and a following block', function () {
    // gpt-5.5-edge-b's regression: `[html, table]` siblings produce two
    // blank lines between them in the chunked-parse implementation,
    // because `parser.parse([html])` and `parser.parse([table])` are
    // called separately. The html token's `text` already includes its
    // trailing `\n\n` (verbatim from the source), and the table starts
    // its own `section()` `\n\n`. The chunked path's
    // `text.endsWith('\n')` guard suppresses our synthetic separator,
    // but the natural `\n\n` from the html PLUS the leading `\n` of the
    // table's section still combine to `\n\n\n` between them.
    //
    // Baseline (`parser.parse([html, table], false)` single-call) yields
    // exactly one blank line between the html and the table — that is
    // the contract this test pins down.
    const md = ['- <div>x</div>', '', '  | A |', '  | - |', '  | 1 |', ''].join('\n');

    const out = render(md, { width: 80 });

    // Exactly one blank line (i.e. exactly two `\n` characters with only
    // whitespace between content lines) — not two blank lines (three
    // newlines).
    match(
      out,
      /<\/div>[ \t]*\n[ \t]*\n[ \t]*┌/,
      `expected exactly one blank line between </div> and ┌, got: ${JSON.stringify(out)}`
    );
    doesNotMatch(
      out,
      /<\/div>[ \t]*\n[ \t]*\n[ \t]*\n[ \t]*┌/,
      `expected NOT to find more than one blank line between </div> and ┌, got: ${JSON.stringify(out)}`
    );
  });

  it('does not apply transform across multi-line text token content (tight)', function () {
    // Regression flagged by gpt-5.5 reviewers: a tight item like
    //   - first
    //     second
    // produces a single `text` token whose `.text === "first\nsecond"`
    // and renders multi-line. The pre-fix `text.indexOf('\n')`
    // heuristic correctly suppressed `transform(text)` for this case;
    // a token-types-only heuristic misses it and leaks the custom
    // `o.listitem` (and emoji/entity transforms) across both lines.
    const out = render('- first\n  second', {
      width: 80,
      listitem: (s) => '[' + s + ']'
    });

    // The custom listitem decorator must NOT wrap the multi-line item
    // (consistent with pre-fix behavior).
    doesNotMatch(
      out,
      /\[first/,
      `expected listitem transform NOT to fire on multi-line item, got: ${JSON.stringify(out)}`
    );
  });

  it('does not apply transform across multi-line html block content (tight)', function () {
    // Regression flagged by gpt-5.5 reviewers: a tight item with html
    // whose own `.text` contains `\n` (e.g. multi-line raw HTML) was
    // multi-line pre-fix and skipped `transform`. A coarse "is the
    // top-level type in a set?" check misses this and leaks emoji /
    // entity unescape into the html block content.
    const out = render('- Intro\n  <div>&amp; :smile:\n  x</div>', {
      width: 80
    });

    // Emoji shortcode and entity inside the multi-line html block
    // must NOT be transformed.
    doesNotMatch(
      out,
      /😄/,
      `expected emoji NOT to be expanded inside multi-line html, got: ${JSON.stringify(out)}`
    );
    ok(
      out.includes(':smile:'),
      `expected literal :smile: to remain inside multi-line html, got: ${JSON.stringify(out)}`
    );
    ok(
      out.includes('&amp;'),
      `expected literal &amp; to remain inside multi-line html, got: ${JSON.stringify(out)}`
    );
  });
});
