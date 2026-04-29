'use strict';

import chalk from 'chalk';
import Table from 'cli-table3';
import { highlight as highlightCli } from 'cli-highlight';
import * as emoji from 'node-emoji';
import ansiEscapes from 'ansi-escapes';
import supportsHyperlinks from 'supports-hyperlinks';
import ansiRegex from 'ansi-regex';

var TABLE_CELL_SPLIT = '^*||*^';
var TABLE_ROW_WRAP = '*|*|*|*';
var TABLE_ROW_WRAP_REGEXP = new RegExp(escapeRegExp(TABLE_ROW_WRAP), 'g');

var COLON_REPLACER = '*#COLON|*';
var COLON_REPLACER_REGEXP = new RegExp(escapeRegExp(COLON_REPLACER), 'g');

var TAB_ALLOWED_CHARACTERS = ['\t'];

var ANSI_REGEXP = ansiRegex();

// HARD_RETURN holds a character sequence used to indicate text has a
// hard (no-reflowing) line break.  Previously \r and \r\n were turned
// into \n in marked's lexer- preprocessing step. So \r is safe to use
// to indicate a hard (non-reflowed) return.
var HARD_RETURN = '\r',
  HARD_RETURN_RE = new RegExp(HARD_RETURN),
  HARD_RETURN_GFM_RE = new RegExp(HARD_RETURN + '|<br />');

var defaultOptions = {
  code: chalk.yellow,
  blockquote: chalk.gray.italic,
  html: chalk.gray,
  heading: chalk.green.bold,
  firstHeading: chalk.magenta.underline.bold,
  hr: chalk.reset,
  listitem: chalk.reset,
  list: list,
  table: chalk.reset,
  paragraph: chalk.reset,
  strong: chalk.bold,
  em: chalk.italic,
  codespan: chalk.yellow,
  del: chalk.dim.gray.strikethrough,
  link: chalk.blue,
  href: chalk.blue.underline,
  text: identity,
  unescape: true,
  emoji: true,
  width: 80,
  showSectionPrefix: true,
  reflowText: false,
  tab: 4,
  tableOptions: {}
};

function Renderer(options, highlightOptions) {
  this.o = Object.assign({}, defaultOptions, options);
  this.tab = sanitizeTab(this.o.tab, defaultOptions.tab);
  this.tableSettings = this.o.tableOptions;
  this.emoji = this.o.emoji ? insertEmojis : identity;
  this.unescape = this.o.unescape ? unescapeEntities : identity;
  this.highlightOptions = highlightOptions || {};

  this.transform = compose(undoColon, this.unescape, this.emoji);
}

// Compute length of str not including ANSI escape codes.
// See http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
function textLength(str) {
  return str.replace(ANSI_REGEXP, '').length;
}

Renderer.prototype.textLength = textLength;

function fixHardReturn(text, reflow) {
  return reflow ? text.replace(HARD_RETURN, /\n/g) : text;
}

Renderer.prototype.space = function () {
  return '';
};

Renderer.prototype.text = function (text) {
  if (typeof text === 'object') {
    text = text.tokens ? this.parser.parseInline(text.tokens) : text.text;
  }
  return this.o.text(text);
};

Renderer.prototype.code = function (code, lang, escaped) {
  if (typeof code === 'object') {
    lang = code.lang;
    escaped = !!code.escaped;
    code = code.text;
  }
  return section(
    indentify(this.tab, highlight(code, lang, this.o, this.highlightOptions))
  );
};

Renderer.prototype.blockquote = function (quote) {
  if (typeof quote === 'object') {
    quote = this.parser.parse(quote.tokens);
  }
  return section(this.o.blockquote(indentify(this.tab, quote.trim())));
};

Renderer.prototype.html = function (html) {
  if (typeof html === 'object') {
    html = html.text;
  }
  return this.o.html(html);
};

