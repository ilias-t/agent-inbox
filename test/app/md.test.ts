import { describe, expect, it } from "vitest";
import { esc, safeUrl } from "../../src/lib/dom.ts";
import { inlineMd, md, plain } from "../../src/lib/md.ts";

describe("esc", () => {
  it("escapes the five HTML metacharacters", () => {
    expect(esc(`<a href="x" title='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  });
  it("renders null and undefined as empty", () => {
    expect(esc(null)).toBe("");
    expect(esc(undefined)).toBe("");
    expect(esc(3)).toBe("3");
  });
});

describe("safeUrl", () => {
  it("keeps http(s) urls", () => {
    expect(safeUrl("https://github.com/x/y/pull/1")).toBe("https://github.com/x/y/pull/1");
    expect(safeUrl("HTTP://example.com")).toBe("HTTP://example.com");
  });
  it("drops every other scheme and non-strings", () => {
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl(" javascript:alert(1)")).toBeNull();
    expect(safeUrl("data:text/html,<script>")).toBeNull();
    expect(safeUrl("//evil.example")).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
    expect(safeUrl({ url: "https://x" })).toBeNull();
  });
});

describe("md", () => {
  it("renders paragraphs, line breaks, lists and headings", () => {
    expect(md("one\ntwo\n\n- a\n- b\n# Head")).toBe('<p>one<br>two</p><ul><li>a</li><li>b</li></ul><p class="h">Head</p>');
  });
  it("renders inline code, bold, em and links", () => {
    expect(inlineMd("`x` **b** *i* _u_ [PR](https://github.com/o/r/pull/2)")).toBe(
      '<code>x</code> <strong>b</strong> <em>i</em> <em>u</em> <a href="https://github.com/o/r/pull/2" target="_blank" rel="noopener">PR</a>',
    );
  });
  it("returns empty for empty input", () => {
    expect(md("")).toBe("");
    expect(md(null)).toBe("");
  });
  it("escapes raw HTML, script tags included", () => {
    const out = md("<script>alert(1)</script> <img src=x onerror=alert(1)>");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;script&gt;");
  });
  it("never links javascript: or data: urls", () => {
    const out = md("[click](javascript:alert(1)) [d](data:text/html,x)");
    expect(out).not.toContain("<a");
    expect(out).toContain("[click](javascript:alert(1))");
  });
  it("can't break out of the href attribute", () => {
    const out = md('[x](https://e.com/"onmouseover="alert(1))');
    expect(out).not.toMatch(/href="[^"]*"\s*onmouseover/);
    const out2 = md("[x](https://e.com/'onmouseover='alert(1))");
    expect(out2).not.toContain("'onmouseover");
  });
  it("escapes markup inside code and link labels", () => {
    expect(inlineMd("`<b>`")).toBe("<code>&lt;b&gt;</code>");
    expect(inlineMd("[<i>x</i>](https://e.com)")).toBe('<a href="https://e.com" target="_blank" rel="noopener">&lt;i&gt;x&lt;/i&gt;</a>');
  });
  it("leaves snake_case words alone", () => {
    expect(inlineMd("qa_pending and qa_last_at")).toBe("qa_pending and qa_last_at");
  });
});

describe("md fenced code", () => {
  it("renders a fence with a language class and escapes the content verbatim", () => {
    expect(md("```sql\nSELECT * FROM t WHERE a < 1 AND b = 'x';\n```")).toBe(
      '<div class="codeblock"><button type="button" class="copybtn" data-copy-code aria-label="Copy code">Copy</button><pre><code class="lang-sql">SELECT * FROM t WHERE a &lt; 1 AND b = &#39;x&#39;;</code></pre></div>',
    );
  });
  it("renders a fence without a language", () => {
    expect(md("```\nplain\n```")).toBe("<div class=\"codeblock\"><button type=\"button\" class=\"copybtn\" data-copy-code aria-label=\"Copy code\">Copy</button><pre><code>plain</code></pre></div>");
  });
  it("splits a fence out of the surrounding paragraphs", () => {
    expect(md("before\n```\ncode\n```\nafter")).toBe("<p>before</p><div class=\"codeblock\"><button type=\"button\" class=\"copybtn\" data-copy-code aria-label=\"Copy code\">Copy</button><pre><code>code</code></pre></div><p>after</p>");
  });
  it("keeps indentation, blank lines and markdown syntax literal inside the fence", () => {
    expect(md("```py\ndef f():\n    return `x` **y** *z* [a](https://e.com)\n\n# not a heading\n- not a list\n> not a quote\n```")).toBe(
      '<div class="codeblock"><button type="button" class="copybtn" data-copy-code aria-label="Copy code">Copy</button><pre><code class="lang-py">def f():\n    return `x` **y** *z* [a](https://e.com)\n\n# not a heading\n- not a list\n&gt; not a quote</code></pre></div>',
    );
  });
  it("treats an unterminated fence as code to the end", () => {
    expect(md("intro\n```js\nconst a = 1;\n\nconst b = 2;")).toBe(
      '<p>intro</p><div class="codeblock"><button type="button" class="copybtn" data-copy-code aria-label="Copy code">Copy</button><pre><code class="lang-js">const a = 1;\n\nconst b = 2;</code></pre></div>',
    );
  });
  it("renders an empty fence", () => {
    expect(md("```\n```")).toBe("<div class=\"codeblock\"><button type=\"button\" class=\"copybtn\" data-copy-code aria-label=\"Copy code\">Copy</button><pre><code></code></pre></div>");
  });
  it("accepts language names like c++, c# and objective-c", () => {
    expect(md("```C++\nx\n```")).toContain('<code class="lang-C++">');
    expect(md("```c#\nx\n```")).toContain('<code class="lang-c#">');
    expect(md("```objective-c\nx\n```")).toContain('<code class="lang-objective-c">');
  });
  it("drops the class for an unsafe or overlong language", () => {
    expect(md('```"onmouseover="alert(1)\nx\n```')).toBe("<div class=\"codeblock\"><button type=\"button\" class=\"copybtn\" data-copy-code aria-label=\"Copy code\">Copy</button><pre><code>x</code></pre></div>");
    expect(md("```x'y\nx\n```")).toBe("<div class=\"codeblock\"><button type=\"button\" class=\"copybtn\" data-copy-code aria-label=\"Copy code\">Copy</button><pre><code>x</code></pre></div>");
    expect(md("```<script>\nx\n```")).toBe("<div class=\"codeblock\"><button type=\"button\" class=\"copybtn\" data-copy-code aria-label=\"Copy code\">Copy</button><pre><code>x</code></pre></div>");
    expect(md("```" + "a".repeat(21) + "\nx\n```")).toBe("<div class=\"codeblock\"><button type=\"button\" class=\"copybtn\" data-copy-code aria-label=\"Copy code\">Copy</button><pre><code>x</code></pre></div>");
  });
  it("uses only the first word of the info string", () => {
    expect(md("```ts title=x\ny\n```")).toBe('<div class="codeblock"><button type="button" class="copybtn" data-copy-code aria-label="Copy code">Copy</button><pre><code class="lang-ts">y</code></pre></div>');
  });
  it("strips the fence's own indentation from its content", () => {
    expect(md("  ```\n  a\n    b\nc\n  ```")).toBe("<div class=\"codeblock\"><button type=\"button\" class=\"copybtn\" data-copy-code aria-label=\"Copy code\">Copy</button><pre><code>a\n  b\nc</code></pre></div>");
  });
  it("escapes HTML injection attempts inside and around fences", () => {
    const out = md("<img src=x onerror=alert(1)>\n```html\n<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n```\n<svg onload=alert(1)>");
    expect(out).not.toMatch(/<(script|img|svg)/);
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain('<code class="lang-html">');
  });
  it("can't close the pre early from inside the fence", () => {
    expect(md("```\n</code></pre><script>alert(1)</script>\n```")).toBe(
      "<div class=\"codeblock\"><button type=\"button\" class=\"copybtn\" data-copy-code aria-label=\"Copy code\">Copy</button><pre><code>&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;</code></pre></div>",
    );
  });
  it("lets a longer fence contain a ``` line", () => {
    expect(md("````md\n```js\nx\n```\n````")).toBe('<div class="codeblock"><button type="button" class="copybtn" data-copy-code aria-label="Copy code">Copy</button><pre><code class="lang-md">```js\nx\n```</code></pre></div>');
  });
  it("leaves a one-line ```x``` to the paragraph instead of opening a fence", () => {
    expect(md("```x```\nnext")).toBe("<p>``<code>x</code>``<br>next</p>");
  });
  it("never links urls inside fences", () => {
    expect(md("```\n[x](javascript:alert(1)) [y](https://e.com)\n```")).not.toContain("<a");
  });
});

describe("md ordered lists", () => {
  it("renders 1. and 1) items", () => {
    expect(md("1. one\n2. **two**")).toBe("<ol><li>one</li><li><strong>two</strong></li></ol>");
    expect(md("1) one\n2) two")).toBe("<ol><li>one</li><li>two</li></ol>");
  });
  it("keeps the start number when the list doesn't begin at 1", () => {
    expect(md("3. three\n4. four")).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
  });
  it("switches between ordered and unordered lists", () => {
    expect(md("1. a\n2. b\n- c\n- d\n3. e")).toBe('<ol><li>a</li><li>b</li></ol><ul><li>c</li><li>d</li></ul><ol start="3"><li>e</li></ol>');
  });
  it("ends the list at a paragraph line", () => {
    expect(md("1. a\ntext")).toBe("<ol><li>a</li></ol><p>text</p>");
  });
  it("doesn't treat a number without a space as an item", () => {
    expect(md("1.5 is a number")).toBe("<p>1.5 is a number</p>");
  });
  it("escapes injection attempts inside items", () => {
    const out = md("1. <img src=x onerror=alert(1)>\n2. [x](javascript:alert(1))\n- <script>alert(1)</script>");
    expect(out).not.toMatch(/<(img|script)/);
    expect(out).not.toContain("<a");
  });
});

describe("md blockquotes", () => {
  it("renders consecutive > lines as one quote with inline formatting", () => {
    expect(md("> **note** one\n> two")).toBe("<blockquote><p><strong>note</strong> one<br>two</p></blockquote>");
  });
  it("accepts > without a following space", () => {
    expect(md(">tight")).toBe("<blockquote><p>tight</p></blockquote>");
  });
  it("separates paragraphs inside a quote and ends at a non-quote line", () => {
    expect(md("> a\n>\n> b\nafter")).toBe("<blockquote><p>a</p><p>b</p></blockquote><p>after</p>");
  });
  it("renders nested quotes", () => {
    expect(md("> outer\n> > inner\n> back")).toBe("<blockquote><p>outer</p><blockquote><p>inner</p></blockquote><p>back</p></blockquote>");
  });
  it("renders lists and fences inside a quote", () => {
    expect(md("> - a\n> 1. b\n> ```\n> <x>\n> ```")).toBe(
      "<blockquote><ul><li>a</li></ul><ol><li>b</li></ol><div class=\"codeblock\"><button type=\"button\" class=\"copybtn\" data-copy-code aria-label=\"Copy code\">Copy</button><pre><code>&lt;x&gt;</code></pre></div></blockquote>",
    );
  });
  it("escapes injection attempts inside quotes", () => {
    const out = md("> <img src=x onerror=alert(1)>\n> [x](javascript:alert(1))\n>> <script>alert(1)</script>");
    expect(out).not.toMatch(/<(img|script)/);
    expect(out).not.toContain("<a");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
  it("caps nesting so a long run of > can't blow the stack", () => {
    const out = md(">".repeat(20000) + " x");
    expect(out.match(/<blockquote>/g)).toHaveLength(8);
    expect(out).toContain("&gt;&gt;&gt;");
  });
  it("doesn't treat a mid-line > as a quote", () => {
    expect(md("a > b")).toBe("<p>a &gt; b</p>");
  });
});

describe("md horizontal rules", () => {
  it("renders ---, *** and ___ as a rule", () => {
    expect(md("a\n\n---\n\nb")).toBe("<p>a</p><hr><p>b</p>");
    expect(md("***")).toBe("<hr>");
    expect(md("___")).toBe("<hr>");
  });
  it("still renders - item as a list", () => {
    expect(md("- item")).toBe("<ul><li>item</li></ul>");
  });
});

describe("plain", () => {
  it("strips markdown to one line", () => {
    expect(plain("# Why\n- **fix** the [bug](https://x)\n`now`")).toBe("Why fix the bug now");
  });
  it("strips fences, quote markers and ordered-list markers", () => {
    expect(plain("> 1. step one\n2) step two\n```sql\nselect 1\n```")).toBe("step one step two select 1");
  });
});
