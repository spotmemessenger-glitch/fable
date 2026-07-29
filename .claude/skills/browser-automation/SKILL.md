---
name: browser-automation
description: Automate a browser through the DOM with Playwright instead of driving Chrome by mouse and pixels. Use when an agent task involves web pages — filling forms, scraping, logging in, navigating flows, taking screenshots of pages — or when a computer-use agent is clicking around a browser window and losing reliability.
allowed-tools: [Read, Grep, Glob, Edit, Write, Bash]
---

# Browser automation

**If the target is a web page, do not drive it with the mouse.** A computer-use
agent clicking Chrome is guessing at pixels over a surface that already exposes
a precise, queryable structure. Playwright gets exact selectors, real waits, and
no DPI or scaling class of bug at all.

Reserve pixel-driving for the browser *chrome* itself (profile switching,
extension dialogs, native print dialogs) — everything inside the viewport is
DOM work.

## Waiting is the whole game

Playwright's locators auto-wait for actionability — attached, visible, stable,
enabled, unobscured — which removes the entire category of race conditions that
`sleep()` was papering over.

```python
page.get_by_role("button", name="Save").click()   # waits for actionable
page.wait_for_url("**/dashboard")                  # waits for the transition
expect(page.get_by_text("Saved")).to_be_visible()  # asserts the end state
```

Never `page.wait_for_timeout()` as a substitute. It is the browser equivalent of
`sleep(2)` and fails the same way — too slow when things are fast, too short
when they are not.

## Selector priority

Ordered by resilience:

1. `get_by_role(...)` — matches the accessibility tree; survives restyling.
2. `get_by_label` / `get_by_placeholder` / `get_by_text` — user-visible anchors.
3. `data-testid` — stable if the app owns it.
4. CSS/XPath — last resort; breaks on any markup change.

Deep CSS chains (`div > div:nth-child(3) > span`) are the selector equivalent of
a hard-coded coordinate.

## This environment

Chromium is pre-installed and Playwright is configured to find it:
`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`, with
`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` stopping npm postinstall re-fetching it.
**Do not run `playwright install`.** If a project pins a different
`@playwright/test`, launch with `executablePath: '/opt/pw-browsers/chromium'`
rather than downloading.

Headless by default; use `headless=False` only when you need to watch it.

## Verification still applies

The verify loop from `action-verify-loop` is not optional here — it is just
cheaper to satisfy. Assert the end state (`expect(...)`), not the fact that a
click was dispatched. A click that lands on a detached node throws; a click that
lands on the right node and triggers nothing does not.

## State and auth

Log in once, save the session, reuse it — re-authenticating per run is slow and
trips bot detection:

```python
context.storage_state(path="auth.json")            # save
browser.new_context(storage_state="auth.json")     # reuse
```

Treat that file as a credential: it is a live session. Never commit it. In this
repo `.gitignore` already excludes `*_token.json` and `credentials.json` — put
saved sessions under an ignored path and keep them out of history.

## Bridging to the desktop agent

When a desktop task involves a web step, hand off rather than click through it:
the operator opens the page, Playwright drives the flow against the DOM, and
control returns once the end state is asserted. Two reliable mechanisms beat one
unreliable one covering both.

Attach to an already-open browser over CDP when the flow needs the user's real
profile and cookies:

```python
browser = playwright.chromium.connect_over_cdp("http://localhost:9222")
```

The browser must have been started with `--remote-debugging-port=9222`.

## Anti-patterns

- Pixel-clicking a web page a selector could hit exactly.
- `wait_for_timeout()` instead of a real wait condition.
- Screenshot-and-look when `text_content()` answers the question for no tokens.
- Committing `storage_state` files.
- Scraping behind a login without checking the site's terms — access you have as
  a human is not automatically access you have as a bot.
