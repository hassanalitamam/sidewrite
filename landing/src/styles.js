/**
 * Responsive style objects, derived from the source design's renderVals().
 * `m` is the isMobile flag. Keeping these in one place mirrors the original
 * single-source-of-truth for layout and keeps the components readable.
 */
export function layout(m) {
  const mono = "'IBM Plex Mono', monospace";
  return {
    navPad: {
      maxWidth: "1240px",
      margin: "0 auto",
      padding: m ? "14px 18px" : "16px 36px",
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      gap: "14px",
    },
    navLinks: {
      display: "flex",
      alignItems: "center",
      gap: m ? "10px" : "30px",
      fontFamily: mono,
      fontSize: "12.5px",
    },
    heroGrid: {
      maxWidth: "1240px",
      margin: "0 auto",
      padding: m ? "48px 18px 56px" : "96px 36px 88px",
      display: "grid",
      gridTemplateColumns: m ? "1fr" : "1.05fr 0.95fr",
      gap: m ? "32px" : "72px",
      alignItems: "center",
      position: "relative",
    },
    h1: {
      fontSize: m ? "38px" : "76px",
      lineHeight: 1.02,
      fontWeight: 900,
      letterSpacing: "-0.02em",
      textTransform: "uppercase",
      margin: "0 0 24px",
      textWrap: "balance",
      animation: "sw-rise 0.5s 0.05s ease both",
    },
    statsGrid: {
      maxWidth: "1240px",
      margin: "0 auto",
      padding: m ? "0 18px" : "0 36px",
      display: "grid",
      gridTemplateColumns: m ? "1fr 1fr" : "repeat(4, 1fr)",
    },
    sectionPad: {
      maxWidth: "1240px",
      margin: "0 auto",
      padding: m ? "56px 18px" : "104px 36px",
    },
    h2: {
      fontSize: m ? "30px" : "48px",
      fontWeight: 800,
      letterSpacing: "-0.02em",
      textTransform: "uppercase",
      margin: 0,
    },
    twoColGrid: {
      display: "grid",
      gridTemplateColumns: m ? "1fr" : "1fr 1fr",
      gap: "24px",
    },
    bentoGrid: {
      display: "grid",
      gridTemplateColumns: m ? "1fr" : "repeat(3, 1fr)",
      gridAutoRows: "minmax(160px, auto)",
      gap: "20px",
    },
    bentoSpan: {
      gridColumn: m ? "auto" : "span 2",
      border: "1px solid #d9d6cf",
      background: "#ffffff",
      padding: "32px",
      display: "flex",
      flexDirection: "column",
      justifyContent: "space-between",
      gap: "24px",
    },
    safetyBadgeGrid: {
      display: "grid",
      gridTemplateColumns: m ? "1fr" : "repeat(4, 1fr)",
      gap: "24px",
    },
    comparisonRow: {
      display: "grid",
      gridTemplateColumns: m ? "1fr" : "1fr 2fr",
      gap: m ? "8px" : "40px",
      padding: "28px 0",
      borderBottom: "1px solid #d9d6cf",
    },
    // Divider between the two halves of a merged chapter (e.g. Modes → Features,
    // Safety → Comparison) — same visual weight as a section border, but inline
    // so it doesn't read as a new numbered chapter.
    chapterDivider: {
      marginTop: m ? "48px" : "80px",
      paddingTop: m ? "48px" : "80px",
      borderTop: "1px solid #e5e3dd",
    },
    // Slim, unnumbered install recap bar — a fraction of the old full-section
    // height, since the Hero already carries the primary install moment.
    installBarOuter: {
      maxWidth: "1240px",
      margin: "0 auto",
      padding: m ? "28px 18px" : "36px 36px",
      textAlign: "center",
    },
    // Full-width promoted Free-Tier Pool diagram — the page's signature visual.
    poolDiagramFull: {
      marginTop: m ? "28px" : "40px",
      paddingTop: m ? "28px" : "40px",
      borderTop: "1px dashed #e5e3dd",
      display: "flex",
      flexDirection: m ? "column" : "row",
      alignItems: "center",
      gap: m ? "16px" : "24px",
    },
  };
}
