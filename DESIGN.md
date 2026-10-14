---
name: homectl
description: Modern dark peer workspace for local homelab operations
colors:
  ground: "#0d131d"
  rail: "#101824"
  surface: "#151f2d"
  raised: "#1b2839"
  rule: "#2c3d52"
  ink: "#e9f0fa"
  muted: "#a7b9cf"
  accent: "#a99aff"
  accent-ink: "#181130"
  success: "#87d9ba"
  warning: "#efc782"
  danger: "#ffa8aa"
typography:
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "30px"
    fontWeight: 650
    lineHeight: 1.18
    letterSpacing: "-.025em"
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "20px"
    fontWeight: 620
    lineHeight: 1.55
    letterSpacing: "-.015em"
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
    fontSize: "12px"
    fontWeight: 550
    lineHeight: 1.55
  technical:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  control: "8px"
  field: "7px"
  badge: "6px"
  panel: "10px"
  dialog: "12px"
spacing:
  step-6: "6px"
  step-8: "8px"
  step-10: "10px"
  step-12: "12px"
  step-14: "14px"
  step-16: "16px"
  step-18: "18px"
  step-20: "20px"
  step-24: "24px"
  step-28: "28px"
  step-32: "32px"
  step-36: "36px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  button-secondary:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.control}"
    padding: "8px 14px"
  panel:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.panel}"
    padding: "24px"
---

# Design System: homectl

## Overview

**Creative North Star: "The Peer Workspace"**

A modern dark application workspace for operating machines and trusted peers. Blue-black framing, slate work surfaces and crisp platform typography keep attention on named targets, trust and explicit choices. All interface copy is English.

The user-pinned replacement direction supersedes the rejected initial sketches. System typography follows native application conventions; this is an operational interface rather than a promotional surface.

**Key Characteristics:**

- Blue-black shell and slate work surfaces.
- Violet actions and selection; mint success and amber attention.
- Compact, readable platform typography with clear keyboard focus.
- Equal-weight conflict comparison with an explicit retained result.

## Colors

The palette combines cool dark neutrals with a restrained violet action color and legible semantic feedback. Frontmatter records the reusable CSS custom properties exactly.

### Primary

- **Soft Violet (accent):** primary actions, keyboard focus, input caret and selection.
- **Deep Violet Ink (accent-ink):** readable foreground on the violet action surface.

### Secondary

- **Mint (success):** unlocked sessions, successful notices and local live-state markers.
- **Amber (warning):** attention badges.
- **Rose (danger):** errors and destructive action labels.

### Neutral

- **Blue-black Ground (ground):** page backdrop.
- **Navigation Night (rail):** persistent navigation and toolbar.
- **Slate Surface (surface):** panels, lists and dialogs.
- **Raised Slate (raised):** secondary buttons and device icon containers.
- **Steel Rule (rule):** thin borders and dividers.
- **Cool Pale Ink (ink):** principal text.
- **Muted Blue-gray (muted):** labels and supporting text.

**The Semantic Accent Rule.** Violet identifies actions and selection; mint, amber and rose identify success, attention and errors alongside readable labels.

## Typography

The system sans-serif stack is shared across headings, controls and body copy. Technical output uses the system monospace stack. There is no separate marketing display font.

### Hierarchy

- **Headline:** page headings use the frontmatter headline role; narrow-screen page headings reduce to 26px. Connection headings use 38px, reducing to 32px on narrow screens.
- **Title:** section headings use the title role. Subsection headings are 15px with the browser's bold heading weight.
- **Body:** operational copy uses the body role; paragraphs stay within 72ch.
- **Label:** compact badges and column labels use the label role. Form labels use 13px; buttons use weight 600.
- **Technical:** preformatted output and editable JSON use the technical role. Inline code is .95em; numeric table values use tabular figures.

**The Platform Type Rule.** Use the system sans-serif stack for the application hierarchy and monospace for technical values; keep interface copy English.

## Layout

Desktop uses a 208px sticky navigation rail and flexible work area with a persistent toolbar. Main content has a 1500px maximum width, 34px vertical and 36px horizontal padding. Panels use 24px internal padding; paired columns and stacks use 20px gaps. Forms use two equal columns with 18px gaps.

At 1000px and below, the rail becomes 180px, main padding becomes 28px 24px, and comparison columns stack. At 700px and below, navigation becomes a horizontal scrolling row, the toolbar wraps, main padding becomes 24px 16px and forms become single-column. Machine tables transform into stacked records with wrapping action groups; the search label remains visible. Panels reduce to 18px padding.

## Elevation & Depth

The interface uses tonal layering and thin borders rather than box shadows. Darker framing anchors the workspace; slate panels and raised controls establish hierarchy. Dialogs use a dark translucent backdrop (#050910b3). Focus is a 2px violet outline offset by 4px; it is an interaction indicator rather than elevation.

## Shapes

Controls use the control radius; fields and navigation links use the field radius. Status badges are compact rounded rectangles. Panels and tables use the panel radius; dialogs and empty-state boundaries use the dialog radius. Borders are 1px. The brand's single-letter mark has a 9px radius; host initials use an 8px square container. These are identifiers, not action icons.

## Components

### Buttons

Primary buttons use violet with deep violet text; secondary buttons use raised slate with a steel border; quiet buttons are transparent with muted text. All have a 38px minimum height, 8px 14px padding and weight 600. Primary hover is #c1b5ff; secondary and quiet hover is #26374b. Background transitions last 120ms with ease-out. Disabled controls have .55 opacity and a waiting cursor. Keyboard focus uses the shared outline.

### Chips

Badges use 12px text, weight 550, 3px 9px padding, a 1px border and the badge radius. Neutral badges use muted text and the steel rule. Success badges use #17382f with #2a5044 borders; warning badges use #382c1b with #615036 borders. Always retain a readable label.

### Cards / Containers

Panels use slate surfaces, thin steel borders and the panel radius. Tables share this enclosure; their headers use #121c29. Rows have dividers, tabular numeric values and compact secondary descriptions. Empty states use dashed boundaries and centered guidance without fabricated metrics.

### Inputs / Fields

Fields use #101925 backgrounds, #3a4c63 borders, pale text, 9px 12px padding and the field radius. Placeholders use #a1b2c8. Labels remain separate and visible. Focus uses the shared violet outline. Textareas use monospace, vertical resizing and a 140px minimum height. Errors use rose text on #382126 with #70424a borders and an alert role.

### Navigation

Rail links use muted text, weight 550, 10px 13px padding and rounded corners. Hover uses raised slate; the current page uses #2b2545 and #d6ccff with aria-current. On narrow screens links become 13px with 8px 10px padding. The skip link becomes visible on keyboard focus.

### Conflict comparison

Two matching version containers show local and received data with 18px padding, a thin border and an 8px radius. A selection collapses the pair into one retained result with a status role and a Compare again action. The feedback background animates from #302849 to transparent over 220ms with cubic-bezier(.16,1,.3,1). Reduced motion disables animations and transitions.

**The Equal Peers Rule.** Local and received versions receive matching containers before a choice is made.

## Do's and Don'ts

### Do:

- Do keep all interface copy English.
- Do identify the target and execution device alongside operations.
- Do retain equal visual weight for local and received conflict versions.
- Do show text labels with semantic status colors.
- Do preserve keyboard focus and reduced-motion behavior.

### Don't:

- Don't revive the rejected initial admin-panel sketches.
- Don't replace platform typography with promotional display assets.
- Don't use color alone to convey trust, errors or selected versions.
- Don't turn the application into a decorative metrics dashboard.
