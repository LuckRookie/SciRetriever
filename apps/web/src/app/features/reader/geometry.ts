/**
 * Spec 1.1: the sheet on the desk. Pure arithmetic from the desk's width (the
 * reading area below the top bar, beside any side panel) and the reading font
 * size; the reader page, the spine (block 10) and the direct tests share it.
 */
export type SheetTier = "wide" | "medium" | "narrow" | "full";
export interface SheetGeometry {
  tier: SheetTier;
  /** The sheet's width and its left edge on the desk, px. */
  sheet: number;
  left: number;
  /** Left margin, text column and right margin inside the sheet, px. */
  marginLeft: number;
  column: number;
  marginRight: number;
  /** Notes in the right margin, or under their paragraph. */
  notes: "margin" | "below";
  /** The spine (16 px, 8 px from the sheet) is shown, and where it starts. */
  spine: boolean;
  spineLeft: number;
  /** A left margin narrower than 96 px keeps only key-sentence bars and doubt marks. */
  compactLeft: boolean;
  /** The sheet has its shadow and desk around it. */
  framed: boolean;
  /** The page header's side indent, px (spec 1.2). */
  headerIndent: number;
}
export const SPINE_GAP = 8;
export const SPINE_WIDTH = 16;
/** The sheet and the spine keep 16 px of desk on each side below 1088 px. */
const EDGE = 16;
const SIDE = SPINE_GAP + SPINE_WIDTH + 2 * EDGE; // 56
/** The text column is 34 em; where that does not fit, at least 24 em. */
const COLUMN_EM = 34,
  MIN_COLUMN_EM = 24;
/** The narrowest right margin that still holds notes beside the text. */
const NOTE_MARGIN = 190;

/**
 * `columnEm` overrides the 34 em text column (the width setting the current
 * toolbar still offers); the margins and tiers stay as the spec gives them.
 */
export function sheetGeometry(
  desk: number,
  fontSize: number,
  columnEm = COLUMN_EM,
): SheetGeometry {
  const em = (n: number) => n * fontSize,
    widest = em(columnEm),
    narrowest = em(Math.min(MIN_COLUMN_EM, columnEm));
  const fit = (room: number) => Math.max(Math.min(widest, room), narrowest);
  if (desk < 640) {
    const marginLeft = 24,
      marginRight = 16;
    return {
      tier: "full",
      sheet: desk,
      left: 0,
      marginLeft,
      column: Math.max(0, desk - marginLeft - marginRight),
      marginRight,
      notes: "below",
      spine: false,
      spineLeft: 0,
      compactLeft: true,
      framed: false,
      headerIndent: 16,
    };
  }
  let tier: SheetTier, marginLeft: number, column: number, marginRight: number;
  const room = desk - SIDE;
  if (desk >= 1088) {
    tier = "wide";
    marginLeft = 150;
    marginRight = 210;
    column = fit(room - marginLeft - marginRight);
  } else if (desk >= 800) {
    tier = "medium";
    marginLeft = 96;
    // The right margin is what the text leaves, at least 24 px.
    column = fit(room - marginLeft - 24);
    marginRight = Math.max(24, room - marginLeft - column);
  } else {
    tier = "narrow";
    marginLeft = 56;
    marginRight = 24;
    column = fit(room - marginLeft - marginRight);
  }
  const sheet = marginLeft + column + marginRight;
  // The sheet, the gap and the spine are centred together on the desk.
  const left = Math.max(EDGE, (desk - sheet - SPINE_GAP - SPINE_WIDTH) / 2);
  return {
    tier,
    sheet,
    left,
    marginLeft,
    column,
    marginRight,
    notes:
      tier === "wide" || (tier === "medium" && marginRight >= NOTE_MARGIN)
        ? "margin"
        : "below",
    spine: true,
    spineLeft: left + sheet + SPINE_GAP,
    compactLeft: marginLeft < 96,
    framed: true,
    headerIndent: tier === "wide" ? 40 : 24,
  };
}
