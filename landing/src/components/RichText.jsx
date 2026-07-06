import InlineCode from "./InlineCode.jsx";

const mono = "'IBM Plex Mono', monospace";

/**
 * Renders an array of inline "parts" so copy with mixed formatting can live as
 * plain data in content.js. A part is either a string or a single-key object:
 *
 *   "plain text"
 *   { strong: "bold" }
 *   { em: "italic" }
 *   { code: "boxed mono" }      — orange highlight (InlineCode)
 *   { codePlain: "mono" }        — mono, no highlight
 *   { a: { t: "link", href } }   — accented anchor
 */
export default function RichText({ parts }) {
  return (
    <>
      {parts.map((part, i) => {
        if (typeof part === "string") return part;
        if (part.strong)
          return (
            <strong key={i} style={{ fontWeight: 700 }}>
              {part.strong}
            </strong>
          );
        if (part.em) return <em key={i}>{part.em}</em>;
        if (part.code) return <InlineCode key={i}>{part.code}</InlineCode>;
        if (part.codePlain)
          return (
            <code key={i} style={{ fontFamily: mono, fontSize: "12.5px" }}>
              {part.codePlain}
            </code>
          );
        if (part.a)
          return (
            <a key={i} href={part.a.href} style={{ color: "#e05a26" }}>
              {part.a.t}
            </a>
          );
        return null;
      })}
    </>
  );
}