Renderer.prototype.heading = function (text, level) {
  if (typeof text === 'object') {
    level = text.depth;
    text = this.parser.parseInline(text.tokens);
  }
  text = this.transform(text);

  var prefix = this.o.showSectionPrefix
    ? new Array(level + 1).join('#') + ' '
    : '';
  text = prefix + text;
  if (this.o.reflowText) {
    text = reflowText(text, this.o.width, this.options.gfm);
  }
  return section(
    level === 1 ? this.o.firstHeading(text) : this.o.heading(text)
  );
};

Renderer.prototype.hr = function () {
  return section(this.o.hr(hr('-', this.o.reflowText && this.o.width)));
};

Renderer.prototype.list = function (body, ordered) {
  let start = 1;
  if (typeof body === 'object') {
    const listToken = body;
    start = listToken.start ?? 1;
    const loose = listToken.loose;

    ordered = listToken.ordered;
    body = '';
    const previousListDepth = this.listDepth || 0;
    this.listDepth = previousListDepth + 1;
    try {
      for (let j = 0; j < listToken.items.length; j++) {
        const itemNumber = (start ?? 1) + j;
        const previousListItemPrefixWidth = this.listItemPrefixWidth;
        this.listItemPrefixWidth =
          this.listDepth === 1
            ? textLength(this.tab) + textLength(ordered ? numberedPoint(itemNumber) : BULLET_POINT)
            : undefined;
        body += this.listitem(listToken.items[j]);
        this.listItemPrefixWidth = previousListItemPrefixWidth;
      }
    } finally {
      this.listDepth = previousListDepth;
    }
  }
  body = this.o.list(body, ordered, this.tab, start);
  return section(fixNestedLists(indentLines(this.tab, body), this.tab));
};

Renderer.prototype.listitem = function (text) {
  // Tracks whether the rendered child output (independent of any
  // synthetic separators we inject) contains `\n`. The `isNested`
  // decision below uses this so synthetic separators don't suppress
  // the inline transform pass (emoji expansion, entity unescape,
  // custom `o.listitem`).
  var renderedChildHasNewline = false;
  if (typeof text === 'object') {
    const item = text;
    text = '';
    if (item.task) {
      const checkbox = this.checkbox({ checked: !!item.checked });
      if (item.loose) {
        if (item.tokens.length > 0 && item.tokens[0].type === 'paragraph') {
          item.tokens[0].text = checkbox + ' ' + item.tokens[0].text;
          if (
            item.tokens[0].tokens &&
            item.tokens[0].tokens.length > 0 &&
            item.tokens[0].tokens[0].type === 'text'
          ) {
            item.tokens[0].tokens[0].text =
              checkbox + ' ' + item.tokens[0].tokens[0].text;
          }
        } else {
          item.tokens.unshift({
            type: 'text',
            raw: checkbox + ' ',
            text: checkbox + ' '
          });
        }
      } else {
        text += checkbox + ' ';
      }
    }

    // When a child token of the types in
    // `BLOCK_TYPES_NEEDING_LISTITEM_SEPARATOR` follows an inline `text`
    // sibling in a TIGHT list item, the upstream
    // `parser.parse(item.tokens, false)` concatenates child outputs
    // without a separator. The block's first character (`┌`, `>`, code
    // text, `# heading`, `---`, `<div>`) ends up glued to the prose,
    // which the terminal then visually wraps high above the rest of
    // the block (most catastrophic for tables — a "floating" top
    // border).
    //
    // We fix this by pre-inserting a synthetic empty `text` token
    // before each glue point, then making a SINGLE `parser.parse`
    // call. marked's text-token coalescing in `Parser.parse` joins
    // consecutive `text` tokens with `"\n"` between their renderings,
    // so an empty synthetic text token after a real text token
    // contributes exactly the `"\n"` we want — no more, no less.
    //
    // Loose list items don't need this: marked wraps text tokens in
    // synthesized paragraphs, and the paragraph renderer's
    // `section()` adds `"\n\n"` already, naturally separating siblings.
    //
    // We deliberately do NOT split before `list` tokens —
    // `fixNestedLists` (run by the `list` renderer after `o.list`)
    // handles nested-list separation and requires the sub-list to be
    // glued to its parent prose here.
    const tokens = prepareListitemTokens(item.tokens, !!item.loose);
    text += this.parseListItemTokens(tokens, !!item.loose);
    renderedChildHasNewline =
      !!item.loose ||
      item.tokens.some(childTokenProducesNewline);
  } else {
    // Legacy string-input path (pre-marked-v5 API). Fall back to the
    // historical heuristic: any `\n` in the string suppresses transform.
    renderedChildHasNewline = text.indexOf('\n') !== -1;
  }
  var transform = compose(this.o.listitem, this.transform);
  if (!renderedChildHasNewline) {
    text = transform(text);
    if (this.o.reflowText && this.listItemPrefixWidth) {
      text = reflowText(text, this.listItemContentWidth(), this.options.gfm);
    }
  }

  // Use BULLET_POINT as a marker for ordered or unordered list item
  return '\n' + BULLET_POINT + text;
};

