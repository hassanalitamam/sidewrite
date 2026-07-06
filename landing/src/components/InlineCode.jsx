const style = {
  fontFamily: "'IBM Plex Mono', monospace",
  fontSize: "12.5px",
  color: "#e05a26",
  background: "rgba(224, 90, 38, 0.08)",
  padding: "2px 7px",
};

/** Orange monospace inline code fragment used inside the mode step lists. */
export default function InlineCode({ children }) {
  return <code style={style}>{children}</code>;
}
