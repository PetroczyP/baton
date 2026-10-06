---
handoff: 1
saved_at: 2026-10-06T14:54:32Z
branch: main
head: 91c8ecac1f0e3b2a9c7d4e5f60718293a4b5c6d7
---
# Handoff — add CSV export to the reports page

Continue the following task.

## Goal

Add a "Download CSV" button to the reports page that exports the rows currently shown.

## Completed

- `src/reports/export.ts` builds the CSV from the table's visible rows, with tests in `src/reports/export.test.ts`.

## Remaining

1. Add the button to `src/reports/ReportsPage.tsx` and wire it to `exportCsv`.
2. Add a test that the download contains the filtered rows only.

## Key context

- Dates must be exported in ISO 8601; the table shows them localized.

## Relevant files

- `src/reports/export.ts`
- `src/reports/ReportsPage.tsx`

## Current state

```
$ git status --short
(clean)
$ git log -1 --oneline
91c8eca feat(reports): build CSV rows from the visible table
```

## Absolute don'ts

- Don't change the table's existing column order.
