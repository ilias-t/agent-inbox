# Agent Inbox UI inventory

Every capability the UI has, by area. A UI change or redesign keeps each one, or drops it on purpose; tick them off
when checking a redesign for coverage ([README.md](README.md)).

## Header (`index.html`, `views/header.ts`, `lib/status.ts`, `lib/sched.ts`)
- [ ] Title "Agent Inbox" and a badge: "N need you · M FYI" or "Nothing needs you" (hidden until loaded; snoozed items don't count).
- [ ] `?` keyboard-help button (desktop only) and a Settings gear.
- [ ] Status line with a dot and text. Kinds:
  - **unknown**: "Waiting for the manager" or "Manager hasn't checked in yet"
  - **warn**: "Manager may be down" or "Tick overdue Xm"
  - **pending**: "Tick requested HH:MM"
  - **idle**: "Off hours · next pickup Thu 10:03 ET"
  - **ok**: "Next pickup 14:23", "Next tick in Xm" or "Last tick Xm ago"
- [ ] The status line expands to show:
  - Detail line: last tick, next tick, *tick overdue* (red), *tick requested at* (with exact time on hover).
  - Lease line: manager session title (a link if it's a claude.ai session URL), heartbeat age, "manager may be down" (red) or "idle until work hours".
  - Cadence: "picked up every ~10 min · full sweep ~30 min · 10:00–18:00 ET, Mon–Fri · next pickup", plus "Off hours (next pickup …)" outside work hours.
  - **Run tick now** form with an optional note (max 500). Hidden for viewers.
  - Feedback messages: requesting…, "Requested — runs on next pickup (…)", plus errors for not loaded, 401, 403 and generic failure.
- [ ] Manager digest fold: one-line preview, markdown body. It opens by itself only when the digest changed since this viewer last saw it; otherwise it keeps their open/closed choice.

## Tabs
- [ ] Inbox count (turns "hot" when any item is high priority), Team count (active orchestrators only, excluding done/dropped/cleaned), History count (includes archived items not loaded yet). The last tab is remembered.

## Inbox tab (`views/index.ts`, `views/rows.ts`, `lib/items.ts`)
- [ ] **All / Mine / Unassigned** filter with a count on each. It only appears for humans once assignees are in use (anyone in People or any item assigned), or once a non-All filter is saved.
- [ ] Groups:
  - High / Normal / Low headers with counts, oldest first within each.
  - "FYI · decided for you N", newest first.
  - Collapsible "Snoozed N", soonest to wake first. Each row has an **Unsnooze** button (disabled while busy; toast on 403 or failure). The group remembers whether it's open.
- [ ] Empty states:
  - Filtered: "Nothing assigned to you." / "Nothing unassigned." with a **Show all items** button.
  - "Inbox clear.", with different copy when only snoozed items remain.
  - Loading skeleton; "Signed out"; "couldn't load" with **Try again**.
- [ ] Row anatomy:
  - Type badge: PROP / DECIDE / PR / BLOCK / INFO / AUTO.
  - Priority dot (open asks only).
  - Headline: the question if there is one, else the title.
  - Blue "answered" dot (manager replied after your last look) and "? asked" chip (waiting for an answer).
  - Confidence chip (only when there's a full recommendation).
  - FYI rows show the agent's choice; past rows show the verdict, "being handled" or "archived".
  - PR chip (open / merged / closed / approved / changes / comment).
  - Orchestrator chip (O3) and assignee initials (accent colour when it's you).
  - Relative time (created for open items, decided for past ones) and a chevron.
  - Snoozed rows show "until today 18:00 ET" under the title.
  - On narrow screens these drop off: FYI choice at 480px, orchestrator chip and confidence at 420px, PR chip at 380px.

## Item page (`views/item.ts`)
- [ ] Back link: to the last tab, or to the orchestrator page (labelled with its id) if opened from there.
- [ ] Orchestrator context strip (collapsible): "O3 · Why: … · Goal: …", or "No briefing yet" / "Not on the team list". Expanded it shows Why (markdown), Goal and **Open O3 briefing ›**.
- [ ] Meta line: type label, priority, PR chip, snooze chip ("until …"), assignee initials and name ("You"), "from <source>", relative time.
- [ ] Title heading (gets focus on arrival).
- **Regular items** (call first, background after):
  - [ ] Summary lead (markdown).
  - [ ] "The question" box.
  - [ ] Option cards (radio group). Each card can show:
    - label, "Recommended", "Your call" (closed items), key hint 1–9
    - description, → consequence, **Tradeoff**
    - reversible / one-way tag
    - confidence chip and plain-text why (recommended option only)
    - red styling for "reject"
    - **Other…** is always last on open items
  - [ ] Default options when the item has none: Approve / Reject for proposals, Acknowledge for everything else. Closed items with these defaults show no Options block.
  - [ ] A separate "Recommendation" block when the recommended option isn't one of the shown options.
  - [ ] "Your call" panel:
    - Note field: "optional", or "required for Other" (highlighted until filled; max 1500).
    - **Submit** button: "Submit" → "Submit: <label>" → "Saving…", with help text "Choose an option above." or "Write a note to send Other."
    - Status line (Saving… / errors).
    - Snooze row.
  - [ ] Context fold: preview line, markdown body; open by default at ≥900px wide, otherwise remembers the toggle.
  - [ ] Cost of waiting.
  - [ ] Evidence links (falls back to the older `links` field).
  - [ ] **Open O3 chat** button.
- **auto_decided items**:
  - [ ] Context; "Decided for you" panel with the choice and the agent's note; Reasoning; Alternatives (label, description, → consequence); Evidence; chat button.
  - [ ] Open: **Looks good** and **Override…**. Override opens a required "What should happen instead?" note; its button reads "Write a note to override" until filled, then "Send override".
- **Viewer**: [ ] disabled Submit with "View only: your role is viewer…" explanation. No snooze, ask, assign or decide controls.
- **Verdict panel** (closed items):
  - [ ] Heading is one of: Decided / Archived / Being handled / Accepted / Overridden / Closed.
  - [ ] Big choice label with exact time and note; "Archived without a decision."
  - [ ] For overrides: "The agent had chosen: X". For accepted FYIs: "You confirmed this call on …".
  - [ ] "Manager acts on next pickup (…)" or "picked this up and is acting on it".
  - [ ] **Back to the inbox** and **Next item ›**.
- **Snooze** (humans only; tokens get none):
  - [ ] "Not now? Hide it…" hint, or "Snoozed for you until **…**".
  - [ ] **Snooze…** / **Change…** and **Unsnooze**.
  - [ ] Menu: 1 hour, Tonight 6 pm (Tomorrow 6 pm after 6 pm), Tomorrow 9 am, Monday 9 am. Each shows its wake time in the schedule's timezone.
  - [ ] Errors: 409 "Already decided elsewhere", 404, 403, 400, 401.
- **Assignee section**: shown only when assigned or assignees are in use; controls only for an open item with a decider or admin.
  - [ ] Initials, name, email; push note ("pushes go to everyone" / "no ntfy topic…").
  - [ ] **Assign to me**, **Unassign**, **Someone else…** (email field with People suggestions, Assign / Saving…).
  - [ ] 409: "This item changed while you were looking…". Also 400/403/404/401 errors.
- **Questions (Q&A)**:
  - [ ] "Questions · N" thread: your messages on the right; Manager or O3 replies on the left (markdown); relative times.
  - [ ] Failed-to-load message; "Waiting for the manager (…)" while a question is pending.
  - [ ] Viewer copy: "Asking is for deciders and admins".
  - [ ] Hint text when empty; **Ask a question** opens a box (max 2000) with **Cancel** / **Send question** (Sending…). Toast "Question sent… next pickup". Errors for 401/403/404/400.
- [ ] History timeline: Created (with source), Decided (with choice), Updated, Archived.
- [ ] Pager: Prev, "3 of 7" / "N open" / "Inbox clear", Next, `?`. On phones it's a bottom bar; once an option is picked the middle becomes **Submit: <label>** with the arrows shrunk either side.
- [ ] Page states: loading skeleton; fetching (older archived item not loaded); "isn't in the inbox any more"; "couldn't load"; both with **Back to the inbox**.
- [ ] Decide conflict (409): "This item changed since you opened it — review and decide again" (clears the chosen option, keeps the note), or "Already <status> (<choice>) elsewhere." Shown as a toast and on the status line. Also 404/403/400/401 messages.

## Team tab
- [ ] Rows sorted by status (blocked → running → pr-open → parked → approved → proposed → done → cleaned → dropped), then by id.
- [ ] Row: id, status badge, goal ("(no goal)"), open-ask count, updated time, chat icon on the side.
- [ ] Empty copy: "No orchestrators yet…". Loading and error states.

## Orchestrator page (`views/orch.ts`)
- [ ] "O3 · Orchestrator briefing".
- [ ] Briefing:
  - **Why** (markdown, or "No motivation recorded yet").
  - **Goal** (the heading).
  - **Where it stands** (summary, else headline, else "hasn't written a summary"; shows "updated Xm").
  - **Needs from you** (asks markdown plus open item rows, "N open"; or "Nothing — running on its own").
- [ ] Details: Status badge; PR "#12 title" link with state chip, or "none yet"; Session title.
- [ ] Primary **Open chat** button.
- [ ] "Auto-decided · N" section (open ones as FYI rows, closed ones as past rows).
- [ ] "History · N" section, or "Nothing from O3 has been decided yet".
- [ ] Not found: "No orchestrator called X" with **Back to the team**.

## History tab
- [ ] Search box (desktop `/` hint). Matches title, summary, question, decision note and orchestrator id; every word must match. Debounced.
- [ ] Filter chips: All / Decided by me / Auto-decided / Overridden.
- [ ] Count: "12 items", "3 of 12" or "3+ of 12".
- [ ] Rows are past rows, newest decision first.
- [ ] Server search when the query is 2+ characters and older items aren't loaded: an "Older matches N(+)" section, "Searching older items…" and "Couldn't search older items."
- [ ] **Load older N** button (Loading…; toast on failure).
- [ ] Empty states:
  - "No decisions yet."
  - "Nothing matches "q" in <filter>."
  - Per-filter explanations (e.g. notification-button taps don't count as "mine").
  - Clear button reads "Clear search and filter", "Clear search" or "Show all".

## Settings (`views/settings.ts`)
- [ ] **Schedule**:
  - Fields: start–end time, first–last day, timezone (suggestion list), pickup interval (select), sweep interval (number).
  - Live preview: label, in or off hours now, manager cron in UTC, note when the window isn't on whole UTC hours, DST note, or the validation error.
  - **Save schedule** / **Reset** (enabled only with unsaved edits).
  - 409: "changed elsewhere (now …). Save again or Reset". Also 400/403/401.
  - Non-admins: fields disabled, "Only admins can change the schedule."
  - Never overwrites unsaved edits on a live update.
- [ ] **Agent tokens** (admin only; others see "Only admins manage agent tokens"):
  - Rows: name, scope badge (manager / orchestrator · O3), revoked time, used or "never used", created time, id, **Revoke** (with a confirm dialog).
  - New-token form: name; scope; orchestrator id field only for orchestrator scope.
  - After creating: one-time secret box with **Copy token**, **Copy CLI snippet**, **Done**.
  - Validation and 400/409 errors; loading and "No tokens yet" states.
- [ ] **People** (humans only):
  - Admins see role help, a bootstrap note ("No admin is saved yet…") and rows with name, email, "(you)", notes (default role, N Web Push devices, ntfy topic set, only admin), a role select and **Remove** (confirm dialog).
  - The last admin's demote and remove are locked. Some rows have only Web Push devices and no saved role ("devices only").
  - Add-someone form (email + role) with the "Also add them to the Access policy" note.
  - Non-admins see "Your role: X" and its explanation.
- [ ] **Notifications** (humans only):
  - This-device status chip: On, Off, Needs re-enabling, Another account's, Checking…, Blocked, Not available.
  - Help copy for: iOS "Add to Home Screen first", unsupported browser, blocked, server not configured (503), stale key, taken by another account.
  - Buttons: **Enable notifications on this device**, **Send test notification** (result "Sent to N devices; M failed", expired, refused, none registered), **Turn off on this device**.
  - Profile: display name; ntfy topic with **Generate** and format check; **Save**; extra note for viewers.
- [ ] **Account**: "Signed in as email" or "Using token X (scope)". Theme switch: System / Light / Dark.

## Cross-cutting behaviour
- [ ] Offline banner when the device is offline or the server is unreachable; "may be down" warnings are suppressed while offline.
- [ ] Startup failure retries with backoff (and immediately on reconnect); **Try again** button.
- [ ] Signed out: sticky toast, and lists and detail pages are replaced with a signed-out message.
- [ ] Toasts "Live updates stopped. Reload to reconnect." and "Live updates reconnected."; dismissible toast.
- [ ] Live updates through the change feed; the Q&A thread and People list refetch when they change.
- [ ] A one-minute timer refreshes relative times and the schedule, and brings woken snoozed items back.
- [ ] Auto-advance after decide or snooze: goes to the next item in triage order (high, normal, low, then FYI), or back to the Inbox after the last. It replaces the history entry, so Back doesn't land on the decided item.
- [ ] Settle guard: for 400ms after an auto-advance, decide keys are ignored; held keys never repeat a decision.
- [ ] Focus: the heading gets focus on navigation; focus and caret survive live re-renders; back on a list, focus returns to the opened row and scroll position is restored; screen-reader announcements for status messages.
- [ ] Window title: "(N) Page – Agent Inbox".
- [ ] Keyboard (help overlay via `?`, hints hidden on touch screens):
  - Item page: `j`/`→` next, `k`/`←` previous, `1`–`9` choose, Enter submit, Ctrl/⌘+Enter submit or send from a text field, `a` ask, `y` looks good, `o` override, `s` snooze, `u`/Esc back (Esc closes the snooze menu first).
  - Lists: `j`/`k`/arrows move between rows, Enter opens, `/` searches History.
  - Anywhere: `g i` / `g t` / `g h` / `g s` go to Inbox / Team / History / Settings; Esc leaves a text field.
- [ ] Theme applied before first paint; light and dark browser-chrome colours.
- [ ] Home-screen app: manifest, icons, iOS status bar.
- [ ] Tapping a Web Push notification focuses the app and opens the item.
- [ ] Reduced motion respected.
- [ ] Markdown supports paragraphs, lists, headings (as bold lines), code fences, quotes, rules, inline code, bold, italics and https links. It's used in: digest, summary, context, recommendation why, orchestrator Why / Where it stands / asks, and Q&A replies.

## The 8 core-loop moments to make excellent
1. **Glance triage**: badge, priority groups and dense rows (answered dot, "? asked", confidence, assignee) tell you what needs you in about 2 seconds.
2. **Read the call**: question, then option cards with consequence, tradeoff, reversibility and the recommendation with confidence. The background (context, cost of waiting, evidence) stays one tap away.
3. **Pick, Submit, auto-advance**: one tap or key to choose, one to submit, then straight to the next item without loading the next one unseen (the settle guard).
4. **Phone thumb flow**: the bottom bar, and its Submit once an option is picked, plus prev/next and the position counter.
5. **FYI review**: Looks good vs Override… with the required note.
6. **Ask → answered → decide**: send a question, see "Waiting for the manager", then the answered dot, read the thread, decide.
7. **Snooze and return**: quick presets with wake times, the Snoozed group, Unsnooze.
8. **Conflict and failure recovery**: the 409 "changed, review again" vs "already decided elsewhere", while offline, and when signed out, with nothing typed lost.

A ninth candidate is **manager status and Run tick now**. The status line and its warnings are the only signal that decisions are actually being picked up.
