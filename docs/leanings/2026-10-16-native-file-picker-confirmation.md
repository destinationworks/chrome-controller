# 2026-10-16 — Native file-picker confirmation needs visible readback

- **Status:** Open
- **Task/context:** CTRL-RUNTIME-001, upload the verified 1.3.0 package to the existing Chrome Web Store item.
- **Unexpected observation or failure:** CUA could set and read back an existing ZIP path in the macOS Go To Folder sheet, but Return reset the visible field to `/` instead of confirming it. Escape and alternate confirmation attempts did not close the sheet.
- **Evidence:** Repeated fresh accessibility states and screenshots showed the full existing path before confirmation and the root directory afterwards. The dashboard had not confirmed an upload.
- **Approaches tried:**
  - **Attempt:** Set the path, confirm by keyboard, invoke the row's exposed open action, or double-click its visible row.
    - **Outcome:** Did not work
    - **Why:** The observed sheet remained open; the underlying routing or native-dialog issue is not established.
  - **Attempt:** Leave the exact path visible and request one manual Enter/Open confirmation.
    - **Outcome:** Partial
    - **Why:** The user can complete the system dialog without sharing credentials; actual upload still needs dashboard readback.
- **Root cause:** Unknown. Do not infer a missing ZIP, bad repository path, or authorization failure from this input symptom.
- **Resolution:** Pending confirmed native selection and dashboard upload state.
- **Verification:** Exact package identity and local existence were verified independently; no upload or publication is claimed from path entry alone.
- **Prevention/follow-up:** Preserve the original windows, avoid repeating ineffective key sequences, and read back the dashboard version after selection.
- **Reusable learning:** A filled native path field is not proof that a file was selected or uploaded.
- **References:** `docs/user-guide.md`, Web Store package workflow; sanitized task receipts.
