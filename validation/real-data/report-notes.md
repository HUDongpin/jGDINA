# Real-data report design notes

- Audience: maintainers and technical reviewers making an RC release decision.
- Evidence route: deterministic validation results plus a technical report; no
  business KPI interpretation is applied.
- The report includes one paired-bar chart because iteration equality is both
  decision-relevant and faithfully representable across all four cases.
- A numerical-error chart is intentionally omitted. The audit values include
  exact zeros and nonzero differences between roughly `1e-15` and `1e-11`; a
  linear scale would hide the values and a logarithmic scale cannot represent
  zero without an arbitrary transformation. The sortable exact-value table
  preserves more information and is the more trustworthy visual form for that
  evidence.
- The report distinguishes the two genuine bundled datasets from the
  deterministic missing-value derivative and does not treat the latter as a
  third real dataset.
- The report makes an RC acceptance recommendation, not a claim that the full R
  package surface has been ported or that user-owned research data has already
  been validated.
- The portable reader's full-bleed sticky header uses `100vw`, which overflows
  by the width of a non-overlay desktop scrollbar on long reports. The delivery
  wrapper changes only that embedded header rule to `width: 100%`; the standard
  portable builder, static-chart extraction, and browser verifier remain in
  use for all report content.