Renderer.prototype.listItemContentWidth = function () {
  return Math.max(1, this.o.width - (this.listItemPrefixWidth || 0));
};

Renderer.prototype.parseListItemTokens = function (tokens, loose) {
  if (!this.o.reflowText || !this.listItemPrefixWidth) {
    return this.parser.parse(tokens, loose);
  }

  const previousWidth = this.o.width;
  this.o.width = this.listItemContentWidth();
  try {
    return this.parser.parse(tokens, loose);
  } finally {
    this.o.width = previousWidth;
  }
};

Renderer.prototype.checkbox = function (checked) {
  if (typeof checked === 'object') {
    checked = checked.checked;
  }
  return '[' + (checked ? 'X' : ' ') + '] ';
};

Renderer.prototype.paragraph = function (text) {
  if (typeof text === 'object') {
    text = this.parser.parseInline(text.tokens);
  }
  var transform = compose(this.o.paragraph, this.transform);
  text = transform(text);
  if (this.o.reflowText) {
    text = reflowText(text, this.o.width, this.options.gfm);
  }
  return section(text);
};

Renderer.prototype.table = function (header, body) {
  if (typeof header === 'object') {
    const token = header;
    header = '';

    // header
    let cell = '';
    for (let j = 0; j < token.header.length; j++) {
      cell += this.tablecell(token.header[j]);
    }
    header += this.tablerow({ text: cell });

    body = '';
    for (let j = 0; j < token.rows.length; j++) {
      const row = token.rows[j];

      cell = '';
      for (let k = 0; k < row.length; k++) {
        cell += this.tablecell(row[k]);
      }

      body += this.tablerow({ text: cell });
    }
  }
  var table = new Table(
    Object.assign(
      {},
      {
        head: generateTableRow(header)[0]
      },
      this.tableSettings
    )
  );

  generateTableRow(body, this.transform).forEach(function (row) {
    table.push(row);
  });
  return section(this.o.table(table.toString()));
};

Renderer.prototype.tablerow = function (content) {
  if (typeof content === 'object') {
    content = content.text;
  }
  return TABLE_ROW_WRAP + content + TABLE_ROW_WRAP + '\n';
};

Renderer.prototype.tablecell = function (content) {
  if (typeof content === 'object') {
    content = this.parser.parseInline(content.tokens);
  }
  return content + TABLE_CELL_SPLIT;
};

// span level renderer
Renderer.prototype.strong = function (text) {
  if (typeof text === 'object') {
    text = this.parser.parseInline(text.tokens);
  }
  return this.o.strong(text);
};

Renderer.prototype.em = function (text) {
  if (typeof text === 'object') {
    text = this.parser.parseInline(text.tokens);
  }
  text = fixHardReturn(text, this.o.reflowText);
  return this.o.em(text);
};

Renderer.prototype.codespan = function (text) {
  if (typeof text === 'object') {
    text = text.text;
  }
  text = fixHardReturn(text, this.o.reflowText);
  return this.o.codespan(text.replace(/:/g, COLON_REPLACER));
};

Renderer.prototype.br = function () {
  return this.o.reflowText ? HARD_RETURN : '\n';
};

Renderer.prototype.del = function (text) {
  if (typeof text === 'object') {
    text = this.parser.parseInline(text.tokens);
  }
  return this.o.del(text);
};

