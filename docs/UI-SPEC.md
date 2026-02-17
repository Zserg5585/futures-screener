# UI-SPEC.md — Densities Tab (Desktop Wide + Mobile Variant A)

This document describes the user interface for the Densities tab (Tab 1) of Futures Screener. It uses the provided mobile and desktop visual references as guidance for layout and interaction, but remains a textual, testable specification.

## Scope
- Focus: Tab 1 – Densities. Tabs 2 (Mini-charts/Screener) and 3 (Signals) will be defined later.
- Platform: Web app with desktop-wide and mobile variants. Design follows a dark theme with dense data presentation.

## Desktop Wide (Key Layout and Blocks)
- Global chrome:
  - Top header with title "Futures Screener" and a compact action bar.
  - Left filter column (collapsible) containing filters such as Min Density, Max Density, Notional, Symbols (comma-separated).
  - Main content area consisting of:
    - A horizontal-scrollable density table panel showing assets with density-related metrics.
    - Columns to include: Symbol, BID price, BID size, DIST, MM×2, MM×3, Distances, Notional, Exchange indicators.
    - Color-coded cells/flags to indicate density strength (green for strong density, orange for moderate, red for weak/high risk).
  - Secondary blocks: quick stats bar showing aggregate densities, and a small memo/help area.
  - Bottom row of controls: sort dropdowns (Sort: MM×2, Desc), and a Refresh button.
- Interaction details:
  - Horizontal scrolling enabled for the density table to accommodate many assets.
  - Clicking a row expands to show more detail or opens a modal with per-asset density breakdown (if implemented in MVP).
  - Filters apply live or on hitting Refresh; filter values visible near the left panel.

## Mobile Variant A (Densities)
- Layout adaptation:
  - Header remains compact with title and a menu icon; filters accessible via a collapsible panel or modal.
  - Density table presented as a vertically stacked list with horizontal swipes to view key columns.
  - Each asset row shows core density metrics; tap reveals a detail drawer with density breakdown.
- Key interactions:
  - Tap on a density row to see extended information.
  - Use a prominent Refresh button in the header or a floating action button.
  - Filtering controlled via a modal panel to maintain space efficiency on small screens.

## Data and Endpoints (for Tab 1)
- Data source: mocked density data during MVP; backend endpoint /api/screener will proxy or serve density data. (Phase 0 reference)
- Fields to present (provisional):
  - Symbol, BID, BBID density score, DIST, MM×2, MM×3, Notional, Notional Density, Distance/Notional, etc.

## Accessibility & Testing Notes
- Ensure dense data table has keyboard navigability, focus states on rows, and screen-reader labels for density metrics.
- Tests should cover filter application, sorting, and the density score calculation path (mocked in MVP).

## Milestones (initial MVP for Densities)
- MVP: Basic density table UI with left filters and horizontal scroll (Desktop Wide). Backend density data available via mocked API.
- Next: enrich columns, density scoring, and per-asset modal detail (to be defined in future PR).
