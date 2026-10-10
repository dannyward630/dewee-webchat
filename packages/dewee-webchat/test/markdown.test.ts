// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/widget/markdown";

const html = (md: string) => {
  const div = document.createElement("div");
  div.appendChild(renderMarkdown(document, md));
  return div.innerHTML;
};

describe("renderMarkdown", () => {
  it("renders common blocks", () => {
    const out = html("# Title\n\nHello **bold** and `code`.\n\n- a\n- b\n\n1. one\n2. two\n\n```js\nconst x = 1;\n```");
    expect(out).toContain("<h3>Title</h3>");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<code>code</code>");
    expect(out).toContain("<ul><li>a</li><li>b</li></ul>");
    expect(out).toContain("<ol><li>one</li><li>two</li></ol>");
    expect(out).toContain('<pre><code data-lang="js">const x = 1;</code></pre>');
  });

  it("renders tables", () => {
    const out = html("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(out).toContain("<th>a</th>");
    expect(out).toContain("<td>2</td>");
  });

  it("never injects HTML or unsafe links", () => {
    const out = html('<img src=x onerror=alert(1)> [x](javascript:alert(1)) [ok](https://dewee.sh)');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
    expect(out).not.toContain("javascript:");
    expect(out).toContain('href="https://dewee.sh"');
  });

  it("autolinks bare urls", () => {
    expect(html("see https://dewee.sh/docs.")).toContain('href="https://dewee.sh/docs"');
  });
});