Renderer.prototype.link = function (href, title, text) {
  if (typeof href === 'object') {
    title = href.title;
    text = this.parser.parseInline(href.tokens);
    href = href.href;
  }

  if (this.options.sanitize) {
    try {
      var prot = decodeURIComponent(unescape(href))
        .replace(/[^\w:]/g, '')
        .toLowerCase();
    } catch (e) {
      return '';
    }
    if (prot.indexOf('javascript:') === 0) {
      return '';
    }
  }

  var hasText = text && text !== href;

  var out = '';

  if (supportsHyperlinks.stdout) {
    let link = '';
    if (text) {
      link = this.o.href(this.emoji(text));
    } else {
      link = this.o.href(href);
    }
    out = ansiEscapes.link(
      link,
      href
        // textLength breaks on '+' in URLs
        .replace(/\+/g, '%20')
    );
  } else {
    if (hasText) out += this.emoji(text) + ' (';
    out += this.o.href(href);
    if (hasText) out += ')';
  }
  return this.o.link(out);
};

Renderer.prototype.image = function (href, title, text) {
  if (typeof href === 'object') {
    title = href.title;
    text = href.text;
    href = href.href;
  }

  if (typeof this.o.image === 'function') {
    return this.o.image(href, title, text);
  }
  var out = '![' + text;
  if (title) out += ' – ' + title;
  return out + '](' + href + ')\n';
};

export default Renderer;

export function markedTerminal(options, highlightOptions) {
  const r = new Renderer(options, highlightOptions);

  const funcs = [
    'text',
    'code',
    'blockquote',
    'html',
    'heading',
    'hr',
    'list',
    'listitem',
    'checkbox',
    'paragraph',
    'table',
    'tablerow',
    'tablecell',
    'strong',
    'em',
    'codespan',
    'br',
    'del',
    'link',
    'image'
  ];

  return funcs.reduce(
    (extension, func) => {
      extension.renderer[func] = function (...args) {
        r.options = this.options;
        r.parser = this.parser;
        return r[func](...args);
      };
      return extension;
    },
    { renderer: {}, useNewRenderer: true }
  );
}

