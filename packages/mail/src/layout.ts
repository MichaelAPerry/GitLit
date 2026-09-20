/**
 * Email HTML, written by hand rather than rendered from components.
 *
 * §4 names React Email alongside Resend. This departs from that, deliberately:
 * an email client is not a browser. Gmail strips <style> blocks, Outlook
 * renders through Word, and flexbox is not available in either — so the output
 * has to be a table with inline styles whatever produces it. Pulling a React
 * renderer into the API server to emit markup we would have to constrain to
 * 1998 HTML anyway buys nothing, and it puts a rendering pass between an
 * author and the only thing standing between them and their manuscript.
 *
 * If GitLit later has a dozen templates and a designer editing them, revisit
 * this. At two, it is one function.
 */

/** Escape for HTML text content AND attribute values (quotes included). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const INK = "#1c1a17";
const MUTED = "#6b645c";
const PAPER = "#faf8f4";
const RULE = "#e3ddd3";
const ACCENT = "#2f5d50";

export interface LayoutParts {
  /** Shown in the client's preview line, before the body is opened. */
  preheader: string;
  heading: string;
  /** Already-escaped HTML fragments, in order. */
  body: string[];
}

export function layout({ preheader, heading, body }: LayoutParts): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${PAPER};color:${INK};">
<!-- Preview text. Hidden in the body, read by the client's inbox list. -->
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
       style="background:${PAPER};padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
             style="max-width:480px;background:#ffffff;border:1px solid ${RULE};border-radius:6px;">
        <tr>
          <td style="padding:28px 28px 0;">
            <p style="margin:0;font:600 15px/1.2 Georgia,'Times New Roman',serif;color:${ACCENT};
                      letter-spacing:0.02em;">GitLit</p>
          </td>
        </tr>
        <tr>
          <td style="padding:14px 28px 28px;
                     font:400 15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
                     color:${INK};">
            <h1 style="margin:0 0 14px;font:600 20px/1.3 Georgia,'Times New Roman',serif;color:${INK};">
              ${escapeHtml(heading)}
            </h1>
            ${body.join("\n            ")}
          </td>
        </tr>
      </table>
      <p style="max-width:480px;margin:16px auto 0;
                font:400 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
                color:${MUTED};text-align:center;">
        GitLit — version control and provenance for manuscripts.
      </p>
    </td>
  </tr>
</table>
</body>
</html>`;
}

/** A button that still reads as a link in clients that drop the styling. */
export function button(href: string, label: string): string {
  const safe = escapeHtml(href);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:22px 0;">
              <tr><td style="background:${ACCENT};border-radius:5px;">
                <a href="${safe}" style="display:inline-block;padding:11px 22px;color:#ffffff;
                   text-decoration:none;font:600 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;"
                   >${escapeHtml(label)}</a>
              </td></tr>
            </table>`;
}

export function paragraph(html: string, muted = false): string {
  return `<p style="margin:0 0 12px;${muted ? `color:${MUTED};font-size:13px;line-height:1.5;` : ""}">${html}</p>`;
}