// Munge \n's and spaces in "text" so that the number of
// characters between \n's is less than or equal to "width".
function reflowText(text, width, gfm) {
  // Hard break was inserted by Renderer.prototype.br or is
  // <br /> when gfm is true
  var splitRe = gfm ? HARD_RETURN_GFM_RE : HARD_RETURN_RE,
    sections = text.split(splitRe),
    reflowed = [];

  sections.forEach(function (section) {
    // Split the section by escape codes so that we can
    // deal with them separately.
    var fragments = section.split(/(\u001b\[(?:\d{1,3})(?:;\d{1,3})*m)/g);
    var column = 0;
    var currentLine = '';
    var lastWasEscapeChar = false;

    while (fragments.length) {
      var fragment = fragments[0];

      if (fragment === '') {
        fragments.splice(0, 1);
        lastWasEscapeChar = false;
        continue;
      }

      // This is an escape code - leave it whole and
      // move to the next fragment.
      if (!textLength(fragment)) {
        currentLine += fragment;
        fragments.splice(0, 1);
        lastWasEscapeChar = true;
        continue;
      }

      var words = fragment.split(/[ \t\n]+/);

      for (var i = 0; i < words.length; i++) {
        var word = words[i];
        var addSpace = column != 0;
        if (lastWasEscapeChar) addSpace = false;

        // If adding the new word overflows the required width
        if (column + word.length + addSpace > width) {
          if (word.length <= width) {
            // If the new word is smaller than the required width
            // just add it at the beginning of a new line
            reflowed.push(trimReflowedLineEnd(currentLine));
            currentLine = word;
            column = word.length;
          } else {
            // If the new word is longer than the required width
            // split this word into smaller parts.
            var w = word.substr(0, width - column - addSpace);
            if (addSpace) currentLine += ' ';
            currentLine += w;
            reflowed.push(trimReflowedLineEnd(currentLine));
            currentLine = '';
            column = 0;

            word = word.substr(w.length);
            while (word.length) {
              var w = word.substr(0, width);

              if (!w.length) break;

              if (w.length < width) {
                currentLine = w;
                column = w.length;
                break;
              } else {
                reflowed.push(w);
                word = word.substr(width);
              }
            }
          }
        } else {
          if (addSpace) {
            currentLine += ' ';
            column++;
          }

          currentLine += word;
          column += word.length;
        }

        lastWasEscapeChar = false;
      }

      fragments.splice(0, 1);
    }

    if (textLength(currentLine)) reflowed.push(trimReflowedLineEnd(currentLine));
  });

  return reflowed.join('\n');
}

function trimReflowedLineEnd(line) {
  return line.replace(/[ \t]+((?:\u001b\[(?:\d{1,3})(?:;\d{1,3})*m)*)$/, '$1');
}

function indentLines(indent, text) {
  return text.replace(/(^|\n)(.+)/g, '$1' + indent + '$2');
}

function indentify(indent, text) {
  if (!text) return text;
  return indent + text.split('\n').join('\n' + indent);
}

var BULLET_POINT_REGEX = '\\*';
var NUMBERED_POINT_REGEX = '\\d+\\. ';
var POINT_REGEX =
  '(?:' + [BULLET_POINT_REGEX, NUMBERED_POINT_REGEX].join('|') + ')';

// Prevents nested lists from joining their parent list's last line
function fixNestedLists(body, indent) {
  var regex = new RegExp(
    '' +
      '(\\S(?: |  )?)' + // Last char of current point, plus one or two spaces
      // to allow trailing spaces
      '((?:' +
      indent +
      ')+)' + // Indentation of sub point
      '(' +
      POINT_REGEX +
      '(?:.*)+)$',
    'gm'
  ); // Body of subpoint
  return body.replace(regex, '$1\n' + indent + '$2$3');
}

var isPointedLine = function (line, indent) {
  return line.match('^(?:' + indent + ')*' + POINT_REGEX);
};

function toSpaces(str) {
  return ' '.repeat(str.length);
}

var BULLET_POINT = '* ';

const BLOCK_TYPES_NEEDING_LISTITEM_SEPARATOR = new Set([
  'table',
  'blockquote',
  'code',
  'heading',
  'hr',
  'html'
]);

// Token types whose rendered output naturally contains `\n` (used to
// decide whether the bottom `transform(text)` pass should run on a
// list item's assembled text). `list` is included because nested
// lists always render multi-line; `html` is omitted because its
// output is source-dependent (handled per-token below).
const NEWLINE_PRODUCING_LISTITEM_CHILD_TYPES = new Set([
  'table',
  'blockquote',
  'code',
  'heading',
  'hr',
  'list'
]);

// Returns true if a list-item child token's rendered output naturally
// contains a `\n` (i.e. independent of any synthetic separator we
// might insert). Block tokens in `NEWLINE_PRODUCING_LISTITEM_CHILD_TYPES`
// always do; `text` and `html` tokens do only when their own content
// has `\n` (multi-line tight prose, hard breaks, multi-line raw HTML).
function childTokenProducesNewline(tok) {
  if (NEWLINE_PRODUCING_LISTITEM_CHILD_TYPES.has(tok.type)) return true;
  if (
    (tok.type === 'text' || tok.type === 'html') &&
    typeof tok.text === 'string' &&
    tok.text.indexOf('\n') !== -1
  ) {
    return true;
  }
  return false;
}

// Pre-process a list item's child tokens for the tight-list separator
// fix: insert a synthetic empty `text` token before each child of a
// "block" type that immediately follows a (non-space) `text` sibling.
// marked's text-token coalescing in `Parser.parse` joins consecutive
// `text` tokens with `"\n"`, so the synthetic contributes exactly the
// `"\n"` that prevents the next block's first character (`┌`, `<`,
// `---`, etc.) from being glued to the prose. Loose list items skip
// this entirely because marked wraps text in synthesized paragraphs
// whose section trailing `"\n\n"` already separates siblings.
function prepareListitemTokens(tokens, loose) {
  if (loose) return tokens;
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (BLOCK_TYPES_NEEDING_LISTITEM_SEPARATOR.has(tok.type)) {
      // Find the last non-space sibling to decide whether we need to
      // insert a separator. Marked's `space` tokens render as `""`,
      // so they don't actually separate siblings visually; treat them
      // as transparent.
      let prev = null;
      for (let j = out.length - 1; j >= 0; j--) {
        if (out[j].type !== 'space') {
          prev = out[j];
          break;
        }
      }
      if (prev && prev.type === 'text') {
        out.push({ type: 'text', raw: '', text: '', escaped: true });
      }
    }
    out.push(tok);
  }
  return out;
}

function bulletPointLine(indent, line) {
  return isPointedLine(line, indent) ? line : toSpaces(BULLET_POINT) + line;
}

function bulletPointLines(lines, indent) {
  var transform = bulletPointLine.bind(null, indent);
  return lines.split('\n').filter(identity).map(transform).join('\n');
}

var numberedPoint = function (n) {
  return n + '. ';
};
function numberedLine(indent, line, num) {
  return isPointedLine(line, indent)
    ? {
        num: num + 1,
        line: line.replace(BULLET_POINT, numberedPoint(num + 1))
      }
    : {
        num: num,
        line: toSpaces(numberedPoint(num)) + line
      };
}

function numberedLines(lines, indent, start) {
  var transform = numberedLine.bind(null, indent);
  let num = (start ?? 1) - 1;
  return lines
    .split('\n')
    .filter(identity)
    .map((line) => {
      const numbered = transform(line, num);
      num = numbered.num;

      return numbered.line;
    })
    .join('\n');
}

function list(body, ordered, indent, start) {
  body = body.trim();
  body = ordered ? numberedLines(body, indent, start) : bulletPointLines(body, indent);
  return body;
}

function section(text) {
  return text + '\n\n';
}

function highlight(code, language, opts, hightlightOpts) {
  if (chalk.level === 0) return code;

  var style = opts.code;

  code = fixHardReturn(code, opts.reflowText);

  try {
    return highlightCli(code, Object.assign({}, { language }, hightlightOpts));
  } catch (e) {
    return style(code);
  }
}

function insertEmojis(text) {
  return text.replace(/:([A-Za-z0-9_\-\+]+?):/g, function (emojiString) {
    var emojiSign = emoji.get(emojiString);
    if (!emojiSign) return emojiString;
    return emojiSign + ' ';
  });
}

function hr(inputHrStr, length) {
  length = length || process.stdout.columns;
  return new Array(length).join(inputHrStr);
}

function undoColon(str) {
  return str.replace(COLON_REPLACER_REGEXP, ':');
}

function generateTableRow(text, escape) {
  if (!text) return [];
  escape = escape || identity;
  var lines = escape(text).split('\n');

  var data = [];
  lines.forEach(function (line) {
    if (!line) return;
    var parsed = line
      .replace(TABLE_ROW_WRAP_REGEXP, '')
      .split(TABLE_CELL_SPLIT);

    data.push(parsed.splice(0, parsed.length - 1));
  });
  return data;
}

function escapeRegExp(str) {
  return str.replace(/[\-\[\]\/\{\}\(\)\*\+\?\.\\\^\$\|]/g, '\\$&');
}

function unescapeEntities(html) {
  return html
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function identity(str) {
  return str;
}

function compose() {
  var funcs = arguments;
  return function () {
    var args = arguments;
    for (var i = funcs.length; i-- > 0; ) {
      args = [funcs[i].apply(this, args)];
    }
    return args[0];
  };
}

function isAllowedTabString(string) {
  return TAB_ALLOWED_CHARACTERS.some(function (char) {
    return string.match('^(' + char + ')+$');
  });
}

function sanitizeTab(tab, fallbackTab) {
  if (typeof tab === 'number') {
    return new Array(tab + 1).join(' ');
  } else if (typeof tab === 'string' && isAllowedTabString(tab)) {
    return tab;
  } else {
    return new Array(fallbackTab + 1).join(' ');
  }
}
